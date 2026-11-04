// Traffic spike alerts (every hour) and the Monthly review (07:00 UTC on the 1st). Both are on for every
// account unless switched off under Email preferences (accounts.spikes, accounts.monthly).

import { accountSites, type Mailer } from "./accounts.ts";
import { pageName } from "./dashboard.ts";
import { accountPlan } from "./plans.ts";
import { utcDay } from "./visitor.ts";
import { mailFrom } from "./host.ts";
import { BLUE, button, card, DOWN, emailPage, esc, INK, LINE, MUTE, topList, UP } from "./digest.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A page spikes when it gets at least this many visitors in an hour... */
export const SPIKE_MIN = 25;
/** ...and this many times its usual hourly visitors over the last two weeks. */
export const SPIKE_TIMES = 5;

export const MONTHLY_CRON = "0 7 1 * *";
export const HOURLY_CRON = "0 * * * *";

type Env = { DB: D1Database; EMAIL?: Mailer; APP_HOST?: string; MAIL_FROM?: string };
const num = (n: number) => Math.round(n).toLocaleString("en-GB");

async function people(env: Env, column: "spikes" | "monthly", now: number) {
	const rows = (await env.DB.prepare(`SELECT id, email FROM accounts WHERE ${column} = 1 AND status != 'unpaid'`).all<{ id: string; email: string }>()).results ?? [];
	const out: { id: string; email: string; sites: string[] }[] = [];
	for (const r of rows) {
		if ((await accountPlan(env.DB, r.id, now)).ended) continue;
		const sites = await accountSites(env.DB, r.id);
		if (sites.length) out.push({ ...r, sites });
	}
	return out;
}

/** Pages on a site getting far more visitors this past hour than they usually do. */
export async function findSpikes(db: D1Database, site: string, now: number): Promise<{ path: string; visitors: number; usual: number; sources: { name: string; visitors: number }[] }[]> {
	const hot = (await db
		.prepare("SELECT path, COUNT(DISTINCT visitor) AS visitors FROM events WHERE site = ? AND kind = 'view' AND ts >= ? GROUP BY path HAVING visitors >= ? ORDER BY visitors DESC LIMIT 5")
		.bind(site, now - HOUR, SPIKE_MIN)
		.all<{ path: string; visitors: number }>()).results ?? [];
	const out = [];
	for (const h of hot) {
		const before = await db
			.prepare("SELECT COUNT(DISTINCT visitor || day) AS v FROM events WHERE site = ? AND kind = 'view' AND path = ? AND ts >= ? AND ts < ?")
			.bind(site, h.path, now - 14 * DAY - HOUR, now - HOUR)
			.first<{ v: number }>();
		const usual = Number(before?.v ?? 0) / (14 * 24);
		if (Number(h.visitors) < SPIKE_TIMES * Math.max(usual, 1)) continue;
		const sources = (await db
			.prepare("SELECT COALESCE(NULLIF(source, ''), 'Direct') AS name, COUNT(DISTINCT visitor) AS visitors FROM events WHERE site = ? AND kind = 'view' AND path = ? AND ts >= ? GROUP BY 1 ORDER BY visitors DESC LIMIT 3")
			.bind(site, h.path, now - HOUR)
			.all<{ name: string; visitors: number }>()).results ?? [];
		out.push({ path: h.path, visitors: Number(h.visitors), usual, sources });
	}
	return out;
}

type Spike = Awaited<ReturnType<typeof findSpikes>>[number];

const big = (v: string, label: string) => `<div style="font-size:44px;font-weight:800;line-height:1;color:${INK};letter-spacing:-.02em">${v}</div><div style="font-size:14px;color:${MUTE};margin-top:4px">${label}</div>`;
const pill = (text: string, good: boolean) => `<span style="display:inline-block;background-color:${good ? "#e7f4ea" : "#fbeee6"};color:${good ? UP : DOWN};font-weight:700;font-size:14px;padding:4px 10px;border-radius:99px">${text}</span>`;

export function spikeHtml(site: string, s: Spike, appHost: string): string {
	const times = s.usual < 1 ? null : Math.round(s.visitors / s.usual);
	const link = `https://${appHost}/?site=${encodeURIComponent(site)}&range=today`;
	return emailPage(
		"A post is taking off",
		`Right now on ${esc(site)}.`,
		card(
			`<p style="margin:0 0 2px;font-size:13px;color:${MUTE}">Last hour</p><h2 style="margin:0 0 14px;font-size:20px;color:${INK};word-break:break-all"><a href="https://${esc(site)}${esc(s.path)}" style="color:${INK};text-decoration:none">${esc(pageName(s.path))}</a></h2>` +
				big(num(s.visitors), "visitors in the last hour") +
				`<p style="margin:12px 0 18px">${pill(times ? `▲ ${times}× its usual` : "▲ Far above its usual", true)} <span style="color:${MUTE};font-size:13px">usually ${s.usual < 1 ? "under 1" : `about ${num(s.usual)}`} an hour</span></p>` +
				`<div style="margin:0 0 18px">${topList("Where they're coming from", s.sources)}</div>` +
				`<p style="margin:0 0 16px;padding:12px 14px;background-color:#f4f7fd;border-radius:10px;font-size:14px;color:${INK};line-height:1.5"><b style="color:${BLUE}">Make the most of it:</b> share it again, reply to comments, and add a link to a related post or your newsletter.</p>` +
				button(link, "See it live →"),
		),
		`You get this because "Traffic spike alerts" is switched on. <a href="https://${appHost}/#emails" style="color:${MUTE}">Switch it off in Settings</a>.`,
	);
}

export async function sendSpikeAlerts(env: Env, now: number): Promise<number> {
	if (!env.EMAIL || !env.APP_HOST) return 0;
	const day = utcDay(now);
	let sent = 0;
	for (const p of await people(env, "spikes", now)) {
		for (const site of p.sites) {
			for (const s of await findSpikes(env.DB, site, now)) {
				// One email per page per day.
				const fresh = await env.DB.prepare("INSERT OR IGNORE INTO spikes (site, path, day, visitors) VALUES (?, ?, ?, ?) RETURNING site").bind(site, s.path, day, s.visitors).first();
				if (!fresh) continue;
				const from = s.sources.map((x) => `- ${x.name}: ${num(x.visitors)}`).join("\n");
				try {
					await env.EMAIL.send({
						to: p.email,
						from: { email: mailFrom(env), name: "ReaderCount" },
						subject: `“${pageName(s.path)}” is taking off: ${num(s.visitors)} visitors in the last hour`,
						html: spikeHtml(site, s, env.APP_HOST),
						text: `${num(s.visitors)} people read https://${site}${s.path} in the last hour. It usually gets ${s.usual < 1 ? "under 1" : `about ${num(s.usual)}`} an hour.\n\nWhere they're coming from:\n${from}\n\nNow's a good time to share it again, reply to comments, or add a link to a related post.\n\nSee it live: https://${env.APP_HOST}/?site=${encodeURIComponent(site)}&page=${encodeURIComponent(s.path)}\n\nSwitch these emails off under Settings › Email preferences.\n\nReaderCount`,
					});
					sent++;
				} catch (e) {
					console.error("spike alert failed", e instanceof Error ? e.message : String(e));
				}
			}
		}
	}
	return sent;
}

type MonthSite = { site: string; visitors: number; before: number; top: { path: string; visitors: number }[]; risers: { path: string; now: number; before: number }[]; fallers: { path: string; now: number; before: number }[] };

/** Last calendar month for one site, against the month before. */
export async function monthFor(db: D1Database, site: string, now: number): Promise<MonthSite> {
	const d = new Date(now);
	const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1), end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - DAY;
	const prevStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 1);
	const [a, b, pa] = [utcDay(start), utcDay(end), utcDay(prevStart)];
	const pb = utcDay(start - DAY);
	const V = "COUNT(DISTINCT visitor || day)";
	const total = async (x: string, y: string) => Number((await db.prepare(`SELECT ${V} AS v FROM events WHERE site = ? AND kind = 'view' AND day >= ? AND day <= ?`).bind(site, x, y).first<{ v: number }>())?.v ?? 0);
	const pages = async (x: string, y: string) => new Map(((await db.prepare(`SELECT path, ${V} AS v FROM events WHERE site = ? AND kind = 'view' AND day >= ? AND day <= ? GROUP BY path`).bind(site, x, y).all<{ path: string; v: number }>()).results ?? []).map((r) => [r.path, Number(r.v)]));
	const [visitors, before, nowPages, prevPages] = await Promise.all([total(a, b), total(pa, pb), pages(a, b), pages(pa, pb)]);
	const top = [...nowPages].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([path, v]) => ({ path, visitors: v }));
	const moves = [...new Set([...nowPages.keys(), ...prevPages.keys()])]
		.map((path) => ({ path, now: nowPages.get(path) ?? 0, before: prevPages.get(path) ?? 0 }))
		.filter((m) => m.now + m.before >= 20);
	const risers = moves.filter((m) => m.now > m.before).sort((x, y) => y.now - y.before - (x.now - x.before)).slice(0, 3);
	const fallers = moves.filter((m) => m.now < m.before).sort((x, y) => x.now - x.before - (y.now - y.before)).slice(0, 3);
	return { site, visitors, before, top, risers, fallers };
}

const pct = (now: number, before: number) => (before ? `${now >= before ? "+" : ""}${Math.round(((now - before) / before) * 100)}%` : "new");

export function monthlyText(sites: MonthSite[], monthName: string, appHost: string): string {
	const part = (s: MonthSite) =>
		[
			`${s.site}: ${num(s.visitors)} visitors in ${monthName} (${pct(s.visitors, s.before)} on the month before)`,
			s.top.length ? `Top posts:\n${s.top.map((t, i) => `${i + 1}. ${pageName(t.path)} (${num(t.visitors)})`).join("\n")}` : "",
			s.risers.length ? `Biggest risers:\n${s.risers.map((m) => `- ${pageName(m.path)}: ${num(m.before)} → ${num(m.now)}`).join("\n")}` : "",
			s.fallers.length ? `Biggest fallers:\n${s.fallers.map((m) => `- ${pageName(m.path)}: ${num(m.before)} → ${num(m.now)}`).join("\n")}` : "",
		]
			.filter(Boolean)
			.join("\n\n");
	return `Your ${monthName} in numbers.\n\n${sites.map(part).join("\n\n---\n\n")}\n\nSee everything: https://${appHost}/\n\nYou get this email on the first of each month. Switch it off under Settings › Email preferences.\n\nReaderCount`;
}

export function monthlyHtml(sites: MonthSite[], monthName: string, appHost: string): string {
	const moves = (title: string, list: MonthSite["risers"], up: boolean) =>
		list.length
			? `<p style="margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${MUTE}">${title}</p><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px">${list
					.map((m) => `<tr><td style="padding:4px 8px 4px 0;font-size:14px;color:${INK}">${esc(pageName(m.path))}</td><td style="padding:4px 0;font-size:14px;text-align:right;white-space:nowrap;color:${MUTE}">${num(m.before)} → <b style="color:${up ? UP : DOWN}">${num(m.now)}</b></td></tr>`)
					.join("")}</table>`
			: "";
	const one = (s: MonthSite) => {
		const pc = s.before ? Math.round(((s.visitors - s.before) / s.before) * 100) : null;
		return card(
			`<p style="margin:0 0 2px;font-size:13px;color:${MUTE}">${esc(monthName)}</p><h2 style="margin:0 0 14px;font-size:20px;color:${INK};word-break:break-all">${esc(s.site)}</h2>` +
				big(num(s.visitors), "visitors") +
				`<p style="margin:12px 0 18px">${pc === null ? `<span style="color:${MUTE};font-size:14px">Your first full month</span>` : `${pill(`${pc > 0 ? "▲" : pc < 0 ? "▼" : "●"} ${Math.abs(pc)}%`, pc >= 0)} <span style="color:${MUTE};font-size:13px">on the month before (${num(s.before)})</span>`}</p>` +
				`<div style="margin:0 0 16px;padding-top:12px;border-top:1px solid ${LINE}">${topList("Top posts", s.top.map((t) => ({ name: pageName(t.path), visitors: t.visitors })))}</div>` +
				moves("Biggest risers", s.risers, true) +
				moves("Biggest fallers", s.fallers, false) +
				button(`https://${appHost}/?site=${encodeURIComponent(s.site)}&range=30d`, "See the full month →"),
		);
	};
	return emailPage(`Your ${esc(monthName)} review`, "How the month went, and the posts that moved.", sites.map(one).join(""), `You get this on the 1st of each month because "Monthly review" is switched on. <a href="https://${appHost}/#emails" style="color:${MUTE}">Switch it off in Settings</a>.`);
}

export async function sendMonthlyReviews(env: Env, now: number): Promise<number> {
	if (!env.EMAIL || !env.APP_HOST) return 0;
	const d = new Date(now);
	const month = utcDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).slice(0, 7);
	const monthName = new Date(month + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
	let sent = 0;
	for (const p of await people(env, "monthly", now)) {
		const done = await env.DB.prepare("SELECT monthly_sent FROM accounts WHERE id = ?").bind(p.id).first<{ monthly_sent: string | null }>();
		if (done?.monthly_sent === month) continue;
		const sites = (await Promise.all(p.sites.map((s) => monthFor(env.DB, s, now)))).sort((a, b) => b.visitors - a.visitors).slice(0, 10);
		try {
			await env.EMAIL.send({ to: p.email, from: { email: mailFrom(env), name: "ReaderCount" }, subject: `Your ${monthName} review: ${num(sites.reduce((a, s) => a + s.visitors, 0))} visitors`, text: monthlyText(sites, monthName, env.APP_HOST), html: monthlyHtml(sites, monthName, env.APP_HOST) });
			await env.DB.prepare("UPDATE accounts SET monthly_sent = ? WHERE id = ?").bind(month, p.id).run();
			sent++;
		} catch (e) {
			console.error("monthly review failed", p.id, e instanceof Error ? e.message : String(e));
		}
	}
	return sent;
}
