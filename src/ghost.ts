// Connect Ghost: a Ghost website's owner makes a Custom integration in Ghost (Settings, Integrations) and pastes its
// Admin API URL and key here. With it ReaderCount reads the published posts' titles and dates, so the stats show
// titles instead of addresses and each new post appears on the chart. Ghost tells us the moment a post goes out
// (a webhook the connection adds to that integration), and every night we read the whole list again to pick up
// edits and deletions.
//
// Ghost doesn't let integrations change Code injection, so the owner still pastes the counting code in themselves.
// The key can only do what a Ghost integration can; we use it to read posts and add or remove our one webhook.

import { randomToken, sha256 } from "./accounts.ts";
import { belongsTo } from "./collect.ts";
import type { Env } from "./index.ts";
import { utcDay } from "./visitor.ts";

/** The most posts we keep per website (newest first). */
const MAX_POSTS = 2_000;
const PAGE = 100;

export type GhostLink = { site: string; account_id: string; api_url: string; key: string; hook_id: string | null; connected_at: number; synced_at: number | null; last_error: string | null };
export type GhostState = { connected: boolean; apiUrl?: string; posts?: number; error?: string | null };
export type Post = { day: string; path: string; title: string };

type GhostEnv = Pick<Env, "DB" | "APP_HOST" | "GOOGLE_TOKEN_KEY" | "ADMIN_PASSWORD">;

// ---- The key is kept encrypted, the same way as Google's refresh tokens. ----

async function cryptoKey(env: GhostEnv): Promise<CryptoKey> {
	const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode((env.GOOGLE_TOKEN_KEY || env.ADMIN_PASSWORD || "") + ":ghost"));
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(env: GhostEnv, text: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(env), new TextEncoder().encode(text)));
	return btoa(String.fromCharCode(...iv, ...ct));
}

async function unseal(env: GhostEnv, sealed: string): Promise<string> {
	const b = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
	return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, await cryptoKey(env), b.slice(12)));
}

// ---- Talking to Ghost's Admin API ----

/** "https://example.com/ghost/" or "example.ghost.io" -> "https://example.ghost.io"; null when it isn't a web address. */
export function apiOrigin(input: unknown): string | null {
	let text = String(input ?? "").trim();
	if (!text) return null;
	if (!/^https?:\/\//i.test(text)) text = "https://" + text;
	try {
		const u = new URL(text);
		if (u.protocol !== "https:" || !u.hostname.includes(".") || u.username || u.password || u.port) return null;
		return u.origin;
	} catch {
		return null;
	}
}

/** An Admin API key is "id:secret", the secret in hex. */
export function parseKey(input: unknown): { id: string; secret: string } | null {
	const m = /^([0-9a-f]{24}):([0-9a-f]{64})$/i.exec(String(input ?? "").trim());
	return m ? { id: m[1], secret: m[2] } : null;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64json = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

/** A short-lived token signed with the key, as Ghost's Admin API asks for. */
export async function ghostToken(key: { id: string; secret: string }, now: number): Promise<string> {
	const iat = Math.floor(now / 1000);
	const unsigned = `${b64json({ alg: "HS256", typ: "JWT", kid: key.id })}.${b64json({ iat, exp: iat + 300, aud: "/admin/" })}`;
	const secret = Uint8Array.from(key.secret.match(/../g)!.map((h) => parseInt(h, 16)));
	const hmac = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return `${unsigned}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(unsigned))))}`;
}

type Get = typeof fetch;

async function ghost(origin: string, key: { id: string; secret: string }, path: string, now: number, get: Get, init: RequestInit = {}): Promise<Response> {
	return get(`${origin}/ghost/api/admin${path}`, {
		...init,
		headers: { Authorization: `Ghost ${await ghostToken(key, now)}`, "Accept-Version": "v5.0", "Content-Type": "application/json", "User-Agent": "ReaderCount (+https://paulobrien.dev/readercount/)" },
		redirect: "manual",
		signal: AbortSignal.timeout(10_000),
	});
}

/** What went wrong, in words the owner can act on. */
function trouble(status: number): string {
	if (status === 401 || status === 403) return "Ghost didn't accept that Admin API key. Copy it again from Settings, Integrations, ReaderCount in Ghost.";
	if (status === 404 || (status >= 300 && status < 400)) return "We couldn't find Ghost's Admin API at that address. Copy the API URL from the same Ghost integration page.";
	return `Ghost answered with an error (${status}). Try again in a minute.`;
}

/** A post's address on the website, as ReaderCount stores page addresses ("/my-post/"). */
function pathOf(url: unknown): string | null {
	try {
		return new URL(String(url)).pathname || "/";
	} catch {
		return null;
	}
}

function toPost(p: { title?: unknown; url?: unknown; published_at?: unknown }): Post | null {
	const path = pathOf(p.url);
	const when = Date.parse(String(p.published_at ?? ""));
	const title = String(p.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
	return path && title && !Number.isNaN(when) ? { day: utcDay(when), path, title } : null;
}

/** Every published post, newest first. */
async function readPosts(origin: string, key: { id: string; secret: string }, now: number, get: Get): Promise<Post[] | { error: string }> {
	const out: Post[] = [];
	for (let page = 1; out.length < MAX_POSTS; page++) {
		const q = new URLSearchParams({ fields: "title,url,published_at", filter: "status:published", order: "published_at desc", limit: String(PAGE), page: String(page) });
		const res = await ghost(origin, key, `/posts/?${q}`, now, get);
		if (!res.ok) return { error: trouble(res.status) };
		const body = (await res.json()) as { posts?: { title?: string; url?: string; published_at?: string }[]; meta?: { pagination?: { next?: number | null } } };
		for (const p of body.posts ?? []) {
			const post = toPost(p);
			if (post) out.push(post);
		}
		if (!body.meta?.pagination?.next) break;
	}
	return out.slice(0, MAX_POSTS);
}

async function savePosts(db: D1Database, site: string, posts: Post[]): Promise<void> {
	const insert = (p: Post) => db.prepare("INSERT OR REPLACE INTO posts (site, path, title, day) VALUES (?, ?, ?, ?)").bind(site, p.path, p.title, p.day);
	await db.batch([db.prepare("DELETE FROM posts WHERE site = ?").bind(site), ...posts.map(insert)]);
}

// ---- Connecting and disconnecting ----

/** Checks the address and key with Ghost, adds our webhook, reads the posts and keeps the key. */
export async function connectGhost(env: GhostEnv, accountId: string, site: string, apiUrlIn: unknown, keyIn: unknown, now: number, get: Get = fetch): Promise<{ posts: number } | { error: string }> {
	const origin = apiOrigin(apiUrlIn);
	if (!origin) return { error: "That API URL doesn't look right. It's the address of your Ghost site, starting https://, shown on the integration's page in Ghost." };
	const key = parseKey(keyIn);
	if (!key) return { error: "That isn't a Ghost Admin API key. It's the long one with a colon in the middle, shown as Admin API key on the integration's page in Ghost." };
	let res: Response;
	try {
		res = await ghost(origin, key, "/site/", now, get);
	} catch {
		return { error: `We couldn't reach ${origin}. Check the API URL, and that your Ghost site is online.` };
	}
	if (!res.ok) return { error: trouble(res.status) };
	// The Ghost site must be this website, so a key for another blog can't put its posts on these stats.
	const siteUrl = ((await res.json()) as { site?: { url?: string } }).site?.url ?? "";
	let host = "";
	try {
		host = new URL(siteUrl).hostname;
	} catch {
		// checked below
	}
	if (!host || !belongsTo(host, site)) {
		return { error: `That Ghost site is ${host || "a different website"}, not ${site}. Connect it to the matching website in ReaderCount.` };
	}
	const posts = await readPosts(origin, key, now, get);
	if ("error" in posts) return posts;

	const old = await env.DB.prepare("SELECT * FROM ghost_links WHERE site = ?").bind(site).first<GhostLink>();
	if (old) await dropHook(env, old, now, get);
	const hookToken = randomToken(24);
	const hookId = await addHook(origin, key, hookToken, env.APP_HOST, now, get);
	await env.DB.prepare(
		`INSERT OR REPLACE INTO ghost_links (site, account_id, api_url, key, hook_id, hook_hash, connected_at, synced_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
	)
		.bind(site, accountId, origin, await seal(env, `${key.id}:${key.secret}`), hookId, hookId ? await sha256(hookToken) : null, now, now)
		.run();
	await savePosts(env.DB, site, posts);
	return { posts: posts.length };
}

/** Asks Ghost to tell us when a post goes out. If Ghost says no, the nightly read still catches new posts. */
async function addHook(origin: string, key: { id: string; secret: string }, token: string, appHost: string | undefined, now: number, get: Get): Promise<string | null> {
	if (!appHost) return null;
	try {
		const res = await ghost(origin, key, "/webhooks/", now, get, {
			method: "POST",
			body: JSON.stringify({ webhooks: [{ event: "post.published", target_url: `https://${appHost}/ghost/hook/${token}`, name: "ReaderCount" }] }),
		});
		if (!res.ok) return null;
		return ((await res.json()) as { webhooks?: { id?: string }[] }).webhooks?.[0]?.id ?? null;
	} catch {
		return null;
	}
}

async function dropHook(env: GhostEnv, link: GhostLink, now: number, get: Get): Promise<void> {
	if (!link.hook_id || !/^[0-9a-f]{24}$/i.test(link.hook_id)) return;
	try {
		const key = parseKey(await unseal(env, link.key));
		if (key) await ghost(link.api_url, key, `/webhooks/${link.hook_id}/`, now, get, { method: "DELETE" });
	} catch {
		// The owner may have deleted the integration already; nothing more to tidy on Ghost's side.
	}
}

/** Removes the connection, our webhook in Ghost and the post titles. */
export async function disconnectGhost(env: GhostEnv, site: string, now: number, get: Get = fetch): Promise<void> {
	const link = await env.DB.prepare("SELECT * FROM ghost_links WHERE site = ?").bind(site).first<GhostLink>();
	if (link) await dropHook(env, link, now, get);
	await env.DB.batch([env.DB.prepare("DELETE FROM ghost_links WHERE site = ?").bind(site), env.DB.prepare("DELETE FROM posts WHERE site = ?").bind(site)]);
}

export async function ghostState(db: D1Database, site: string): Promise<GhostState> {
	const link = await db.prepare("SELECT api_url, last_error FROM ghost_links WHERE site = ?").bind(site).first<{ api_url: string; last_error: string | null }>();
	if (!link) return { connected: false };
	const n = await db.prepare("SELECT COUNT(*) AS n FROM posts WHERE site = ?").bind(site).first<{ n: number }>();
	return { connected: true, apiUrl: link.api_url, posts: n?.n ?? 0, error: link.last_error };
}

// ---- Keeping the posts up to date ----

/** Ghost's "post published" webhook, at /ghost/hook/<token>. Answers 404 to anything it doesn't recognise. */
export async function ghostHook(request: Request, env: GhostEnv, token: string): Promise<Response> {
	if (request.method !== "POST" || !token) return new Response("Not found", { status: 404 });
	const link = await env.DB.prepare("SELECT site FROM ghost_links WHERE hook_hash = ?").bind(await sha256(token)).first<{ site: string }>();
	if (!link) return new Response("Not found", { status: 404 });
	const text = await request.text();
	if (text.length > 2_000_000) return new Response("Too big", { status: 413 });
	let body: { post?: { current?: { title?: string; url?: string; published_at?: string; status?: string } } } = {};
	try {
		body = JSON.parse(text);
	} catch {
		return new Response("Not JSON", { status: 400 });
	}
	const current = body.post?.current;
	const post = current && (current.status ?? "published") === "published" ? toPost(current) : null;
	if (post) await env.DB.prepare("INSERT OR REPLACE INTO posts (site, path, title, day) VALUES (?, ?, ?, ?)").bind(link.site, post.path, post.title, post.day).run();
	return new Response(null, { status: 204 });
}

/** Nightly: read every connected website's posts again. A failure is kept to show on the settings row. */
export async function syncGhost(env: GhostEnv, now: number, get: Get = fetch): Promise<void> {
	const links = await env.DB.prepare("SELECT * FROM ghost_links").all<GhostLink>();
	for (const link of links.results ?? []) {
		let result: Post[] | { error: string };
		try {
			const key = parseKey(await unseal(env, link.key));
			result = key ? await readPosts(link.api_url, key, now, get) : { error: "The saved key can't be read. Connect Ghost again." };
		} catch {
			result = { error: `We couldn't reach ${link.api_url} last night. We'll try again tonight.` };
		}
		if ("error" in result) {
			await env.DB.prepare("UPDATE ghost_links SET last_error = ? WHERE site = ?").bind(result.error, link.site).run();
			continue;
		}
		await savePosts(env.DB, link.site, result);
		await env.DB.prepare("UPDATE ghost_links SET synced_at = ?, last_error = NULL WHERE site = ?").bind(now, link.site).run();
	}
}

// ---- Reading them back ----

/** Posts published between two days, for marks on the chart. */
export async function postsBetween(db: D1Database, site: string, from: string, to: string): Promise<Post[]> {
	const rows = await db.prepare("SELECT day, path, title FROM posts WHERE site = ? AND day >= ? AND day <= ? ORDER BY day LIMIT 200").bind(site, from, to).all<Post>();
	return rows.results ?? [];
}

/** Titles for the pages on screen, keyed by address. */
export async function titlesFor(db: D1Database, site: string, paths: string[]): Promise<Map<string, string>> {
	const want = [...new Set(paths.filter(Boolean))].slice(0, 90);
	if (!want.length) return new Map();
	const rows = await db
		.prepare(`SELECT path, title FROM posts WHERE site = ? AND path IN (${want.map(() => "?").join(", ")})`)
		.bind(site, ...want)
		.all<{ path: string; title: string }>();
	return new Map((rows.results ?? []).map((r) => [r.path, r.title]));
}
