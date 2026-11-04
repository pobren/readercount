// Triggers: goals set up in Settings with no code. "Page visited" (such as /thank-you, or /order/* for every page
// starting /order/), "Link clicked" (a link or download whose address contains some text, such as amazon.) and
// "Form sent" (a form by name, or * for any form). They're worked out from visits already counted, so a new
// trigger shows its past too. Each can also email the owner (each time, up to the plan's daily cap, or a daily
// round-up) or post to a webhook: Slack, Discord, Microsoft Teams, Zapier, Make or anything that takes JSON.
// Messages say the trigger, page, source and country, never anything about the reader.

import { offLimits } from "./links.ts";
import { alertSiteOwner } from "./health.ts";
import { utcDay } from "./visitor.ts";

export const KINDS = { page: "Page visited", link: "Link clicked", form: "Form sent" } as const;
export type TriggerKind = keyof typeof KINDS;
export const NOTIFY = { none: "Just count it", email: "Email me each time", daily: "Email me a daily round-up" } as const;
export type Notify = keyof typeof NOTIFY;

export type Trigger = { id: number; site: string; name: string; kind: TriggerKind; pattern: string; notify: Notify; webhook: string | null };

/** Webhook posts a day per trigger, so a busy page can't flood a channel. */
export const HOOKS_PER_DAY = 200;
export const MAX_NAME = 60;
export const MAX_PATTERN = 200;

/** The part of a hit a trigger looks at. */
export type TriggerHit = { kind: string; path: string; target: string | null; source: string; country: string };

/** "/thank-you" matches /thank-you and /thank-you/; "/order/*" matches every page under /order/. */
export function pageMatches(pattern: string, path: string): boolean {
	const p = pattern.trim();
	if (p.endsWith("*")) return path.startsWith(p.slice(0, -1));
	const strip = (x: string) => (x.length > 1 ? x.replace(/\/+$/, "") : x);
	return strip(p) === strip(path);
}

export function matches(t: Pick<Trigger, "kind" | "pattern">, hit: TriggerHit): boolean {
	if (t.kind === "page") return hit.kind === "view" && pageMatches(t.pattern, hit.path);
	if (t.kind === "link") return (hit.kind === "outbound" || hit.kind === "download") && !!hit.target && hit.target.toLowerCase().includes(t.pattern.trim().toLowerCase());
	if (hit.kind !== "goal" || !hit.target) return false;
	const p = t.pattern.trim();
	return p === "*" ? hit.target.startsWith("Form: ") : hit.target === p || hit.target === `Form: ${p}`;
}

/** Checks a new trigger from the Settings form. Returns it, or what to fix. */
export function readTrigger(form: { name?: unknown; kind?: unknown; pattern?: unknown; notify?: unknown; webhook?: unknown }): Omit<Trigger, "id" | "site"> | { error: string } {
	const name = String(form.name ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
	const kind = String(form.kind ?? "") as TriggerKind;
	const pattern = String(form.pattern ?? "").trim().slice(0, MAX_PATTERN);
	const notify = (Object.hasOwn(NOTIFY, String(form.notify)) ? String(form.notify) : "none") as Notify;
	const webhook = String(form.webhook ?? "").trim();
	if (!name) return { error: "Give the trigger a name, such as Order placed." };
	if (!Object.hasOwn(KINDS, kind)) return { error: "Choose what the trigger watches for." };
	if (!pattern) return { error: kind === "page" ? "Type the page's address, such as /thank-you." : kind === "link" ? "Type part of the link's address, such as amazon." : "Type the form's name, or * for any form." };
	if (kind === "page" && !pattern.startsWith("/")) return { error: "A page address starts with /, such as /thank-you or /order/*." };
	if (webhook && (!webhook.startsWith("https://") || offLimits(webhook) || webhook.length > 500)) return { error: "The webhook address must start with https:// and be on the public internet." };
	return { name, kind, pattern, notify, webhook: webhook || null };
}

// One short cache per Worker, so checking triggers doesn't add a database read to every hit.
let cache: { at: number; bySite: Map<string, Trigger[]> } | null = null;

export async function triggersFor(db: D1Database, site: string, now: number): Promise<Trigger[]> {
	if (!cache || now - cache.at > 60_000 || now < cache.at) {
		const rows = (await db.prepare("SELECT id, site, name, kind, pattern, notify, webhook FROM triggers").all<Trigger>().catch(() => ({ results: [] as Trigger[] }))).results ?? [];
		const bySite = new Map<string, Trigger[]>();
		for (const t of rows) bySite.set(t.site, [...(bySite.get(t.site) ?? []), t]);
		cache = { at: now, bySite };
	}
	return cache.bySite.get(site) ?? [];
}

export function forgetTriggers(): void {
	cache = null;
}

export async function listTriggers(db: D1Database, site: string): Promise<Trigger[]> {
	return (await db.prepare("SELECT id, site, name, kind, pattern, notify, webhook FROM triggers WHERE site = ? ORDER BY id").bind(site).all<Trigger>()).results ?? [];
}

export async function addTrigger(db: D1Database, site: string, t: Omit<Trigger, "id" | "site">, now: number): Promise<void> {
	await db.prepare("INSERT INTO triggers (site, name, kind, pattern, notify, webhook, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(site, t.name, t.kind, t.pattern, t.notify, t.webhook, now).run();
	forgetTriggers();
}

export async function removeTrigger(db: D1Database, site: string, id: number): Promise<void> {
	await db.prepare("DELETE FROM triggers WHERE site = ? AND id = ?").bind(site, id).run();
	forgetTriggers();
}

/** The message a webhook gets, in the shape its service wants. */
export function hookBody(webhook: string, text: string, fields: Record<string, string>): string {
	const host = new URL(webhook).hostname;
	if (host === "hooks.slack.com") return JSON.stringify({ text });
	if (host === "discord.com" || host === "discordapp.com") return JSON.stringify({ content: text });
	// Teams: incoming webhooks and Workflows both read text.
	if (host.endsWith(".webhook.office.com") || host.endsWith(".logic.azure.com") || host.endsWith(".powerplatform.com")) return JSON.stringify({ text });
	return JSON.stringify({ text, ...fields });
}

/** A hit was counted: tell anyone its triggers ask for. Returns how many triggers it set off. */
export async function fireTriggers(env: { DB: D1Database; EMAIL?: Parameters<typeof alertSiteOwner>[0]["EMAIL"]; MAIL_FROM?: string; APP_HOST?: string }, site: string, hit: TriggerHit, now: number, poster: typeof fetch = fetch): Promise<number> {
	const hits = (await triggersFor(env.DB, site, now)).filter((t) => matches(t, hit));
	for (const t of hits) {
		if (t.notify !== "email" && !t.webhook) continue;
		const where = [`on ${hit.path}`, hit.source ? `from ${hit.source}` : "", hit.country ? `(${hit.country})` : ""].filter(Boolean).join(" ");
		const text = `${t.name} on ${site}: ${where}`;
		if (t.notify === "email") await alertSiteOwner(env, site, "triggers", `${t.name} on ${site}`, `${text}.\n\nSee all your goals: https://${env.APP_HOST}/?site=${encodeURIComponent(site)}\n\nReaderCount`, now);
		if (t.webhook) {
			const day = utcDay(now);
			const row = await env.DB.prepare("UPDATE triggers SET sent_n = CASE WHEN sent_day = ?1 THEN sent_n + 1 ELSE 1 END, sent_day = ?1 WHERE id = ?2 RETURNING sent_n").bind(day, t.id).first<{ sent_n: number }>();
			if ((row?.sent_n ?? 0) > HOOKS_PER_DAY) continue;
			try {
				await poster(t.webhook, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "ReaderCount (+https://paulobrien.dev/readercount/)" }, body: hookBody(t.webhook, text, { trigger: t.name, site, page: hit.path, source: hit.source || "Direct", country: hit.country, time: new Date(now).toISOString() }), redirect: "manual", signal: AbortSignal.timeout(5000) });
			} catch {
				// A webhook that's down doesn't stop the visit being counted.
			}
		}
	}
	return hits.length;
}

/** Each trigger's completions and visitors in a date range, for the Goals card. */
export async function triggerCounts(db: D1Database, site: string, from: string, to: string): Promise<{ name: string; completions: number; visitors: number; trigger: 1 }[]> {
	const out: { name: string; completions: number; visitors: number; trigger: 1 }[] = [];
	for (const t of await listTriggers(db, site)) {
		const where =
			t.kind === "page"
				? t.pattern.endsWith("*")
					? ["kind = 'view' AND substr(path, 1, ?) = ?", t.pattern.length - 1, t.pattern.slice(0, -1)]
					: ["kind = 'view' AND (path = ? OR path = ?)", t.pattern.replace(/\/+$/, "") || "/", t.pattern.replace(/\/+$/, "") + "/"]
				: t.kind === "link"
					? ["kind IN ('outbound', 'download') AND instr(lower(target), lower(?)) > 0", t.pattern]
					: t.pattern === "*"
						? ["kind = 'goal' AND target LIKE 'Form: %'"]
						: ["kind = 'goal' AND (target = ? OR target = ?)", t.pattern, `Form: ${t.pattern}`];
		const [sql, ...args] = where as [string, ...unknown[]];
		const row = await db.prepare(`SELECT COUNT(*) AS c, COUNT(DISTINCT visitor || day) AS v FROM events WHERE site = ? AND day >= ? AND day <= ? AND ${sql}`).bind(site, from, to, ...args).first<{ c: number; v: number }>();
		out.push({ name: t.name, completions: Number(row?.c ?? 0), visitors: Number(row?.v ?? 0), trigger: 1 });
	}
	return out;
}

/** Each morning: one email per website listing yesterday's daily round-up triggers that happened. */
export async function sendTriggerRoundups(env: Parameters<typeof fireTriggers>[0], now: number): Promise<number> {
	const day = utcDay(now - 86_400_000);
	const sites = (await env.DB.prepare("SELECT DISTINCT site FROM triggers WHERE notify = 'daily'").all<{ site: string }>()).results ?? [];
	let sent = 0;
	for (const { site } of sites) {
		const counts = (await triggerCounts(env.DB, site, day, day)).filter((c) => c.completions);
		const daily = new Set((await listTriggers(env.DB, site)).filter((t) => t.notify === "daily").map((t) => t.name));
		const lines = counts.filter((c) => daily.has(c.name)).map((c) => `- ${c.name}: ${c.completions.toLocaleString("en-GB")} (${c.visitors.toLocaleString("en-GB")} ${c.visitors === 1 ? "visitor" : "visitors"})`);
		if (!lines.length) continue;
		if (await alertSiteOwner(env, site, "triggers", `Yesterday on ${site}: your triggers`, `Your triggers on ${site} yesterday:\n\n${lines.join("\n")}\n\nSee all your goals: https://${env.APP_HOST}/?site=${encodeURIComponent(site)}\n\nReaderCount`, now)) sent++;
	}
	return sent;
}
