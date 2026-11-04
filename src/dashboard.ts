// ReaderCount: the private stats page. Server-rendered HTML, no scripts, works on a phone.

import type { MoneyReport } from "./money.ts";
import { APP_HEAD } from "./pwa.ts";
import { activeViews } from "./active.ts";
import { consoleUrl, type GoogleState, type SearchReport } from "./google.ts";
import { utcDay } from "./visitor.ts";
import type { Fix } from "./fixes.ts";
import { pageUrl, type HealthItem } from "./health.ts";
import type { BrokenLink } from "./links.ts";
import { historyBetween, MAX_NOTE, type Note } from "./history.ts";
import { CHANGES_URL, NEWS } from "./news.ts";
import { HOME_URL, REPO_URL } from "./host.ts";
import { filteredBetween, FILTERED_NOTE_MIN, unseenBetween, type UnseenVisit } from "./filter.ts";
import { foundByAi, type FoundByAi } from "./ai.ts";
import { BTN_ICONS } from "./btn-icons.ts";
import type { Behaviour, Rating, SpeedRow } from "./behaviour.ts";

export const RANGES = { today: 1, "7d": 7, "30d": 30, "12m": 365 } as const;
export type Range = keyof typeof RANGES;
const RANGE_LABELS: Record<Range, string> = { today: "Today", "7d": "7 days", "30d": "30 days", "12m": "12 months" };
const PERIOD_LABELS: Record<Range, string> = { today: "1-day", "7d": "7-day", "30d": "30-day", "12m": "12-month" };

type Row = Record<string, string | number | null>;

/** One day on the chart. secs, bounce and clicks are missing on days brought in from older stats. */
export type Day = { day: string; views: number; visitors: number; secs?: number; bounce?: number; clicks?: number; imported?: boolean; hour?: number };

/** Narrowing the whole page to one source, page, country, device, browser or campaign (?source=Google and so on). */
export const FILTER_KEYS = ["source", "page", "country", "device", "browser", "campaign"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type Filters = Partial<Record<FilterKey, string>>;

/** What the chart shows: the stat tile picked above it. */
export const METRICS = ["visitors", "views", "time", "bounce", "clicks"] as const;
export type Metric = (typeof METRICS)[number];

/** The filters and chart choice from the stats page address. */
export function readView(url: URL): { filters: Filters; metric: Metric } {
	const filters: Filters = {};
	for (const k of FILTER_KEYS) {
		const v = url.searchParams.get(k);
		if (v) filters[k] = v.slice(0, 300);
	}
	const m = url.searchParams.get("metric") ?? "";
	return { filters, metric: (METRICS as readonly string[]).includes(m) ? (m as Metric) : "visitors" };
}

export type Report = {
	site: string;
	range: Range;
	from: string;
	to: string;
	totals: { views: number; visitors: number; avgSeconds: number; bounce: number; now: number; clicks?: number };
	previous: { views: number; visitors: number; clicks?: number };
	/** imported: from the owner's older stats (src/history.ts), for days before ReaderCount started counting. */
	days: Day[];
	/** The same number of days just before, for the dashed "previous period" line. */
	prevDays?: Day[];
	/** Today only: one point per hour so far (UTC), and the same hours yesterday. */
	hours?: Day[];
	prevHours?: Day[];
	/** pages rows may carry clicks: link clicks and downloads from that page. */
	pages: Row[];
	/** The first and last page of each visit. */
	entries?: Row[];
	exits?: Row[];
	sources: Row[];
	campaigns: Row[];
	countries: Row[];
	devices: Row[];
	browsers: Row[];
	clicks: Row[];
	/** Goals (src/tracker.ts): name, completions and visitors who completed it; and which sources and pages they came from. */
	goals?: Row[];
	goalSources?: Row[];
	goalPages?: Row[];
	/** Missing page report: "not found" pages, how often, and the most common place visitors came from. */
	missing?: Row[];
	/** Earnings per post, in pence, estimated from the owner's affiliate reports (src/earnings.ts). */
	earnings?: { path: string; pence: number }[];
	/** Earnings laid over the stats: by source, Google search, shop and device, posts worth updating, wrong-country links (src/money.ts). Private pages only. */
	money?: MoneyReport | null;
	/** Scroll depth, page speed, problems readers ran into and form drop-off (src/behaviour.ts). Private pages only. */
	behaviour?: Behaviour;
	/** Broken link alerts: outbound links that failed the nightly check (src/links.ts). */
	broken?: BrokenLink[];
	filters?: Filters;
	/** Hits left out of these numbers because they looked fake (src/filter.ts). */
	filtered?: number;
	/** Watch only: visits that never had the page on screen, probably robots, not yet taken out of the numbers (src/filter.ts). */
	unseen?: { visitors: number; latest: UnseenVisit[] };
	/** Found by AI: visits from ChatGPT, Perplexity and other AI services (src/ai.ts). */
	ai?: FoundByAi;
};

/** Watch only, for the owner: how many visits look like robots that never had the page on screen, with the latest so they can be checked. */
export function unseenNote(r: Report): string {
	const u = r.unseen;
	if (!u?.visitors) return "";
	const when = (ts: number) => new Date(ts).toISOString().slice(5, 16).replace("T", " ").replace(/^(\d\d)-(\d\d)/, "$2/$1");
	const rows = u.latest
		.map((v) => `<li><span class="uv-when">${esc(when(v.ts))}</span> <b>${esc(country(v.country))}</b> · ${esc(v.os)} ${esc(v.browser)} · ${esc(sourceLabel(v.source))}<span class="uv-path">${esc(v.path)}</span></li>`)
		.join("");
	const share = r.totals.visitors ? ` (${Math.round((100 * u.visitors) / r.totals.visitors)}% of visitors)` : "";
	return `<details class="filtered-note unseen"><summary><b>Probably robots: ${num(u.visitors)} visit${u.visitors === 1 ? "" : "s"}${share}.</b> These loaded one page and never had it on screen: no time on the page, no scrolling, no clicks. They are still counted while we check them. <span class="uv-show">Show the latest</span></summary><ul class="uv-list">${rows}</ul><p class="gs-note">Times are UTC. A visit is only judged 30 minutes after it starts.</p></details>`;
}

/** The first day of a range ending today (UTC), counting today as day one. */
export function rangeStart(range: Range, now: number): string {
	return utcDay(now - (RANGES[range] - 1) * 86_400_000);
}

// Where each filter lives on a page view, and on a click (where the reader came from is on the page view the click happened on, v).
const VIEW_COL: Record<FilterKey, string> = { source: "COALESCE(NULLIF(source, ''), 'Direct')", page: "path", country: "country", device: "device", browser: "browser", campaign: "utm_campaign" };
const CLICK_COL: Record<FilterKey, string> = { source: "COALESCE(NULLIF(v.source, ''), 'Direct')", page: "c.path", country: "c.country", device: "c.device", browser: "c.browser", campaign: "v.utm_campaign" };

/** Time on a page counts up to 30 minutes, so one tab left open on screen for hours can't swamp the average. */
export const READ = "MIN(duration, 1800)";

/** full: every row, for downloads, instead of the top few the stats page shows. */
export async function buildReport(db: D1Database, site: string, range: Range, now: number, full = false, filters: Filters = {}): Promise<Report> {
	const top = (n: number) => (full ? 10_000 : n);
	const to = utcDay(now);
	const from = rangeStart(range, now);
	const span = RANGES[range];
	const prevFrom = utcDay(now - (2 * span - 1) * 86_400_000);
	const prevTo = utcDay(now - span * 86_400_000);
	// The period before stops at the same time of day, so this morning is set against yesterday morning, not all of yesterday.
	const prevCut = now - span * 86_400_000;
	const all = <T = Row>(sql: string, ...args: unknown[]) =>
		db.prepare(sql).bind(...args).all<T>().then((r) => r.results ?? []);
	const one = <T = Row>(sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).first<T>();
	// Visitor hashes change every day, so "visitors" over a range is the sum of each day's visitors.
	const V = "COUNT(DISTINCT visitor || day)";
	const keys = FILTER_KEYS.filter((k) => filters[k]);
	const fv = keys.map((k) => filters[k]!);
	const where = keys.map((k) => ` AND ${VIEW_COL[k]} = ?`).join("");
	const inRange = `site = ? AND day >= ? AND day <= ?${where}`;
	// Clicks only need joining to their page view when filtering by where the reader came from.
	const join = keys.some((k) => k === "source" || k === "campaign");
	const clicksFrom = `FROM events c${join ? " LEFT JOIN events v ON v.view_id = c.view_id AND v.site = c.site AND v.kind = 'view'" : ""} WHERE c.site = ? AND c.kind IN ('outbound', 'download') AND c.day >= ? AND c.day <= ?${keys.map((k) => ` AND ${CLICK_COL[k]} = ?`).join("")}`;
	// Goals always join their page view: where the reader came from is on the view, not the goal.
	const goalsFrom = `FROM events c LEFT JOIN events v ON v.view_id = c.view_id AND v.site = c.site AND v.kind = 'view' WHERE c.site = ? AND c.kind = 'goal' AND c.day >= ? AND c.day <= ?${keys.map((k) => ` AND ${CLICK_COL[k]} = ?`).join("")}`;
	const span2 = [site, prevFrom, to, ...fv];
	const cur = [site, from, to, ...fv];
	const first = (order: "ASC" | "DESC") =>
		all(`SELECT path, COUNT(*) AS visitors FROM (SELECT path, ROW_NUMBER() OVER (PARTITION BY visitor, day ORDER BY ts ${order}) AS n FROM events WHERE kind = 'view' AND ${inRange}) WHERE n = 1 GROUP BY path ORDER BY visitors DESC LIMIT ${top(20)}`, ...cur);

	const [totals, bounce, prev, now5, days, dayBounce, dayClicks, clickTotals, pages, pageClicks, entries, exits, sources, campaigns, countries, devices, browsers, clicks, history, goals, goalSources, goalPages, missing] = await Promise.all([
		one<{ views: number; visitors: number; avg: number | null }>(`SELECT COUNT(*) AS views, ${V} AS visitors, AVG(${READ}) AS avg FROM events WHERE kind = 'view' AND ${inRange}`, ...cur),
		one<{ single: number; total: number }>(`SELECT SUM(n = 1) AS single, COUNT(*) AS total FROM (SELECT COUNT(*) AS n FROM events WHERE kind = 'view' AND ${inRange} GROUP BY visitor, day)`, ...cur),
		one<{ views: number; visitors: number }>(`SELECT COUNT(*) AS views, ${V} AS visitors FROM events WHERE kind = 'view' AND ts <= ? AND ${inRange}`, prevCut, site, prevFrom, prevTo, ...fv),
		one<{ n: number }>(`SELECT COUNT(*) AS n FROM (${activeViews(site, now, where)[0]})`, ...activeViews(site, now, where, fv)[1]),
		all<{ day: string; views: number; visitors: number; secs: number | null }>(
			`SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors, CAST(AVG(${READ}) AS INTEGER) AS secs FROM events WHERE kind = 'view' AND ${inRange} GROUP BY day ORDER BY day`,
			...span2,
		),
		all<{ day: string; single: number; total: number }>(`SELECT day, SUM(n = 1) AS single, COUNT(*) AS total FROM (SELECT day, COUNT(*) AS n FROM events WHERE kind = 'view' AND ${inRange} GROUP BY visitor, day) GROUP BY day`, ...span2),
		all<{ day: string; clicks: number }>(`SELECT c.day AS day, COUNT(*) AS clicks ${clicksFrom} GROUP BY c.day`, ...span2),
		one<{ now: number; before: number }>(`SELECT SUM(c.day >= ?) AS now, SUM(c.day < ? AND c.ts <= ?) AS before ${clicksFrom}`, from, from, prevCut, ...span2),
		all(`SELECT path, COUNT(*) AS views, ${V} AS visitors, CAST(AVG(${READ}) AS INTEGER) AS secs FROM events WHERE kind = 'view' AND ${inRange} GROUP BY path ORDER BY visitors DESC, views DESC LIMIT ${top(20)}`, ...cur),
		all<{ path: string; clicks: number }>(`SELECT c.path AS path, COUNT(*) AS clicks ${clicksFrom} GROUP BY c.path`, ...cur),
		first("ASC"),
		first("DESC"),
		all(`SELECT COALESCE(NULLIF(source, ''), 'Direct') AS name, ${V} AS visitors FROM events WHERE kind = 'view' AND ${inRange} GROUP BY 1 ORDER BY visitors DESC LIMIT ${top(15)}`, ...cur),
		all(`SELECT utm_campaign AS name, ${V} AS visitors FROM events WHERE kind = 'view' AND utm_campaign != '' AND ${inRange} GROUP BY 1 ORDER BY visitors DESC LIMIT ${top(10)}`, ...cur),
		all(`SELECT country AS name, ${V} AS visitors FROM events WHERE kind = 'view' AND ${inRange} GROUP BY 1 ORDER BY visitors DESC LIMIT ${top(10)}`, ...cur),
		all(`SELECT device AS name, ${V} AS visitors FROM events WHERE kind = 'view' AND ${inRange} GROUP BY 1 ORDER BY visitors DESC`, ...cur),
		all(`SELECT browser AS name, ${V} AS visitors FROM events WHERE kind = 'view' AND ${inRange} GROUP BY 1 ORDER BY visitors DESC LIMIT ${top(8)}`, ...cur),
		all(`SELECT c.kind AS kind, c.target AS target, c.path AS path, COUNT(*) AS clicks ${clicksFrom} GROUP BY c.kind, c.target, c.path ORDER BY clicks DESC LIMIT ${top(100)}`, ...cur),
		// Older stats are whole-site totals, so they can't be narrowed by a filter.
		keys.length ? Promise.resolve([]) : historyBetween(db, site, prevFrom, to),
		all(`SELECT c.target AS name, COUNT(*) AS completions, COUNT(DISTINCT c.visitor || c.day) AS visitors ${goalsFrom} GROUP BY c.target ORDER BY visitors DESC, completions DESC LIMIT ${top(20)}`, ...cur),
		all(`SELECT COALESCE(NULLIF(v.source, ''), 'Direct') AS name, COUNT(DISTINCT c.visitor || c.day) AS visitors ${goalsFrom} GROUP BY 1 ORDER BY visitors DESC LIMIT ${top(15)}`, ...cur),
		all(`SELECT c.path AS path, COUNT(DISTINCT c.visitor || c.day) AS visitors ${goalsFrom} GROUP BY c.path ORDER BY visitors DESC LIMIT ${top(15)}`, ...cur),
		all(
			// top_link: the page of this website that most often linked to it (a broken link to fix), kept in target.
			`SELECT path, COUNT(*) AS views, (SELECT COALESCE(NULLIF(m2.referrer, ''), 'Direct') FROM events m2 WHERE m2.site = events.site AND m2.kind = 'view' AND m2.missing = 1 AND m2.path = events.path AND m2.day >= ? GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1) AS top_from,
			 (SELECT m3.target FROM events m3 WHERE m3.site = events.site AND m3.kind = 'view' AND m3.missing = 1 AND m3.path = events.path AND m3.day >= ? AND m3.target IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1) AS top_link
			 FROM events WHERE kind = 'view' AND missing = 1 AND ${inRange} GROUP BY path ORDER BY views DESC LIMIT ${top(20)}`,
			from, from, ...cur,
		),
	]);
	// Older history fills the days before ReaderCount's first visit, so the totals and chart include it.
	const old = (a: string, b: string) => history.filter((h) => h.day >= a && h.day <= b);
	const sum = (rows: { visitors: number; views: number }[]) => rows.reduce((t, h) => ({ visitors: t.visitors + Number(h.visitors), views: t.views + Number(h.views) }), { visitors: 0, views: 0 });
	const oldNow = sum(old(from, to)), oldPrev = sum(old(prevFrom, prevTo));
	const bounceOn = new Map(dayBounce.map((b) => [b.day, b.total ? Math.round((100 * (b.single ?? 0)) / b.total) : 0]));
	const clicksOn = new Map(dayClicks.map((c) => [c.day, Number(c.clicks)]));
	const counted: Day[] = days.map((d) => ({ day: d.day, views: Number(d.views), visitors: Number(d.visitors), secs: Number(d.secs ?? 0), bounce: bounceOn.get(d.day) ?? 0, clicks: clicksOn.get(d.day) ?? 0 }));
	for (const [day, n] of clicksOn) if (!days.some((d) => d.day === day)) counted.push({ day, views: 0, visitors: 0, clicks: n });
	const merged = [...counted, ...history.map((h) => ({ day: h.day, views: Number(h.views), visitors: Number(h.visitors), imported: true }))];
	const clicksByPage = new Map(pageClicks.map((p) => [p.path, Number(p.clicks)]));
	const [ai, filtered, hourly, unseen] = await Promise.all([foundByAi(all, inRange, cur, [site, prevFrom, prevTo, ...fv], from, to), filteredBetween(db, site, from, to), range === "today" ? hoursOf(all, inRange, clicksFrom, span2, to, prevFrom, now) : undefined, keys.length || full ? undefined : unseenBetween(db, site, from, to, now)]);

	return {
		site,
		range,
		from,
		to,
		totals: {
			views: (totals?.views ?? 0) + oldNow.views,
			visitors: (totals?.visitors ?? 0) + oldNow.visitors,
			avgSeconds: Math.round(totals?.avg ?? 0),
			bounce: bounce?.total ? Math.round((100 * (bounce.single ?? 0)) / bounce.total) : 0,
			now: now5?.n ?? 0,
			clicks: Number(clickTotals?.now ?? 0),
		},
		previous: { views: (prev?.views ?? 0) + oldPrev.views, visitors: (prev?.visitors ?? 0) + oldPrev.visitors, clicks: Number(clickTotals?.before ?? 0) },
		days: fillDays(merged, from, to),
		prevDays: fillDays(merged, prevFrom, prevTo),
		hours: hourly?.hours,
		prevHours: hourly?.prev,
		pages: pages.map((p) => ({ ...p, clicks: clicksByPage.get(String(p.path)) ?? 0 })),
		entries,
		exits,
		sources,
		campaigns,
		countries,
		devices,
		browsers,
		clicks,
		goals,
		goalSources,
		goalPages,
		missing,
		filters: keys.length ? filters : undefined,
		filtered,
		unseen,
		ai,
	};
}

/** Today's chart: views, visitors, time, bounce and clicks for each hour so far, and the same hours yesterday. A visit's bounce counts in the hour it started. */
async function hoursOf(all: <T = Row>(sql: string, ...args: unknown[]) => Promise<T[]>, inRange: string, clicksFrom: string, args: unknown[], today: string, yesterday: string, now: number) {
	const H = (col: string) => `CAST((${col} % 86400000) / 3600000 AS INTEGER)`;
	const [views, bounce, clicks] = await Promise.all([
		all<{ day: string; h: number; views: number; visitors: number; secs: number | null }>(`SELECT day, ${H("ts")} AS h, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors, CAST(AVG(${READ}) AS INTEGER) AS secs FROM events WHERE kind = 'view' AND ${inRange} GROUP BY 1, 2`, ...args),
		all<{ day: string; h: number; single: number; total: number }>(`SELECT day, h, SUM(n = 1) AS single, COUNT(*) AS total FROM (SELECT day, ${H("MIN(ts)")} AS h, COUNT(*) AS n FROM events WHERE kind = 'view' AND ${inRange} GROUP BY visitor, day) GROUP BY 1, 2`, ...args),
		all<{ day: string; h: number; clicks: number }>(`SELECT c.day AS day, ${H("c.ts")} AS h, COUNT(*) AS clicks ${clicksFrom} GROUP BY 1, 2`, ...args),
	]);
	const last = new Date(now).getUTCHours();
	const make = (day: string): Day[] =>
		Array.from({ length: last + 1 }, (_, hour) => {
			const v = views.find((r) => r.day === day && Number(r.h) === hour);
			const b = bounce.find((r) => r.day === day && Number(r.h) === hour);
			const c = clicks.find((r) => r.day === day && Number(r.h) === hour);
			return { day, hour, views: Number(v?.views ?? 0), visitors: Number(v?.visitors ?? 0), secs: Number(v?.secs ?? 0), bounce: b?.total ? Math.round((100 * (b.single ?? 0)) / b.total) : 0, clicks: Number(c?.clicks ?? 0) };
		});
	return { hours: make(today), prev: make(yesterday) };
}

function fillDays(rows: Day[], from: string, to: string): Day[] {
	const byDay = new Map(rows.filter((r) => r.day >= from && r.day <= to).map((r) => [r.day, r]));
	const out: Day[] = [];
	for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z"); t += 86_400_000) {
		const day = utcDay(t);
		out.push(byDay.get(day) ?? { day, views: 0, visitors: 0 });
	}
	return out;
}

// ---- HTML ----

export const esc = (s: unknown) =>
	String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const num = (n: number) => n.toLocaleString("en-GB");

export function duration(s: number): string {
	if (!s) return "–";
	const m = Math.floor(s / 60);
	return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** The tiles' comparison. Today compares against yesterday up to the same time. Small numbers show the figure itself, so 1 visitor against 0 doesn't read as a 100% fall. */
function vsBefore(now: number, before: number, range: string, what: string): string {
	if (!before) return "";
	const when = range === "today" ? "by this time yesterday" : "in the period before";
	if (before < 10 && now < 10) return `<span class="chg">${now === before ? (range === "today" ? "Same as this time yesterday" : "Same as the period before") : `${num(before)} ${before === 1 ? what : what + "s"} ${when}`}</span>`;
	return change(now, before, range === "today" ? " vs this time yesterday" : " vs prior period");
}

function change(now: number, before: number, after = ""): string {
	if (!before) return "";
	const pct = Math.round(((now - before) / before) * 100);
	const cls = pct > 0 ? "up" : pct < 0 ? "down" : "";
	return `<span class="chg ${cls}">${pct > 0 ? "+" : ""}${pct}%${after}</span>`;
}

let countryNames: Intl.DisplayNames | undefined;
export function country(code: unknown): string {
	const c = String(code ?? "");
	if (!/^[A-Z]{2}$/.test(c)) return "Unknown";
	try {
		countryNames ??= new Intl.DisplayNames(["en-GB"], { type: "region" });
		return countryNames.of(c) ?? c;
	} catch {
		return c;
	}
}

// ---- Lists: a bar behind every row, an icon, and a click to filter the page ----

/** One row in a list. href filters the page to it; out opens the page or link itself. */
/** shown replaces the number on the right when value (the bar) isn't the number to read, such as pounds. */
type Item = { name: string; sub?: string; /** Addresses in sub shown as links that open them. */ subLinks?: string[]; /** Show name as a link that opens out. */ nameLink?: boolean; icon?: string; tag?: string; extra?: string; value: number; shown?: string; href?: string; out?: string; /** A web search that finds the page linking here. */ find?: string; /** An address to copy. */ copy?: string };

/** Escapes text, turning each of the given addresses in it into a link that opens it in a new tab. */
function linked(text: string, links: string[] = []): string {
	const urls = [...new Set(links)].filter((u) => /^https?:\/\//i.test(u)).sort((a, b) => b.length - a.length).map(esc);
	if (!urls.length) return esc(text);
	// One pass, longest first, so a page address that starts another (yourblog.com/ in yourblog.com/menu.js) isn't linked inside the link.
	return esc(text).replace(new RegExp(urls.map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g"), (u) => `<a class="ln" href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}

const COPY_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>`;
const FIND_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

/** A source that is a website ("aocr.org", not "Google" or "newsletter"): its address, and a Google search for its pages that mention this site.
 * Browsers only tell us the referring site, not the page, so the search is the way to find the page itself. */
export function sourceLinks(name: unknown, site: string): { out?: string; find?: string; copy?: string } {
	const host = String(name ?? "").toLowerCase();
	if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return {};
	const out = `https://${host}/`;
	return { out, copy: out, find: `https://www.google.com/search?q=${encodeURIComponent(`site:${host} "${site.replace(/^www\./, "")}"`)}` };
}

function rows(items: Item[], head: [string, string], empty: string, show = 8): string {
	if (!items.length) return empty.startsWith("<") ? empty : `<p class="empty">${empty}</p>`;
	const max = Math.max(1, ...items.map((i) => i.value));
	const one = (i: Item) => {
		const name = `${i.nameLink && i.out && !i.href ? linked(i.name, [i.name]) : esc(i.name)}${i.tag ?? ""}${i.sub ? `<small>${linked(i.sub, i.subLinks)}</small>` : ""}`;
		return `<div class="row"><span class="b" style="width:${Math.max(2, Math.round((i.value / max) * 100))}%"></span>${i.icon ?? ""}${i.href ? `<a class="nm" href="${i.href}" title="Show only this">${name}</a>` : `<span class="nm">${name}</span>`}${i.copy ? `<button type="button" class="out" data-copy-text="${esc(i.copy)}" title="Copy ${esc(i.copy)}" aria-label="Copy ${esc(i.copy)}">${COPY_ICON}</button>` : ""}${i.find ? `<a class="out" href="${esc(i.find)}" rel="noreferrer" target="_blank" title="Find the page that links to you" aria-label="Find the page on ${esc(i.name)} that links to you">${FIND_ICON}</a>` : ""}${i.out ? `<a class="out" href="${esc(i.out)}" rel="noreferrer" target="_blank" title="Open ${esc(i.out)}" aria-label="Open ${esc(i.name)}">↗</a>` : ""}${i.extra ? `<span class="x">${i.extra}</span>` : ""}<span class="v">${i.shown ?? num(i.value)}</span></div>`;
	};
	const rest = items.slice(show);
	return `<div class="colh"><span>${head[0]}</span><span>${head[1]}</span></div><div class="rows">${items.slice(0, show).map(one).join("")}</div>${rest.length ? `<details class="all"><summary>Show all ${num(items.length)}</summary><div class="rows">${rest.map(one).join("")}</div></details>` : ""}`;
}

/** A card with tabs along the top (radio buttons, so it needs no script and survives the page updating itself). */
function tabbed(id: string, title: string, panes: ([string, string] | false)[]): string {
	const p = panes.filter((x): x is [string, string] => Boolean(x));
	if (p.length === 1) return `<section class="card list" id="card-${id}"><h2>${title}</h2>${p[0][1]}</section>`;
	return `<section class="card list tabbed" id="card-${id}"><h2>${title}</h2>${p.map((_, i) => `<input type="radio" name="${id}" id="${id}-${i + 1}" class="t${i + 1}"${i ? "" : " checked"}>`).join("")}<div class="tabs">${p.map(([label], i) => `<label for="${id}-${i + 1}">${label}</label>`).join("")}</div>${p.map(([, html], i) => `<div class="pane p${i + 1}">${html}</div>`).join("")}</section>`;
}

/** "Gmail vs proton mail why I made the switch" from "/gmail-vs-proton-mail-why-i-made-the-switch/". */
export function pageName(path: string): string {
	const clean = String(path ?? "").split(/[?#]/)[0].replace(/\/+$/, "");
	if (!clean) return "Home page";
	let last = clean.split("/").pop() ?? "";
	try {
		last = decodeURIComponent(last);
	} catch {
		// Keep it as it is.
	}
	const words = last.replace(/\.(html?|php|aspx?)$/i, "").replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim().replace(/\bi\b/g, "I");
	return words ? words[0].toUpperCase() + words.slice(1) : clean;
}

const ICONS: Record<string, [string, string]> = {
	Direct: ["#6b6b70", "→"], Google: ["#4285F4", "G"], "Google News": ["#4285F4", "N"], Bing: ["#00809D", "b"], DuckDuckGo: ["#DE5833", "D"], "duck.ai": ["#DE5833", "d"], Yahoo: ["#6001D2", "y"], Ecosia: ["#2E7D32", "e"], "Brave Search": ["#FB542B", "B"], Baidu: ["#2932E1", "du"], Yandex: ["#FC3F1D", "Y"],
	Reddit: ["#FF4500", "r"], "X (Twitter)": ["#14171a", "X"], Facebook: ["#1877F2", "f"], Instagram: ["#C13584", "ig"], LinkedIn: ["#0A66C2", "in"], Threads: ["#14171a", "@"], Bluesky: ["#0085FF", "b"], Mastodon: ["#6364FF", "m"], Pinterest: ["#E60023", "p"], Flipboard: ["#E12828", "f"], YouTube: ["#FF0000", "▶"], "Hacker News": ["#FF6600", "Y"],
	ChatGPT: ["#10A37F", "✦"], Amazon: ["#FF9900", "a"], Fastmail: ["#0067B9", "F"], Proton: ["#6D4AFF", "P"], eBay: ["#E53238", "e"], NordVPN: ["#4687FF", "N"], Tuta: ["#850122", "T"], Apple: ["#1d1d1f", "A"], GitHub: ["#24292f", "G"], Gemini: ["#8E75F0", "✦"], Perplexity: ["#1F8A8A", "✦"], Claude: ["#D97757", "✦"], Copilot: ["#0078D4", "✦"], DeepSeek: ["#4D6BFE", "✦"], "Meta AI": ["#0866FF", "✦"], Grok: ["#14171a", "✦"], "Le Chat (Mistral)": ["#FA520F", "✦"], "Duck.ai": ["#DE5833", "✦"], "You.com": ["#7c3aed", "✦"], Phind: ["#0e7490", "✦"], newsletter: ["#1a7f37", "✉"],
};
/** utm_source tags are often lower case ("newsletter"): show them with a capital letter. */
function sourceLabel(name: unknown): string {
	const s = String(name ?? "");
	return /^[a-z][a-z0-9 _-]*$/.test(s) ? s[0].toUpperCase() + s.slice(1).replace(/[_-]+/g, " ") : s;
}

/** A line under sources that are easy to misread. */
function sourceNote(name: unknown): string | undefined {
	return /^(newsletter|email)$/i.test(String(name ?? "")) ? "Links in your emails" : undefined;
}

/** A campaign named after a post ("proton-mail-free-plan") reads as the post's name, with the tag underneath. */
function campaignLabel(name: unknown): { name: string; sub?: string } {
	const s = String(name ?? "");
	return /^[a-z0-9]+(-[a-z0-9]+)+$/.test(s) ? { name: pageName(s), sub: s } : { name: s };
}

const TILE_COLOURS = ["#2f6fed", "#1a7f37", "#c2410c", "#7c3aed", "#0e7490", "#be185d", "#4d7c0f", "#b45309"];

/** The shops we name (see BRANDS below) and the address their logo comes from. */
const BRAND_HOSTS: Record<string, string> = { Amazon: "amazon.com", Fastmail: "fastmail.com", Proton: "proton.me", eBay: "ebay.com", NordVPN: "nordvpn.com", Tuta: "tuta.com", Apple: "apple.com", GitHub: "github.com", YouTube: "youtube.com" };
/** Where a shop's or website's logo comes from: our own /logo/ address (src/index.ts), so the person viewing never contacts an outside icon service. */
export const LOGO_BASE = "/logo/";

/** A small coloured square with a letter, for a source or website. Shops and websites also get their own logo over it; if there isn't one, the letter shows. */
export function iconFor(name: string): string {
	const known = ICONS[name];
	const label = name.replace(/^www\./, "");
	let h = 0;
	for (const c of label) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	const [bg, letter] = known ?? [TILE_COLOURS[h % TILE_COLOURS.length], (label[0] ?? "?").toUpperCase()];
	const host = BRAND_HOSTS[name] ?? (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(label) ? label.toLowerCase() : "");
	const logo = host ? `<img src="${LOGO_BASE}${esc(host)}" alt="" loading="lazy" onerror="this.remove()">` : "";
	return `<span class="ic${logo ? " lg" : ""}" style="background:${bg}" aria-hidden="true">${esc(letter)}${logo}</span>`;
}

export function flag(code: unknown): string {
	const c = String(code ?? "");
	const f = /^[A-Z]{2}$/.test(c) ? String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : "🌐";
	return `<span class="flag" aria-hidden="true">${f}</span>`;
}

const BRANDS: [RegExp, string][] = [
	[/(^|\.)amazon\.[a-z.]+$|^amzn\.(to|eu)$/, "Amazon"], [/(^|\.)fastmail\.com$/, "Fastmail"], [/(^|\.)proton\.me$|^pr\.tn$/, "Proton"], [/(^|\.)ebay\.[a-z.]+$/, "eBay"],
	[/(^|\.)nordvpn\.com$/, "NordVPN"], [/(^|\.)tuta\.(com|io)$/, "Tuta"], [/(^|\.)apple\.com$/, "Apple"], [/(^|\.)github\.com$/, "GitHub"], [/(^|\.)youtube\.com$|^youtu\.be$/, "YouTube"],
];
const AFFILIATE_HOSTS = /(^|\.)(awin1\.com|amzn\.to|amzn\.eu|go\.skimresources\.com|shareasale\.com|prf\.hn|anrdoezrs\.net|jdoqocy\.com|tkqlhce\.com|dpbolvw\.net|kqzyfj\.com|sjv\.io|pxf\.io|pntra\.com|avantlink\.com|linksynergy\.com|clickbank\.net|tradedoubler\.com|webgains\.com|pr\.tn|join\.fastmail\.com)$/;
const AFFILIATE_PARAMS = ["tag", "ref", "aff", "affid", "aff_id", "affiliate", "affiliate_id", "partner", "partner_id", "irclickid", "clickref", "via", "ascsubtag", "awc", "rfsn", "sca_ref", "coupon_ref"];

/** Which website a link goes to (Amazon, Fastmail...), and whether it looks like an affiliate link from its address. */
export function linkSite(target: string): { key: string; name: string; affiliate: boolean } {
	try {
		const u = new URL(target);
		let host = u.hostname.replace(/^www\./, "").toLowerCase();
		const affiliate = AFFILIATE_HOSTS.test(host) || AFFILIATE_PARAMS.some((p) => u.searchParams.has(p)) || u.searchParams.get("utm_medium") === "affiliate" || /\/(ref|aff|affiliate)\//i.test(u.pathname);
		// Affiliate networks carry the shop's address inside the link.
		const inner = host === "awin1.com" ? (u.searchParams.get("ued") ?? u.searchParams.get("p")) : null;
		if (inner) {
			try {
				host = new URL(/^https?:/i.test(inner) ? inner : "https://" + inner).hostname.replace(/^www\./, "").toLowerCase();
			} catch {
				// Keep the network's own name.
			}
		}
		const brand = BRANDS.find(([re]) => re.test(host))?.[1];
		return { key: brand ?? host, name: brand ?? host, affiliate };
	} catch {
		return { key: target, name: target.slice(0, 60), affiliate: false };
	}
}

// ---- The chart ----

const METRIC_LABELS: Record<Metric, string> = { visitors: "Unique Visitors", views: "Total Page Views", time: "Avg Dwell Time", bounce: "Bounce Rate", clicks: "Outbound Clicks" };
const CHART_TITLES: Record<Metric, string> = { visitors: "Daily Visitor Trend", views: "Daily Page View Trend", time: "Daily Dwell Time Trend", bounce: "Daily Bounce Rate Trend", clicks: "Daily Outbound Click Trend" };
const HOURLY_TITLES: Record<Metric, string> = { visitors: "Hourly Visitor Trend", views: "Hourly Page View Trend", time: "Hourly Dwell Time Trend", bounce: "Hourly Bounce Rate Trend", clicks: "Hourly Outbound Click Trend" };

/** "14:00" for an hour on today's chart. */
const clock = (h: number) => `${String(h).padStart(2, "0")}:00`;

function valueOf(d: Day, m: Metric): number {
	return Number(m === "visitors" ? d.visitors : m === "views" ? d.views : m === "time" ? d.secs : m === "bounce" ? d.bounce : d.clicks) || 0;
}

function fmt(v: number, m: Metric): string {
	return m === "time" ? duration(v) : m === "bounce" ? `${v}%` : num(v);
}

/** A round number just above the highest value, so the scale reads 0, 10, 20, 30, 40. */
function scaleTop(max: number, m: Metric): { top: number; step: number } {
	if (m === "bounce") return { top: 100, step: 25 };
	const raw = Math.max(1, max) / 4;
	const p = 10 ** Math.floor(Math.log10(raw));
	let step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? 10 * p;
	if (m === "time" && step > 30) step = Math.ceil(step / 60) * 60;
	step = Math.max(1, Math.round(step));
	return { top: step * Math.max(1, Math.ceil(max / step)), step };
}

function tick(v: number, m: Metric): string {
	return m === "time" ? (v >= 60 ? `${Math.round(v / 60)}m` : `${v}s`) : m === "bounce" ? `${v}%` : num(v);
}

function chart(r: Report, metric: Metric, notes?: ChartNotes, posts: { day: string; title: string }[] = []): string {
	// Today has one point per hour, so the chart isn't a single dot.
	const hourly = Boolean(r.hours?.length);
	let days = hourly ? r.hours! : r.days, prev = (hourly ? r.prevHours : r.prevDays) ?? [];
	const label = (d: Day) => (hourly ? clock(d.hour ?? 0) : shortDate(d.day));
	// Notes and new posts belong to a day, not an hour.
	if (hourly) posts = [];
	// Skip the empty days before ReaderCount started counting, so a new site's chart isn't mostly blank.
	const started = days.findIndex((d) => d.views || d.visitors || d.clicks || d.imported);
	let since = "";
	if (!hourly && days.length > 7 && started >= 3 && !prev.some((d) => d.views || d.visitors)) {
		days = days.slice(started);
		prev = [];
		since = `<span class="since">Counting started ${shortDate(days[0].day)}</span>`;
	}
	const n = days.length;
	const vals = days.map((d) => valueOf(d, metric));
	const before = prev.length === days.length ? prev.map((d) => valueOf(d, metric)) : [];
	const hasBefore = before.some((v) => v > 0);
	const peak = Math.max(0, ...vals);
	const { top, step } = scaleTop(Math.max(peak, ...(hasBefore ? before : [0])), metric);
	const W = 1000;
	const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
	const y = (v: number) => 100 - (v / top) * 100;
	const pts = (list: number[]) => list.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(2)}`).join(" ");
	const area = n > 1 ? `<path class="area" d="M0,100 L${pts(vals).replace(/ /g, " L")} L${W},100 Z"/>` : "";
	const prevLine = hasBefore && n > 1 ? `<polyline class="prev" points="${pts(before)}"/>` : "";
	const line = n > 1 ? `<polyline class="ln" points="${pts(vals)}"/>` : "";
	const dots = vals.map((v, i) => `<line class="pt${days[i].imported ? " imp" : ""}" data-i="${i}" x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(v).toFixed(2)}" y2="${y(v).toFixed(2)}"/>`).join("");
	const dayNotes = new Map<string, string[]>();
	for (const nt of hourly ? [] : notes?.list ?? []) dayNotes.set(nt.day, [...(dayNotes.get(nt.day) ?? []), nt.text]);
	const marks = [...dayNotes]
		.map(([day, texts]) => {
			const i = days.findIndex((d) => d.day === day);
			return i < 0 ? "" : `<g class="nt"><line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="0" y2="100"/><title>${esc(shortDate(day))}: ${esc(texts.join(" · "))}</title></g>`;
		})
		.join("");
	const dayPosts = new Map<string, string[]>();
	for (const p of posts) dayPosts.set(p.day, [...(dayPosts.get(p.day) ?? []), p.title]);
	const postMarks = [...dayPosts]
		.map(([day, titles]) => {
			const i = days.findIndex((d) => d.day === day);
			return i < 0 || dayNotes.has(day) ? "" : `<g class="np"><line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="0" y2="100"/><title>${esc(shortDate(day))}: ${esc(titles.join(" · "))}</title></g>`;
		})
		.join("");
	// One invisible full-height strip per day, so hovering anywhere over a day shows its numbers.
	const hits = days
		.map((d, i) => {
			const left = n === 1 ? 0 : Math.max(0, x(i) - W / (n - 1) / 2), right = n === 1 ? W : Math.min(W, x(i) + W / (n - 1) / 2);
			const tip = [
				hourly ? `${clock(d.hour ?? 0)} to ${clock(d.hour ?? 0).slice(0, 3)}59 (UTC)` : longDate(d.day),
				`${num(d.visitors)} ${d.visitors === 1 ? "visitor" : "visitors"} · ${num(d.views)} ${d.views === 1 ? "view" : "views"}`,
				metric === "time" || metric === "bounce" ? `${METRIC_LABELS[metric]}: ${fmt(vals[i], metric)}` : "",
				d.clicks ? `${num(d.clicks)} outbound ${d.clicks === 1 ? "click" : "clicks"}` : "",
				hasBefore ? `${hourly ? "Same hour yesterday" : "Prior period"}: ${fmt(before[i], metric)}` : "",
				d.imported ? "From your older stats" : "",
				...(dayNotes.get(d.day) ?? []).map((t) => "Note: " + t),
				...(dayPosts.get(d.day) ?? []).map((t) => "New post: " + t),
			].filter(Boolean).join("\n");
			return `<rect class="hit" x="${left.toFixed(1)}" y="0" width="${(right - left).toFixed(1)}" height="100" data-i="${i}" data-tip="${esc(tip)}"/>`;
		})
		.join("");
	const grid = Array.from({ length: Math.round(top / step) + 1 }, (_, k) => k * step)
		.map((v) => `<div class="gl" style="top:${y(v).toFixed(2)}%"><span>${tick(v, metric)}</span></div>`)
		.join("");
	const every = n <= 8 ? 1 : n <= 16 ? 3 : 4;
	const labelsAt = hourly ? days.map((_, i) => i).filter((i) => i % every === 0) : n <= 7 ? days.map((_, i) => i) : [...new Set(Array.from({ length: 6 }, (_, k) => Math.round((k * (n - 1)) / 5)))];
	const xlabels = labelsAt.map((i) => `<span style="left:${(x(i) / 10).toFixed(2)}%"${i === 0 && n > 1 ? ' class="first"' : i === n - 1 && n > 1 ? ' class="last"' : ""}>${label(days[i])}</span>`).join("");
	// The figure above each point, so the numbers can be read without hovering. Longer charts label the peak and the latest point only.
	const peakAt = vals.indexOf(peak);
	const valueLabels = vals
		.map((v, i) => (!v || (n > 14 && i !== peakAt && i !== n - 1) ? "" : `<span class="vl${i === peakAt || i === n - 1 ? " vk" : ""}${i === 0 && n > 1 ? " first" : i === n - 1 && n > 1 ? " last" : ""}" style="left:${(x(i) / 10).toFixed(2)}%;top:${y(v).toFixed(2)}%">${fmt(v, metric)}</span>`))
		.join("");
	const imported = days.some((d) => d.imported) ? `<p class="gs-note"><span class="key imp"></span>Faded dots come from your older stats, for the days before ReaderCount started counting.</p>` : "";
	const empty = hourly && !vals.some(Boolean) ? `<p class="gs-note">No ${({ visitors: "visitors", views: "page views", time: "visits", bounce: "visits", clicks: "outbound clicks" } as Record<Metric, string>)[metric]} yet today. The day starts at midnight UTC${hasBefore ? ", and the dashed line shows yesterday up to the same hour" : ""}.</p>` : "";
	const legend = `<div class="legend"><span class="lk"><i></i>${METRIC_LABELS[metric]}</span>${hasBefore ? `<span class="lk"><i class="d"></i>${hourly ? "Yesterday" : "Prior period"}</span>` : ""}${postMarks ? `<span class="lk"><i class="p"></i>New post</span>` : ""}${since}</div>`;
	return `<section class="card wide chartcard" id="chart"><h2>${(hourly ? HOURLY_TITLES : CHART_TITLES)[metric]} <small>(${metric === "time" || metric === "bounce" ? "Peak" : "Peak volume"}: ${fmt(peak, metric)}${hourly ? " · times in UTC" : ""})</small></h2>${legend}<div class="chart-wrap"><div class="plot">${grid}<svg viewBox="0 0 ${W} 100" preserveAspectRatio="none" role="img" aria-label="${METRIC_LABELS[metric]} per ${hourly ? "hour" : "day"}"><defs><linearGradient id="rc-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".22"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>${area}${prevLine}${line}${postMarks}${marks}${dots}${hits}</svg>${valueLabels}</div><div class="ctip" hidden></div></div><div class="xaxis">${xlabels}</div>${empty}${imported}${notes ? noteList(notes) : ""}</section>`;
}

/** Notes on the chart, and whether they can be added and removed here. */
export type ChartNotes = { list: Note[]; site: string; range: Range; today: string; editable: boolean };

/** The notes for the dates on screen, and a box to add one. */
function noteList(n: ChartNotes): string {
	const hidden = `<input type="hidden" name="site" value="${esc(n.site)}"><input type="hidden" name="range" value="${n.range}">`;
	const items = n.list
		.map((x) => `<li><span class="nt-day">${esc(shortDate(x.day))}</span><span class="nt-text">${esc(x.text)}</span>${n.editable ? `<form method="post" action="/notes/remove">${hidden}<input type="hidden" name="id" value="${x.id}"><button type="submit" class="link-btn" aria-label="Remove the note for ${esc(shortDate(x.day))}">Remove</button></form>` : ""}</li>`)
		.join("");
	const add = n.editable
		? `<details class="nt-add"><summary class="btn-out">Add timeline annotation</summary><p class="gs-intro">Annotate marketing actions (e.g. "Published on Reddit" or "Updated headline") to correlate promotional activities with traffic changes.</p><form method="post" action="/notes" class="cl-row">${hidden}<input type="date" name="day" value="${n.today}" max="${n.today}" required aria-label="Annotation Date"><input name="text" maxlength="${MAX_NOTE}" placeholder="Published guide on Reddit" required aria-label="Annotation Note"><button class="cl-copy" type="submit">Save annotation</button></form></details>`
		: "";
	return `<div class="notes" id="notes">${items ? `<ul class="nt-list">${items}</ul>` : ""}${add}</div>`;
}

const FIX_LABELS: Record<Fix["kind"], string> = { slipping: "Slipping on Google", "few-clicks": "Seen but not clicked", "page-two": "Nearly on page one", losing: "Losing visitors", bounce: "High bounce rate" };
/** One small line icon per kind of fix (Lucide-style, 24px grid). */
const FIX_ICONS: Record<Fix["kind"], string> = {
	slipping: '<path d="M22 17l-8.5-8.5-5 5L2 7"/><path d="M16 17h6v-6"/>',
	"few-clicks": '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
	"page-two": '<path d="M22 7l-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
	losing: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11h-6"/>',
	bounce: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
};

/** Site health: one card near the top, worst first, or a single line when all's well. */
export function healthCard(items: HealthItem[]): string {
	if (!items.length) return `<p class="hl-ok"><span aria-hidden="true">✓</span> <b>Site health: all clear.</b> We open your home page every 5 minutes and watch for broken links, pictures, slow pages and script errors.</p>`;
	const fix = items.filter((i) => i.level === "fix").length;
	const list = items
		.map((i) => `<li class="hl ${i.level}"><span class="tag ${i.level === "fix" ? "bad" : "mid"}">${i.level === "fix" ? "Requires fix" : "Needs attention"}</span><div><b>${esc(i.title)}</b><p>${linked(i.detail, i.links)}</p>${i.go ? `<a class="hl-go" href="#card-${i.go.card}"${i.go.tab ? ` data-tab="${esc(i.go.tab)}"` : ""}>Show me${i.go.tab ? ` in ${esc(i.go.tab)}` : ""} ↓</a>` : ""}</div></li>`)
		.join("");
	return `<section class="card wide health" id="health"><div class="fix-head"><h2>Site Health</h2><p>${fix ? `${fix} ${fix === 1 ? "thing needs" : "things need"} fixing` : "Nothing broken"}${items.length - fix ? `, ${items.length - fix} worth a look` : ""}. Worst first.</p></div><ul class="hl-list">${list}</ul></section>`;
}

/** "What to fix": a few posts worth working on, each with the reason and what to do. */
function fixList(fixes: Fix[], site: string): string {
	const items = fixes
		.map(
			(f) =>
				`<li class="fix ${f.kind}"><span class="fix-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${FIX_ICONS[f.kind]}</svg></span><div class="fix-body"><p class="fix-tag">${FIX_LABELS[f.kind]}</p><a class="fix-page" href="https://${esc(site)}${esc(f.page)}" rel="noreferrer" target="_blank">${esc(pageName(f.page))} <small>${esc(f.page)}</small></a><p class="fix-what">${esc(f.what)}</p><p class="fix-todo"><b>What to do</b>${esc(f.todo)}</p></div></li>`,
		)
		.join("");
	return `<section class="card wide fixes"><div class="fix-head"><h2>What to fix this week</h2><p>The last 4 weeks against the 4 before, biggest wins first.</p></div>${items ? `<ol class="fix-list">${items}</ol>` : `<p class="fix-none"><span aria-hidden="true">✓</span> Nothing needs fixing right now. When a post starts slipping on Google or losing readers, it shows up here with what to do.</p>`}</section>`;
}

/** Download buttons: the range on screen as a spreadsheet, or the page itself saved as a PDF. */
function downloads(r: Report): string {
	const q = `site=${encodeURIComponent(r.site)}&amp;range=${r.range}`;
	return `<section class="card wide dl"><h2>Data Export Modules</h2><p class="gs-intro">Export traffic data for ${r.range === "today" ? "today" : `the selected ${PERIOD_LABELS[r.range]} period`}. CSV and Excel exports contain complete dataset arrays across pages, referral sources, and link events.</p><div class="acct-btns"><a class="btn-out" href="/export?${q}&amp;format=csv" download>Export CSV</a><a class="btn-out" href="/export?${q}&amp;format=xlsx" download>Export Excel</a><button type="button" class="btn-out" onclick="print()">Export PDF</button><a class="btn-out" href="/media-kit?site=${encodeURIComponent(r.site)}" download>Download media kit</a></div><p class="gs-note">For PDF generation, select "Save as PDF" within the system print interface. The media kit is a one-page PDF of your last 30 days for sponsors and advertisers.</p></section>`;
}

/** "Tue 14 Oct 2026" for the chart's hover box. */
/** Found by AI: how many visitors AI services sent, which ones, the pages they sent people to, and a small chart of each day. */
function foundByAiCard(ai: FoundByAi, allVisitors: number, page: (p: Row) => Item, filter: (name: string) => string | undefined): string {
	const title = `Found by AI`;
	if (!ai.visitors) return `<section class="card list ai"><h2>${title}</h2><p class="empty">No visits from AI services in these dates yet. When ChatGPT, Perplexity, Claude, Gemini or Copilot links to one of your pages and someone clicks through, the visit shows up here.</p></section>`;
	const pct = allVisitors ? (100 * ai.visitors) / allVisitors : 0;
	const top = Math.max(1, ...ai.days.map((d) => d.visitors));
	const w = ai.days.length;
	const bars = w > 1 ? `<svg class="ai-spark" viewBox="0 0 ${w * 4} 40" preserveAspectRatio="none" role="img" aria-label="Visitors from AI services each day">${ai.days.map((d, i) => (d.visitors ? `<rect x="${i * 4 + 0.5}" y="${40 - Math.max(2, Math.round((d.visitors / top) * 40))}" width="3" height="${Math.max(2, Math.round((d.visitors / top) * 40))}" rx="1"><title>${esc(longDate(d.day))}: ${num(d.visitors)}</title></rect>` : "")).join("")}</svg>` : "";
	const sum = `<div class="ai-sum"><p><b>${num(ai.visitors)}</b> ${ai.visitors === 1 ? "visitor" : "visitors"} from AI services${change(ai.visitors, ai.previous, " vs prior period")}<br><span class="hint">${pct >= 0.1 ? `${pct < 1 ? pct.toFixed(1) : Math.round(pct)}% of all visitors` : "Under 0.1% of all visitors"}</span></p>${bars}</div>`;
	const panes: [string, string][] = [
		["AI services", rows(ai.services.map((s) => ({ name: s.name, icon: iconFor(s.name), value: s.visitors, extra: `${Math.max(1, Math.round((100 * s.visitors) / ai.visitors))}%`, href: filter(s.name) })), ["AI service", "Share · Visitors"], "No visits yet")],
		["Pages", rows(ai.pages.map((p) => page({ path: p.path, visitors: p.visitors })), ["Page they were sent to", "Visitors"], "No visits yet")],
	];
	return `<section class="card list tabbed ai"><h2>${title}</h2>${sum}${panes.map((_, i) => `<input type="radio" name="tai" id="tai-${i + 1}" class="t${i + 1}"${i ? "" : " checked"}>`).join("")}<div class="tabs">${panes.map(([label], i) => `<label for="tai-${i + 1}">${label}</label>`).join("")}</div>${panes.map(([, html], i) => `<div class="pane p${i + 1}">${html}</div>`).join("")}</section>`;
}

function longDate(day: string): string {
	return day ? new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
}

function shortDate(day: string): string {
	return day ? new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "";
}

/** "What's new": the three latest updates, each linking to its release note. */
function newsCard(): string {
	const items = NEWS.slice(0, 3)
		.map((n) => `<li><span class="news-day">${shortDate(n.day)}</span><a class="news-title" href="${CHANGES_URL}/tag/${n.id}" target="_blank" rel="noopener">${esc(n.title)}</a><p>${esc(n.text)}</p></li>`)
		.join("");
	return `<section class="card news"><h2>What's new in ReaderCount</h2><ul class="news-list">${items}</ul><a class="btn-out news-all" href="${CHANGES_URL}" target="_blank" rel="noopener">View full changelog</a></section>`;
}

/** Why the numbers differ from Google Analytics: folded away under the stats. */
function gaCard(): string {
	return `<details class="card ga-why"><summary>Why do my numbers differ from Google Analytics?</summary><p>It is completely normal for the figures to be different. ReaderCount will usually show higher numbers, and here is why:</p><ul><li><b>Cookie blocking:</b> Many visitors block Google Analytics or reject cookie consent banners. ReaderCount does not use cookies, so it counts these visitors regardless.</li><li><b>How visitors are counted:</b> Google uses cookies to track a single person across several days. ReaderCount resets each day, so returning visitors are counted once per day. Over a week or a month, returning readers will show up multiple times on ReaderCount.</li></ul><p>For the most accurate comparison between the two tools, look at daily page views.</p></details>`;
}

/** The official-style "Continue with Google" button that starts connecting Search Console. */
export const GOOGLE_BUTTON = `<a class="gs-btn" href="/google/connect" aria-label="Connect Google Search Console: continue with Google"><svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg><span>Continue with Google</span></a>`;

/** What the stats page shows about Google Search Console, when the Google link is set up. */
export type GoogleView = { state: GoogleState; report?: SearchReport };

function googleSection(g: GoogleView | undefined, demo: boolean, inSettings = false): string {
	if (!g) return "";
	if (!g.state.connected) {
		return `<section class="card gs"><h2>Organic Search Performance</h2><p class="gs-intro">Import Google Search Console query metrics to analyse search impressions, organic clicks, and average SERP positions.</p><p>${GOOGLE_BUTTON}</p><p class="gs-note">Clean Data Pledge: Read-only access, automated nightly sync, zero data commercialisation, zero AI training. Disconnecting permanently purges imported data. <a href="${REPO_URL}#google-search-console" target="_blank" rel="noopener">Read details</a></p></section>`;
	}
	const rep = g.report;
	const t = rep?.totals ?? { clicks: 0, impressions: 0, position: 0 };
	const rows = (rep?.queries ?? []).map((q) => [esc(q.query), num(Number(q.clicks)), num(Number(q.impressions)), String(q.position || "–")]);
	const synced = g.state.syncedAt ? new Date(g.state.syncedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "";
	const note = demo
		? "Integrated via Google Search Console."
		: `Integrated via Google Search Console. Google's figures arrive two or three days late.${synced ? ` Last copied ${synced}.` : " Copying now: refresh in a minute."}`;
	const problem = g.state.error ? `<p class="gs-err">${esc(g.state.error)} <a href="/google/connect">Connect again</a></p>` : "";
	// Sites in another Google account: Search Console lets that account add the connected one as a user, which needs nothing changed here.
	const missing =
		!demo && !g.state.error && g.state.syncedAt && rep?.property === null
			? `<p class="gs-err">We can't find this website in the Search Console of the Google account you connected. If it's in a different Google account, open Search Console there, go to Settings, then Users and permissions, and add the Google account you connected here as a user (Restricted is enough). Its figures then arrive with the next nightly copy.</p>`
			: "";
	const open = !demo && rep?.property ? ` <a href="${esc(consoleUrl(rep.property))}" target="_blank" rel="noopener">Open in Google Search Console ↗</a>` : "";
	const off = demo || inSettings ? "" : `<form method="post" action="/google/disconnect" class="gs-off"><button type="submit">Disconnect Google</button></form>`;
	const late = rep?.late ? `<p class="gs-note">Google hasn't sent figures for these dates yet, so this shows its latest week: ${shortDate(rep.from)} to ${shortDate(rep.to)}.</p>` : "";
	return `<section class="card gs"><h2>Organic Search Performance <small>(${num(t.clicks)} Clicks · ${num(t.impressions)} Impressions · Avg Position ${t.position || "–"})</small></h2>${problem}${missing}${late}<table><thead><tr><th>Organic Search Query</th><th class="n">Clicks</th><th class="n">Impressions</th><th class="n">Avg SERP Position</th></tr></thead><tbody>${
		rows.length ? rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="n"' : ""}>${c}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="4" class="empty">No Google searches for these dates yet</td></tr>`
	}</tbody></table><p class="gs-note">${note}${open}</p>${off}</section>`;
}

/** Claude.s connector settings, where a custom connector is added. */
export const CLAUDE_DIRECTORY = "https://claude.ai/settings/connectors";

/** The "Connect to Claude" button, which opens Claude.s connector settings. */
export const CLAUDE_BUTTON = `<a class="gs-btn cl-btn" href="${CLAUDE_DIRECTORY}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#D97757" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg><span>Connect to Claude</span></a>`;

function claudeSection(url: string | undefined, demo: boolean, signIn = false, connected = false): string {
	if (!url) return "";
	if (signIn) {
		const intro = `<h2>Ask Claude about your stats</h2><p class="gs-intro">Add ReaderCount to Claude, then ask things like "which posts did best this month?" or "what do people search on Google to find my reviews?". Claude can read your stats, never change them.</p>`;
		if (connected) return `<section class="card cl">${intro}<p class="ck-status ok">● Connected to Claude. Turn on ReaderCount in a chat and ask away.</p><form method="post" action="/claude/disconnect" class="gs-off"><button type="submit">Disconnect Claude</button></form></section>`;
		return `<section class="card cl">${intro}${CLAUDE_BUTTON}<p class="gs-note">Opens Claude.s connector settings. Click <b>Add custom connector</b>, name it <b>ReaderCount</b> and paste the address below. Then click <b>Connect</b>, sign in with your ReaderCount password and click <b>Allow</b>.</p>
<div class="cl-row"><input class="cl-url" readonly value="${esc(url)}" aria-label="The Claude connector address"><button type="button" class="cl-copy" data-copy>Copy</button></div></section>`;
	}
	const link = demo
		? `<input class="cl-url" readonly value="https://stats.example.com/mcp" aria-label="Your Claude connector address">`
		: `<input class="cl-url" readonly value="${esc(url)}" aria-label="Your Claude connector address"><button type="button" class="cl-copy" data-copy>Copy</button>`;
	return `<section class="card cl"><h2>Query Analytics via Claude AI</h2><p class="gs-intro">Connect ReaderCount to Claude to ask natural language questions such as "Which content generated the highest dwell time this month?" or "What search terms bring traffic to my security reviews?". Claude queries metrics via read-only access.</p>
<details${demo ? " open" : ""}><summary>Integration instructions</summary><ol class="cl-steps"><li>Within claude.ai, navigate to Settings › Connectors › <b>Add custom connector</b>.</li><li>Name the connector <b>ReaderCount</b> and paste your custom endpoint URL. Maintain confidentiality: anyone with this URL can query your traffic data.<div class="cl-row">${link}</div></li><li>Leave authentication set to <b>No sign-in</b>, click <b>Add</b>, and toggle ReaderCount active within your chat window.</li></ol></details></section>`;
}

export type DashboardOptions = {
	demo?: boolean;
	/** The public page at /share/<domain>: no settings, no private sections, and a "Counted by ReaderCount" link. */
	shared?: boolean;
	google?: GoogleView;
	claudeUrl?: string;
	/** "What to fix": posts worth working on, from findFixes. */
	fixes?: Fix[];
	/** Site health: what's wrong with the website now, worst first (src/health.ts). Never on public pages. */
	health?: HealthItem[];
	/** Notes on the chart (never on public pages). */
	notes?: ChartNotes;
	/** Posts published in the dates on screen, read from Ghost: marked on the chart. */
	posts?: { day: string; title: string }[];
	/** Post titles by page address, read from Ghost, shown in place of the address. */
	titles?: Map<string, string>;
	/** Signed in with a ReaderCount account: who, and the "Your websites" box. */
	account?: { email: string; sitesHtml: string; accountHtml?: string; claude?: boolean };
	/** What the chart shows (the stat tile picked). Default visitors. */
	metric?: Metric;
};

const FILTER_LABELS: Record<FilterKey, string> = { source: "Source", page: "Page", country: "Country", device: "Device", browser: "Browser", campaign: "Campaign" };

export function renderDashboard(r: Report, sites: string[], opts: DashboardOptions = {}): string {
	const t = r.totals;
	const metric = opts.metric ?? "visitors";
	const filters = r.filters ?? {};
	// Every link keeps the site, dates, chart and filters, changing only what it's for.
	const href = (change: Partial<Record<"site" | "range" | "metric" | FilterKey, string | null>>) => {
		const q = new URLSearchParams();
		const v: Record<string, string | null | undefined> = { site: r.site, range: r.range, metric: metric === "visitors" ? null : metric, ...filters, ...change };
		for (const [k, x] of Object.entries(v)) if (x) q.set(k, x);
		return esc("?" + q.toString());
	};
	// The demo's numbers are made up, so it can't narrow them down.
	const only = (key: FilterKey, value: unknown) => (opts.demo || value === null || value === undefined || value === "" ? undefined : href({ [key]: String(value) }));
	const link = (range: Range) => `<a href="${href({ range })}"${range === r.range ? ' aria-current="page"' : ""}>${RANGE_LABELS[range]}</a>`;
	const sitePicker =
		sites.length > 1
			? `<nav class="sites">${opts.account ? `<a href="/">Multi-Property Overview</a>` : ""}${sites.map((s) => `<a href="${esc(`?site=${encodeURIComponent(s)}&range=${r.range}`)}"${s === r.site ? ' aria-current="page"' : ""}>${esc(s)}</a>`).join("")}</nav>`
			: "";
	const tile = (m: Metric, value: string, extra = "") =>
		`<a class="stat${m === metric ? " on" : ""}" href="${href({ metric: m === "visitors" ? null : m })}#chart"${m === metric ? ' aria-current="true"' : ""}><div class="k">${METRIC_LABELS[m]}</div><div class="v">${value}</div>${extra ? `<div class="c">${extra}</div>` : ""}</a>`;
	const share = (n: number) => (t.visitors ? `${Math.max(Number(n) ? 1 : 0, Math.round((100 * Number(n)) / t.visitors))}%` : "");
	const dot = opts.demo ? "" : t.now ? '<span class="live" title="Someone is on the site now"></span>' : '<span class="live off" title="Nobody right now. Updates by itself"></span>';
	// Signed in, the pill opens the live view: who's on the site now and the pages they've seen today.
	const live = opts.account
		? `<a class="livepill" href="${esc(`/live?site=${encodeURIComponent(r.site)}`)}" title="Watch visitors move around the site live">${dot}Real-Time Active Visitors: <b>${num(t.now)}</b><span class="go">Watch live ›</span></a>`
		: `<span class="livepill">${dot}Real-Time Active Visitors: <b>${num(t.now)}</b></span>`;
	const chips = FILTER_KEYS.filter((k) => filters[k])
		.map((k) => `<a class="chip" href="${href({ [k]: null })}" title="Remove this filter">${FILTER_LABELS[k]}: <b>${esc(k === "country" ? country(filters[k]) : k === "source" ? sourceLabel(filters[k]) : filters[k])}</b><span aria-hidden="true">✕</span></a>`)
		.join("");
	const left = r.filtered ?? 0;
	const filteredNote = left >= FILTERED_NOTE_MIN ? `<p class="filtered-note"><b>Some traffic filtered.</b> We left ${num(left)} hits out of these numbers because they looked automated: sent from cloud servers, sent without a web page, or one visitor loading far more pages than a person could.</p>` : "";
	const toolbar = `${filteredNote}${opts.account ? unseenNote(r) : ""}<div class="toolbar">${live}${chips ? `<span class="fl">Filtered by</span>${chips}${Object.keys(filters).length > 1 ? `<a class="clear" href="${href(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])))}">Clear all</a>` : ""}` : opts.demo ? "" : `<span class="hint">Click any source, page, country, device or browser below to filter the whole page.</span>`}</div>`;

	const pageItem = (p: Row, extra = true): Item => {
		const path = String(p.path ?? "");
		const clicks = Number(p.clicks ?? 0);
		return {
			name: opts.titles?.get(path) ?? pageName(path),
			sub: path,
			value: Number(p.visitors),
			href: only("page", path),
			out: `https://${r.site}${path}`,
			extra: extra ? `${clicks ? `<span class="pc" title="${num(clicks)} outbound ${clicks === 1 ? "click" : "clicks"} from this page, ${Math.round((100 * clicks) / Math.max(1, Number(p.visitors)))} per 100 visitors">${num(clicks)} ${clicks === 1 ? "click" : "clicks"}</span>` : ""}<span class="tm">${duration(Number(p.secs ?? 0))}</span>` : undefined,
		};
	};
	const pagesCard = tabbed("tp", "Top Performing Landing Pages", [
		["Top Pages", rows(r.pages.map((p) => pageItem(p)), ["Landing Page Path", "Avg Dwell Time · Unique Visitors"], "Awaiting traffic data")],
		r.entries ? ["Entry Pages", rows(r.entries.map((p) => pageItem(p, false)), ["First page of the visit", "Unique Visitors"], "Awaiting traffic data")] : false,
		r.exits ? ["Exit Pages", rows(r.exits.map((p) => pageItem(p, false)), ["Last page of the visit", "Unique Visitors"], "Awaiting traffic data")] : false,
		r.earnings?.length ? ["Earnings", rows(r.earnings.map((e) => {
			const seen = Number(r.pages.find((p) => p.path === e.path)?.visitors ?? 0);
			return { name: pageName(e.path), sub: e.path, value: e.pence, out: `https://${r.site}${e.path}`, extra: `<span class="pc" title="Estimated from your affiliate reports, shared by each page's clicks to that shop">${seen ? `${pounds((e.pence * 1000) / seen)} per 1,000 readers` : "est."}</span>`, shown: pounds(e.pence) };
		}), ["Page", "Per 1,000 readers · Estimated earnings"], "No earnings yet")] : false,
	]);
	const m = r.money;
	const per = (pence: number, of: number, by: number) => (of ? pounds((pence * by) / of) : "");
	const moneyCard = !m || opts.shared
		? ""
		: tabbed("te", "Earnings Insights", [
				["By Source", rows(m.sources.map((x) => ({ name: sourceLabel(x.name), icon: iconFor(String(x.name)), value: x.pence, shown: pounds(x.pence), extra: x.visitors ? `<span class="pc" title="Earnings for every 1,000 readers from ${esc(sourceLabel(x.name))}">${per(x.pence, x.visitors, 1000)} per 1,000 readers</span>` : "", href: only("source", x.name) })), ["Where readers came from", "Per 1,000 readers · Earnings"], "No earnings from clicks yet")],
				m.searches.length ? ["Google Searches", rows(m.searches.map((x) => ({ name: x.name, sub: x.page, value: x.pence, shown: pounds(x.pence), extra: `<span class="pc">${num(x.clicks ?? 0)} clicks from Google</span>` })), ["Search · Post it led to", "Earnings"], "No earnings from Google searches yet")] : false,
				["Clicks Against Sales", rows(m.shops.map((x) => ({ name: x.name, icon: iconFor(x.name), tag: (x.clicks ?? 0) >= 30 && !x.pence ? `<span class="tag bad" title="Readers clicked through, but no sales came back in this period">No sales</span>` : "", value: x.pence || 0, shown: pounds(x.pence), extra: `<span class="pc">${num(x.clicks ?? 0)} clicks${x.clicks ? ` · ${per(x.pence, x.clicks, 100)} per 100 clicks` : ""}</span>` })), ["Shop", "Clicks · Per 100 clicks · Earnings"], "No affiliate clicks yet")],
				m.devices.length ? ["Phones and Computers", rows(m.devices.map((x) => ({ name: cap(x.name), value: x.pence, shown: pounds(x.pence), extra: `<span class="pc">${num(x.clicks ?? 0)} clicks${x.clicks ? ` · ${per(x.pence, x.clicks, 100)} per 100 clicks` : ""}</span>` })), ["Device", "Per 100 clicks · Earnings"], "No earnings yet")] : false,
				["Worth Updating", rows(m.update.map((x) => ({ name: pageName(x.path), sub: x.why, value: x.monthly, shown: `${pounds(x.monthly)} a month`, out: `https://${r.site}${x.path}`, href: only("page", x.path) })), ["Post earning well but slipping", "Earns a month"], "Nothing slipping: your best-earning posts are holding their place")],
				m.wrongCountry.length ? ["Wrong Country", rows(m.wrongCountry.map((x) => ({ name: x.store, icon: iconFor(x.store), sub: `${Math.round((100 * x.elsewhere) / x.clicks)}% of clicks come from readers outside ${country(x.country)}${x.top ? `, most from ${country(x.top)}` : ""}. Those clicks usually earn nothing: add a link to their own Amazon store.`, value: x.elsewhere, shown: `${num(x.elsewhere)} of ${num(x.clicks)}` })), ["Amazon store · Readers it can't pay for", "Clicks"], "")] : false,
			]);
	const sourcesCard = tabbed("ts", "Traffic Acquisition Channels", [
		["Sources", rows(r.sources.map((s) => ({ name: sourceLabel(s.name), sub: sourceNote(s.name), icon: iconFor(String(s.name)), value: Number(s.visitors), extra: share(Number(s.visitors)), href: only("source", s.name), ...sourceLinks(s.name, r.site) })), ["Acquisition Source", "Share · Unique Visitors"], "Awaiting traffic data")],
		r.campaigns.length ? ["UTM Campaigns", rows(r.campaigns.map((c) => ({ ...campaignLabel(c.name), value: Number(c.visitors), extra: share(Number(c.visitors)), href: only("campaign", c.name) })), ["Campaign Name (utm_campaign)", "Share · Unique Visitors"], "No campaigns yet")] : false,
	]);

	const aiCard = !r.ai || (opts.shared && !r.ai.visitors) ? "" : foundByAiCard(r.ai, t.visitors, (p) => pageItem(p, false), (name) => only("source", name));

	// Clicks grouped by the website they went to, so every Amazon or Fastmail link adds up in one row.
	const outbound = r.clicks.filter((c) => c.kind !== "download");
	const bySite = new Map<string, { name: string; affiliate: boolean; clicks: number; pages: Set<string> }>();
	for (const c of outbound) {
		const s = linkSite(String(c.target));
		const g = bySite.get(s.key) ?? { name: s.name, affiliate: false, clicks: 0, pages: new Set<string>() };
		g.clicks += Number(c.clicks);
		g.affiliate ||= s.affiliate;
		g.pages.add(String(c.path));
		bySite.set(s.key, g);
	}
	const AFF = `<span class="tag" title="Looks like an affiliate link, from its address">Affiliate</span>`;
	const sitesList: Item[] = [...bySite.values()]
		.sort((a, b) => b.clicks - a.clicks)
		.map((g) => ({ name: g.name, icon: iconFor(g.name), tag: g.affiliate ? AFF : "", sub: g.pages.size === 1 ? `from “${pageName([...g.pages][0])}”` : `from ${num(g.pages.size)} pages`, value: g.clicks }));
	const linkItem = (c: Row): Item => ({
		name: pageName(String(c.path)),
		sub: shortLink(String(c.target)),
		icon: iconFor(linkSite(String(c.target)).name),
		tag: linkSite(String(c.target)).affiliate ? AFF : "",
		value: Number(c.clicks),
		href: only("page", c.path),
		out: String(c.target),
	});
	const downloadsList = r.clicks.filter((c) => c.kind === "download").map((c) => ({ ...linkItem(c), name: decodeName(String(c.target)), sub: `from “${pageName(String(c.path))}”`, icon: `<span class="ic dl" aria-hidden="true">⬇</span>`, tag: "" }));
	const linksCard = tabbed("tl", "Outbound Link Events & Asset Downloads", [
		["By Destination", rows(sitesList, ["Destination Website", "Total Clicks"], "No outbound link events recorded yet")],
		["By Page", rows(outbound.map(linkItem), ["Originating Page · Target URL", "Total Clicks"], "No outbound link events recorded yet")],
		downloadsList.length ? ["Downloads", rows(downloadsList, ["Asset", "Total Clicks"], "No downloads yet")] : false,
		r.broken?.length
			? ["Broken links", rows(r.broken.flatMap((b) => {
					const said = b.status ? `answered ${b.status} since ${shortDate(utcDay(b.since))}` : `didn't answer since ${shortDate(utcDay(b.since))}`;
					return b.pages.map((p) => ({ name: b.target, nameLink: true, icon: iconFor(linkSite(b.target).name), tag: linkSite(b.target).affiliate ? AFF : "", sub: `On ${pageUrl(r.site, p.path)}, last clicked ${shortDate(p.last)} · ${said}`, subLinks: [pageUrl(r.site, p.path)], value: p.clicks, out: b.target }));
				}), ["Link that stopped working · Page it's on", "Clicks"], "No broken links")]
			: false,
	]);
	const goalsCard = r.goals === undefined ? "" : tabbed("tg", "Goals and Sign-Ups", [
		["Goals", rows(r.goals.map((g) => ({ name: String(g.name), tag: g.trigger ? `<span class="tag" title="Set up in Settings › Triggers">Trigger</span>` : "", value: Number(g.visitors), extra: `<span class="pc" title="${num(Number(g.completions))} completions">${num(Number(g.completions))}×</span>${t.visitors ? `<span class="tm" title="Share of visitors who completed it">${((100 * Number(g.visitors)) / t.visitors).toFixed(1)}%</span>` : ""}` })), ["Goal", "Completions · Conversion · Visitors"], opts.shared || opts.demo ? "No goals yet" : GOALS_HELP)],
		r.goalSources?.length ? ["By Source", rows(r.goalSources.map((g) => ({ name: sourceLabel(g.name), icon: iconFor(String(g.name)), value: Number(g.visitors), href: only("source", g.name) })), ["Where they came from", "Visitors who completed a goal"], "No goals yet")] : false,
		r.goalPages?.length ? ["By Page", rows(r.goalPages.map((g) => ({ name: pageName(String(g.path)), sub: String(g.path), value: Number(g.visitors), href: only("page", g.path) })), ["Page the goal happened on", "Visitors who completed a goal"], "No goals yet")] : false,
	]);
	const missingCard = !r.missing?.length || opts.shared
		? ""
		: tabbed("tm", "Missing Page Report", [
				["Not Found", rows(r.missing.map((m) => ({ name: String(m.path), sub: m.top_link ? `Broken link on your page ${pageUrl(r.site, String(m.top_link))}` : `Most came from ${String(m.top_from ?? "Direct")}`, subLinks: m.top_link ? [pageUrl(r.site, String(m.top_link))] : [], tag: m.top_link ? `<span class="tag bad" title="Readers followed a link on your own website to this missing page">Broken link</span>` : "", value: Number(m.views), out: `https://${r.site}${m.top_link ?? m.path}` })), ["Address visitors tried · Where from", "Hits"], "No missing pages")],
			]);
	const [engagementCard, problemsCard] = r.behaviour && !opts.shared ? behaviourCards(r.behaviour, r.site, (path) => opts.titles?.get(path) ?? pageName(path), (path) => only("page", path)) : ["", ""];
	const audienceCard = tabbed("ta", "Audience Distribution", [
		["Countries", rows(r.countries.map((c) => ({ name: country(c.name), icon: flag(c.name), value: Number(c.visitors), extra: share(Number(c.visitors)), href: only("country", c.name) })), ["Country", "Share · Unique Visitors"], "Awaiting traffic data")],
		["Devices", rows(r.devices.map((d) => ({ name: cap(d.name), value: Number(d.visitors), extra: share(Number(d.visitors)), href: only("device", d.name) })), ["Device Category", "Share · Unique Visitors"], "Awaiting traffic data")],
		["Browsers", rows(r.browsers.map((b) => ({ name: String(b.name), value: Number(b.visitors), extra: share(Number(b.visitors)), href: only("browser", b.name) })), ["Web Browser", "Share · Unique Visitors"], "Awaiting traffic data")],
	]);

	return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><link rel="icon" href="/favicon.ico?v=2" sizes="any"><link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=2">${opts.demo || opts.shared ? "" : APP_HEAD}<title>${esc(r.site)} · ${opts.shared ? "Public Traffic Metrics" : "ReaderCount Dashboard"}</title><style>${CSS}</style>${BTN_ICONS}</head><body>
<header>${opts.demo ? `<p class="demo">Interactive demo mode using sample traffic metrics. <a href="${HOME_URL}">Get ReaderCount</a> to count your own websites, free.</p>` : ""}${opts.shared ? `<p class="demo">Public analytics dashboard for <code>${esc(r.site)}</code>, published by the site owner. Privacy-first, cookie-free metrics. <a href="/share/${esc(r.site)}/media-kit.pdf" download>Download the media kit (PDF)</a></p>` : ""}<div class="brand">${opts.demo ? '<a href="/">Reader<span class="rc-c">Count</span></a>' : opts.shared ? '<a href="${HOME_URL}">Reader<span class="rc-c">Count</span></a>' : 'Reader<span class="rc-c">Count</span>'}</div>${opts.account ? accountBar(opts.account.email) : ""}<h1>${esc(r.site)}</h1>${sitePicker}<nav class="ranges">${(Object.keys(RANGES) as Range[]).map(link).join("")}</nav></header>
<main>
${toolbar}
<section class="stats">
${tile("visitors", num(t.visitors), vsBefore(t.visitors, r.previous.visitors, r.range, "visitor"))}
${tile("views", num(t.views), vsBefore(t.views, r.previous.views, r.range, "view"))}
${tile("time", duration(t.avgSeconds))}
${tile("bounce", t.visitors ? `${t.bounce}%` : "–")}
${t.clicks === undefined ? "" : tile("clicks", num(t.clicks), vsBefore(t.clicks, r.previous.clicks ?? 0, r.range, "click"))}
</section>
${opts.health && !opts.shared ? healthCard(opts.health) : ""}
${chart(r, metric, opts.shared ? undefined : opts.notes, opts.shared ? [] : opts.posts)}
${opts.fixes ? fixList(opts.fixes, r.site) : ""}
${pagesCard}
${moneyCard}
${sourcesCard}
${aiCard}
${linksCard}
${goalsCard}
${missingCard}
${problemsCard}
${engagementCard}
${audienceCard}
${googleSection(opts.google, Boolean(opts.demo || opts.shared), Boolean(opts.account))}
${opts.shared ? "" : newsCard()}
${opts.shared || opts.demo ? "" : gaCard()}
${opts.account ? downloads(r) : ""}
${opts.account?.sitesHtml ?? ""}
${opts.shared || opts.account ? "" : claudeSection(opts.claudeUrl, Boolean(opts.demo), false, false)}
${opts.account?.accountHtml ?? ""}
</main>
<footer>Reporting period: ${shortDate(r.from)} to ${shortDate(r.to)} (UTC). Zero tracking cookies, zero client data storage.${opts.demo ? "" : " Real-time background polling active (30s interval)."}${opts.shared ? ` <span class="counted">Powered by <a href="${HOME_URL}"><b>Reader<span class="rc-c">Count</span></b></a>: Privacy-first, cookie-free web analytics. <a href="${HOME_URL}">Get ReaderCount free</a></span>` : ""}</footer>
${opts.demo ? `<script>${COPY}${HOVER}</script>` : opts.shared ? `<script>${LIVE}${COPY}${HOVER}</script>` : `<script>${LIVE}${COPY}${TIP}${CHECK}${GO}${HOVER}</script>`}
</body></html>`;
}

// ---- Reader engagement, page speed and site problems (src/behaviour.ts) ----

const RATING_LABELS: Record<Rating, string> = { good: "Good", attention: "Needs attention", fix: "Requires fix" };
const ratingTag = (r: Rating | null, title = "") => (r ? `<span class="tag${r === "good" ? "" : r === "fix" ? " bad" : " mid"}"${title ? ` title="${esc(title)}"` : ""}>${RATING_LABELS[r]}</span>` : "");
const secs = (ms: number | null) => (ms === null ? "–" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const SPEED_TIP = "Google's Core Web Vitals, from real readers: Loading is when the biggest picture or block of text appeared, Response is the slowest reaction to a tap or click, Layout jumps is how much the page moved while loading. 3 in 4 readers had it this good or better.";

/** One line of speed figures: loading, response, layout jumps. */
function speedLine(s: SpeedRow): string {
	return `Loading ${secs(s.lcp)} · Response ${secs(s.inp)} · Layout jumps ${s.cls === null ? "–" : (s.cls / 1000).toFixed(2)}`;
}

export function behaviourCards(b: Behaviour, site: string, name: (path: string) => string, only: (path: string) => string | undefined): [string, string] {
	const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : "–");
	const reading = rows(
		b.reading.map((p) => ({ name: name(p.path), sub: p.path, value: p.avg, shown: `${p.avg}%`, href: only(p.path), out: `https://${site}${p.path}`, extra: `<span class="pc" title="Readers who got at least halfway down">${pct(p.half, p.views)} halfway</span><span class="tm" title="Readers who reached the end">${pct(p.end, p.views)} to the end</span>` })),
		["Page · How many read halfway · To the end", "Typical depth"],
		"Scroll depth appears here as readers visit. It needs the latest tracker, which every website gets by itself.",
	);
	const device = (label: string, d?: SpeedRow) => (d ? `<p class="sp-dev"><b>${label}</b> ${ratingTag(d.rating, SPEED_TIP)} <span>${speedLine(d)}</span></p>` : "");
	const speedHead = b.devices.phone || b.devices.computer ? `<div class="sp-sum">${device("On phones", b.devices.phone)}${device("On computers", b.devices.computer)}</div>` : "";
	const order: Record<string, number> = { fix: 0, attention: 1, good: 2 };
	const speed =
		speedHead +
		rows(
			[...b.speed].sort((x, y) => (order[x.rating ?? "good"] - order[y.rating ?? "good"]) || y.n - x.n).map((p) => ({ name: name(p.path), sub: speedLine(p), tag: ratingTag(p.rating, SPEED_TIP), value: p.n, href: only(p.path), out: `https://${site}${p.path}` })),
			["Page · Speed for 3 in 4 readers", "Visits measured"],
			"Page speed appears here once a few readers have visited. It's measured in their own browsers, so it shows what they really waited.",
		);
	const forms = b.forms.length
		? rows(
				b.forms.map((f) => ({ name: f.form.replace(/^Form: /, ""), sub: `${num(f.started)} started · ${num(f.sent)} sent`, tag: f.started >= 10 && f.sent / f.started < 0.3 ? `<span class="tag mid" title="Fewer than 3 in 10 people who started it sent it">Many give up</span>` : "", value: f.started, shown: pct(Math.min(f.sent, f.started), f.started) })),
				["Form · Started · Sent", "Sent"],
				"No forms yet",
			)
		: false;
	const engagement = tabbed("tr", "Reader Engagement & Page Speed", [["Scroll Depth", reading], ["Page Speed", speed], forms ? ["Form Drop-Off", forms] : false]);

	const onPages = (p: { pages: string[]; browsers: string[] }) => `${p.pages.length === 1 ? `On ${pageUrl(site, p.pages[0])}` : `On ${num(p.pages.length)} pages, such as ${pageUrl(site, p.pages[0])}`}${p.browsers.length ? ` · ${p.browsers.slice(0, 3).join(", ")}` : ""}`;
	const files = b.problems.filter((p) => p.kind !== "script");
	const scripts = b.problems.filter((p) => p.kind === "script");
	const fullNote = b.full ? `<p class="filtered-note"><b>Monthly limit reached.</b> Your plan's problem reports for this month are used up, so new problems will show from the 1st. Everything found so far is still here.</p>` : "";
	const problems = tabbed("tx", "Site Problems Seen by Readers", [
		["Broken Images & Files", fullNote + rows(files.map((p) => ({ name: p.url, nameLink: true, sub: onPages(p), subLinks: p.pages.slice(0, 1).map((x) => pageUrl(site, x)), tag: `<span class="tag bad">${p.kind === "image" ? "Picture" : "File"} didn't load</span>`, value: p.n, out: p.url })), ["Picture or file · Where", "Readers affected"], "No broken pictures or files. When one fails to load for a reader, it shows here with the page it's on.")],
		["Script Errors", fullNote + rows(scripts.map((p) => ({ name: p.message || "Script error", sub: `${p.url} · ${onPages(p)}`, subLinks: [p.url, ...p.pages.slice(0, 1).map((x) => pageUrl(site, x))], value: p.n, out: p.url })), ["Error · File · Where", "Times seen"], "No script errors. When the JavaScript on a page breaks in a reader's browser, it shows here.")],
	]);
	return [engagement, problems];
}

// ---- All websites: one row per website, for accounts with two or more ----

export type OverviewRow = { site: string; today: number; week: number; lastWeek: number; views: number; days: number[]; topSource: string };
export type Overview = { rows: OverviewRow[]; monthViews: number; month: string };


export async function buildOverview(db: D1Database, sites: string[], now: number): Promise<Overview> {
	const today = utcDay(now);
	const from14 = utcDay(now - 13 * 86_400_000);
	const from7 = utcDay(now - 6 * 86_400_000);
	const prevFrom = utcDay(now - 13 * 86_400_000);
	const prevTo = utcDay(now - 7 * 86_400_000);
	const month = today.slice(0, 7);
	const list = sites.map(() => "?").join(",");
	const all = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).bind(...sites, ...args).all<T>().then((r) => r.results ?? []);
	const V = "COUNT(DISTINCT visitor || day)";
	const [days, sources, monthRow] = await Promise.all([
		all<{ site: string; day: string; views: number; visitors: number }>(
			`SELECT site, day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM events WHERE kind = 'view' AND site IN (${list}) AND day >= ? AND day <= ? GROUP BY site, day`,
			from14, today,
		),
		all<{ site: string; name: string; visitors: number }>(
			`SELECT site, COALESCE(NULLIF(source, ''), 'Direct') AS name, ${V} AS visitors FROM events WHERE kind = 'view' AND site IN (${list}) AND day >= ? AND day <= ? GROUP BY site, name ORDER BY visitors DESC`,
			from7, today,
		),
		all<{ views: number }>(`SELECT COUNT(*) AS views FROM events WHERE kind = 'view' AND site IN (${list}) AND day >= ? AND day <= ?`, month + "-01", today),
	]);
	const rows = sites.map((site) => {
		const mine = days.filter((d) => d.site === site);
		const on = (from: string, to: string, key: "visitors" | "views") => mine.filter((d) => d.day >= from && d.day <= to).reduce((a, d) => a + Number(d[key]), 0);
		const series = Array.from({ length: 14 }, (_, i) => {
			const day = utcDay(now - (13 - i) * 86_400_000);
			return Number(mine.find((d) => d.day === day)?.visitors ?? 0);
		});
		return {
			site,
			today: on(today, today, "visitors"),
			week: on(from7, today, "visitors"),
			lastWeek: on(prevFrom, prevTo, "visitors"),
			views: on(from7, today, "views"),
			days: series,
			topSource: sources.find((r) => r.site === site)?.name ?? "",
		};
	});
	return { rows, monthViews: Number(monthRow[0]?.views ?? 0), month };
}

function sparkline(values: number[]): string {
	const W = 120, H = 32, max = Math.max(1, ...values);
	const pts = values.map((v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(H - 2 - (v / max) * (H - 4)).toFixed(1)}`).join(" ");
	return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

export function renderOverview(o: Overview, account: { email: string; sitesHtml: string; addHtml?: string; views: number; planName: string }): string {
	const limit = Math.max(1, account.views);
	const over = o.monthViews > limit;
	const used = Math.min(100, Math.round((o.monthViews / limit) * 100));
	const monthName = new Date(o.month + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
	const total = o.rows.reduce((a, r) => ({ today: a.today + r.today, week: a.week + r.week, lastWeek: a.lastWeek + r.lastWeek }), { today: 0, week: 0, lastWeek: 0 });
	const rows = o.rows
		.map(
			(r) => `<a class="ov-row" href="/?site=${encodeURIComponent(r.site)}"><span class="ov-site">${esc(r.site)}</span><span class="ov-n"><b>${num(r.today)}</b><small>visitors today</small></span><span class="ov-n"><b>${num(r.week)}${change(r.week, r.lastWeek)}</b><small>visitors (last 7 days)</small></span>${sparkline(r.days)}<span class="ov-src">${r.topSource ? `Top source: <b>${esc(r.topSource)}</b>` : "Awaiting initial traffic snippet execution"}</span><span class="ov-go" aria-hidden="true">›</span></a>`,
		)
		.join("");
	return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><link rel="icon" href="/favicon.ico?v=2" sizes="any"><link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=2">${APP_HEAD}<title>Multi-Property Overview · ReaderCount</title><style>${CSS}</style>${BTN_ICONS}</head><body>
<header><div class="brand">Reader<span class="rc-c">Count</span></div>${accountBar(account.email)}<h1>Multi-Property Overview</h1><nav class="sites"><a href="/" aria-current="page">Multi-Property Overview</a>${o.rows.map((r) => `<a href="/?site=${encodeURIComponent(r.site)}">${esc(r.site)}</a>`).join("")}</nav></header>
<main>
<section class="stats">
<div class="stat"><div class="k">Unique Visitors Today</div><div class="v">${num(total.today)}</div></div>
<div class="stat"><div class="k">Unique Visitors (Last 7 Days)</div><div class="v">${num(total.week)}${change(total.week, total.lastWeek)}</div></div>
<div class="stat"><div class="k">Registered Properties</div><div class="v">${o.rows.length}</div></div>
</section>
<section class="card ov"><h2>Registered Domain Properties</h2><p class="gs-intro">Summary metric comparison across registered properties. Select a domain to open its dedicated analytics dashboard.</p><div class="ov-list">${rows}</div>${account.addHtml ?? ""}</section>
<section class="card ov-month"><h2>Monthly Traffic Volume (${esc(monthName)})</h2><p class="gs-intro"><b>${num(o.monthViews)}</b> of ${num(limit)} page views across all your websites (${esc(account.planName)})${over ? `. That's over your plan this month. We keep counting; if it stays over for two months in a row, we'll email you about moving up. <a href="/plans">See plans</a>.` : "."}</p><div class="meter${over ? " over" : ""}" role="img" aria-label="${used}% of your monthly page views used"><span style="width:${used}%"></span></div></section>
${account.sitesHtml}
</main>
<footer>Reporting dates displayed in UTC. Zero tracking cookies, zero client data storage. Real-time background polling active (30s interval).</footer>
<script>${LIVE}${COPY}${TIP}${CHECK}</script>
</body></html>`;
}

// Keeps the page up to date: every 30 seconds while it's on screen (and straight away when you come back to it),
// fetch the same page again and swap in the new numbers, without reloading.
export const LIVE = `(function(){var busy=0;function tick(){var a=document.activeElement;if(busy||document.hidden||(a&&a.closest&&a.closest("main form")))return;busy=1;fetch(location.href,{credentials:"same-origin",cache:"no-store"}).then(function(r){return r.ok?r.text():null}).then(function(h){if(!h)return;var d=new DOMParser().parseFromString(h,"text/html"),m=d.querySelector("main");if(m){var o=document.querySelector("main"),open=[].map.call(o.querySelectorAll("details"),function(x){return x.open});var tabs=[].map.call(o.querySelectorAll("input[type=radio]:checked"),function(x){return x.id});[].forEach.call(m.querySelectorAll("details"),function(x,i){if(i<open.length)x.open=open[i]});tabs.forEach(function(id){var x=m.querySelector("#"+id);if(x)x.checked=true});o.replaceWith(m);if(window.rcAfterLive)rcAfterLive()}}).catch(function(){}).finally(function(){busy=0})}setInterval(tick,30000);document.addEventListener("visibilitychange",tick)})();`;

// Hover (or tap) over the chart: a box with that day's date and numbers, and the day's dot grows. Listens on the document, so it still works after the page updates itself.
const HOVER = `(function(){function hide(w){var t=w&&w.querySelector(".ctip");if(t)t.hidden=true;if(w)[].forEach.call(w.querySelectorAll(".pt.on"),function(r){r.classList.remove("on")})}function show(e){var h=e.target.closest&&e.target.closest("rect.hit"),w=e.target.closest&&e.target.closest(".chart-wrap");document.querySelectorAll(".chart-wrap").forEach(function(x){if(x!==w)hide(x)});if(!w)return;if(!h){hide(w);return}var t=w.querySelector(".ctip"),bars=w.querySelectorAll(".pt"),i=+h.getAttribute("data-i");[].forEach.call(bars,function(r,j){r.classList.toggle("on",j===i)});var lines=h.getAttribute("data-tip").split("\\n");t.innerHTML="";lines.forEach(function(l,k){var d=document.createElement(k?"div":"b");d.textContent=l;t.appendChild(d)});t.hidden=false;var wr=w.getBoundingClientRect(),hr=(bars[i]||h).getBoundingClientRect(),x=hr.left+hr.width/2-wr.left,tw=t.offsetWidth;t.style.left=Math.max(0,Math.min(wr.width-tw,x-tw/2))+"px"}document.addEventListener("pointermove",show);document.addEventListener("pointerdown",show);document.addEventListener("pointerleave",function(){document.querySelectorAll(".chart-wrap").forEach(hide)})})();`;

// The Copy button in the Claude box. Listens on the document, so it still works after the page updates itself.
// "Check it's working" on the setup box: asks /check and shows a green light, kept across live updates.
/** A Site Health "Show me" link opens the tab with the details, then the page scrolls to its card. */
const GO = `document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[data-tab]");if(!a)return;var c=document.querySelector(a.getAttribute("href"));if(!c)return;[].forEach.call(c.querySelectorAll(".tabs label"),function(l){if(l.textContent.trim()===a.getAttribute("data-tab"))l.click()})});`;
const CHECK = `(function(){var last=null;function show(){if(!last)return;var b=document.querySelector("[data-check]"),p=document.querySelector("[data-check-status]");if(!b||!p)return;p.textContent=(last.ok?"\\u25CF ":"")+last.message;p.className="ck-status "+(last.ok?"ok":"bad");b.textContent="Check again"}window.rcAfterLive=show;document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-check]");if(!b)return;b.disabled=true;b.textContent="Checking\\u2026";fetch("/check?site="+encodeURIComponent(b.getAttribute("data-check")),{credentials:"same-origin",cache:"no-store"}).then(function(r){return r.json()}).then(function(j){last={ok:!!j.ok,message:j.message||j.error||"Something went wrong. Please try again."}}).catch(function(){last={ok:false,message:"Couldn't check just now. Please try again."}}).finally(function(){var n=document.querySelector("[data-check]");if(n)n.disabled=false;show()})})})();`;
// Keeps an open "i" tooltip on the screen: near the right-hand edge it slides left instead of running off (and widening the page).
const TIP = `(function(){function fit(e){var t=e.target.closest&&e.target.closest(".tip");if(!t)return;t.style.setProperty("--tip-x","0px");var w=parseFloat(getComputedStyle(t,"::after").width)||0,r=t.getBoundingClientRect(),left=r.left-14,vw=document.documentElement.clientWidth,x=Math.min(0,vw-12-(left+w));if(left+x<12)x=12-left;t.style.setProperty("--tip-x",x+"px")}document.addEventListener("focusin",fit);document.addEventListener("mouseover",fit)})();`;
export const COPY = `document.addEventListener("click",function(e){if(e.target.closest&&e.target.closest(".tip")){e.preventDefault();return}var c=e.target.closest&&e.target.closest("[data-copy-text]");if(c){var w=c.getAttribute("data-copy-text"),z=c.getAttribute("title");navigator.clipboard&&navigator.clipboard.writeText(w).then(function(){c.setAttribute("title","Copied");c.classList.add("done");setTimeout(function(){c.setAttribute("title",z);c.classList.remove("done")},2000)});return}var b=e.target.closest&&e.target.closest("[data-copy]");if(!b)return;var i=b.parentNode.querySelector("input");i.select();(navigator.clipboard?navigator.clipboard.writeText(i.value):Promise.reject()).catch(function(){document.execCommand("copy")}).finally(function(){var t=b.getAttribute("data-label")||b.textContent;b.setAttribute("data-label",t);b.textContent="Copied";setTimeout(function(){b.textContent=t},2000)})});`;

/** "email-move-checklist.pdf" from a download's address. */
function decodeName(url: string): string {
	try {
		return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? url);
	} catch {
		return url.slice(0, 60);
	}
}

function shortLink(url: string): string {
	try {
		const u = new URL(url);
		const s = u.hostname.replace(/^www\./, "") + u.pathname;
		return s.length > 60 ? s.slice(0, 57) + "…" : s;
	} catch {
		return url.slice(0, 60);
	}
}

const pounds = (pence: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);

const GOALS_GUIDE = `${REPO_URL}#goals`;
// The Goals card before the first goal arrives: what goals are for, the one line to copy, and the full guide.
const GOALS_HELP = `<div class="goal-empty"><div class="ge-head"><span class="ge-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg></span><p class="ge-title">No goals yet</p></div><p class="ge-text">Count newsletter sign-ups, enquiries and sales, and see which pages and sources bring them in.</p><ol class="ge-steps"><li><b>Add this to any button, link or form</b><span class="cl-row"><input class="cl-url ge-code" readonly value='data-rc-goal="Newsletter sign-up"' aria-label="Goal code to copy"><button type="button" class="cl-copy" data-copy>Copy</button></span></li><li><b>Change the name to suit, then publish</b><span>It shows here as soon as someone uses it. Forms are counted on their own too.</span></li></ol><a class="ge-go" href="${GOALS_GUIDE}" target="_blank" rel="noopener">Read the goals guide</a></div>`;

function cap(s: unknown): string {
	const t = String(s ?? "");
	return t ? t[0].toUpperCase() + t.slice(1) : "Unknown";
}

export function accountBar(email: string): string {
	// "Get the app" stays hidden until the script in APP_HEAD knows this browser can install ReaderCount.
	return `<form method="post" action="/signout" class="who"><button type="button" class="get-app" data-rc-get data-icon="download" aria-expanded="false" hidden>Get the app</button><span>${esc(email)}</span><button type="submit">Sign out</button></form><p class="rc-how" data-rc-how role="note" hidden></p>`;
}

/** A plain ReaderCount page (sign-in, Allow Claude, first website) around some HTML. */
export function renderPage(title: string, html: string, status = 200, headers: Record<string, string> = {}, main = "msg"): Response {
	return new Response(
		`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><link rel="icon" href="/favicon.ico?v=2" sizes="any"><link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=2">${APP_HEAD}<title>${esc(title)} | ReaderCount</title><style>${CSS}</style>${BTN_ICONS}</head><body><main class="${main}"><div class="brand">Reader<span class="rc-c">Count</span></div>${html}</main></body></html>`,
		{ status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'", ...headers } },
	);
}

export function renderMessage(title: string, body: string, status = 200, heading = title): Response {
	return new Response(
		`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><link rel="icon" href="/favicon.ico?v=2" sizes="any"><link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=2">${APP_HEAD}<title>${esc(title)}</title><style>${CSS}</style>${BTN_ICONS}</head><body><main class="msg"><div class="brand">Reader<span class="rc-c">Count</span></div><h1>${esc(heading)}</h1><p>${body}</p></main></body></html>`,
		{ status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
	);
}

export const CSS = `
:root{--tint:#f4f7fd;--tint-line:#e3eaf8;--bg:#f6f5f2;--card:#fff;--ink:#1d1d1f;--mute:#6b6b70;--line:#e6e4df;--accent:#2f6fed;--bar:#dfe8fb;--up:#1a7f37;--down:#c2410c;--mid:#a16207}
@media (prefers-color-scheme:dark){:root{--tint:#1f2533;--tint-line:#2c3550;--bg:#121214;--card:#1c1c1f;--ink:#f2f2f3;--mute:#a1a1a8;--line:#2c2c30;--accent:#7aa2ff;--bar:#25304a;--up:#4ade80;--down:#fb923c;--mid:#facc15}}
*{box-sizing:border-box}html{overflow-x:clip;overscroll-behavior-x:none}body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif}
.gs{grid-column:1/-1}.gs-intro{color:var(--mute);margin:0 0 12px}.gs-btn{display:inline-flex;align-items:center;gap:10px;height:40px;padding:0 12px;background:#fff;border:1px solid #747775;border-radius:20px;color:#1f1f1f;font:500 14px/20px Roboto,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.25px;text-decoration:none}.gs-btn svg{width:20px;height:20px}.gs-btn:hover{box-shadow:0 1px 2px rgba(60,64,67,.3),0 1px 3px 1px rgba(60,64,67,.15)}@media (prefers-color-scheme:dark){.gs-btn{background:#131314;border-color:#8e918f;color:#e3e3e3}}.gs-note{color:var(--mute);font-size:13px;margin:10px 0 0}.gs-err{color:var(--down);font-weight:600}.gs-off{margin-top:8px}.gs-off button{background:none;border:0;padding:0;color:var(--mute);text-decoration:underline;font:inherit;font-size:13px;cursor:pointer}
.live{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--up);margin-left:4px;vertical-align:middle;animation:pulse 2s infinite}.live.off{background:var(--mute);opacity:.5;animation:none}@keyframes pulse{50%{opacity:.35}}
header,main,footer{max-width:1200px;margin:0 auto;padding:16px 20px}
.get-app[hidden],.rc-how[hidden],[data-rc-install][hidden]{display:none!important}.who .get-app{font-weight:600}.rc-how{clear:both;margin:0 0 12px;padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--card);font-size:14px}.rc-app{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 14px}.rc-app p{margin:0;flex:1 1 220px;font-weight:600}.device-other{margin:0 0 6px;color:var(--mute);font-size:14px}.device-steps{margin:0;padding-left:1.2em}.device-steps li{margin:0 0 6px}@media (display-mode:standalone){.device{display:none}}.btn-out{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:999px;padding:7px 14px;background:var(--card);color:var(--ink);font:inherit;font-size:14px;font-weight:600;text-decoration:none;cursor:pointer;list-style:none}.btn-out::-webkit-details-marker{display:none}.btn-out:hover{border-color:var(--accent);color:var(--accent)}.site-list{list-style:none;margin:0 0 14px;padding:0}.site-list li{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid var(--line)}.site-name{flex:1 1 160px;font-weight:600}.pill{font-size:13px;font-weight:600;border-radius:999px;padding:3px 10px;background:var(--bg);color:var(--mute)}.pill.ok{color:var(--up)}.pill.here{color:var(--accent)}details.setup,details.device{margin:0 0 14px}details.setup[open]>summary,details.device[open]>summary{margin-bottom:10px}.add-site label{display:block;font-weight:600;margin:4px 0 6px}.add-site input{flex:1;min-width:0;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}.acct-btns{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start}.acct-btns details[open]{flex-basis:100%}.mysites ul.site-list{padding:0}.cl summary.btn-out{color:var(--ink)}.cl summary.btn-out:hover{color:var(--accent)}.gs-off button{display:inline-flex;border:1px solid var(--line)!important;border-radius:999px;padding:7px 14px!important;background:var(--card)!important;color:var(--ink)!important;text-decoration:none!important;font-weight:600;font-size:14px!important}.ck{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:12px}.ck-status{margin:0;flex:1 1 220px;color:var(--mute)}.ck-status.ok,.ck-ok{color:var(--up);font-weight:600}.ck-status.bad{color:var(--ink)}.ck-btn{border:1px solid var(--line);border-radius:8px;padding:8px 14px;background:var(--card);color:var(--ink);font:inherit;font-weight:600;cursor:pointer}.ck-btn:disabled{opacity:.6;cursor:wait}.cl .gs-note{margin-bottom:10px}.cl{grid-column:1/-1}.cl summary{cursor:pointer;font-weight:600;color:var(--accent)}.cl-steps{margin:10px 0 0;padding-left:1.3em}.cl-steps li{margin:0 0 8px}.cl-row{display:flex;gap:8px;margin-top:6px}.hist-up{flex-wrap:wrap}.hist-up input[type=file]{min-width:0;max-width:100%}.cl-url{flex:1;min-width:0;font:13px ui-monospace,Menlo,monospace;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}.cl-shop{flex:1 1 200px;min-width:0;font:inherit;font-size:14px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}.cl-copy{border:0;border-radius:8px;padding:8px 14px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}.gh-form{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.msg.wide{max-width:760px;padding-top:6vh}.clients .card{margin:0 0 16px}.clients .cl-steps{list-style:none;padding:0}.clients .site-name .set-sub{font-weight:400;color:var(--mute);font-size:14px}.clients .brand-form select{font:inherit;font-size:14px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}.clients .brand-form label.inline{display:flex;align-items:center;gap:8px;font-weight:500}.clients .set-body>form{margin-bottom:12px}.btn-danger{background:#c0392b}.pill.wait{color:#b26b00}.brand-form{display:grid;gap:10px;margin:10px 0;max-width:520px}.brand-form label{display:grid;gap:4px;font-size:14px;font-weight:600}.brand-form input{font:inherit;font-size:14px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}.brand-form input[type=color]{width:64px;height:38px;padding:2px}.brand-form button{justify-self:start}.gh-form input{flex:1 1 220px;min-width:0;font:inherit;font-size:14px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}.lk i.p{background:none;border-top:2px dotted var(--accent);height:0}svg .np line{stroke:var(--accent);stroke-width:1.5;stroke-dasharray:2 4;vector-effect:non-scaling-stroke}
.who{float:right;display:flex;gap:10px;align-items:center;color:var(--mute);font-size:13px}.who button,.link-btn{background:none;border:0;padding:0;color:var(--accent);font:inherit;cursor:pointer;text-decoration:underline}
.f label{display:block;font-weight:600;margin:14px 0 6px}.f input[type=email],.f input[type=text],.f input[inputmode]{width:100%;font:inherit;font-size:17px;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)}.f .go,.f .no{margin-top:14px;border:0;border-radius:999px;padding:11px 20px;font:inherit;font-weight:650;cursor:pointer}.f .go{background:var(--accent);color:#fff}.f .no{background:var(--card);color:var(--ink);border:1px solid var(--line);margin-left:8px}.err{color:var(--down);font-weight:600}.hint{color:var(--mute);font-size:14px}.f ul{padding-left:1.2em}.mysites ul{margin:0 0 10px;padding-left:1.2em}.updates{margin:12px 0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg)}.updates label{display:flex;gap:8px;align-items:center;font-weight:600;cursor:pointer}.updates input{width:18px;height:18px;accent-color:var(--accent)}.updates .gs-note{margin:6px 0 0}.mysites .cl-row{margin-bottom:8px}.mysites input[name=domain]{flex:1;min-width:0;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
.settings-head{grid-column:1/-1;margin:36px 0 0;padding-top:26px;border-top:1px solid var(--line)}.settings-head h2{font-size:24px;margin:0 0 4px}.settings-head p{margin:0;color:var(--mute);font-size:15px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.set-card{grid-column:1/-1;padding:0}.set-head{padding:18px 20px 12px}.set-head h2{font-size:18px;margin:0}.set-head p{margin:4px 0 0;color:var(--mute);font-size:15px}
.set-row{display:flex;align-items:center;gap:16px;padding:14px 20px;border-top:1px solid var(--line);font-size:16px;margin:0}summary.set-row{cursor:pointer;list-style:none}summary.set-row::-webkit-details-marker{display:none}summary.set-row:hover{background:var(--bg)}.set-card>:last-child.set-row,.set-card>details:last-child>summary{border-radius:0 0 14px 14px}
.set-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}.set-title{font-weight:650;display:block}.set-title .tip{margin-left:8px;vertical-align:middle;margin-top:-3px}.set-sub{color:var(--mute);font-size:15px}.on{color:var(--up);font-weight:600}
.set-act{flex:0 0 auto;display:flex;align-items:center;gap:10px;justify-content:flex-end}.set-act form{margin:0}.set-act .pill{font-size:14px}
.set-open::after{content:"";width:7px;height:7px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg);margin:-4px 0 0 10px;transition:transform .15s}details[open]>summary .set-open::after{transform:rotate(225deg);margin-top:5px}details[open]>summary .set-open{border-color:var(--accent);color:var(--accent)}
.set-body{padding:2px 20px 20px;font-size:15px}.set-body .gs-intro{color:var(--ink)}.set-manual{margin-top:6px}.set-manual summary{cursor:pointer;color:var(--accent);font-weight:600}.set-manual[open]{color:var(--ink)}
.site-row .site-name{flex:1 1 160px;font-weight:650}.ov .add-site{padding:16px 0 0;margin-top:6px}.set-elsewhere{grid-column:1/-1;margin:0;color:var(--mute);font-size:15px}.set-elsewhere a{color:var(--accent);font-weight:600}.add-site label.set-title{display:block;margin:0}.add-fields{flex:1 1 380px;max-width:520px}.add-fields input{flex:1;min-width:0;font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
.tip{position:relative;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1.5px solid var(--mute);color:var(--mute);font:italic 700 12px/1 Georgia,"Times New Roman",serif;cursor:help;flex:0 0 auto;user-select:none}.tip:hover,.tip:focus{border-color:var(--accent);color:var(--accent);outline:none}
.tip::after{content:attr(data-tip);position:absolute;left:calc(-14px + var(--tip-x,0px));box-sizing:border-box;bottom:calc(100% + 10px);width:max-content;max-width:min(320px,78vw);padding:11px 13px;border-radius:10px;background:var(--ink);color:var(--bg);font:400 14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:left;white-space:normal;box-shadow:0 8px 24px rgba(0,0,0,.2);display:none;z-index:20;pointer-events:none}.tip:hover::after,.tip:focus::after{display:block}.tip-demo{cursor:default}.tip-demo::after{display:none}
.switch{position:relative;display:inline-block;width:48px;height:28px;cursor:pointer}.switch input{position:absolute;inset:0;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:1}.switch span{position:absolute;inset:0;border-radius:99px;background:#c8c6c1;transition:background .15s}.switch span::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .15s}.switch input:checked+span{background:var(--up)}.switch input:checked+span::after{transform:translateX(20px)}.switch input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}@media (prefers-color-scheme:dark){.switch span{background:#4a4a50}}
.news{display:flex;flex-direction:column}.news-list{list-style:none;margin:0 0 14px;padding:0}.news-list li{padding:10px 0;border-bottom:1px solid var(--line)}.news-list li:first-child{padding-top:0}.news-day{display:block;color:var(--mute);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}.news-title{font-weight:650;color:var(--ink);text-decoration:none;font-size:15px}.news-title:hover{color:var(--accent);text-decoration:underline}.news-list p{margin:2px 0 0;color:var(--mute);font-size:14px}.news-all{align-self:flex-start;margin-top:auto}
@media (max-width:600px){.set-row{flex-wrap:wrap;gap:10px 14px}.set-text{flex:1 1 200px}.set-act{justify-content:flex-start}.add-fields{flex:1 1 100%;max-width:none;min-width:0}.add-fields input{width:0}.set-row{padding:14px 16px}.set-head{padding:16px 16px 10px}.set-body{padding:2px 16px 18px}}
.ga-why{grid-column:1/-1}.ga-why summary{cursor:pointer;font-weight:650;font-size:17px}.ga-why[open] summary{margin-bottom:10px}.ga-why p,.ga-why li{color:var(--ink);font-size:15px}.ga-why ul{padding-left:1.2em}
.fix-head{margin:0 0 16px}.fix-head h2{margin:0 0 4px}.fix-head p{margin:0;color:var(--mute);font-size:15px}.fix-list{list-style:none;margin:0;padding:0;display:grid;gap:12px}.fix{display:flex;gap:14px;align-items:flex-start;border:1px solid var(--line);border-radius:14px;padding:16px 18px;background:var(--card)}.fix-ico{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--tint);color:var(--accent)}.fix.slipping .fix-ico,.fix.losing .fix-ico,.fix.bounce .fix-ico{background:color-mix(in srgb,var(--down) 12%,transparent);color:var(--down)}.fix.page-two .fix-ico{background:color-mix(in srgb,var(--up) 12%,transparent);color:var(--up)}.fix-body{min-width:0;flex:1}.fix-tag{margin:0 0 2px;font-size:13px;font-weight:700;color:var(--mute)}.fix.slipping .fix-tag,.fix.losing .fix-tag,.fix.bounce .fix-tag{color:var(--down)}.fix.page-two .fix-tag{color:var(--up)}.fix-tag{letter-spacing:0}.fix-page{display:block;font-size:17px;font-weight:700;color:var(--ink);text-decoration:none;overflow-wrap:anywhere}.fix-page:hover{color:var(--accent)}.fix-page small{display:block;font-size:13px;font-weight:500;color:var(--mute)}.fix-what{margin:8px 0 10px;color:var(--ink);line-height:1.5}.fix-todo{margin:0;padding:10px 12px;border-radius:10px;background:var(--tint);border:1px solid var(--tint-line);line-height:1.5}.fix-todo b{display:block;font-size:12px;font-weight:750;letter-spacing:.05em;text-transform:uppercase;color:var(--accent);margin:0 0 2px}.hl-ok{margin:0 0 16px;padding:12px 16px;border-radius:12px;background:var(--tint);border:1px solid var(--tint-line);color:var(--ink)}.hl-ok span{color:var(--up);font-weight:800}.hl-list{list-style:none;margin:0;padding:0;display:grid;gap:10px}.hl{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line);border-radius:12px;padding:12px 14px}.hl.fix{border-color:color-mix(in srgb,var(--down) 40%,var(--line))}.hl .tag{flex:none;margin:2px 0 0}.hl p{margin:4px 0 0;color:var(--mute);line-height:1.5}.ln{color:var(--accent);text-decoration:underline;overflow-wrap:anywhere}.hl-go{display:inline-block;margin-top:6px;font-weight:700;color:var(--accent);text-decoration:none}.hl-go:hover{text-decoration:underline}.aff-h{margin:18px 0 6px;font-size:16px}.aff-h:first-child{margin-top:0}.tr-list{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:8px}.tr-item{display:flex;gap:12px;align-items:center;justify-content:space-between;border:1px solid var(--line);border-radius:10px;padding:10px 12px}.tr-item small{display:block;color:var(--mute);overflow-wrap:anywhere}.tr-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;align-items:end;margin:0 0 10px}.tr-form label{display:grid;gap:4px;font-size:14px;font-weight:600}.tr-form .tr-wide{grid-column:1/-1}.tr-form input,.tr-form select{width:100%;min-width:0;box-sizing:border-box;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}.fix-none{margin:0;padding:14px 16px;border-radius:12px;background:var(--tint);color:var(--ink)}.fix-none span{color:var(--up);font-weight:800;margin-right:6px}.news-list{display:grid;gap:12px}.news-list li,.news-list li:first-child,.news-list li+li{background:var(--tint);border:1px solid var(--tint-line);border-radius:12px;padding:14px 16px}.ga-why ul{list-style:none;padding:0;display:grid;gap:10px}.ga-why li{background:var(--tint);border:1px solid var(--tint-line);border-radius:12px;padding:12px 16px}
@media print{.news,.ga-why{display:none!important}}
.trial{display:block;max-width:1080px;padding:6vh 20px 60px}.trial .hint a{color:var(--accent)}.trial .pill2{display:inline-flex;gap:8px;align-items:center;font-size:14px;font-weight:600;color:var(--accent);background:var(--tint);border:1px solid var(--tint-line);border-radius:999px;padding:5px 14px;margin:22px 0 0}.trial .pill2 b{color:var(--ink)}
.trial h1{font-size:clamp(34px,5vw,52px);line-height:1.05;letter-spacing:-.03em;margin:14px 0 12px}.trial h1 em{font-style:normal;color:var(--accent)}.trial .lede{font-size:20px;max-width:680px;margin:0 0 30px}
.split{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:24px;align-items:start}.split>*{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:26px}
.split .f label:first-of-type{margin-top:0}.split .f .go{width:100%;font-size:18px;padding:14px 20px;margin-top:14px}.steps{list-style:none;counter-reset:s;margin:22px 0 4px;padding:0;display:grid;gap:12px}.steps li{counter-increment:s;display:flex;gap:12px;align-items:flex-start;font-size:16px}.steps li::before{content:counter(s);flex:none;width:28px;height:28px;border-radius:50%;background:var(--tint);color:var(--accent);font-weight:750;display:grid;place-items:center;font-size:14px}.steps b{display:block}.steps span span{display:block;color:var(--mute);font-size:15px}
.have{margin:18px 0 0;padding-top:16px;border-top:1px solid var(--line);font-size:16px}.have a,.trial-faq a,.side a{color:var(--accent);font-weight:600}
.side .cap{margin:0 0 14px;font-weight:700;font-size:18px}.side .cap span{color:var(--accent)}.inc{list-style:none;margin:0;padding:0;display:grid;gap:14px}.inc li{display:flex;gap:12px;align-items:flex-start}.inc .ic{width:34px;height:34px;flex:none;border-radius:10px;display:grid;place-items:center;background:var(--tint);color:var(--accent)}.inc .ic svg{width:19px;height:19px}.inc b{display:block;font-size:16.5px}.inc small{display:block;color:var(--mute);font-size:15px;line-height:1.4}.side .then{margin:18px 0 0;padding-top:14px;border-top:1px solid var(--line);font-size:16px}
.trial-faq{margin:44px 0 0;max-width:820px}.trial-faq h2{font-size:26px;margin:0 0 10px}.trial-faq details{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 18px;margin-bottom:10px}.trial-faq summary{cursor:pointer;font-weight:650}.trial-faq p{margin:10px 0 0;font-size:16px}
@media (max-width:820px){.split{grid-template-columns:minmax(0,1fr)}.split>*{padding:22px 18px}.trial .lede{font-size:18px}}
.brand{font-weight:750;color:var(--ink);letter-spacing:-.01em;font-size:21px}
h1{margin:6px 0 14px;font-size:clamp(30px,4.4vw,40px);font-weight:800;letter-spacing:-.02em}
nav{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
nav a{padding:8px 16px;border-radius:999px;background:var(--card);border:1px solid var(--line);color:var(--ink);text-decoration:none;font-size:16px;font-weight:600}
nav a[aria-current]{background:var(--accent);color:var(--card);border-color:var(--accent)}
main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}
.stats{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));background:var(--card);border:1px solid var(--line);border-radius:18px;overflow:hidden}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px 24px}.stat{position:relative;display:block;padding:20px 22px 18px;color:var(--ink);text-decoration:none;border-right:1px solid var(--line);margin-right:-1px}.stat:hover{background:var(--bg)}.stat.on{background:color-mix(in srgb,var(--accent) 7%,var(--card))}.stat.on::before{content:"";position:absolute;left:0;right:0;top:0;height:5px;background:var(--accent)}.stat.on .k{color:var(--accent)}.stat .c{margin-top:2px}.stat .c .chg{margin:0;font-size:15px}
.stat .k{color:var(--ink);font-size:16px;font-weight:650}.stat .v{font-size:40px;font-weight:800;letter-spacing:-.03em;line-height:1.15;margin-top:4px;font-variant-numeric:tabular-nums}
.chg{font-size:13px;font-weight:600;margin-left:8px;color:var(--mute)}.chg.up{color:var(--up)}.chg.down{color:var(--down)}
.wide{grid-column:1/-1}
h2{font-size:21px;font-weight:800;letter-spacing:-.01em;margin:0 0 12px}h2 small{font-size:15px;font-weight:500;color:var(--mute);margin-left:6px;letter-spacing:0}
.chart-wrap{position:relative;margin-top:8px}.ctip{position:absolute;top:-6px;transform:translateY(-100%);z-index:20;pointer-events:none;width:max-content;max-width:260px;padding:10px 13px;border-radius:10px;background:var(--ink);color:var(--bg);font-size:15px;line-height:1.45;box-shadow:0 8px 24px rgba(0,0,0,.22)}.ctip b{display:block;font-size:15px;margin-bottom:2px}

table{width:100%;border-collapse:collapse;font-size:16px}th{text-align:left;color:var(--mute);font-weight:600;font-size:14px;padding:4px 0;border-bottom:1px solid var(--line)}
td{padding:6px 0;border-bottom:1px solid var(--line);position:relative;max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
th.n,td.n{text-align:right;width:1%;max-width:none;overflow:visible;padding-left:12px;font-variant-numeric:tabular-nums}
.wide td.n:nth-child(2){text-align:left;max-width:0;overflow:hidden;width:35%}
td a{color:var(--ink);text-decoration:none}td a:hover{text-decoration:underline}
.bar{position:absolute;left:0;top:4px;bottom:4px;width:var(--w);background:var(--bar);border-radius:4px;z-index:0}.lbl{position:relative;padding-left:6px}
.empty{color:var(--mute);text-align:center;padding:18px 0}
.goal-empty{padding:6px 0 4px}.ge-ico{display:grid;place-items:center;width:48px;height:48px;border-radius:14px;background:var(--tint);border:1px solid var(--tint-line);color:var(--accent);flex:none}.ge-head{display:flex;align-items:center;gap:14px;margin:0 0 10px}.ge-title{margin:0;font-size:22px;font-weight:750;letter-spacing:-.01em}.ge-text{margin:0 0 18px;color:var(--ink);font-size:17px;line-height:1.5}.ge-steps{list-style:none;counter-reset:ge;margin:0 0 20px;padding:0;display:grid;gap:12px}.ge-steps li{counter-increment:ge;position:relative;padding:14px 16px 14px 56px;border-radius:12px;background:var(--tint);border:1px solid var(--tint-line)}.ge-steps li::before{content:counter(ge);position:absolute;left:16px;top:13px;width:26px;height:26px;border-radius:50%;background:var(--accent);color:var(--card);font-weight:750;font-size:14px;display:grid;place-items:center}.ge-steps b{display:block;font-size:17px;margin:0 0 6px}.ge-steps li>span:not(.cl-row){display:block;color:var(--ink);font-size:16px;line-height:1.45}.ge-steps .cl-row{margin:0}.ge-code{font-size:15px;background:var(--card)}.ge-go{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:11px 20px;background:var(--accent);color:var(--card);font-weight:650;text-decoration:none}.ge-go:hover{filter:brightness(1.08)}.ge-go::after{content:"→"}@media (max-width:520px){.ge-steps li{padding-left:16px;padding-top:48px}.ge-steps li::before{top:14px}.ge-steps .cl-row{flex-wrap:wrap}.ge-code{flex-basis:100%}}
.ai-sum{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;margin:0 0 12px;padding:12px 14px;border-radius:12px;background:var(--tint);border:1px solid var(--tint-line)}.ai-sum p{margin:0;flex:1 1 180px;line-height:1.35}.ai-sum p b{font-size:26px;font-weight:750;color:var(--ink)}.ai-spark{flex:1 1 160px;height:40px;color:var(--accent);fill:currentColor}
footer{color:var(--mute);font-size:14px}
.demo{background:var(--bar);border-radius:10px;padding:10px 14px;margin:0 0 14px;font-size:14px}.demo a{color:var(--accent)}.brand a{color:var(--ink);text-decoration:none}
.msg{display:block;max-width:520px;padding-top:15vh}.rc-start{margin:16px 0 20px;padding:14px 18px;border:2px solid var(--accent);border-radius:16px;background:var(--card)}.rc-start summary{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;cursor:pointer;list-style:none}.rc-start summary::-webkit-details-marker{display:none}.rc-start-badge{display:inline-flex;align-items:center;background:var(--accent);color:#fff;font-weight:700;font-size:12px;padding:4px 10px;border-radius:999px}.rc-start-badge svg{width:14px;height:14px;margin-right:5px}.rc-start-t{font-weight:700;font-size:18px;flex:1 1 auto}.rc-start-hide,.rc-start-show{color:var(--mute);font-size:14px;font-weight:600}.rc-start[open] .rc-start-show,.rc-start:not([open]) .rc-start-hide{display:none}.rc-start-lede{margin:8px 0 0;color:var(--mute);font-size:15px}.rc-start ol{list-style:none;counter-reset:rcs;margin:12px 0 0;padding:0;display:grid;gap:10px}.rc-start li{counter-increment:rcs;display:grid;grid-template-columns:26px 1fr;column-gap:9px;font-size:15px;align-content:start}.rc-start li::before{content:counter(rcs);grid-row:1/3;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:13px;background:var(--bg);color:var(--accent);border:1px solid var(--line)}.rc-start li.done::before{content:"✓";color:var(--up)}.rc-start li b{padding-top:3px}.rc-start li span{color:var(--mute)}.rc-start-row{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0}.rc-start-btn{display:inline-flex;align-items:center;border-radius:999px;padding:8px 15px;font-size:14px;font-weight:650;text-decoration:none}.rc-start-btn.go{background:var(--accent);color:#fff;border:0}.rc-start-btn.btn-out{padding:8px 15px}.plans{display:grid;gap:14px;margin:20px 0}.plan{border:1px solid var(--line);border-radius:14px;padding:16px 18px;background:var(--card)}.plan h2{margin:0 0 4px}.plan ul{padding-left:1.2em;margin:8px 0}.plan-price{margin:0;color:var(--mute)}.plan-price b{color:var(--ink);font-size:22px}.plan-now{color:var(--up);font-weight:650}.cur-switch{display:inline-flex;gap:4px;margin:4px 0 0;padding:4px;border:1px solid var(--line);border-radius:999px;background:var(--card)}.cur-switch a{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;color:var(--mute);font-weight:600;text-decoration:none}.cur-switch a span{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--line);font-size:12px}.cur-switch a[aria-current]{background:var(--ink);color:var(--card)}.cur-switch a[aria-current] span{background:var(--card);color:var(--ink)}.plan .f .no{margin-left:8px}.msg a{color:var(--accent)}

.counted{display:block;margin-top:8px}.counted a{color:var(--accent)}
svg rect.imp{fill-opacity:.38}.key{display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--accent);vertical-align:-1px;margin-right:6px}.key.imp{opacity:.38}svg .nt line{stroke:var(--down);stroke-width:1.5;stroke-dasharray:3 3;vector-effect:non-scaling-stroke}svg .nt .nt-dot{stroke-width:9;stroke-dasharray:none;stroke-linecap:round}.notes{margin-top:10px}.nt-list{list-style:none;margin:0 0 10px;padding:0}.nt-list li{display:flex;gap:10px;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--line)}.nt-day{flex:0 0 auto;font-weight:650;color:var(--down);font-size:13px}.nt-text{flex:1;min-width:0;overflow-wrap:anywhere}.nt-list form{flex:0 0 auto}.nt-list .link-btn{font-size:13px;color:var(--mute)}.nt-add .cl-row input{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}.nt-add .cl-row input[name=text]{flex:1;min-width:0}.api-add input[name=name]{flex:1;min-width:0;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}@media (max-width:520px){.nt-add .cl-row{flex-wrap:wrap}.nt-add .cl-row input[name=text]{flex-basis:100%}}
.unseen summary{cursor:pointer}.unseen summary::marker{color:var(--accent)}.uv-list{list-style:none;margin:10px 0 0;padding:0;font-size:14px}.uv-list li{padding:6px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.uv-show{color:var(--accent);font-weight:600}.uv-when{color:var(--mute);font-variant-numeric:tabular-nums}.uv-path{display:block;color:var(--mute)}.filtered-note{grid-column:1/-1;margin:0;padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--mute);font-size:15px}.filtered-note b{color:var(--ink)}.toolbar{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:10px}.livepill{display:inline-flex;align-items:center;gap:10px;background:var(--tint);border:2px solid var(--tint-line);border-radius:999px;padding:11px 22px;font-size:19px;font-weight:650;box-shadow:0 2px 10px rgba(47,111,237,.08)}.livepill b{font-size:26px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}.livepill .live{margin:0;width:12px;height:12px}a.livepill{color:var(--ink);text-decoration:none}a.livepill:hover{border-color:var(--accent)}a.livepill .go{color:#fff;background:var(--accent);font-weight:650;font-size:15px;margin-left:4px;padding:6px 14px;border-radius:999px}@media (max-width:600px){.livepill{flex-wrap:wrap;width:100%;box-sizing:border-box;border-radius:16px;padding:14px 18px;font-size:18px}a.livepill .go{margin:4px 0 0;flex:1 1 100%;text-align:center;padding:9px 14px}}.toolbar .hint{color:var(--mute);font-size:15px}.fl{color:var(--mute);font-size:15px;font-weight:600}
.chip{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:var(--card);border-radius:999px;padding:7px 10px 7px 14px;font-size:16px;text-decoration:none}.chip span{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.25);font-size:12px}.chip:hover span{background:var(--down);color:#fff}.clear{color:var(--accent);font-size:15px;font-weight:600}
.legend{display:flex;flex-wrap:wrap;align-items:center;gap:8px 18px;font-size:15px;font-weight:600;color:var(--ink)}.lk{display:inline-flex;align-items:center;gap:8px}.lk i{display:inline-block;width:22px;height:4px;border-radius:2px;background:var(--accent)}.lk i.d{height:0;background:none;border-top:3px dashed var(--mute)}.since{margin-left:auto;font-size:14px;font-weight:700;background:color-mix(in srgb,#f59e0b 22%,var(--card));color:var(--ink);padding:4px 12px;border-radius:999px}
.plot{position:relative;height:280px;margin:14px 0 0 46px;color:var(--accent)}.plot svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;display:block}.gl{position:absolute;left:0;right:0;border-top:1px solid var(--line)}.gl span{position:absolute;right:calc(100% + 10px);transform:translateY(-50%);color:var(--mute);font-size:13px;font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}
.plot .area{fill:url(#rc-fill)}.plot .ln{fill:none;stroke:var(--accent);stroke-width:3.5;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}.plot .prev{fill:none;stroke:var(--mute);stroke-width:2;stroke-dasharray:6 6;opacity:.7;vector-effect:non-scaling-stroke}.plot .pt{stroke:var(--accent);stroke-width:11;stroke-linecap:round;vector-effect:non-scaling-stroke}.plot .pt.imp{opacity:.4}.plot .vl{position:absolute;transform:translate(-50%,calc(-100% - 12px));color:var(--ink);font-size:14px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;pointer-events:none}.plot .vl.first{transform:translate(0,calc(-100% - 12px))}.plot .vl.last{transform:translate(-100%,calc(-100% - 12px))}.chartcard .plot{margin-top:34px}.plot .pt.on{stroke-width:17}.plot rect.hit{fill:transparent;cursor:crosshair}
.xaxis{position:relative;height:22px;margin:8px 0 0 46px;color:var(--mute);font-size:13px;font-weight:600}.xaxis span{position:absolute;top:0;transform:translateX(-50%);white-space:nowrap}.xaxis span.first{transform:none}.xaxis span.last{transform:translateX(-100%)}
.plot .nt line{stroke:var(--down);stroke-width:1.5;stroke-dasharray:3 3;vector-effect:non-scaling-stroke}
.list h2{margin-bottom:6px}.tabbed>input{position:absolute;opacity:0;pointer-events:none}.tabs{display:flex;flex-wrap:wrap;gap:4px 20px;border-bottom:1px solid var(--line);margin:4px 0 6px}.tabs label{padding:4px 0 10px;font-size:16px;font-weight:700;color:var(--mute);cursor:pointer}.tabs label:hover{color:var(--ink)}
.pane{display:none}.t1:checked~.p1,.t2:checked~.p2,.t3:checked~.p3,.t4:checked~.p4,.t5:checked~.p5{display:block}.t1:checked~.tabs label:nth-child(1),.t2:checked~.tabs label:nth-child(2),.t3:checked~.tabs label:nth-child(3),.t4:checked~.tabs label:nth-child(4),.t5:checked~.tabs label:nth-child(5){color:var(--ink);box-shadow:inset 0 -3px 0 var(--accent)}.t1:focus-visible~.tabs label:nth-child(1),.t2:focus-visible~.tabs label:nth-child(2),.t3:focus-visible~.tabs label:nth-child(3){outline:2px solid var(--accent);outline-offset:2px}
.colh{display:flex;justify-content:space-between;gap:12px;color:var(--mute);font-size:14px;font-weight:600;padding:8px 2px 4px}
.rows{display:grid;grid-template-columns:minmax(0,1fr);gap:5px}.row{position:relative;display:flex;align-items:center;gap:12px;min-height:46px;padding:8px 12px;border-radius:10px;font-size:17px;overflow:hidden;background:color-mix(in srgb,var(--bar) 35%,var(--card))}.row .b{position:absolute;left:0;top:0;bottom:0;background:var(--bar);z-index:0}.row>:not(.b){position:relative;z-index:1}
.row .nm{flex:1;min-width:0;color:var(--ink);font-weight:600;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;position:static}.row .nm small{display:block;color:var(--mute);font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis}a.nm::after{content:"";position:absolute;inset:0;border-radius:10px;z-index:1}.row:has(a.nm):hover{outline:2px solid color-mix(in srgb,var(--accent) 45%,transparent)}
.row .out{z-index:2;display:inline-flex;align-items:center;border:0;background:none;font:inherit;cursor:pointer;color:var(--mute);text-decoration:none;font-weight:700;padding:2px 4px}.row .out:hover,.row .out.done{color:var(--accent)}.row .x{display:flex;align-items:center;gap:10px;color:var(--mute);font-size:15px;font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}.row .v{min-width:40px;text-align:right;font-weight:750;font-variant-numeric:tabular-nums}
.ic{display:grid;place-items:center;flex:0 0 auto;width:28px;height:28px;border-radius:7px;color:#fff;font-size:13px;font-weight:800;line-height:1}.ic.dl{background:var(--mute)}.ic.lg{position:relative;overflow:hidden}.ic.lg img{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;padding:3px;background:#fff;object-fit:contain;border:1px solid var(--line);border-radius:inherit}.flag{flex:0 0 auto;font-size:24px;line-height:1}
.tag{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:999px;background:color-mix(in srgb,var(--up) 14%,var(--card));color:var(--up);font-size:12px;font-weight:800;vertical-align:2px}.tag.mid{background:color-mix(in srgb,var(--mid) 16%,var(--card));color:var(--mid)}.tag.bad{background:color-mix(in srgb,var(--down) 14%,var(--card));color:var(--down)}.sp-sum{display:grid;gap:6px;margin:0 0 14px}.sp-dev{margin:0;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline}.sp-dev span{color:var(--mute);font-size:15px}.pc{background:color-mix(in srgb,var(--up) 14%,var(--card));color:var(--up);border-radius:999px;padding:2px 9px;font-size:13px;font-weight:800}
details.all summary{cursor:pointer;color:var(--accent);font-weight:700;font-size:16px;margin-top:10px;list-style:none}details.all summary::-webkit-details-marker{display:none}details.all[open] summary{margin-bottom:5px}
.news{grid-column:1/-1}@media (min-width:821px){.news-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}}
@media print{.toolbar .hint,.tabs,details.all summary,.row .out{display:none!important}.pane{display:block!important}}
.rc-c{color:var(--accent)}.brand a .rc-c{color:var(--accent)}
.badges{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 4px}.badges img{max-width:100%;height:auto}details.plain summary{cursor:pointer;margin-top:10px}
@media print{:root{--bg:#fff;--card:#fff;--ink:#1d1d1f;--mute:#6b6b70;--line:#e6e4df;--accent:#2f6fed;--bar:#dfe8fb}nav,.who,.live,.dl,.settings-head,.settings-head~*,footer+script{display:none!important}.card{break-inside:avoid}body{font-size:12px}}
@media (max-width:820px){main{grid-template-columns:minmax(0,1fr)}}@media (max-width:520px){.plot .vl:not(.vk){display:none}.stat .v{font-size:30px}.stat{padding:16px}.card{padding:18px}header,main,footer{padding:12px 14px}.plot{height:220px}.row .x .tm{display:none}.legend .since{margin-left:0}.row .nm{white-space:normal;overflow-wrap:anywhere}.row button.out{display:none}.row .out{padding:2px 1px}.row .nm small{white-space:nowrap}.row:has(.x .pc){flex-wrap:wrap;row-gap:4px}.row:has(.x .pc) .x{order:5;flex-basis:100%;white-space:normal;flex-wrap:wrap}}
.ov{grid-column:1/-1}.ov-list{display:grid;gap:8px}.ov-row{display:grid;grid-template-columns:minmax(0,1.4fr) 80px 130px 120px minmax(0,1fr) 16px;gap:14px;align-items:center;padding:12px 14px;border:1px solid var(--line);border-radius:12px;color:var(--ink);text-decoration:none;background:var(--bg)}.ov-row:hover{border-color:var(--accent)}.ov-site{font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ov-n b{display:block;font-size:18px}.ov-n small,.ov-src{color:var(--mute);font-size:13px}.ov-src b{color:var(--ink)}.ov-row svg.spark{width:120px;height:32px;color:var(--accent)}.ov-go{color:var(--mute);font-size:22px}.ov-month{grid-column:1/-1}.meter{height:10px;border-radius:99px;background:var(--line);overflow:hidden}.meter span{display:block;height:100%;background:var(--accent);border-radius:99px}.meter.over span{background:var(--down)}@media (max-width:760px){.ov-row{grid-template-columns:1fr auto;row-gap:6px}.ov-row .spark,.ov-go{display:none}.ov-site{grid-column:1/-1}.ov-src{grid-column:1/-1}}
.btn-out.btn-danger{color:var(--down);border-color:var(--down)}.btn-out.btn-danger:hover{background:var(--down);color:#fff;border-color:var(--down)}.f .go.go-danger{background:#c0262d}.f a.no{display:inline-block;text-decoration:none}.del-list{padding-left:1.2em}.del-list li{margin:0 0 6px}
`;
