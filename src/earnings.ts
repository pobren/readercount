// Earnings per post: the owner uploads the CSV report from Amazon Associates, Awin or any affiliate
// network (a date, an amount and, if it has one, the shop). Each day's earnings for a shop are shared
// across the site's pages by how many clicks each page sent to that shop, so the stats page can show
// estimated earnings per post. Nothing here is exact: networks don't say which page a sale came from.

import { linkSite } from "./dashboard.ts";
import { utcDay } from "./visitor.ts";
import { ADSENSE_SHOP } from "./adsense.ts";

export const MAX_EARNINGS_BYTES = 2_000_000;

export type EarningRow = { day: string; shop: string; pence: number };

/** Splits one CSV line, allowing "quoted, fields". */
export function cells(line: string, sep: string): string[] {
	const out: string[] = [];
	let cur = "", q = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (q) {
			if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
			else if (c === '"') q = false;
			else cur += c;
		} else if (c === '"') q = true;
		else if (c === sep) out.push(cur.trim()), (cur = "");
		else cur += c;
	}
	out.push(cur.trim());
	return out;
}

const find = (head: string[], words: RegExp) => head.findIndex((h) => words.test(h));

/** "2026-10-19", "19/10/2026" (UK order), "Oct 19, 2026" or "19 Oct 2026" as a day. */
export function readDay(value: string): string | null {
	const v = value.trim().replace(/T.*$/, "").replace(/\s+\d{1,2}:\d{2}(:\d{2})?$/, "");
	let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
	if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
	m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
	if (m) return Number(m[2]) <= 12 ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
	const t = Date.parse(v + " UTC");
	return Number.isFinite(t) && /[a-z]/i.test(v) ? utcDay(t) : null;
}

/** "£1,234.56", "-0.40", "12,50 €" as pence. */
export function readPence(value: string): number | null {
	let v = value.replace(/[^\d.,-]/g, "");
	if (/,\d{2}$/.test(v) && !/\.\d/.test(v)) v = v.replace(/\./g, "").replace(",", ".");
	v = v.replace(/,/g, "");
	const n = Number(v);
	return v && Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Reads an affiliate report. shop is used when the file has no shop column (Amazon's own reports, say). */
export function parseEarnings(text: string, shopIn = ""): { rows: EarningRow[]; skipped: number } | { error: string } {
	const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
	// Some networks put a title line or two above the real header: use the first line that names an amount.
	const amountWords = /commission|earning|amount|revenue|fees|payout|bounty|income/i;
	let headAt = lines.findIndex((l) => amountWords.test(l) && /date|day|time/i.test(l) && /[,;\t]/.test(l));
	if (headAt < 0) headAt = lines.findIndex((l) => amountWords.test(l));
	if (headAt < 0) return { error: "We couldn't find an earnings column. The file needs a column called Commission, Earnings, Amount or similar." };
	const sep = (lines[headAt].match(/;/g)?.length ?? 0) > (lines[headAt].match(/,/g)?.length ?? 0) ? ";" : lines[headAt].includes("\t") ? "\t" : ",";
	const head = cells(lines[headAt], sep).map((h) => h.toLowerCase());
	const dateCol = find(head, /date|day|time/);
	const amountCol = find(head, /commission|earning|revenue|ad fees|payout|bounty|income|amount/);
	const shopCol = find(head, /merchant|advertiser|shop|store|programme|program|brand|retailer|partner/);
	if (dateCol < 0) return { error: "We couldn't find a date column. The file needs a column called Date or similar." };
	const fixedShop = shopIn.trim().slice(0, 80);
	if (shopCol < 0 && !fixedShop) return { error: "This file doesn't say which shop each sale came from. Type the shop's name (for example Amazon) in the box and try again." };
	const sum = new Map<string, EarningRow>();
	let skipped = 0;
	for (const line of lines.slice(headAt + 1)) {
		const c = cells(line, sep);
		const day = readDay(c[dateCol] ?? "");
		const pence = readPence(c[amountCol] ?? "");
		const shop = (shopCol >= 0 ? c[shopCol] : "") || fixedShop;
		if (!day || pence === null || !shop) {
			skipped++;
			continue;
		}
		const key = `${day}|${shop.toLowerCase()}`;
		const row = sum.get(key) ?? { day, shop: shop.slice(0, 80), pence: 0 };
		row.pence += pence;
		sum.set(key, row);
	}
	if (!sum.size) return { error: "We couldn't read any earnings from that file. Check it has a date and an amount on each line." };
	return { rows: [...sum.values()], skipped };
}

export async function saveEarnings(db: D1Database, site: string, rows: EarningRow[]): Promise<void> {
	for (let i = 0; i < rows.length; i += 50) {
		await db.batch(
			rows.slice(i, i + 50).map((r) =>
				db.prepare("INSERT INTO earnings (site, day, shop, pence) VALUES (?, ?, ?, ?) ON CONFLICT (site, day, shop) DO UPDATE SET pence = excluded.pence").bind(site, r.day, r.shop, r.pence),
			),
		);
	}
}

export async function forgetEarnings(db: D1Database, site: string): Promise<void> {
	await db.prepare("DELETE FROM earnings WHERE site = ?").bind(site).run();
}

/** What's been uploaded (not what connected networks sent). */
export async function earningsSummary(db: D1Database, site: string): Promise<{ pence: number; first: string; last: string; shops: number } | null> {
	const r = await db.prepare("SELECT SUM(pence) AS pence, MIN(day) AS first, MAX(day) AS last, COUNT(DISTINCT lower(shop)) AS shops FROM earnings WHERE site = ?").bind(site).first<{ pence: number | null; first: string; last: string; shops: number }>();
	return r?.pence == null ? null : { pence: Number(r.pence), first: r.first, last: r.last, shops: Number(r.shops) };
}

/** "Amazon UK" and amazon.co.uk both become "amazon". */
const norm = (s: string) => s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\.(co\.uk|com|co|uk|net|org|de|fr|io)(\/.*)?$/, "").replace(/[^a-z0-9]/g, "");

export function sameShop(shop: string, site: { key: string; name: string }): boolean {
	const a = norm(shop), b = norm(site.key), c = norm(site.name);
	if (!a) return false;
	return [b, c].some((x) => x.length >= 3 && (a.includes(x) || x.includes(a)));
}

/** Estimated earnings per page between two days, biggest first. */
export async function earningsByPage(db: D1Database, site: string, from: string, to: string): Promise<{ path: string; pence: number }[]> {
	const uploaded = (await db.prepare("SELECT day, shop, pence FROM earnings WHERE site = ? AND day >= ? AND day <= ?").bind(site, from, to).all<EarningRow>()).results ?? [];
	// From connected networks (src/affiliates.ts): sales tied to a page count for it exactly, the rest are shared like an upload.
	const fetched = (await db.prepare("SELECT day, shop, page, pence FROM affiliate_earnings WHERE site = ? AND day >= ? AND day <= ?").bind(site, from, to).all<EarningRow & { page: string }>().catch(() => ({ results: [] as (EarningRow & { page: string })[] }))).results ?? [];
	const ads = fetched.filter((f) => !f.page && f.shop === ADSENSE_SHOP);
	const earned = [...uploaded, ...fetched.filter((f) => !f.page && f.shop !== ADSENSE_SHOP)];
	const out = new Map<string, number>();
	for (const f of fetched) if (f.page) out.set(f.page, (out.get(f.page) ?? 0) + f.pence);
	// Ad money (src/adsense.ts) is earned by being seen, so it's shared by each page's views that day.
	if (ads.length) {
		const views = (await db.prepare("SELECT day, path, COUNT(*) AS n FROM events WHERE site = ? AND kind = 'view' AND day >= ? AND day <= ? GROUP BY day, path").bind(site, from, to).all<{ day: string; path: string; n: number }>()).results ?? [];
		for (const a of ads) {
			const pool = views.filter((v) => v.day === a.day);
			const total = pool.reduce((x, v) => x + Number(v.n), 0);
			for (const v of pool) out.set(v.path, (out.get(v.path) ?? 0) + (a.pence * Number(v.n)) / total);
		}
	}
	if (!earned.length) return [...out].map(([path, pence]) => ({ path, pence: Math.round(pence) })).filter((x) => x.pence !== 0).sort((a, b) => b.pence - a.pence);
	const clicks = (await db
		.prepare("SELECT day, path, target, COUNT(*) AS n FROM events WHERE site = ? AND kind = 'outbound' AND day >= ? AND day <= ? GROUP BY day, path, target")
		.bind(site, from, to)
		.all<{ day: string; path: string; target: string; n: number }>()).results ?? [];
	const withShop = clicks.map((c) => ({ ...c, n: Number(c.n), shop: linkSite(c.target) }));
	for (const e of earned) {
		const mine = withShop.filter((c) => sameShop(e.shop, c.shop));
		// That day's clicks to the shop if there were any, otherwise all its clicks in the period.
		const pool = mine.some((c) => c.day === e.day) ? mine.filter((c) => c.day === e.day) : mine;
		const total = pool.reduce((a, c) => a + c.n, 0);
		if (!total) continue;
		for (const c of pool) out.set(c.path, (out.get(c.path) ?? 0) + (e.pence * c.n) / total);
	}
	return [...out].map(([path, pence]) => ({ path, pence: Math.round(pence) })).filter((x) => x.pence !== 0).sort((a, b) => b.pence - a.pence);
}
