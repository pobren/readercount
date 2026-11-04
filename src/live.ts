// ReaderCount: the live view. Who is on the website right now, the page each one is on, and the pages they've seen today.
// Still no cookies: a visitor is the same daily hash the rest of the stats use (src/visitor.ts), so a trail can't reach
// back past midnight or across websites, and the hash itself never leaves the server.

import { APP_HEAD } from "./pwa.ts";
import { CSS, LIVE, accountBar, country, duration, esc, flag, iconFor, linkSite, num, pageName } from "./dashboard.ts";
import { activeViews } from "./active.ts";
import { BTN_ICONS } from "./btn-icons.ts";

/** How often the live page fetches itself again while it's on screen. */
export const LIVE_EVERY_MS = 5_000;
const MAX_VISITORS = 50;
const MAX_STEPS = 12;

export type LiveStep = { ts: number; kind: string; path: string; target: string | null; seconds: number };
export type LiveVisitor = {
	country: string;
	device: string;
	browser: string;
	os: string;
	source: string;
	first: number;
	last: number;
	views: number;
	/** The page they're on now: their latest page view. */
	page: string;
	steps: LiveStep[];
};
export type Live = {
	site: string;
	now: number;
	/** Everyone active, even past the cards shown. */
	total: number;
	/** The page each active visitor is on, and where each came from today, counted over everyone. */
	pages: { path: string; n: number }[];
	sources: { name: string; n: number }[];
	/** The most recently active visitors, up to MAX_VISITORS. */
	visitors: LiveVisitor[];
};

type Row = { visitor: string; ts: number; kind: string; path: string; target: string | null; source: string | null; country: string | null; device: string | null; browser: string | null; os: string | null; duration: number | null };

export async function buildLive(db: D1Database, site: string, now: number): Promise<Live> {
	const [active, args] = activeViews(site, now);
	// With hundreds on the site, only the latest 50 get a card, but the count and both cards cover everyone.
	const [latest, total, pages, sources] = await Promise.all([
		db.prepare(`${active} ORDER BY ts DESC LIMIT ${MAX_VISITORS}`).bind(...args).all<{ visitor: string }>(),
		db.prepare(`SELECT COUNT(*) AS n FROM (${active})`).bind(...args).first<{ n: number }>(),
		db.prepare(`SELECT path, COUNT(*) AS n FROM (${active}) GROUP BY path ORDER BY n DESC LIMIT 20`).bind(...args).all<{ path: string; n: number }>(),
		// Where each came from: the source of their first page view today.
		db
			.prepare(
				`SELECT COALESCE(NULLIF(source, ''), 'Direct') AS name, COUNT(*) AS n FROM (SELECT source, ROW_NUMBER() OVER (PARTITION BY visitor ORDER BY ts) AS rn FROM events WHERE site = ? AND day IN (?, ?) AND kind = 'view' AND visitor IN (SELECT visitor FROM (${active}))) WHERE rn = 1 GROUP BY name ORDER BY n DESC LIMIT 20`,
			)
			.bind(site, args[1], args[2], ...args)
			.all<{ name: string; n: number }>(),
	]);
	const ids = (latest.results ?? []).map((r) => r.visitor);
	if (!ids.length) return { site, now, total: 0, pages: [], sources: [], visitors: [] };
	const trail = await db
		.prepare(`SELECT visitor, ts, kind, path, target, source, country, device, browser, os, duration FROM events WHERE site = ? AND day IN (?, ?) AND visitor IN (${ids.map(() => "?").join(", ")}) ORDER BY ts`)
		.bind(site, args[1], args[2], ...ids)
		.all<Row>();
	const by = new Map<string, Row[]>();
	for (const r of trail.results ?? []) by.set(r.visitor, [...(by.get(r.visitor) ?? []), r]);
	const visitors: LiveVisitor[] = [];
	for (const id of ids) {
		const rows = by.get(id) ?? [];
		const views = rows.filter((r) => r.kind === "view");
		if (!rows.length) continue;
		const first = views[0] ?? rows[0];
		const latest = views[views.length - 1] ?? rows[rows.length - 1];
		visitors.push({
			country: String(first.country ?? ""),
			device: String(first.device ?? ""),
			browser: String(first.browser ?? ""),
			os: String(first.os ?? ""),
			source: String(first.source || "Direct"),
			first: rows[0].ts,
			last: Math.max(...rows.map((r) => r.ts + 1000 * Number(r.duration ?? 0))),
			views: views.length,
			page: latest.path,
			steps: rows.map((r) => ({ ts: r.ts, kind: r.kind, path: r.path, target: r.target, seconds: Number(r.duration ?? 0) })),
		});
	}
	return { site, now, total: Number(total?.n ?? visitors.length), pages: pages.results ?? [], sources: sources.results ?? [], visitors };
}

/** "iPhone", "Mac", "Android tablet": what kind of device, from the browser's own description. */
export function deviceName(device: string, os: string): string {
	if (os === "iOS") return device === "tablet" ? "iPad" : "iPhone";
	if (os === "Android") return device === "tablet" ? "Android tablet" : "Android phone";
	if (os === "macOS") return "Mac";
	if (os === "Windows") return "Windows PC";
	if (os === "ChromeOS") return "Chromebook";
	if (os === "Linux") return "Linux computer";
	return device === "mobile" ? "Phone" : device === "tablet" ? "Tablet" : "Computer";
}

/** "just now", "40s ago", "3m ago", "2h 5m ago". */
export function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 15) return "just now";
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

export function renderLive(l: Live, sites: string[], opts: { email: string; titles?: Map<string, string> }): string {
	const title = (path: string) => opts.titles?.get(path) ?? pageName(path);
	const back = `/?site=${encodeURIComponent(l.site)}&range=today`;
	const count = l.total;

	// Pages being viewed now: each visitor counts once, on the page they're on.
	const pageRows = l.pages.map((p) => [p.path, Number(p.n)] as const);
	const max = Math.max(1, ...pageRows.map((p) => p[1]));
	const pagesCard = `<section class="card list"><h2>Pages Being Viewed Now</h2>${
		pageRows.length
			? `<div class="colh"><span>Page</span><span>Active Visitors</span></div><div class="rows">${pageRows
					.map(([path, n]) => `<div class="row"><span class="b" style="width:${Math.max(2, Math.round((n / max) * 100))}%"></span><a class="nm" href="https://${esc(l.site)}${esc(path)}" target="_blank" rel="noopener">${esc(title(path))}<small>${esc(path)}</small></a><span class="x"><b>${num(n)}</b></span></div>`)
					.join("")}</div>`
			: `<p class="empty">Nobody on the site right now</p>`
	}</section>`;

	const sourceRows = l.sources.map((s) => [s.name, Number(s.n)] as const);
	const smax = Math.max(1, ...sourceRows.map((s) => s[1]));
	const sourcesCard = `<section class="card list"><h2>Where Active Visitors Came From</h2>${
		sourceRows.length
			? `<div class="colh"><span>Acquisition Source</span><span>Active Visitors</span></div><div class="rows">${sourceRows
					.map(([name, n]) => `<div class="row"><span class="b" style="width:${Math.max(2, Math.round((n / smax) * 100))}%"></span>${iconFor(name)}<span class="nm">${esc(name)}</span><span class="x"><b>${num(n)}</b></span></div>`)
					.join("")}</div>`
			: `<p class="empty">Nobody on the site right now</p>`
	}</section>`;

	const step = (s: LiveStep, current: boolean) => {
		const when = `<span class="lv-when">${ago(l.now - s.ts)}</span>`;
		if (s.kind === "view") return `<li class="lv-step${current ? " now" : ""}"><span class="lv-dot" aria-hidden="true"></span><span class="lv-what">${esc(title(s.path))}${current ? `<span class="lv-tag">Now</span>` : ""}<small>${esc(s.path)}${s.seconds && !current ? ` · read for ${duration(s.seconds)}` : ""}</small></span>${when}</li>`;
		const label = s.kind === "goal" ? `Completed goal: ${s.target ?? ""}` : s.kind === "download" ? `Downloaded ${decodeLast(s.target)}` : `Clicked a link to ${linkSite(String(s.target ?? "")).name}`;
		return `<li class="lv-step ev"><span class="lv-dot" aria-hidden="true"></span><span class="lv-what">${esc(label)}</span>${when}</li>`;
	};
	const visitorCard = (v: LiveVisitor) => {
		const steps = v.steps.filter((s) => s.kind !== "leave");
		const lastView = steps.map((s) => s.kind).lastIndexOf("view");
		const shown = steps.slice(-MAX_STEPS);
		const hidden = steps.length - shown.length;
		const fresh = l.now - v.last < 60_000;
		return `<article class="card lv-visitor"><div class="lv-head">${flag(v.country)}<div><h3>Visitor from ${esc(country(v.country) === "Unknown" ? "an unknown country" : country(v.country))}</h3><p class="lv-meta">${esc(deviceName(v.device, v.os))} · ${esc(v.browser || "Other")} · came from ${esc(v.source)}</p></div><span class="live${fresh ? "" : " off"}" title="${fresh ? "Active in the last minute" : "On the page, no new activity for a minute or more"}"></span></div><p class="lv-sum">Arrived <b>${ago(l.now - v.first)}</b> · <b>${num(v.views)}</b> ${v.views === 1 ? "page" : "pages"} today</p><ol class="lv-trail">${hidden ? `<li class="lv-more">${num(hidden)} earlier ${hidden === 1 ? "step" : "steps"} today</li>` : ""}${shown.map((s, i) => step(s, steps.length - shown.length + i === lastView)).join("")}</ol></article>`;
	};

	const sitePicker = sites.length > 1 ? `<nav class="sites">${sites.map((s) => `<a href="${esc(`/live?site=${encodeURIComponent(s)}`)}"${s === l.site ? ' aria-current="page"' : ""}>${esc(s)}</a>`).join("")}</nav>` : "";
	return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><link rel="icon" href="/favicon.ico?v=2" sizes="any"><link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=2">${APP_HEAD}<title>Live · ${esc(l.site)} · ReaderCount</title><style>${CSS}${LIVE_CSS}</style>${BTN_ICONS}</head><body>
<header><div class="brand">Reader<span class="rc-c">Count</span></div>${accountBar(opts.email)}<p class="lv-back"><a href="${esc(back)}">‹ Back to ${esc(l.site)} stats</a></p><h1>Live Visitor Activity</h1>${sitePicker}</header>
<main>
<div class="toolbar"><span class="livepill"><span class="live${count ? "" : " off"}"></span>Real-Time Active Visitors: <b>${num(count)}</b></span><span class="hint">Everyone on ${esc(l.site)} now, and the pages they've viewed today. Visitors drop off as soon as they close the page or switch away from it. Updates every 5 seconds.</span></div>
${pagesCard}
${sourcesCard}
${count > l.visitors.length ? `<p class="lv-cap">Showing the ${num(l.visitors.length)} most recently active of ${num(count)} visitors. The count and the two cards above include everyone.</p>` : ""}<section class="lv-list">${count ? l.visitors.map(visitorCard).join("") : `<div class="card lv-empty"><h2>Nobody on the site right now</h2><p>Leave this page open: visitors appear here as they arrive, and drop off as soon as they leave.</p></div>`}</section>
${selfCard(sites)}
</main>
<footer>Live view (times are how long ago). A visitor who leaves no sign of going drops off 5 minutes after their last page view. No cookies: each visitor is a hash that changes every day, so their trail starts afresh at midnight (UTC) and never links to another day or website.</footer>
<script>${LIVE.replace("setInterval(tick,30000)", `setInterval(tick,${LIVE_EVERY_MS})`)}</script>
</body></html>`;
}

/** Links that stop counting this browser on each website: the tracker remembers #readercount-ignore in that browser only. */
function selfCard(sites: string[]): string {
	const links = sites.map((s) => `<a class="lv-ign" href="${esc(`https://${s}/#readercount-ignore`)}" target="_blank" rel="noopener">Leave me out on ${esc(s)} ›</a>`).join("");
	return `<section class="card lv-self"><h2>Leave Your Own Visits Out</h2><p class="gs-intro">Open each link once in every browser you use, on your computer, phone and tablet. From then on that browser isn't counted on that website, here or anywhere else in your stats. To be counted again, open the website with <code>#readercount-count</code> on the end of the address.</p><div class="lv-links">${links}</div></section>`;
}

function decodeLast(url: string | null): string {
	try {
		return decodeURIComponent(new URL(String(url)).pathname.split("/").filter(Boolean).pop() ?? "a file");
	} catch {
		return "a file";
	}
}

const LIVE_CSS = `
.lv-back{margin:4px 0 0;font-size:15px}.lv-back a{color:var(--mute);text-decoration:none}.lv-back a:hover{color:var(--accent)}
.lv-list{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:18px;align-items:start}
.lv-visitor{padding:18px 20px}.lv-head{display:flex;align-items:flex-start;gap:12px}.lv-head .flag{font-size:28px;line-height:1}.lv-head>div{flex:1;min-width:0}.lv-head h3{margin:0;font-size:19px;font-weight:700}.lv-head .live{margin-top:8px}
.lv-meta{margin:2px 0 0;color:var(--mute);font-size:15px}.lv-sum{margin:12px 0 10px;font-size:15px;color:var(--mute)}.lv-sum b{color:var(--ink)}
.lv-trail{list-style:none;margin:0;padding:0;position:relative}.lv-trail:before{content:"";position:absolute;left:5px;top:10px;bottom:10px;width:2px;background:var(--line)}
.lv-step{position:relative;display:flex;gap:12px;align-items:flex-start;padding:6px 0}.lv-dot{flex:none;width:12px;height:12px;border-radius:50%;background:var(--card);border:2px solid var(--mute);margin-top:6px;position:relative}
.lv-step.now .lv-dot{background:var(--up);border-color:var(--up)}.lv-step.ev .lv-dot{border-color:var(--accent);border-radius:3px}
.lv-what{flex:1;min-width:0;font-size:16px;overflow-wrap:anywhere}.lv-what small{display:block;color:var(--mute);font-size:13px}.lv-step.ev .lv-what{color:var(--accent);font-size:15px}
.lv-when{flex:none;color:var(--mute);font-size:13px;margin-top:3px}.lv-tag{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:999px;background:var(--up);color:#fff;font-size:12px;font-weight:700;vertical-align:2px}
.lv-more{color:var(--mute);font-size:13px;padding:2px 0 6px 24px}.lv-self{grid-column:1/-1}.lv-links{display:flex;flex-wrap:wrap;gap:10px}.lv-ign{display:inline-block;padding:8px 14px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--accent);text-decoration:none;font-weight:600;font-size:15px}.lv-ign:hover{border-color:var(--accent)}.lv-cap{grid-column:1/-1;margin:0;color:var(--mute);font-size:15px}.lv-empty{grid-column:1/-1;text-align:center;padding:40px 20px}.lv-empty p{color:var(--mute);margin:0}
@media (max-width:520px){.lv-list{grid-template-columns:minmax(0,1fr)}}`;
