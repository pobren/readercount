// What readers do on a page, and what goes wrong for them, from the tracker's "leave" message (src/tracker.ts).
// Everything is a plain number or a count per page: how far down people read, how fast the page was for them
// (Core Web Vitals), pictures and files that didn't load, script errors, and forms started against forms sent.
// Nothing here can follow one reader: no recordings, no clicks on the page, nothing anyone typed.

import type { Problem } from "./collect.ts";
import { planState, type PlanRow } from "./plans.ts";

/** Reports a month for the private-link websites (SITES), which have no plan. */
export const FIXED_REPORTS = 200_000;

/** Pages need this many measured visits before their scroll depth or speed is shown. */
export const MIN_SAMPLES = 5;

export type Rating = "good" | "attention" | "fix";

/** Google's Core Web Vitals limits: up to the first is good, past the second needs fixing. CLS is x 1000. */
export const VITALS = { lcp: [2500, 4000], inp: [200, 500], cls: [100, 250] } as const;
export type Vital = keyof typeof VITALS;

export function rate(metric: Vital, value: number | null | undefined): Rating | null {
	if (value === null || value === undefined) return null;
	const [good, poor] = VITALS[metric];
	return value <= good ? "good" : value <= poor ? "attention" : "fix";
}

/** The worst of a page's ratings. */
export function worst(ratings: (Rating | null)[]): Rating | null {
	const r = ratings.filter((x): x is Rating => x !== null);
	return r.includes("fix") ? "fix" : r.includes("attention") ? "attention" : r.length ? "good" : null;
}

export type ReadingRow = { path: string; views: number; avg: number; half: number; end: number };
export type SpeedRow = { path: string; n: number; lcp: number | null; inp: number | null; cls: number | null; rating: Rating | null };
export type ProblemRow = { kind: Problem["kind"]; url: string; message: string; n: number; pages: string[]; browsers: string[] };
export type FormRow = { form: string; started: number; sent: number };

export type Behaviour = {
	reading: ReadingRow[];
	/** Speed per page, and for the whole website on phones and on computers. */
	speed: SpeedRow[];
	devices: { phone?: SpeedRow; computer?: SpeedRow };
	problems: ProblemRow[];
	forms: FormRow[];
	/** This month's problem and form reports have reached the plan's allowance: no new ones are being kept. */
	full?: boolean;
};

type Owner = { owner: string; limit: number };

async function ownerOf(db: D1Database, site: string, now: number): Promise<Owner> {
	const row = await db.prepare("SELECT s.account_id AS id, a.plan AS plan, a.trial_ends AS trial_ends FROM sites s LEFT JOIN accounts a ON a.id = s.account_id WHERE s.domain = ?").bind(site).first<{ id: string } & PlanRow>();
	return row ? { owner: row.id, limit: planState(row, now).reports } : { owner: "key", limit: FIXED_REPORTS };
}

const month = (now: number) => new Date(now).toISOString().slice(0, 7);

/** Other companies' visitor-tracking and ad scripts. Ad blockers stop these on purpose, so a failed load isn't a fault on the website. */
const TRACKERS = /^https?:\/\/([^/]+\.)?(cloudflareinsights\.com|google-analytics\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|googleadservices\.com|facebook\.net|connect\.facebook\.net|hotjar\.com|clarity\.ms|plausible\.io|matomo\.cloud|segment\.com|segment\.io|scorecardresearch\.com|quantserve\.com|adsbygoogle\.com|amazon-adsystem\.com|taboola\.com|outbrain\.com|licdn\.com|ads-twitter\.com|analytics\.tiktok\.com|pinimg\.com\/ct)(\/|$)/i;

/** A file that failed because the reader blocks trackers or ads, not because the website is broken. */
export function blockedTracker(problem: { kind: string; url: string }): boolean {
	return problem.kind !== "image" && TRACKERS.test(problem.url);
}

/** "Script error." with no file or line: the browser hides the details of errors in scripts from other websites, often a browser extension, so there's nothing the owner can find or fix. */
export function hiddenError(problem: { kind: string; message: string }): boolean {
	return problem.kind === "script" && /^script error\.?(:0)?$/i.test((problem.message ?? "").trim());
}

/** A picture or file whose address is the page it was on. That's an element with an empty address (often added by a browser extension), not something missing from the website. */
export function pageItself(problem: { kind: string; url: string }, site: string, paths: string[]): boolean {
	if (problem.kind === "script" || !paths.length) return false;
	let url: URL;
	try {
		url = new URL(problem.url);
	} catch {
		return false;
	}
	return url.hostname.replace(/^www\./, "") === site.replace(/^www\./, "") && paths.every((p) => p === url.pathname);
}

/** Keeps the problems and started forms a reader's browser sent for one page view, up to the plan's monthly allowance. */
export async function recordReports(db: D1Database, site: string, viewId: string, problems: Problem[], forms: string[], now: number): Promise<boolean> {
	problems = problems.filter((p) => !blockedTracker(p) && !hiddenError(p));
	if (!problems.length && !forms.length) return false;
	const view = await db.prepare("SELECT path, day, browser FROM events WHERE view_id = ? AND site = ? AND kind = 'view' AND ts > ?").bind(viewId, site, now - 86_400_000).first<{ path: string; day: string; browser: string | null }>();
	if (!view) return false;
	problems = problems.filter((p) => !pageItself(p, site, [view.path]));
	if (!problems.length && !forms.length) return false;
	const { owner, limit } = await ownerOf(db, site, now);
	const used = await db
		.prepare("INSERT INTO report_use (owner, month, n) VALUES (?, ?, ?) ON CONFLICT (owner, month) DO UPDATE SET n = n + excluded.n RETURNING n")
		.bind(owner, month(now), problems.length + forms.length)
		.first<{ n: number }>();
	if ((used?.n ?? 0) > limit) return false;
	await db.batch([
		...problems.map((p) =>
			db
				.prepare("INSERT INTO problems (site, day, path, kind, url, message, browser, n) VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT (site, day, path, kind, url, message, browser) DO UPDATE SET n = n + 1")
				.bind(site, view.day, view.path, p.kind, p.url, p.message, view.browser ?? ""),
		),
		...forms.map((f) => db.prepare("INSERT INTO form_starts (site, day, path, form, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT (site, day, path, form) DO UPDATE SET n = n + 1").bind(site, view.day, view.path, f)),
	]);
	return true;
}

/** Whether this month's allowance of problem and form reports has run out for the website's account. */
export async function reportsFull(db: D1Database, site: string, now: number): Promise<boolean> {
	const { owner, limit } = await ownerOf(db, site, now);
	const row = await db.prepare("SELECT n FROM report_use WHERE owner = ? AND month = ?").bind(owner, month(now)).first<{ n: number }>();
	return (row?.n ?? 0) >= limit;
}

/** The 75th percentile of each Core Web Vital, by page (or by "phone" and "computer" when by is the device). Google rates pages on this figure. */
async function vitals(db: D1Database, by: string, site: string, from: string, to: string, limit: number): Promise<SpeedRow[]> {
	const one = async (m: Vital) =>
		(
			await db
				.prepare(
					`SELECT k, MAX(CASE WHEN r <= 0.75 THEN ${m} END) AS v, MAX(n) AS n FROM (SELECT ${by} AS k, ${m}, PERCENT_RANK() OVER (PARTITION BY ${by} ORDER BY ${m}) AS r, COUNT(*) OVER (PARTITION BY ${by}) AS n
					 FROM events WHERE site = ? AND kind = 'view' AND day >= ? AND day <= ? AND ${m} IS NOT NULL) GROUP BY k HAVING n >= ? ORDER BY n DESC LIMIT ?`,
				)
				.bind(site, from, to, MIN_SAMPLES, limit)
				.all<{ k: string; v: number; n: number }>()
		).results ?? [];
	const [lcp, inp, cls] = await Promise.all([one("lcp"), one("inp"), one("cls")]);
	const at = (rows: { k: string; v: number }[], k: string) => rows.find((r) => r.k === k)?.v ?? null;
	return lcp.map((r) => {
		const row = { path: r.k, n: Number(r.n), lcp: Number(r.v), inp: at(inp, r.k), cls: at(cls, r.k) };
		return { ...row, rating: worst([rate("lcp", row.lcp), rate("inp", row.inp), rate("cls", row.cls)]) };
	});
}

export async function behaviourReport(db: D1Database, site: string, from: string, to: string, now: number, top = 20): Promise<Behaviour> {
	const all = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).all<T>().then((r) => r.results ?? []);
	const [reading, speed, devices, problems, starts, full] = await Promise.all([
		all<ReadingRow>(
			`SELECT path, COUNT(*) AS views, CAST(AVG(scroll) AS INTEGER) AS avg, SUM(scroll >= 50) AS half, SUM(scroll >= 90) AS "end"
			 FROM events WHERE site = ? AND kind = 'view' AND day >= ? AND day <= ? AND scroll IS NOT NULL GROUP BY path HAVING views >= ? ORDER BY views DESC LIMIT ?`,
			site, from, to, MIN_SAMPLES, top,
		),
		vitals(db, "path", site, from, to, top),
		vitals(db, "CASE device WHEN 'desktop' THEN 'computer' ELSE 'phone' END", site, from, to, 2),
		all<{ kind: Problem["kind"]; url: string; message: string; n: number; pages: string; browsers: string }>(
			`SELECT kind, url, message, SUM(n) AS n, GROUP_CONCAT(DISTINCT path) AS pages, GROUP_CONCAT(DISTINCT NULLIF(browser, '')) AS browsers
			 FROM problems WHERE site = ? AND day >= ? AND day <= ? GROUP BY kind, url, message ORDER BY n DESC LIMIT ?`,
			site, from, to, top * 2,
		),
		all<{ form: string; started: number }>("SELECT form, SUM(n) AS started FROM form_starts WHERE site = ? AND day >= ? AND day <= ? GROUP BY form ORDER BY started DESC LIMIT ?", site, from, to, top),
		reportsFull(db, site, now),
	]);
	// A form's "sent" count is its goal: the tracker names both the same way.
	const sent = starts.length
		? await all<{ form: string; sent: number }>(
				`SELECT target AS form, COUNT(*) AS sent FROM events WHERE site = ? AND kind = 'goal' AND day >= ? AND day <= ? AND target IN (${starts.map(() => "?").join(",")}) GROUP BY target`,
				site, from, to, ...starts.map((s) => s.form),
			)
		: [];
	return {
		reading: reading.map((r) => ({ path: r.path, views: Number(r.views), avg: Number(r.avg), half: Number(r.half), end: Number(r.end) })),
		speed,
		devices: { phone: devices.find((d) => d.path === "phone"), computer: devices.find((d) => d.path === "computer") },
		problems: problems
			.map((p) => ({ kind: p.kind, url: p.url, message: p.message, n: Number(p.n), pages: String(p.pages ?? "").split(",").filter(Boolean), browsers: String(p.browsers ?? "").split(",").filter(Boolean) }))
			.filter((p) => !blockedTracker(p) && !hiddenError(p) && !pageItself(p, site, p.pages)),
		forms: starts.map((s) => ({ form: s.form, started: Number(s.started), sent: Number(sent.find((x) => x.form === s.form)?.sent ?? 0) })),
		...(full ? { full } : {}),
	};
}
