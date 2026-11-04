// Client mode: off by default, clients sign in with one-time links, see only their own websites, and pay the owner through Stripe.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../src/index.ts";
import { fakeD1 } from "./fake-d1.ts";
import { countedSites, forgetCountedSites } from "../src/accounts.ts";
import { applyStripeEvent, stripeForm, stripeSignatureOk } from "../src/clients.ts";

const ORIGIN = "https://stats.example.com";
const PASSWORD = "a-long-test-password";

function setup() {
	const { db, sql } = fakeD1();
	const env: Env = { DB: db, ADMIN_PASSWORD: PASSWORD, APP_HOST: "stats.example.com" };
	const go = (path: string, init: RequestInit & { cookie?: string; form?: Record<string, string> } = {}) =>
		worker.fetch(
			new Request(ORIGIN + path, {
				redirect: "manual",
				method: init.form ? "POST" : (init.method ?? "GET"),
				headers: { Origin: ORIGIN, ...(init.cookie ? { Cookie: init.cookie } : {}), ...(init.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
				body: init.form ? new URLSearchParams(init.form) : undefined,
			}),
			env,
		);
	return { db, sql, env, go };
}

async function signInOwner(go: ReturnType<typeof setup>["go"]): Promise<string> {
	const res = await go("/signin", { form: { password: PASSWORD } });
	assert.equal(res.status, 303);
	return (res.headers.get("Set-Cookie") ?? "").split(";")[0];
}

test("client mode: off by default, then clients sign in with a one-time link and see only their own websites", async () => {
	forgetCountedSites();
	const { db, sql, go } = setup();
	const owner = await signInOwner(go);
	await go("/sites", { cookie: owner, form: { domain: "mine.com" } });

	// Off by default: no client box on the sign-in page.
	assert.ok(!(await (await go("/signin")).text()).includes("Signing in as a client?"));
	const admin = await (await go("/clients", { cookie: owner })).text();
	assert.ok(admin.includes("Let clients sign in") && admin.includes("commercial licence") && admin.includes("https://paulobrien.dev/contact/"));

	// A plan, and a client on it who doesn't pay through Stripe.
	assert.equal((await go("/clients/plans", { cookie: owner, form: { name: "Starter", sites: "2", price_label: "Ask us", stripe_price: "" } })).status, 303);
	assert.equal((await go("/clients/plans", { cookie: owner, form: { name: "Bad", sites: "2", stripe_price: "nope" } })).status, 400, "Stripe Price IDs are checked");
	const planId = String(sql.prepare("SELECT id FROM client_plans WHERE name = 'Starter'").get()?.id);
	assert.equal((await go("/clients/add", { cookie: owner, form: { email: "Client@Example.com", name: "Their Shop", plan: planId, free: "on" } })).status, 303);
	const client = sql.prepare("SELECT id, status FROM accounts WHERE email = 'client@example.com'").get() as { id: string; status: string };
	assert.equal(client.status, "free");
	assert.equal((await go("/clients/site", { cookie: owner, form: { id: client.id, domain: "mine.com" } })).status, 400, "one account per website");
	assert.equal((await go("/clients/site", { cookie: owner, form: { id: client.id, domain: "theirs.com" } })).status, 303);

	// A sign-in link: only works while client mode is on, once, and a GET doesn't use it up.
	const linkPage = await (await go("/clients/link", { cookie: owner, form: { id: client.id } })).text();
	const link = /value="(https:\/\/stats\.example\.com\/signin\/link\/[^"]+)"/.exec(linkPage)?.[1];
	assert.ok(link, "the owner gets a link to copy");
	const path = new URL(link!).pathname;
	assert.equal((await go(path, { form: {} })).headers.get("Location"), "/signin", "client mode is off");
	await go("/clients/switch", { cookie: owner, form: { on: "on" } });
	assert.equal((await go(path)).status, 200);
	const used = await go(path, { form: {} });
	assert.equal(used.status, 303);
	const them = (used.headers.get("Set-Cookie") ?? "").split(";")[0];
	assert.equal((await go(path, { form: {} })).status, 400, "each link works once");

	// The client sees their website, not the owner's, and none of the owner's settings.
	const home = await (await go("/", { cookie: them })).text();
	assert.ok(home.includes("theirs.com") && !home.includes("mine.com"));
	assert.ok(home.includes("Your account") && home.includes("Starter") && !home.includes("Manage clients") && !home.includes('action="/branding"'));
	assert.ok(!(await (await go("/?site=mine.com", { cookie: them })).text()).includes("mine.com"), "not the owner's website");
	assert.equal((await go("/clients", { cookie: them })).status, 404, "clients can't manage clients");
	assert.equal((await go("/branding", { cookie: them, form: { name: "Hacked" } })).status, 403);
	assert.equal((await go("/sites", { cookie: them, form: { domain: "mine.com" } })).status, 400, "can't take the owner's website");
	assert.equal((await go("/sites", { cookie: them, form: { domain: "second.com" } })).status, 303);
	assert.equal((await go("/sites", { cookie: them, form: { domain: "third.com" } })).status, 400, "the plan covers two websites");

	// Needs to pay: their stats wait behind the plans page, and stop being counted.
	await go("/clients/update", { cookie: owner, form: { id: client.id, plan: planId, status: "unpaid" } });
	assert.equal((await go("/", { cookie: them })).headers.get("Location"), "/plans");
	const plans = await (await go("/plans", { cookie: them })).text();
	assert.ok(plans.includes("waiting for a plan") && plans.includes("Ask us") && plans.includes("Get in touch"));
	forgetCountedSites();
	assert.deepEqual(await countedSites(db, 1), ["mine.com"], "an unpaid client's websites aren't counted");

	// Switching client mode off signs clients out.
	await go("/clients/update", { cookie: owner, form: { id: client.id, plan: planId, status: "free" } });
	await go("/clients/switch", { cookie: owner, form: {} });
	assert.equal((await go("/", { cookie: them })).status, 403);

	// Removing a client removes their websites too.
	assert.equal((await go("/clients/remove", { cookie: owner, form: { id: client.id, confirm: "wrong@example.com" } })).status, 400);
	await go("/clients/remove", { cookie: owner, form: { id: client.id, confirm: "client@example.com" } });
	assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM sites WHERE account_id = ?").get(client.id)?.n, 0);
	assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM accounts WHERE id = ?").get(client.id)?.n, 0);
});

test("client mode payments: Stripe's signature is checked, and paying switches a client on until the subscription stops", async () => {
	const { db, sql, env, go } = setup();
	sql.prepare("INSERT INTO client_plans (id, name, sites, price_label, stripe_price, created_at) VALUES (7, 'Pro', 5, '', 'price_ABC123xyz', 0)").run();
	sql.prepare("INSERT INTO accounts (id, email, created_at, status) VALUES ('c1', 'c@example.com', 0, 'unpaid')").run();
	assert.equal(stripeForm({ mode: "subscription", line_items: { 0: { price: "p", quantity: 1 } }, skip: null }), "mode=subscription&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1");

	const secret = "whsec_test";
	const sign = async (body: string, t = Math.floor(Date.now() / 1000)) => {
		const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
		return `t=${t},v1=${sig}`;
	};
	const body = JSON.stringify({ type: "checkout.session.completed", data: { object: { payment_status: "paid", customer: "cus_1", subscription: "sub_1", metadata: { account: "c1", plan: "7" } } } });
	assert.ok(await stripeSignatureOk(body, await sign(body), secret));
	assert.ok(!(await stripeSignatureOk(body, await sign(body), "whsec_other")), "wrong secret");
	assert.ok(!(await stripeSignatureOk(body, await sign(body, 1000), secret)), "too old");

	// Through the webhook address: needs Stripe set up, and a good signature.
	const hook = (sig: string) => worker.fetch(new Request(ORIGIN + "/billing/webhook", { method: "POST", headers: { "Stripe-Signature": sig }, body }), env);
	assert.equal((await hook(await sign(body))).status, 404, "off until Stripe is set up");
	env.STRIPE_SECRET_KEY = "sk_test_x";
	env.STRIPE_WEBHOOK_SECRET = secret;
	assert.equal((await hook("t=1,v1=00")).status, 400);
	assert.equal(await (await hook(await sign(body))).text(), "client on");
	assert.deepEqual({ ...sql.prepare("SELECT status, client_plan, stripe_customer, stripe_subscription FROM accounts WHERE id = 'c1'").get() }, { status: "active", client_plan: 7, stripe_customer: "cus_1", stripe_subscription: "sub_1" });

	// Renewals keep them on; a cancelled subscription switches them off. Another subscription can't.
	assert.equal(await applyStripeEvent(db, { type: "customer.subscription.updated", data: { object: { id: "sub_other", status: "canceled", metadata: { account: "c1" } } } }), "client off");
	assert.equal(sql.prepare("SELECT status FROM accounts WHERE id = 'c1'").get()?.status, "active", "a different subscription doesn't touch them");
	await applyStripeEvent(db, { type: "customer.subscription.deleted", data: { object: { id: "sub_1", status: "canceled", metadata: { account: "c1" } } } });
	assert.equal(sql.prepare("SELECT status FROM accounts WHERE id = 'c1'").get()?.status, "unpaid");
	assert.equal(await applyStripeEvent(db, { type: "checkout.session.completed", data: { object: { payment_status: "paid", metadata: { account: "owner" } } } }), "ignored", "never the owner");
	void go;
});
