// ReaderCount: count unique visitors without cookies.
// Each visitor becomes a hash of today's secret salt, the site, their IP address and browser.
// The salt is replaced every day (UTC) and the old one deleted, so a hash can't be linked to the
// next day's, and the IP address can't be worked back out. The IP itself is never stored.

let cached: { day: string; salt: string } | undefined;

export function utcDay(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

export async function saltFor(db: D1Database, day: string): Promise<string> {
	if (cached?.day === day) return cached.salt;
	const fresh = randomHex(32);
	await db.prepare("INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)").bind(day, fresh).run();
	const row = await db.prepare("SELECT salt FROM salts WHERE day = ?").bind(day).first<{ salt: string }>();
	const salt = row?.salt ?? fresh;
	cached = { day, salt };
	return salt;
}

export async function visitorId(salt: string, site: string, ip: string, ua: string): Promise<string> {
	const bytes = new TextEncoder().encode(`${salt}|${site}|${ip}|${ua}`);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return toHex(digest.subarray(0, 16));
}

/** Deletes every salt older than today, so yesterday's visitors can't be matched to today's. */
export async function forgetOldSalts(db: D1Database, today: string): Promise<void> {
	await db.prepare("DELETE FROM salts WHERE day < ?").bind(today).run();
	if (cached && cached.day < today) cached = undefined;
}

function randomHex(n: number): string {
	return toHex(crypto.getRandomValues(new Uint8Array(n)));
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
