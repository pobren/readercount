// ReaderCount's API: read one website's stats from your own code, at https://YOUR-STATS-ADDRESS/api/.
// The owner makes a key on their stats page (each key reads one website, and can't change anything),
// then sends it in a header:
//
//   curl -H "Authorization: Bearer rc_..." "https://YOUR-STATS-ADDRESS/api/v1/overview?period=7d"
//
//   GET /v1/overview          headline stats, top pages, sources, clicks...    (period)
//   GET /v1/breakdown         views or clicks grouped by one thing             (by, of, period or from/to, filters)
//   GET /v1/google-searches   Google Search Console figures, when connected    (by, period or from/to, filters)
//   GET /v1/check             whether the website's visits are arriving, as the stats page's setup check
//
// The answers are the same as the Claude connector's tools (src/mcp.ts). There are no CORS headers on purpose:
// a key belongs on a server, not in a web page where anyone could copy it. Docs: the README, under API

import { checkSite } from "./app.ts";
import { randomToken, sha256 } from "./accounts.ts";
import type { Env } from "./index.ts";
import { breakdown, googleSearches, overview } from "./mcp.ts";

/** Requests a minute for each key. */
export const API_LIMIT = 60;
/** Keys each website can have. */
export const MAX_KEYS = 10;

const DOCS = "https://github.com/pobren/readercount#api";

export type ApiKey = { id: string; name: string; hint: string; created_at: number; last_used: number | null };

/** Makes a key for one of the account's websites. The key itself is only ever returned here. */
export async function makeKey(db: D1Database, accountId: string, site: string, nameIn: unknown, now: number): Promise<{ key: string; name: string } | { error: string }> {
	const name = String(nameIn ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "API key";
	const count = await db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE account_id = ? AND site = ?").bind(accountId, site).first<{ n: number }>();
	if ((count?.n ?? 0) >= MAX_KEYS) return { error: `A website can have up to ${MAX_KEYS} keys. Delete one you no longer use first.` };
	const key = "rc_" + randomToken(24);
	await db
		.prepare("INSERT INTO api_keys (id, account_id, site, name, key_hash, hint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.bind(crypto.randomUUID(), accountId, site, name, await sha256(key), key.slice(0, 8), now)
		.run();
	return { key, name };
}

export async function listKeys(db: D1Database, accountId: string, site: string): Promise<ApiKey[]> {
	const rows = await db.prepare("SELECT id, name, hint, created_at, last_used FROM api_keys WHERE account_id = ? AND site = ? ORDER BY created_at").bind(accountId, site).all<ApiKey>();
	return rows.results ?? [];
}

/** Deletes a key straight away. Only the account that made it can. */
export async function deleteKey(db: D1Database, accountId: string, id: unknown): Promise<void> {
	await db.prepare("DELETE FROM api_keys WHERE id = ? AND account_id = ?").bind(String(id ?? ""), accountId).run();
}

function answer(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body, null, status === 200 ? undefined : 2), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...headers },
	});
}

const problem = (status: number, error: string, headers: Record<string, string> = {}) => answer({ error, docs: DOCS }, status, headers);

function keyFrom(request: Request): string {
	const auth = request.headers.get("Authorization") ?? "";
	const bearer = /^Bearer\s+(\S+)$/i.exec(auth.trim());
	return (bearer?.[1] ?? request.headers.get("X-API-Key") ?? "").trim();
}

const ROUTES: Record<string, (args: Record<string, unknown>, db: D1Database, sites: string[], now: number, owner: string, env: Env) => Promise<Record<string, unknown>>> = {
	"/v1/overview": (args, db, sites, now) => overview(args, db, sites, now),
	"/v1/breakdown": (args, db, sites, now) => breakdown(args, db, sites, now),
	"/v1/google-searches": (args, db, sites, now, owner) => googleSearches(args, db, sites, now, owner),
	// For the WordPress plugin's "Check now" button.
	"/v1/check": async (_args, _db, sites, now, _owner, env) => ({ site: sites[0], ...(await checkSite(env, sites[0], now)) }),
};

/** Everything under /api/ (the caller takes /api off the front of the path). */
export async function handleApi(request: Request, env: Env, url: URL, now: number): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") return problem(405, "The API only reads stats, so every request is a GET.", { Allow: "GET" });
	const path = url.pathname.replace(/\/+$/, "") || "/";
	if (path === "/") return answer({ name: "ReaderCount API", docs: DOCS, endpoints: Object.keys(ROUTES) });
	const route = ROUTES[path];
	if (!route) return problem(404, `There's nothing at ${path}. Try ${Object.keys(ROUTES).join(", ")}.`);
	if (url.searchParams.has("key") || url.searchParams.has("api_key")) {
		return problem(400, "Send your key in the Authorization header (Authorization: Bearer rc_...), not in the address, where it ends up in logs and browser history.");
	}

	const key = keyFrom(request);
	if (!key) return problem(401, "Add your API key: Authorization: Bearer rc_... Make one on your ReaderCount stats page, under API keys.", { "WWW-Authenticate": "Bearer" });
	// The website must still be on the account that made the key: removing a website stops its keys too.
	const found = await env.DB
		.prepare("SELECT k.id, k.account_id, k.site FROM api_keys k JOIN sites s ON s.domain = k.site AND s.account_id = k.account_id WHERE k.key_hash = ?")
		.bind(await sha256(key))
		.first<{ id: string; account_id: string; site: string }>();
	if (!found) return problem(401, "That API key isn't right, or it has been deleted.", { "WWW-Authenticate": 'Bearer error="invalid_token"' });

	const minute = Math.floor(now / 60_000) * 60_000;
	const used = await env.DB
		.prepare("UPDATE api_keys SET window_count = CASE WHEN window_start = ? THEN window_count + 1 ELSE 1 END, window_start = ?, last_used = ? WHERE id = ? RETURNING window_count")
		.bind(minute, minute, now, found.id)
		.first<{ window_count: number }>();
	const count = used?.window_count ?? 1;
	const limits = { "X-RateLimit-Limit": String(API_LIMIT), "X-RateLimit-Remaining": String(Math.max(0, API_LIMIT - count)) };
	if (count > API_LIMIT) {
		const wait = String(Math.max(1, Math.ceil((minute + 60_000 - now) / 1000)));
		return problem(429, `Slow down: each key can make ${API_LIMIT} requests a minute. Try again in ${wait} seconds, and keep answers for a minute or two on your side.`, { ...limits, "Retry-After": wait });
	}

	const args: Record<string, unknown> = Object.fromEntries(url.searchParams);
	try {
		return answer(await route(args, env.DB, [found.site], now, found.account_id, env), 200, limits);
	} catch (e) {
		return problem(400, e instanceof Error ? e.message : "Something went wrong.", limits);
	}
}
