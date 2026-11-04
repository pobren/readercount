// ReaderCount on the web: sign in with the owner's password, your websites, your stats and their settings,
// public stats pages, and the Claude connector (/mcp), which signs in with the same password through OAuth.

import { adsenseConnectUrl, adsenseState, disconnectAdsense, finishAdsense, type AdsenseState } from "./adsense.ts";
import { moneyProblems, moneyReport } from "./money.ts";
import { accountSites, addSite, checkPassword, cleanDomain, currentAccount, randomToken, forgetCountedSites, MIN_PASSWORD, passwordReady, readCookie, removeSite, sessionCookie, SESSION_COOKIE, sha256, signOut, type Account } from "./accounts.ts";
import { deleteKey, listKeys, makeKey, MAX_KEYS, type ApiKey } from "./api.ts";
import { buildOverview, buildReport, CLAUDE_BUTTON, COPY, GOOGLE_BUTTON, RANGES, readView, renderDashboard, renderOverview, renderMessage, renderPage, type GoogleView, type Range } from "./dashboard.ts";
import { connectGhost, disconnectGhost, ghostHook, ghostState, postsBetween, titlesFor, type GhostState } from "./ghost.ts";
import { buildLive, renderLive } from "./live.ts";
import { connectUrl, disconnect, finishConnect, googleOn, googleState, searchReport, syncSearch, type Owner } from "./google.ts";
import type { Env } from "./index.ts";
import { utcDay } from "./visitor.ts";
import { fileName, toCsv, toXlsx } from "./export.ts";
import { findFixes } from "./fixes.ts";
import { mediaKitData, mediaKitName, mediaKitPdf } from "./mediakit.ts";
import { setDigest, wantsDigest } from "./digest.ts";
import { earningsByPage, earningsSummary, forgetEarnings, MAX_EARNINGS_BYTES, parseEarnings, saveEarnings } from "./earnings.ts";
import { brokenLinks, widelySent } from "./links.ts";
import { behaviourReport } from "./behaviour.ts";
import { siteHealth } from "./health.ts";
import { connectNetwork, disconnectNetwork, NETWORKS, needsSecret, networksFor, setTagging, taggingOn, type NetworkState } from "./affiliates.ts";
import { addTrigger, KINDS, listTriggers, NOTIFY, readTrigger, removeTrigger, triggerCounts, type Trigger } from "./triggers.ts";
import { addNote, forgetHistory, historySummary, MAX_FILE_BYTES, notesBetween, parseHistory, removeNote, saveHistory } from "./history.ts";
import { clientIp, overLimit, turnstileOk, turnstileOn } from "./guard.ts";
import { handleMcp } from "./mcp.ts";
import { accountPlan, LICENCE_SITES, type PlanState } from "./plans.ts";
import { HOME_URL, REPO_URL } from "./host.ts";
import { brandPage, loadBrand, saveBrand, supportHref, type Brand } from "./brand.ts";
import { addClient, addPlan, billingPortal, clientsAdmin, clientsOn, emailSignInLink, giveSite, isOwner, listClients, listPlans, makeSignInLink, plansPage, removeClient, removePlan, setClientsOn, startCheckout, stripeOn, stripeWebhook, updateClient, useSignInLink } from "./clients.ts";
import { mailFrom } from "./host.ts";
import { bearerAccount, checkAuthRequest, claudeConnected, denied, issueCode, OAUTH_CORS, register, resourceMetadata, revokeAll, serverMetadata, token, unauthorised, type AuthRequest } from "./oauth.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const see = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 303, headers: { Location: to, "Cache-Control": "no-store", ...headers } });

/** Where to go after signing in: only a path on this site. */
function safeNext(value: unknown): string {
	const v = String(value ?? "");
	// Browsers drop tabs and newlines and read a backslash as "/", so "/%09/evil.com" would otherwise leave the site.
	if (!v.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(v)) return "/";
	const u = new URL(v, "https://readercount.invalid");
	return u.origin === "https://readercount.invalid" && !v.startsWith("//") ? u.pathname + u.search + u.hash : "/";
}

function sameOrigin(request: Request, url: URL): boolean {
	const origin = request.headers.get("Origin");
	return !origin || origin === url.origin;
}

export async function appFetch(request: Request, env: Env, url: URL, ctx: ExecutionContext | undefined, now: number): Promise<Response> {
	let res = await appRoutes(request, env, url, ctx, now);
	if ((res.headers.get("Content-Type") ?? "").startsWith("text/html")) res = new Response(brandPage(await res.text(), await loadBrand(env.DB, now)), res);
	// Pages can't be shown inside another website's frame (so nobody can trick a click on them), except
	// public stats pages, which owners may want to show on their own website.
	if ((res.headers.get("Content-Type") ?? "").startsWith("text/html") && !url.pathname.startsWith("/share/") && !res.headers.has("Content-Security-Policy")) {
		const out = new Response(res.body, res);
		out.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
		out.headers.set("X-Frame-Options", "DENY");
		out.headers.set("X-Content-Type-Options", "nosniff");
		out.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
		return out;
	}
	return res;
}

async function appRoutes(request: Request, env: Env, url: URL, ctx: ExecutionContext | undefined, now: number): Promise<Response> {
	const p = url.pathname;
	// The Claude connector and its OAuth sign-in (src/oauth.ts), on the same address as everything else.
	if (p === "/mcp" || p === "/register" || p === "/token" || p.startsWith("/.well-known/oauth-")) {
		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: OAUTH_CORS });
		if (p.startsWith("/.well-known/oauth-protected-resource")) return resourceMetadata(url.origin);
		if (p.startsWith("/.well-known/oauth-authorization-server")) return serverMetadata(url.origin);
		if (p === "/register" && request.method === "POST") {
			if (await overLimit(env.FORM_LIMIT, "register:" + clientIp(request))) return Response.json({ error: "slow_down", error_description: "Too many apps registered from here. Try again in a minute." }, { status: 429, headers: OAUTH_CORS });
			return register(request, env.DB, now);
		}
		if (p === "/token" && request.method === "POST") return token(request, env.DB, now);
		if (p === "/mcp") {
			const accountId = await bearerAccount(request, env.DB, now);
			if (!accountId) return unauthorised(url.origin);
			const res = await handleMcp(request, env.DB, await accountSites(env.DB, accountId), now, accountId);
			for (const [k, v] of Object.entries(OAUTH_CORS)) res.headers.set(k, v);
			return res;
		}
		return new Response("Not found", { status: 404 });
	}
	if (p === "/authorize") return authorize(request, env, url, now);
	if (p === "/signin") return signIn(request, env, url, now);
	if (p === "/signin/email" && request.method === "POST") return emailLink(request, env, url, now);
	if (p.startsWith("/signin/link/")) return linkSignIn(request, env, url, p.slice("/signin/link/".length), now);
	// Stripe tells us about clients' payments (client mode). Checked by its signature, so no sign-in is needed.
	if (p === "/billing/webhook" && request.method === "POST") {
		if (!stripeOn(env)) return new Response("Card payments aren't set up", { status: 404 });
		return stripeWebhook(request, env, now);
	}
	if (p === "/signout" && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		await signOut(env.DB, request);
		return see("/signin", { "Set-Cookie": sessionCookie("", 0) });
	}
	// Ghost tells us when a post goes out; the secret address is the only key, so no sign-in is needed.
	if (p.startsWith("/ghost/hook/")) return ghostHook(request, env, p.slice("/ghost/hook/".length));

	// Public stats, for websites whose owner switched it on: no sign-in needed.
	if (p.startsWith("/share/") && request.method === "GET") return sharedStats(env, url, now);

	// Everything below needs someone signed in: the owner, or a client when client mode is on.
	const account = await currentAccount(env.DB, request, now);
	if (!account) return request.method === "GET" ? see(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`) : new Response("Sign in first", { status: 401 });
	const owner = isOwner(account);
	if (!owner && !(await clientsOn(env.DB, now))) {
		await signOut(env.DB, request);
		return renderPage("Signed out", `<h1>Not open at the moment</h1><p>Signing in is switched off here for now. Please get in touch with whoever runs your stats.</p>`, 403);
	}
	const sites = await accountSites(env.DB, account.id);
	const plan = await accountPlan(env.DB, account.id, now);
	if (owner && (p === "/clients" || p.startsWith("/clients/"))) return clientRoutes(request, env, url, now);
	if (!owner && (p === "/plans" || p.startsWith("/billing/"))) return planRoutes(request, env, url, account, plan, now);
	if (!owner && p === "/branding") return new Response("Forbidden", { status: 403 });
	// A client without a live plan sees the plans until they pick one.
	if (!owner && plan.ended) return request.method === "GET" ? see("/plans") : new Response("Pick a plan first", { status: 402 });
	if (url.pathname === "/" && request.method === "GET") return home(env, url, account, sites, now, plan);
	if (url.pathname === "/branding" && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		const saved = await saveBrand(env.DB, await request.formData());
		if ("error" in saved) return renderMessage("Couldn't save your branding", `${esc(saved.error)} <a href="/#branding">Back to your stats</a>`, 400);
		return see("/?branding=saved#branding");
	}
	if (url.pathname === "/sites" && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		const form = await request.formData();
		if (!owner) {
			const domain = cleanDomain(form.get("domain"));
			if (domain && !sites.includes(domain) && sites.length >= plan.sites) return renderMessage("Your plan is full", `Your plan covers ${plan.sites} website${plan.sites === 1 ? "" : "s"}. <a href="/plans">See the plans</a>`, 400);
			const taken = domain ? await env.DB.prepare("SELECT account_id FROM sites WHERE domain = ?").bind(domain).first<{ account_id: string }>() : null;
			if (taken && taken.account_id !== account.id) return renderMessage("Couldn't add that website", `That website is already on another account. <a href="/">Back to your stats</a>`, 400);
		}
		const added = await addSite(env.DB, account.id, form.get("domain"), now);
		if ("error" in added) return sites.length ? renderMessage("Couldn't add that website", `${esc(added.error)} <a href="/">Back to your stats</a>`, 400) : firstSite(env, account, added.error);
		if (googleOn(env) && (await googleState(env.DB, account.id)).connected && !sites.includes(added.domain)) {
			// Bring in the new website's last 90 days of Google searches now, rather than waiting for tonight's copy.
			const copy = syncSearch(env, account.id, [...sites, added.domain], now);
			if (ctx) ctx.waitUntil(copy);
			else await copy;
		}
		return see(`/?site=${encodeURIComponent(added.domain)}`);
	}
	if (url.pathname === "/sites/remove" && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		const form = await request.formData();
		const site = String(form.get("site") ?? "");
		if (!sites.includes(site)) return new Response("That isn't one of your websites.", { status: 404 });
		if (String(form.get("confirm") ?? "").trim().toLowerCase() !== site) return renderMessage("Type the address to confirm", `To remove ${esc(site)} and all its stats, type <b>${esc(site)}</b> in the box. <a href="/?site=${encodeURIComponent(site)}#remove">Back</a>`, 400);
		await removeSite(env.DB, account.id, site);
		return see("/");
	}
	if (url.pathname === "/share" && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		const form = await request.formData();
		const site = String(form.get("site") ?? "");
		if (!sites.includes(site)) return new Response("That isn't one of your websites.", { status: 404 });
		const on = form.get("public") === "on";
		await env.DB.prepare("UPDATE sites SET public = ?, public_google = ?, verified_at = COALESCE(verified_at, ?) WHERE domain = ? AND account_id = ?").bind(on ? 1 : 0, on && form.get("google") === "on" ? 1 : 0, now, site, account.id).run();
		return see(`/?site=${encodeURIComponent(site)}&share=${on ? "on" : "off"}#share`);
	}
	if ((url.pathname === "/api-keys" || url.pathname === "/api-keys/delete") && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		const form = await request.formData();
		const site = String(form.get("site") ?? "");
		if (!sites.includes(site)) return new Response("That isn't one of your websites.", { status: 404 });
		const back = `/?site=${encodeURIComponent(site)}`;
		if (url.pathname === "/api-keys/delete") {
			await deleteKey(env.DB, account.id, form.get("id"));
			return see(`${back}&api=deleted#api`);
		}
		const made = await makeKey(env.DB, account.id, site, form.get("name"), now);
		if ("error" in made) return renderMessage("Couldn't make a key", `${esc(made.error)} <a href="${esc(back)}#api">Back to your stats</a>`, 400);
		return newKeyPage(env, site, made.name, made.key, back);
	}
	if ((url.pathname === "/ghost/connect" || url.pathname === "/ghost/disconnect") && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		const form = await request.formData();
		const site = String(form.get("site") ?? "");
		if (!sites.includes(site)) return new Response("That isn't one of your websites.", { status: 404 });
		const back = `/?site=${encodeURIComponent(site)}`;
		if (url.pathname === "/ghost/disconnect") {
			await disconnectGhost(env, site, now);
			return see(`${back}&ghost=off#ghost`);
		}
		const done = await connectGhost(env, account.id, site, form.get("api_url"), form.get("key"), now);
		if ("error" in done) return renderMessage("Couldn't connect Ghost", `${esc(done.error)} <a href="${esc(back)}&ghost=open#ghost">Back to your stats</a>`, 400);
		return see(`${back}&ghost=on#ghost`);
	}
	if (url.pathname === "/digest" && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		const on = (await request.formData()).get("digest") === "on";
		await setDigest(env.DB, account.id, on);
		return see(on ? "/?digest=on#emails" : "/?digest=off#emails");
	}
	if ((url.pathname === "/spikes" || url.pathname === "/monthly" || url.pathname === "/downs") && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		const name = url.pathname.slice(1);
		const on = (await request.formData()).get(name) === "on";
		await env.DB.prepare(`UPDATE accounts SET ${name === "spikes" ? "spikes" : name === "downs" ? "downs" : "monthly"} = ? WHERE id = ?`).bind(on ? 1 : 0, account.id).run();
		return see(`/?${name}=${on ? "on" : "off"}#emails`);
	}
	if ((url.pathname === "/affiliates" || url.pathname === "/affiliates/remove" || url.pathname === "/affiliates/tagging") && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		const form = await request.formData();
		const site = String(form.get("site") ?? "");
		if (!sites.includes(site)) return new Response("That isn't one of your websites.", { status: 404 });
		if (url.pathname === "/affiliates/remove") {
			await disconnectNetwork(env.DB, site, form.get("network"));
			return see(`/?site=${encodeURIComponent(site)}&earnings=disconnected#earnings`);
		}
		if (url.pathname === "/affiliates/tagging") {
			await setTagging(env.DB, site, form.get("on") === "1");
			return see(`/?site=${encodeURIComponent(site)}&earnings=${form.get("on") === "1" ? "tagging-on" : "tagging-off"}#earnings`);
		}
		const done = await connectNetwork(env, site, form.get("network"), form.get("account"), form.get("token"), plan.networks, now, fetch, form.get("secret"));
		if ("error" in done) return renderMessage("Couldn't connect that network", `${esc(done.error)} <a href="/?site=${encodeURIComponent(site)}#earnings">Back to your stats</a>`, 400);
		return see(`/?site=${encodeURIComponent(site)}&range=30d&earnings=connected#earnings`);
	}
	if ((url.pathname === "/earnings" || url.pathname === "/earnings/remove") && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		if (Number(request.headers.get("Content-Length") ?? 0) > MAX_EARNINGS_BYTES + 10_000) return renderMessage("That file is too big", `Reports can be up to 2 MB. Download a shorter date range, then try again. <a href="/">Back to your stats</a>`, 413);
		const form = await request.formData();
		const site = String(form.get("site") ?? "");
		if (!sites.includes(site)) return new Response("That isn't one of your websites.", { status: 404 });
		const again = `<a href="/?site=${encodeURIComponent(site)}#earnings">Back to your stats</a>`;
		if (url.pathname === "/earnings/remove") {
			await forgetEarnings(env.DB, site);
			return see(`/?site=${encodeURIComponent(site)}&earnings=removed#earnings`);
		}
		const file = form.get("file") as unknown as File | string | null;
		if (!file || typeof file === "string" || !file.size) return renderMessage("Pick a file first", `Choose the report you downloaded from your affiliate network, then click Import earnings. ${again}`, 400);
		if (file.size > MAX_EARNINGS_BYTES) return renderMessage("That file is too big", `Reports can be up to 2 MB. Download a shorter date range, then try again. ${again}`, 413);
		const read = parseEarnings(await file.text(), String(form.get("shop") ?? ""));
		if ("error" in read) return renderMessage("We couldn't read that file", `${esc(read.error)} ${again}`, 400);
		await saveEarnings(env.DB, site, read.rows);
		return see(`/?site=${encodeURIComponent(site)}&range=30d&earnings=${read.rows.length}#earnings`);
	}
	if (url.pathname === "/claude/disconnect" && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		await revokeAll(env.DB, account.id);
		return see("/?claude=disconnected#connections");
	}
	if (url.pathname === "/live" && request.method === "GET") {
		const site = url.searchParams.get("site") ?? "";
		if (!sites.includes(site)) return new Response("That isn't one of your websites.", { status: 404 });
		const live = await buildLive(env.DB, site, now);
		const titles = await titlesFor(env.DB, site, live.visitors.flatMap((v) => v.steps.map((s) => s.path)));
		return new Response(renderLive(live, sites, { email: account.email, titles }), {
			headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
		});
	}
	if (url.pathname === "/check" && request.method === "GET") {
		const site = url.searchParams.get("site") ?? "";
		if (!sites.includes(site)) return Response.json({ error: "That isn't one of your websites." }, { status: 404 });
		return Response.json(await checkSite(env, site, now), { headers: { "Cache-Control": "no-store" } });
	}
	if (url.pathname === "/export" && request.method === "GET") {
		const site = url.searchParams.get("site") ?? "";
		if (!sites.includes(site)) return new Response("That isn't one of your websites.", { status: 404 });
		const asked = url.searchParams.get("range") ?? "";
		const report = await buildReport(env.DB, site, Object.hasOwn(RANGES, asked) ? (asked as Range) : "7d", now, true);
		const excel = url.searchParams.get("format") === "xlsx";
		return new Response(excel ? toXlsx(report) : toCsv(report), {
			headers: {
				"Content-Type": excel ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8",
				"Content-Disposition": `attachment; filename="${fileName(report, excel ? "xlsx" : "csv")}"`,
				"Cache-Control": "no-store",
			},
		});
	}
	if (url.pathname === "/media-kit" && request.method === "GET") {
		const site = url.searchParams.get("site") ?? "";
		if (!sites.includes(site)) return new Response("That isn't one of your websites.", { status: 404 });
		const row = await env.DB.prepare("SELECT public, verified_at FROM sites WHERE domain = ?").bind(site).first<{ public: number; verified_at: number | null }>();
		const live = row?.public && row.verified_at ? `https://${env.APP_HOST}/share/${site}` : undefined;
		return mediaKitResponse(await mediaKitData(env.DB, site, now, { live, verified: Boolean(row?.verified_at) }), now, "no-store");
	}
	if ((url.pathname === "/triggers" || url.pathname === "/triggers/remove") && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		const form = await request.formData();
		const site = String(form.get("site") ?? "");
		if (!sites.includes(site)) return new Response("That isn't one of your websites.", { status: 404 });
		const back = (k: string) => `/?site=${encodeURIComponent(site)}&triggers=${k}#triggers`;
		const again = `<a href="/?site=${encodeURIComponent(site)}#triggers">Back to your stats</a>`;
		if (url.pathname === "/triggers/remove") {
			await removeTrigger(env.DB, site, Number(form.get("id")));
			return see(back("removed"));
		}
		const t = readTrigger(Object.fromEntries(form) as Record<string, unknown>);
		if ("error" in t) return renderMessage("Couldn't add that trigger", `${esc(t.error)} ${again}`, 400);
		const have = await listTriggers(env.DB, site);
		if (have.length >= plan.triggers) return renderMessage("You've reached your triggers", `Your plan has up to ${plan.triggers} triggers for each website. Remove one you don't need, then add this one. ${again}`, 400);
		if (t.webhook && have.filter((x) => x.webhook).length >= plan.hooks) return renderMessage("You've reached your webhooks", `Your plan has up to ${plan.hooks} triggers with a webhook for each website. Add this one without a webhook, or take the webhook off another. ${again}`, 400);
		await addTrigger(env.DB, site, t, now);
		return see(back("added"));
	}
	if ((url.pathname === "/notes" || url.pathname === "/notes/remove") && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		const form = await request.formData();
		const site = String(form.get("site") ?? "");
		if (!sites.includes(site)) return new Response("That isn't one of your websites.", { status: 404 });
		const range = String(form.get("range") ?? "");
		const back = `/?site=${encodeURIComponent(site)}${Object.hasOwn(RANGES, range) ? `&range=${range}` : ""}#chart`;
		if (url.pathname === "/notes/remove") await removeNote(env.DB, site, form.get("id"));
		else {
			const problem = await addNote(env.DB, site, form.get("day"), form.get("text"), now);
			if (problem) return renderMessage("Couldn't add that note", `${esc(problem)} <a href="${esc(back)}">Back to your stats</a>`, 400);
		}
		return see(back);
	}
	if ((url.pathname === "/history" || url.pathname === "/history/remove") && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		const tooBig = (back: string) => renderMessage("That file is too big", `Files can be up to 5 MB. Download fewer columns (just the date, users and views), then try again. ${back}`, 413);
		if (Number(request.headers.get("Content-Length") ?? 0) > MAX_FILE_BYTES + 10_000) return tooBig(`<a href="/">Back to your stats</a>`);
		const form = await request.formData();
		const site = String(form.get("site") ?? "");
		if (!sites.includes(site)) return new Response("That isn't one of your websites.", { status: 404 });
		const again = `<a href="/?site=${encodeURIComponent(site)}#history">Back to your stats</a>`;
		if (url.pathname === "/history/remove") {
			await forgetHistory(env.DB, site);
			return see(`/?site=${encodeURIComponent(site)}&history=removed#history`);
		}
		const file = form.get("file") as unknown as File | string | null;
		if (!file || typeof file === "string" || !file.size) return renderMessage("Pick a file first", `Choose the CSV file you downloaded, then click Import CSV dataset. ${again}`, 400);
		if (file.size > MAX_FILE_BYTES) return tooBig(again);
		const read = parseHistory(await file.text(), now);
		if ("error" in read) return renderMessage("We couldn't read that file", `${esc(read.error)} ${again}`, 400);
		await saveHistory(env.DB, site, read.days);
		return see(`/?site=${encodeURIComponent(site)}&range=12m&history=${read.days.length}#history`);
	}
	if (url.pathname.startsWith("/google/")) return googleRoutes(request, env, url, account.id, sites, ctx, now);
	return new Response("Not found", { status: 404 });
}

// ---- Signing in ----

function signInPage(env: Env, next: string, error = "", status = 200, clients = false): Response {
	const ready = passwordReady(env.ADMIN_PASSWORD);
	const err = error ? `<p class="err">${esc(error)}</p>` : "";
	if (!ready) {
		return renderPage(
			"Set a password first",
			`<h1>Set a password first</h1><p>This ReaderCount needs a password before anyone can sign in. In the Cloudflare dashboard, open <b>Workers &amp; Pages</b>, then this Worker, then <b>Settings</b> › <b>Variables and Secrets</b>, and add a secret called <code>ADMIN_PASSWORD</code> with at least ${MIN_PASSWORD} characters. Then come back to this page.</p><p class="hint">Or from the code: <code>npx wrangler secret put ADMIN_PASSWORD</code></p>`,
			503,
		);
	}
	// Cloudflare Turnstile, when both keys are set: a box in each form that most people never see (guard.ts).
	const ts = turnstileOn(env) ? `<div class="cf-turnstile" data-sitekey="${esc(env.TURNSTILE_SITE_KEY!)}" data-appearance="interaction-only"></div>` : "";
	return renderPage(
		"Sign in",
		`${ts ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ""}<h1>Sign in to ReaderCount</h1><p>Enter the password you chose when you set up ReaderCount.</p>${err}<form method="post" action="/signin" class="f"><input type="hidden" name="next" value="${esc(next)}"><input type="text" name="username" value="ReaderCount" autocomplete="username" hidden><label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password" required autofocus>${ts}<button class="go" type="submit">Sign in</button></form><p class="hint">Forgotten it? Set a new <code>ADMIN_PASSWORD</code> secret for this Worker in the Cloudflare dashboard.</p>${clients && env.EMAIL ? `<h2>Signing in as a client?</h2><p>We'll email you a link that signs you in.</p><form method="post" action="/signin/email" class="f"><label for="email">Your email address</label><input id="email" type="email" name="email" autocomplete="email" required>${ts}<button class="go" type="submit">Email me a sign-in link</button></form>` : ""}`,
		status,
	);
}

async function signIn(request: Request, env: Env, url: URL, now: number): Promise<Response> {
	if (request.method === "GET") return signInPage(env, safeNext(url.searchParams.get("next")), "", 200, await clientsOn(env.DB, now));
	if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
	if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
	if (await overLimit(env.FORM_LIMIT, "signin:" + clientIp(request))) return signInPage(env, "/", "Too many tries from here. Please wait a minute and try again.", 429);
	const form = await request.formData();
	const next = safeNext(form.get("next"));
	if (!(await robotOk(env, request, form))) return signInPage(env, next, ROBOT_ERROR, 403, await clientsOn(env.DB, now));
	const done = await checkPassword(env.DB, env, form.get("password"), now);
	if ("error" in done) return signInPage(env, next, done.error, 400);
	// Remembered for emails sent on a schedule, which have no request to take the address from.
	await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('app_host', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(url.host).run();
	return see(next, { "Set-Cookie": sessionCookie(done.token) });
}

const ROBOT_ERROR = "We couldn't check you're a person. Please try again, and tick the box if one appears.";
/** True when Turnstile is off, or the form's answer from it is genuine. */
async function robotOk(env: Env, request: Request, form: FormData): Promise<boolean> {
	if (!turnstileOn(env)) return true;
	const token = form.get("cf-turnstile-response");
	return turnstileOk(env.TURNSTILE_SECRET!, typeof token === "string" ? token : "", clientIp(request));
}

/** A client asks for a sign-in link by email (client mode). */
async function emailLink(request: Request, env: Env, url: URL, now: number): Promise<Response> {
	if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
	if (!(await clientsOn(env.DB, now))) return see("/signin");
	if (await overLimit(env.FORM_LIMIT, "signin:" + clientIp(request))) return signInPage(env, "/", "Too many tries from here. Please wait a minute and try again.", 429, true);
	const form = await request.formData();
	if (!(await robotOk(env, request, form))) return signInPage(env, "/", ROBOT_ERROR, 403, true);
	const error = await emailSignInLink(env.DB, env.EMAIL, mailFrom(env), form.get("email"), url.origin, now);
	if (error) return signInPage(env, "/", error, 400, true);
	return renderPage("Check your email", `<h1>Check your email</h1><p>If that address has an account here, a sign-in link is on its way. It works once, for the next 30 minutes.</p>`);
}

/** Opening a one-time sign-in link. A GET only shows a button, so email scanners that open links don't use it up. */
async function linkSignIn(request: Request, env: Env, url: URL, token: string, now: number): Promise<Response> {
	if (!(await clientsOn(env.DB, now))) return see("/signin");
	if (request.method === "GET") return renderPage("Sign in", `<h1>Sign in</h1><form method="post" class="f"><button class="go" type="submit">Sign in now</button></form>`);
	if (request.method !== "POST" || !sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
	const accountId = /^[A-Za-z0-9_-]{16,100}$/.test(token) ? await useSignInLink(env.DB, token, now) : null;
	if (!accountId) return renderPage("Link expired", `<h1>That link has expired</h1><p>Each link works once, for 30 minutes. <a href="/signin">Ask for a new one</a>.</p>`, 400);
	const session = randomToken();
	await env.DB.prepare("INSERT INTO sessions (token_hash, account_id, expires) VALUES (?, ?, ?)").bind(await sha256(session), accountId, now + 30 * 86_400_000).run();
	return see("/", { "Set-Cookie": sessionCookie(session) });
}

// ---- Clients (client mode, owner only) ----

async function clientRoutes(request: Request, env: Env, url: URL, now: number): Promise<Response> {
	const p = url.pathname;
	const page = async (note = "", link?: { email: string; url: string }, status = 200) =>
		renderPage("Clients", clientsAdmin({ on: await clientsOn(env.DB, now), stripe: stripeOn(env), email: Boolean(env.EMAIL), plans: await listPlans(env.DB), clients: await listClients(env.DB), origin: url.origin, note, link }), status, {}, "msg wide");
	if (request.method === "GET") return p === "/clients" ? page(url.searchParams.get("saved") ? "Saved." : "") : new Response("Not found", { status: 404 });
	if (request.method !== "POST" || !sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
	const form = await request.formData();
	const back = (error: string | null) => (error ? page(error, undefined, 400) : see("/clients?saved=1"));
	if (p === "/clients/switch") {
		await setClientsOn(env.DB, form.get("on") === "on");
		return see("/clients?saved=1");
	}
	if (p === "/clients/plans") return back(await addPlan(env.DB, form, now));
	if (p === "/clients/plans/remove") {
		await removePlan(env.DB, form.get("id"));
		return see("/clients?saved=1");
	}
	if (p === "/clients/add") return back(await addClient(env.DB, form, now));
	if (p === "/clients/update") {
		await updateClient(env.DB, form);
		return see("/clients?saved=1");
	}
	const id = String(form.get("id") ?? "");
	const client = await env.DB.prepare("SELECT id, email FROM accounts WHERE id = ? AND id != 'owner'").bind(id).first<{ id: string; email: string }>();
	if (!client) return back("That client isn't here any more.");
	if (p === "/clients/site") {
		const domain = cleanDomain(form.get("domain"));
		if (!domain) return back("Please enter the website's address, like theirsite.com.");
		return back(await giveSite(env.DB, client.id, domain, now));
	}
	if (p === "/clients/link") return page("", { email: client.email, url: await makeSignInLink(env.DB, client.id, url.origin, now) });
	if (p === "/clients/remove") {
		if (String(form.get("confirm") ?? "").trim().toLowerCase() !== client.email) return back("Type the client's email address exactly to remove them.");
		await removeClient(env.DB, client.id, (site) => removeSite(env.DB, client.id, site));
		return see("/clients?saved=1");
	}
	return new Response("Not found", { status: 404 });
}

// ---- Plans and paying (client mode, clients only) ----

async function planRoutes(request: Request, env: Env, url: URL, account: Account, plan: PlanState, now: number): Promise<Response> {
	const p = url.pathname;
	if (p === "/plans" && request.method === "GET") {
		const row = await env.DB.prepare("SELECT client_plan, stripe_customer, status FROM accounts WHERE id = ?").bind(account.id).first<{ client_plan: number | null; stripe_customer: string | null; status: string }>();
		const brand = await loadBrand(env.DB, now);
		return renderPage("Plans", plansPage({ plan, current: row?.client_plan ?? null, plans: await listPlans(env.DB), stripe: stripeOn(env), paying: Boolean(row?.stripe_customer) && stripeOn(env), paid: url.searchParams.has("paid"), support: brand.support ? supportHref(brand) : "" }), 200, {}, "msg wide");
	}
	if (request.method !== "POST" || !sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
	const form = await request.formData();
	const go = p === "/billing/checkout" ? await startCheckout(env, account, form.get("plan"), url.origin) : p === "/billing/manage" ? await billingPortal(env, account, url.origin) : null;
	if (!go) return new Response("Not found", { status: 404 });
	if ("error" in go) return renderMessage("Couldn't open payments", `${esc(go.error)} <a href="/plans">Back to plans</a>`, 400);
	return see(go.url);
}

// ---- Allowing Claude (OAuth consent) ----

async function consentToken(request: Request): Promise<string> {
	return sha256(readCookie(request, SESSION_COOKIE) + ":allow");
}

async function authorize(request: Request, env: Env, url: URL, now: number): Promise<Response> {
	const params = request.method === "POST" ? new URLSearchParams((await request.formData()) as unknown as Record<string, string>) : url.searchParams;
	const checked = await checkAuthRequest(env.DB, params);
	if ("page" in checked) return renderPage("Can't connect", `<h1>Can't connect</h1><p>${esc(checked.page)}</p>`, 400);
	if ("redirect" in checked) return see(checked.redirect);
	const req: AuthRequest = checked.ok;
	const account = await currentAccount(env.DB, request, now);
	if (!account) {
		if (request.method === "POST") return new Response("Sign in first", { status: 401 });
		return see(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`);
	}
	const csrf = await consentToken(request);
	if (request.method === "POST") {
		if (!sameOrigin(request, url) || params.get("csrf") !== csrf) return new Response("Forbidden", { status: 403 });
		if (params.get("decision") !== "allow") return see(denied(req));
		return see(await issueCode(env.DB, req, account.id, url.origin, now));
	}
	if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
	const sites = await accountSites(env.DB, account.id);
	const keep = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"]
		.filter((k) => params.has(k))
		.map((k) => `<input type="hidden" name="${k}" value="${esc(params.get(k))}">`)
		.join("");
	const where = new URL(req.redirectUri).hostname;
	return renderPage(
		"Allow access",
		`<h1>Let ${esc(req.clientName)} read your stats?</h1><p>Signed in as <b>${esc(account.email)}</b>.</p><form method="post" action="/authorize" class="f">${keep}<input type="hidden" name="csrf" value="${csrf}"><p>${esc(req.clientName)} (${esc(where)}) will be able to read the stats for:</p><ul>${
			sites.length ? sites.map((s) => `<li>${esc(s)}</li>`).join("") : "<li>your websites, once you add one</li>"
		}</ul><p class="hint">It can't change anything. You can disconnect it at any time from your ReaderCount stats page.</p><button class="go" type="submit" name="decision" value="allow">Allow</button><button class="no" type="submit" name="decision" value="deny">Cancel</button></form>`,
	);
}

// ---- Your stats ----

function snippet(env: Env, domain: string): string {
	return `<script defer src="https://${env.APP_HOST}/s.js" data-site="${domain}"></script>`;
}

// ---- "Check it's working" ----

/** When ReaderCount last heard from a website, if it was in the last day. */
export async function lastVisit(db: D1Database, site: string, now: number): Promise<number | null> {
	const row = await db.prepare("SELECT ts FROM events WHERE site = ? AND day >= ? ORDER BY ts DESC LIMIT 1").bind(site, utcDay(now - 86_400_000)).first<{ ts: number }>();
	return row && now - row.ts < 86_400_000 ? row.ts : null;
}

export type SiteCheck = { ok: boolean; message: string };

/** Is the code on the website's home page, and has ReaderCount had a visit from it? */
export async function checkSite(env: Env, site: string, now: number, get: typeof fetch = fetch): Promise<SiteCheck> {
	const seen = await lastVisit(env.DB, site, now);
	if (seen) return { ok: true, message: `Working. The last visit arrived ${ago(now - seen)}.` };
	// The code is sending visits, but from a page on another website (copied to the wrong site, or the wrong code).
	const elsewhere = await env.DB.prepare("SELECT detail FROM filtered WHERE site = ? AND reason = 'wrong site' AND day >= ? AND detail IS NOT NULL ORDER BY day DESC LIMIT 1")
		.bind(site, utcDay(now - 86_400_000))
		.first<{ detail: string }>();
	if (elsewhere) return { ok: false, message: `Your code for ${site} is on a different website, ${elsewhere.detail}, so those visits aren't counted. Put the code on ${site}, or add ${elsewhere.detail} as another website and use its own code.` };
	const found = await codeOnHomePage(site, get);
	if (found) return { ok: true, message: `Working. We found the code on ${site}. Visits will appear here as people read your site.` };
	if (found === false) return { ok: false, message: `We can't see the code on ${site}'s home page yet. Check it's in the <head> and that you've saved or published the change. If your site uses a cache, it can take a few minutes.` };
	return { ok: false, message: `We couldn't open ${site} to check. Visit your site in another tab, then check again.` };
}

/** Whether the site's home page carries its ReaderCount code; null when the page couldn't be opened. */
export async function codeOnHomePage(site: string, get: typeof fetch = fetch): Promise<boolean | null> {
	try {
		const res = await get(`https://${site}/`, { headers: { "User-Agent": "ReaderCount setup check (+https://paulobrien.dev/readercount/)" }, redirect: "follow", signal: AbortSignal.timeout(8000) });
		const html = (await res.text()).slice(0, 2_000_000);
		return html.includes("/s.js") && new RegExp(`data-site=["']?(www\\.)?${site.replace(/[.]/g, "\\.")}["' >]`).test(html);
	} catch {
		return null;
	}
}

function ago(ms: number): string {
	const m = Math.round(ms / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
	const h = Math.round(m / 60);
	return `${h} hour${h === 1 ? "" : "s"} ago`;
}

function checkBox(site: string, lastSeen: number | null, now: number): string {
	const status = lastSeen ? `<p class="ck-status ok" data-check-status>● Working. The last visit arrived ${ago(now - lastSeen)}.</p>` : `<p class="ck-status" data-check-status>After embedding the script, execute a verification test.</p>`;
	return `<div class="ck">${status}<button type="button" class="ck-btn" data-check="${esc(site)}">${lastSeen ? "Check again" : "Verify snippet installation"}</button></div>`;
}

// ---- Settings, under the stats ----
// Every setting is a row: its name, an ⓘ that explains it, how it's set now, and one button.
// Rows that need more room open a panel underneath.

/** A small ⓘ that explains a setting when you hover over it, tap it or tab to it. */
function tip(text: string): string {
	return `<span class="tip" tabindex="0" role="note" aria-label="${esc(text)}" data-tip="${esc(text)}">i</span>`;
}

function rowText(title: string, help: string, sub: string): string {
	return `<span class="set-text"><span class="set-title">${title}${tip(help)}</span>${sub ? `<span class="set-sub">${sub}</span>` : ""}</span>`;
}

function row(title: string, help: string, sub: string, action: string): string {
	return `<div class="set-row">${rowText(title, help, sub)}<div class="set-act">${action}</div></div>`;
}

/** A row whose button opens a panel underneath it. */
function panel(id: string, open: boolean, title: string, help: string, sub: string, label: string, body: string, extra = ""): string {
	return `<details class="set-more${extra}"${id ? ` id="${id}"` : ""}${open ? " open" : ""}><summary class="set-row">${rowText(title, help, sub)}<span class="set-act"><span class="btn-out set-open">${label}</span></span></summary><div class="set-body">${body}</div></details>`;
}

function setCard(id: string, title: string, intro: string, rows: string): string {
	return `<section class="card set-card" id="${id}"><div class="set-head"><h2>${title}</h2>${intro ? `<p>${intro}</p>` : ""}</div>${rows}</section>`;
}

function settingsHead(title: string): string {
	return `<div class="settings-head"><h2>${title}</h2><p>Hover over or tap <span class="tip tip-demo" aria-hidden="true">i</span> tooltips to view setting details.</p></div>`;
}

const ON = (text: string) => `<span class="on">● ${text}</span>`;

/** Every website on the account, with a status light, and a box to add another. */
function websitesCard(sites: string[], seen: (number | null)[], current: string | null): string {
	const rows = sites
		.map((s, i) => {
			const light = seen[i] ? `<span class="pill ok">● Working</span>` : `<span class="pill wait">○ Awaiting initial traffic snippet execution</span>`;
			const action = s === current ? `<span class="pill here">Currently selected</span>` : `<a class="btn-out" href="/?site=${encodeURIComponent(s)}">Open dashboard</a>`;
			return `<div class="set-row site-row"><span class="site-name">${esc(s)}</span><div class="set-act">${light}${action}</div></div>`;
		})
		.join("");
	return setCard("websites", "Registered Properties", "", rows + addSiteRow());
}

/** The box to add another website: on the overview for accounts with two or more, in settings otherwise. */
export function addSiteRow(): string {
	return `<form method="post" action="/sites" class="set-row add-site"><span class="set-text"><label class="set-title" for="new-site">Register an additional property${tip("Register an additional domain property to your account. Each property receives a unique tracking snippet and isolated metrics.")}</label></span><div class="set-act add-fields"><input id="new-site" name="domain" placeholder="myblog.com" autocapitalize="off" spellcheck="false" required><button class="cl-copy" type="submit">Add property</button></div></form>`;
}

type SiteSettings = { networks: NetworkState[]; tagLinks: boolean; adsense: AdsenseState | null; triggers: Trigger[]; limits: { triggers: number; hooks: number; networks: number }; site: string; code: string; lastSeen: number | null; share: { on: boolean; google: boolean }; history: Awaited<ReturnType<typeof historySummary>>; earnings: Awaited<ReturnType<typeof earningsSummary>>; keys: ApiKey[]; ghost: GhostState; url: URL };

/** Settings for the website on screen: its code, public stats and older stats. */
function siteCard(env: Env, s: SiteSettings, now: number): string {
	const just = (k: string) => s.url.searchParams.get(k);
	const code = panel(
		"code",
		!s.lastSeen,
		"Tracking Code Snippet",
		"Lightweight snippet (~1 KB) embedded into your website HTML. Operates without cookies and executes asynchronously.",
		s.lastSeen ? ON(`Status: Working. The last visit arrived ${ago(now - s.lastSeen)}.`) : "Status: Pending installation",
		"Get snippet",
		`<p class="gs-intro">Paste this script snippet into the <code>&lt;head&gt;</code> section of your website templates (In Ghost: Settings › Code injection › Site header..)</p><div class="cl-row"><input class="cl-url" readonly value="${s.code}" aria-label="Tracking script snippet for ${esc(s.site)}"><button type="button" class="cl-copy" data-copy>Copy snippet</button></div>${checkBox(s.site, s.lastSeen, now)}`,
	);
	const share = panel(
		"share",
		Boolean(just("share")),
		"Public Metrics Page",
		"Publishes a public analytics page so sponsors and advertisers can see your audience numbers. Only for websites you run, and the What to fix list is never shown.",
		s.share.on ? ON("Status: Enabled. Anyone with the link can view these metrics.") : "Status: Disabled",
		s.share.on ? "Manage" : "Configure",
		shareBox(env, s.site, s.share.on, s.share.google, just("share")),
	);
	const h = s.history;
	const older = panel(
		"history",
		Boolean(just("history")),
		"Historical Data Import",
		"Importing metrics from Google Analytics? Import historical daily visitor totals to populate timeline charts without starting from zero.",
		h.days ? ON(`Status: ${h.days.toLocaleString("en-GB")} days imported, from ${longDate(h.from)}.`) : "Status: No historical data imported",
		h.days ? "Manage" : "Import CSV",
		historyBox(s.site, h, just("history")),
	);
	const e = s.earnings;
	const earn = panel(
		"earnings",
		Boolean(just("earnings")),
		"Earnings per post",
		"Connect Awin, Impact or CJ to bring in your commissions every night, or upload a report from Amazon Associates or any network, to see how much each post earns.",
		s.networks.length
			? ON(`Status: ${s.networks.map((n) => NETWORKS[n.network].name).join(", ")} connected${e ? `, and £${(e.pence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} uploaded` : ""}.`)
			: e ? ON(`Status: £${(e.pence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} imported, ${longDate(e.first)} to ${longDate(e.last)}.`) : "Status: No earnings imported",
		e || s.networks.length ? "Manage" : "Set up",
		adsenseBox(s.adsense, just("earnings"), now) + networksBox(s.site, s.networks, s.tagLinks, s.limits.networks, just("earnings"), now) + earningsBox(s.site, e, just("earnings")),
	);
	const api = panel(
		"api",
		Boolean(just("api")),
		"API Keys",
		"Authorises external applications to query metrics programmatically via REST API. Tokens grant read-only permissions to this property.",
		s.keys.length ? ON(`Status: ${s.keys.length} API key${s.keys.length === 1 ? "" : "s"} generated`) : "Status: No API keys generated",
		s.keys.length ? "Manage" : "Configure",
		apiBox(s.site, s.keys, just("api"), now),
	);
	const g = s.ghost;
	const ghost = panel(
		"ghost",
		Boolean(just("ghost")),
		"Ghost",
		"For websites on Ghost: shows your posts' titles in the stats and marks each new post on the chart. ReaderCount can only read your posts.",
		g.connected ? (g.error ? `<span class="gs-err">${esc(g.error)}</span>` : ON(`Status: Connected. ${(g.posts ?? 0).toLocaleString("en-GB")} post${g.posts === 1 ? "" : "s"} read.`)) : "Status: Not connected",
		g.connected ? "Manage" : "Connect Ghost",
		ghostBox(s.site, g, just("ghost")),
	);
	const trig = panel(
		"triggers",
		Boolean(just("triggers")),
		"Triggers",
		"Count a page visited, a link clicked or a form sent as a goal, with no code. Get an email, or a message in Slack, Discord, Teams or Zapier, when it happens.",
		s.triggers.length ? ON(`Status: ${s.triggers.length} trigger${s.triggers.length === 1 ? "" : "s"} set up`) : "Status: No triggers",
		s.triggers.length ? "Manage" : "Add a trigger",
		triggersBox(s.site, s.triggers, s.limits, just("triggers")),
	);
	const remove = panel(
		"remove",
		just("remove") !== null,
		"Remove this website",
		"Stops counting this website and deletes all its stats, settings and keys. This can't be undone.",
		"Deletes its stats for good",
		"Remove",
		`<p class="gs-intro">Download anything you want to keep first. To remove <b>${esc(s.site)}</b> and all its stats, type its address below.</p><form method="post" action="/sites/remove" class="cl-row"><input type="hidden" name="site" value="${esc(s.site)}"><input class="cl-url" name="confirm" placeholder="${esc(s.site)}" autocomplete="off" autocapitalize="off" spellcheck="false" required aria-label="Type ${esc(s.site)} to confirm"><button class="cl-copy btn-danger" type="submit">Remove website</button></form>`,
	);
	return setCard("this-site", `Configuration: ${esc(s.site)}`, "Settings for the selected domain property.", code + trig + ghost + share + older + earn + api + remove);
}

/** Google Search Console and Claude, for the whole account. */
function connectionsCard(env: Env, google: { connected: boolean; error?: string | null } | null, claude: boolean, claudeUrl: string): string {
	const g = google
		? row(
				"Google Search Console",
				"Imports organic search terms, impression counts, and average SERP positions. Access is strictly read-only.",
				google.connected ? (google.error ? `<span class="gs-err">${esc(google.error)}</span>` : ON("Status: Connected")) : "Status: Disconnected",
				google.connected
					? `${google.error ? `<a class="btn-out" href="/google/connect">Connect again</a>` : ""}<form method="post" action="/google/disconnect"><button class="btn-out" type="submit">Disconnect</button></form>`
					: GOOGLE_BUTTON,
			)
		: "";
	const manual = `<details class="set-manual"><summary>Manual MCP Endpoint Configuration</summary><ol class="cl-steps"><li>Within claude.ai, navigate to Settings › Connectors › <b>Add custom connector</b>.</li><li>Name the connector <b>ReaderCount</b> and paste this endpoint URL:<div class="cl-row"><input class="cl-url" readonly value="${esc(claudeUrl)}" aria-label="The Claude connector address"><button type="button" class="cl-copy" data-copy>Copy</button></div></li><li>Click <b>Add</b>, then <b>Connect</b>, and authenticate with your ReaderCount credentials. Click <b>Allow</b>, and toggle ReaderCount active within your chat window.</li></ol></details>`;
	const c = row(
		"Claude AI MCP Connector",
		"Enables natural language analytics queries within Claude via read-only Model Context Protocol access.",
		claude ? ON("Status: Connected. Toggle ReaderCount active within your chat window.") : `Status: Disconnected ${manual}`,
		claude ? `<form method="post" action="/claude/disconnect"><button class="btn-out" type="submit">Disconnect</button></form>` : CLAUDE_BUTTON,
	);
	return setCard("connections", "Third-Party Integrations", "Supported third-party platforms.", g + c);
}

function toggle(action: string, name: string, on: boolean, label: string): string {
	return `<form method="post" action="${action}"><label class="switch"><input type="checkbox" name="${name}"${on ? " checked" : ""} onchange="this.form.submit()" aria-label="${esc(label)}"><span aria-hidden="true"></span></label><noscript><button class="cl-copy" type="submit">Save</button></noscript></form>`;
}

/** Both emails ReaderCount can send, in one place. */
function emailsCard(env: Env, email: string, digest: boolean, url: URL, alerts: { spikes: boolean; monthly: boolean; downs: boolean }): string {
	const said = (k: string, on: string, off: string) => (url.searchParams.get(k) === "on" ? `<span class="on">${on}</span>` : url.searchParams.get(k) === "off" ? off : "");
	const d = row(
		"Weekly Optimisation Digest",
		"Delivered every Monday morning: summarises weekly property traffic alongside prioritised content optimisation recommendations.",
		said("digest", "Done. Your first one arrives next Monday morning.", "Done, no more Monday emails.") || (digest ? "Status: Enabled" : "Status: Disabled"),
		toggle("/digest", "digest", digest, "Receive weekly optimisation digest emails"),
	);
	const sp = row(
		"Traffic spike alerts",
		"An email the moment a post takes off: when a page gets five times its usual readers in an hour, with where they're coming from.",
		said("spikes", "Done. We'll email you when a post takes off.", "Done, no more spike alerts.") || (alerts.spikes ? "Status: Enabled" : "Status: Disabled"),
		toggle("/spikes", "spikes", alerts.spikes, "Receive traffic spike alerts"),
	);
	const dn = row(
		"Site down alerts",
		"We open your home page every 5 minutes. If it fails twice in a row (about 10 minutes), we email you, and again when it's back.",
		said("downs", "Done. We'll email you if your website goes down.", "Done, no more site down alerts.") || (alerts.downs ? "Status: Enabled" : "Status: Disabled"),
		toggle("/downs", "downs", alerts.downs, "Receive site down alerts"),
	);
	const mo = row(
		"Monthly review",
		"On the first of each month: your month against the one before, your top posts, and the biggest risers and fallers.",
		said("monthly", "Done. Your first one arrives on the 1st.", "Done, no more monthly reviews.") || (alerts.monthly ? "Status: Enabled" : "Status: Disabled"),
		toggle("/monthly", "monthly", alerts.monthly, "Receive the monthly review email"),
	);
	const where = env.EMAIL && !email.endsWith("@localhost") ? `Sent to <b>${esc(email)}</b>. Switch any of them off at any time.` : `Emails are off until you set them up: add the <code>OWNER_EMAIL</code> setting and an email binding, as the README explains. <a href="${REPO_URL}#emails" target="_blank" rel="noopener">How to set up emails</a>`;
	return setCard("emails", "Email Notification Preferences", where, d + sp + dn + mo);
}

/** Signing out, putting ReaderCount on a device, and the licence reminder. */
function accountCard(sites: number, brand: Brand, url: URL, clients: boolean): string {
	const licence = sites > LICENCE_SITES ? `<span class="gs-err">${sites} websites: the free licence covers up to ${LICENCE_SITES}.</span>` : `${sites} of the ${LICENCE_SITES} websites the free licence covers`;
	return setCard(
		"account",
		"Your ReaderCount",
		"",
		row("Licence", `Free for one person or organisation's own websites, up to ${LICENCE_SITES}. Running it for clients, or for more websites, needs a commercial licence.`, licence, `<a class="btn-out" href="${REPO_URL}/blob/main/LICENSE" target="_blank" rel="noopener">Read the licence</a>`) +
			row("Clients", "Sell stats to your own clients under your brand: their own sign-in, plans you set and payments to your own Stripe account. Needs a commercial licence.", clients ? ON("Switched on") : "Switched off", `<a class="btn-out" href="/clients">Manage clients</a>`) +
			row("Signed in", "You sign in with the ADMIN_PASSWORD secret. Change it in the Cloudflare dashboard to sign out every device.", "Owner", `<form method="post" action="/signout"><button class="btn-out" type="submit">Sign out</button></form>`) +
			panel("", false, "Put it on your phone or computer", "Pins ReaderCount to your home screen or Dock, like an app.", "Install as an app", "Install or view steps", DEVICE, " device") +
			panel(
				"branding",
				url.searchParams.get("branding") !== null,
				"Branding",
				"Your own name, logo, colour and support address on every page and email, instead of ReaderCount's. Using it for clients needs a commercial licence.",
				brand.name === "ReaderCount" && !brand.logo && !brand.colour && !brand.support ? "ReaderCount's own" : ON(`Shown as ${esc(brand.name)}`),
				"Change",
				`${url.searchParams.get("branding") === "saved" ? `<p class="gs-note ck-ok">● Saved. It can take a minute to show everywhere.</p>` : ""}<form method="post" action="/branding" class="brand-form"><label>Name<input name="name" maxlength="40" value="${brand.name === "ReaderCount" ? "" : esc(brand.name)}" placeholder="ReaderCount"></label><label>Logo address (https://, about 28 pixels high)<input name="logo" type="url" value="${esc(brand.logo)}" placeholder="https://example.com/logo.png"></label><label>Colour<input name="colour" type="color" value="${esc(brand.colour || "#2f6fed")}"></label><label>Support email or web address<input name="support" value="${esc(brand.support)}" placeholder="help@example.com"></label><button class="cl-copy" type="submit">Save branding</button></form><p class="gs-note">Leave a box empty to use ReaderCount's own.</p>`,
			) +
			row("Updates and help", "New versions are on GitHub. Questions and bug reports go there too.", `<a href="${HOME_URL}" target="_blank" rel="noopener">${HOME_URL.replace(/^https:\/\//, "")}</a>`, `<a class="btn-out" href="${REPO_URL}/releases" target="_blank" rel="noopener">See releases</a>`),
	);
}

/** A client's own card: their plan, signing out and where to get help. */
function clientCard(account: Account, plan: PlanState, brand: Brand): string {
	const help = brand.support ? supportHref(brand) : "";
	return setCard(
		"account",
		"Your account",
		"",
		row("Plan", `Up to ${plan.sites} website${plan.sites === 1 ? "" : "s"}.`, esc(plan.name), `<a class="btn-out" href="/plans">See plans</a>`) +
			row("Signed in", "You sign in with a link sent to your email address.", esc(account.email), `<form method="post" action="/signout"><button class="btn-out" type="submit">Sign out</button></form>`) +
			panel("", false, "Put it on your phone or computer", "Pins your stats to your home screen or Dock, like an app.", "Install as an app", "Install or view steps", DEVICE, " device") +
			(help ? row("Help", "Questions about your stats or your plan.", `<a href="${esc(help)}">${esc(brand.support)}</a>`, `<a class="btn-out" href="${esc(help)}">Get help</a>`) : ""),
	);
}

function firstSite(env: Env, account: Account, error = ""): Response {
	return renderPage(
		"Register Domain Property",
		`<form method="post" action="/signout" class="who"><span>${esc(account.email)}</span><button type="submit">Sign out</button></form><h1>Add your website property</h1><p>Enter the domain URL you want ReaderCount to measure.</p>${error ? `<p class="err">${esc(error)}</p>` : ""}<form method="post" action="/sites" class="f"><label for="domain">Domain URL</label><input id="domain" type="text" name="domain" placeholder="myblog.com" autocapitalize="off" spellcheck="false" required autofocus><button class="go" type="submit">Register domain</button></form>`,
		error ? 400 : 200,
	);
}

async function home(env: Env, url: URL, account: Account, sites: string[], now: number, plan: PlanState): Promise<Response> {
	if (!sites.length) return firstSite(env, account);
	const seen = await Promise.all(sites.map((s) => lastVisit(env.DB, s, now)));
	const google = googleOn(env) ? await googleState(env.DB, account.id) : undefined;
	const claudeUrl = `https://${env.APP_HOST}/mcp`;
	const claude = await claudeConnected(env.DB, account.id, now);
	const forAccount =
		connectionsCard(env, google ?? null, claude, claudeUrl) +
		emailsCard(env, account.email, await wantsDigest(env.DB, account.id), url, await alertsFor(env.DB, account.id)) +
		(isOwner(account) ? accountCard(sites.length, await loadBrand(env.DB, now), url, await clientsOn(env.DB, now)) : clientCard(account, plan, await loadBrand(env.DB, now)));
	if (sites.length > 1 && !sites.includes(url.searchParams.get("site") ?? "")) {
		// Two or more websites: start on the overview, and drill down from there.
		// The website list (with its Add box) and the account-wide settings live here, not on each website's page.
		const box = settingsHead("Global Account Settings") + forAccount;
		return new Response(renderOverview(await buildOverview(env.DB, sites, now), { email: account.email, sitesHtml: box, addHtml: addSiteRow(), views: plan.views, planName: plan.name }), {
			headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
		});
	}
	const site = sites.includes(url.searchParams.get("site") ?? "") ? url.searchParams.get("site")! : sites[0];
	const asked = url.searchParams.get("range") ?? "";
	const range: Range = Object.hasOwn(RANGES, asked) ? (asked as Range) : "7d";
	const view = readView(url);
	const report = await buildReport(env.DB, site, range, now, false, view.filters);
	let triggers: Trigger[];
	[report.earnings, report.broken, report.behaviour, triggers] = await Promise.all([earningsByPage(env.DB, site, report.from, report.to), brokenLinks(env.DB, site, now), behaviourReport(env.DB, site, report.from, report.to, now), listTriggers(env.DB, site)]);
	// Triggers count as goals, worked out from visits already counted.
	const fromTriggers = await triggerCounts(env.DB, site, report.from, report.to);
	if (fromTriggers.length) report.goals = [...(report.goals ?? []), ...fromTriggers].sort((a, b) => Number(b.visitors) - Number(a.visitors));
	const health = await siteHealth(env.DB, site, { behaviour: report.behaviour, missing: report.missing, broken: report.broken, visitors: report.totals.visitors, previousVisitors: report.previous.visitors, range }, now);
	// Earnings laid over the stats (src/money.ts), and money problems in Site Health.
	[report.money] = await Promise.all([moneyReport(env.DB, site, report.from, report.to, now)]);
	for (const p of await moneyProblems(env.DB, site, now)) health.push({ level: "attention", title: p.title, detail: p.detail, go: { card: "te" } });
	const g: GoogleView | undefined = google ? { state: google, report: google.connected ? await searchReport(env.DB, site, report.from, report.to) : undefined } : undefined;
	const sharing = await env.DB.prepare("SELECT public, public_google FROM sites WHERE domain = ?").bind(site).first<{ public: number; public_google: number }>();
	const thisSite = siteCard(env, { networks: await networksFor(env.DB, site), tagLinks: await taggingOn(env.DB, site), adsense: googleOn(env) ? await adsenseState(env.DB, account.id) : null, triggers, limits: { triggers: plan.triggers, hooks: plan.hooks, networks: plan.networks }, site, code: esc(snippet(env, site)), lastSeen: seen[sites.indexOf(site)], share: { on: Boolean(sharing?.public), google: Boolean(sharing?.public_google) }, history: await historySummary(env.DB, site), earnings: await earningsSummary(env.DB, site), keys: await listKeys(env.DB, account.id, site), ghost: await ghostState(env.DB, site), url }, now);
	// With two or more websites, each website's page only has its own settings; the rest is on the overview.
	const sitesHtml =
		sites.length > 1
			? settingsHead("Property Settings") + thisSite + `<p class="set-elsewhere">Your other websites, connections and account settings are on the <a href="/">Multi-Property Overview</a>.</p>`
			: settingsHead("Property Settings") + websitesCard(sites, seen, site) + thisSite + forAccount;
	const notes = { list: await notesBetween(env.DB, site, report.from, report.to), site, range, today: utcDay(now), editable: true };
	const [posts, titles] = await Promise.all([postsBetween(env.DB, site, report.from, report.to), titlesFor(env.DB, site, report.pages.map((p) => String(p.path ?? "")))]);
	return new Response(renderDashboard(report, sites, { google: g, notes, posts, titles, fixes: await findFixes(env.DB, site, now), health, claudeUrl, account: { email: account.email, sitesHtml, claude }, metric: view.metric }), {
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
	});
}

/** How to add the stats page to a phone or computer as an app. Hidden once it's open as one. */
const DEVICE = `<div class="rc-app"><p data-rc-here>Follow the steps for your device below.</p><button type="button" class="btn-out" data-rc-install data-icon="download" hidden>Install ReaderCount</button></div><p class="device-other">Every device:</p><ul class="device-steps"><li><b>iOS (iPhone/iPad):</b> Open in Safari, tap the Share icon, select <b>Add to Home Screen</b>.</li><li><b>Android:</b> Open in Chrome, tap the menu (⋮), select <b>Add to Home screen</b>.</li><li><b>macOS:</b> Open in Safari, select <b>File › Add to Dock</b>. In Chrome, click the installation icon in the address bar.</li><li><b>Windows:</b> Open in Chrome or Edge, click the installation icon in the address bar.</li></ul>`;

/** The public stats panel: the switch, its link, and a badge to paste into the website's footer., its link, and a badge to paste into the website's footer. */
function shareBox(env: Env, site: string, on: boolean, google: boolean, just: string | null): string {
	const link = `https://${env.APP_HOST}/share/${site}`;
	const badge = `<a href="${link}">See my stats</a> · counted by <a href="${HOME_URL}">ReaderCount</a>`;
	const img = (dark: boolean) => `<a href="${link}"><img src="https://${env.APP_HOST}/badge${dark ? "-dark" : ""}.svg" width="228" height="32" alt="See my stats on ReaderCount"></a>`;
	const row = (label: string, value: string) => `<div class="cl-row"><input class="cl-url" readonly value="${esc(value)}" aria-label="${label}"><button type="button" class="cl-copy" data-copy>Copy</button></div>`;
	const note =
		just === "on"
			? `<p class="gs-note ck-ok">● Your stats are public.</p>`
			: just === "off"
				? `<p class="gs-note">Done, your stats are private again. The old link no longer works.</p>`
				: "";
	const shared = on
		? `<p class="gs-intro">Anyone with this link can see ${esc(site)}'s stats. Your Google searches ${google ? "are" : "aren't"} included, and the What to fix list is never shown.</p><div class="cl-row"><input class="cl-url" readonly value="${esc(link)}" aria-label="Your public stats link"><button type="button" class="cl-copy" data-copy>Copy</button></div><p class="gs-intro" style="margin-top:12px">Add a badge to your website's footer, so readers and sponsors can see your numbers:</p><p class="badges"><img src="/badge.svg" width="228" height="32" alt="Light badge"> <img src="/badge-dark.svg" width="228" height="32" alt="Dark badge"></p><p class="gs-note">For a light website:</p>${row("Light badge code", img(false))}<p class="gs-note">For a dark website:</p>${row("Dark badge code", img(true))}<details class="plain"><summary class="gs-note">Or use a plain text link</summary>${row("Plain link code", badge)}</details><p class="gs-note"><a class="btn-out" href="${esc(link)}" target="_blank">Open your public page</a></p><p class="gs-intro" style="margin-top:16px"><b>Media kit.</b> A one-page PDF of your visitors, countries, devices and most-read pages, with a link to this page, ready to send to sponsors and advertisers. Anyone on your public page can download it too.</p><p class="gs-note"><a class="btn-out" href="/media-kit?site=${encodeURIComponent(site)}" download>Download media kit</a></p>`
		: `<p class="gs-intro">Publish a public analytics page for <code>${esc(site)}</code> to show your traffic numbers to advertisers, sponsors, or readers. Can be disabled at any time.</p>`;
	return `${note}${shared}<form method="post" action="/share" class="updates"><input type="hidden" name="site" value="${esc(site)}"><label><input type="checkbox" name="public"${on ? " checked" : ""} onchange="this.form.submit()"> Enable public metrics page</label>${on ? `<label><input type="checkbox" name="google"${google ? " checked" : ""} onchange="this.form.submit()"> Include my Google searches</label>` : ""}<noscript><button class="cl-copy" type="submit">Save</button></noscript></form>`;
}

function mediaKitResponse(kit: Awaited<ReturnType<typeof mediaKitData>>, now: number, cache: string): Response {
	return new Response(mediaKitPdf(kit), {
		headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${mediaKitName(kit.site, now)}"`, "Cache-Control": cache, "X-Robots-Tag": "noindex" },
	});
}

/** Public stats at /share/<domain> (and its media kit at /share/<domain>/media-kit.pdf), only while the owner has it switched on. */
async function sharedStats(env: Env, url: URL, now: number): Promise<Response> {
	let site = "";
	try {
		site = decodeURIComponent(url.pathname.slice("/share/".length)).replace(/\/$/, "").replace(/\/media-kit\.pdf$/, "").toLowerCase();
	} catch {
		// A broken address is just a site that isn't shared.
	}
	const row = await env.DB.prepare("SELECT account_id, public, public_google, verified_at FROM sites WHERE domain = ?").bind(site).first<{ account_id: string; public: number; public_google: number; verified_at: number | null }>();
	if (!row?.public || !row.verified_at) return renderMessage("Analytics Page Restricted", `The owner of this website has not enabled public metrics access, or has disabled public visibility for this property. <a href="${HOME_URL}">Learn about ReaderCount</a>`, 404, "Public analytics page restricted");
	if (url.pathname.endsWith("/media-kit.pdf")) return mediaKitResponse(await mediaKitData(env.DB, site, now, { live: `https://${env.APP_HOST}/share/${site}`, verified: true }), now, "public, max-age=3600");
	const asked = url.searchParams.get("range") ?? "";
	const view = readView(url);
	const report = await buildReport(env.DB, site, Object.hasOwn(RANGES, asked) ? (asked as Range) : "30d", now, false, view.filters);
	// Anyone can send a click or a goal, so a public page only lists ones several readers sent on the same day.
	const seen = await widelySent(env.DB, site, report.from, report.to);
	report.clicks = report.clicks.filter((c) => seen.has(`${c.kind}|${c.target}`));
	if (report.goals) report.goals = report.goals.filter((goal) => seen.has(`goal|${goal.name}`));
	let g: GoogleView | undefined;
	if (row.public_google && googleOn(env)) {
		const state = await googleState(env.DB, row.account_id);
		if (state.connected) g = { state, report: await searchReport(env.DB, site, report.from, report.to) };
	}
	return new Response(renderDashboard(report, [site], { shared: true, google: g, metric: view.metric }), {
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60", "X-Robots-Tag": "noindex" },
	});
}

/** The API keys panel: each key with when it was last used, a button to delete it, and a box to make another. */
function apiBox(site: string, keys: ApiKey[], just: string | null, now: number): string {
	const note = just === "deleted" ? `<p class="gs-note">Done, that key has been deleted and stops working straight away.</p>` : "";
	const used = (k: ApiKey) => (k.last_used ? `last used ${now - k.last_used < 86_400_000 ? ago(now - k.last_used) : `on ${longDate(utcDay(k.last_used))}`}` : "not used yet");
	const list = keys.length
		? `<ul class="nt-list">${keys
				.map(
					(k) =>
						`<li><span class="nt-text"><b>${esc(k.name)}</b> <code>${esc(k.hint)}…</code><br><span class="gs-note">Made ${longDate(utcDay(k.created_at))}, ${used(k)}</span></span><form method="post" action="/api-keys/delete"><input type="hidden" name="site" value="${esc(site)}"><input type="hidden" name="id" value="${esc(k.id)}"><button class="link-btn" type="submit">Delete</button></form></li>`,
				)
				.join("")}</ul>`
		: "";
	const add =
		keys.length < MAX_KEYS
			? `<form method="post" action="/api-keys" class="cl-row nt-add api-add"><input type="hidden" name="site" value="${esc(site)}"><input name="name" maxlength="60" placeholder="Identifier label, e.g. Admin Dashboard" aria-label="API Key Identifier Label"><button class="cl-copy" type="submit">Generate API key</button></form>`
			: `<p class="gs-note">This website has ${MAX_KEYS} keys, the most it can have. Delete one to make another.</p>`;
	return `${note}<p class="gs-intro">Query metrics for <code>${esc(site)}</code> programmatically via <code>/api/</code> on this address. API tokens grant read-only access strictly to this property. Store tokens securely in server-side environments. <a href="${REPO_URL}#api" target="_blank" rel="noopener">API documentation</a></p>${list}${add}`;
}

function ghostBox(site: string, g: GhostState, just: string | null): string {
	const hidden = `<input type="hidden" name="site" value="${esc(site)}">`;
	const note = just === "on" ? `<p class="gs-note">Done, Ghost is connected. New posts will appear on your chart.</p>` : just === "off" ? `<p class="gs-note">Done, Ghost is disconnected and we've removed our webhook from it. You can delete the ReaderCount integration in Ghost too.</p>` : "";
	if (g.connected) {
		return `${note}<p class="gs-intro">Connected to <code>${esc(g.apiUrl ?? "")}</code>. We read your posts again every night, and Ghost tells us straight away when you publish one.</p><form method="post" action="/ghost/disconnect">${hidden}<button class="btn-out" type="submit">Disconnect Ghost</button></form>`;
	}
	return `${note}<ol class="cl-steps"><li>In Ghost, go to Settings › <b>Integrations</b> › <b>Add custom integration</b> and call it <b>ReaderCount</b>.</li><li>Copy its <b>API URL</b> and <b>Admin API key</b> into the boxes below.</li></ol><form method="post" action="/ghost/connect" class="gh-form">${hidden}<input name="api_url" type="url" placeholder="https://${esc(site)}" required aria-label="Ghost API URL" autocapitalize="off" spellcheck="false"><input name="key" type="password" placeholder="Admin API key" required aria-label="Ghost Admin API key" autocomplete="off"><button class="cl-copy" type="submit">Connect Ghost</button></form><p class="gs-note">Ghost doesn't let integrations add code to your site, so paste the tracking code into Settings › <b>Code injection</b> › Site header yourself.</p>`;
}

/** Shown once, straight after a key is made: we only keep a hash, so this is the only time anyone sees it. */
function newKeyPage(env: Env, site: string, name: string, key: string, back: string): Response {
	const example = `curl -H "Authorization: Bearer ${key}" "https://${env.APP_HOST}/api/v1/overview?period=7d"`;
	return renderPage(
		"Your new API key",
		`<h1>Your new API key</h1><p><b>${esc(name)}</b> can read the stats for <b>${esc(site)}</b>. Copy it now and keep it somewhere safe: you won't be able to see it again.</p><div class="cl-row"><input class="cl-url" readonly value="${esc(key)}" aria-label="Your new API key"><button type="button" class="cl-copy" data-copy>Copy</button></div><p class="hint" style="margin-top:18px">Try it:</p><div class="cl-row"><input class="cl-url" readonly value="${esc(example)}" aria-label="An example request"><button type="button" class="cl-copy" data-copy>Copy</button></div><p class="hint">Keep the key on your server, never in a web page. If you lose it or it gets out, delete it on your stats page and make another. <a href="${REPO_URL}#api" target="_blank" rel="noopener">How to use the API</a></p><p><a href="${esc(back)}#api">Back to your stats</a></p><script>${COPY}</script>`,
		200,
		{ "Referrer-Policy": "no-referrer" },
	);
}

function longDate(day: string): string {
	return day ? new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "";
}

async function alertsFor(db: D1Database, id: string): Promise<{ spikes: boolean; monthly: boolean; downs: boolean }> {
	const r = await db.prepare("SELECT spikes, monthly, downs FROM accounts WHERE id = ?").bind(id).first<{ spikes: number; monthly: number; downs: number }>();
	return { spikes: Boolean(r?.spikes ?? 1), monthly: Boolean(r?.monthly ?? 1), downs: Boolean(r?.downs ?? 1) };
}

/** Triggers (src/triggers.ts): the list, and the form to add one. */
function triggersBox(site: string, list: Trigger[], limits: { triggers: number; hooks: number }, just: string | null): string {
	const note = just === "added" ? `<p class="gs-note ck-ok">● Trigger added. It shows under Goals and Sign-Ups, including visits before today.</p>` : just === "removed" ? `<p class="gs-note">Done, that trigger has been removed.</p>` : "";
	const hidden = `<input type="hidden" name="site" value="${esc(site)}">`;
	const what = (t: Trigger) => `${KINDS[t.kind]}: ${t.kind === "form" && t.pattern === "*" ? "any form" : t.pattern}`;
	const how = (t: Trigger) => [t.notify === "none" ? "" : NOTIFY[t.notify], t.webhook ? `Webhook to ${new URL(t.webhook).hostname}` : ""].filter(Boolean).join(" · ") || "Counted as a goal";
	const items = list.map((t) => `<li class="tr-item"><span><b>${esc(t.name)}</b><small>${esc(what(t))} · ${esc(how(t))}</small></span><form method="post" action="/triggers/remove">${hidden}<input type="hidden" name="id" value="${t.id}"><button class="btn-out" type="submit" data-icon="trash">Remove</button></form></li>`).join("");
	const hooks = list.filter((t) => t.webhook).length;
	const full = list.length >= limits.triggers;
	const add = full
		? `<p class="gs-note">You've used all ${limits.triggers} triggers for this website. Remove one to add another.</p>`
		: `<form method="post" action="/triggers" class="tr-form">${hidden}
<label>Name<input name="name" maxlength="60" placeholder="Order placed" required></label>
<label>When<select name="kind" required>${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
<label>Page, link or form<input name="pattern" maxlength="200" placeholder="/thank-you" required autocapitalize="off" spellcheck="false"></label>
<label>Tell me<select name="notify">${Object.entries(NOTIFY).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
<label class="tr-wide">Webhook (optional)<input name="webhook" type="url" maxlength="500" placeholder="https://hooks.slack.com/services/..." autocapitalize="off" spellcheck="false"${hooks >= limits.hooks ? ` disabled title="You've used all ${limits.hooks} webhooks for this website"` : ""}></label>
<button class="cl-copy" type="submit" data-icon="add">Add trigger</button></form>`;
	return `${note}<p class="gs-intro"><b>Page visited</b>: type the address, such as <code>/thank-you</code>, or <code>/order/*</code> for every page under /order/. <b>Link clicked</b>: type part of the link, such as <code>amazon.</code> or <code>.pdf</code>. <b>Form sent</b>: type the form's name (as it shows under Goals), or <code>*</code> for any form.</p>${items ? `<ul class="tr-list">${items}</ul>` : ""}${add}<p class="gs-note">Emails and webhook messages say the trigger, the page, where the reader came from and their country. Never anything about who they are. Up to ${limits.triggers} triggers a website, ${limits.hooks} with a webhook.</p>`;
}

/** Google AdSense (src/adsense.ts): one link for the whole account, shown on each website's Earnings panel. */
function adsenseBox(a: AdsenseState | null, just: string | null, now: number): string {
	if (!a) return "";
	const note = just === "adsense" ? `<p class="gs-note ck-ok">● AdSense connected. We've brought in the last 30 days and will check every night.</p>` : just === "adsense-off" ? `<p class="gs-note">Done, AdSense is disconnected and its figures removed.</p>` : "";
	const body = a.connected
		? `<ul class="tr-list"><li class="tr-item"><span><b>Google AdSense</b><small>${a.account ? `${esc(a.account.replace(/^accounts\//, ""))} · ` : ""}${a.error ? `<span class="gs-err">${esc(a.error)}</span>` : a.syncedAt ? `Last read ${ago(now - a.syncedAt)}` : "Not read yet"}</small></span>${a.error ? `<a class="btn-out" href="/google/adsense">Connect again</a>` : ""}<form method="post" action="/google/adsense/disconnect"><button class="btn-out" type="submit">Disconnect</button></form></li></ul>`
		: `<p><a class="cl-copy" href="/google/adsense">Connect AdSense</a></p>`;
	return `${note}<h3 class="aff-h">Google AdSense</h3><p class="gs-intro">Sign in with Google once and we bring in your ad earnings every night, for all your websites. We can only view your AdSense reports, never change anything. Ad money is shared across each website's pages by their views; set up a URL channel for a post in AdSense to make that post's figure exact.</p>${body}`;
}

/** Affiliate networks with a reporting API (src/affiliates.ts): connected ones, the form to connect another, and the link tagging switch. */
function networksBox(site: string, list: NetworkState[], tagOn: boolean, limit: number, just: string | null, now: number): string {
	const note =
		just === "connected"
			? `<p class="gs-note ck-ok">● Connected. We've brought in the last 30 days, and we'll check for new sales every night. See them under Top pages › Earnings and in Earnings Insights.</p>`
			: just === "disconnected"
				? `<p class="gs-note">Done, that network is disconnected and its figures removed.</p>`
				: just === "tagging-on"
					? `<p class="gs-note ck-ok">● Links will be tagged with their post again, within the hour.</p>`
					: just === "tagging-off"
						? `<p class="gs-note">Done. We'll stop tagging links within the hour. Tags you add yourself still count.</p>`
						: "";
	const hidden = `<input type="hidden" name="site" value="${esc(site)}">`;
	const items = list
		.map((n) => `<li class="tr-item"><span><b>${NETWORKS[n.network].name}</b><small>${esc(NETWORKS[n.network].id)} ${esc(n.account)} · ${n.error ? `<span class="gs-err">${esc(n.error)}</span>` : n.syncedAt ? `Last read ${ago(now - n.syncedAt)}` : "Not read yet"}</small></span><form method="post" action="/affiliates/remove">${hidden}<input type="hidden" name="network" value="${n.network}"><button class="btn-out" type="submit">Disconnect</button></form></li>`)
		.join("");
	const where = Object.values(NETWORKS).map((n) => `<li><b>${n.name}:</b> ${esc(n.where)}</li>`).join("");
	// The labels change with the network chosen (a few lines of script); without script every box shows, each saying what it's for.
	const labels = Object.fromEntries(Object.entries(NETWORKS).map(([k, n]) => [k, [n.id, n.token, needsSecret(k as keyof typeof NETWORKS) ?? ""]]));
	const add =
		list.length >= limit
			? `<p class="gs-note">You've connected ${limit} networks for this website. Disconnect one to connect another.</p>`
			: `<form method="post" action="/affiliates" class="tr-form aff-form">${hidden}<label>Network<select name="network" required>${Object.entries(NETWORKS).map(([k, n]) => `<option value="${k}">${n.name}</option>`).join("")}</select></label><label><span class="aff-l1">Publisher or account ID</span><input name="account" maxlength="100" required autocapitalize="off" spellcheck="false"></label><label class="tr-wide"><span class="aff-l2">API token or report link</span><input name="token" type="password" maxlength="1000" required autocomplete="off"></label><label class="tr-wide aff-s"><span class="aff-l3">Second key (Partnerize and Skimlinks only)</span><input name="secret" type="password" maxlength="500" autocomplete="off"></label><button class="cl-copy" type="submit">Connect network</button></form><script>(function(){var f=document.currentScript.previousElementSibling,L=${JSON.stringify(labels).replace(/</g, "\\u003c")};function set(){var x=L[f.network.value];f.querySelector(".aff-l1").textContent=x[0];f.querySelector(".aff-l2").textContent=x[1];f.querySelector(".aff-l3").textContent=x[2];f.querySelector(".aff-s").hidden=!x[2];f.secret.required=!!x[2]}f.network.addEventListener("change",set);set()})();</script>`;
	const tag = `<form method="post" action="/affiliates/tagging" class="gs-off aff-tag">${hidden}<input type="hidden" name="on" value="${tagOn ? "0" : "1"}"><p class="gs-note"><b>Tag links with their post: ${tagOn ? "on" : "off"}.</b> ${tagOn ? "When a reader clicks a link to Awin, CJ, Impact, Rakuten, Partnerize, Skimlinks or Sovrn, we add the post's address as the network's sub-ID, so each sale is matched to the post exactly. Only the page's address is added, never anything about the reader. Links that already have one are left alone." : "Sales are shared across your posts by their clicks, unless you add the post's address to your links yourself."}</p><button class="btn-out" type="submit">${tagOn ? "Turn off" : "Turn on"}</button></form>`;
	return `${note}<h3 class="aff-h">Connect a network</h3><p class="gs-intro">Paste your network's API details once and we bring in your commissions every night. When the network says which page a sale came from, that post gets it exactly. Your details are kept encrypted, and we only use them to read your reports.</p>${items ? `<ul class="tr-list">${items}</ul>` : ""}${add}<details class="set-manual"><summary>Where to find your details</summary><ul class="cl-steps">${where}</ul></details>${list.length ? tag : ""}<p class="gs-note">Don't upload a report from a network you've connected, or its sales count twice. Amazon has no earnings API: for Amazon, upload your report below, and use a different tracking ID for each post if you want exact figures.</p><h3 class="aff-h">Or upload a report</h3>`;
}

/** Earnings per post: upload an affiliate report (src/earnings.ts). */
function earningsBox(site: string, e: Awaited<ReturnType<typeof earningsSummary>>, just: string | null): string {
	const note =
		just === "removed"
			? `<p class="gs-note">Done, your earnings have been removed.</p>`
			: just && /^\d+$/.test(just)
				? `<p class="gs-note ck-ok">● Brought in your earnings. See them under Top pages › Earnings.</p>`
				: "";
	const have = e
		? `<p class="gs-intro">You've imported earnings from ${longDate(e.first)} to ${longDate(e.last)}, from ${e.shops} shop${e.shops === 1 ? "" : "s"}.</p><form method="post" action="/earnings/remove" class="gs-off"><input type="hidden" name="site" value="${esc(site)}"><button type="submit">Remove earnings</button></form>`
		: `<p class="gs-intro">Most reports say what you earned each day, not which post earned it, so ReaderCount shares each day's earnings across your posts by how many clicks each one sent to that shop.</p>`;
	return `${note}${have}<ol class="cl-steps"><li>In Amazon Associates, Awin or your network, open the earnings or commission report.</li><li>Choose a date range and download it as <b>CSV</b>.</li><li>Upload it here. If the file doesn't name the shop (Amazon's own reports don't), type the shop's name in the box.</li></ol><p class="gs-note">Uploaded earnings are estimates. Uploading again updates the same days.</p><form method="post" action="/earnings" enctype="multipart/form-data" class="cl-row hist-up"><input type="hidden" name="site" value="${esc(site)}"><input type="file" name="file" accept=".csv,.tsv,.txt,text/csv" required aria-label="Affiliate earnings report"><input class="cl-shop" type="text" name="shop" placeholder="Shop (if the file doesn't say)" aria-label="Shop name"><button class="cl-copy" type="submit">Import earnings</button></form>`;
}

/** "Bring in your older stats": upload a Google Analytics CSV so the chart doesn't start from zero. */
function historyBox(site: string, h: Awaited<ReturnType<typeof historySummary>>, just: string | null): string {
	const note =
		just === "removed"
			? `<p class="gs-note">Done, your older stats have been removed.</p>`
			: just && /^\d+$/.test(just)
				? `<p class="gs-note ck-ok">● Brought in ${Number(just).toLocaleString("en-GB")} days. They show as lighter bars on the chart.</p>`
				: "";
	const used = h.firstCounted ? `ReaderCount utilises historical benchmarks up to your active tracking start date (${longDate(h.firstCounted)}) to prevent duplicate counting.` : "ReaderCount utilises historical benchmarks up to your active tracking start date to prevent duplicate counting.";
	const have = h.days
		? `<p class="gs-intro">You've imported <b>${h.days.toLocaleString("en-GB")} days</b>, from ${longDate(h.from)} to ${longDate(h.to)}. ${used}</p><form method="post" action="/history/remove" class="gs-off"><input type="hidden" name="site" value="${esc(site)}"><button type="submit">Remove older stats</button></form>`
		: `<p class="gs-intro">Import historical daily visitor and page view totals from Google Analytics to populate timeline charts. ${used}</p>`;
	return `${note}${have}<ol class="cl-steps"><li>In Google Analytics (GA4), navigate to <b>Explore</b> and create a <b>Blank</b> exploration.</li><li>Under Dimensions, add <b>Date</b>. Under Metrics, add <b>Total users</b> and <b>Views</b>. Drag <b>Date</b> to Rows, and both metrics to Values.</li><li>Select your desired historical date range and export the dataset as <b>CSV</b>.</li></ol><p class="gs-note">CSV exports containing a date column and a users/visitors column are supported (including exports from Plausible, Fathom, or Matomo). Re-uploading updates overlapping date ranges.</p><form method="post" action="/history" enctype="multipart/form-data" class="cl-row hist-up"><input type="hidden" name="site" value="${esc(site)}"><input type="file" name="file" accept=".csv,.tsv,.txt,text/csv" required aria-label="Historical CSV metrics file"><button class="cl-copy" type="submit">Import CSV dataset</button></form>`;
}

// ---- Google Search Console (shared by the private-link stats page and accounts) ----

const STATE = "rc_google";

function sameText(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** /google/connect, /google/callback and /google/disconnect for one owner, who has already been checked. */
export async function googleRoutes(request: Request, env: Env, url: URL, owner: Owner, sites: string[], ctx: ExecutionContext | undefined, now: number): Promise<Response> {
	const home = (q = "") => see("/" + q);
	if (url.pathname === "/google/adsense" && request.method === "GET") {
		// Same Google app and return address as Search Console; the "ads." on the state tells the callback which.
		const state = "ads." + crypto.randomUUID();
		return see(adsenseConnectUrl(env, url.origin, state), { "Set-Cookie": `${STATE}=${state}; Path=/google/; Max-Age=600; HttpOnly; Secure; SameSite=Lax` });
	}
	if (url.pathname === "/google/adsense/disconnect" && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		await disconnectAdsense(env, owner, sites);
		return home("?earnings=adsense-off#earnings");
	}
	if (url.pathname === "/google/connect" && request.method === "GET") {
		const state = crypto.randomUUID();
		return see(connectUrl(env, url.origin, state), { "Set-Cookie": `${STATE}=${state}; Path=/google/; Max-Age=600; HttpOnly; Secure; SameSite=Lax` });
	}
	if (url.pathname === "/google/callback" && request.method === "GET") {
		const state = readCookie(request, STATE);
		if (!state || !sameText(state, url.searchParams.get("state") ?? "")) return renderMessage("That didn't work", "The Google sign-in took too long or was opened in another browser. <a href=\"/google/connect\">Try again</a>.", 400);
		const code = url.searchParams.get("code");
		if (!code) return home(); // they said no on Google's page
		if (state.startsWith("ads.")) {
			const trouble = await finishAdsense(env, owner, url.origin, code, sites, now);
			if (trouble) return renderMessage("AdSense didn't connect", `Google said: ${trouble.replace(/[<>&]/g, "")}. <a href="/google/adsense">Try again</a>.`, 400);
			return home("?range=30d&earnings=adsense#earnings");
		}
		const problem = await finishConnect(env, owner, url.origin, code, now);
		if (problem) return renderMessage("Google didn't connect", `Google said: ${problem.replace(/[<>&]/g, "")}. <a href="/google/connect">Try again</a>.`, 400);
		// Bring in the last 90 days in the background; the nightly run keeps it up to date from then on.
		const first = syncSearch(env, owner, sites, now, 90);
		if (ctx) ctx.waitUntil(first);
		else await first;
		return home("?google=connected");
	}
	if (url.pathname === "/google/disconnect" && request.method === "POST") {
		if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
		await disconnect(env, owner, sites);
		return home();
	}
	return new Response("Not found", { status: 404 });
}
