// The owner of a self-hosted ReaderCount: one account, signed in with the ADMIN_PASSWORD secret, and the
// websites it counts.

export type Account = { id: string; email: string };

/** The one account. Its id never changes, so everything the owner sets up stays theirs. */
export const OWNER_ID = "owner";
export const SESSION_COOKIE = "rc_account";
const SESSION_DAYS = 30;
/** Wrong passwords allowed an hour, from everywhere together, before signing in waits for the hour to pass. */
const FAILS_PER_HOUR = 20;
/** The password must be at least this long, and not the example from the set-up instructions. */
export const MIN_PASSWORD = 12;
const EXAMPLE_PASSWORDS = ["change-me-to-something-long", "replace-this-with-a-long-password"];

export async function sha256(text: string): Promise<string> {
	const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
	const b = crypto.getRandomValues(new Uint8Array(bytes));
	return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function cleanEmail(value: unknown): string | null {
	const e = String(value ?? "").trim().toLowerCase();
	return /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[a-z]{2,}$/.test(e) && e.length <= 200 ? e : null;
}

/** A website address as we store it: lower case, no scheme, no www., no path. */
export function cleanDomain(value: unknown): string | null {
	let v = String(value ?? "").trim().toLowerCase();
	if (!v) return null;
	try {
		v = new URL(/^https?:\/\//.test(v) ? v : "https://" + v).hostname;
	} catch {
		return null;
	}
	v = v.replace(/^www\./, "");
	return /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v) ? v : null;
}

export type Mailer = { send(message: { to: string; from: { email: string; name: string }; subject: string; text: string; html?: string }): Promise<unknown> };

/** True when ADMIN_PASSWORD is set to something that can be used: long enough, and not the example. */
export function passwordReady(password: string | undefined): boolean {
	return Boolean(password && password.length >= MIN_PASSWORD && !EXAMPLE_PASSWORDS.includes(password));
}

function sameText(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * Checks the password and starts a session. Hashes are compared, so the time taken says nothing about the
 * password. After FAILS_PER_HOUR wrong tries (from anywhere) it waits for the hour to pass.
 */
export async function checkPassword(db: D1Database, env: { ADMIN_PASSWORD?: string; OWNER_EMAIL?: string }, given: unknown, now: number): Promise<{ token: string; account: Account } | { error: string }> {
	if (!passwordReady(env.ADMIN_PASSWORD)) return { error: `Set the ADMIN_PASSWORD secret first (at least ${MIN_PASSWORD} characters). The README says how.` };
	const fails = await db.prepare("SELECT COUNT(*) AS n FROM sign_in_fails WHERE at > ?").bind(now - 3_600_000).first<{ n: number }>();
	if ((fails?.n ?? 0) >= FAILS_PER_HOUR) return { error: "Too many wrong passwords in the last hour. Please wait a while and try again." };
	if (!sameText(await sha256(String(given ?? "")), await sha256(env.ADMIN_PASSWORD!))) {
		await db.prepare("INSERT INTO sign_in_fails (at) VALUES (?)").bind(now).run();
		return { error: "That password isn't right." };
	}
	return startSession(db, env.OWNER_EMAIL, now);
}

/** Signs the owner in (making the account the first time) and returns the new session's cookie value. */
export async function startSession(db: D1Database, ownerEmail: string | undefined, now: number): Promise<{ token: string; account: Account }> {
	const email = cleanEmail(ownerEmail) ?? "owner@localhost";
	await db.prepare("INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET email = excluded.email").bind(OWNER_ID, email, now).run();
	const token = randomToken();
	await db.prepare("INSERT INTO sessions (token_hash, account_id, expires) VALUES (?, ?, ?)").bind(await sha256(token), OWNER_ID, now + SESSION_DAYS * 86_400_000).run();
	return { token, account: { id: OWNER_ID, email } };
}

export function sessionCookie(token: string, maxAgeDays = SESSION_DAYS): string {
	return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeDays * 86_400}; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(request: Request, name: string): string {
	return (request.headers.get("Cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(name + "="))?.slice(name.length + 1) ?? "";
}

export async function currentAccount(db: D1Database, request: Request, now: number): Promise<Account | null> {
	const token = readCookie(request, SESSION_COOKIE);
	if (!token) return null;
	return db
		.prepare("SELECT a.id, a.email FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires > ?")
		.bind(await sha256(token), now)
		.first<Account>();
}

export async function signOut(db: D1Database, request: Request): Promise<void> {
	const token = readCookie(request, SESSION_COOKIE);
	if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}

/** Signs out every browser, such as after changing the password. */
export async function signOutEverywhere(db: D1Database): Promise<void> {
	await db.prepare("DELETE FROM sessions").run();
}

export async function accountSites(db: D1Database, accountId: string): Promise<string[]> {
	const r = await db.prepare("SELECT domain FROM sites WHERE account_id = ? ORDER BY created_at").bind(accountId).all<{ domain: string }>();
	return (r.results ?? []).map((x) => x.domain);
}

/** Adds a website. There's no limit in the code: the free licence covers up to 10 (see LICENSE). */
export async function addSite(db: D1Database, accountId: string, domainIn: unknown, now: number): Promise<{ domain: string } | { error: string }> {
	const domain = cleanDomain(domainIn);
	if (!domain) return { error: "Please enter your website's address, like myblog.com." };
	await db.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES (?, ?, ?) ON CONFLICT (domain) DO NOTHING").bind(domain, accountId, now).run();
	forgetCountedSites();
	return { domain };
}

/** Removes a website and everything kept for it. */
export async function removeSite(db: D1Database, accountId: string, domain: string): Promise<boolean> {
	const owned = await db.prepare("SELECT 1 AS ok FROM sites WHERE domain = ? AND account_id = ?").bind(domain, accountId).first();
	if (!owned) return false;
	const tables = ["events", "search", "search_days", "search_sites", "imported_days", "notes", "filtered", "site_hits", "spikes", "link_checks", "site_checks", "problems", "form_starts", "triggers", "ghost_links", "posts", "earnings", "affiliate_links", "affiliate_earnings", "money_alerts"];
	await db.batch([...tables.map((t) => db.prepare(`DELETE FROM ${t} WHERE site = ?`).bind(domain)), db.prepare("DELETE FROM api_keys WHERE site = ?").bind(domain), db.prepare("DELETE FROM sites WHERE domain = ?").bind(domain)]);
	forgetCountedSites();
	return true;
}

// Every counted site (not those of clients who haven't paid). Kept for a minute so hits don't each need a database read.
let known: { sites: string[]; at: number } | null = null;

export async function countedSites(db: D1Database, now: number): Promise<string[]> {
	if (!known || now - known.at > 60_000 || now < known.at) {
		const r = await db.prepare("SELECT s.domain FROM sites s LEFT JOIN accounts a ON a.id = s.account_id WHERE a.status IS NULL OR a.status != 'unpaid'").all<{ domain: string }>().catch(() => ({ results: [] as { domain: string }[] }));
		known = { sites: (r.results ?? []).map((x) => x.domain), at: now };
	}
	return known.sites;
}

export function forgetCountedSites(): void {
	known = null;
}

/** A short email, such as an alert. Never stops the request it came from. */
export async function alertOwner(mail: Mailer | undefined, from: string, to: string | undefined, subject: string, text: string): Promise<void> {
	if (!mail || !to || to.endsWith("@localhost")) return;
	try {
		await mail.send({ to, from: { email: from, name: "ReaderCount" }, subject, text });
	} catch (e) {
		console.error("alert email failed", e instanceof Error ? e.message : String(e));
	}
}
