// Broken link alerts: once a day, check each outbound link readers clicked in the last 30 days. A link
// that fails two checks in a row shows under Broken links on the stats page, and the owner gets one email.
// A failing link is only counted while it's still on the pages readers clicked it on, so one already taken off
// the site isn't reported for the rest of the 30 days.
// Runs a few links at a time every hour (the cron in index.ts), so no single run gets too big.

import { alertOwner, type Mailer } from "./accounts.ts";
import { mailFrom } from "./host.ts";
import { linkSite } from "./dashboard.ts";
import { accountPlan } from "./plans.ts";

const DAY = 86_400_000;
/** Links checked per hourly run. */
export const LINKS_PER_RUN = 40;

/** Answers that mean the link is broken. Sites that block checkers (401, 403, 429) are given the benefit of the doubt. */
export function isBroken(status: number | null): boolean {
	return status === null || status === 404 || status === 410 || status >= 500;
}

/** Redirects followed when checking a link. */
const LINK_HOPS = 5;

/**
 * Addresses the link check never opens: anything but http(s), addresses with a login in them, and hosts on a
 * private network (localhost, .local, .internal and private or reserved IP addresses). Clicks can be sent by
 * anyone, so the targets aren't trusted. Workers can't reach private networks anyway; this keeps it that way.
 */
export function offLimits(target: string): boolean {
	let u: URL;
	try {
		u = new URL(target);
	} catch {
		return true;
	}
	if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return true;
	const host = u.hostname.toLowerCase().replace(/\.$/, "");
	if (!host.includes(".") || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/.test(host)) return true;
	if (host.startsWith("[")) {
		const v6 = host.slice(1, -1);
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
		if (mapped) return privateV4(mapped[1]);
		return v6 === "::" || v6 === "::1" || /^(fc|fd|fe[89ab]|ff)/.test(v6) || v6.startsWith("::ffff:") || v6.startsWith("64:ff9b:");
	}
	// new URL() has already turned decimal, octal and hex forms into dotted IPv4.
	return /^\d+\.\d+\.\d+\.\d+$/.test(host) && privateV4(host);
}

function privateV4(ip: string): boolean {
	const [a, b] = ip.split(".").map(Number);
	return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
}

export async function check(target: string, fetcher: typeof fetch = fetch): Promise<number | null> {
	// Redirects are followed one at a time, so each address on the way is checked too.
	const ask = async (method: string): Promise<number | null> => {
		let at = target;
		for (let hop = 0; hop <= LINK_HOPS; hop++) {
			if (offLimits(at)) return null;
			const res = await fetcher(at, { method, redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "User-Agent": "ReaderCount link check (+https://paulobrien.dev/readercount/)" } });
			// Only the status matters, so don't download the page.
			await res.body?.cancel().catch(() => {});
			const next = res.status >= 300 && res.status < 400 ? res.headers.get("Location") : null;
			if (!next) return res.status;
			at = new URL(next, at).href;
		}
		return null;
	};
	// A quick HEAD first. Plenty of sites only answer GET and say 404 or 405 to HEAD (Bluesky profiles and
	// Fastmail referral links do), so anything but a clear yes is asked again for the page itself, and that answer counts.
	let status: number | null = null;
	try {
		status = await ask("HEAD");
	} catch {}
	if (status !== null && status >= 200 && status < 300) return status;
	try {
		return await ask("GET");
	} catch {
		return null;
	}
}

/** Matches the link in a page's HTML, with or without a trailing slash, and not as the start of a longer address. */
function linkPattern(target: string): RegExp {
	const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const bare = target.replace(/\/$/, "");
	return new RegExp(`(${esc(bare)}|${esc(bare.replaceAll("&", "&amp;"))})/?(?=["'\\s<>?#)]|$)`);
}

/**
 * Is the link still on this page? false only when the page opened and the link isn't in it; null when the page
 * couldn't be read, so the link carries on being reported.
 */
export async function onPage(page: string, target: string, fetcher: typeof fetch = fetch): Promise<boolean | null> {
	if (offLimits(page)) return null;
	try {
		const res = await fetcher(page, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "ReaderCount link check (+https://paulobrien.dev/readercount/)" } });
		if (!res.ok || !(res.headers.get("Content-Type") ?? "").includes("html")) {
			await res.body?.cancel().catch(() => {});
			return null;
		}
		return linkPattern(target).test(await res.text());
	} catch {
		return null;
	}
}

type Env = { DB: D1Database; EMAIL?: Mailer; MAIL_FROM?: string; APP_HOST?: string };

export async function checkLinks(env: Env, now: number, checker: (target: string) => Promise<number | null> = check, stillOn: (page: string, target: string) => Promise<boolean | null> = onPage): Promise<number> {
	const since = new Date(now - 30 * DAY).toISOString().slice(0, 10);
	const due = (await env.DB
		.prepare(
			`SELECT e.site AS site, e.target AS target, c.fails AS fails, c.alerted AS alerted FROM (SELECT DISTINCT site, target FROM events WHERE kind = 'outbound' AND day >= ?) e
			 LEFT JOIN link_checks c ON c.site = e.site AND c.target = e.target WHERE c.checked_at IS NULL OR c.checked_at < ? ORDER BY c.checked_at IS NOT NULL, c.checked_at LIMIT ?`,
		)
		.bind(since, now - 20 * 3_600_000, LINKS_PER_RUN)
		.all<{ site: string; target: string; fails: number | null; alerted: number | null }>()).results ?? [];
	const newlyBroken = new Map<string, string[]>();
	for (const d of due) {
		// A link that can never be checked isn't reported as broken either.
		if (offLimits(d.target)) {
			await env.DB.prepare("INSERT INTO link_checks (site, target, status, checked_at, fails, broken_since, alerted) VALUES (?, ?, NULL, ?, 0, NULL, 0) ON CONFLICT (site, target) DO UPDATE SET checked_at = excluded.checked_at, fails = 0, broken_since = NULL").bind(d.site, d.target, now).run();
			continue;
		}
		const status = await checker(d.target);
		let bad = isBroken(status);
		if (bad) {
			// Taken off every page readers clicked it on (up to three checked): nothing for the owner to fix.
			const paths = (await env.DB.prepare("SELECT DISTINCT path FROM events WHERE site = ? AND target = ? AND kind = 'outbound' AND day >= ? AND path IS NOT NULL LIMIT 3").bind(d.site, d.target, since).all<{ path: string }>()).results ?? [];
			if (paths.length) {
				const found = await Promise.all(paths.map((p) => stillOn(`https://${d.site}${p.path.startsWith("/") ? "" : "/"}${p.path}`, d.target)));
				if (found.every((f) => f === false)) bad = false;
			}
		}
		const fails = bad ? (d.fails ?? 0) + 1 : 0;
		await env.DB
			.prepare(
				`INSERT INTO link_checks (site, target, status, checked_at, fails, broken_since, alerted) VALUES (?, ?, ?, ?, ?, ?, 0)
				 ON CONFLICT (site, target) DO UPDATE SET status = excluded.status, checked_at = excluded.checked_at, fails = excluded.fails,
				 broken_since = CASE WHEN excluded.fails = 0 THEN NULL ELSE COALESCE(link_checks.broken_since, excluded.checked_at) END,
				 alerted = CASE WHEN excluded.fails = 0 THEN 0 ELSE link_checks.alerted END`,
			)
			.bind(d.site, d.target, status, now, fails, bad ? now : null)
			.run();
		if (fails === 2 && !d.alerted) newlyBroken.set(d.site, [...(newlyBroken.get(d.site) ?? []), d.target]);
	}
	for (const [site, links] of newlyBroken) {
		const owner = await env.DB.prepare("SELECT a.id, a.email FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.domain = ?").bind(site).first<{ id: string; email: string }>();
		if (owner && !(await accountPlan(env.DB, owner.id, now)).ended && env.APP_HOST) {
			const list = links.map((l) => `- ${l}${linkSite(l).affiliate ? " (affiliate link)" : ""}`).join("\n");
			await alertOwner(
				env.EMAIL,
				mailFrom(env),
				owner.email,
				links.length === 1 ? `A link on ${site} has stopped working` : `${links.length} links on ${site} have stopped working`,
				`Readers clicked ${links.length === 1 ? "this link" : "these links"} on ${site} recently, and ${links.length === 1 ? "it has" : "they have"} failed our check two days running:\n\n${list}\n\nSee which pages they're on under Link clicks › Broken links: https://${env.APP_HOST}/?site=${encodeURIComponent(site)}\n\nReaderCount`,
			);
		}
		for (const l of links) await env.DB.prepare("UPDATE link_checks SET alerted = 1 WHERE site = ? AND target = ?").bind(site, l).run();
	}
	return due.length;
}

export type BrokenLink = { target: string; status: number | null; since: number; pages: { path: string; clicks: number; last: string }[] };

/** Links that failed two checks in a row, each with the pages readers clicked it on (most clicks first).
 * Only links clicked in the last 30 days and still on the page: one taken off the site drops out at its next check. */
export async function brokenLinks(db: D1Database, site: string, now = Date.now()): Promise<BrokenLink[]> {
	const since = new Date(now - 30 * DAY).toISOString().slice(0, 10);
	const r = await db.prepare("SELECT target, status, broken_since AS since FROM link_checks WHERE site = ? AND fails >= 2 ORDER BY broken_since DESC LIMIT 50").bind(site).all<{ target: string; status: number | null; since: number }>();
	const links = r.results ?? [];
	if (!links.length) return [];
	const pages = (await db
		.prepare(`SELECT target, path, COUNT(*) AS clicks, MAX(day) AS last FROM events WHERE site = ? AND kind = 'outbound' AND day >= ? AND target IN (${links.map(() => "?").join(", ")}) GROUP BY target, path ORDER BY clicks DESC, last DESC`)
		.bind(site, since, ...links.map((l) => l.target))
		.all<{ target: string; path: string; clicks: number; last: string }>()).results ?? [];
	return links
		.map((l) => ({ ...l, pages: pages.filter((p) => p.target === l.target).map(({ path, clicks, last }) => ({ path, clicks: Number(clicks), last })) }))
		.filter((l) => l.pages.length);
}

/** On public stats pages, a link or goal is only listed once this many different visitors sent it on one day. */
export const PUBLIC_MIN_VISITORS = 3;

/**
 * Link clicks and goals as "kind|target" that at least PUBLIC_MIN_VISITORS different visitors sent on the same day.
 * Public pages list only these, so a script can't plant its own links or text on someone's public stats page.
 */
export async function widelySent(db: D1Database, site: string, from: string, to: string): Promise<Set<string>> {
	const r = await db
		.prepare("SELECT DISTINCT kind, target FROM (SELECT kind, target, day FROM events WHERE site = ? AND kind IN ('outbound', 'download', 'goal') AND day >= ? AND day <= ? GROUP BY kind, target, day HAVING COUNT(DISTINCT visitor) >= ?)")
		.bind(site, from, to, PUBLIC_MIN_VISITORS)
		.all<{ kind: string; target: string }>();
	return new Set((r.results ?? []).map((x) => `${x.kind}|${x.target}`));
}
