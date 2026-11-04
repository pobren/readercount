// White label: your own name, logo, colour and support address on every page and email, set under Branding.
// One brand for the whole install, kept in the settings table and remembered for a minute.

import type { Mailer } from "./accounts.ts";

export type Brand = { name: string; logo: string; colour: string; support: string };
export const DEFAULT_BRAND: Brand = { name: "ReaderCount", logo: "", colour: "", support: "" };
const KEYS = { name: "brand_name", logo: "brand_logo", colour: "brand_colour", support: "brand_support" } as const;

let cached: { brand: Brand; at: number } | null = null;

export async function loadBrand(db: D1Database, now = Date.now()): Promise<Brand> {
	if (cached && now - cached.at < 60_000 && now >= cached.at) return cached.brand;
	const rows = (await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'brand_%'").all<{ key: string; value: string }>().catch(() => ({ results: [] as { key: string; value: string }[] }))).results ?? [];
	const got = new Map(rows.map((r) => [r.key, r.value]));
	const brand: Brand = { name: got.get(KEYS.name) || DEFAULT_BRAND.name, logo: got.get(KEYS.logo) ?? "", colour: got.get(KEYS.colour) ?? "", support: got.get(KEYS.support) ?? "" };
	cached = { brand, at: now };
	return brand;
}

export function forgetBrand(): void {
	cached = null;
}

/** Checks and saves the Branding form. Empty fields go back to ReaderCount's own. */
export async function saveBrand(db: D1Database, form: FormData): Promise<{ error: string } | Brand> {
	const name = String(form.get("name") ?? "").trim().replace(/\s+/g, " ");
	const logo = String(form.get("logo") ?? "").trim();
	const colour = String(form.get("colour") ?? "").trim().toLowerCase();
	const support = String(form.get("support") ?? "").trim();
	if (name.length > 40 || /[<>"]/.test(name)) return { error: "Keep the name under 40 characters, without < > or quotes." };
	if (logo && !/^https:\/\/[^\s"'<>]{4,500}$/.test(logo)) return { error: "The logo needs to be a picture's full address, starting https://." };
	if (colour && !/^#[0-9a-f]{6}$/.test(colour)) return { error: "Pick the colour as six hex digits, like #2f6fed." };
	if (support && !/^(https:\/\/[^\s"'<>]{4,300}|[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,})$/i.test(support)) return { error: "The support address needs to be an email address or a web address starting https://." };
	const values: Brand = { name, logo, colour: colour === "#2f6fed" ? "" : colour, support };
	await db.batch(
		(Object.keys(KEYS) as (keyof Brand)[]).map((k) =>
			values[k] ? db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(KEYS[k], values[k]) : db.prepare("DELETE FROM settings WHERE key = ?").bind(KEYS[k]),
		),
	);
	forgetBrand();
	return { ...values, name: name || DEFAULT_BRAND.name };
}

export const isDefault = (b: Brand) => b.name === DEFAULT_BRAND.name && !b.logo && !b.colour && !b.support;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const supportHref = (b: Brand) => (b.support.startsWith("https://") ? b.support : `mailto:${b.support}`);

/** Puts the brand on a finished page: the name and logo, the colour, and a help link in the footer. */
export function brandPage(html: string, b: Brand): string {
	if (isDefault(b)) return html;
	const renamed = b.name !== DEFAULT_BRAND.name;
	let out = html;
	const mark = b.logo ? `<img class="brand-logo" src="${esc(b.logo)}" alt="${esc(b.name)}">` : esc(b.name);
	out = out.split(`Reader<span class="rc-c">Count</span>`).join(mark);
	if (renamed) {
		// Links to ReaderCount's own home page become plain text, then the name changes everywhere else.
		out = out.replace(/<a [^>]*href="https:\/\/paulobrien\.dev\/readercount\/"[^>]*>([\s\S]*?)<\/a>/g, "$1");
		out = out.split("ReaderCount").join(esc(b.name));
	}
	const style = `<style>${b.colour ? `:root,:root[data-theme]{--accent:${b.colour}}@media (prefers-color-scheme:dark){:root{--accent:${b.colour}}}` : ""}.brand-logo{height:28px;width:auto;max-width:200px;vertical-align:middle}</style>`;
	out = out.replace("</head>", `${style}</head>`);
	if (b.support) out = out.replace("</footer>", ` Need help? <a href="${esc(supportHref(b))}">Contact ${esc(b.support.replace(/^https:\/\//, ""))}</a></footer>`);
	return out;
}

/** The same for emails: the sender's name and every mention of ReaderCount. */
export function brandMailer(mail: Mailer | undefined, b: Brand): Mailer | undefined {
	if (!mail || b.name === DEFAULT_BRAND.name) return mail;
	const swap = (s: string) => s.split("ReaderCount").join(b.name);
	return {
		send: (m) =>
			mail.send({ ...m, from: { ...m.from, name: swap(m.from.name) }, subject: swap(m.subject), text: swap(m.text), html: m.html ? swap(m.html.replace(/Reader<span style="[^"]*">Count<\/span>/g, esc(b.name))) : m.html }),
	};
}
