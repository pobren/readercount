// Downloads: a website's stats for the range on screen, as a CSV file or an Excel workbook.
// (PDF is the stats page itself, printed with "Save as PDF".)

import type { Report } from "./dashboard.ts";

type Cell = string | number;
type Sheet = { name: string; rows: Cell[][] };

const RANGE_NAMES: Record<Report["range"], string> = { today: "today", "7d": "7 days", "30d": "30 days", "12m": "12 months" };

/** The report as named tables, the same ones the stats page shows. */
export function sheets(r: Report): Sheet[] {
	const t = r.totals;
	const n = (v: unknown) => Number(v ?? 0);
	const s = (v: unknown) => String(v ?? "");
	return [
		{
			name: "Summary",
			rows: [
				["Website", r.site],
				["From", r.from],
				["To", r.to],
				["Visitors", t.visitors],
				["Page views", t.views],
				["Average time on page (seconds)", t.avgSeconds],
				["Bounce rate (%)", t.bounce],
				["Visitors in the previous period", r.previous.visitors],
				["Page views in the previous period", r.previous.views],
			],
		},
		{ name: "Days", rows: [["Date", "Visitors", "Page views"], ...r.days.map((d) => [d.day, d.visitors, d.views])] },
		{ name: "Pages", rows: [["Page", "Visitors", "Page views", "Average time (seconds)"], ...r.pages.map((p) => [s(p.path), n(p.visitors), n(p.views), n(p.secs)])] },
		{ name: "Sources", rows: [["Source", "Visitors"], ...r.sources.map((x) => [s(x.name), n(x.visitors)])] },
		{ name: "Campaigns", rows: [["Campaign", "Visitors"], ...r.campaigns.map((x) => [s(x.name), n(x.visitors)])] },
		{ name: "Countries", rows: [["Country code", "Visitors"], ...r.countries.map((x) => [s(x.name) || "Unknown", n(x.visitors)])] },
		{ name: "Devices", rows: [["Device", "Visitors"], ...r.devices.map((x) => [s(x.name), n(x.visitors)])] },
		{ name: "Browsers", rows: [["Browser", "Visitors"], ...r.browsers.map((x) => [s(x.name), n(x.visitors)])] },
		{ name: "Clicks", rows: [["Type", "Link", "From page", "Clicks"], ...r.clicks.map((c) => [c.kind === "download" ? "Download" : "Link", s(c.target), s(c.path), n(c.clicks)])] },
	];
}

/** File name for a download, like readercount-example.com-30-days-2026-10-13.csv */
export function fileName(r: Report, ext: string): string {
	return `readercount-${r.site}-${RANGE_NAMES[r.range].replace(" ", "-")}-${r.to}.${ext}`;
}

// ---- CSV: one file, each table under its own heading, which Excel, Numbers and Google Sheets all open ----

function csvCell(v: Cell): string {
	let s = String(v);
	// Stop spreadsheet apps treating a page path or search term as a formula.
	if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(r: Report): string {
	const blocks = sheets(r).map((sh) => [[sh.name], ...sh.rows].map((row) => row.map(csvCell).join(",")).join("\r\n"));
	return "﻿" + blocks.join("\r\n\r\n") + "\r\n";
}

// ---- Excel: a real .xlsx workbook with one tab per table ----

const xml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

function column(i: number): string {
	let s = "";
	for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
	return s;
}

function sheetXml(sh: Sheet, header: boolean): string {
	const widths = sh.rows.reduce<number[]>((w, row) => row.map((c, i) => Math.max(w[i] ?? 8, Math.min(60, String(c).length + 2))), []);
	const cols = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`;
	const rows = sh.rows
		.map((row, y) => {
			const style = header && y === 0 ? ' s="1"' : "";
			const cells = row
				.map((c, x) => {
					const ref = `${column(x)}${y + 1}`;
					return typeof c === "number" && Number.isFinite(c)
						? `<c r="${ref}"${style}><v>${c}</v></c>`
						: `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(String(c))}</t></is></c>`;
				})
				.join("");
			return `<row r="${y + 1}">${cells}</row>`;
		})
		.join("");
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0">${header ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : ""}</sheetView></sheetViews>${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

export function toXlsx(r: Report): Uint8Array {
	const list = sheets(r);
	const files: [string, string][] = [
		[
			"[Content_Types].xml",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
		],
		["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
		[
			"xl/workbook.xml",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${list.map((sh, i) => `<sheet name="${xml(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
		],
		[
			"xl/_rels/workbook.xml.rels",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
		],
		[
			"xl/styles.xml",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
		],
		...list.map((sh, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sh, i > 0)]),
	];
	return zip(files.map(([name, text]) => [name, new TextEncoder().encode(text)]));
}

// ---- A plain (uncompressed) zip file, which is all an .xlsx needs ----

let crcTable: Uint32Array | undefined;
function crc32(data: Uint8Array): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (const b of data) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

export function zip(files: [string, Uint8Array][]): Uint8Array {
	const parts: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const [name, data] of files) {
		const nameBytes = new TextEncoder().encode(name);
		const crc = crc32(data);
		const local = new Uint8Array(30 + nameBytes.length);
		const l = new DataView(local.buffer);
		l.setUint32(0, 0x04034b50, true);
		l.setUint16(4, 20, true);
		l.setUint16(6, 0x0800, true); // names are UTF-8
		l.setUint16(8, 0, true); // stored, no compression
		l.setUint16(10, 0, true);
		l.setUint16(12, 0x21, true); // 1 Jan 1980
		l.setUint32(14, crc, true);
		l.setUint32(18, data.length, true);
		l.setUint32(22, data.length, true);
		l.setUint16(26, nameBytes.length, true);
		local.set(nameBytes, 30);
		const entry = new Uint8Array(46 + nameBytes.length);
		const c = new DataView(entry.buffer);
		c.setUint32(0, 0x02014b50, true);
		c.setUint16(4, 20, true);
		c.setUint16(6, 20, true);
		c.setUint16(8, 0x0800, true);
		c.setUint16(14, 0x21, true);
		c.setUint32(16, crc, true);
		c.setUint32(20, data.length, true);
		c.setUint32(24, data.length, true);
		c.setUint16(28, nameBytes.length, true);
		c.setUint32(42, offset, true);
		entry.set(nameBytes, 46);
		parts.push(local, data);
		central.push(entry);
		offset += local.length + data.length;
	}
	const size = central.reduce((n, e) => n + e.length, 0);
	const end = new Uint8Array(22);
	const e = new DataView(end.buffer);
	e.setUint32(0, 0x06054b50, true);
	e.setUint16(8, files.length, true);
	e.setUint16(10, files.length, true);
	e.setUint32(12, size, true);
	e.setUint32(16, offset, true);
	const out = new Uint8Array(offset + size + 22);
	let at = 0;
	for (const p of [...parts, ...central, end]) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}
