// ReaderCount: Google Search Console. The owner connects their Google account once from the stats page;
// each night ReaderCount copies the searches that showed their pages in Google, with clicks and position.
// Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (a Google Cloud "Web application" OAuth client whose
// redirect address is https://STATS-ADDRESS/google/callback). Read-only access; nothing is changed in Google.

import { utcDay } from "./visitor.ts";

export type GoogleEnv = { DB: D1Database; ADMIN_PASSWORD?: string; GOOGLE_TOKEN_KEY?: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string };

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/webmasters/v3";
const PAGE = 25_000; // Google's most rows per request
const MAX_PAGES = 8;

export const googleOn = (env: GoogleEnv) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && (env.GOOGLE_TOKEN_KEY || env.ADMIN_PASSWORD));

export function connectUrl(env: GoogleEnv, origin: string, state: string): string {
	const q = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID!,
		redirect_uri: origin + "/google/callback",
		response_type: "code",
		scope: SCOPE,
		access_type: "offline",
		prompt: "consent",
		state,
	});
	return `${AUTH}?${q}`;
}

// ---- The refresh token is kept encrypted. ----
// The key comes from its own secret, GOOGLE_TOKEN_KEY (`wrangler secret put GOOGLE_TOKEN_KEY`), so the stats
// page secret can be changed without losing every Google link. Until it's set, the key is made from
// ADMIN_PASSWORD as before. Tokens sealed with that older key still open, and are sealed again with the
// new key the next time they're used.

async function keyFrom(secret: string): Promise<CryptoKey> {
	// Same key for every owner; each token also has its own random IV.
	const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret + ":google"));
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const cryptoKey = (env: GoogleEnv) => keyFrom(env.GOOGLE_TOKEN_KEY || env.ADMIN_PASSWORD || "");

export async function seal(env: GoogleEnv, text: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(env), new TextEncoder().encode(text)));
	return btoa(String.fromCharCode(...iv, ...ct));
}

/** Opens a sealed token; old says it was sealed with the older ADMIN_PASSWORD key and should be sealed again. */
export async function unseal(env: GoogleEnv, sealed: string): Promise<{ text: string; old: boolean }> {
	const b = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
	const open = async (key: CryptoKey) => new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, key, b.slice(12)));
	try {
		return { text: await open(await cryptoKey(env)), old: false };
	} catch (e) {
		if (!env.GOOGLE_TOKEN_KEY || !env.ADMIN_PASSWORD) throw e;
		return { text: await open(await keyFrom(env.ADMIN_PASSWORD)), old: true };
	}
}

/** An owner's refresh token, moved onto the current key if it was sealed with the older one. */
async function refreshToken(env: GoogleEnv, owner: Owner, sealed: string): Promise<string> {
	const { text, old } = await unseal(env, sealed);
	if (old) await env.DB.prepare("UPDATE google_links SET token = ? WHERE owner = ? AND token = ?").bind(await seal(env, text), owner, sealed).run();
	return text;
}

export async function tokenCall(env: GoogleEnv, params: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string; error?: string; error_description?: string }> {
	const res = await fetch(TOKEN, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, ...params }),
	});
	return res.json();
}

/**
 * Who a Google link belongs to: always the owner account id in a self-hosted ReaderCount.
 */
export type Owner = string;

/** After the owner says yes on Google's page: swap the code for a refresh token and keep it. */
export async function finishConnect(env: GoogleEnv, owner: Owner, origin: string, code: string, now: number): Promise<string | null> {
	const t = await tokenCall(env, { code, grant_type: "authorization_code", redirect_uri: origin + "/google/callback" });
	if (!t.refresh_token) return t.error_description ?? t.error ?? "Google didn't give access.";
	await env.DB.prepare("INSERT OR REPLACE INTO google_links (owner, token, connected_at, synced_at, last_error) VALUES (?, ?, ?, NULL, NULL)")
		.bind(owner, await seal(env, t.refresh_token), now)
		.run();
	return null;
}

/** Hand access back to Google and forget the link and the search figures copied for these sites. */
export async function disconnect(env: GoogleEnv, owner: Owner, sites: string[]): Promise<void> {
	const row = await env.DB.prepare("SELECT token FROM google_links WHERE owner = ?").bind(owner).first<{ token: string }>();
	if (row && row.token !== "demo") {
		try {
			await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: (await unseal(env, row.token)).text }) });
		} catch {
			// Forget it here even if Google can't be reached.
		}
	}
	await env.DB.batch([
		env.DB.prepare("DELETE FROM google_links WHERE owner = ?").bind(owner),
		...sites.flatMap((site) => [
			env.DB.prepare("DELETE FROM search WHERE site = ?").bind(site),
			env.DB.prepare("DELETE FROM search_days WHERE site = ?").bind(site),
			env.DB.prepare("DELETE FROM search_sites WHERE site = ?").bind(site),
		]),
	]);
}

export type GoogleState = { connected: boolean; syncedAt: number | null; error: string | null };

export async function googleState(db: D1Database, owner: Owner): Promise<GoogleState> {
	const row = await db.prepare("SELECT synced_at, last_error FROM google_links WHERE owner = ?").bind(owner).first<{ synced_at: number | null; last_error: string | null }>();
	return { connected: Boolean(row), syncedAt: row?.synced_at ?? null, error: row?.last_error ?? null };
}

/** The Search Console property for a site: a Domain property if there is one, else its https (or http) address. */
export function propertyFor(site: string, entries: { siteUrl: string; permissionLevel?: string }[]): string | null {
	const ok = entries.filter((e) => e.permissionLevel !== "siteUnverifiedUser").map((e) => e.siteUrl);
	const tries = [`sc-domain:${site}`, `https://${site}/`, `https://www.${site}/`, `http://${site}/`, `http://www.${site}/`];
	return tries.find((t) => ok.includes(t)) ?? null;
}

type ApiRow = { keys: string[]; clicks: number; impressions: number; position: number };

async function query(token: string, property: string, body: Record<string, unknown>): Promise<ApiRow[]> {
	const res = await fetch(`${API}/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Google said ${res.status} for ${property}`);
	return ((await res.json()) as { rows?: ApiRow[] }).rows ?? [];
}

function pathOf(page: string): string {
	try {
		return new URL(page).pathname.slice(0, 300) || "/";
	} catch {
		return page.slice(0, 300);
	}
}

/** Write rows as JSON in a few big statements (D1 allows only 100 bound values per statement). */
export async function insertJson(db: D1Database, sql: string, site: string, rows: unknown[][]): Promise<void> {
	const stmts: D1PreparedStatement[] = [];
	let chunk: unknown[][] = [], size = 0;
	for (const r of rows) {
		const s = JSON.stringify(r).length;
		if (chunk.length && size + s > 400_000) {
			stmts.push(db.prepare(sql).bind(site, JSON.stringify(chunk)));
			chunk = [];
			size = 0;
		}
		chunk.push(r);
		size += s + 1;
	}
	if (chunk.length) stmts.push(db.prepare(sql).bind(site, JSON.stringify(chunk)));
	if (stmts.length) await db.batch(stmts);
}

/**
 * Copy Google's numbers for the last `days` days (up to yesterday) for every counted site that's in
 * Search Console. Google's figures settle over two or three days, so the nightly run fetches the last
 * few days again and replaces them. A website copied for the first time (just added, or just added to
 * this Google account's Search Console) gets the last 90 days instead.
 */
export async function syncSearch(env: GoogleEnv, owner: Owner, sites: string[], now: number, days = 5): Promise<string> {
	const row = await env.DB.prepare("SELECT token FROM google_links WHERE owner = ?").bind(owner).first<{ token: string }>();
	if (!row || !googleOn(env)) return "not connected";
	if (row.token === "demo") return "demo"; // the reviewer's made-up Google data (src/demo.ts)
	try {
		const t = await tokenCall(env, { grant_type: "refresh_token", refresh_token: await refreshToken(env, owner, row.token) });
		if (!t.access_token) throw new Error(t.error === "invalid_grant" ? "Google access was removed or has expired. Connect Google again." : `Google sign-in failed: ${t.error ?? "unknown"}`);
		const list = await fetch(`${API}/sites`, { headers: { Authorization: `Bearer ${t.access_token}` } });
		if (!list.ok) throw new Error(`Google said ${list.status} when listing your sites`);
		const entries = ((await list.json()) as { siteEntry?: { siteUrl: string; permissionLevel?: string }[] }).siteEntry ?? [];
		const to = utcDay(now - 86_400_000);
		const found: string[] = [];
		for (const site of sites) {
			const property = propertyFor(site, entries);
			if (!property) {
				// Not (or no longer) in this Google account: forget where it was, so the stats page says so.
				await env.DB.prepare("DELETE FROM search_sites WHERE site = ?").bind(site).run();
				continue;
			}
			found.push(site);
			const known = await env.DB.prepare("SELECT 1 FROM search_sites WHERE site = ?").bind(site).first();
			const from = utcDay(now - (known ? days : Math.max(days, 90)) * 86_400_000);
			const totals = await query(t.access_token, property, { startDate: from, endDate: to, dimensions: ["date"], type: "web", rowLimit: PAGE });
			const detail = new Map<string, { clicks: number; impressions: number; posSum: number }>();
			for (let p = 0; p < MAX_PAGES; p++) {
				const rows = await query(t.access_token, property, { startDate: from, endDate: to, dimensions: ["date", "query", "page"], type: "web", rowLimit: PAGE, startRow: p * PAGE });
				for (const r of rows) {
					// The same path can come from http/https or www addresses; add them together.
					const key = JSON.stringify([r.keys[0], r.keys[1].slice(0, 300), pathOf(r.keys[2])]);
					const d = detail.get(key) ?? { clicks: 0, impressions: 0, posSum: 0 };
					d.clicks += r.clicks;
					d.impressions += r.impressions;
					d.posSum += r.position * r.impressions;
					detail.set(key, d);
				}
				if (rows.length < PAGE) break;
			}
			await env.DB.batch([
				env.DB.prepare("DELETE FROM search WHERE site = ? AND day >= ? AND day <= ?").bind(site, from, to),
				env.DB.prepare("DELETE FROM search_days WHERE site = ? AND day >= ? AND day <= ?").bind(site, from, to),
			]);
			await insertJson(
				env.DB,
				"INSERT INTO search_days (site, day, clicks, impressions, position) SELECT ?, value->>0, value->>1, value->>2, value->>3 FROM json_each(?)",
				site,
				totals.map((r) => [r.keys[0], r.clicks, r.impressions, Math.round(r.position * 10) / 10]),
			);
			await insertJson(
				env.DB,
				"INSERT INTO search (site, day, query, page, clicks, impressions, position) SELECT ?, value->>0, value->>1, value->>2, value->>3, value->>4, value->>5 FROM json_each(?)",
				site,
				[...detail].map(([k, d]) => [...JSON.parse(k), d.clicks, d.impressions, d.impressions ? Math.round((d.posSum / d.impressions) * 10) / 10 : 0]),
			);
			await env.DB.prepare("INSERT OR REPLACE INTO search_sites (site, property) VALUES (?, ?)").bind(site, property).run();
		}
		const note = found.length ? null : `None of your sites (${sites.join(", ")}) are in this Google account's Search Console.`;
		await env.DB.prepare("UPDATE google_links SET synced_at = ?, last_error = ? WHERE owner = ?").bind(now, note, owner).run();
		return found.length ? `synced ${found.join(", ")}` : "no matching sites";
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		await env.DB.prepare("UPDATE google_links SET last_error = ? WHERE owner = ?").bind(msg.slice(0, 300), owner).run();
		return msg;
	}
}

export type SearchReport = {
	from: string;
	to: string;
	/** The dates asked for are after Google's latest figures, so from and to are Google's latest week instead. */
	late?: boolean;
	totals: { clicks: number; impressions: number; position: number };
	/** Where the site is in Search Console: a property such as "sc-domain:example.com", "" while not yet known, or null when it isn't in the connected Google account. */
	property: string | null;
	queries: { query: string; clicks: number; impressions: number; position: number }[];
};

/** Google searches for a site over a date range, for the stats page. */
export async function searchReport(db: D1Database, site: string, from: string, to: string, limit = 15): Promise<SearchReport> {
	// Google's figures arrive two or three days late, so Today, Yesterday and other dates after its latest day show its latest week instead of nothing.
	const latest = await db.prepare("SELECT MAX(day) AS day FROM search_days WHERE site = ?").bind(site).first<{ day: string | null }>();
	const late = Boolean(latest?.day && from > latest.day);
	if (late) {
		to = latest!.day!;
		from = new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
	}
	const [totals, queries, found] = await Promise.all([
		db.prepare("SELECT COALESCE(SUM(clicks), 0) AS clicks, COALESCE(SUM(impressions), 0) AS impressions, ROUND(SUM(position * impressions) / MAX(SUM(impressions), 1), 1) AS position FROM search_days WHERE site = ? AND day >= ? AND day <= ?")
			.bind(site, from, to)
			.first<SearchReport["totals"]>(),
		db.prepare(`SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions, ROUND(SUM(position * impressions) / MAX(SUM(impressions), 1), 1) AS position FROM search WHERE site = ? AND day >= ? AND day <= ? GROUP BY query ORDER BY clicks DESC, impressions DESC LIMIT ${limit}`)
			.bind(site, from, to)
			.all<SearchReport["queries"][number]>(),
		db.prepare("SELECT property FROM search_sites WHERE site = ?").bind(site).first<{ property: string | null }>(),
	]);
	return { from, to, ...(late ? { late } : {}), totals: totals ?? { clicks: 0, impressions: 0, position: 0 }, property: found ? (found.property ?? "") : null, queries: queries.results ?? [] };
}

/** Google's own Search Console report for a property. It opens signed in if the reader is signed in to Google in that browser. */
export function consoleUrl(property: string): string {
	return `https://search.google.com/search-console/performance/search-analytics?resource_id=${encodeURIComponent(property)}`;
}
