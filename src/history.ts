// Older history and notes on the chart.
// History: a CSV from Google Analytics (or Plausible, Fathom, Matomo...) with visitors and page views per day,
// so the chart doesn't start from zero. It fills only the days before ReaderCount's first visit, so nothing is counted twice.
// Notes: a line pinned to a day, like "posted on Reddit", to explain a spike later.

import { utcDay } from "./visitor.ts";

export type HistoryDay = { day: string; visitors: number; views: number };
export type Note = { id: number; day: string; text: string };

/** Largest file we'll read, and the most days we'll keep (20 years). */
export const MAX_FILE_BYTES = 5_000_000;
const MAX_DAYS = 7_305;
export const MAX_NOTE = 140;
const MAX_NOTES = 1_000;

// ---- Reading the file ----

/** Splits one line of a CSV or TSV, keeping "quoted, values" together. */
function cells(line: string, sep: string): string[] {
	const out: string[] = [];
	let cur = "", quoted = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quoted) {
			if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
			else if (c === '"') quoted = false;
			else cur += c;
		} else if (c === '"') quoted = true;
		else if (c === sep) out.push(cur.trim()), (cur = "");
		else cur += c;
	}
	out.push(cur.trim());
	return out;
}

const DATE_COLS = [/^date$/i, /^day$/i, /^date\s*\(.*\)$/i, /^(date|day)\b/i];
const INDEX_COLS = [/^nth day$/i, /^day index$/i];
const VISITOR_COLS = [/^total users$/i, /^users$/i, /^active users$/i, /^(unique )?visitors$/i, /^unique visits$/i, /^(?!new\b).*\b(users|visitors)$/i];
const VIEW_COLS = [/^views$/i, /^page ?views$/i, /^screen ?page ?views$/i, /^(?!.*\bper\b).*\b(page ?views|views)$/i];

function findCol(head: string[], patterns: RegExp[]): number {
	for (const p of patterns) {
		const i = head.findIndex((h) => p.test(h));
		if (i >= 0) return i;
	}
	return -1;
}

function count(s: string | undefined): number | null {
	const t = String(s ?? "").replace(/[\s,'"]/g, "");
	if (!/^\d+(\.\d+)?$/.test(t)) return null;
	return Math.round(Number(t));
}

const iso = (y: number, m: number, d: number): string | null => {
	if (y < 100) y += 2000;
	const t = Date.UTC(y, m - 1, d);
	const back = new Date(t);
	return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? utcDay(t) : null;
};

/** Turns one date column into YYYY-MM-DD. Slashed dates are day first (UK) unless the column shows they're month first. */
function dateReader(values: string[]): (v: string) => string | null {
	const slashed = values.map((v) => v.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/)).filter(Boolean) as RegExpMatchArray[];
	const monthFirst = !slashed.some((m) => Number(m[1]) > 12) && slashed.some((m) => Number(m[2]) > 12);
	return (v: string) => {
		let m = v.match(/^(\d{4})(\d{2})(\d{2})$/) ?? v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
		if (m) return iso(+m[1], +m[2], +m[3]);
		m = v.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/);
		if (m) return monthFirst ? iso(+m[3], +m[1], +m[2]) : iso(+m[3], +m[2], +m[1]);
		const t = Date.parse(v + " UTC");
		return Number.isFinite(t) && /[a-z]/i.test(v) ? utcDay(t) : null;
	};
}

/**
 * Reads visitors and page views per day from a stats export. Understands Google Analytics 4 downloads
 * (a Date column, or "Nth day" counted from the "# Start date" line), and any CSV or TSV with a date column
 * and a users or visitors column.
 */
export function parseHistory(text: string, now: number): { days: HistoryDay[] } | { error: string } {
	const lines = text.replace(/^﻿/, "").split(/\r?\n/);
	const start = text.match(/#\s*Start date:\s*(\d{8}|\d{4}-\d{2}-\d{2})/i)?.[1]?.replace(/-/g, "");
	const startDay = start ? iso(+start.slice(0, 4), +start.slice(4, 6), +start.slice(6, 8)) : null;
	// Google's downloads hold several tables, split by blank or # lines. Use the first one with days and visitors.
	const blocks: string[][] = [[]];
	for (const line of lines) {
		if (!line.trim() || line.trimStart().startsWith("#")) {
			if (blocks.at(-1)!.length) blocks.push([]);
		} else blocks.at(-1)!.push(line);
	}
	let sawDates = false;
	for (const block of blocks) {
		if (block.length < 2) continue;
		const sep = block[0].includes("\t") ? "\t" : block[0].split(";").length > block[0].split(",").length ? ";" : ",";
		const head = cells(block[0], sep).map((h) => h.replace(/^"|"$/g, ""));
		const rows = block.slice(1).map((l) => cells(l, sep));
		// "Nth day" (or "Day Index" holding plain numbers) counts days from the file's start date.
		let indexCol = startDay ? findCol(head, INDEX_COLS) : -1;
		if (indexCol >= 0 && !rows.every((r) => /^\d+$/.test(r[indexCol] ?? "") || !r[indexCol])) indexCol = -1;
		const dateCol = indexCol >= 0 ? -1 : findCol(head, DATE_COLS);
		if (dateCol < 0 && indexCol < 0) continue;
		sawDates = true;
		const visitorCol = findCol(head, VISITOR_COLS);
		if (visitorCol < 0) continue;
		const viewCol = findCol(head, VIEW_COLS);
		const readDate = dateReader(rows.map((r) => r[dateCol] ?? ""));
		const today = utcDay(now);
		const byDay = new Map<string, HistoryDay>();
		for (const r of rows) {
			let day: string | null = null;
			if (dateCol >= 0) day = readDate(r[dateCol] ?? "");
			else {
				const n = count(r[indexCol]);
				if (n !== null) day = utcDay(Date.parse(startDay + "T00:00:00Z") + n * 86_400_000);
			}
			const visitors = count(r[visitorCol]);
			if (!day || visitors === null || day > today || day < "2005-01-01") continue;
			const views = viewCol >= 0 && viewCol !== visitorCol ? (count(r[viewCol]) ?? 0) : 0;
			const had = byDay.get(day);
			byDay.set(day, { day, visitors: (had?.visitors ?? 0) + visitors, views: (had?.views ?? 0) + views });
		}
		const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-MAX_DAYS);
		if (days.length) return { days };
	}
	return {
		error: sawDates
			? "We found the dates, but no column of users or visitors. Add Total users (or Users) to the report and download it again."
			: "We couldn't find a column of dates in that file. Make sure the report is split by Date, then download it as a CSV.",
	};
}

// ---- Storing it ----

/** Saves the days, replacing any days already brought in. */
export async function saveHistory(db: D1Database, site: string, days: HistoryDay[]): Promise<void> {
	const sql = "INSERT INTO imported_days (site, day, visitors, views) VALUES (?, ?, ?, ?) ON CONFLICT (site, day) DO UPDATE SET visitors = excluded.visitors, views = excluded.views";
	for (let i = 0; i < days.length; i += 100) {
		await db.batch(days.slice(i, i + 100).map((d) => db.prepare(sql).bind(site, d.day, d.visitors, d.views)));
	}
}

export async function forgetHistory(db: D1Database, site: string): Promise<void> {
	await db.prepare("DELETE FROM imported_days WHERE site = ?").bind(site).run();
}

/** What's been brought in for a website, for the Settings box. */
export async function historySummary(db: D1Database, site: string): Promise<{ days: number; from: string; to: string; firstCounted: string | null }> {
	const [h, first] = await Promise.all([
		db.prepare("SELECT COUNT(*) AS days, MIN(day) AS from_day, MAX(day) AS to_day FROM imported_days WHERE site = ?").bind(site).first<{ days: number; from_day: string | null; to_day: string | null }>(),
		db.prepare("SELECT MIN(day) AS day FROM events WHERE site = ?").bind(site).first<{ day: string | null }>(),
	]);
	return { days: Number(h?.days ?? 0), from: h?.from_day ?? "", to: h?.to_day ?? "", firstCounted: first?.day ?? null };
}

/** The imported days between two dates that come before ReaderCount's first visit for the website. */
export async function historyBetween(db: D1Database, site: string, from: string, to: string): Promise<HistoryDay[]> {
	const r = await db
		.prepare("SELECT day, visitors, views FROM imported_days WHERE site = ? AND day >= ? AND day <= ? AND day < COALESCE((SELECT MIN(day) FROM events WHERE site = ?), '9999') ORDER BY day")
		.bind(site, from, to, site)
		.all<HistoryDay>();
	return r.results ?? [];
}

// ---- Notes ----

export async function notesBetween(db: D1Database, site: string, from: string, to: string): Promise<Note[]> {
	const r = await db.prepare("SELECT id, day, text FROM notes WHERE site = ? AND day >= ? AND day <= ? ORDER BY day, id").bind(site, from, to).all<Note>();
	return r.results ?? [];
}

/** Adds a note. Returns an error to show the person, or nothing when it's saved. */
export async function addNote(db: D1Database, site: string, day: unknown, text: unknown, now: number): Promise<string | null> {
	const d = String(day ?? "");
	const t = String(text ?? "").replace(/\s+/g, " ").trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d + "T00:00:00Z")) || d > utcDay(now) || d < "2005-01-01") return "Pick a date up to today.";
	if (!t) return "Write a few words for the note.";
	if (t.length > MAX_NOTE) return `Keep notes to ${MAX_NOTE} characters.`;
	const n = await db.prepare("SELECT COUNT(*) AS n FROM notes WHERE site = ?").bind(site).first<{ n: number }>();
	if (Number(n?.n ?? 0) >= MAX_NOTES) return "This website has as many notes as it can hold. Remove some old ones first.";
	await db.prepare("INSERT INTO notes (site, day, text, created_at) VALUES (?, ?, ?, ?)").bind(site, d, t, now).run();
	return null;
}

export async function removeNote(db: D1Database, site: string, id: unknown): Promise<void> {
	await db.prepare("DELETE FROM notes WHERE site = ? AND id = ?").bind(site, Number(id) || 0).run();
}
