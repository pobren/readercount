// ReaderCount: the media kit, a one-page PDF of a website's audience (visitors, countries, devices and top posts)
// for sponsors and advertisers. Drawn straight into a PDF, so it needs no browser and looks the same everywhere.

import { buildReport, pageName } from "./dashboard.ts";
import { historyBetween } from "./history.ts";
import { titlesFor } from "./ghost.ts";
import { utcDay } from "./visitor.ts";

export type MediaKit = {
	site: string;
	from: string;
	to: string;
	visitors: number;
	views: number;
	avgSeconds: number;
	/** Visitors each month, oldest first, for up to the last 12 months. */
	months: { month: string; visitors: number }[];
	countries: { code: string; visitors: number }[];
	devices: { name: string; visitors: number }[];
	sources: { name: string; visitors: number }[];
	pages: { name: string; visitors: number }[];
	/** The public stats page, when the owner has switched it on. */
	live?: string;
	/** The owner has proved they run the website. */
	verified: boolean;
	made: string;
};

/** The figures for a media kit: the last 30 days, and visitors each month for the last 12. */
export async function mediaKitData(db: D1Database, site: string, now: number, opts: { live?: string; verified: boolean }): Promise<MediaKit> {
	const r = await buildReport(db, site, "30d", now);
	const yearAgo = utcDay(now - 364 * 86_400_000).slice(0, 7) + "-01";
	const [counted, older, titles] = await Promise.all([
		db
			.prepare("SELECT substr(day, 1, 7) AS month, COUNT(DISTINCT visitor || day) AS visitors FROM events WHERE site = ? AND kind = 'view' AND day >= ? GROUP BY month")
			.bind(site, yearAgo)
			.all<{ month: string; visitors: number }>()
			.then((x) => x.results ?? []),
		historyBetween(db, site, yearAgo, utcDay(now)),
		titlesFor(db, site, r.pages.map((p) => String(p.path ?? ""))),
	]);
	const byMonth = new Map<string, number>();
	for (const m of counted) byMonth.set(m.month, Number(m.visitors));
	for (const h of older) byMonth.set(h.day.slice(0, 7), (byMonth.get(h.day.slice(0, 7)) ?? 0) + Number(h.visitors));
	const months = [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, visitors]) => ({ month, visitors }));
	// Leave out the empty months before the website started counting.
	while (months.length && !months[0].visitors) months.shift();
	const rows = (list: Record<string, unknown>[], key: string) => list.map((x) => ({ name: String(x[key] ?? ""), visitors: Number(x.visitors) })).filter((x) => x.visitors > 0);
	return {
		site,
		from: r.from,
		to: r.to,
		visitors: r.totals.visitors,
		views: r.totals.views,
		avgSeconds: r.totals.avgSeconds,
		months: months.slice(-12),
		countries: rows(r.countries, "name").map((c) => ({ code: c.name, visitors: c.visitors })),
		devices: rows(r.devices, "name"),
		sources: rows(r.sources, "name"),
		pages: r.pages.map((p) => ({ name: titles.get(String(p.path)) ?? pageName(String(p.path ?? "")), visitors: Number(p.visitors) })),
		live: opts.live,
		verified: opts.verified,
		made: utcDay(now),
	};
}

// ---- Drawing the PDF ----

// Character widths (in 1/1000 of the font size) for Helvetica and Helvetica-Bold, from Adobe's font metrics, for " " to "~".
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// The few characters outside Latin-1 that the standard PDF fonts can still draw (WinAnsiEncoding).
const WIN: Record<string, number> = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99 };

function winAnsi(text: string): number[] {
	const out: number[] = [];
	for (const ch of text.normalize("NFC")) {
		const c = ch.codePointAt(0)!;
		if (WIN[ch]) out.push(WIN[ch]);
		else if (c >= 32 && c < 127) out.push(c);
		else if (c >= 160 && c < 256) out.push(c);
		else if (c >= 32) out.push(63); // "?" for anything the font can't draw, such as emoji
	}
	return out;
}

function width(text: string, size: number, bold = false): number {
	const w = bold ? W_BOLD : W_REG;
	return (winAnsi(text).reduce((sum, c) => sum + (c >= 32 && c <= 126 ? w[c - 32] : 556), 0) * size) / 1000;
}

/** Cut text to fit a width, ending with "…". */
function fit(text: string, size: number, max: number, bold = false): string {
	if (width(text, size, bold) <= max) return text;
	let t = text;
	while (t.length > 1 && width(t + "…", size, bold) > max) t = t.slice(0, -1);
	return t.trimEnd() + "…";
}

function pdfString(text: string): string {
	return "(" + winAnsi(text).map((c) => (c === 40 || c === 41 || c === 92 ? "\\" + String.fromCharCode(c) : c < 127 ? String.fromCharCode(c) : "\\" + c.toString(8).padStart(3, "0"))).join("") + ")";
}

type RGB = [number, number, number];
const hex = (h: string): RGB => [0, 2, 4].map((i) => parseInt(h.slice(1 + i, 3 + i), 16) / 255) as RGB;
const INK = hex("#1d1d1f"), MUTE = hex("#6b6b70"), ACCENT = hex("#2f6fed"), BAR = hex("#dfe8fb"), TINT = hex("#f4f7fd"), LINE = hex("#e3eaf8");

const PAGE_W = 595.28, PAGE_H = 841.89, M = 48;

class Page {
	ops: string[] = [];
	links: { x: number; y: number; w: number; h: number; url: string }[] = [];
	/** y is measured from the top of the page, to the text's baseline. */
	text(x: number, y: number, s: string, size: number, opts: { bold?: boolean; colour?: RGB; align?: "left" | "right" | "centre" } = {}): void {
		const w = width(s, size, opts.bold);
		const left = opts.align === "right" ? x - w : opts.align === "centre" ? x - w / 2 : x;
		const [r, g, b] = opts.colour ?? INK;
		this.ops.push(`BT ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg /${opts.bold ? "F2" : "F1"} ${size} Tf ${left.toFixed(2)} ${(PAGE_H - y).toFixed(2)} Td ${pdfString(s)} Tj ET`);
	}
	/** A filled box; y is its top edge, from the top of the page. */
	box(x: number, y: number, w: number, h: number, colour: RGB, radius = 0): void {
		const [r, g, b] = colour;
		const top = PAGE_H - y, bottom = top - h;
		const k = Math.min(radius, w / 2, h / 2);
		this.ops.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
		if (!k) {
			this.ops.push(`${x.toFixed(2)} ${bottom.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
			return;
		}
		// A rounded rectangle from four Bézier corners (0.5523 makes a circle's quarter).
		const c = k * 0.4477;
		const n = (v: number) => v.toFixed(2);
		this.ops.push(
			`${n(x + k)} ${n(bottom)} m ${n(x + w - k)} ${n(bottom)} l ${n(x + w - c)} ${n(bottom)} ${n(x + w)} ${n(bottom + c)} ${n(x + w)} ${n(bottom + k)} c ${n(x + w)} ${n(top - k)} l ${n(x + w)} ${n(top - c)} ${n(x + w - c)} ${n(top)} ${n(x + w - k)} ${n(top)} c ${n(x + k)} ${n(top)} l ${n(x + c)} ${n(top)} ${n(x)} ${n(top - c)} ${n(x)} ${n(top - k)} c ${n(x)} ${n(bottom + k)} l ${n(x)} ${n(bottom + c)} ${n(x + c)} ${n(bottom)} ${n(x + k)} ${n(bottom)} c f`,
		);
	}
	link(x: number, y: number, w: number, h: number, url: string): void {
		this.links.push({ x, y: PAGE_H - y - h, w, h, url });
	}
}

/** Put one page together as a PDF file. */
function pdfFile(page: Page, title: string): Uint8Array {
	const content = page.ops.join("\n");
	const objects: string[] = [];
	const annots = page.links.map((_, i) => `${8 + i} 0 R`).join(" ");
	objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
	objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
	objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R${annots ? ` /Annots [${annots}]` : ""} >>`;
	objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
	objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
	objects[6] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
	objects[7] = `<< /Title ${pdfString(title)} /Producer (ReaderCount) /Creator (ReaderCount) >>`;
	page.links.forEach((l, i) => {
		objects[8 + i] = `<< /Type /Annot /Subtype /Link /Rect [${l.x.toFixed(2)} ${l.y.toFixed(2)} ${(l.x + l.w).toFixed(2)} ${(l.y + l.h).toFixed(2)}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(l.url)} >> >>`;
	});
	let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
	const offsets: number[] = [];
	for (let i = 1; i < objects.length; i++) {
		offsets[i] = out.length;
		out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
	}
	const xref = out.length;
	out += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	// Every character above is a single byte (text was turned into WinAnsi codes), so this is the file as it is.
	return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

const num = (n: number) => n.toLocaleString("en-GB");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (day: string) => `${Number(day.slice(8, 10))} ${LONG_MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;

let countryNames: Intl.DisplayNames | undefined;
function country(code: string): string {
	if (!/^[A-Z]{2}$/.test(code)) return "Unknown";
	try {
		countryNames ??= new Intl.DisplayNames(["en-GB"], { type: "region" });
		return countryNames.of(code) ?? code;
	} catch {
		return code;
	}
}

function duration(s: number): string {
	if (!s) return "–";
	const m = Math.floor(s / 60);
	return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

const pct = (n: number, of: number) => (of ? `${Math.max(n ? 1 : 0, Math.round((100 * n) / of))}%` : "–");

/** The media kit as a PDF file. */
export function mediaKitPdf(k: MediaKit): Uint8Array {
	const p = new Page();
	const right = PAGE_W - M;
	const full = right - M;

	// Heading
	p.box(0, 0, PAGE_W, 6, ACCENT);
	p.text(M, 52, "MEDIA KIT", 10, { bold: true, colour: ACCENT });
	// "ReaderCount" in two colours, as on the website.
	const rcW = width("ReaderCount", 12, true);
	p.text(right - rcW, 52, "Reader", 12, { bold: true });
	p.text(right - rcW + width("Reader", 12, true), 52, "Count", 12, { bold: true, colour: ACCENT });
	p.text(M, 86, fit(k.site, 30, full, true), 30, { bold: true });
	p.text(M, 108, `Audience for the 30 days from ${longDate(k.from)} to ${longDate(k.to)}`, 11, { colour: MUTE });

	// Headline figures
	const tiles: [string, string][] = [
		["Visitors", num(k.visitors)],
		["Page views", num(k.views)],
		["Pages per visit", k.visitors ? (k.views / k.visitors).toFixed(1) : "–"],
		["Average time on a page", duration(k.avgSeconds)],
	];
	const gap = 10, tw = (full - gap * 3) / 4;
	tiles.forEach(([label, value], i) => {
		const x = M + i * (tw + gap);
		p.box(x, 128, tw, 66, TINT, 8);
		p.text(x + 12, 148, label, 9, { colour: MUTE });
		p.text(x + 12, 178, fit(value, 22, tw - 24, true), 22, { bold: true });
	});

	// Visitors each month
	let y = 226;
	p.text(M, y, "Visitors each month", 13, { bold: true });
	const months = k.months.length >= 2 ? k.months : [];
	const chartTop = y + 14, chartH = 96;
	if (months.length) {
		const top = Math.max(1, ...months.map((m) => m.visitors));
		const slot = full / months.length, bw = Math.min(30, slot * 0.6);
		months.forEach((m, i) => {
			const h = Math.max(1, (m.visitors / top) * (chartH - 14));
			const x = M + i * slot + (slot - bw) / 2;
			p.box(x, chartTop + chartH - h, bw, h, i === months.length - 1 ? ACCENT : BAR, 3);
			p.text(x + bw / 2, chartTop + chartH - h - 4, num(m.visitors), 7, { align: "centre", colour: MUTE });
			const mi = Number(m.month.slice(5, 7)) - 1;
			p.text(x + bw / 2, chartTop + chartH + 12, mi === 0 || i === 0 ? `${MONTHS[mi]} ${m.month.slice(2, 4)}` : MONTHS[mi], 8, { align: "centre", colour: MUTE });
			// This month isn't over yet, so its bar is short: say so.
			if (m.month === k.made.slice(0, 7)) p.text(x + bw / 2, chartTop + chartH + 22, "so far", 7, { align: "centre", colour: MUTE });
		});
	} else {
		p.box(M, chartTop, full, chartH, TINT, 8);
		p.text(M + full / 2, chartTop + chartH / 2 + 4, "Monthly figures appear here once the website has two months of visitors.", 10, { align: "centre", colour: MUTE });
	}

	// Countries, devices and sources, in three columns
	y = chartTop + chartH + 44;
	const colW = (full - 2 * 20) / 3;
	const column = (x: number, title: string, items: { name: string; visitors: number }[], total: number) => {
		p.text(x, y, title, 13, { bold: true });
		let ry = y + 14;
		if (!items.length) p.text(x, ry + 14, "Nothing yet", 10, { colour: MUTE });
		for (const it of items.slice(0, 5)) {
			const share = total ? it.visitors / total : 0;
			p.box(x, ry, colW, 22, TINT, 4);
			p.box(x, ry, Math.max(3, colW * share), 22, BAR, 4);
			p.text(x + 8, ry + 15, fit(it.name, 10, colW - 54), 10);
			p.text(x + colW - 8, ry + 15, pct(it.visitors, total), 10, { bold: true, align: "right" });
			ry += 26;
		}
	};
	const total = Math.max(1, k.visitors);
	column(M, "Where readers are", k.countries.map((c) => ({ name: country(c.code), visitors: c.visitors })), total);
	column(M + colW + 20, "Devices", k.devices.map((d) => ({ name: d.name ? d.name[0].toUpperCase() + d.name.slice(1) : "Unknown", visitors: d.visitors })), total);
	column(M + 2 * (colW + 20), "How readers find it", k.sources.map((s) => ({ name: /^[a-z][^.]*$/.test(s.name) ? s.name[0].toUpperCase() + s.name.slice(1) : s.name, visitors: s.visitors })), total);

	// Most-read posts
	y += 14 + 5 * 26 + 28;
	p.text(M, y, "Most-read pages", 13, { bold: true });
	p.text(right, y, "Visitors", 9, { align: "right", colour: MUTE });
	let ry = y + 10;
	const pages = k.pages.slice(0, 8);
	if (!pages.length) p.text(M, ry + 18, "Nothing yet", 10, { colour: MUTE });
	pages.forEach((pg, i) => {
		if (i) p.box(M, ry + 1, full, 0.75, LINE);
		p.text(M, ry + 16, `${i + 1}.`, 10, { colour: MUTE });
		p.text(M + 20, ry + 16, fit(pg.name, 10.5, full - 100), 10.5);
		p.text(right, ry + 16, num(pg.visitors), 10.5, { bold: true, align: "right" });
		ry += 22;
	});

	// How it was counted
	const fy = PAGE_H - 92;
	p.box(M, fy, full, 0.75, LINE);
	const note = `Counted by ReaderCount, privacy-first stats with no cookies. Visitors are counted once a day, so the same reader on two days counts twice.${k.verified ? " The owner has proved they run this website." : ""}`;
	let ny = fy + 18;
	for (const line of wrap(note, 9, full)) {
		p.text(M, ny, line, 9, { colour: MUTE });
		ny += 12;
	}
	if (k.live) {
		const label = "See the live figures: ";
		const shown = k.live.replace(/^https:\/\//, "");
		p.text(M, ny + 4, label, 9, { colour: MUTE });
		p.text(M + width(label, 9), ny + 4, shown, 9, { bold: true, colour: ACCENT });
		p.link(M + width(label, 9), ny - 6, width(shown, 9, true), 13, k.live);
		ny += 12;
	}
	p.text(M, ny + 4, `Made on ${longDate(k.made)}.`, 8, { colour: MUTE });

	return pdfFile(p, `${k.site} media kit`);
}

function wrap(text: string, size: number, max: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(" ")) {
		const next = line ? `${line} ${word}` : word;
		if (line && width(next, size) > max) {
			lines.push(line);
			line = word;
		} else line = next;
	}
	if (line) lines.push(line);
	return lines;
}

export function mediaKitName(site: string, now: number): string {
	return `${site.replace(/[^a-z0-9.-]/gi, "-")}-media-kit-${utcDay(now)}.pdf`;
}
