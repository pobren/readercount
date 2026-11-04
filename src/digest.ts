// The Monday email: each website's week as a card (visitors, change, a bar per day, top pages and sources), then its "What to fix" list. Only for people who ticked the box.

import { earningsByPage } from "./earnings.ts";
import { accountPlan } from "./plans.ts";
import { accountSites, type Mailer } from "./accounts.ts";
import { mailFrom } from "./host.ts";
import { findFixes, type Fix } from "./fixes.ts";
import { utcDay } from "./visitor.ts";

// Cloudflare counts weekdays from Sunday = 1, so name the day.
export const DIGEST_CRON = "0 7 * * MON";
/** The busiest websites get a card each; the rest are one line with a link to the overview. */
export const DIGEST_MAX_SITES = 5;
const DAY = 86_400_000;
const n = (v: number) => Math.round(v).toLocaleString("en-GB");

export async function wantsDigest(db: D1Database, accountId: string): Promise<boolean> {
	const row = await db.prepare("SELECT digest FROM accounts WHERE id = ?").bind(accountId).first<{ digest: number }>();
	return Boolean(row?.digest);
}

export async function setDigest(db: D1Database, accountId: string, on: boolean): Promise<void> {
	await db.prepare("UPDATE accounts SET digest = ? WHERE id = ?").bind(on ? 1 : 0, accountId).run();
}

export type DigestSite = {
	site: string;
	/** Visitors on each of the last 7 full days, oldest first. */
	days: { day: string; visitors: number }[];
	week: { now: number; before: number; views: number };
	pages: { name: string; visitors: number }[];
	sources: { name: string; visitors: number }[];
	/** Affiliate earnings in the week, and the post that earned most (src/earnings.ts), when there are any. */
	money?: { pence: number; best?: { path: string; pence: number } };
	fixes: Fix[];
};

/** One website's last 7 full days, against the 7 before. */
async function weekFor(db: D1Database, site: string, now: number): Promise<Omit<DigestSite, "fixes">> {
	const from = utcDay(now - 7 * DAY), to = utcDay(now - DAY), prevFrom = utcDay(now - 14 * DAY);
	const all = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).all<T>().then((r) => r.results ?? []);
	const [daily, pages, sources] = await Promise.all([
		all<{ day: string; visitors: number; views: number }>("SELECT day, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS views FROM events WHERE site = ? AND kind = 'view' AND day >= ? AND day <= ? GROUP BY day", site, prevFrom, to),
		all<{ name: string; visitors: number }>("SELECT path AS name, COUNT(DISTINCT visitor || day) AS visitors FROM events WHERE site = ? AND kind = 'view' AND day >= ? AND day <= ? GROUP BY path ORDER BY visitors DESC LIMIT 3", site, from, to),
		all<{ name: string; visitors: number }>("SELECT COALESCE(NULLIF(source, ''), 'Direct') AS name, COUNT(DISTINCT visitor || day) AS visitors FROM events WHERE site = ? AND kind = 'view' AND day >= ? AND day <= ? GROUP BY 1 ORDER BY visitors DESC LIMIT 3", site, from, to),
	]);
	const byDay = new Map(daily.map((d) => [d.day, d]));
	const days = Array.from({ length: 7 }, (_, i) => utcDay(now - (7 - i) * DAY)).map((day) => ({ day, visitors: byDay.get(day)?.visitors ?? 0 }));
	const week = { now: 0, before: 0, views: 0 };
	for (const d of daily) {
		if (d.day >= from) (week.now += d.visitors), (week.views += d.views);
		else week.before += d.visitors;
	}
	return { site, days, week, pages, sources, money: await weekMoney(db, site, from, to) };
}

async function weekMoney(db: D1Database, site: string, from: string, to: string): Promise<DigestSite["money"]> {
	const total = async (table: string) => Number((await db.prepare(`SELECT SUM(pence) AS p FROM ${table} WHERE site = ? AND day >= ? AND day <= ?`).bind(site, from, to).first<{ p: number | null }>().catch(() => null))?.p ?? 0);
	const pence = (await total("earnings")) + (await total("affiliate_earnings"));
	if (!pence) return undefined;
	const best = (await earningsByPage(db, site, from, to))[0];
	return { pence, best };
}

const gbp = (pence: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
const moneyLine = (m: DigestSite["money"]) => (m ? `You earned ${gbp(m.pence)} from affiliate links${m.best ? `. Best post: ${m.best.path} (${gbp(m.best.pence)})` : ""}.` : "");

/** "up 12%", "down 4%", or "" when there's nothing to compare with. */
function change(w: { now: number; before: number }): string {
	if (!w.before) return "";
	const pc = Math.round(((w.now - w.before) / w.before) * 100);
	return pc === 0 ? "the same as the week before" : `${pc > 0 ? "up" : "down"} ${Math.abs(pc)}%`;
}

const when = (day: string, opts: Intl.DateTimeFormatOptions) => new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", ...opts });

/** "12 to 18 October", or "28 September to 4 October". */
export function weekLabel(now: number): string {
	const a = utcDay(now - 7 * DAY), b = utcDay(now - DAY);
	return `${when(a, a.slice(5, 7) === b.slice(5, 7) ? { day: "numeric" } : { day: "numeric", month: "long" })} to ${when(b, { day: "numeric", month: "long" })}`;
}

export function digestSubject(sites: DigestSite[], more = { sites: 0, visitors: 0 }): string {
	const visitors = sites.reduce((a, s) => a + s.week.now, more.visitors);
	const fixes = sites.reduce((a, s) => a + s.fixes.length, 0);
	const head = sites.length + more.sites === 1 ? `${sites[0].site} had ${n(visitors)} visitor${visitors === 1 ? "" : "s"} last week` : `Your ${sites.length + more.sites} websites had ${n(visitors)} visitors last week`;
	const ch = sites.length === 1 ? change(sites[0].week) : "";
	return `${head}${ch && ch.startsWith("the same") ? "" : ch ? `, ${ch}` : ""}${fixes ? ` · ${fixes} thing${fixes === 1 ? "" : "s"} to fix` : ""}`;
}

/** "Plus 3 more websites with 412 visitors between them." */
function moreLine(more: { sites: number; visitors: number }): string {
	return `Plus ${more.sites} more website${more.sites === 1 ? "" : "s"} with ${n(more.visitors)} visitor${more.visitors === 1 ? "" : "s"} between them.`;
}

export function digestText(sites: DigestSite[], appHost: string, now: number, more = { sites: 0, visitors: 0 }): string {
	const parts = sites.map(({ site, week: w, pages, sources, fixes }) => {
		const ch = change(w);
		const top = (title: string, rows: { name: string; visitors: number }[]) => (rows.length ? `\n${title}:\n${rows.map((r) => `- ${r.name}: ${n(r.visitors)}`).join("\n")}\n` : "");
		const list = fixes.length
			? fixes.map((f, i) => `${i + 1}. https://${site}${f.page}\n   ${f.what}\n   What to do: ${f.todo}`).join("\n\n")
			: "Nothing needs fixing this week. Nice.";
		const earned = moneyLine(sites.find((x) => x.site === site)?.money);
		return `${site.toUpperCase()}\n${n(w.now)} visitors and ${n(w.views)} page views${ch ? ` (${ch} on the week before)` : ""}.\n${earned ? `${earned}\n` : ""}${top("Top pages", pages)}${top("Top sources", sources)}\nWorth fixing:\n${list}\n\nSee the full stats: https://${appHost}/?site=${encodeURIComponent(site)}&range=7d`;
	});
	return `Good morning. Here's your week on ReaderCount, ${weekLabel(now)}.\n\n${parts.join("\n\n\n")}${more.sites ? `\n\n\n${moreLine(more)}\nSee all your stats: https://${appHost}/` : ""}\n\n\nYou get this email because "Weekly Optimisation Digest" is switched on. To stop it, switch it off under Settings on your stats page: https://${appHost}/#emails`;
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export const INK = "#1d1d1f", MUTE = "#6b6b70", LINE = "#e6e4df", BLUE = "#2f6fed", BAR = "#dfe8fb", UP = "#1a7f37", DOWN = "#c2410c";
const FONT = "-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif";

/** Seven small bars, one per day (the busiest in blue), with the day's first letter under each. Tables, because email. */
function bars(days: DigestSite["days"]): string {
	const max = Math.max(1, ...days.map((d) => d.visitors));
	const cell = (d: DigestSite["days"][number]) => {
		const h = d.visitors ? Math.max(4, Math.round((d.visitors / max) * 56)) : 2;
		const colour = d.visitors === max ? BLUE : BAR;
		const fill = d.visitors ? colour : LINE;
		return `<td valign="bottom" style="vertical-align:bottom;padding:0 3px;width:14.28%" title="${n(d.visitors)}"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="width:100%"><tr><td height="${h}" bgcolor="${fill}" style="height:${h}px;background-color:${fill};border-radius:4px 4px 0 0;font-size:0;line-height:0">&nbsp;</td></tr></table></td>`;
	};
	const label = (d: DigestSite["days"][number]) => `<td style="padding:5px 3px 0;text-align:center;font-size:11px;color:${MUTE}">${when(d.day, { weekday: "short" }).slice(0, 2)}</td>`;
	return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;height:58px;table-layout:fixed"><tr>${days.map(cell).join("")}</tr><tr>${days.map(label).join("")}</tr></table>`;
}

// Gmail drops CSS backgrounds on divs and links, so colour comes from table cells with bgcolor too.
/** A white rounded card, with a gap under it. */
export function card(body: string, padding = "24px"): string {
	return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="width:100%;margin:0 0 16px"><tr><td bgcolor="#ffffff" style="background-color:#ffffff;border-radius:16px;padding:${padding}">${body}</td></tr></table>`;
}

/** A pill button: solid blue, or a blue outline. */
export function button(href: string, label: string, solid = true): string {
	const cell = solid ? `bgcolor="${BLUE}" style="background-color:${BLUE};border-radius:99px"` : `style="border:2px solid ${BLUE};border-radius:99px"`;
	return `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td ${cell}><a href="${href}" style="display:inline-block;color:${solid ? "#ffffff" : BLUE};text-decoration:none;font-weight:700;font-size:15px;padding:${solid ? "11px 18px" : "9px 16px"};border-radius:99px">${label}</a></td></tr></table>`;
}

export function topList(title: string, rows: { name: string; visitors: number }[]): string {
	const body = rows.length
		? rows.map((r) => `<tr><td style="padding:4px 8px 4px 0;font-size:14px;color:${INK};word-break:break-all">${esc(r.name)}</td><td style="padding:4px 0;font-size:14px;text-align:right;font-weight:700;color:${INK}">${n(r.visitors)}</td></tr>`).join("")
		: `<tr><td style="padding:4px 0;font-size:14px;color:${MUTE}">No visits yet</td></tr>`;
	return `<p style="margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${MUTE}">${title}</p><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%">${body}</table>`;
}

function siteCard(s: DigestSite, appHost: string): string {
	const pc = s.week.before ? Math.round(((s.week.now - s.week.before) / s.week.before) * 100) : null;
	const pill =
		pc === null
			? `<span style="color:${MUTE};font-size:14px">Your first full week</span>`
			: `<span style="display:inline-block;background-color:${pc >= 0 ? "#e7f4ea" : "#fbeee6"};color:${pc >= 0 ? UP : DOWN};font-weight:700;font-size:14px;padding:4px 10px;border-radius:99px">${pc > 0 ? "▲" : pc < 0 ? "▼" : "●"} ${Math.abs(pc)}%</span> <span style="color:${MUTE};font-size:13px">on the week before (${n(s.week.before)})</span>`;
	const link = `https://${appHost}/?site=${encodeURIComponent(s.site)}&range=7d`;
	const fixes = s.fixes.length
		? s.fixes
				.map(
					(f) =>
						`<tr><td style="padding:10px 0;border-top:1px solid ${LINE}"><a href="https://${esc(s.site)}${esc(f.page)}" style="color:${INK};font-weight:700;font-size:15px;text-decoration:none;word-break:break-all">${esc(f.page)}</a><div style="font-size:14px;color:${MUTE};margin-top:2px">${esc(f.what)}</div><div style="font-size:14px;color:${INK};margin-top:4px"><b style="color:${BLUE}">What to do:</b> ${esc(f.todo)}</div></td></tr>`,
				)
				.join("")
		: `<tr><td style="padding:10px 0;border-top:1px solid ${LINE};font-size:15px;color:${UP};font-weight:600">✓ Nothing needs fixing this week. Nice.</td></tr>`;
	return (
		card(
			`<p style="margin:0 0 2px;font-size:13px;color:${MUTE}">Last 7 days</p><h2 style="margin:0 0 14px;font-size:20px;color:${INK};word-break:break-all"><a href="${link}" style="color:${INK};text-decoration:none">${esc(s.site)}</a></h2>` +
			`<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 6px"><tr>` +
			`<td style="vertical-align:bottom;width:50%"><div style="font-size:44px;font-weight:800;line-height:1;color:${INK};letter-spacing:-.02em">${n(s.week.now)}</div><div style="font-size:14px;color:${MUTE};margin-top:4px">visitors · ${n(s.week.views)} page views</div></td>` +
			`<td style="vertical-align:bottom;width:50%;padding-left:12px">${bars(s.days)}</td></tr></table>` +
			`<p style="margin:10px 0 18px">${pill}</p>` +
			(s.money ? `<p style="margin:0 0 18px;font-size:15px;color:${INK}"><b style="color:${UP}">${esc(gbp(s.money.pence))}</b> earned from affiliate links${s.money.best ? `. Best post: <a href="https://${esc(s.site)}${esc(s.money.best.path)}" style="color:${INK};word-break:break-all">${esc(s.money.best.path)}</a> (${esc(gbp(s.money.best.pence))})` : ""}.</p>` : "") +
			`<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 18px"><tr><td style="vertical-align:top;width:50%;padding-right:10px">${topList("Top pages", s.pages)}</td><td style="vertical-align:top;width:50%;padding-left:10px">${topList("Top sources", s.sources)}</td></tr></table>` +
			`<p style="margin:0 0 2px;font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${MUTE}">Worth fixing</p><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px">${fixes}</table>` +
			button(link, "See the full stats →"),
		)
	);
}

/** The ReaderCount email layout: logo, a heading, a line under it, the cards, then the small print. */
export function emailPage(heading: string, intro: string, body: string, footer: string): string {
	return (
		`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>` +
		`<body style="margin:0;padding:0;background-color:#f6f5f2;font-family:${FONT};color:${INK}"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" bgcolor="#f6f5f2" style="width:100%;background-color:#f6f5f2"><tr><td align="center" style="padding:24px 12px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="width:100%;max-width:580px"><tr><td align="left" style="font-family:${FONT};color:${INK}">` +
		`<p style="margin:0 0 18px;font-size:22px;font-weight:800;letter-spacing:-.01em;color:${INK}">Reader<span style="color:${BLUE}">Count</span></p>` +
		`<h1 style="margin:0 0 4px;font-size:26px;line-height:1.2;color:${INK}">${heading}</h1><p style="margin:0 0 20px;font-size:16px;color:${MUTE}">${intro}</p>` +
		body +
		`<p style="margin:6px 4px 0;font-size:13px;color:${MUTE};line-height:1.5">${footer}</p>` +
		`</td></tr></table></td></tr></table></body></html>`
	);
}

export function digestHtml(sites: DigestSite[], appHost: string, now: number, more = { sites: 0, visitors: 0 }): string {
	return (
		`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>` +
		`<body style="margin:0;padding:0;background-color:#f6f5f2;font-family:${FONT};color:${INK}"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" bgcolor="#f6f5f2" style="width:100%;background-color:#f6f5f2"><tr><td align="center" style="padding:24px 12px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="width:100%;max-width:580px"><tr><td align="left" style="font-family:${FONT};color:${INK}">` +
		`<p style="margin:0 0 18px;font-size:22px;font-weight:800;letter-spacing:-.01em;color:${INK}">Reader<span style="color:${BLUE}">Count</span></p>` +
		`<h1 style="margin:0 0 4px;font-size:26px;line-height:1.2;color:${INK}">Your week in numbers</h1><p style="margin:0 0 20px;font-size:16px;color:${MUTE}">Good morning. Here's how ${sites.length + more.sites === 1 ? "your website" : more.sites ? `your ${sites.length} busiest websites` : "your websites"} did, ${esc(weekLabel(now))}.</p>` +
		sites.map((s) => siteCard(s, appHost)).join("") +
		(more.sites
			? card(`<p style="margin:0 0 12px;font-size:16px;color:${INK}">${moreLine(more)}</p>${button(`https://${appHost}/`, "View all your stats →", false)}`, "20px 24px")
			: "") +
		`<p style="margin:6px 4px 0;font-size:13px;color:${MUTE};line-height:1.5">Private, cookie-free stats from ReaderCount. You get this email because "Weekly Optimisation Digest" is switched on. <a href="https://${appHost}/#emails" style="color:${MUTE}">Switch it off in Settings</a>.</p>` +
		`</td></tr></table></td></tr></table></body></html>`
	);
}

/** Sends this Monday's emails. Safe to run twice: each account is sent at most one per day. */
export async function sendDigests(env: { DB: D1Database; EMAIL?: Mailer; APP_HOST?: string; MAIL_FROM?: string }, now: number): Promise<number> {
	if (!env.EMAIL || !env.APP_HOST) return 0;
	const today = utcDay(now);
	const from = mailFrom(env);
	const people = await env.DB.prepare("SELECT id, email FROM accounts WHERE digest = 1 AND status != 'unpaid' AND (digest_sent IS NULL OR digest_sent != ?)").bind(today).all<{ id: string; email: string }>();
	let sent = 0;
	for (const p of people.results ?? []) {
		if ((await accountPlan(env.DB, p.id, now)).ended) continue;
		const sites = await accountSites(env.DB, p.id);
		if (!sites.length) continue;
		const weeks = (await Promise.all(sites.map((site) => weekFor(env.DB, site, now)))).sort((a, b) => b.week.now - a.week.now);
		const shown = weeks.slice(0, DIGEST_MAX_SITES), rest = weeks.slice(DIGEST_MAX_SITES);
		const rows: DigestSite[] = await Promise.all(shown.map(async (w) => ({ ...w, fixes: await findFixes(env.DB, w.site, now, 5) })));
		const more = { sites: rest.length, visitors: rest.reduce((a, w) => a + w.week.now, 0) };
		try {
			await env.EMAIL.send({
				to: p.email,
				from: { email: from, name: "ReaderCount" },
				subject: digestSubject(rows, more),
				text: digestText(rows, env.APP_HOST, now, more),
				html: digestHtml(rows, env.APP_HOST, now, more),
			});
			await env.DB.prepare("UPDATE accounts SET digest_sent = ? WHERE id = ?").bind(today, p.id).run();
			sent++;
		} catch (e) {
			console.error("digest failed", p.id, e instanceof Error ? e.message : String(e));
		}
	}
	return sent;
}
