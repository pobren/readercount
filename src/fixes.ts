// "What to fix": a short list of posts worth working on this week, each with the reason and what to do.
// Compares the last 28 days with the 28 before, from the site's own visits and (when connected) Google searches.
// Also landing pages most people leave straight away, with the likeliest reason from what readers' browsers saw
// (page speed, scroll depth, problems) and where those readers came from.

import { utcDay } from "./visitor.ts";

export type Fix = {
	kind: "losing" | "slipping" | "page-two" | "few-clicks" | "bounce";
	page: string;
	query?: string;
	/** What happened, in plain English. */
	what: string;
	/** What to do about it. */
	todo: string;
	/** Rough size, for putting the biggest first. */
	weight: number;
};

/** How often Google searchers click a result at each position, roughly. Below half of this is worth a look. */
const USUAL_CLICK_RATE = [0, 0.28, 0.15, 0.1, 0.07, 0.05];

const DAY = 86_400_000;
/** A landing page needs this many visits starting on it before its bounce rate counts. */
export const BOUNCE_MIN_VISITS = 50;
/** High: at least this share leave after one page, and well above the site's own rate. */
const BOUNCE_HIGH = 70;
const BOUNCE_OVER_SITE = 10;
const n = (v: number) => Math.round(v).toLocaleString("en-GB");

export async function findFixes(db: D1Database, site: string, now: number, max = 6): Promise<Fix[]> {
	// Visits: the last 28 full days against the 28 before.
	const to = utcDay(now - DAY), from = utcDay(now - 28 * DAY), prevFrom = utcDay(now - 56 * DAY), prevTo = utcDay(now - 29 * DAY);
	// Google: its figures arrive about three days late, so shift its window back to match.
	const gTo = utcDay(now - 3 * DAY), gFrom = utcDay(now - 30 * DAY), gPrevFrom = utcDay(now - 58 * DAY), gPrevTo = utcDay(now - 31 * DAY);
	const all = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).all<T>().then((r) => r.results ?? []);

	const [visits, pages, queries] = await Promise.all([
		all<{ path: string; now: number; before: number }>(
			`SELECT path, SUM(day >= ?1) AS now, SUM(day <= ?2) AS before FROM (SELECT path, day, visitor FROM events WHERE site = ?3 AND kind = 'view' AND day >= ?4 AND day <= ?5 GROUP BY path, day, visitor) GROUP BY path HAVING before >= 30`,
			from, prevTo, site, prevFrom, to,
		),
		all<{ page: string; imp: number; clicks: number; pos: number; prevImp: number; prevClicks: number; prevPos: number }>(
			`SELECT page,
				SUM(CASE WHEN day >= ?1 THEN impressions END) AS imp, SUM(CASE WHEN day >= ?1 THEN clicks END) AS clicks,
				SUM(CASE WHEN day >= ?1 THEN position * impressions END) / MAX(SUM(CASE WHEN day >= ?1 THEN impressions END), 1) AS pos,
				SUM(CASE WHEN day <= ?2 THEN impressions END) AS prevImp, SUM(CASE WHEN day <= ?2 THEN clicks END) AS prevClicks,
				SUM(CASE WHEN day <= ?2 THEN position * impressions END) / MAX(SUM(CASE WHEN day <= ?2 THEN impressions END), 1) AS prevPos
			FROM search WHERE site = ?3 AND day >= ?4 AND day <= ?5 GROUP BY page`,
			gFrom, gPrevTo, site, gPrevFrom, gTo,
		),
		all<{ query: string; page: string; imp: number; clicks: number; pos: number }>(
			`SELECT query, page, SUM(impressions) AS imp, SUM(clicks) AS clicks, SUM(position * impressions) / MAX(SUM(impressions), 1) AS pos
			FROM search WHERE site = ? AND day >= ? AND day <= ? GROUP BY query, page HAVING imp >= 100 AND pos >= 8 AND pos <= 20 ORDER BY imp DESC LIMIT 20`,
			site, gFrom, gTo,
		),
	]);

	const bounce = await bounceFixes(db, site, from, to);

	const fixes: Fix[] = [];
	const seen = new Set<string>();
	const add = (f: Fix) => {
		if (seen.has(f.page)) return;
		seen.add(f.page);
		fixes.push(f);
	};

	// Pages sliding down Google, which is usually why visitors drop.
	const slipping = pages
		.filter((p) => (p.prevImp ?? 0) >= 50 && p.prevPos > 0 && p.prevPos <= 20 && (p.imp ?? 0) > 0 && p.pos - p.prevPos >= 2)
		.map((p): Fix => ({
			kind: "slipping",
			page: p.page,
			what: `Its average place on Google fell from ${p.prevPos.toFixed(1)} to ${p.pos.toFixed(1)}, so it got ${n(p.clicks ?? 0)} clicks from Google, down from ${n(p.prevClicks ?? 0)}.`,
			todo: "Bring it up to date: check the facts and prices, add anything that has changed, and update the date on the post.",
			weight: (p.prevClicks ?? 0) - (p.clicks ?? 0) + (p.pos - p.prevPos) * 10,
		}));

	// Shown near the top of Google, but rarely clicked: usually the title or description.
	const fewClicks = pages
		.filter((p) => (p.imp ?? 0) >= 200 && p.pos >= 1 && p.pos <= 5.5)
		.flatMap((p): Fix[] => {
			const usual = USUAL_CLICK_RATE[Math.min(5, Math.max(1, Math.round(p.pos)))];
			const rate = (p.clicks ?? 0) / p.imp;
			if (rate >= usual / 2) return [];
			return [{
				kind: "few-clicks",
				page: p.page,
				what: `It sits at ${p.pos.toFixed(1)} on Google and was seen ${n(p.imp)} times, but only ${(rate * 100).toFixed(1)}% of people clicked. At that place, about ${Math.round(usual * 100)}% usually do.`,
				todo: "Rewrite the title and description that show on Google, so they say exactly what the reader gets.",
				weight: Math.round(p.imp * (usual - rate)),
			}];
		});

	// Searches where a page sits on Google's second page: a little more on the topic can lift it.
	const pageTwo = queries.map((q): Fix => ({
		kind: "page-two",
		page: q.page,
		query: q.query,
		what: `It's just off page one of Google (place ${q.pos.toFixed(1)}) for "${q.query}", a search made ${n(q.imp)} times.`,
		todo: `Add a section with "${q.query}" as its heading that answers it directly, and link to the post from your related articles.`,
		weight: Math.round(q.imp / 10),
	}));

	// Pages losing visitors, whether or not Google is connected.
	const losing = visits
		.filter((v) => v.now <= v.before * 0.7)
		.map((v): Fix => ({
			kind: "losing",
			page: v.path,
			what: `Visitors fell ${Math.round(100 - (100 * v.now) / v.before)}%: ${n(v.now)} in the last 4 weeks, down from ${n(v.before)}.`,
			todo: "Check which sources sent fewer readers, then bring the post up to date and share it again.",
			weight: v.before - v.now,
		}));

	for (const list of [slipping, fewClicks, pageTwo, losing, bounce]) list.sort((a, b) => b.weight - a.weight);
	// Take the best of each kind first, so one kind doesn't fill the list, then the rest by size.
	const firsts = [slipping, fewClicks, pageTwo, losing, bounce].flatMap((l) => l.slice(0, 1));
	for (const f of firsts) add(f);
	for (const f of [...slipping, ...fewClicks, ...pageTwo, ...losing, ...bounce].sort((a, b) => b.weight - a.weight)) {
		if (fixes.length >= max) break;
		add(f);
	}
	return fixes.slice(0, max);
}

type Landing = {
	path: string; visits: number; bounces: number; phone: number; phoneB: number; comp: number; compB: number;
	bScroll: number | null; bScrolled: number; bEnd: number; phoneLcp: number | null;
};

/** Landing pages with a high bounce rate (one page, then gone), each with the likeliest reason and what to do. */
export async function bounceFixes(db: D1Database, site: string, from: string, to: string, max = 3): Promise<Fix[]> {
	const all = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).all<T>().then((r) => r.results ?? []);
	// A visit is one reader's day on the website; it lands on the first page they opened.
	const visits = `WITH v AS (SELECT visitor, day, COUNT(*) AS n, MIN(ts) AS t FROM events WHERE site = ?1 AND kind = 'view' AND day >= ?2 AND day <= ?3 GROUP BY visitor, day),
		l AS (SELECT e.path, e.device, e.source, e.scroll, e.lcp, v.n FROM v JOIN events e ON e.site = ?1 AND e.kind = 'view' AND e.visitor = v.visitor AND e.day = v.day AND e.ts = v.t)`;
	const pages = await all<Landing>(
		`${visits} SELECT path, COUNT(*) AS visits, SUM(n = 1) AS bounces,
			SUM(device != 'desktop') AS phone, SUM(device != 'desktop' AND n = 1) AS phoneB, SUM(device = 'desktop') AS comp, SUM(device = 'desktop' AND n = 1) AS compB,
			AVG(CASE WHEN n = 1 THEN scroll END) AS bScroll, SUM(n = 1 AND scroll IS NOT NULL) AS bScrolled, SUM(n = 1 AND scroll >= 90) AS bEnd,
			AVG(CASE WHEN device != 'desktop' THEN lcp END) AS phoneLcp
		 FROM l GROUP BY path HAVING visits >= ?4 ORDER BY visits DESC LIMIT 200`,
		site, from, to, BOUNCE_MIN_VISITS,
	);
	if (!pages.length) return [];
	const total = pages.reduce((a, p) => a + Number(p.visits), 0);
	const siteRate = (100 * pages.reduce((a, p) => a + Number(p.bounces), 0)) / total;
	const rate = (b: number, v: number) => (v ? (100 * b) / v : 0);
	const high = pages.filter((p) => rate(p.bounces, p.visits) >= BOUNCE_HIGH && rate(p.bounces, p.visits) >= siteRate + BOUNCE_OVER_SITE).slice(0, max);
	if (!high.length) return [];
	const marks = high.map((_, i) => `?${i + 4}`).join(",");
	const paths = high.map((p) => p.path);
	const [sources, problems] = await Promise.all([
		all<{ path: string; source: string; visits: number; bounces: number }>(`${visits} SELECT path, source, COUNT(*) AS visits, SUM(n = 1) AS bounces FROM l WHERE path IN (${marks}) GROUP BY path, source HAVING visits >= 20`, site, from, to, ...paths),
		all<{ path: string; n: number }>(`SELECT path, SUM(n) AS n FROM problems WHERE site = ?1 AND day >= ?2 AND day <= ?3 AND path IN (${marks}) GROUP BY path`, site, from, to, ...paths),
	]);
	return high.map((p): Fix => {
		const r = rate(p.bounces, p.visits);
		const what = `${Math.round(r)}% of the ${n(p.visits)} people who landed here left without opening another page, against ${Math.round(siteRate)}% across your site.`;
		const fix = (why: string, todo: string): Fix => ({ kind: "bounce", page: p.path, what: `${what} ${why}`, todo, weight: Math.round((p.bounces * (r - siteRate)) / 100) });
		const phoneRate = rate(p.phoneB, p.phone), compRate = rate(p.compB, p.comp);
		const seen = Number(problems.find((x) => x.path === p.path)?.n ?? 0);
		const worstSource = sources.filter((s) => s.path === p.path).map((s) => ({ ...s, r: rate(s.bounces, s.visits) })).sort((a, b) => b.r - a.r)[0];
		if (p.phoneLcp && p.phoneLcp > 4000 && p.phone >= 20) return fix(`On phones it takes about ${(p.phoneLcp / 1000).toFixed(1)} seconds to show its main content, and many people give up before then.`, "Make the first picture smaller (or load it first), cut scripts and adverts near the top, and check Page Speed again in a week.");
		if (seen >= 5) return fix(`Readers' browsers reported ${n(seen)} problems on it, such as pictures that didn't load or script errors.`, "Open Site Problems, fix what's broken on this page, then watch the bounce rate fall.");
		if (p.phone >= 20 && p.comp >= 20 && phoneRate >= compRate + 20) return fix(`On phones ${Math.round(phoneRate)}% leave, against ${Math.round(compRate)}% on computers.`, "Open it on a phone: check the text is readable without zooming, pop-ups don't cover it, and buttons are easy to tap.");
		if (worstSource && worstSource.r >= r + 15) return fix(`It's worst for readers from ${worstSource.source || "Direct"}: ${Math.round(worstSource.r)}% of them leave.`, `Check what ${worstSource.source || "those links"} promises about this page, and make the opening match it, or point that link at a better page.`);
		if (p.bScroll !== null && p.bScrolled >= 10 && p.bScroll < 30) return fix(`Most who leave don't scroll past the first third of the page.`, "Answer the question in the first few lines, put the best part near the top, and cut a long introduction.");
		if (p.bScrolled >= 10 && p.bEnd / p.bScrolled >= 0.5) return fix("Most who leave read to the end first, so they got what they came for.", "Give them somewhere to go next: link two or three related posts at the end, and add a clear next step.");
		return fix("Nothing on the page looks broken or slow.", "Check the title and opening match what people searched for, and add links to related posts early in the page.");
	});
}
