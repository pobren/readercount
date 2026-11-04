// Earnings insights: the owner's affiliate earnings (uploaded reports and connected networks, src/earnings.ts and
// src/affiliates.ts) laid over the stats. Every click is already tied to the page, source, country and device it came
// from, so each sale's money can be followed back the same way: a sale the network ties to a post goes to that post's
// clicks to that shop; any other sale is shared across that day's clicks to the shop. From that come earnings by
// source, by Google search, by shop (clicks against sales), by device, the posts worth updating, and alerts when
// earnings fall or a shop stops paying while readers still click. Nothing here is stored; it's worked out when asked.

import { linkSite } from "./dashboard.ts";
import { alertSiteOwner } from "./health.ts";
import { sameShop, type EarningRow } from "./earnings.ts";
import { ADSENSE_SHOP } from "./adsense.ts";
import { utcDay } from "./visitor.ts";

type Click = { day: string; path: string; target: string; source: string; country: string; device: string; n: number };
/** One share of a sale's money and the clicks that earned it. */
type Share = { path: string; source: string; country: string; device: string; shop: string; pence: number };

export type MoneyRow = { name: string; pence: number; clicks?: number; visitors?: number };
export type WrongCountry = { store: string; country: string; clicks: number; elsewhere: number; top: string };
export type WorthUpdating = { path: string; monthly: number; why: string };
export type MoneyReport = {
	total: number;
	sources: MoneyRow[];
	searches: (MoneyRow & { page: string })[];
	shops: MoneyRow[];
	devices: MoneyRow[];
	update: WorthUpdating[];
	wrongCountry: WrongCountry[];
	/** Shops readers still click that haven't paid for 14 days, when they used to. */
	stopped: { shop: string; clicks: number; before: number }[];
};

const DAY = 86_400_000;

async function clicksBetween(db: D1Database, site: string, from: string, to: string): Promise<Click[]> {
	const rows = (await db
		.prepare(
			`SELECT c.day AS day, c.path AS path, c.target AS target, COALESCE(NULLIF(v.source, ''), 'Direct') AS source, COALESCE(c.country, '') AS country, COALESCE(c.device, '') AS device, COUNT(*) AS n
			 FROM events c LEFT JOIN events v ON v.view_id = c.view_id AND v.site = c.site AND v.kind = 'view'
			 WHERE c.site = ? AND c.kind = 'outbound' AND c.day >= ? AND c.day <= ? GROUP BY 1, 2, 3, 4, 5, 6`,
		)
		.bind(site, from, to)
		.all<Click>()).results ?? [];
	return rows.map((r) => ({ ...r, n: Number(r.n) }));
}

/** Page views with where they came from, only needed when there's ad money to share. */
async function viewsBetween(db: D1Database, site: string, from: string, to: string, sales: { shop: string; page: string }[]): Promise<Click[]> {
	if (!sales.some((s) => s.shop === ADSENSE_SHOP && !s.page)) return [];
	const rows = (await db
		.prepare("SELECT day, path, '' AS target, COALESCE(NULLIF(source, ''), 'Direct') AS source, COALESCE(country, '') AS country, COALESCE(device, '') AS device, COUNT(*) AS n FROM events WHERE site = ? AND kind = 'view' AND day >= ? AND day <= ? GROUP BY 1, 2, 4, 5, 6")
		.bind(site, from, to)
		.all<Click>()).results ?? [];
	return rows.map((r) => ({ ...r, n: Number(r.n) }));
}

async function salesBetween(db: D1Database, site: string, from: string, to: string): Promise<(EarningRow & { page: string })[]> {
	const [up, net] = await Promise.all([
		db.prepare("SELECT day, shop, pence FROM earnings WHERE site = ? AND day >= ? AND day <= ?").bind(site, from, to).all<EarningRow>(),
		db.prepare("SELECT day, shop, page, pence FROM affiliate_earnings WHERE site = ? AND day >= ? AND day <= ?").bind(site, from, to).all<EarningRow & { page: string }>().catch(() => ({ results: [] as (EarningRow & { page: string })[] })),
	]);
	return [...(up.results ?? []).map((r) => ({ ...r, page: "" })), ...(net.results ?? [])].map((r) => ({ ...r, pence: Number(r.pence) }));
}

/** Follows each sale's money back to the clicks that earned it. */
export function shareOut(sales: (EarningRow & { page: string })[], clicks: Click[], views: Click[] = []): Share[] {
	const out: Share[] = [];
	// Ad money (src/adsense.ts) is earned by being seen: shared by that day's page views, not by clicks to a shop.
	for (const s of sales.filter((x) => x.shop === ADSENSE_SHOP && !x.page)) {
		const pool = views.filter((v) => v.day === s.day);
		const total = pool.reduce((a, v) => a + v.n, 0);
		for (const v of pool) out.push({ path: v.path, source: v.source, country: v.country, device: v.device, shop: s.shop, pence: (s.pence * v.n) / total });
	}
	sales = sales.filter((x) => !(x.shop === ADSENSE_SHOP && !x.page));
	const byShop = new Map<string, (Click & { shop: string })[]>();
	const withShop = clicks.map((c) => ({ ...c, shop: linkSite(c.target).key }));
	for (const s of sales) {
		const key = s.shop.toLowerCase();
		if (!byShop.has(key)) byShop.set(key, withShop.filter((c) => sameShop(s.shop, { key: c.shop, name: c.shop })));
		const mine = byShop.get(key)!;
		let pool: typeof mine;
		if (s.page) {
			// The network said which post: that post's clicks to the shop, or any of its clicks, or the post alone.
			const onPage = withShop.filter((c) => c.path === s.page);
			pool = mine.filter((c) => c.path === s.page);
			if (!pool.length) pool = onPage;
			if (!pool.length) {
				out.push({ path: s.page, source: "", country: "", device: "", shop: s.shop, pence: s.pence });
				continue;
			}
		} else pool = mine.some((c) => c.day === s.day) ? mine.filter((c) => c.day === s.day) : mine;
		const total = pool.reduce((a, c) => a + c.n, 0);
		if (!total) continue;
		for (const c of pool) out.push({ path: c.path, source: c.source, country: c.country, device: c.device, shop: s.shop, pence: (s.pence * c.n) / total });
	}
	return out;
}

function sum<K extends keyof Share>(shares: Share[], key: K): Map<string, number> {
	const m = new Map<string, number>();
	for (const s of shares) m.set(String(s[key]), (m.get(String(s[key])) ?? 0) + s.pence);
	return m;
}

/** Amazon stores and the country whose readers they pay for. */
const AMAZON: [RegExp, string][] = [
	[/^amazon\.com$/, "US"], [/^amazon\.co\.uk$/, "GB"], [/^amazon\.de$/, "DE"], [/^amazon\.fr$/, "FR"], [/^amazon\.it$/, "IT"], [/^amazon\.es$/, "ES"],
	[/^amazon\.ca$/, "CA"], [/^amazon\.com\.au$/, "AU"], [/^amazon\.co\.jp$/, "JP"], [/^amazon\.in$/, "IN"], [/^amazon\.nl$/, "NL"], [/^amazon\.se$/, "SE"],
	[/^amazon\.pl$/, "PL"], [/^amazon\.com\.br$/, "BR"], [/^amazon\.com\.mx$/, "MX"], [/^amazon\.ie$/, "IE"],
];
/** A wrong-country store is flagged once it has this many clicks and this share of them from elsewhere. */
const WRONG_MIN = 20;
const WRONG_SHARE = 0.4;

export function wrongCountry(clicks: Click[]): WrongCountry[] {
	const stores = new Map<string, { country: string; clicks: number; elsewhere: Map<string, number> }>();
	for (const c of clicks) {
		let host = "";
		try {
			host = new URL(c.target).hostname.replace(/^www\./, "").toLowerCase();
		} catch {
			continue;
		}
		const hit = AMAZON.find(([re]) => re.test(host));
		if (!hit || !c.country) continue;
		const s = stores.get(host) ?? { country: hit[1], clicks: 0, elsewhere: new Map() };
		s.clicks += c.n;
		if (c.country !== hit[1]) s.elsewhere.set(c.country, (s.elsewhere.get(c.country) ?? 0) + c.n);
		stores.set(host, s);
	}
	return [...stores]
		.map(([store, s]) => {
			const elsewhere = [...s.elsewhere.values()].reduce((a, b) => a + b, 0);
			const top = [...s.elsewhere].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
			return { store, country: s.country, clicks: s.clicks, elsewhere, top };
		})
		.filter((s) => s.clicks >= WRONG_MIN && s.elsewhere >= s.clicks * WRONG_SHARE)
		.sort((a, b) => b.elsewhere - a.elsewhere);
}

/** The money report for the stats page, between two days. */
export async function moneyReport(db: D1Database, site: string, from: string, to: string, now: number): Promise<MoneyReport | null> {
	const sales = await salesBetween(db, site, from, to);
	if (!sales.length) return null;
	const clicks = await clicksBetween(db, site, from, to);
	const shares = shareOut(sales, clicks, await viewsBetween(db, site, from, to, sales));
	const total = Math.round(sales.reduce((a, s) => a + s.pence, 0));

	// By source, with readers from each so the figure per 1,000 readers is fair.
	const readers = new Map(((await db.prepare("SELECT COALESCE(NULLIF(source, ''), 'Direct') AS name, COUNT(DISTINCT day || visitor) AS n FROM events WHERE site = ? AND kind = 'view' AND day >= ? AND day <= ? GROUP BY 1").bind(site, from, to).all<{ name: string; n: number }>()).results ?? []).map((r) => [r.name, Number(r.n)]));
	const sources = [...sum(shares.filter((s) => s.source), "source")].map(([name, pence]) => ({ name, pence: Math.round(pence), visitors: readers.get(name) ?? 0 })).filter((r) => r.pence > 0).sort((a, b) => b.pence - a.pence);

	// Google searches: each post's Google money, shared by the clicks each search brought it.
	const google = new Map<string, number>();
	for (const s of shares) if (s.source === "Google") google.set(s.path, (google.get(s.path) ?? 0) + s.pence);
	const searches: MoneyReport["searches"] = [];
	if (google.size) {
		const q = (await db.prepare("SELECT query, page, SUM(clicks) AS clicks FROM search WHERE site = ? AND day >= ? AND day <= ? AND clicks > 0 GROUP BY query, page").bind(site, from, to).all<{ query: string; page: string; clicks: number }>().catch(() => ({ results: [] as { query: string; page: string; clicks: number }[] }))).results ?? [];
		for (const [page, pence] of google) {
			const mine = q.filter((r) => r.page === page);
			const all = mine.reduce((a, r) => a + Number(r.clicks), 0);
			for (const r of mine) searches.push({ name: r.query, page, pence: Math.round((pence * Number(r.clicks)) / all), clicks: Number(r.clicks) });
		}
		searches.sort((a, b) => b.pence - a.pence);
	}

	// Shops: clicks against earnings.
	const shopClicks = new Map<string, number>();
	for (const c of clicks) {
		const shop = linkSite(c.target);
		if (shop.affiliate) shopClicks.set(shop.name, (shopClicks.get(shop.name) ?? 0) + c.n);
	}
	const shopMoney = new Map<string, number>();
	for (const s of sales) {
		const name = [...shopClicks.keys()].find((k) => sameShop(s.shop, { key: k, name: k })) ?? s.shop;
		shopMoney.set(name, (shopMoney.get(name) ?? 0) + s.pence);
	}
	const shops = [...new Set([...shopClicks.keys(), ...shopMoney.keys()])].map((name) => ({ name, pence: Math.round(shopMoney.get(name) ?? 0), clicks: shopClicks.get(name) ?? 0 })).sort((a, b) => b.pence - a.pence || b.clicks - a.clicks);

	const devClicks = new Map<string, number>();
	for (const c of clicks) if (c.device) devClicks.set(c.device, (devClicks.get(c.device) ?? 0) + c.n);
	const devices = [...sum(shares.filter((s) => s.device), "device")].map(([name, pence]) => ({ name, pence: Math.round(pence), clicks: devClicks.get(name) ?? 0 })).sort((a, b) => b.pence - a.pence);

	const [update, stopped] = await Promise.all([worthUpdating(db, site, now), stoppedPaying(db, site, now)]);
	return { total, sources, searches: searches.slice(0, 50), shops, devices, update, wrongCountry: wrongCountry(clicks), stopped };
}

/** Pages a post's money comes through, last 28 days, from sales the network tied to it or its share of the rest. */
async function pageMoney(db: D1Database, site: string, from: string, to: string): Promise<Map<string, number>> {
	const sales = await salesBetween(db, site, from, to);
	if (!sales.length) return new Map();
	return sum(shareOut(sales, await clicksBetween(db, site, from, to), await viewsBetween(db, site, from, to, sales)), "path");
}

/** Posts that earn well but are slipping: a worse Google position or fewer readers than the four weeks before. */
export async function worthUpdating(db: D1Database, site: string, now: number): Promise<WorthUpdating[]> {
	const end = utcDay(now), start = utcDay(now - 27 * DAY), before = utcDay(now - 55 * DAY), beforeEnd = utcDay(now - 28 * DAY);
	const money = await pageMoney(db, site, start, end);
	const top = [...money].filter(([, p]) => p >= 500).sort((a, b) => b[1] - a[1]).slice(0, 30);
	if (!top.length) return [];
	const pos = async (a: string, b: string) => new Map(((await db.prepare("SELECT page, SUM(position * impressions) / SUM(impressions) AS pos, SUM(impressions) AS seen FROM search WHERE site = ? AND day >= ? AND day <= ? GROUP BY page").bind(site, a, b).all<{ page: string; pos: number; seen: number }>().catch(() => ({ results: [] as { page: string; pos: number; seen: number }[] }))).results ?? []).filter((r) => Number(r.seen) >= 50).map((r) => [r.page, Number(r.pos)]));
	const views = async (a: string, b: string) => new Map(((await db.prepare("SELECT path, COUNT(DISTINCT day || visitor) AS n FROM events WHERE site = ? AND kind = 'view' AND day >= ? AND day <= ? GROUP BY path").bind(site, a, b).all<{ path: string; n: number }>()).results ?? []).map((r) => [r.path, Number(r.n)]));
	const [posNow, posThen, readNow, readThen] = await Promise.all([pos(start, end), pos(before, beforeEnd), views(start, end), views(before, beforeEnd)]);
	const out: WorthUpdating[] = [];
	for (const [path, pence] of top) {
		const a = posNow.get(path), b = posThen.get(path), r1 = readNow.get(path) ?? 0, r0 = readThen.get(path) ?? 0;
		let why = "";
		if (a !== undefined && b !== undefined && a - b >= 2) why = `Slipped from ${ordinal(b)} to ${ordinal(a)} on Google.`;
		else if (r0 >= 50 && r1 <= r0 * 0.75) why = `Readers down ${Math.round(100 - (100 * r1) / r0)}% on the four weeks before.`;
		if (why) out.push({ path, monthly: Math.round((pence * 30) / 28), why });
	}
	return out.sort((x, y) => y.monthly - x.monthly);
}

const ordinal = (pos: number) => {
	const n = Math.max(1, Math.round(pos));
	const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
	return `${n}${s}`;
};

/** A shop that paid in the 60 days before but nothing in the last 14, while readers still clicked through to it. */
const QUIET_DAYS = 14;
const QUIET_MIN_CLICKS = 30;
export async function stoppedPaying(db: D1Database, site: string, now: number): Promise<{ shop: string; clicks: number; before: number }[]> {
	const end = utcDay(now), quiet = utcDay(now - (QUIET_DAYS - 1) * DAY), start = utcDay(now - 74 * DAY);
	const sales = await salesBetween(db, site, start, end);
	if (!sales.length) return [];
	const recent = sales.filter((s) => s.day >= quiet), older = sales.filter((s) => s.day < quiet);
	const clicks = await clicksBetween(db, site, quiet, end);
	const out: { shop: string; clicks: number; before: number }[] = [];
	const shops = new Map<string, number>();
	for (const s of older) shops.set(s.shop, (shops.get(s.shop) ?? 0) + s.pence);
	for (const [shop, before] of shops) {
		if (before <= 0 || recent.some((r) => sameShop(r.shop, { key: shop, name: shop }) || r.shop === shop)) continue;
		const n = clicks.filter((c) => sameShop(shop, { key: linkSite(c.target).key, name: linkSite(c.target).name })).reduce((a, c) => a + c.n, 0);
		if (n >= QUIET_MIN_CLICKS) out.push({ shop, clicks: n, before: Math.round(before) });
	}
	return out.sort((a, b) => b.before - a.before);
}

/** This week's earnings against the weekly average of the four weeks before. */
export async function weekOnWeek(db: D1Database, site: string, now: number): Promise<{ week: number; usual: number } | null> {
	const sales = await salesBetween(db, site, utcDay(now - 35 * DAY), utcDay(now - DAY));
	if (!sales.length) return null;
	const cut = utcDay(now - 7 * DAY);
	const week = sales.filter((s) => s.day >= cut).reduce((a, s) => a + s.pence, 0);
	const usual = sales.filter((s) => s.day < cut).reduce((a, s) => a + s.pence, 0) / 4;
	return { week: Math.round(week), usual: Math.round(usual) };
}

/** Earnings fall by this much (and were worth at least MIN_WEEKLY a week) before we say so. */
export const DROP = 0.4;
const MIN_WEEKLY = 500;

/** The Site Health items and alert texts for money: a sharp fall, and shops that stopped paying while readers click. */
export async function moneyProblems(db: D1Database, site: string, now: number): Promise<{ kind: "drop" | "stopped"; title: string; detail: string }[]> {
	const out: { kind: "drop" | "stopped"; title: string; detail: string }[] = [];
	const w = await weekOnWeek(db, site, now);
	if (w && w.usual >= MIN_WEEKLY && w.week <= w.usual * (1 - DROP)) out.push({ kind: "drop", title: "Affiliate earnings are down sharply", detail: `${gbp(w.week)} in the last 7 days, against about ${gbp(w.usual)} a week before, down ${Math.round(100 - (100 * w.week) / w.usual)}%. Earnings Insights shows which shops and posts fell.` });
	for (const s of (await stoppedPaying(db, site, now)).slice(0, 3)) out.push({ kind: "stopped", title: `${s.shop} hasn't paid for ${QUIET_DAYS} days`, detail: `Readers clicked through to ${s.shop} ${s.clicks.toLocaleString("en-GB")} times in that time, but no sales came back, when it paid ${gbp(s.before)} in the two months before. Check your links still carry your tracking ID, and that the programme is still running.` });
	return out;
}

export const gbp = (pence: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: pence >= 10_000 ? 0 : 2 }).format(pence / 100);

/** Each money problem is emailed at most once a week for a website. */
const ALERT_EVERY = 7 * DAY;

/** Every night, after the networks are read: email owners whose earnings fell sharply or whose shop stopped paying. */
export async function moneyAlerts(env: Parameters<typeof alertSiteOwner>[0], now: number): Promise<number> {
	const sites = ((await env.DB.prepare("SELECT DISTINCT site FROM affiliate_earnings UNION SELECT DISTINCT site FROM earnings").all<{ site: string }>().catch(() => ({ results: [] as { site: string }[] }))).results ?? []).map((r) => r.site);
	let sent = 0;
	for (const site of sites) {
		const problems = await moneyProblems(env.DB, site, now);
		for (const kind of ["drop", "stopped"] as const) {
			const mine = problems.filter((p) => p.kind === kind);
			if (!mine.length) continue;
			const last = await env.DB.prepare("SELECT sent_at FROM money_alerts WHERE site = ? AND kind = ?").bind(site, kind).first<{ sent_at: number }>();
			if (last && now - last.sent_at < ALERT_EVERY) continue;
			const subject = kind === "drop" ? `${site}: affiliate earnings are down` : `${site}: ${mine.length === 1 ? mine[0].title : "some shops have stopped paying"}`;
			const text = `${mine.map((p) => `${p.title}\n${p.detail}`).join("\n\n")}\n\nEarnings Insights: https://${(env as { APP_HOST?: string }).APP_HOST}/?site=${encodeURIComponent(site)}&range=30d#card-te\n\nWe send this at most once a week.\n\nReaderCount`;
			if (await alertSiteOwner(env, site, "earnings", subject, text, now)) {
				sent++;
				await env.DB.prepare("INSERT INTO money_alerts (site, kind, sent_at) VALUES (?, ?, ?) ON CONFLICT (site, kind) DO UPDATE SET sent_at = excluded.sent_at").bind(site, kind, now).run();
			}
		}
	}
	return sent;
}
