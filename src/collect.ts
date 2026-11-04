// ReaderCount: check one message from the tracker and turn it into a row for the events table.
// Pure functions only, so they can be tested without a Worker.

import { isBot, parseAgent } from "./agent.ts";
import { referrerHost, sourceName } from "./referrer.ts";
import { aiService } from "./ai.ts";

/** Something that went wrong on a page, as the reader's browser saw it: a picture or other file that didn't load, or a script error. */
export type Problem = { kind: "image" | "file" | "script"; url: string; message: string };

/** Extras on a "leave" message: plain numbers about the page, never about the reader. */
export type PageExtras = {
	/** How far down the page the reader got, 0 to 100. */
	scroll?: number;
	/** Core Web Vitals for the first page of a visit: largest paint and worst tap delay in ms, layout shift x 1000. */
	lcp?: number;
	inp?: number;
	cls?: number;
	problems?: Problem[];
	/** Names of forms the reader started filling in (the same names as their "Form: ..." goals). */
	forms?: string[];
};

export type Hit =
	| ({ kind: "leave"; site: string; viewId: string; seconds: number } & PageExtras)
	| { kind: "back"; site: string; viewId: string }
	| {
			kind: "view" | "outbound" | "download" | "goal";
			site: string;
			viewId: string | null;
			path: string;
			target: string | null;
			referrer: string;
			source: string;
			utmMedium: string;
			utmCampaign: string;
			device: string;
			browser: string;
			os: string;
			/** A view of a "not found" page. */
			missing?: boolean;
	  };

const KINDS = { v: "view", o: "outbound", d: "download", g: "goal", l: "leave", b: "back" } as const;
const MAX_SECONDS = 4 * 60 * 60;
const PROBLEM_KINDS = { i: "image", f: "file", j: "script" } as const;
/** A reader who leaves within this many seconds cuts off pictures still loading, so those aren't reported as broken. */
const QUICK_LEAVE = 3;

/** The sites this install counts, from the SITES setting ("example.com, blog.example.org"). */
export function siteList(setting: string | undefined): string[] {
	return (setting ?? "")
		.split(/[\s,]+/)
		.map((s) => s.trim().toLowerCase().replace(/^www\./, ""))
		.filter(Boolean);
}

/** The page's host belongs to the site: the site itself, www., or any other subdomain of it. */
export function belongsTo(host: string, site: string): boolean {
	host = host.toLowerCase();
	return host === site || host.endsWith("." + site);
}

/** Returns the hit to record, or a short reason it was ignored. A page on the wrong website also says which website it was. */
export function parseHit(body: unknown, userAgent: string, sites: string[]): Hit | { ignored: string; site?: string; host?: string } {
	if (!body || typeof body !== "object") return { ignored: "not json" };
	const o = body as Record<string, unknown>;
	const kind = KINDS[String(o.k) as keyof typeof KINDS];
	if (!kind) return { ignored: "unknown kind" };
	const site = String(o.s ?? "").toLowerCase().replace(/^www\./, "");
	if (!sites.includes(site)) return { ignored: "unknown site" };
	if (isBot(userAgent)) return { ignored: "bot" };
	const viewId = typeof o.v === "string" && /^[a-z0-9]{4,16}$/.test(o.v) ? o.v : null;

	if (kind === "leave") {
		const seconds = Math.round(Number(o.d));
		const extras = pageExtras(o);
		// Pictures that "didn't load" for a reader who left within a few seconds were cut off by leaving, or blocked by a
		// bot or preview tool that shows the page for a moment. When no picture on the page loaded at all (a = 0), the
		// reader's browser was blocking pictures (a bot, a data saver or an extension). Either way they aren't missing
		// from the website, so they aren't kept.
		if ((seconds < QUICK_LEAVE || o.a === 0) && extras.problems) {
			const kept = extras.problems.filter((p) => p.kind !== "image");
			if (kept.length) extras.problems = kept;
			else delete extras.problems;
		}
		// A leave under a second is only worth keeping for what it says about the page.
		if (!viewId || !Number.isFinite(seconds) || seconds < 0 || (seconds < 1 && !extras.problems && !extras.forms)) return { ignored: "bad leave" };
		return { kind, site, viewId, seconds: Math.min(seconds, MAX_SECONDS), ...extras };
	}
	// The reader came back to a page they'd hidden.
	if (kind === "back") return viewId ? { kind, site, viewId } : { ignored: "bad back" };

	let page: URL;
	try {
		page = new URL(String(o.u));
	} catch {
		return { ignored: "bad url" };
	}
	if (!/^https?:$/.test(page.protocol)) return { ignored: "bad url" };
	if (!belongsTo(page.hostname, site)) return { ignored: "wrong site", site, host: page.hostname.toLowerCase().slice(0, 100) };

	let target: string | null = null;
	if (kind === "goal") {
		// A goal's target is its name, such as "Newsletter sign-up".
		target = clip(String(o.t ?? "").replace(/\s+/g, " "), 80);
		if (!target) return { ignored: "bad goal" };
	} else if (kind !== "view") {
		try {
			const t = new URL(String(o.t));
			if (!/^https?:$/.test(t.protocol)) return { ignored: "bad link" };
			target = t.href.slice(0, 500);
		} catch {
			return { ignored: "bad link" };
		}
	}

	// A missing page reached from another page of the same website: that page has a broken link. Kept as its address, in target.
	if (kind === "view" && o.m === 1) {
		try {
			const from = new URL(String(o.r ?? ""));
			if (belongsTo(from.hostname, site) && from.pathname !== page.pathname) target = clip(decodePath(from.pathname), 300) || "/";
		} catch {}
	}

	const q = page.searchParams;
	const refHost = referrerHost(String(o.r ?? ""), page.hostname);
	const utmSource = clip(q.get("utm_source") ?? q.get("ref") ?? "", 100);
	const agent = parseAgent(userAgent);
	return {
		kind,
		site,
		viewId,
		path: clip(decodePath(page.pathname), 300) || "/",
		target,
		referrer: refHost,
		// ChatGPT tags its links utm_source=chatgpt.com: count it as ChatGPT, the same as its referrer.
		source: aiService(utmSource) || utmSource || sourceName(refHost),
		utmMedium: clip(q.get("utm_medium") ?? "", 100),
		utmCampaign: clip(q.get("utm_campaign") ?? "", 100),
		...agent,
		...(kind === "view" && o.m === 1 ? { missing: true } : {}),
	};
}

/** A whole number between lo and hi, or nothing. */
function whole(v: unknown, lo: number, hi: number): number | undefined {
	const n = Math.round(Number(v));
	return v === undefined || v === null || !Number.isFinite(n) ? undefined : Math.max(lo, Math.min(hi, n));
}

/** Takes anything personal out of a script error before it's kept: email addresses, long numbers and anything after ? in an address. */
export function scrub(text: string): string {
	return text
		.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
		.replace(/(https?:\/\/[^\s?#'"]+)[?#][^\s'"]*/g, "$1")
		.replace(/\d{5,}/g, "#")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 150);
}

export function pageExtras(o: Record<string, unknown>): PageExtras {
	const out: PageExtras = {};
	const scroll = whole(o.p, 0, 100), lcp = whole(o.c, 0, 120_000), inp = whole(o.i, 0, 60_000), cls = whole(o.x, 0, 10_000);
	if (scroll !== undefined) out.scroll = scroll;
	// 0 means the browser didn't measure it (Safari has no tap delay, for one).
	if (lcp) out.lcp = lcp;
	if (inp) out.inp = inp;
	if (cls !== undefined && o.c) out.cls = cls;
	if (Array.isArray(o.e)) {
		const problems: Problem[] = [];
		for (const p of o.e.slice(0, 3)) {
			if (!Array.isArray(p)) continue;
			const kind = PROBLEM_KINDS[String(p[0]) as keyof typeof PROBLEM_KINDS];
			let url: URL;
			try {
				url = new URL(String(p[1]));
			} catch {
				continue;
			}
			if (!kind || !/^https?:$/.test(url.protocol) || url.username || url.password) continue;
			problems.push({ kind, url: (url.origin + decodePath(url.pathname)).slice(0, 300), message: kind === "script" ? scrub(String(p[2] ?? "")) : "" });
		}
		if (problems.length) out.problems = problems;
	}
	if (Array.isArray(o.f)) {
		const forms = [...new Set(o.f.slice(0, 5).map((f) => clip(String(f).replace(/\s+/g, " "), 80)).filter(Boolean))];
		if (forms.length) out.forms = forms;
	}
	return out;
}

function decodePath(p: string): string {
	try {
		return decodeURIComponent(p);
	} catch {
		return p;
	}
}

function clip(s: string, n: number): string {
	return s.trim().slice(0, n);
}
