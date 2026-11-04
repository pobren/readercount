// ReaderCount Worker: serves the tracker script (/s.js), records what it sends (/e), and the stats pages.
// Runs on your own Cloudflare account; see README.md.

import { accountSites, countedSites, type Mailer } from "./accounts.ts";
import { handleApi } from "./api.ts";
import { appFetch } from "./app.ts";
import { belongsTo, parseHit } from "./collect.ts";
import { recordReports } from "./behaviour.ts";
import { checkSitesUp, UPTIME_CRON } from "./health.ts";
import { fireTriggers, sendTriggerRoundups, triggersFor } from "./triggers.ts";
import { syncAffiliates } from "./affiliates.ts";
import { moneyAlerts } from "./money.ts";
import { syncAdsense } from "./adsense.ts";
import { syncGhost } from "./ghost.ts";
import { syncSearch } from "./google.ts";
import { ICON_FILES } from "./icons.ts";
import { BADGES } from "./badges.ts";
import { brandMailer, loadBrand } from "./brand.ts";
import { DIGEST_CRON, sendDigests } from "./digest.ts";
import { HOURLY_CRON, MONTHLY_CRON, sendMonthlyReviews, sendSpikeAlerts } from "./alerts.ts";
import { checkLinks } from "./links.ts";
import { countFiltered, fromCloud, underSiteCap, VISITOR_DAILY_CAP } from "./filter.ts";
import { clientIp, originHost, overLimit, type Limiter } from "./guard.ts";
import { MANIFEST, SERVICE_WORKER } from "./pwa.ts";
import { TAGGER, TRACKER } from "./tracker.ts";
import { forgetOldSalts, saltFor, utcDay, visitorId } from "./visitor.ts";

export interface Env {
	DB: D1Database;
	/** The owner's password for the stats pages (a secret: `wrangler secret put ADMIN_PASSWORD`). */
	ADMIN_PASSWORD?: string;
	/** Where alert and report emails go. Optional: emails are off without it and the EMAIL binding. */
	OWNER_EMAIL?: string;
	/** Delete events older than this many days. "0" or empty keeps everything. */
	RETENTION_DAYS?: string;
	/** The address the stats pages answer on, such as stats.example.com. Optional: taken from the request, and remembered for scheduled emails. */
	APP_HOST?: string;
	/** Optional Google Search Console and AdSense link: your own Google Cloud OAuth client (see src/google.ts). */
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	/** Encrypts saved tokens (Google, Ghost, affiliate networks). Optional: made from ADMIN_PASSWORD until it's set. */
	GOOGLE_TOKEN_KEY?: string;
	/** Email binding for alerts and reports, and the address they come from. */
	EMAIL?: Mailer;
	MAIL_FROM?: string;
	/** Per-IP limits (Workers Rate Limiting bindings in wrangler.jsonc): hits sent to /e, and the sign-in form. */
	COLLECT_LIMIT?: Limiter;
	FORM_LIMIT?: Limiter;
	/** Client mode only: your own Stripe account's secret key and webhook signing secret, so clients can pay you. */
	STRIPE_SECRET_KEY?: string;
	STRIPE_WEBHOOK_SECRET?: string;
}

// Websites that get the affiliate link tagger (src/tracker.ts TAGGER) added to their script: those with a network
// connected and tagging left on. Remembered for 10 minutes, so most script loads cost no database read.
const tagging = new Map<string, { on: boolean; at: number }>();
async function tagsLinks(db: D1Database, request: Request, now: number): Promise<boolean> {
	let host = "";
	try {
		host = new URL(request.headers.get("Referer") || request.headers.get("Origin") || "").hostname.replace(/^www\./, "");
	} catch {
		return false;
	}
	const known = tagging.get(host);
	if (known && now - known.at < 600_000) return known.on;
	const row = await db
		.prepare("SELECT 1 AS on_ FROM affiliate_links a LEFT JOIN sites s ON s.domain = a.site WHERE a.site IN (?, ?) AND COALESCE(s.tag_links, 1) = 1 LIMIT 1")
		.bind(host, `www.${host}`)
		.first<{ on_: number }>()
		.catch(() => null);
	if (tagging.size > 5000) tagging.clear();
	tagging.set(host, { on: Boolean(row), at: now });
	return Boolean(row);
}

/** A shop's or website's logo for the stats page. We fetch it, so the person viewing never contacts an outside icon service, and keep it for 30 days. No logo answers 404 and the page shows the letter instead. */
export async function logo(host: string, ctx?: ExecutionContext, get: typeof fetch = fetch): Promise<Response> {
	if (host.length > 100 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return new Response("Not found", { status: 404 });
	const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
	const key = new Request(`https://logo.readercount.invalid/${host}`);
	const hit = await cache?.match(key);
	if (hit) return hit;
	const res = await get(`https://www.google.com/s2/favicons?domain=${host}&sz=64`).catch(() => null);
	const type = res?.headers.get("Content-Type") ?? "";
	const ok = Boolean(res?.ok && type.startsWith("image/"));
	const out = new Response(ok ? await res!.arrayBuffer() : "Not found", { status: ok ? 200 : 404, headers: { "Content-Type": ok ? type : "text/plain", "Cache-Control": `public, max-age=${ok ? 2_592_000 : 86_400}` } });
	if (cache) {
		const put = cache.put(key, out.clone());
		if (ctx) ctx.waitUntil(put);
		else await put;
	}
	return out;
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };

export default {
	async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/s.js" && (request.method === "GET" || request.method === "HEAD")) {
			return new Response((await tagsLinks(env.DB, request, Date.now())) ? TRACKER + "\n" + TAGGER : TRACKER, {
				headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600", ...CORS },
			});
		}
		if (url.pathname === "/e") {
			if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
			if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });
			// One address sending more than a real reader ever could is dropped quietly.
			if (!(await overLimit(env.COLLECT_LIMIT, clientIp(request)))) await record(request, env, Date.now(), ctx);
			// Always 202, so a bad or ignored hit tells the sender nothing.
			return new Response(null, { status: 202, headers: CORS });
		}
		if (url.pathname.startsWith("/logo/") && request.method === "GET") return logo(url.pathname.slice(6), ctx);
		// Every page serves the ReaderCount icons and badges itself.
		if (Object.hasOwn(ICONS, url.pathname) && (request.method === "GET" || request.method === "HEAD")) return icon(url.pathname);
		if (Object.hasOwn(BADGES, url.pathname)) return new Response(BADGES[url.pathname], { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400", ...CORS } });
		// The stats page as an app on a home screen or Dock (src/pwa.ts).
		if (url.pathname === "/manifest.webmanifest") return new Response(MANIFEST, { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" } });
		if (url.pathname === "/sw.js") return new Response(SERVICE_WORKER, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
		// Private stats: no search engine needs any of it.
		if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
		const here = withHost(env, url);
		here.EMAIL = brandMailer(env.EMAIL, await loadBrand(env.DB));
		if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
			const api = new URL(url);
			api.pathname = url.pathname.slice(4) || "/";
			return handleApi(request, here, api, Date.now());
		}
		return appFetch(request, here, url, ctx, Date.now());
	},

	async scheduled(controller: ScheduledController, env: Env): Promise<void> {
		env = await storedHost(env);
		env = { ...env, EMAIL: brandMailer(env.EMAIL, await loadBrand(env.DB)) };
		if (controller.cron === DIGEST_CRON) {
			await sendDigests(env, Date.now());
			return;
		}
		if (controller.cron === HOURLY_CRON) {
			await sendSpikeAlerts(env, Date.now());
			await checkLinks(env, Date.now());
			return;
		}
		if (controller.cron === UPTIME_CRON) {
			await checkSitesUp(env, Date.now());
			return;
		}
		if (controller.cron === MONTHLY_CRON) {
			await sendMonthlyReviews(env, Date.now());
			return;
		}
		await tidy(env, Date.now());
		const linked = await env.DB.prepare("SELECT owner FROM google_links").all<{ owner: string }>();
		for (const { owner } of linked.results ?? []) await syncSearch(env, owner, await accountSites(env.DB, owner), Date.now());
		await syncGhost(env, Date.now());
		await sendTriggerRoundups(env, Date.now());
		await syncAffiliates(env, Date.now());
		const ads = (await env.DB.prepare("SELECT owner FROM adsense_links").all<{ owner: string }>().catch(() => ({ results: [] as { owner: string }[] }))).results ?? [];
		for (const { owner } of ads) await syncAdsense(env, owner, await accountSites(env.DB, owner), Date.now());
		await moneyAlerts(env, Date.now());
	},
};

// Every host serves the icons itself, so a phone adding the stats to its home screen finds them at the same address.
// Pages link them with ?v=N: iPhones keep an icon (or a failed fetch) per address, so a new N makes them fetch again.
const ICONS: Record<string, { type: string; base64: string }> = { ...ICON_FILES, "/apple-touch-icon-precomposed.png": ICON_FILES["/apple-touch-icon.png"] };

function icon(path: string): Response {
	const { type, base64 } = ICONS[path];
	return new Response(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)), { headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400" } });
}

export async function record(request: Request, env: Env, now: number, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<string> {
	const text = await request.text();
	if (text.length > 4096) return "too big";
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return "not json";
	}
	const ua = request.headers.get("User-Agent") ?? "";
	const day = utcDay(now);
	const hit = parseHit(body, ua, await countedSites(env.DB, now));
	if ("ignored" in hit) {
		// The owner's code on another website: kept as a count so the setup check can say where it is.
		if (hit.site && hit.host) await countFiltered(env.DB, hit.site, day, "wrong site", hit.host);
		return hit.ignored;
	}
	// A browser always says which website sent the hit, so another website can't count visits for this one,
	// and a hit with no Origin at all didn't come from a web page. "null" (pages that hide where they are) is let through.
	const from = originHost(request);
	if (from === null || (from && !belongsTo(from, hit.site))) {
		if (hit.kind !== "leave" && hit.kind !== "back") await countFiltered(env.DB, hit.site, day, "wrong origin");
		return "wrong origin";
	}
	const cf = (request as { cf?: { country?: string; asn?: number } }).cf;
	const fake = from === undefined ? "no origin" : fromCloud(cf?.asn) ? "cloud" : null;
	if (fake) {
		if (hit.kind !== "leave" && hit.kind !== "back") await countFiltered(env.DB, hit.site, day, fake);
		return fake;
	}

	if (hit.kind === "leave") {
		// left_at drops the reader from the live view straight away. Scroll depth and page speed only ever go up
		// (a leave can arrive more than once for one page view, each time with the latest figures).
		await env.DB.prepare(
			`UPDATE events SET duration = MAX(COALESCE(duration, 0), ?1), left_at = ?2, scroll = CASE WHEN ?3 IS NULL THEN scroll ELSE MAX(COALESCE(scroll, 0), ?3) END,
			 lcp = COALESCE(?4, lcp), inp = CASE WHEN ?5 IS NULL THEN inp ELSE MAX(COALESCE(inp, 0), ?5) END, cls = CASE WHEN ?6 IS NULL THEN cls ELSE MAX(COALESCE(cls, 0), ?6) END
			 WHERE view_id = ?7 AND site = ?8 AND kind = 'view'`,
		)
			.bind(hit.seconds, now, hit.scroll ?? null, hit.lcp ?? null, hit.inp ?? null, hit.cls ?? null, hit.viewId, hit.site)
			.run();
		if (hit.problems || hit.forms) await recordReports(env.DB, hit.site, hit.viewId, hit.problems ?? [], hit.forms ?? [], now);
		return "leave";
	}
	if (hit.kind === "back") {
		await env.DB.prepare("UPDATE events SET left_at = 0 WHERE view_id = ? AND site = ? AND kind = 'view'").bind(hit.viewId, hit.site).run();
		return "back";
	}

	// A click only counts on a page view that was counted (so nobody can plant links in Link clicks).
	if (hit.kind !== "view") {
		const view = hit.viewId
			? await env.DB.prepare("SELECT 1 AS ok FROM events WHERE view_id = ? AND site = ? AND kind = 'view' AND ts > ?").bind(hit.viewId, hit.site, now - 86_400_000).first()
			: null;
		if (!view) {
			await countFiltered(env.DB, hit.site, day, "no view");
			return "no view";
		}
	}

	const ip = request.headers.get("CF-Connecting-IP") ?? "";
	const visitor = await visitorId(await saltFor(env.DB, day), hit.site, ip, ua);
	const today = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE site = ? AND day = ? AND visitor = ?").bind(hit.site, day, visitor).first<{ n: number }>();
	if ((today?.n ?? 0) >= VISITOR_DAILY_CAP) {
		await countFiltered(env.DB, hit.site, day, "too many");
		return "too many";
	}
	if (!(await underSiteCap(env.DB, hit.site, day))) {
		await countFiltered(env.DB, hit.site, day, "site cap");
		return "site cap";
	}
	const country = cf?.country ?? "";
	await env.DB.prepare(
		`INSERT INTO events (site, ts, day, kind, visitor, view_id, path, target, referrer, source, utm_medium, utm_campaign, country, device, browser, os, missing)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(hit.site, now, day, hit.kind, visitor, hit.viewId, hit.path, hit.target, hit.referrer, hit.source, hit.utmMedium, hit.utmCampaign, country, hit.device, hit.browser, hit.os, hit.missing ? 1 : null)
		.run();
	// Triggers set up in Settings: emails and webhooks go out after the reply, so the reader's browser never waits.
	if ((await triggersFor(env.DB, hit.site, now)).length) {
		let source = hit.source;
		if (hit.kind !== "view" && hit.viewId) source = (await env.DB.prepare("SELECT source FROM events WHERE view_id = ? AND site = ? AND kind = 'view'").bind(hit.viewId, hit.site).first<{ source: string }>())?.source ?? source;
		const fired = fireTriggers(env, hit.site, { kind: hit.kind, path: hit.path, target: hit.target, source, country }, now).catch(() => 0);
		if (ctx) ctx.waitUntil(fired);
		else await fired;
	}
	return hit.kind;
}

/** Nightly: forget old salts, and old events when a retention period is set. */
export async function tidy(env: Env, now: number): Promise<void> {
	await forgetOldSalts(env.DB, utcDay(now));
	const days = Number(env.RETENTION_DAYS ?? 0);
	if (days > 0) await env.DB.prepare("DELETE FROM events WHERE day < ?").bind(utcDay(now - days * 86_400_000)).run();
	// The per-website daily cap only needs today's count (and yesterday's, for hits arriving around midnight).
	await env.DB.prepare("DELETE FROM site_hits WHERE day < ?").bind(utcDay(now - 86_400_000)).run();
	for (const table of ["sessions", "oauth_codes", "oauth_tokens"]) await env.DB.prepare(`DELETE FROM ${table} WHERE expires < ?`).bind(now).run();
	await env.DB.prepare("DELETE FROM sign_in_fails WHERE at < ?").bind(now - 86_400_000).run();
}

/** Requests carry their own address; scheduled emails use the one remembered when the owner last signed in. */
function withHost(env: Env, url: URL): Env {
	return { ...env, APP_HOST: env.APP_HOST || url.host };
}

async function storedHost(env: Env): Promise<Env> {
	if (env.APP_HOST) return env;
	const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'app_host'").first<{ value: string }>().catch(() => null);
	return row?.value ? { ...env, APP_HOST: row.value } : env;
}
