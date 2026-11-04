// Affiliate networks: instead of uploading a report, the owner pastes their network's API details once and every
// night we read the last 30 days of commissions (networks change pending sales for weeks). Each sale the network
// can tie to a page (the page the reader clicked from, or a sub-ID that's a page address) counts for that page
// exactly; the rest is shared across pages by their clicks to that shop, the same as an uploaded report.
// Awin, Impact, CJ, Rakuten, Partnerize, Skimlinks, Sovrn Commerce and PartnerStack. Amazon has no earnings API, so
// Amazon reports are still uploaded (src/earnings.ts). The token (and, for networks that need two, the second key) is
// kept encrypted, the same way as the Ghost key. We only ever read reports with it.
// The response shapes for the five added on 26 Oct 2026 come from each network's documentation, not live accounts:
// check each with a real account after deploy.

import type { Env } from "./index.ts";
import { utcDay } from "./visitor.ts";
import { cells, readPence } from "./earnings.ts";

type AffEnv = Pick<Env, "DB" | "GOOGLE_TOKEN_KEY" | "ADMIN_PASSWORD">;
type Get = typeof fetch;

export const NETWORKS = {
	awin: { name: "Awin", id: "Publisher ID", token: "API token", where: "In Awin, open your account menu, then API Credentials. Your publisher ID is the number in the address bar." },
	impact: { name: "Impact", id: "Account SID", token: "Auth token", where: "In Impact, open Settings, then API. Copy the Account SID and Auth Token (read-only is enough)." },
	cj: { name: "CJ", id: "Company ID (CID)", token: "Personal access token", where: "In CJ, your CID is at the top right. Make a personal access token at developers.cj.com, under Authentication." },
	rakuten: { name: "Rakuten", id: "Site ID (SID)", token: "Report API link", where: "In Rakuten Advertising, open Reports, then the Signature Orders report, and copy its API link (it has token= in it). Your Site ID is under your account name." },
	partnerize: { name: "Partnerize", id: "Publisher ID", token: "User API key", secret: "Application key", where: "In Partnerize, open your account settings, then API Credentials. Copy the User API key and the Application key. Your Publisher ID is on the same page." },
	skimlinks: { name: "Skimlinks", id: "Publisher ID", token: "Client ID", secret: "Client secret", where: "In the Skimlinks Publisher Hub, open Toolbox, then APIs, then API Authentication credentials. Your Publisher ID is in Settings." },
	sovrn: { name: "Sovrn Commerce", id: "Site name", token: "Secret key", where: "In Sovrn Commerce, open Settings, then API Keys, and copy the Secret key. The site name is just for you." },
	partnerstack: { name: "PartnerStack", id: "Your partner name", token: "Partner API key", where: "In PartnerStack, open your profile, then the API tab, and create a key. The partner name is just for you." },
} as const satisfies Record<string, { name: string; id: string; token: string; secret?: string; where: string }>;
const secretOf = (n: Network): string | undefined => (NETWORKS[n] as { secret?: string }).secret;
/** The second key's label, for networks that need two. */
export const needsSecret = (n: Network) => secretOf(n);
export type Network = keyof typeof NETWORKS;
export const isNetwork = (x: unknown): x is Network => typeof x === "string" && Object.hasOwn(NETWORKS, x);

/** Days read each night. */
export const SYNC_DAYS = 30;

/** One sale or commission, in the network's own currency's minor units. page is set when the network says it. */
export type Sale = { day: string; shop: string; pence: number; page: string };

async function cryptoKey(env: AffEnv): Promise<CryptoKey> {
	const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode((env.GOOGLE_TOKEN_KEY || env.ADMIN_PASSWORD || "") + ":affiliate"));
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(env: AffEnv, text: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(env), new TextEncoder().encode(text)));
	return btoa(String.fromCharCode(...iv, ...ct));
}

async function unseal(env: AffEnv, sealed: string): Promise<string> {
	const b = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
	return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, await cryptoKey(env), b.slice(12)));
}

/** The page on the owner's website a sale came from: the address the reader clicked from, or a sub-ID like "/my-post/". */
export function pageFrom(site: string, ...hints: unknown[]): string {
	for (const h of hints) {
		let v = String(h ?? "").trim();
		if (!v) continue;
		// Partnerize and some others hand back the sub-ID still encoded ("%2Fbest-vpn-uk%2F").
		if (/^%2f/i.test(v))
			try {
				v = decodeURIComponent(v);
			} catch {
				// Leave it.
			}
		if (v.startsWith("/")) return v.split(/[?#]/)[0].slice(0, 300);
		try {
			const u = new URL(v);
			const host = u.hostname.replace(/^www\./, "");
			if (host === site.replace(/^www\./, "")) return u.pathname.slice(0, 300) || "/";
		} catch {
			// Not an address.
		}
	}
	return "";
}

const iso = (day: string, end = false) => `${day}T${end ? "23:59:59" : "00:00:00"}`;
/** "10/01/26" or "10/01/2026" (US order, as Rakuten writes them) or "2026-10-01" as a day. */
function usDay(v: unknown): string {
	const t = String(v ?? "").trim();
	const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/.exec(t);
	if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
	return t.slice(0, 10);
}
/** A day from an ISO date, a "2026-10-01 12:00:00" time or milliseconds. */
const anyDay = (v: unknown) => (typeof v === "number" ? utcDay(v > 1e11 ? v : v * 1000) : String(v ?? "").slice(0, 10));
/** The first of several paths into an object that has a value. */
function pick(o: any, ...paths: string[]): unknown {
	for (const p of paths) {
		const v = p.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
		if (v !== undefined && v !== null && v !== "") return v;
	}
	return undefined;
}
const pence = (x: unknown) => (typeof x === "number" ? Math.round(x * 100) : readPence(String(x ?? "")));

class NetworkError extends Error {}

async function call(get: Get, url: string, init: RequestInit, name: string): Promise<unknown> {
	const res = await get(url, { ...init, headers: { Accept: "application/json", "User-Agent": "ReaderCount (+https://paulobrien.dev/readercount/)", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
	if (res.status === 401 || res.status === 403) throw new NetworkError(`${name} didn't accept those details. Check the ID and token, then connect again.`);
	if (!res.ok) throw new NetworkError(`${name} answered with error ${res.status}. We'll try again tonight.`);
	return res.json();
}

/** Reads the network's commissions between two days (at most 31 days apart). */
export async function readSales(network: Network, site: string, id: string, token: string, from: string, to: string, get: Get = fetch, secret = ""): Promise<Sale[]> {
	if (network === "awin") {
		const q = new URLSearchParams({ startDate: iso(from), endDate: iso(to, true), timezone: "UTC" });
		const rows = (await call(get, `https://api.awin.com/publishers/${encodeURIComponent(id)}/transactions/?${q}`, { headers: { Authorization: `Bearer ${token}` } }, "Awin")) as Record<string, any>[];
		return (Array.isArray(rows) ? rows : [])
			.filter((t) => t.commissionStatus !== "declined" && t.transactionDate)
			.map((t) => ({ day: String(t.transactionDate).slice(0, 10), shop: String(t.advertiserName ?? `awin ${t.advertiserId ?? ""}`).trim(), pence: pence(t.commissionAmount?.amount) ?? 0, page: pageFrom(site, t.clickRefs?.clickRef, t.publisherUrl) }));
	}
	if (network === "impact") {
		const out: Sale[] = [];
		const auth = `Basic ${btoa(`${id}:${token}`)}`;
		let url: string | null = `https://api.impact.com/Mediapartners/${encodeURIComponent(id)}/Actions?${new URLSearchParams({ ActionDateStart: `${iso(from)}Z`, ActionDateEnd: `${iso(to, true)}Z`, PageSize: "1000" })}`;
		for (let page = 0; url && page < 20; page++) {
			const body = (await call(get, url, { headers: { Authorization: auth } }, "Impact")) as { Actions?: Record<string, any>[]; "@nextpageuri"?: string };
			for (const a of body.Actions ?? []) if (a.State !== "REVERSED" && a.EventDate) out.push({ day: String(a.EventDate).slice(0, 10), shop: String(a.CampaignName ?? "impact"), pence: pence(a.Payout) ?? 0, page: pageFrom(site, a.SubId1, a.ReferringUrl ?? a.ReferringURL) });
			url = body["@nextpageuri"] ? `https://api.impact.com${body["@nextpageuri"]}` : null;
		}
		return out;
	}
	if (network === "rakuten") {
		// The owner's own report link, with our dates in it. It answers with CSV.
		const u = new URL(token);
		u.searchParams.set("start_date", from);
		u.searchParams.set("end_date", to);
		u.searchParams.set("date_type", "transaction");
		const res = await get(u.toString(), { headers: { "User-Agent": "ReaderCount (+https://paulobrien.dev/readercount/)" }, signal: AbortSignal.timeout(20_000) });
		if (res.status === 401 || res.status === 403) throw new NetworkError("Rakuten didn't accept that report link. Copy the API link again, then connect again.");
		if (!res.ok) throw new NetworkError(`Rakuten answered with error ${res.status}. We'll try again tonight.`);
		const lines = (await res.text()).replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
		if (!lines.length) return [];
		const head = cells(lines[0], ",").map((h) => h.toLowerCase());
		const col = (re: RegExp) => head.findIndex((h) => re.test(h));
		const day = col(/transaction date|process date|^date/), shop = col(/advertiser name|advertiser|merchant/), amount = col(/total commission|commission/), u1 = col(/u1|member id/);
		if (day < 0 || amount < 0) throw new NetworkError("That Rakuten report has no date or commission column. Use the Signature Orders report's API link.");
		return lines.slice(1).map((l) => cells(l, ",")).map((c) => ({ day: usDay(c[day]), shop: (shop >= 0 ? c[shop] : "") || "rakuten", pence: readPence(c[amount] ?? "") ?? 0, page: pageFrom(site, u1 >= 0 ? c[u1] : "") }));
	}
	if (network === "partnerize") {
		const out: Sale[] = [];
		const auth = `Basic ${btoa(`${secret}:${token}`)}`;
		for (let offset = 0; offset < 20 * 300; offset += 300) {
			const q = new URLSearchParams({ start_date: `${from} 00:00:00`, end_date: `${to} 23:59:59`, limit: "300", offset: String(offset) });
			const body = (await call(get, `https://api.partnerize.com/reporting/report_publisher/publisher/${encodeURIComponent(id)}/conversion.json?${q}`, { headers: { Authorization: auth } }, "Partnerize")) as { conversions?: { conversion_data?: Record<string, any> }[] };
			const got = body.conversions ?? [];
			for (const c of got) {
				const d = c.conversion_data ?? {};
				const status = String(pick(d, "conversion_value.conversion_status", "conversion_status") ?? "").toLowerCase();
				if (status === "rejected") continue;
				out.push({ day: anyDay(pick(d, "conversion_time", "conversion_date")), shop: String(pick(d, "campaign_title", "advertiser_name") ?? "partnerize"), pence: pence(pick(d, "conversion_value.publisher_commission", "publisher_commission")) ?? 0, page: pageFrom(site, pick(d, "publisher_reference"), pick(d, "referer")) });
			}
			if (got.length < 300) break;
		}
		return out;
	}
	if (network === "skimlinks") {
		const auth = (await call(get, "https://authentication.skimapis.com/access_token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: token, client_secret: secret, grant_type: "client_credentials" }) }, "Skimlinks")) as { access_token?: string };
		if (!auth.access_token) throw new NetworkError("Skimlinks didn't accept those details. Check the Client ID and secret, then connect again.");
		const out: Sale[] = [];
		for (let offset = 0; offset < 20 * 500; offset += 500) {
			const q = new URLSearchParams({ start_date: from, end_date: to, limit: "500", offset: String(offset), access_token: auth.access_token });
			const body = (await call(get, `https://reporting.skimapis.com/publisher/${encodeURIComponent(id)}/commission-report?${q}`, {}, "Skimlinks")) as { commissions?: Record<string, any>[] };
			const got = body.commissions ?? [];
			for (const c of got) {
				if (String(pick(c, "transaction_details.status", "status") ?? "").toLowerCase() === "cancelled") continue;
				out.push({ day: anyDay(pick(c, "transaction_details.transaction_date", "transaction_date", "date")), shop: String(pick(c, "merchant_details.merchant_name", "merchant_name") ?? "skimlinks"), pence: pence(pick(c, "transaction_details.basket.publisher_amount", "transaction_details.publisher_amount", "commission_amount", "publisher_amount")) ?? 0, page: pageFrom(site, pick(c, "click_details.custom_id", "custom_id", "xcust"), pick(c, "click_details.page_url", "page_url")) });
			}
			if (got.length < 500) break;
		}
		return out;
	}
	if (network === "sovrn") {
		const q = new URLSearchParams({ lastDate: to, period: "month" });
		const body = (await call(get, `https://viglink.io/transactions?${q}`, { headers: { Authorization: `secret ${token}` } }, "Sovrn Commerce")) as { transactions?: Record<string, any>[] } | Record<string, any>[];
		const rows = Array.isArray(body) ? body : (body.transactions ?? []);
		return rows
			.map((t) => ({ day: anyDay(pick(t, "commissionDate", "transactionDate", "clickDate", "date")), shop: String(pick(t, "merchantName", "merchant") ?? "sovrn"), pence: pence(pick(t, "publisherRevenue", "commission", "revenue")) ?? 0, page: pageFrom(site, pick(t, "cuid"), pick(t, "pageUrl", "referringUrl")) }))
			.filter((t) => t.day >= from && t.day <= to);
	}
	if (network === "partnerstack") {
		const out: Sale[] = [];
		let after = "";
		for (let page = 0; page < 20; page++) {
			const q = new URLSearchParams({ limit: "250", ...(after ? { starting_after: after } : {}) });
			const body = (await call(get, `https://api.partnerstack.com/api/v2/rewards?${q}`, { headers: { Authorization: `Bearer ${token}` } }, "PartnerStack")) as { data?: { items?: Record<string, any>[]; has_more?: boolean } };
			const items = body.data?.items ?? [];
			for (const r of items) {
				const day = anyDay(pick(r, "created_at"));
				if (String(pick(r, "status") ?? "").toLowerCase() === "declined") continue;
				// PartnerStack gives cents already.
				if (day >= from && day <= to) out.push({ day, shop: String(pick(r, "company.name", "company_name", "company_key") ?? "partnerstack"), pence: Math.round(Number(pick(r, "amount") ?? 0)), page: "" });
			}
			// Newest first: once a page goes back past the first day, the rest is older still.
			const oldest = items.length ? anyDay(pick(items[items.length - 1], "created_at")) : "";
			if (!body.data?.has_more || !items.length || oldest < from) break;
			after = String(pick(items[items.length - 1], "key", "id") ?? "");
			if (!after) break;
		}
		return out;
	}
	const query = `{ publisherCommissions(forPublishers: [${JSON.stringify(id)}], sincePostingDate: ${JSON.stringify(`${iso(from)}Z`)}, beforePostingDate: ${JSON.stringify(`${iso(to, true)}Z`)}) { records { postingDate pubCommissionAmountUsd advertiserName shopperId clickReferringURL actionStatus } } }`;
	const body = (await call(get, "https://commissions.api.cj.com/query", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query }) }, "CJ")) as { data?: { publisherCommissions?: { records?: Record<string, any>[] } }; errors?: { message: string }[] };
	if (body.errors?.length) throw new NetworkError(`CJ said: ${String(body.errors[0].message).slice(0, 150)}`);
	return (body.data?.publisherCommissions?.records ?? [])
		.filter((r) => r.postingDate)
		.map((r) => ({ day: String(r.postingDate).slice(0, 10), shop: String(r.advertiserName ?? "cj"), pence: pence(r.pubCommissionAmountUsd) ?? 0, page: pageFrom(site, r.shopperId, r.clickReferringURL) }));
}

/** Replaces the network's figures for the days read. Several sales on one day, shop and page add up. */
async function saveSales(db: D1Database, site: string, network: Network, from: string, to: string, sales: Sale[]): Promise<void> {
	const sum = new Map<string, Sale>();
	for (const s of sales) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(s.day) || s.day < from || s.day > to) continue;
		const k = `${s.day}\n${s.shop.toLowerCase()}\n${s.page}`;
		const was = sum.get(k);
		sum.set(k, { ...s, pence: (was?.pence ?? 0) + s.pence });
	}
	const rows = [...sum.values()].filter((s) => s.pence);
	await db.prepare("DELETE FROM affiliate_earnings WHERE site = ? AND network = ? AND day >= ? AND day <= ?").bind(site, network, from, to).run();
	for (let i = 0; i < rows.length; i += 50)
		await db.batch(rows.slice(i, i + 50).map((s) => db.prepare("INSERT INTO affiliate_earnings (site, network, day, shop, page, pence) VALUES (?, ?, ?, ?, ?, ?)").bind(site, network, s.day, s.shop.slice(0, 100), s.page, s.pence)));
}

async function syncOne(env: AffEnv, site: string, network: Network, id: string, token: string, now: number, get: Get, secret = ""): Promise<number> {
	const to = utcDay(now), from = utcDay(now - (SYNC_DAYS - 1) * 86_400_000);
	const sales = await readSales(network, site, id, token, from, to, get, secret);
	await saveSales(env.DB, site, network, from, to, sales);
	return sales.length;
}

/** Checks the details with the network, reads the last 30 days and keeps them. */
export async function connectNetwork(env: AffEnv, site: string, networkIn: unknown, idIn: unknown, tokenIn: unknown, limit: number, now: number, get: Get = fetch, secretIn: unknown = ""): Promise<{ sales: number } | { error: string }> {
	if (!isNetwork(networkIn)) return { error: "Choose your affiliate network." };
	const network = networkIn;
	const id = String(idIn ?? "").trim().slice(0, 100), token = String(tokenIn ?? "").trim().slice(0, 1000), secret = String(secretIn ?? "").trim().slice(0, 500);
	const second = secretOf(network);
	if (!id || !token) return { error: `Paste your ${NETWORKS[network].id} and ${NETWORKS[network].token}.` };
	if (second && !secret) return { error: `${NETWORKS[network].name} needs two keys. Paste your ${second} too.` };
	// The ID is only shown back to the owner for the networks where it's a name of their choosing.
	if (!(network === "sovrn" || network === "partnerstack" ? /^[\w .'&-]+$/ : /^[\w.-]+$/).test(id)) return { error: `That ${NETWORKS[network].id} doesn't look right. Copy it again from ${NETWORKS[network].name}.` };
	if (network === "rakuten") {
		let host = "";
		try {
			host = new URL(token).hostname;
		} catch {
			// Not a link.
		}
		if (!/(^|\.)rakutenmarketing\.com$|(^|\.)linksynergy\.com$/.test(host) || !/[?&]token=/.test(token)) return { error: "Paste the report's API link from Rakuten: it starts with https:// and has token= in it." };
	}
	const have = (await env.DB.prepare("SELECT network FROM affiliate_links WHERE site = ?").bind(site).all<{ network: string }>()).results ?? [];
	if (!have.some((h) => h.network === network) && have.length >= limit) return { error: `Your plan connects up to ${limit} networks for each website. Disconnect one first.` };
	let sales: number;
	try {
		sales = await syncOne(env, site, network, id, token, now, get, secret);
	} catch (e) {
		return { error: e instanceof NetworkError ? e.message : `We couldn't reach ${NETWORKS[network].name}. Try again in a few minutes.` };
	}
	await env.DB.prepare(
		`INSERT INTO affiliate_links (site, network, account, token, connected_at, synced_at, last_error) VALUES (?, ?, ?, ?, ?, ?, NULL)
		 ON CONFLICT (site, network) DO UPDATE SET account = excluded.account, token = excluded.token, synced_at = excluded.synced_at, last_error = NULL`,
	)
		.bind(site, network, id, await seal(env, second ? `${token}\n${secret}` : token), now, now)
		.run();
	return { sales };
}

export async function disconnectNetwork(db: D1Database, site: string, network: unknown): Promise<void> {
	if (!isNetwork(network)) return;
	await db.batch([db.prepare("DELETE FROM affiliate_links WHERE site = ? AND network = ?").bind(site, network), db.prepare("DELETE FROM affiliate_earnings WHERE site = ? AND network = ?").bind(site, network)]);
}

export type NetworkState = { network: Network; account: string; syncedAt: number | null; error: string | null };

export async function networksFor(db: D1Database, site: string): Promise<NetworkState[]> {
	const rows = (await db.prepare("SELECT network, account, synced_at, last_error FROM affiliate_links WHERE site = ? ORDER BY network").bind(site).all<{ network: string; account: string; synced_at: number | null; last_error: string | null }>()).results ?? [];
	return rows.filter((r) => isNetwork(r.network)).map((r) => ({ network: r.network as Network, account: r.account, syncedAt: r.synced_at, error: r.last_error }));
}

/** Every night: read the last 30 days from each connected network. */
export async function syncAffiliates(env: AffEnv, now: number, get: Get = fetch): Promise<void> {
	const links = (await env.DB.prepare("SELECT site, network, account, token FROM affiliate_links").all<{ site: string; network: string; account: string; token: string }>()).results ?? [];
	for (const l of links) {
		if (!isNetwork(l.network)) continue;
		let error: string | null = null;
		try {
			const [token, secret = ""] = (await unseal(env, l.token)).split("\n");
			await syncOne(env, l.site, l.network, l.account, token, now, get, secret);
		} catch (e) {
			error = e instanceof NetworkError ? e.message : `We couldn't reach ${NETWORKS[l.network].name} last night. We'll try again tonight.`;
		}
		await env.DB.prepare(`UPDATE affiliate_links SET ${error ? "last_error = ?" : "synced_at = ?, last_error = NULL"} WHERE site = ? AND network = ?`).bind(error ?? now, l.site, l.network).run();
	}
}

/** Whether links on the website are tagged with the post (src/tracker.ts TAGGER). On unless the owner turned it off. */
export async function taggingOn(db: D1Database, site: string): Promise<boolean> {
	const row = await db.prepare("SELECT tag_links FROM sites WHERE domain = ?").bind(site).first<{ tag_links: number }>().catch(() => null);
	return row?.tag_links !== 0;
}

export async function setTagging(db: D1Database, site: string, on: boolean): Promise<void> {
	await db.prepare("UPDATE sites SET tag_links = ? WHERE domain = ?").bind(on ? 1 : 0, site).run();
}
