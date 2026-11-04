// Site health: one list, worst first, of what's wrong with a website right now, at the top of the stats page.
// Also the site-down check: every 5 minutes ReaderCount looks at each website's home page. Two failed looks
// in a row (about 10 minutes) and the owner gets one email, then another when it's back.

import { alertOwner, countedSites, type Mailer } from "./accounts.ts";
import { check, isBroken } from "./links.ts";
import { planState, type PlanRow } from "./plans.ts";
import type { Behaviour } from "./behaviour.ts";
import { mailFrom } from "./host.ts";
import { utcDay } from "./visitor.ts";

export const UPTIME_CRON = "*/5 * * * *";
/** Failed looks in a row before a website counts as down. */
export const DOWN_AFTER = 2;
/** Home pages looked at per 5-minute run, a few at a time. */
export const SITES_PER_RUN = 300;
const AT_ONCE = 10;
/** Tracking has stopped when a website that got at least this many views on every one of the last 7 days has had none for TRACKING_HOURS. */
const TRACKING_MIN_DAILY = 20;
const TRACKING_HOURS = 12;

type Env = { DB: D1Database; EMAIL?: Mailer; MAIL_FROM?: string; APP_HOST?: string };

type Owner = { id: string; email: string; downs: number } & PlanRow;

async function ownerOf(db: D1Database, site: string): Promise<Owner | null> {
	return db.prepare("SELECT a.id AS id, a.email AS email, a.downs AS downs, a.plan AS plan, a.trial_ends AS trial_ends FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.domain = ?").bind(site).first<Owner>();
}

/** Counts one alert email towards the account's daily cap, and says whether it may be sent. */
export async function mayAlert(db: D1Database, owner: string, cap: number, now: number): Promise<boolean> {
	const row = await db
		.prepare("INSERT INTO alert_sends (owner, day, n) VALUES (?, ?, 1) ON CONFLICT (owner, day) DO UPDATE SET n = n + 1 RETURNING n")
		.bind(owner, utcDay(now))
		.first<{ n: number }>();
	return (row?.n ?? 0) <= cap;
}

/** Sends an alert email to a website's owner, if their plan is running, they want this kind and today's cap allows. */
export async function alertSiteOwner(env: Env, site: string, kind: "downs" | "triggers" | "earnings", subject: string, text: string, now: number): Promise<boolean> {
	const owner = await ownerOf(env.DB, site);
	if (!owner) return false;
	const plan = planState(owner, now);
	if (plan.ended || (kind === "downs" && !owner.downs)) return false;
	if (!(await mayAlert(env.DB, owner.id, plan.alerts, now))) return false;
	await alertOwner(env.EMAIL, mailFrom(env), owner.email, subject, text);
	return true;
}

/** Every 5 minutes: look at each counted website's home page, and email when one goes down or comes back. */
export async function checkSitesUp(env: Env, now: number, checker: (target: string) => Promise<number | null> = check): Promise<number> {
	const sites = await countedSites(env.DB, now);
	// Longest-unchecked first, so every website gets its turn when there are more than one run can do.
	const last = new Map(((await env.DB.prepare("SELECT site, checked_at FROM site_checks").all<{ site: string; checked_at: number }>()).results ?? []).map((r) => [r.site, r.checked_at]));
	const due = sites.sort((a, b) => (last.get(a) ?? 0) - (last.get(b) ?? 0)).slice(0, SITES_PER_RUN);
	for (let i = 0; i < due.length; i += AT_ONCE) await Promise.all(due.slice(i, i + AT_ONCE).map((site) => checkOne(env, site, now, checker)));
	return due.length;
}

async function checkOne(env: Env, site: string, now: number, checker: (target: string) => Promise<number | null>): Promise<void> {
	const status = await checker(`https://${site}/`).catch(() => null);
	const bad = isBroken(status);
	const before = await env.DB.prepare("SELECT fails, down_since, alerted FROM site_checks WHERE site = ?").bind(site).first<{ fails: number; down_since: number | null; alerted: number }>();
	const fails = bad ? (before?.fails ?? 0) + 1 : 0;
	const downSince = bad ? (before?.down_since ?? now) : null;
	let alerted = bad ? (before?.alerted ?? 0) : 0;
	const said = status ? `It answered with error ${status}.` : "It didn't answer at all.";
	if (bad && fails >= DOWN_AFTER && !before?.alerted) {
		alerted = 1;
		await alertSiteOwner(env, site, "downs", `${site} is down`, `We couldn't open ${site} on our last two looks, 5 minutes apart. ${said}\n\nWe'll keep looking every 5 minutes and email you when it's back.\n\nSite health: https://${env.APP_HOST}/?site=${encodeURIComponent(site)}\n\nReaderCount`, now);
	}
	if (!bad && before?.alerted) {
		const mins = before.down_since ? Math.max(1, Math.round((now - before.down_since) / 60_000)) : 0;
		await alertSiteOwner(env, site, "downs", `${site} is back up`, `${site} is working again${mins ? `, after about ${mins < 120 ? `${mins} minutes` : `${Math.round(mins / 60)} hours`}` : ""}.\n\nReaderCount`, now);
	}
	await env.DB.prepare(
		`INSERT INTO site_checks (site, status, checked_at, fails, down_since, alerted) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (site) DO UPDATE SET status = excluded.status, checked_at = excluded.checked_at, fails = excluded.fails, down_since = excluded.down_since, alerted = excluded.alerted`,
	)
		.bind(site, status, now, fails, downSince, alerted)
		.run();
}

/** go: the card (and tab) on the stats page with the details, linked from the item. */
/** links: addresses in detail shown as links that open them. */
export type HealthItem = { level: "fix" | "attention"; title: string; detail: string; tab?: string; go?: { card: string; tab?: string }; links?: string[] };

type HealthInput = {
	behaviour?: Behaviour;
	missing?: Record<string, unknown>[];
	broken?: { target: string; pages?: { path: string }[] }[];
	visitors: number;
	previousVisitors: number;
	range: string;
};

/** "https://example.com/mail/" from a page's path, so the item links straight to it. */
export function pageUrl(site: string, path: string): string {
	return /^https?:\/\//i.test(path) ? path : `https://${site}${path.startsWith("/") ? "" : "/"}${path}`;
}

const n = (x: number) => x.toLocaleString("en-GB");
const plural = (x: number, one: string, many = one + "s") => `${n(x)} ${x === 1 ? one : many}`;

/** What's wrong with the website now, worst first. */
export async function siteHealth(db: D1Database, site: string, r: HealthInput, now: number): Promise<HealthItem[]> {
	const items: HealthItem[] = [];
	const [up, last, usual] = await Promise.all([
		db.prepare("SELECT status, fails, down_since FROM site_checks WHERE site = ?").bind(site).first<{ status: number | null; fails: number; down_since: number | null }>(),
		db.prepare("SELECT MAX(ts) AS ts FROM events WHERE site = ? AND kind = 'view' AND day >= ?").bind(site, utcDay(now - 8 * 86_400_000)).first<{ ts: number | null }>(),
		db.prepare("SELECT day, COUNT(*) AS views FROM events WHERE site = ? AND kind = 'view' AND day >= ? AND day < ? GROUP BY day").bind(site, utcDay(now - 8 * 86_400_000), utcDay(now - 86_400_000)).all<{ day: string; views: number }>(),
	]);
	if (up && up.fails >= DOWN_AFTER) {
		const mins = up.down_since ? Math.max(5, Math.round((now - up.down_since) / 60_000)) : 0;
		items.push({ level: "fix", title: "Your website is down", detail: `We couldn't open your home page${mins ? ` for about ${mins < 120 ? `${mins} minutes` : `${Math.round(mins / 60)} hours`}` : ""}. ${up.status ? `It answers with error ${up.status}.` : "It doesn't answer at all."} We look every 5 minutes.` });
	}
	// The quietest of the last 7 days, not the average: a busy launch week or a day of testing
	// shouldn't make a quiet site's normal gaps look like the code has gone.
	const days = usual.results ?? [];
	const daily = days.length < 7 ? 0 : Math.min(...days.map((d) => Number(d.views)));
	if (daily >= TRACKING_MIN_DAILY && (!last?.ts || now - last.ts > TRACKING_HOURS * 3_600_000) && !(up && up.fails >= DOWN_AFTER)) {
		items.push({ level: "fix", title: "Visits have stopped arriving", detail: `No visits for over ${TRACKING_HOURS} hours, when you've had at least ${n(daily)} a day all week. Check the ReaderCount code is still on your pages: a new theme or plugin can remove it.` });
	}
	const b = r.behaviour;
	const brokenLinks = (r.missing ?? []).filter((m) => m.top_link);
	if (brokenLinks.length) items.push({ level: "fix", title: plural(brokenLinks.length, "broken link") + " on your own pages", detail: `For example, ${pageUrl(site, String(brokenLinks[0].top_link))} links to ${pageUrl(site, String(brokenLinks[0].path))}, which is missing.`, go: { card: "tm", tab: "Not Found" }, links: [pageUrl(site, String(brokenLinks[0].top_link)), pageUrl(site, String(brokenLinks[0].path))] });
	const files = b?.problems.filter((p) => p.kind !== "script") ?? [];
	if (files.length) {
		const seen = files.reduce((a, p) => a + p.n, 0);
		items.push({ level: seen >= 20 ? "fix" : "attention", title: `${plural(files.length, "picture or file", "pictures or files")} didn't load for readers`, detail: `Seen ${plural(seen, "time")}, for example ${files[0].url} on ${files[0].pages[0] ? pageUrl(site, files[0].pages[0]) : "your site"}.`, tab: "files", go: { card: "tx", tab: "Broken Images & Files" }, links: [files[0].url, ...(files[0].pages[0] ? [pageUrl(site, files[0].pages[0])] : [])] });
	}
	const slow = b?.speed.filter((p) => p.rating === "fix") ?? [];
	if (slow.length) items.push({ level: "fix", title: `${plural(slow.length, "page")} slow to load`, detail: `${slow[0].path} takes ${((slow[0].lcp ?? 0) / 1000).toFixed(1)} seconds to show its main content for 1 in 4 readers. Google counts over 4 seconds as poor.`, go: { card: "tr", tab: "Page Speed" } });
	const scripts = b?.problems.filter((p) => p.kind === "script") ?? [];
	if (scripts.length) items.push({ level: "attention", title: `${plural(scripts.length, "script error")} in readers' browsers`, detail: `The most common: "${scripts[0].message || "Script error"}". Something on ${scripts[0].pages[0] ?? "the page"} may not work for them.`, go: { card: "tx", tab: "Script Errors" } });
	if (r.broken?.length) {
		const first = r.broken[0];
		const page = first.pages?.length ? pageUrl(site, first.pages[0].path) : "";
		items.push({ level: "attention", title: `${plural(r.broken.length, "outbound link")} stopped working`, detail: `Links readers clicked that fail our daily check${page ? `, such as ${first.target} on ${page}` : ""}.`, go: { card: "tl", tab: "Broken links" }, links: page ? [first.target, page] : [] });
	}
	const missing = (r.missing ?? []).filter((m) => !m.top_link);
	const missingHits = missing.reduce((a, m) => a + Number(m.views), 0);
	if (missingHits >= 10) items.push({ level: "attention", title: `${plural(missing.length, "missing page")} people try to open`, detail: `${n(missingHits)} visits landed on a "not found" page, most on ${String(missing[0].path)}. A redirect to the right page would keep them.`, go: { card: "tm", tab: "Not Found" } });
	if (r.range !== "today" && r.previousVisitors >= 100 && r.visitors <= r.previousVisitors * 0.6) items.push({ level: "attention", title: "Visitors are down sharply", detail: `${n(r.visitors)} visitors against ${n(r.previousVisitors)} in the period before, down ${Math.round(100 - (100 * r.visitors) / r.previousVisitors)}%. What to fix shows which pages lost the most.` });
	return items.sort((x, y) => (x.level === y.level ? 0 : x.level === "fix" ? -1 : 1));
}
