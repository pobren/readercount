// A small stand-in for Cloudflare D1, backed by Node's built-in SQLite, for tests.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

export function fakeD1(): { db: D1Database; sql: DatabaseSync } {
	const sql = new DatabaseSync(":memory:");
	const dir = new URL("../migrations/", import.meta.url);
	for (const f of readdirSync(dir).sort()) sql.exec(readFileSync(new URL(f, dir), "utf8"));
	const prepare = (query: string) => {
		let args: unknown[] = [];
		const stmt = {
			bind(...a: unknown[]) {
				args = a;
				return stmt;
			},
			async run() {
				sql.prepare(query).run(...(args as never[]));
				return { success: true };
			},
			async first<T>() {
				return (sql.prepare(query).get(...(args as never[])) ?? null) as T | null;
			},
			async all<T>() {
				return { results: sql.prepare(query).all(...(args as never[])) as T[] };
			},
		};
		return stmt;
	};
	const batch = async (stmts: { run(): Promise<unknown> }[]) => {
		const out = [];
		for (const st of stmts) out.push(await st.run());
		return out;
	};
	return { db: { prepare, batch } as unknown as D1Database, sql };
}

/** Puts websites on the owner's account, as adding them on the stats page does. */
export async function addSites(db: D1Database, list: string): Promise<void> {
	const { forgetCountedSites } = await import("../src/accounts.ts");
	for (const d of list.split(",").map((s) => s.trim()).filter(Boolean)) await db.prepare("INSERT OR IGNORE INTO sites (domain, account_id, created_at) VALUES (?, 'owner', 0)").bind(d).run();
	forgetCountedSites();
}
