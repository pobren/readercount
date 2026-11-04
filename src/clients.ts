// Client mode: sell ReaderCount to your own clients, under your own brand, with your own plans and your own Stripe
// account. Off until the owner switches it on under Clients. Clients sign in with a one-time link (emailed, or copied
// and sent by the owner), see only their own websites, and pay through Stripe Checkout. Payments go straight to the
// owner's Stripe account. Running ReaderCount for clients needs a commercial licence (see LICENSE): nothing here checks.

import { cleanEmail, forgetCountedSites, OWNER_ID, randomToken, sha256, type Account, type Mailer } from "./accounts.ts";
import type { PlanState } from "./plans.ts";

export type ClientPlan = { id: number; name: string; sites: number; price_label: string; stripe_price: string | null };
export type Client = { id: string; email: string; name: string | null; status: string; client_plan: number | null; plan_name: string | null; sites: string | null; stripe_subscription: string | null };
type StripeEnv = { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string };

const LINK_MINUTES = 30;
const LINKS_PER_HOUR = 5;
export const isOwner = (account: Account) => account.id === OWNER_ID;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---- On or off ----

let on: { value: boolean; at: number } | null = null;

export async function clientsOn(db: D1Database, now = Date.now()): Promise<boolean> {
	if (on && now - on.at < 60_000 && now >= on.at) return on.value;
	const row = await db.prepare("SELECT value FROM settings WHERE key = 'clients_on'").first<{ value: string }>().catch(() => null);
	on = { value: row?.value === "1", at: now };
	return on.value;
}

export async function setClientsOn(db: D1Database, value: boolean): Promise<void> {
	await db.prepare("INSERT INTO settings (key, value) VALUES ('clients_on', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(value ? "1" : "0").run();
	on = null;
	forgetCountedSites();
}

export const stripeOn = (env: StripeEnv) => Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);

// ---- Plans ----

export async function listPlans(db: D1Database): Promise<ClientPlan[]> {
	return (await db.prepare("SELECT id, name, sites, price_label, stripe_price FROM client_plans ORDER BY sites, id").all<ClientPlan>()).results ?? [];
}

export async function addPlan(db: D1Database, form: FormData, now: number): Promise<string | null> {
	const name = String(form.get("name") ?? "").trim();
	const sites = Number(form.get("sites"));
	const label = String(form.get("price_label") ?? "").trim();
	const price = String(form.get("stripe_price") ?? "").trim();
	if (!name || name.length > 40) return "Give the plan a name of up to 40 characters.";
	if (!Number.isInteger(sites) || sites < 1 || sites > 1000) return "Websites must be a whole number from 1 to 1,000.";
	if (label.length > 60) return "Keep the price wording under 60 characters.";
	if (price && !/^price_[A-Za-z0-9]{6,}$/.test(price)) return "The Stripe Price ID starts price_. Copy it from the product's page in your Stripe dashboard.";
	await db.prepare("INSERT INTO client_plans (name, sites, price_label, stripe_price, created_at) VALUES (?, ?, ?, ?, ?)").bind(name, sites, label, price || null, now).run();
	return null;
}

export async function removePlan(db: D1Database, id: unknown): Promise<void> {
	await db.prepare("DELETE FROM client_plans WHERE id = ? AND NOT EXISTS (SELECT 1 FROM accounts WHERE client_plan = client_plans.id)").bind(Number(id)).run();
}

/** What a client may do: their plan's websites, while it's free or paid. */
export async function clientPlan(db: D1Database, accountId: string, base: PlanState): Promise<PlanState> {
	const row = await db
		.prepare("SELECT a.status AS status, p.name AS name, p.sites AS sites FROM accounts a LEFT JOIN client_plans p ON p.id = a.client_plan WHERE a.id = ?")
		.bind(accountId)
		.first<{ status: string; name: string | null; sites: number | null }>();
	const live = row?.status === "free" || row?.status === "active";
	return { ...base, plan: row?.status ?? "unpaid", name: row?.name ?? "No plan yet", sites: row?.sites ?? 1, ended: !live };
}

// ---- Clients ----

export async function listClients(db: D1Database): Promise<Client[]> {
	return (
		(
			await db
				.prepare(
					"SELECT a.id, a.email, a.name, a.status, a.client_plan, a.stripe_subscription, p.name AS plan_name, (SELECT GROUP_CONCAT(domain, ', ') FROM sites WHERE account_id = a.id) AS sites FROM accounts a LEFT JOIN client_plans p ON p.id = a.client_plan WHERE a.id != ? ORDER BY a.created_at",
				)
				.bind(OWNER_ID)
				.all<Client>()
		).results ?? []
	);
}

export async function addClient(db: D1Database, form: FormData, now: number): Promise<string | null> {
	const email = cleanEmail(form.get("email"));
	if (!email) return "Please enter the client's email address.";
	const name = String(form.get("name") ?? "").trim().slice(0, 80) || null;
	const plan = Number(form.get("plan")) || null;
	const free = form.get("free") === "on";
	const exists = await db.prepare("SELECT 1 AS ok FROM accounts WHERE email = ?").bind(email).first();
	if (exists) return "That email address already has an account.";
	await db
		.prepare("INSERT INTO accounts (id, email, created_at, name, client_plan, status) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(crypto.randomUUID(), email, now, name, plan, free ? "free" : "unpaid")
		.run();
	return null;
}

export async function updateClient(db: D1Database, form: FormData): Promise<void> {
	const id = String(form.get("id") ?? "");
	if (!id || id === OWNER_ID) return;
	const plan = Number(form.get("plan")) || null;
	const status = String(form.get("status") ?? "");
	await db
		.prepare("UPDATE accounts SET client_plan = ?, status = CASE WHEN ? IN ('free', 'unpaid') THEN ? ELSE status END WHERE id = ?")
		.bind(plan, status, status, id)
		.run();
	forgetCountedSites();
}

/** Removes a client, their websites and all their stats. */
export async function removeClient(db: D1Database, id: unknown, removeSite: (site: string) => Promise<unknown>): Promise<void> {
	const accountId = String(id ?? "");
	if (!accountId || accountId === OWNER_ID) return;
	const sites = (await db.prepare("SELECT domain FROM sites WHERE account_id = ?").bind(accountId).all<{ domain: string }>()).results ?? [];
	for (const s of sites) await removeSite(s.domain);
	await db.batch([
		...["sessions", "sign_in_links", "oauth_tokens", "oauth_codes", "api_keys"].map((t) => db.prepare(`DELETE FROM ${t} WHERE account_id = ?`).bind(accountId)),
		...["google_links", "adsense_links", "alert_sends", "report_use"].map((t) => db.prepare(`DELETE FROM ${t} WHERE owner = ?`).bind(accountId)),
		db.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId),
	]);
	forgetCountedSites();
}

/** Puts a website on a client's account (the owner can, whatever the client's plan). */
export async function giveSite(db: D1Database, accountId: string, domain: string, now: number): Promise<string | null> {
	const taken = await db.prepare("SELECT account_id FROM sites WHERE domain = ?").bind(domain).first<{ account_id: string }>();
	if (taken && taken.account_id !== accountId) return "That website is already on another account. Remove it there first.";
	await db.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES (?, ?, ?) ON CONFLICT (domain) DO NOTHING").bind(domain, accountId, now).run();
	forgetCountedSites();
	return null;
}

// ---- Signing in with a one-time link ----

/** A link that signs a client in once, within LINK_MINUTES. */
export async function makeSignInLink(db: D1Database, accountId: string, origin: string, now: number): Promise<string> {
	const token = randomToken();
	await db.prepare("INSERT INTO sign_in_links (token_hash, account_id, expires) VALUES (?, ?, ?)").bind(await sha256(token), accountId, now + LINK_MINUTES * 60_000).run();
	return `${origin}/signin/link/${token}`;
}

/** Emails a sign-in link to a client. Says the same whether or not the address has an account. */
export async function emailSignInLink(db: D1Database, mail: Mailer | undefined, from: string, emailIn: unknown, origin: string, now: number): Promise<string | null> {
	const email = cleanEmail(emailIn);
	if (!email) return "Please enter a valid email address.";
	if (!mail) return "Email isn't set up here yet. Ask whoever runs your stats for a sign-in link.";
	const who = await db.prepare("SELECT id FROM accounts WHERE email = ? AND id != ?").bind(email, OWNER_ID).first<{ id: string }>();
	if (!who) return null;
	const recent = await db.prepare("SELECT COUNT(*) AS n FROM sign_in_links WHERE account_id = ? AND expires > ?").bind(who.id, now + (LINK_MINUTES - 60) * 60_000).first<{ n: number }>();
	if ((recent?.n ?? 0) >= LINKS_PER_HOUR) return null;
	const link = await makeSignInLink(db, who.id, origin, now);
	await mail.send({ to: email, from: { email: from, name: "ReaderCount" }, subject: "Your ReaderCount sign-in link", text: `Here's your link to sign in to ReaderCount. It works once, for the next ${LINK_MINUTES} minutes:\n\n${link}\n\nIf you didn't ask for it, you can ignore this email.\n\nReaderCount` });
	return null;
}

/** Uses a sign-in link: returns the account it signs in, once. */
export async function useSignInLink(db: D1Database, token: string, now: number): Promise<string | null> {
	const row = await db.prepare("DELETE FROM sign_in_links WHERE token_hash = ? RETURNING account_id, expires").bind(await sha256(token)).first<{ account_id: string; expires: number }>();
	return row && row.expires > now ? row.account_id : null;
}

// ---- Stripe (the owner's own account) ----

/** Stripe's form encoding, with nested keys written as a[b][c]. */
export function stripeForm(params: Record<string, unknown>, prefix = ""): string {
	const out: string[] = [];
	for (const [k, v] of Object.entries(params)) {
		if (v == null) continue;
		const key = prefix ? `${prefix}[${k}]` : k;
		if (typeof v === "object") out.push(stripeForm(v as Record<string, unknown>, key));
		else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
	}
	return out.filter(Boolean).join("&");
}

async function stripe(env: StripeEnv, path: string, params: Record<string, unknown>, get: typeof fetch = fetch): Promise<Record<string, any>> {
	const res = await get(`https://api.stripe.com/v1/${path}`, { method: "POST", headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" }, body: stripeForm(params) });
	const body = (await res.json().catch(() => ({}))) as Record<string, any>;
	if (!res.ok) throw new Error(body.error?.message ?? `Stripe said ${res.status}`);
	return body;
}

/** Starts Stripe Checkout for a plan, and returns the address to send the client to. */
export async function startCheckout(env: StripeEnv & { DB: D1Database }, account: Account, planId: unknown, origin: string, get: typeof fetch = fetch): Promise<{ url: string } | { error: string }> {
	if (!stripeOn(env)) return { error: "Card payments aren't set up yet." };
	const plan = await env.DB.prepare("SELECT id, name, stripe_price FROM client_plans WHERE id = ?").bind(Number(planId)).first<{ id: number; name: string; stripe_price: string | null }>();
	if (!plan?.stripe_price) return { error: "That plan can't be paid for online. Please get in touch instead." };
	const row = await env.DB.prepare("SELECT stripe_customer FROM accounts WHERE id = ?").bind(account.id).first<{ stripe_customer: string | null }>();
	try {
		const s = await stripe(
			env,
			"checkout/sessions",
			{
				mode: "subscription",
				line_items: { 0: { price: plan.stripe_price, quantity: 1 } },
				...(row?.stripe_customer ? { customer: row.stripe_customer } : { customer_email: account.email }),
				client_reference_id: account.id,
				metadata: { account: account.id, plan: String(plan.id) },
				subscription_data: { metadata: { account: account.id, plan: String(plan.id) } },
				success_url: `${origin}/plans?paid=1`,
				cancel_url: `${origin}/plans`,
			},
			get,
		);
		return { url: String(s.url) };
	} catch (e) {
		return { error: e instanceof Error ? e.message : "Stripe didn't answer." };
	}
}

/** Stripe's own page for changing card, cancelling and downloading receipts. */
export async function billingPortal(env: StripeEnv & { DB: D1Database }, account: Account, origin: string, get: typeof fetch = fetch): Promise<{ url: string } | { error: string }> {
	const row = await env.DB.prepare("SELECT stripe_customer FROM accounts WHERE id = ?").bind(account.id).first<{ stripe_customer: string | null }>();
	if (!stripeOn(env) || !row?.stripe_customer) return { error: "There's no card payment on this account." };
	try {
		const s = await stripe(env, "billing_portal/sessions", { customer: row.stripe_customer, return_url: `${origin}/plans` }, get);
		return { url: String(s.url) };
	} catch (e) {
		return { error: e instanceof Error ? e.message : "Stripe didn't answer." };
	}
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Checks a Stripe-Signature header (t=…,v1=…) against the raw body, within five minutes. */
export async function stripeSignatureOk(body: string, header: string | null, secret: string, now = Date.now()): Promise<boolean> {
	if (!header || !secret) return false;
	const parts = header.split(",").map((p) => p.split("="));
	const t = parts.find(([k]) => k === "t")?.[1];
	const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
	if (!t || !sigs.length || Math.abs(now / 1000 - Number(t)) > 300) return false;
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const want = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
	return sigs.some((s) => s.length === want.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ want.charCodeAt(i)), 0) === 0);
}

/** Stripe tells us about payments here. A paid checkout or a live subscription switches the client on; a stopped one switches them off. */
export async function stripeWebhook(request: Request, env: StripeEnv & { DB: D1Database }, now: number): Promise<Response> {
	const body = await request.text();
	if (!(await stripeSignatureOk(body, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET ?? "", now))) return new Response("Bad signature", { status: 400 });
	const event = JSON.parse(body) as { type: string; data: { object: Record<string, any> } };
	return new Response(await applyStripeEvent(env.DB, event));
}

export async function applyStripeEvent(db: D1Database, event: { type: string; data: { object: Record<string, any> } }): Promise<string> {
	const o = event.data.object;
	const account = String(o.metadata?.account ?? "");
	const plan = Number(o.metadata?.plan) || null;
	if (!account || account === OWNER_ID) return "ignored";
	if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
		if (o.payment_status !== "paid" && o.payment_status !== "no_payment_required") return "not paid yet";
		await db.prepare("UPDATE accounts SET status = 'active', client_plan = COALESCE(?, client_plan), stripe_customer = ?, stripe_subscription = ? WHERE id = ?").bind(plan, o.customer ?? null, o.subscription ?? null, account).run();
		forgetCountedSites();
		return "client on";
	}
	if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
		const live = event.type === "customer.subscription.updated" && ["active", "trialing", "past_due"].includes(o.status);
		const end = Number(o.current_period_end ?? o.items?.data?.[0]?.current_period_end) || null;
		await db
			.prepare("UPDATE accounts SET status = CASE WHEN status = 'free' THEN 'free' WHEN ? THEN 'active' ELSE 'unpaid' END, client_plan = COALESCE(?, client_plan), paid_until = ? WHERE id = ? AND (stripe_subscription IS NULL OR stripe_subscription = ?)")
			.bind(live ? 1 : 0, live ? plan : null, end ? end * 1000 : null, account, o.id ?? "")
			.run();
		forgetCountedSites();
		return live ? "client on" : "client off";
	}
	return "ignored";
}

// ---- Pages ----

/** The owner's Clients page: on or off, the plans, the clients and the licence reminder. */
export function clientsAdmin(opts: { on: boolean; stripe: boolean; email: boolean; plans: ClientPlan[]; clients: Client[]; origin: string; note?: string; link?: { email: string; url: string } }): string {
	const { plans, clients } = opts;
	const planOptions = (selected: number | null) => `<option value="">No plan</option>${plans.map((p) => `<option value="${p.id}"${p.id === selected ? " selected" : ""}>${esc(p.name)} (${p.sites} website${p.sites === 1 ? "" : "s"})</option>`).join("")}`;
	const status = (c: Client) => (c.status === "active" ? `<span class="pill ok">● Paying</span>` : c.status === "free" ? `<span class="pill ok">● Free</span>` : `<span class="pill wait">○ Not paid</span>`);
	const licence = `<p class="gs-note">Running ReaderCount for clients needs a commercial licence. <a href="https://paulobrien.dev/contact/" target="_blank" rel="noopener">Talk to us about one</a>.</p>`;
	const toggle = `<form method="post" action="/clients/switch" class="updates"><label><input type="checkbox" name="on"${opts.on ? " checked" : ""} onchange="this.form.submit()"> Let clients sign in</label><noscript><button class="cl-copy" type="submit">Save</button></noscript></form>`;
	const setup = `<ul class="cl-steps"><li>${opts.email ? "●" : "○"} Email: ${opts.email ? "set up, so clients can ask for a sign-in link themselves." : "not set up, so copy each client's sign-in link and send it yourself."}</li><li>${opts.stripe ? "●" : "○"} Stripe: ${opts.stripe ? `set up. Webhook address: <code>${esc(opts.origin)}/billing/webhook</code>` : "not set up, so clients can't pay by card here. Mark them Free when they've paid you another way."}</li></ul>`;
	const planRows = plans.length
		? `<ul class="site-list">${plans
				.map((p) => `<li><span class="site-name">${esc(p.name)}<span class="set-sub"> · ${p.sites} website${p.sites === 1 ? "" : "s"}${p.price_label ? ` · ${esc(p.price_label)}` : ""} · ${p.stripe_price ? `Stripe <code>${esc(p.stripe_price)}</code>` : "no Stripe price"}</span></span><form method="post" action="/clients/plans/remove"><input type="hidden" name="id" value="${p.id}"><button class="btn-out" type="submit">Remove</button></form></li>`)
				.join("")}</ul>`
		: `<p class="gs-intro">No plans yet. Add one below.</p>`;
	const addPlan = `<form method="post" action="/clients/plans" class="brand-form"><label>Plan name<input name="name" maxlength="40" required placeholder="Starter"></label><label>Websites<input name="sites" type="number" min="1" max="1000" value="1" required></label><label>Price wording clients see<input name="price_label" maxlength="60" placeholder="£9 a month"></label><label>Stripe Price ID (optional)<input name="stripe_price" placeholder="price_..." autocapitalize="off" spellcheck="false"></label><button class="cl-copy" type="submit">Add plan</button></form>`;
	const clientRows = clients.length
		? clients
				.map(
					(c) =>
						`<details class="set-more"><summary class="set-row"><span class="set-text"><span class="set-title">${esc(c.name || c.email)}</span><span class="set-sub">${esc(c.email)} · ${esc(c.plan_name ?? "No plan")} · ${esc(c.sites ?? "no websites yet")}</span></span><span class="set-act">${status(c)}<span class="btn-out set-open">Manage</span></span></summary><div class="set-body">` +
						`<form method="post" action="/clients/update" class="brand-form"><input type="hidden" name="id" value="${esc(c.id)}"><label>Plan<select name="plan">${planOptions(c.client_plan)}</select></label><label>Access<select name="status"><option value="keep">${c.status === "active" ? "Paying through Stripe" : "Leave as it is"}</option><option value="free"${c.status === "free" ? " selected" : ""}>Free (no payment needed)</option><option value="unpaid">Needs to pay</option></select></label><button class="cl-copy" type="submit">Save</button></form>` +
						`<form method="post" action="/clients/site" class="cl-row"><input type="hidden" name="id" value="${esc(c.id)}"><input class="cl-url" name="domain" placeholder="theirsite.com" autocapitalize="off" spellcheck="false" required aria-label="Add a website for ${esc(c.email)}"><button class="cl-copy" type="submit">Add website</button></form>` +
						`<form method="post" action="/clients/link" class="gs-off"><input type="hidden" name="id" value="${esc(c.id)}"><button type="submit">Make a sign-in link</button></form>` +
						`<form method="post" action="/clients/remove" class="cl-row"><input type="hidden" name="id" value="${esc(c.id)}"><input class="cl-url" name="confirm" placeholder="Type ${esc(c.email)} to remove" autocomplete="off" required aria-label="Type the email address to confirm"><button class="cl-copy btn-danger" type="submit">Remove client</button></form>` +
						`</div></details>`,
				)
				.join("")
		: `<p class="gs-intro">No clients yet.</p>`;
	const addClient = `<form method="post" action="/clients/add" class="brand-form"><label>Email address<input name="email" type="email" required placeholder="client@example.com"></label><label>Name (optional)<input name="name" maxlength="80"></label><label>Plan<select name="plan">${planOptions(null)}</select></label><label class="inline"><input type="checkbox" name="free"> Free (they don't pay through Stripe)</label><button class="cl-copy" type="submit">Add client</button></form>`;
	const note = opts.note ? `<p class="gs-note ck-ok">${esc(opts.note)}</p>` : "";
	const link = opts.link
		? `<section class="card set-card"><h2>Sign-in link for ${esc(opts.link.email)}</h2><p class="gs-intro">Send this to your client. It works once, for the next 30 minutes.</p><div class="cl-row"><input class="cl-url" readonly value="${esc(opts.link.url)}" aria-label="Sign-in link"><button type="button" class="cl-copy" data-copy>Copy</button></div></section>`
		: "";
	return `<div class="clients"><p><a href="/">← Back to your stats</a></p><h1>Clients</h1>${note}${link}<section class="card set-card"><h2>Client sign-in</h2>${toggle}${setup}${licence}</section><section class="card set-card"><h2>Plans</h2>${planRows}<details class="set-more"><summary class="set-row"><span class="set-text"><span class="set-title">Add a plan</span></span><span class="set-act"><span class="btn-out set-open">Add</span></span></summary><div class="set-body">${addPlan}<p class="gs-note">Make the product and its price in your own Stripe dashboard first, then paste its Price ID here.</p></div></details></section><section class="card set-card"><h2>Your clients</h2>${clientRows}<details class="set-more"${clients.length ? "" : " open"}><summary class="set-row"><span class="set-text"><span class="set-title">Add a client</span></span><span class="set-act"><span class="btn-out set-open">Add</span></span></summary><div class="set-body">${addClient}</div></details></section></div>`;
}

/** A client's Plans page: their plan, the plans they can pick, and Stripe's page for their card and receipts. */
export function plansPage(opts: { plan: PlanState; current: number | null; plans: ClientPlan[]; stripe: boolean; paying: boolean; paid: boolean; support: string }): string {
	const { plan, plans } = opts;
	const head = opts.paid ? `<p class="gs-note ck-ok">● Thanks, your payment went through. It can take a minute to show here.</p>` : "";
	const now = plan.ended ? `<p class="err">Your stats are waiting for a plan. Pick one below to carry on.</p>` : `<p>Your plan: <b>${esc(plan.name)}</b>, up to ${plan.sites} website${plan.sites === 1 ? "" : "s"}.</p>`;
	const cards = plans
		.map((p) => {
			const mine = p.id === opts.current && !plan.ended;
			const action = mine
				? `<span class="pill here">Your plan</span>`
				: p.stripe_price && opts.stripe
					? `<form method="post" action="/billing/checkout"><input type="hidden" name="plan" value="${p.id}"><button class="go" type="submit">Choose ${esc(p.name)}</button></form>`
					: `<span class="gs-note">Get in touch to switch${opts.support ? `: <a href="${esc(opts.support)}">${esc(opts.support.replace(/^mailto:|^https:\/\//, ""))}</a>` : ""}</span>`;
			return `<div class="card"><h2>${esc(p.name)}</h2><p>Up to ${p.sites} website${p.sites === 1 ? "" : "s"}${p.price_label ? `<br><b>${esc(p.price_label)}</b>` : ""}</p>${action}</div>`;
		})
		.join("");
	const manage = opts.paying ? `<form method="post" action="/billing/manage"><button class="btn-out" type="submit">Card, receipts and cancelling</button></form>` : "";
	return `<p><a href="/">← Back to your stats</a></p><h1>Plans</h1>${head}${now}<div class="plans">${cards || `<p>There are no plans to pick yet. Please get in touch.</p>`}</div>${manage}`;
}
