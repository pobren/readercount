// Google AdSense: the owner signs in with Google once (the same Google app as Search Console, asking only to view
// AdSense data) and every night we read the last 30 days of estimated earnings by day, website and URL channel. A URL
// channel set up for one post ("example.com/best-vpn/") makes that post's ad money exact; the rest is shared across a
// website's pages by their page views (ads pay for being seen, not for clicks through to a shop). The figures go into
// affiliate_earnings as network "adsense", so Earnings per post and Earnings Insights use them like any network.

import { seal, tokenCall, unseal, type GoogleEnv } from "./google.ts";
import { utcDay } from "./visitor.ts";

const SCOPE = "https://www.googleapis.com/auth/adsense.readonly";
const API = "https://adsense.googleapis.com/v2";
export const ADSENSE_SHOP = "Google AdSense";
const DAYS = 30;
type Get = typeof fetch;

export function adsenseConnectUrl(env: GoogleEnv, origin: string, state: string): string {
	const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, redirect_uri: origin + "/google/callback", response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state });
	return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export type AdsenseState = { connected: boolean; account: string | null; syncedAt: number | null; error: string | null };

export async function adsenseState(db: D1Database, owner: string): Promise<AdsenseState> {
	const r = await db.prepare("SELECT account, synced_at, last_error FROM adsense_links WHERE owner = ?").bind(owner).first<{ account: string | null; synced_at: number | null; last_error: string | null }>().catch(() => null);
	return { connected: Boolean(r), account: r?.account ?? null, syncedAt: r?.synced_at ?? null, error: r?.last_error ?? null };
}

/** After the owner says yes on Google's page: keep the refresh token, then read the last 30 days. */
export async function finishAdsense(env: GoogleEnv, owner: string, origin: string, code: string, sites: string[], now: number, get: Get = fetch): Promise<string | null> {
	const t = await tokenCall(env, { code, grant_type: "authorization_code", redirect_uri: origin + "/google/callback" });
	if (!t.refresh_token) return t.error_description ?? t.error ?? "Google didn't give access.";
	await env.DB.prepare("INSERT OR REPLACE INTO adsense_links (owner, token, account, connected_at, synced_at, last_error) VALUES (?, ?, NULL, ?, NULL, NULL)").bind(owner, await seal(env, t.refresh_token), now).run();
	await syncAdsense(env, owner, sites, now, get);
	return null;
}

/** Hands access back to Google and forgets the link and the AdSense figures for these sites. */
export async function disconnectAdsense(env: GoogleEnv, owner: string, sites: string[], get: Get = fetch): Promise<void> {
	const row = await env.DB.prepare("SELECT token FROM adsense_links WHERE owner = ?").bind(owner).first<{ token: string }>();
	if (row)
		try {
			await get("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: (await unseal(env, row.token)).text }) });
		} catch {
			// Forget it here even if Google can't be reached.
		}
	await env.DB.batch([env.DB.prepare("DELETE FROM adsense_links WHERE owner = ?").bind(owner), ...sites.map((s) => env.DB.prepare("DELETE FROM affiliate_earnings WHERE site = ? AND network = 'adsense'").bind(s))]);
}

const bare = (h: string) => h.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
const ymd = (day: string, k: string) => {
	const [y, m, d] = day.split("-");
	return { [`${k}.year`]: String(Number(y)), [`${k}.month`]: String(Number(m)), [`${k}.day`]: String(Number(d)) };
};

/** The page a URL channel points at, when it's one post ("example.com/best-vpn/"), on one of these sites. */
export function channelPage(channel: string): { site: string; path: string } | null {
	const c = bare(channel.trim());
	const at = c.indexOf("/");
	if (at < 1 || at === c.length - 1) return null;
	return { site: c.slice(0, at), path: c.slice(at).split(/[?#*]/)[0] };
}

/** Reads the owner's AdSense earnings into affiliate_earnings for their sites. Returns an error to show, or null. */
export async function syncAdsense(env: GoogleEnv, owner: string, sites: string[], now: number, get: Get = fetch): Promise<string | null> {
	const row = await env.DB.prepare("SELECT token, account FROM adsense_links WHERE owner = ?").bind(owner).first<{ token: string; account: string | null }>();
	if (!row) return null;
	let error: string | null = null;
	try {
		const t = await tokenCall(env, { grant_type: "refresh_token", refresh_token: (await unseal(env, row.token)).text });
		if (!t.access_token) throw new Error(t.error === "invalid_grant" ? "Google access was removed or has expired. Connect AdSense again." : `Google sign-in failed: ${t.error ?? "unknown"}`);
		const auth = { headers: { Authorization: `Bearer ${t.access_token}` } };
		let account = row.account;
		if (!account) {
			const res = await get(`${API}/accounts`, auth);
			if (!res.ok) throw new Error(`AdSense said ${res.status} when we asked for your account.`);
			account = ((await res.json()) as { accounts?: { name: string }[] }).accounts?.[0]?.name ?? null;
			if (!account) throw new Error("This Google account has no AdSense account. Connect the one you use for AdSense.");
		}
		const from = utcDay(now - (DAYS - 1) * 86_400_000), to = utcDay(now - 86_400_000);
		const q = new URLSearchParams({ dateRange: "CUSTOM", ...ymd(from, "startDate"), ...ymd(to, "endDate"), currencyCode: "GBP" });
		for (const d of ["DATE", "DOMAIN_NAME", "URL_CHANNEL_NAME"]) q.append("dimensions", d);
		q.append("metrics", "ESTIMATED_EARNINGS");
		const res = await get(`${API}/${account}/reports:generate?${q}`, auth);
		if (!res.ok) throw new Error(`AdSense said ${res.status} when we asked for your earnings. We'll try again tonight.`);
		const body = (await res.json()) as { headers?: { name: string }[]; rows?: { cells: { value?: string }[] }[] };
		const at = (name: string) => (body.headers ?? []).findIndex((h) => h.name === name);
		const iDay = at("DATE"), iDomain = at("DOMAIN_NAME"), iChannel = at("URL_CHANNEL_NAME"), iMoney = at("ESTIMATED_EARNINGS");
		const mine = new Set(sites.map(bare));
		const sum = new Map<string, number>();
		for (const r of body.rows ?? []) {
			const cell = (i: number) => (i >= 0 ? (r.cells[i]?.value ?? "") : "");
			const domain = bare(cell(iDomain));
			const ch = channelPage(cell(iChannel));
			const site = ch && mine.has(bare(ch.site)) ? bare(ch.site) : domain;
			if (!mine.has(site)) continue;
			const page = ch && bare(ch.site) === site ? ch.path : "";
			const pence = Math.round(Number(cell(iMoney)) * 100);
			if (!pence) continue;
			const k = JSON.stringify([site, cell(iDay), page]);
			sum.set(k, (sum.get(k) ?? 0) + pence);
		}
		const stmts = [...mine].map((s) => env.DB.prepare("DELETE FROM affiliate_earnings WHERE site = ? AND network = 'adsense' AND day >= ? AND day <= ?").bind(sites.find((x) => bare(x) === s) ?? s, from, to));
		for (const [k, pence] of sum) {
			const [s, day, page] = JSON.parse(k) as string[];
			stmts.push(env.DB.prepare("INSERT INTO affiliate_earnings (site, network, day, shop, page, pence) VALUES (?, 'adsense', ?, ?, ?, ?)").bind(sites.find((x) => bare(x) === s) ?? s, day, ADSENSE_SHOP, page, pence));
		}
		for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
		await env.DB.prepare("UPDATE adsense_links SET account = ?, synced_at = ?, last_error = NULL WHERE owner = ?").bind(account, now, owner).run();
	} catch (e) {
		error = e instanceof Error ? e.message : "We couldn't reach AdSense. We'll try again tonight.";
		await env.DB.prepare("UPDATE adsense_links SET last_error = ? WHERE owner = ?").bind(error, owner).run();
	}
	return error;
}
