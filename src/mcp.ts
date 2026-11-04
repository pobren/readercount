// ReaderCount's Claude connector: a read-only MCP server (Streamable HTTP, plain JSON replies, no streams).
// Add it in Claude with Settings, Connectors, Add custom connector, and the address https://STATS-ADDRESS/mcp,
// then sign in with the ReaderCount password (OAuth, src/oauth.ts). It can only read the stats; it can't change anything.

import { earningsByPage } from "./earnings.ts";
import { moneyReport } from "./money.ts";
import { buildReport, RANGES, rangeStart, READ, type Range } from "./dashboard.ts";
import { notesBetween } from "./history.ts";
import { utcDay } from "./visitor.ts";

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `ReaderCount is a private, cookie-free stats service. These tools read one website owner's stats.
- "Visitors" are counted per day: the same person on two days counts twice (there are no cookies to link days). Over a period, visitors is the sum of each day's visitors.
- Times are UTC and dates are YYYY-MM-DD. "today" is the current UTC day so far.
- source is where a visit came from: a friendly name such as Google, Reddit or X (Twitter), a utm_source tag, or "Direct" (typed in, bookmarks, apps that hide where they came from).
- Clicks are clicks on links to other websites (such as affiliate links) and on file downloads. Each click is linked to the page view it happened on, so clicks can be broken down by the reader's source, country or device.
- country is a two-letter code (GB, US, ...). device is mobile, tablet or desktop. avg_seconds is time on page while it was on screen (up to 30 minutes a page, so a tab left open doesn't skew it).
- get_google_searches reads Google Search Console (when the owner has connected it): the searches that showed their pages in Google ("impressions"), clicks from Google, and average position (1 = top). Google's figures arrive two or three days late and leave out rare searches.
- get_earnings reads the owner's affiliate earnings (uploaded reports and connected networks such as Awin, Impact or CJ), laid over the stats: per post (with earnings per 1,000 readers), by source, by Google search, by shop (clicks against earnings), by device, posts worth updating and Amazon links readers in other countries can't earn from. Money is in pounds. Sales a network ties to a post count for it exactly; others are shared by clicks, so treat per-post figures as estimates.
Start with get_overview, then use get_breakdown to answer specific questions.`;

const PERIOD = { type: "string", enum: Object.keys(RANGES), description: "today, 7d (last 7 days), 30d or 12m. Ignored when from and to are given. Default 30d." };
const SITE = { type: "string", description: "The website, e.g. example.com. Default: the first site (see list_sites)." };
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

const TOOLS = [
	{
		name: "list_sites",
		title: "List sites",
		description: "The websites this ReaderCount counts.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "get_overview",
		title: "Stats overview",
		description:
			"The headline stats for a period, with the period before for comparison: visitors, page views, time on page, bounce rate, people on the site now (dropped as soon as they close the page, or 5 minutes after their last page view), visitors per day (imported: true marks days brought in from the owner's older stats), the owner's notes on the chart (what they did on a day, useful for explaining a spike), top pages, sources, campaigns, countries, devices, browsers, and link clicks and downloads.",
		inputSchema: { type: "object", properties: { site: SITE, period: PERIOD } },
	},
	{
		name: "get_breakdown",
		title: "Stats breakdown",
		description:
			"Break page views or link clicks down by one thing (page, source, country, day...), optionally filtered, for any date range. Examples: top pages from Reddit last week; affiliate link clicks by source this month; mobile visitors per day; which pages Amazon links are clicked on.",
		inputSchema: {
			type: "object",
			properties: {
				site: SITE,
				of: { type: "string", enum: ["views", "clicks"], description: "views (page views, visitors, time on page) or clicks (outbound link clicks and downloads). Default views." },
				by: {
					type: "string",
					enum: ["page", "source", "campaign", "medium", "country", "device", "browser", "os", "day", "link"],
					description: "What to group by. link only works with of=clicks.",
				},
				period: PERIOD,
				from: { ...DATE, description: "First day, YYYY-MM-DD (UTC). Use with to." },
				to: { ...DATE, description: "Last day, YYYY-MM-DD (UTC), inclusive." },
				page: { type: "string", description: "Only this page path, e.g. /fastmail-review/. End with * to match the start, e.g. /reviews/*" },
				source: { type: "string", description: "Only visits from this source, e.g. Google, Reddit, Direct." },
				campaign: { type: "string", description: "Only this utm_campaign." },
				country: { type: "string", description: "Only this two-letter country code, e.g. GB." },
				device: { type: "string", enum: ["mobile", "tablet", "desktop"] },
				browser: { type: "string", description: "e.g. Safari, Chrome." },
				link_contains: { type: "string", description: "For clicks: only links whose address contains this text, e.g. amazon." },
				limit: { type: "integer", minimum: 1, maximum: 100, description: "Most rows to return. Default 25." },
			},
			required: ["by"],
		},
	},
	{
		name: "get_google_searches",
		title: "Google searches",
		description:
			"From Google Search Console (if connected): the Google searches that showed the site's pages, with clicks, impressions (times shown) and average position. Group by search term, page or day, and filter by page or by words in the search. Use it for questions like: what do people search to find my Fastmail review; which posts rank on page 2 of Google; which searches get seen but not clicked.",
		inputSchema: {
			type: "object",
			properties: {
				site: SITE,
				by: { type: "string", enum: ["query", "page", "day"], description: "Group by search term (query), page or day. Default query." },
				period: PERIOD,
				from: { ...DATE, description: "First day, YYYY-MM-DD." },
				to: { ...DATE, description: "Last day, YYYY-MM-DD, inclusive." },
				page: { type: "string", description: "Only this page path, e.g. /fastmail-review/. End with * to match the start." },
				query_contains: { type: "string", description: "Only searches containing this text, e.g. fastmail." },
				sort: { type: "string", enum: ["clicks", "impressions", "position"], description: "Default clicks." },
				limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 25." },
			},
		},
	},
	{
		name: "get_earnings",
		title: "Affiliate earnings",
		description:
			"The owner's affiliate earnings for a period, laid over the stats: total, per post (with earnings per 1,000 readers), by the source readers came from, by Google search, by shop (clicks against earnings), by device, posts that earn well but are slipping, and Amazon stores readers in other countries click. Use it for questions like which posts earn most per reader, which sources or searches make money, or which links get clicks but no sales.",
		inputSchema: { type: "object", properties: { site: SITE, period: PERIOD } },
	},
].map((t) => ({ ...t, annotations: { title: t.title, readOnlyHint: true, openWorldHint: false } }));

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** Handles one POST to the connector. The caller has already checked the key. */
export async function handleMcp(request: Request, db: D1Database, sites: string[], now = Date.now(), owner = "key"): Promise<Response> {
	if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
	}
	const batch = Array.isArray(body);
	const messages = (batch ? body : [body]) as Rpc[];
	const origin = new URL(request.url).origin;
	const replies = (await Promise.all(messages.map((m) => answer(m, db, sites, now, owner, origin)))).filter((r) => r !== null);
	if (!replies.length) return new Response(null, { status: 202 });
	return json(batch ? replies : replies[0]);
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function answer(msg: Rpc, db: D1Database, sites: string[], now: number, owner: string, origin: string): Promise<unknown> {
	if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
		return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid request" } };
	}
	if (msg.id === undefined || msg.id === null) return null; // a notification: nothing to send back
	const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
	switch (msg.method) {
		case "initialize": {
			const asked = String(msg.params?.protocolVersion ?? "");
			return ok({
				protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
				capabilities: { tools: {} },
				serverInfo: {
					name: "readercount",
					title: "ReaderCount",
					version: "1.1.0",
					websiteUrl: "https://paulobrien.dev/readercount/",
					icons: [
						{ src: `${origin}/icon.png`, mimeType: "image/png", sizes: ["512x512"] },
						{ src: `${origin}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
					],
				},
				instructions: INSTRUCTIONS,
			});
		}
		case "ping":
			return ok({});
		case "tools/list":
			return ok({ tools: TOOLS });
		case "tools/call": {
			const name = String(msg.params?.name ?? "");
			const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
			if (!TOOLS.some((t) => t.name === name)) return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
			try {
				const data = await callTool(name, args, db, sites, now, owner);
				return ok({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
			} catch (e) {
				return ok({ content: [{ type: "text", text: e instanceof Error ? e.message : "Something went wrong" }], isError: true });
			}
		}
		default:
			return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
	}
}

function pickSite(args: Record<string, unknown>, sites: string[]): string {
	const asked = String(args.site ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
	if (!asked) {
		if (!sites[0]) throw new Error("No sites are set up yet.");
		return sites[0];
	}
	if (!sites.includes(asked)) throw new Error(`Unknown site "${asked}". Sites: ${sites.join(", ")}`);
	return asked;
}

function pickRange(args: Record<string, unknown>): Range {
	const p = String(args.period ?? "");
	return Object.hasOwn(RANGES, p) ? (p as Range) : "30d";
}

async function callTool(name: string, args: Record<string, unknown>, db: D1Database, sites: string[], now: number, owner: string): Promise<Record<string, unknown>> {
	if (name === "list_sites") return { sites };
	if (name === "get_overview") return overview(args, db, sites, now);
	if (name === "get_google_searches") return googleSearches(args, db, sites, now, owner);
	if (name === "get_earnings") return earnings(args, db, sites, now);
	return breakdown(args, db, sites, now);
}

/** Affiliate earnings over the stats (src/money.ts), in pounds. */
async function earnings(args: Record<string, unknown>, db: D1Database, sites: string[], now: number): Promise<Record<string, unknown>> {
	const site = pickSite(args, sites), range = pickRange(args), from = rangeStart(range, now), to = utcDay(now);
	const [pages, m] = await Promise.all([earningsByPage(db, site, from, to), moneyReport(db, site, from, to, now)]);
	if (!m) return { site, period: range, from, to, note: "No earnings in this period. The owner can connect an affiliate network or upload a report in Settings › Earnings per post." };
	const readers = new Map(((await db.prepare("SELECT path, COUNT(DISTINCT day || visitor) AS n FROM events WHERE site = ? AND kind = 'view' AND day >= ? AND day <= ? GROUP BY path").bind(site, from, to).all<{ path: string; n: number }>()).results ?? []).map((r) => [r.path, Number(r.n)]));
	const gbp = (p: number) => Math.round(p) / 100;
	const perK = (p: number, n: number) => (n ? Math.round((p * 1000) / n) / 100 : null);
	return {
		site,
		period: range,
		from,
		to,
		total_gbp: gbp(m.total),
		posts: pages.slice(0, 50).map((p) => ({ page: p.path, earnings_gbp: gbp(p.pence), readers: readers.get(p.path) ?? 0, per_1000_readers_gbp: perK(p.pence, readers.get(p.path) ?? 0) })),
		sources: m.sources.map((x) => ({ source: x.name, earnings_gbp: gbp(x.pence), readers: x.visitors, per_1000_readers_gbp: perK(x.pence, x.visitors ?? 0) })),
		google_searches: m.searches.slice(0, 25).map((x) => ({ search: x.name, page: x.page, earnings_gbp: gbp(x.pence), clicks_from_google: x.clicks })),
		shops: m.shops.map((x) => ({ shop: x.name, clicks: x.clicks, earnings_gbp: gbp(x.pence) })),
		devices: m.devices.map((x) => ({ device: x.name, clicks: x.clicks, earnings_gbp: gbp(x.pence) })),
		worth_updating: m.update.map((x) => ({ page: x.path, earns_a_month_gbp: gbp(x.monthly), why: x.why })),
		wrong_country_amazon_links: m.wrongCountry,
		shops_stopped_paying: m.stopped.map((x) => ({ shop: x.shop, clicks_last_14_days: x.clicks, earned_before_gbp: gbp(x.before) })),
	};
}

/** The headline stats for a period (get_overview, and /v1/overview in src/api.ts). */
export async function overview(args: Record<string, unknown>, db: D1Database, sites: string[], now: number): Promise<Record<string, unknown>> {
	const r = await buildReport(db, pickSite(args, sites), pickRange(args), now);
	return {
		site: r.site,
		period: r.range,
		from: r.from,
		to: r.to,
		totals: { visitors: r.totals.visitors, views: r.totals.views, avg_seconds: r.totals.avgSeconds, bounce_percent: r.totals.bounce, on_site_now: r.totals.now },
		previous_period: { visitors: r.previous.visitors, views: r.previous.views },
		per_day: r.days,
		notes: (await notesBetween(db, r.site, r.from, r.to)).map((n) => ({ day: n.day, note: n.text })),
		top_pages: r.pages.map((p) => ({ page: p.path, visitors: p.visitors, views: p.views, avg_seconds: p.secs })),
		sources: r.sources.map((s) => ({ source: s.name, visitors: s.visitors })),
		campaigns: r.campaigns.map((s) => ({ campaign: s.name, visitors: s.visitors })),
		countries: r.countries.map((s) => ({ country: s.name, visitors: s.visitors })),
		devices: r.devices.map((s) => ({ device: s.name, visitors: s.visitors })),
		browsers: r.browsers.map((s) => ({ browser: s.name, visitors: s.visitors })),
		clicks: r.clicks.map((c) => ({ link: c.target, type: c.kind, page: c.path, clicks: c.clicks })),
	};
}

function dates(args: Record<string, unknown>, now: number): [string, string] {
	const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
	if (isDate(args.from) && isDate(args.to)) {
		const a = String(args.from), b = String(args.to);
		return a <= b ? [a, b] : [b, a];
	}
	return [rangeStart(pickRange(args), now), utcDay(now)];
}

export async function googleSearches(args: Record<string, unknown>, db: D1Database, sites: string[], now: number, owner = "key"): Promise<Record<string, unknown>> {
	const site = pickSite(args, sites);
	const connected = await db.prepare("SELECT synced_at, last_error FROM google_links WHERE owner = ?").bind(owner).first<{ synced_at: number | null; last_error: string | null }>();
	if (!connected) throw new Error("Google Search Console isn't connected yet. The owner can connect it from the stats page.");
	const by = ["query", "page", "day"].includes(String(args.by)) ? String(args.by) : "query";
	const [from, to] = dates(args, now);
	const where = ["site = ?", "day >= ?", "day <= ?"];
	const binds: unknown[] = [site, from, to];
	if (args.page) {
		const p = String(args.page).slice(0, 300);
		if (p.endsWith("*")) {
			where.push("page LIKE ? ESCAPE '\\'");
			binds.push(p.slice(0, -1).replace(/[\\%_]/g, (c) => "\\" + c) + "%");
		} else {
			where.push("page = ?");
			binds.push(p);
		}
	}
	if (args.query_contains) {
		where.push("INSTR(LOWER(query), LOWER(?)) > 0");
		binds.push(String(args.query_contains).slice(0, 200));
	}
	const limit = Math.min(100, Math.max(1, Math.round(Number(args.limit) || 25)));
	const sort = by === "day" ? "day" : args.sort === "impressions" ? "impressions DESC" : args.sort === "position" ? "position ASC" : "clicks DESC, impressions DESC";
	const metrics = "SUM(clicks) AS clicks, SUM(impressions) AS impressions, ROUND(SUM(position * impressions) / MAX(SUM(impressions), 1), 1) AS position";
	const filtered = Boolean(args.page || args.query_contains);
	const [rows, total] = await Promise.all([
		db.prepare(`SELECT ${by}, ${metrics} FROM search WHERE ${where.join(" AND ")} GROUP BY ${by} ORDER BY ${sort} LIMIT ${limit}`).bind(...binds).all(),
		filtered
			? db.prepare(`SELECT ${metrics} FROM search WHERE ${where.join(" AND ")}`).bind(...binds).first()
			: db.prepare(`SELECT ${metrics} FROM search_days WHERE site = ? AND day >= ? AND day <= ?`).bind(site, from, to).first(),
	]);
	const last = await db.prepare("SELECT MAX(day) AS day FROM search_days WHERE site = ?").bind(site).first<{ day: string | null }>();
	return {
		site,
		by,
		from,
		to,
		latest_day_with_data: last?.day ?? null,
		note: connected.last_error ?? undefined,
		total,
		rows: rows.results ?? [],
	};
}

// Where each thing lives. For clicks, where the reader came from is on the page view the click happened on (v).
const VIEW_COLS: Record<string, string> = { page: "path", source: "source", campaign: "utm_campaign", medium: "utm_medium", country: "country", device: "device", browser: "browser", os: "os", day: "day" };
const CLICK_COLS: Record<string, string> = { page: "c.path", source: "v.source", campaign: "v.utm_campaign", medium: "v.utm_medium", country: "c.country", device: "c.device", browser: "c.browser", os: "c.os", day: "c.day", link: "c.target" };

export async function breakdown(args: Record<string, unknown>, db: D1Database, sites: string[], now: number): Promise<Record<string, unknown>> {
	const site = pickSite(args, sites);
	const clicks = args.of === "clicks";
	const cols = clicks ? CLICK_COLS : VIEW_COLS;
	const by = String(args.by ?? "");
	if (!Object.hasOwn(cols, by)) throw new Error(by === "link" ? "by=link only works with of=clicks." : `Can't group by "${by}".`);

	let from: string, to: string;
	const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
	if (isDate(args.from) && isDate(args.to)) {
		from = String(args.from);
		to = String(args.to);
		if (from > to) [from, to] = [to, from];
	} else {
		const range = pickRange(args);
		from = rangeStart(range, now);
		to = utcDay(now);
	}

	const where: string[] = [];
	const binds: unknown[] = [];
	const shown = (col: string) => (col.endsWith("source") ? `COALESCE(NULLIF(${col}, ''), 'Direct')` : col);
	const filter = (key: string, value: unknown) => {
		if (value === undefined || value === null || value === "") return;
		const v = String(value).slice(0, 300);
		if (key === "page" && v.endsWith("*")) {
			where.push(`${cols.page} LIKE ? ESCAPE '\\'`);
			binds.push(v.slice(0, -1).replace(/[\\%_]/g, (c) => "\\" + c) + "%");
		} else {
			where.push(`LOWER(${shown(cols[key])}) = LOWER(?)`);
			binds.push(v);
		}
	};
	for (const k of ["page", "source", "campaign", "country", "device", "browser"]) filter(k, args[k]);
	if (args.link_contains) {
		if (!clicks) throw new Error("link_contains only works with of=clicks.");
		where.push("INSTR(LOWER(c.target), LOWER(?)) > 0");
		binds.push(String(args.link_contains).slice(0, 200));
	}
	const limit = Math.min(100, Math.max(1, Math.round(Number(args.limit) || 25)));
	const extra = where.length ? " AND " + where.join(" AND ") : "";
	const group = shown(cols[by]);
	const order = by === "day" ? "1" : clicks ? "clicks DESC" : "views DESC";

	const sql = clicks
		? {
				from: `FROM events c LEFT JOIN events v ON v.view_id = c.view_id AND v.site = c.site AND v.kind = 'view' WHERE c.site = ? AND c.kind IN ('outbound', 'download') AND c.day >= ? AND c.day <= ?${extra}`,
				metrics: "COUNT(*) AS clicks, COUNT(DISTINCT c.visitor || c.day) AS visitors",
			}
		: {
				from: `FROM events WHERE site = ? AND kind = 'view' AND day >= ? AND day <= ?${extra}`,
				metrics: `COUNT(*) AS views, COUNT(DISTINCT visitor || day) AS visitors, CAST(AVG(${READ}) AS INTEGER) AS avg_seconds`,
			};
	const all = [site, from, to, ...binds];
	const [rows, total] = await Promise.all([
		db.prepare(`SELECT ${group} AS "${by}", ${sql.metrics} ${sql.from} GROUP BY 1 ORDER BY ${order} LIMIT ${limit}`).bind(...all).all(),
		db.prepare(`SELECT ${sql.metrics} ${sql.from}`).bind(...all).first(),
	]);
	const filters = Object.fromEntries(["page", "source", "campaign", "country", "device", "browser", "link_contains"].filter((k) => args[k]).map((k) => [k, args[k]]));
	return { site, of: clicks ? "clicks" : "views", by, from, to, filters, total, rows: rows.results ?? [] };
}
