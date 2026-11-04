// ReaderCount: leaving fake hits out of the stats, without cookies.
// A hit is dropped when it comes from a cloud server (where scripts run, not readers), when one visitor
// sends more than any reader could in a day, when a click arrives without its page view, or when one website
// has had more hits in a day than any real website gets.
// Each dropped hit only adds 1 to a daily count per website, so owners can see how much was left out.

/**
 * Networks (Cloudflare's request.cf.asn) that rent out servers. People don't browse from these, scripts do.
 * Left out on purpose: Cloudflare, Akamai and Fastly (iCloud Private Relay and WARP send real readers
 * through them) and Google's main network (its own proxies and VPN).
 */
export const CLOUD_NETWORKS = new Set([
	16509, 14618, 8987, // Amazon Web Services
	396982, // Google Cloud
	8075, // Microsoft Azure
	14061, // DigitalOcean
	24940, // Hetzner
	16276, // OVHcloud
	63949, // Linode (Akamai Cloud)
	20473, // Vultr
	31898, // Oracle Cloud
	45102, 37963, // Alibaba Cloud
	132203, 45090, // Tencent Cloud
	51167, // Contabo
	12876, // Scaleway
	60781, 28753, // Leaseweb
	46606, // Unified Layer
	36352, // ColoCrossing
	62567, // DigitalOcean (older range)
]);

/** One visitor (the day's hashed address and browser) can send this many hits a day. Offices and phone networks share an address, so it's generous. */
export const VISITOR_DAILY_CAP = 300;

/**
 * One website can store this many hits a day. Far above any website on ReaderCount, it stops a script on
 * home or phone addresses (which get past the other checks) from filling the database for one website.
 */
export const SITE_DAILY_CAP = 200_000;

/** Shown on the stats page once at least this many hits were left out in the period. */
export const FILTERED_NOTE_MIN = 10;

export function fromCloud(asn: unknown): boolean {
	return typeof asn === "number" && CLOUD_NETWORKS.has(asn);
}

/** Adds 1 to today's count of hits left out for this website and reason. */
export async function countFiltered(db: D1Database, site: string, day: string, reason: string, detail: string | null = null): Promise<void> {
	await db
		.prepare("INSERT INTO filtered (site, day, reason, n, detail) VALUES (?, ?, ?, 1, ?) ON CONFLICT (site, day, reason) DO UPDATE SET n = n + 1, detail = COALESCE(excluded.detail, detail)")
		.bind(site, day, reason, detail)
		.run();
}

/** Hits that looked fake in the period ("wrong site" is the owner's code on another website, so it's not counted here). */
export async function filteredBetween(db: D1Database, site: string, from: string, to: string): Promise<number> {
	const row = await db.prepare("SELECT SUM(n) AS n FROM filtered WHERE site = ? AND day >= ? AND day <= ? AND reason != 'wrong site'").bind(site, from, to).first<{ n: number | null }>();
	return row?.n ?? 0;
}

/** Counts a hit towards the website's day, and says whether it's still under SITE_DAILY_CAP. One step, so hits arriving together can't overshoot. */
export async function underSiteCap(db: D1Database, site: string, day: string, cap = SITE_DAILY_CAP): Promise<boolean> {
	const row = await db
		.prepare("INSERT INTO site_hits (site, day, n) VALUES (?, ?, 1) ON CONFLICT (site, day) DO UPDATE SET n = n + 1 RETURNING n")
		.bind(site, day)
		.first<{ n: number }>();
	return (row?.n ?? 0) <= cap;
}

/** A page view this long ago or more has had time to say the reader saw it, so it can be judged. */
export const UNSEEN_AFTER_MS = 30 * 60_000;

/** One visit that looked like a robot running the script: shown so the owner can check them. */
export type UnseenVisit = { ts: number; path: string; country: string; device: string; browser: string; os: string; source: string };

/**
 * Watch only: visits that never had the page on screen for a second. Robots that run the script (search engine
 * checkers, scrapers, headless browsers on home addresses) load one page and send nothing more: no time on page,
 * no scroll, no click. A real reader who opens a second page, stays a second or clicks anything is never one of these.
 * Nothing is taken out of the numbers yet: the stats page only shows how many would be, so the owner can check first.
 */
export async function unseenBetween(db: D1Database, site: string, from: string, to: string, now: number, limit = 50): Promise<{ visitors: number; latest: UnseenVisit[] }> {
	const base = `FROM events e WHERE e.site = ? AND e.kind = 'view' AND e.day >= ? AND e.day <= ? AND e.ts <= ? AND COALESCE(e.duration, 0) < 1
		AND NOT EXISTS (SELECT 1 FROM events o WHERE o.site = e.site AND o.day = e.day AND o.visitor = e.visitor AND o.id != e.id)`;
	const args = [site, from, to, now - UNSEEN_AFTER_MS];
	const [count, rows] = await Promise.all([
		db.prepare(`SELECT COUNT(*) AS n ${base}`).bind(...args).first<{ n: number }>(),
		db
			.prepare(`SELECT e.ts AS ts, e.path AS path, COALESCE(e.country, '') AS country, COALESCE(e.device, '') AS device, COALESCE(e.browser, '') AS browser, COALESCE(e.os, '') AS os, COALESCE(NULLIF(e.source, ''), 'Direct') AS source ${base} ORDER BY e.ts DESC LIMIT ?`)
			.bind(...args, limit)
			.all<UnseenVisit>(),
	]);
	return { visitors: Number(count?.n ?? 0), latest: rows.results ?? [] };
}
