// ReaderCount: run with `node --experimental-strip-types --test stats/test/stats.test.ts`.
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { parseAgent, isBot } from "../src/agent.ts";
import { referrerHost, sourceName } from "../src/referrer.ts";
import { parseHit, siteList } from "../src/collect.ts";
import { TRACKER } from "../src/tracker.ts";
import worker, { logo, record, tidy, type Env } from "../src/index.ts";
import { addSites, fakeD1 } from "./fake-d1.ts";
import { checkSite, lastVisit } from "../src/app.ts";
import { buildReport, iconFor, linkSite, sourceLinks, pageName, readView, renderDashboard } from "../src/dashboard.ts";
import { toCsv } from "../src/export.ts";
import { findFixes } from "../src/fixes.ts";
import { sendDigests, setDigest } from "../src/digest.ts";
import { sampleReport } from "./sample.ts";
import { forgetCountedSites, sha256 } from "../src/accounts.ts";
import { connectGhost, disconnectGhost, ghostHook, ghostState, postsBetween, titlesFor } from "../src/ghost.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const WIN_EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
const ANDROID_TAB = "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
/** Signs in as the owner with ADMIN_PASSWORD and returns the session cookie. */
async function ownerCookie(env: Env, origin = "https://stats.example.com"): Promise<string> {
	const res = await worker.fetch(new Request(origin + "/signin", { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password: env.ADMIN_PASSWORD ?? "" }) }), env);
	assert.equal(res.status, 303, "signed in");
	return (res.headers.get("Set-Cookie") ?? "").split(";")[0];
}

const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

test("browsers, systems and devices are recognised", () => {
	assert.deepEqual(parseAgent(IPHONE), { browser: "Safari", os: "iOS", device: "mobile" });
	assert.deepEqual(parseAgent(MAC_CHROME), { browser: "Chrome", os: "macOS", device: "desktop" });
	assert.deepEqual(parseAgent(WIN_EDGE), { browser: "Edge", os: "Windows", device: "desktop" });
	assert.deepEqual(parseAgent(ANDROID_TAB), { browser: "Chrome", os: "Android", device: "tablet" });
});

test("bots and scripts are not counted", () => {
	assert.ok(isBot(GOOGLEBOT));
	assert.ok(isBot("curl/8.5.0"));
	assert.ok(isBot(""));
	assert.ok(isBot("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0 Safari/537.36"));
	assert.ok(!isBot(IPHONE));
});

test("referrers become friendly source names, and the site's own pages are not a source", () => {
	assert.equal(referrerHost("https://www.google.co.uk/", "paulobrien.com"), "google.co.uk");
	assert.equal(sourceName("google.co.uk"), "Google");
	assert.equal(sourceName("news.google.com"), "Google News");
	assert.equal(sourceName("t.co"), "X (Twitter)");
	assert.equal(sourceName("old.reddit.com"), "Reddit");
	assert.equal(sourceName("someblog.net"), "someblog.net");
	assert.equal(referrerHost("https://paulobrien.com/other-post/", "www.paulobrien.com"), "");
	assert.equal(referrerHost("", "paulobrien.com"), "");
});

test("a page view is tidied into a row", () => {
	const hit = parseHit(
		{ k: "v", s: "paulobrien.com", u: "https://www.paulobrien.com/iphone-17-review/?utm_source=newsletter&utm_medium=email&utm_campaign=oct", r: "https://www.google.com/", v: "abc123" },
		IPHONE,
		siteList("paulobrien.com, example.org"),
	);
	assert.ok(!("ignored" in hit) && hit.kind === "view");
	assert.equal(hit.path, "/iphone-17-review/");
	assert.equal(hit.source, "newsletter", "a campaign tag wins over the referrer");
	assert.equal(hit.referrer, "google.com");
	assert.equal(hit.utmMedium, "email");
	assert.equal(hit.device, "mobile");
});

test("hits for other sites, bots, bad links and junk are ignored", () => {
	const sites = siteList("paulobrien.com");
	assert.deepEqual(parseHit({ k: "v", s: "evil.com", u: "https://evil.com/" }, IPHONE, sites), { ignored: "unknown site" });
	assert.deepEqual(parseHit({ k: "v", s: "paulobrien.com", u: "https://evil.com/" }, IPHONE, sites), { ignored: "wrong site", site: "paulobrien.com", host: "evil.com" });
	assert.deepEqual(parseHit({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/" }, GOOGLEBOT, sites), { ignored: "bot" });
	assert.deepEqual(parseHit({ k: "o", s: "paulobrien.com", u: "https://paulobrien.com/", t: "javascript:alert(1)" }, IPHONE, sites), { ignored: "bad link" });
	assert.deepEqual(parseHit({ k: "x", s: "paulobrien.com" }, IPHONE, sites), { ignored: "unknown kind" });
	assert.deepEqual(parseHit("hello", IPHONE, sites), { ignored: "not json" });
});

test("the tracker script is valid JavaScript and small", () => {
	assert.doesNotThrow(() => new Function(TRACKER));
	// readercount.com says "under 2 KB": that's the size sent, compressed (Cloudflare sends it with gzip or Brotli).
	const sent = gzipSync(TRACKER).length;
	assert.ok(sent < 2048, `tracker is ${sent} bytes gzipped`);
	assert.ok(!/cookie|sessionStorage/.test(TRACKER), "sets no cookies");
	// localStorage is shortened to L and the key to K="stats_ignore"; the only thing stored is the owner's own opt-out.
	assert.deepEqual(TRACKER.match(/\w*\.setItem\([^)]*\)/g), ["L.setItem(K,1)"], "the only thing stored is the owner's own opt-out");
	assert.ok(/K="stats_ignore"/.test(TRACKER) && /L=localStorage/.test(TRACKER), "stores only the opt-out key");
});

/** A hit as a browser sends it, with the Origin of the page it came from. */
function hitRequest(body: unknown, ua = IPHONE, ip = "203.0.113.7") {
	const b = body as { u?: string; s?: string };
	let origin = "https://" + b.s;
	try {
		origin = new URL(String(b.u)).origin;
	} catch {
		// A "leave" hit has no page address.
	}
	return new Request("https://stats.paulobrien.com/e", {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "User-Agent": ua, "CF-Connecting-IP": ip, "Content-Type": "text/plain", Origin: origin },
	});
}

test("views, clicks and time on page are stored; the same reader is one visitor per day", async () => {
	const { db, sql } = fakeD1();
	const env: Env = { DB: db, SITES: "paulobrien.com" };
	await addSites(db, "paulobrien.com");
	const day1 = Date.UTC(2026, 9, 13, 10);
	await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/a/", r: "https://t.co/x", v: "view1" }), env, day1);
	await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/b/", r: "https://paulobrien.com/a/", v: "view2" }), env, day1 + 60_000);
	await record(hitRequest({ k: "o", s: "paulobrien.com", u: "https://paulobrien.com/b/", t: "https://www.amazon.co.uk/dp/B0TEST?tag=paul-21", v: "view2" }), env, day1 + 90_000);
	await record(hitRequest({ k: "l", s: "paulobrien.com", v: "view2", d: 42 }), env, day1 + 100_000);
	await record(hitRequest({ k: "l", s: "paulobrien.com", v: "view2", d: 30 }), env, day1 + 110_000);
	await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/a/", v: "view3" }, MAC_CHROME, "198.51.100.9"), env, day1 + 120_000);

	const rows = sql.prepare("SELECT kind, path, target, source, visitor, view_id, duration FROM events ORDER BY id").all() as Record<string, unknown>[];
	assert.equal(rows.length, 4);
	assert.equal(rows[0].source, "X (Twitter)");
	assert.equal(rows[1].source, "", "moving between your own pages has no source");
	assert.equal(rows[2].kind, "outbound");
	assert.equal(rows[2].target, "https://www.amazon.co.uk/dp/B0TEST?tag=paul-21");
	assert.equal(rows[1].duration, 42, "the longest time on page reported is kept");
	assert.equal(rows[0].visitor, rows[1].visitor, "same reader, same day, same visitor");
	assert.notEqual(rows[0].visitor, rows[3].visitor, "a different reader is a different visitor");
	assert.ok(!JSON.stringify(rows).includes("203.0.113.7"), "the IP address is never stored");
});

test("the same reader on the next day can't be linked to the day before", async () => {
	const { db, sql } = fakeD1();
	const env: Env = { DB: db, SITES: "paulobrien.com" };
	await addSites(db, "paulobrien.com");
	const day1 = Date.UTC(2026, 9, 14, 10);
	await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/", v: "aaaa1" }), env, day1);
	await tidy(env, day1 + 86_400_000);
	await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/", v: "aaaa2" }), env, day1 + 86_400_000);
	const rows = sql.prepare("SELECT visitor FROM events ORDER BY id").all() as { visitor: string }[];
	assert.notEqual(rows[0].visitor, rows[1].visitor);
	const salts = sql.prepare("SELECT day FROM salts").all() as { day: string }[];
	assert.deepEqual(salts.map((s) => s.day), ["2026-10-15"], "yesterday's salt is gone");
});

test("the Worker serves the script and accepts hits from any site's pages", async () => {
	const { db } = fakeD1();
	const env: Env = { DB: db, SITES: "paulobrien.com" };
	await addSites(db, "paulobrien.com");
	const js = await worker.fetch(new Request("https://stats.paulobrien.com/s.js"), env);
	assert.equal(js.status, 200);
	assert.match(js.headers.get("Content-Type") ?? "", /javascript/);
	const pre = await worker.fetch(new Request("https://stats.paulobrien.com/e", { method: "OPTIONS" }), env);
	assert.equal(pre.headers.get("Access-Control-Allow-Origin"), "*");
	const hit = await worker.fetch(hitRequest({ k: "v", s: "nope.com", u: "https://nope.com/" }), env);
	assert.equal(hit.status, 202, "ignored hits look the same as recorded ones");
});

test("every address serves the ReaderCount icons itself, for Claude's directory and phone home screens", async () => {
	const { db } = fakeD1();
	const env: Env = { DB: db, SITES: "", APP_HOST: "app.readercount.com", MCP_HOST: "mcp.readercount.com" };
	const ico = await worker.fetch(new Request("https://mcp.readercount.com/favicon.ico"), env);
	assert.equal(ico.status, 200);
	assert.equal(ico.headers.get("Content-Type"), "image/x-icon");
	for (const path of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/icon.png", "/icon-192.png"]) {
		const res = await worker.fetch(new Request(`https://app.readercount.com${path}`), env);
		assert.equal(res.status, 200, path);
		assert.equal(res.headers.get("Content-Type"), "image/png", path);
		const png = new Uint8Array(await res.arrayBuffer());
		assert.deepEqual([...png.slice(1, 4)], [80, 78, 71], `${path} is a PNG`);
	}
});

test("the stats page can be added to a home screen as an app", async () => {
	const { db } = fakeD1();
	const env: Env = { DB: db, SITES: "paulobrien.com", APP_HOST: "app.readercount.com" };
	await addSites(db, "paulobrien.com");
	const m = await worker.fetch(new Request("https://app.readercount.com/manifest.webmanifest"), env);
	assert.match(m.headers.get("Content-Type") ?? "", /manifest\+json/);
	const manifest = await m.json();
	assert.equal(manifest.name, "ReaderCount");
	assert.equal(manifest.display, "standalone");
	assert.ok(manifest.icons.some((i: { sizes: string }) => i.sizes === "512x512"));
	const sw = await worker.fetch(new Request("https://app.readercount.com/sw.js"), env);
	assert.match(sw.headers.get("Content-Type") ?? "", /javascript/);
	new Function(await sw.text());
	const signIn = await (await worker.fetch(new Request("https://app.readercount.com/signin"), env)).text();
	assert.match(signIn, /rel="manifest"/);
	assert.match(signIn, /apple-mobile-web-app-title" content="ReaderCount"/);
	assert.match(signIn, /rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon.png\?v=2"/, "the home screen icon comes from the app's own address");
	assert.doesNotMatch(renderDashboard(sampleReport("7d", Date.now()), ["yourblog.com"], { demo: true }), /rel="manifest"/, "the public demo isn't an app");
});

test("Google Search Console: connect, copy the searches, show them, and answer Claude", async () => {
	const { db, sql } = fakeD1();
	const env: Env = { DB: db, SITES: "paulobrien.com", ADMIN_PASSWORD: "s3cret-key-long", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret" };
	await addSites(db, "paulobrien.com");
	const t = Date.UTC(2026, 9, 20, 12);
	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	const realNow = Date.now;
	const starts: string[] = [];
	Date.now = () => t;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = String(init?.body ?? "");
		calls.push(url);
		const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });
		if (url === "https://oauth2.googleapis.com/token") {
			const p = new URLSearchParams(body);
			if (p.get("grant_type") === "authorization_code") {
				assert.equal(p.get("redirect_uri"), "https://paulobrien.readercount.com/google/callback");
				return ok({ access_token: "a1", refresh_token: "r1-refresh" });
			}
			assert.equal(p.get("refresh_token"), "r1-refresh", "the stored token decrypts back");
			return ok({ access_token: "a2" });
		}
		if (url.endsWith("/webmasters/v3/sites")) return ok({ siteEntry: [{ siteUrl: "https://example.org/", permissionLevel: "siteOwner" }, { siteUrl: "sc-domain:paulobrien.com", permissionLevel: "siteOwner" }] });
		if (url.includes("/sites/sc-domain%3Apaulobrien.com/searchAnalytics/query")) {
			const q = JSON.parse(body);
			starts.push(q.startDate);
			if (q.dimensions.length === 1) return ok({ rows: [{ keys: ["2026-10-18"], clicks: 10, impressions: 200, position: 5 }] });
			if (q.startRow > 0) return ok({});
			return ok({
				rows: [
					{ keys: ["2026-10-18", "fastmail review", "https://paulobrien.com/fastmail-review/"], clicks: 6, impressions: 50, position: 2 },
					{ keys: ["2026-10-18", "fastmail review", "https://www.paulobrien.com/fastmail-review/"], clicks: 1, impressions: 50, position: 4 },
					{ keys: ["2026-10-18", "best vpn uk", "https://paulobrien.com/best-vpn-uk/"], clicks: 0, impressions: 90, position: 14 },
				],
			});
		}
		throw new Error("unexpected fetch " + url);
	}) as typeof fetch;
	try {
		const cookie = await ownerCookie(env, "https://paulobrien.readercount.com");
		const get = (path: string, extra = "") =>
			worker.fetch(new Request("https://paulobrien.readercount.com" + path, { headers: { Cookie: [cookie, extra].filter(Boolean).join("; ") } }), env);

		const before = await (await get("/")).text();
		assert.ok(before.includes("Continue with Google"));
		assert.match((await worker.fetch(new Request("https://paulobrien.readercount.com/google/connect"), env)).headers.get("Location") ?? "", /^\/signin/, "only for the owner");

		const start = await get("/google/connect");
		assert.equal(start.status, 303);
		const google = new URL(start.headers.get("Location")!);
		assert.equal(google.searchParams.get("scope"), "https://www.googleapis.com/auth/webmasters.readonly");
		const state = google.searchParams.get("state")!;
		const stateCookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0];
		assert.equal((await get(`/google/callback?code=c1&state=wrong`, stateCookie)).status, 400, "state must match");

		const back = await get(`/google/callback?code=c1&state=${state}`, stateCookie);
		assert.equal(back.status, 303);
		const stored = sql.prepare("SELECT token FROM google_links").get() as { token: string };
		assert.ok(!stored.token.includes("r1-refresh"), "the refresh token is stored encrypted");
		assert.deepEqual(sql.prepare("SELECT query, page, clicks, impressions, position FROM search ORDER BY query").all().map((r) => ({ ...r })), [
			{ query: "best vpn uk", page: "/best-vpn-uk/", clicks: 0, impressions: 90, position: 14 },
			{ query: "fastmail review", page: "/fastmail-review/", clicks: 7, impressions: 100, position: 3 },
		]);

		const html = await (await worker.fetch(new Request("https://paulobrien.readercount.com/?range=7d", { headers: { Cookie: cookie } }), env)).text();
		for (const bit of ["Organic Search Performance", "fastmail review", "10 Clicks", "Disconnect"]) assert.ok(html.includes(bit), `page shows ${bit}`);
		assert.ok(html.includes('href="https://search.google.com/search-console/performance/search-analytics?resource_id=sc-domain%3Apaulobrien.com"'), "links to the site's own Search Console report");
		assert.ok(!html.includes("can't find this website"));

		{
			const { handleMcp } = await import("../src/mcp.ts");
			const res = await handleMcp(new Request("https://paulobrien.readercount.com/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_google_searches", arguments: { query_contains: "FASTMAIL", period: "7d" } } }) }), db, ["paulobrien.com"], t, "owner");
			const data = ((await res.json()) as any).result.structuredContent;
			assert.deepEqual(data.rows, [{ query: "fastmail review", clicks: 7, impressions: 100, position: 3 }]);
			assert.equal(data.latest_day_with_data, "2026-10-18");
		}

		// A separate GOOGLE_TOKEN_KEY: tokens sealed with the older ADMIN_PASSWORD key still open, and are sealed again with the new one.
		const { syncSearch } = await import("../src/google.ts");
		env.GOOGLE_TOKEN_KEY = "google-only-key";
		const sealedOld = (sql.prepare("SELECT token FROM google_links").get() as { token: string }).token;
		assert.equal(await syncSearch(env, "owner", ["paulobrien.com"], t), "synced paulobrien.com");
		const sealedNew = (sql.prepare("SELECT token FROM google_links").get() as { token: string }).token;
		assert.notEqual(sealedNew, sealedOld, "moved onto the new key");
		env.ADMIN_PASSWORD = "changed-dashboard-key-long";
		assert.equal(await syncSearch(env, "owner", ["paulobrien.com"], t), "synced paulobrien.com", "so changing the stats page secret no longer loses the Google link");
		env.ADMIN_PASSWORD = "s3cret-key-long";

		// The nightly copy fetches the last 5 days of a website it already knows, and 90 days of one it's seeing for the first time.
		starts.length = 0;
		await syncSearch(env, "owner", ["paulobrien.com"], t);
		assert.deepEqual([...new Set(starts)], [new Date(t - 5 * 86_400_000).toISOString().slice(0, 10)]);
		sql.prepare("DELETE FROM search_sites").run();
		starts.length = 0;
		await syncSearch(env, "owner", ["paulobrien.com"], t);
		assert.deepEqual([...new Set(starts)], [new Date(t - 90 * 86_400_000).toISOString().slice(0, 10)]);

		// A website that isn't in the connected Google account says so, with how to add it, and has no Search Console link.
		const { searchReport } = await import("../src/google.ts");
		assert.equal(await syncSearch(env, "owner", ["paulobrien.com", "elsewhere.com"], t), "synced paulobrien.com");
		assert.equal((await searchReport(db, "elsewhere.com", "2026-10-01", "2026-10-20")).property, null);
		await addSites(db, "elsewhere.com");
		const other = await (await get("/?site=elsewhere.com&range=7d")).text();
		assert.ok(other.includes("can't find this website in the Search Console"), "explains how to add a site from another Google account");
		assert.ok(!other.includes("resource_id="));
		sql.prepare("DELETE FROM sites WHERE domain = 'elsewhere.com'").run();
		forgetCountedSites();

		const off = await worker.fetch(new Request("https://paulobrien.readercount.com/google/disconnect", { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.example" } }), env);
		assert.equal(off.status, 403);
		calls.length = 0;
		await worker.fetch(new Request("https://paulobrien.readercount.com/google/disconnect", { method: "POST", headers: { Cookie: cookie, Origin: "https://paulobrien.readercount.com" } }), env);
		assert.ok(calls.some((c) => c.includes("/revoke")), "access is handed back to Google");
		assert.equal((sql.prepare("SELECT COUNT(*) AS n FROM search").get() as { n: number }).n, 0, "disconnecting forgets Google's data");
	} finally {
		globalThis.fetch = realFetch;
		Date.now = realNow;
	}
});

test("official Claude connector: register, sign in, allow, swap the code (PKCE), and read only your own stats", async () => {
	const { db, sql } = fakeD1();
	const sent: { text: string }[] = [];
	const env: Env = { DB: db, SITES: "paulobrien.com", ADMIN_PASSWORD: "owner-password-long", EMAIL: { send: async (m) => void sent.push(m) } };
	const mcp = (path: string, init: RequestInit = {}) => worker.fetch(new Request("https://mcp.readercount.com" + path, { redirect: "manual", ...init }), env);
	const form = (path: string, body: Record<string, string>, cookie = "") =>
		mcp(path, { method: "POST", body: new URLSearchParams(body), headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" } });

	// Two accounts, each with a site and a visit.
	sql.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('owner', 'paul@example.com', 1), ('a2', 'other@example.com', 1)").run();
	sql.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES ('myblog.co.uk', 'owner', 1), ('theirs.com', 'a2', 1)").run();
	forgetCountedSites();
	await record(hitRequest({ k: "v", s: "myblog.co.uk", u: "https://myblog.co.uk/", v: "o1" }), env, Date.now());
	await record(hitRequest({ k: "v", s: "theirs.com", u: "https://theirs.com/", v: "o2" }), env, Date.now());

	// 1. Claude calls without a token and is told where to sign in.
	const rpcBody = (method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
	const no = await mcp("/mcp", { method: "POST", body: rpcBody("tools/list"), headers: { "Content-Type": "application/json" } });
	assert.equal(no.status, 401);
	assert.equal(no.headers.get("WWW-Authenticate"), 'Bearer resource_metadata="https://mcp.readercount.com/.well-known/oauth-protected-resource", scope="stats:read"');
	const prm = (await (await mcp("/.well-known/oauth-protected-resource")).json()) as any;
	assert.deepEqual(prm.authorization_servers, ["https://mcp.readercount.com"]);
	const asm = (await (await mcp("/.well-known/oauth-authorization-server")).json()) as any;
	assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);

	// 2. It registers itself.
	assert.equal((await mcp("/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }) })).status, 400);
	const reg = await mcp("/register", { method: "POST", body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }) });
	assert.equal(reg.status, 201);
	const client = (await reg.json()) as any;

	// 3. The person is sent to /authorize, signs in, and clicks Allow.
	const verifier = "v".repeat(20) + "-verifier-that-is-long-enough-for-pkce";
	const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
	const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: challenge, code_challenge_method: "S256", state: "st8", scope: "stats:read", resource: "https://mcp.readercount.com/mcp" });
	assert.equal((await mcp("/authorize?" + q.toString().replace("auth_callback", "evil"))).status, 400, "never redirects to an address it wasn't given");
	const toSignIn = await mcp("/authorize?" + q);
	assert.equal(toSignIn.status, 303);
	const next = new URL(toSignIn.headers.get("Location")!, "https://mcp.readercount.com").searchParams.get("next")!;
	const signed = await form("/signin", { password: "owner-password-long", next });
	assert.equal(signed.headers.get("Location"), "/authorize?" + q);
	const cookie = signed.headers.get("Set-Cookie")!.split(";")[0];
	const consent = await mcp("/authorize?" + q, { headers: { Cookie: cookie } });
	const html = await consent.text();
	assert.ok(html.includes("Let Claude read your stats?"));
	assert.ok(html.includes("myblog.co.uk") && !html.includes("theirs.com"));
	assert.equal(consent.headers.get("X-Frame-Options"), "DENY");
	const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
	assert.equal((await form("/authorize", { ...Object.fromEntries(q), csrf: "wrong", decision: "allow" }, cookie)).status, 403);
	const cancel = await form("/authorize", { ...Object.fromEntries(q), csrf, decision: "deny" }, cookie);
	assert.equal(new URL(cancel.headers.get("Location")!).searchParams.get("error"), "access_denied");
	const allow = await form("/authorize", { ...Object.fromEntries(q), csrf, decision: "allow" }, cookie);
	const back = new URL(allow.headers.get("Location")!);
	assert.equal(back.origin + back.pathname, "https://claude.ai/api/mcp/auth_callback");
	assert.equal(back.searchParams.get("state"), "st8");
	const authCode = back.searchParams.get("code")!;

	// 4. Claude swaps the code for tokens; a wrong verifier or a second use fails.
	const swap = (extra: Record<string, string>) => form("/token", { grant_type: "authorization_code", code: authCode, client_id: client.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", ...extra });
	const tok = (await (await swap({ code_verifier: verifier })).json()) as any;
	assert.equal(tok.token_type, "Bearer");
	assert.equal((await swap({ code_verifier: verifier })).status, 400, "a code works once");

	// 5. With the token it reads this account's sites only.
	const call = async (access: string, method: string, params: unknown = {}) =>
		(await (await mcp("/mcp", { method: "POST", body: rpcBody(method, params), headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" } })).json()) as any;
	assert.deepEqual((await call(tok.access_token, "tools/call", { name: "list_sites", arguments: {} })).result.structuredContent.sites, ["myblog.co.uk"]);
	assert.equal((await call(tok.access_token, "tools/call", { name: "get_overview", arguments: { site: "theirs.com" } })).result.isError, true);
	assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM events WHERE site = 'theirs.com'").get()!.n, 1, "account sites are counted");
	assert.equal((await call(tok.access_token, "tools/call", { name: "get_overview", arguments: { period: "today" } })).result.structuredContent.totals.views, 1);

	// 6. Refresh tokens rotate; the old one stops working.
	const fresh = (await (await form("/token", { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client.client_id })).json()) as any;
	assert.ok(fresh.access_token && fresh.refresh_token !== tok.refresh_token);
	assert.equal((await form("/token", { grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client.client_id })).status, 400);
	assert.ok(!JSON.stringify(sql.prepare("SELECT * FROM oauth_tokens").all()).includes(fresh.access_token), "tokens are stored hashed");

	// 7. The stats page shows Claude as connected; disconnect it there.
	const statsPage = async () => (await worker.fetch(new Request("https://app.readercount.com/", { headers: { Cookie: cookie } }), env)).text();
	assert.match(await statsPage(), /Status: Connected\. Toggle ReaderCount active/);
	const off = await worker.fetch(new Request("https://app.readercount.com/claude/disconnect", { method: "POST", headers: { Cookie: cookie, Origin: "https://app.readercount.com" } }), env);
	assert.equal(off.status, 303);
	assert.equal((await mcp("/mcp", { method: "POST", body: rpcBody("tools/list"), headers: { Authorization: `Bearer ${fresh.access_token}` } })).status, 401);
	const after = await statsPage();
	assert.match(after, /Connect to Claude<\/span><\/a>/);
	assert.match(after, /claude\.ai\/settings\/connectors/);
});

test("\"Check it's working\" finds the code on the home page, or a recent visit", async () => {
	const { db, sql } = fakeD1();
	const env: Env = { DB: db, SITES: "", APP_HOST: "app.readercount.com" };
	const now = Date.parse("2026-10-13T21:00:00Z");
	const page = (html: string) => (async () => new Response(html)) as unknown as typeof fetch;
	const snippet = '<head><script defer src="https://app.readercount.com/s.js" data-site="myblog.com"></script></head>';
	assert.equal((await checkSite(env, "myblog.com", now, page(snippet))).ok, true);
	assert.equal((await checkSite(env, "myblog.com", now, page(snippet.replace("myblog.com\"", "other.com\"")))).ok, false, "another site's code doesn't count");
	const missing = await checkSite(env, "myblog.com", now, page("<head></head>"));
	assert.equal(missing.ok, false);
	assert.match(missing.message, /can't see the code/);
	const down = await checkSite(env, "myblog.com", now, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
	assert.match(down.message, /couldn't open/);
	sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, path) VALUES (?, ?, ?, 'view', 'v', '/')").run("myblog.com", now - 5 * 60_000, "2026-10-13");
	const seen = await checkSite(env, "myblog.com", now, page(""));
	assert.equal(seen.ok, true);
	assert.match(seen.message, /5 minutes ago/);
	assert.equal(await lastVisit(db, "myblog.com", now + 2 * 86_400_000), null, "a visit two days ago is too old");
});

test("downloads keep spreadsheet apps from running page paths as formulas", () => {
	const r = sampleReport("7d", Date.UTC(2026, 9, 13));
	r.pages = [{ path: "=HYPERLINK(\"x\")", views: 1, visitors: 1, secs: 0 }];
	const csv = toCsv(r);
	assert.ok(csv.startsWith("\uFEFF"), "Excel reads it as UTF-8");
	assert.ok(csv.includes(`"'=HYPERLINK(""x"")",1,1,0`));
});

test("\"What to fix\" flags posts slipping in Google, rarely clicked, nearly on page 1, or losing visitors", async () => {
	const { db, sql } = fakeD1();
	const now = Date.UTC(2026, 9, 13, 12);
	const day = (ago: number) => new Date(now - ago * 86_400_000).toISOString().slice(0, 10);
	const ev = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, path) VALUES ('b.com', 0, ?, 'view', ?, ?)");
	// /old/: 60 visitors in the 4 weeks before, 10 in the last 4. /steady/: the same both times.
	for (let i = 0; i < 60; i++) ev.run(day(30 + (i % 20)), "a" + i, "/old/");
	for (let i = 0; i < 10; i++) ev.run(day(2 + i), "b" + i, "/old/");
	for (let i = 0; i < 40; i++) ev.run(day(30 + (i % 20)), "c" + i, "/steady/"), ev.run(day(2 + (i % 20)), "d" + i, "/steady/");
	const s = sql.prepare("INSERT INTO search (site, day, query, page, clicks, impressions, position) VALUES ('b.com', ?, ?, ?, ?, ?, ?)");
	s.run(day(40), "phones", "/phones/", 100, 1000, 3), s.run(day(10), "phones", "/phones/", 30, 900, 7.5); // slipping
	s.run(day(10), "vpn", "/vpn/", 4, 2000, 2); // top of Google, hardly clicked
	s.run(day(10), "best kettle", "/kettles/", 3, 500, 12); // page 2
	s.run(day(10), "fine", "/fine/", 300, 1000, 1.5); // nothing wrong
	const fixes = await findFixes(db, "b.com", now);
	const by = Object.fromEntries(fixes.map((f) => [f.page, f.kind]));
	assert.deepEqual(by, { "/phones/": "slipping", "/vpn/": "few-clicks", "/kettles/": "page-two", "/old/": "losing" });
	assert.ok(fixes.find((f) => f.page === "/old/")!.what.startsWith("Visitors fell 83%"));
	const page = renderDashboard(sampleReport("30d", now), ["b.com"], { fixes });
	assert.ok(page.includes("What to fix this week") && page.includes("Nearly on page one") && page.includes("What to do"));
	assert.ok(renderDashboard(sampleReport("30d", now), ["b.com"], { fixes: [] }).includes("Nothing needs fixing right now"));
});

test("the Monday email goes only to people who ticked it, once per day, with each website's week and what to fix", async () => {
	const { db, sql } = fakeD1();
	const sent: { to: string; subject: string; text: string; html?: string }[] = [];
	const now = Date.UTC(2026, 9, 12, 7);
	sql.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('a1', 'yes@example.com', 1), ('a2', 'no@example.com', 1)").run();
	sql.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES ('b.com', 'a1', 1), ('c.com', 'a2', 1)").run();
	await setDigest(db, "a1", true);
	const day = (ago: number) => new Date(now - ago * 86_400_000).toISOString().slice(0, 10);
	const ev = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, path) VALUES ('b.com', 0, ?, 'view', ?, ?)");
	for (let i = 0; i < 60; i++) ev.run(day(30 + (i % 20)), "a" + i, "/old/");
	for (let i = 0; i < 12; i++) ev.run(day(1 + (i % 6)), "b" + i, "/old/");
	const env = { DB: db, APP_HOST: "app.readercount.com", EMAIL: { send: async (m: any) => void sent.push(m) } };
	assert.equal(await sendDigests(env, now), 1);
	assert.equal(await sendDigests(env, now + 60_000), 0, "a retried cron doesn't send twice");
	assert.equal(sent[0].to, "yes@example.com");
	assert.equal(sent[0].subject, "b.com had 12 visitors last week · 1 thing to fix");
	assert.ok(sent[0].text.includes("B.COM\n12 visitors and 12 page views") && sent[0].text.includes("https://b.com/old/") && sent[0].text.includes('"Weekly Optimisation Digest" is switched on'));
	assert.ok(sent[0].text.includes("Top pages:\n- /old/: 12") && sent[0].text.includes("Top sources:\n- Direct: 12"));
	const html = (sent[0] as { html?: string }).html ?? "";
	assert.ok(html.includes('Reader<span style="color:#2f6fed">Count</span>') && html.includes(">12</div>") && html.includes("What to do:"), "the HTML version has the brand, the big number and the fixes");
	assert.ok(html.includes("https://app.readercount.com/?site=b.com&amp;range=7d") || html.includes("https://app.readercount.com/?site=b.com&range=7d"));
	assert.ok(!html.includes("View all your stats"), "one website, no overview link");
});

test("the Monday email shows the 5 busiest websites, then one line and a link for the rest", async () => {
	const { db, sql } = fakeD1();
	const sent: { subject: string; text: string; html?: string }[] = [];
	const now = Date.UTC(2026, 9, 12, 7);
	sql.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('a1', 'yes@example.com', 1)").run();
	const day = new Date(now - 2 * 86_400_000).toISOString().slice(0, 10);
	const ev = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, path) VALUES (?, 0, ?, 'view', ?, '/')");
	for (let s = 1; s <= 7; s++) {
		sql.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES (?, 'a1', 1)").run(`s${s}.com`);
		for (let i = 0; i < s; i++) ev.run(`s${s}.com`, day, "v" + i);
	}
	await setDigest(db, "a1", true);
	await sendDigests({ DB: db, APP_HOST: "app.readercount.com", EMAIL: { send: async (m: any) => void sent.push(m) } }, now);
	const html = sent[0].html ?? "";
	assert.ok(html.includes(">s7.com</a>") && html.includes(">s3.com</a>") && !html.includes(">s2.com</a>") && !html.includes(">s1.com</a>"), "only the 5 busiest get a card");
	assert.ok(html.includes("Plus 2 more websites with 3 visitors between them.") && html.includes("View all your stats"));
	assert.equal(sent[0].subject, "Your 7 websites had 28 visitors last week");
	assert.ok(sent[0].text.includes("See all your stats: https://app.readercount.com/"));
});

test("public stats: off until the owner switches it on, never shows \"What to fix\", and links back to ReaderCount", async () => {
	const { db, sql } = fakeD1();
	const env: Env = { DB: db, SITES: "x.com", APP_HOST: "app.readercount.com", MCP_HOST: "mcp.readercount.com" };
	sql.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('owner', 'p@example.com', 1)").run();
	sql.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES ('b.com', 'owner', 1)").run();
	sql.prepare("INSERT INTO sessions (token_hash, account_id, expires) VALUES (?, 'owner', 9e15)").run(await sha256("tok"));
	const app = (path: string, init: RequestInit = {}) => worker.fetch(new Request("https://app.readercount.com" + path, { redirect: "manual", ...init }), env);
	const share = (form: Record<string, string>) => app("/share", { method: "POST", body: new URLSearchParams(form), headers: { Cookie: "rc_account=tok", Origin: "https://app.readercount.com", "Content-Type": "application/x-www-form-urlencoded" } });

	assert.equal((await app("/share/b.com")).status, 404, "private by default");
	const page = await (await app("/?site=b.com", { headers: { Cookie: "rc_account=tok" } })).text();
	assert.ok(page.includes("Public Metrics Page") && page.includes("Enable public metrics page"));
	assert.ok(page.includes("What's new in ReaderCount") && page.includes("https://github.com/pobren/readercount/releases/tag/"), "the What's new box links to the release notes");
	assert.ok(page.includes('id="emails"') && page.includes('action="/digest"') && page.includes('action="/spikes"'), "the emails sit together under Emails");
	assert.ok(page.includes('class="tip"') && page.includes("data-tip="), "settings explain themselves");
	// The owner switches it on: no proof needed, as nobody else can add websites here.
	assert.equal((await share({ site: "b.com", public: "on" })).headers.get("Location"), "/?site=b.com&share=on#share");
	const pub = await app("/share/b.com");
	assert.equal(pub.status, 200);
	const html = await pub.text();
	assert.ok(html.includes("Public analytics dashboard for <code>b.com</code>") && html.includes("Powered by <a href=\"https://paulobrien.dev/readercount/\"><b>Reader<span class=\"rc-c\">Count</span></b></a>"));
	assert.ok(!html.includes('class="card news"') && !html.includes("What to fix this week") && !html.includes("Account Management") && !html.includes("Query Analytics via Claude") && !html.includes("Data Export Modules"));
	const settings = await (await app("/?site=b.com", { headers: { Cookie: "rc_account=tok" } })).text();
	assert.ok(settings.includes("https://app.readercount.com/share/b.com") && settings.includes("counted by &#60;a href=&#34;https://paulobrien.dev/readercount/&#34;&#62;ReaderCount&#60;/a&#62;"));
	assert.equal((await share({ site: "other.com", public: "on" })).status, 404, "only your own websites");
	// The media kit: on the public page for anyone, and on the owner's stats page.
	assert.ok(html.includes('href="/share/b.com/media-kit.pdf"') && settings.includes('href="/media-kit?site=b.com"'));
	const kit = await app("/share/b.com/media-kit.pdf");
	assert.equal(kit.status, 200);
	assert.equal(kit.headers.get("Content-Type"), "application/pdf");
	const pdf = Buffer.from(await kit.arrayBuffer()).toString("latin1");
	assert.ok(pdf.startsWith("%PDF-1.4") && pdf.includes("(b.com) Tj") && pdf.includes("/URI (https://app.readercount.com/share/b.com)"), "a PDF with a link to the live page");
	assert.equal((await app("/media-kit?site=other.com", { headers: { Cookie: "rc_account=tok" } })).status, 404, "only your own websites");
	await share({ site: "b.com" });
	assert.equal((await app("/share/b.com")).status, 404, "switching off stops the link straight away");
	assert.equal((await app("/share/b.com/media-kit.pdf")).status, 404, "and the public media kit");
	const own = await app("/media-kit?site=b.com", { headers: { Cookie: "rc_account=tok" } });
	assert.equal(own.status, 200, "the owner can still download it");
	assert.ok(!Buffer.from(await own.arrayBuffer()).toString("latin1").includes("/URI"), "without a link to a page that's switched off");
});

test("Found by AI: visits from AI services, their pages and trend, with ChatGPT's own tag counted as ChatGPT", async () => {
	const { db, sql } = fakeD1();
	const env: Env = { DB: db, SITES: "paulobrien.com" };
	await addSites(db, "paulobrien.com");
	const t = Date.UTC(2026, 9, 20, 10);
	assert.equal(sourceName("perplexity.ai"), "Perplexity");
	assert.equal(sourceName("copilot.microsoft.com"), "Copilot");
	assert.equal(sourceName("chat.deepseek.com"), "DeepSeek");
	await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/vpn/?utm_source=chatgpt.com", v: "ai1" }), env, t);
	await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/vpn/", r: "https://chatgpt.com/", v: "ai2" }, MAC_CHROME, "198.51.100.9"), env, t + 1000);
	await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/mail/", r: "https://www.perplexity.ai/search?q=x", v: "ai3" }, WIN_EDGE, "198.51.100.10"), env, t + 2000);
	await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/mail/", r: "https://www.google.com/", v: "ai4" }, ANDROID_TAB, "198.51.100.11"), env, t + 3000);
	// Older rows stored ChatGPT's tag as it came.
	sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, view_id, path, source) VALUES ('paulobrien.com', ?, '2026-10-19', 'view', 'old1', 'o1', '/vpn/', 'chatgpt.com')").run(t - 86_400_000);
	const sources = sql.prepare("SELECT source FROM events WHERE day = '2026-10-20' ORDER BY id").all().map((r) => (r as { source: string }).source);
	assert.deepEqual(sources, ["ChatGPT", "ChatGPT", "Perplexity", "Google"]);
	const r = await buildReport(db, "paulobrien.com", "7d", t + 10_000);
	assert.equal(r.ai?.visitors, 4);
	assert.deepEqual(r.ai?.services, [{ name: "ChatGPT", visitors: 3 }, { name: "Perplexity", visitors: 1 }]);
	assert.deepEqual(r.ai?.pages[0], { path: "/vpn/", visitors: 3 });
	assert.deepEqual(r.ai?.days.slice(-2), [{ day: "2026-10-19", visitors: 1 }, { day: "2026-10-20", visitors: 3 }]);
	const html = renderDashboard(r, ["paulobrien.com"]);
	assert.ok(html.includes("<h2>Found by AI</h2>") && html.includes("from AI services") && html.includes("Pages they were sent to") === false);
	assert.ok(html.includes("Page they were sent to") && html.includes("80% of all visitors"));
	const none = renderDashboard(await buildReport(db, "paulobrien.com", "today", Date.UTC(2026, 9, 25, 10)), ["paulobrien.com"], { shared: true });
	assert.ok(!none.includes("Found by AI"), "public pages leave the card out when there's nothing in it");
});

test("the media kit is a well-formed one-page PDF", async () => {
	const { mediaKitPdf } = await import("../src/mediakit.ts");
	const bytes = mediaKitPdf({
		site: "café.example",
		from: "2026-09-22",
		to: "2026-10-21",
		visitors: 12_345,
		views: 23_456,
		avgSeconds: 95,
		months: [{ month: "2025-12", visitors: 900 }, { month: "2026-01", visitors: 1200 }],
		countries: [{ code: "GB", visitors: 8000 }],
		devices: [{ name: "mobile", visitors: 7000 }],
		sources: [{ name: "Google", visitors: 6000 }],
		pages: [{ name: "A (very) long title with a back\\slash and an emoji 🎉 that keeps going on and on and on until it has to be cut short", visitors: 400 }],
		verified: true,
		made: "2026-10-21",
	});
	const pdf = Buffer.from(bytes).toString("latin1");
	assert.ok(pdf.startsWith("%PDF-1.4") && pdf.endsWith("%%EOF\n") && pdf.includes("/Count 1"));
	assert.ok(pdf.includes("(caf\\351.example) Tj"), "accents in WinAnsi");
	assert.ok(pdf.includes("\\(very\\)") && pdf.includes("\\205) Tj"), "brackets escaped, long names cut with an ellipsis");
	// Every object sits where the cross-reference table says it does.
	const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
	const offsets = pdf.slice(xref).split("\n").slice(3).filter((l) => / 00000 n $/.test(l)).map((l) => Number(l.slice(0, 10)));
	offsets.forEach((o, i) => assert.ok(pdf.startsWith(`${i + 1} 0 obj`, o), `object ${i + 1}`));
	const len = Number(/\/Length (\d+) >>\nstream\n/.exec(pdf)![1]);
	assert.ok(pdf.slice(pdf.indexOf("stream\n") + 7 + len).startsWith("\nendstream"), "stream length is right");
});

test("older stats: reads Google Analytics and other downloads, in any common date style", async () => {
	const { parseHistory } = await import("../src/history.ts");
	const now = Date.parse("2026-10-14T08:00:00Z");
	const ga4 = `# ----------------------------------------\r\n# Free form 1\r\n# Start date: 20260101\r\n# End date: 20260103\r\n# ----------------------------------------\r\nDate,Total users,Views\r\n20260101,120,"1,340"\r\n20260102,98,201\r\n20260103,101,190\r\nGrand total,319,"1,731"\r\n`;
	assert.deepEqual(parseHistory(ga4, now), { days: [{ day: "2026-01-01", visitors: 120, views: 1340 }, { day: "2026-01-02", visitors: 98, views: 201 }, { day: "2026-01-03", visitors: 101, views: 190 }] });
	const nth = `# Start date: 20251230\n# End date: 20260101\n\nNth day,Active users\n0000,5\n0001,6\n0002,7\n`;
	assert.deepEqual(parseHistory(nth, now), { days: [{ day: "2025-12-30", visitors: 5, views: 0 }, { day: "2025-12-31", visitors: 6, views: 0 }, { day: "2026-01-01", visitors: 7, views: 0 }] });
	const uk = parseHistory("date;visitors;pageviews\n02/01/2026;10;20\n13/01/2026;11;22\n", now);
	assert.deepEqual("days" in uk && uk.days.map((d) => d.day), ["2026-01-02", "2026-01-13"], "day first, UK style");
	const us = parseHistory("Day,Users\n1/13/2026,4\n1/2/2026,3\n", now);
	assert.deepEqual("days" in us && us.days.map((d) => d.day), ["2026-01-02", "2026-01-13"], "month first when the file shows it");
	assert.deepEqual(parseHistory("Date\tVisitors\n2026-10-13\t9\n2026-10-20\t9\n", now), { days: [{ day: "2026-10-13", visitors: 9, views: 0 }] }, "tabs work, and future days are dropped");
	assert.match(String((parseHistory("Page,Views\n/a,3\n", now) as { error: string }).error), /column of dates/);
	assert.match(String((parseHistory("Date,Sessions\n20260101,3\n", now) as { error: string }).error), /no column of users/);
});

test("older stats and chart notes: bring in a file, fill only the days before counting began, and pin notes to days", async () => {
	const { db, sql } = fakeD1();
	const env: Env = { DB: db, SITES: "x.com", APP_HOST: "app.readercount.com", MCP_HOST: "mcp.readercount.com" };
	await addSites(db, "x.com");
	sql.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('owner', 'p@example.com', 1)").run();
	sql.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES ('b.com', 'owner', 1)").run();
	sql.prepare("INSERT INTO sessions (token_hash, account_id, expires) VALUES (?, 'owner', 9e15)").run(await sha256("tok"));
	const today = new Date().toISOString().slice(0, 10);
	const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
	// ReaderCount started counting 2 days ago.
	for (const day of [daysAgo(2), daysAgo(1)]) sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, path) VALUES ('b.com', 1, ?, 'view', 'v', '/')").run(day);
	const headers = { Cookie: "rc_account=tok", Origin: "https://app.readercount.com" };
	const app = (path: string, init: RequestInit = {}) => worker.fetch(new Request("https://app.readercount.com" + path, { redirect: "manual", ...init }), env);
	const upload = (site: string, text: string) => {
		const form = new FormData();
		form.set("site", site);
		form.set("file", new File([text], "ga.csv", { type: "text/csv" }));
		return app("/history", { method: "POST", body: form, headers });
	};
	const csv = ["Date,Total users,Views", ...[5, 4, 3, 2, 1].map((n) => `${daysAgo(n).replace(/-/g, "")},100,150`)].join("\n");

	assert.equal((await upload("other.com", csv)).status, 404, "only your own websites");
	const done = await upload("b.com", csv);
	assert.equal(done.headers.get("Location"), "/?site=b.com&range=12m&history=5#history");
	const page = await (await app("/?site=b.com&range=7d", { headers })).text();
	assert.equal((page.match(/<line class="pt imp"/g) ?? []).length, 3, "the two days ReaderCount counted aren't doubled");
	assert.ok(page.includes("Faded dots come from your older stats"));
	assert.match(page, /<div class="k">Unique Visitors<\/div><div class="v">302</, "100 x 3 imported + 1 a day counted");
	assert.ok(page.includes("You've imported <b>5 days</b>"));
	assert.equal((await upload("b.com", "nothing useful")).status, 400);

	const note = (form: Record<string, string>, path = "/notes") => app(path, { method: "POST", body: new URLSearchParams(form), headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" } });
	assert.equal((await note({ site: "b.com", range: "7d", day: today, text: "  Posted on   Reddit " })).headers.get("Location"), "/?site=b.com&range=7d#chart");
	assert.equal((await note({ site: "b.com", day: "2999-01-01", text: "From the future" })).status, 400);
	assert.equal((await note({ site: "b.com", day: today, text: "x".repeat(141) })).status, 400);
	assert.equal((await note({ site: "other.com", day: today, text: "Not mine" })).status, 404);
	const withNote = await (await app("/?site=b.com&range=7d", { headers })).text();
	assert.ok(withNote.includes('<span class="nt-text">Posted on Reddit</span>') && withNote.includes('<g class="nt">'));

	sql.prepare("UPDATE sites SET public = 1 WHERE domain = 'b.com'").run();
	const pub = await (await app("/share/b.com")).text();
	assert.ok(!pub.includes("Posted on Reddit") && !pub.includes("Add timeline annotation"), "notes stay private");

	const id = (sql.prepare("SELECT id FROM notes").get() as { id: number }).id;
	await note({ site: "b.com", id: String(id) }, "/notes/remove");
	assert.equal((sql.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n, 0);
	await app("/history/remove", { method: "POST", body: new URLSearchParams({ site: "b.com" }), headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" } });
	assert.ok(!(await (await app("/?site=b.com&range=7d", { headers })).text()).includes('class="day imp"'));
});

test("security: wrong-website hits, password-guessing floods, per-IP limits and odd addresses", async () => {
	const { db, sql } = fakeD1();
	const sent: { text: string }[] = [];
	const env: Env = { DB: db, SITES: "paulobrien.com", ADMIN_PASSWORD: "the-right-password", EMAIL: { send: async (m) => void sent.push(m) } };
	await addSites(db, "paulobrien.com");
	const views = () => (sql.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

	// Hits: another website's page can't count visits for this one; "null" (a page hiding where it is) is let through.
	const withOrigin = (origin: string) => {
		const r = hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/", v: "or" + views() });
		r.headers.set("Origin", origin);
		return r;
	};
	assert.equal(await record(withOrigin("https://evil.example"), env, Date.now()), "wrong origin");
	assert.equal(await record(withOrigin("not a url"), env, Date.now()), "wrong origin");
	assert.equal(await record(withOrigin("https://www.paulobrien.com"), env, Date.now()), "view");
	assert.equal(await record(withOrigin("null"), env, Date.now()), "view");
	assert.equal(views(), 2);

	// Over the per-IP limit, hits are dropped quietly (still a 202).
	let allowed = 0;
	env.COLLECT_LIMIT = { limit: async () => ({ success: allowed-- > 0 }) };
	const e = await worker.fetch(new Request("https://paulobrien.readercount.com/e", { method: "POST", body: JSON.stringify({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/x", v: "lim1" }), headers: { "User-Agent": IPHONE, "CF-Connecting-IP": "203.0.113.9" } }), env);
	assert.equal(e.status, 202);
	assert.equal(views(), 2, "nothing stored over the limit");
	delete env.COLLECT_LIMIT;

	// Passwords: wrong ones are refused, and after 20 wrong tries in an hour (from anywhere) even the right one waits.
	const app = (path: string, init: RequestInit = {}) => worker.fetch(new Request("https://app.readercount.com" + path, { redirect: "manual", ...init }), env);
	const post = (form: Record<string, string>) => app("/signin", { method: "POST", body: new URLSearchParams({ next: "/", ...form }), headers: { Origin: "https://app.readercount.com", "Content-Type": "application/x-www-form-urlencoded" } });
	assert.equal((await post({ password: "the-right-password", next: "https://evil.example/" })).headers.get("Location"), "/", "never sends you to another website");
	assert.equal((await post({ password: "wrong" })).status, 400);
	await Promise.all(Array.from({ length: 25 }, () => post({ password: "wrong" })));
	assert.equal((await post({ password: "the-right-password" })).status, 400, "after too many wrong tries even the right password waits");
	sql.prepare("DELETE FROM sign_in_fails").run();
	assert.equal((await post({ password: "the-right-password" })).status, 303);
	// A missing, short or example password means nobody can sign in, and the page says how to set one.
	for (const pw of [undefined, "short", "change-me-to-something-long"]) {
		const res = await worker.fetch(new Request("https://app.readercount.com/signin"), { ...env, ADMIN_PASSWORD: pw });
		assert.equal(res.status, 503);
		assert.ok((await res.text()).includes("ADMIN_PASSWORD"));
	}
	assert.equal((await app("/signin", { method: "POST", body: new URLSearchParams({ password: "evil" }), headers: { Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" } })).status, 403, "no sign-in from other websites");

	// Per-IP limit on the sign-in form and on Claude app registration.
	env.FORM_LIMIT = { limit: async () => ({ success: false }) };
	assert.equal((await post({ password: "the-right-password" })).status, 429);
	const reg = await worker.fetch(new Request("https://app.readercount.com/register", { method: "POST", body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }) }), env);
	assert.equal(reg.status, 429);
	delete env.FORM_LIMIT;

	// Pages can't be framed by other websites; public stats pages can. A broken /share/ address is a 404, not a crash.
	assert.equal((await app("/signin")).headers.get("Content-Security-Policy"), "frame-ancestors 'none'");
	assert.equal((await app("/share/%")).status, 404);
	forgetCountedSites();
});

test("API keys: made on the stats page, shown once, read one website with a header, limited per minute, and deleted straight away", async () => {
	const { db, sql } = fakeD1();
	const env: Env = { DB: db, SITES: "x.com", APP_HOST: "app.readercount.com", MCP_HOST: "mcp.readercount.com", API_HOST: "api.readercount.com" };
	await addSites(db, "x.com");
	sql.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('owner', 'p@example.com', 1), ('a2', 'q@example.com', 1)").run();
	sql.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES ('b.com', 'owner', 1), ('c.com', 'a2', 1)").run();
	sql.prepare("INSERT INTO sessions (token_hash, account_id, expires) VALUES (?, 'owner', 9e15)").run(await sha256("tok"));
	const app = (path: string, init: RequestInit = {}) => worker.fetch(new Request("https://app.readercount.com" + path, { redirect: "manual", ...init }), env);
	const post = (path: string, form: Record<string, string>, origin = "https://app.readercount.com") =>
		app(path, { method: "POST", body: new URLSearchParams(form), headers: { Cookie: "rc_account=tok", Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } });
	const api = (path: string, headers: Record<string, string> = {}, method = "GET") => worker.fetch(new Request("https://app.readercount.com/api" + path, { method, headers }), env);

	const page = await (await app("/?site=b.com", { headers: { Cookie: "rc_account=tok" } })).text();
	assert.ok(page.includes("API Keys") && page.includes('action="/api-keys"') && page.includes("https://github.com/pobren/readercount#api"));
	assert.equal((await post("/api-keys", { site: "c.com", name: "x" })).status, 404, "only your own websites");
	assert.equal((await post("/api-keys", { site: "b.com", name: "x" }, "https://evil.example")).status, 403);

	const made = await post("/api-keys", { site: "b.com", name: "  My   website " });
	assert.equal(made.status, 200);
	const shown = await made.text();
	const key = /value="(rc_[\w-]+)"/.exec(shown)![1];
	assert.ok(shown.includes("<b>My website</b>") && shown.includes("won't be able to see it again"));
	assert.equal(made.headers.get("Referrer-Policy"), "no-referrer");
	assert.ok(!JSON.stringify(sql.prepare("SELECT * FROM api_keys").all()).includes(key), "only a hash of the key is kept");
	const listed = await (await app("/?site=b.com", { headers: { Cookie: "rc_account=tok" } })).text();
	assert.ok(listed.includes("My website") && listed.includes(key.slice(0, 8) + "…") && !listed.includes(key), "the stats page never shows the key again");

	await record(hitRequest({ k: "v", s: "b.com", u: "https://b.com/hello/", r: "https://www.reddit.com/", v: "api1" }), env, Date.now());
	await record(hitRequest({ k: "v", s: "c.com", u: "https://c.com/", v: "api2" }), env, Date.now());

	assert.equal((await api("/v1/overview")).status, 401, "a key is needed");
	assert.equal((await api("/v1/overview", { Authorization: "Bearer rc_wrong" })).status, 401);
	assert.equal((await api("/v1/overview?key=" + key)).status, 400, "not in the address");
	assert.equal((await api("/v1/overview", { Authorization: `Bearer ${key}` }, "POST")).status, 405);
	const ov = await api("/v1/overview?period=7d", { Authorization: `Bearer ${key}` });
	assert.equal(ov.status, 200);
	assert.equal(ov.headers.get("Access-Control-Allow-Origin"), null, "no CORS: keys belong on a server");
	assert.equal(ov.headers.get("X-RateLimit-Remaining"), "59");
	const data = (await ov.json()) as { site: string; totals: { views: number }; top_pages: { page: string }[] };
	assert.equal(data.site, "b.com");
	assert.equal(data.totals.views, 1);
	assert.equal(data.top_pages[0].page, "/hello/");
	const br = (await (await api("/v1/breakdown?by=source", { "X-API-Key": key })).json()) as { rows: { source: string }[] };
	assert.equal(br.rows[0].source, "Reddit", "X-API-Key works too");
	const other = await api("/v1/overview?site=c.com", { Authorization: `Bearer ${key}` });
	assert.equal(other.status, 400, "a key reads its own website only");
	assert.ok(!JSON.stringify(await other.json()).includes("views"));
	assert.equal((await api("/v1/google-searches", { Authorization: `Bearer ${key}` })).status, 400, "Google not connected is a clear message");
	assert.equal((await api("/v1/nothing", { Authorization: `Bearer ${key}` })).status, 404);
	assert.ok(sql.prepare("SELECT last_used FROM api_keys").get()!.last_used, "the stats page shows when a key was last used");

	sql.prepare("UPDATE api_keys SET window_count = 60, window_start = ?").run(Math.floor(Date.now() / 60_000) * 60_000);
	const slow = await api("/v1/overview", { Authorization: `Bearer ${key}` });
	assert.equal(slow.status, 429);
	assert.ok(Number(slow.headers.get("Retry-After")) >= 1);

	const id = String(sql.prepare("SELECT id FROM api_keys").get()!.id);
	assert.equal((await post("/api-keys/delete", { site: "b.com", id })).headers.get("Location"), "/?site=b.com&api=deleted#api");
	sql.prepare("UPDATE api_keys SET window_count = 0").run();
	assert.equal((await api("/v1/overview", { Authorization: `Bearer ${key}` })).status, 401, "a deleted key stops working straight away");
});

test("today's chart: one point per hour with its figure, newsletter visits named and campaigns read as post names", async () => {
	const { db, sql } = fakeD1();
	const now = Date.parse("2026-10-23T13:40:00Z");
	const ins = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, view_id, path, source, utm_medium, utm_campaign, country, device, browser, duration) VALUES ('b.com', ?, ?, 'view', ?, ?, '/proton-mail-free-plan/', ?, ?, ?, 'GB', 'desktop', 'Safari', 30)");
	ins.run(Date.parse("2026-10-23T09:10:00Z"), "2026-10-23", "a", "v1", "Google", "", "");
	ins.run(Date.parse("2026-10-23T09:20:00Z"), "2026-10-23", "a", "v2", "Google", "", "");
	ins.run(Date.parse("2026-10-23T13:05:00Z"), "2026-10-23", "b", "v3", "newsletter", "email", "proton-mail-free-plan");
	ins.run(Date.parse("2026-10-22T09:30:00Z"), "2026-10-22", "c", "v4", "", "", "");

	const r = await buildReport(db, "b.com", "today", now);
	assert.equal(r.hours?.length, 14, "midnight to the current hour");
	assert.deepEqual([r.hours?.[9].visitors, r.hours?.[9].views, r.hours?.[13].visitors], [1, 2, 1]);
	assert.equal(r.prevHours?.[9].visitors, 1, "the same hour yesterday");
	assert.equal(r.hours?.[9].bounce, 0);
	assert.equal(r.hours?.[13].bounce, 100);

	const html = renderDashboard(r, ["b.com"]);
	assert.ok(html.includes("Hourly Visitor Trend"));
	assert.ok(html.includes("times in UTC"));
	assert.match(html, /<span class="vl[^"]*"[^>]*>1<\/span>/, "each point shows its figure");
	assert.ok(html.includes("09:00 to 09:59 (UTC)"));
	assert.ok(html.includes(">Newsletter<small>Links in your emails</small>"), "the newsletter source is easy to spot");
	assert.ok(html.includes('href="?site=b.com&amp;range=today&amp;source=newsletter"'), "and still filters by its tag");
	assert.ok(html.includes(">Proton mail free plan<small>proton-mail-free-plan</small>"), "a campaign named after a post reads as its name");

	assert.ok(html.includes("1 visitor by this time yesterday"), "small numbers show yesterday's figure, not a percentage");
	assert.ok(!html.includes("No visitors yet today"));

	// Early in the UTC day with nothing yet: say so plainly, not "-100%".
	const early = await buildReport(db, "b.com", "today", Date.parse("2026-10-24T09:25:00Z"));
	const earlyHtml = renderDashboard(early, ["b.com"]);
	assert.ok(earlyHtml.includes("1 visitor by this time yesterday"));
	assert.ok(!earlyHtml.includes("-100% vs"));
	assert.ok(earlyHtml.includes("No visitors yet today. The day starts at midnight UTC"));

	const week = await buildReport(db, "b.com", "7d", now);
	assert.equal(week.hours, undefined, "longer ranges stay daily");
	assert.ok(renderDashboard(week, ["b.com"]).includes("Daily Visitor Trend"));
});

test("stats page: filters, entry and exit pages, clicks by website, and the chart's metric", async () => {
	const { db, sql } = fakeD1();
	const now = Date.parse("2026-10-17T12:00:00Z");
	const ins = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, view_id, path, target, source, country, device, browser, duration) VALUES ('b.com', ?, '2026-10-17', ?, ?, ?, ?, ?, ?, 'GB', ?, 'Safari', 30)");
	// One reader from Google reads two pages; one direct reader reads one and clicks two Amazon links and a Fastmail one.
	ins.run(now - 3000, "view", "a", "v1", "/first/", null, "Google", "mobile");
	ins.run(now - 2000, "view", "a", "v2", "/second/", null, "Google", "mobile");
	ins.run(now - 1000, "view", "b", "v3", "/fastmail-review/", null, "", "desktop");
	ins.run(now, "outbound", "b", "v3", "/fastmail-review/", "https://join.fastmail.com/abc123", "", "desktop");
	ins.run(now, "outbound", "b", "v3", "/fastmail-review/", "https://www.amazon.co.uk/dp/X?tag=me-21", "", "desktop");
	ins.run(now, "outbound", "b", "v3", "/fastmail-review/", "https://amzn.to/abc", "", "desktop");

	const all = await buildReport(db, "b.com", "7d", now);
	assert.equal(all.totals.clicks, 3);
	assert.deepEqual(all.entries?.map((p) => p.path).sort(), ["/fastmail-review/", "/first/"]);
	assert.deepEqual(all.exits?.map((p) => p.path).sort(), ["/fastmail-review/", "/second/"]);
	assert.equal(all.pages.find((p) => p.path === "/fastmail-review/")?.clicks, 3);
	assert.equal(all.days.at(-1)?.clicks, 3);

	const google = await buildReport(db, "b.com", "7d", now, false, readView(new URL("https://x/?source=Google")).filters);
	assert.equal(google.totals.views, 2);
	assert.equal(google.totals.clicks, 0, "clicks follow the reader's source");
	const direct = await buildReport(db, "b.com", "7d", now, false, { source: "Direct" });
	assert.equal(direct.totals.clicks, 3);

	const page = renderDashboard(google, ["b.com"], { metric: "views" });
	assert.ok(page.includes("Daily Page View Trend"));
	assert.match(page, /class="chip" href="\?site=b\.com&amp;range=7d&amp;metric=views"/, "the chip removes its filter and keeps the rest");
	assert.ok(renderDashboard(all, ["b.com"]).includes('href="?site=b.com&amp;range=7d&amp;source=Google"'), "a source row filters to it");
	const sites = renderDashboard(all, ["b.com"]);
	assert.match(sites, /Amazon<span class="tag"[^>]*>Affiliate<\/span><small>from “Fastmail review”<\/small>/);
	assert.ok(!renderDashboard(all, ["b.com"], { demo: true }).includes("source=Google"), "the demo's made-up numbers can't be filtered");
	assert.equal(readView(new URL("https://x/?metric=nonsense")).metric, "visitors");
});

test("page names and link websites", () => {
	assert.equal(pageName("/"), "Home page");
	assert.equal(pageName("/gmail-vs-proton-mail-why-i-made-the-switch/"), "Gmail vs proton mail why I made the switch");
	assert.equal(pageName("/files/report.pdf?x=1"), "Report.pdf");
	assert.deepEqual(linkSite("https://www.amazon.co.uk/dp/X?tag=me-21"), { key: "Amazon", name: "Amazon", affiliate: true });
	assert.deepEqual(linkSite("https://www.awin1.com/cread.php?awinmid=1&p=https%3A%2F%2Fproton.me%2Fmail"), { key: "Proton", name: "Proton", affiliate: true });
	assert.deepEqual(linkSite("https://www.ispreview.co.uk/news.html"), { key: "ispreview.co.uk", name: "ispreview.co.uk", affiliate: false });
});

test("fake hits: no web page, cloud servers, clicks without a view and one visitor sending too much are left out and counted", async () => {
	const { db, sql } = fakeD1();
	const env: Env = { DB: db, SITES: "paulobrien.com" };
	await addSites(db, "paulobrien.com");
	const now = Date.UTC(2026, 9, 18, 9);
	const day = "2026-10-18";
	const stored = () => (sql.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
	const left = (reason: string) => (sql.prepare("SELECT n FROM filtered WHERE site = 'paulobrien.com' AND day = ? AND reason = ?").get(day, reason) as { n: number } | undefined)?.n ?? 0;

	const bare = hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/", v: "fake1" });
	bare.headers.delete("Origin");
	assert.equal(await record(bare, env, now), "no origin", "a script that doesn't say where it came from");

	const cloud = hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/", v: "fake2" });
	Object.defineProperty(cloud, "cf", { value: { asn: 16509, country: "US" } });
	assert.equal(await record(cloud, env, now), "cloud", "Amazon Web Services");
	const relay = hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/", v: "real1" });
	Object.defineProperty(relay, "cf", { value: { asn: 13335, country: "GB" } });
	assert.equal(await record(relay, env, now), "view", "iCloud Private Relay and WARP readers still count");

	assert.equal(await record(hitRequest({ k: "o", s: "paulobrien.com", u: "https://paulobrien.com/", t: "https://spam.example/", v: "nope1" }), env, now), "no view", "a planted link");
	assert.equal(await record(hitRequest({ k: "o", s: "paulobrien.com", u: "https://paulobrien.com/", t: "https://spam.example/" }), env, now), "no view");
	assert.equal(await record(hitRequest({ k: "o", s: "paulobrien.com", u: "https://paulobrien.com/", t: "https://www.fastmail.com/", v: "real1" }), env, now + 1000), "outbound", "a click on a counted page view");
	assert.equal(stored(), 2);

	const { VISITOR_DAILY_CAP } = await import("../src/filter.ts");
	for (let i = stored(); i < VISITOR_DAILY_CAP; i++) sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, view_id, path, referrer, source) SELECT site, ts, day, 'view', visitor, 'x' || ?, '/', '', '' FROM events LIMIT 1").run(i);
	assert.equal(await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/again/", v: "many1" }), env, now + 2000), "too many");
	assert.equal(stored(), VISITOR_DAILY_CAP);
	assert.deepEqual([left("no origin"), left("cloud"), left("no view"), left("too many")], [1, 1, 2, 1]);

	// One website can only store so many hits a day, however many visitors a script pretends to be.
	const { SITE_DAILY_CAP } = await import("../src/filter.ts");
	sql.prepare("UPDATE site_hits SET n = ? WHERE site = 'paulobrien.com' AND day = ?").run(SITE_DAILY_CAP - 1, day);
	assert.equal(await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/", v: "cap1" }, MAC_CHROME), env, now + 3000), "view", "the last one under the cap");
	assert.equal(await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/", v: "cap2" }, WIN_EDGE, "198.51.100.9"), env, now + 4000), "site cap");
	assert.equal(stored(), VISITOR_DAILY_CAP + 1);
	assert.equal(left("site cap"), 1);
	await tidy(env, now + 2 * 86_400_000);
	assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM site_hits").get()!.n, 0, "old daily counts are tidied away");
	assert.equal(stored(), VISITOR_DAILY_CAP + 1, "the hits themselves are kept");
	sql.prepare("DELETE FROM filtered WHERE reason = 'site cap'").run();

	// The stats page says how much was left out, once there's enough to matter.
	sql.prepare("UPDATE filtered SET n = 40 WHERE reason = 'cloud'").run();
	const report = await buildReport(db, "paulobrien.com", "7d", now);
	assert.equal(report.filtered, 44);
	assert.match(renderDashboard(report, ["paulobrien.com"]), /Some traffic filtered\.<\/b> We left 44 hits out/);

	// The code copied onto another website: not counted, and the setup check says where it is.
	sql.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES ('myblog.co.uk', 'a1', 1)").run();
	forgetCountedSites();
	assert.equal(await record(hitRequest({ k: "v", s: "myblog.co.uk", u: "https://otherblog.com/post/", v: "wr1" }), env, now), "wrong site");
	const check = await checkSite(env, "myblog.co.uk", now, (async () => new Response("")) as typeof fetch);
	assert.equal(check.ok, false);
	assert.match(check.message, /on a different website, otherblog\.com/);
	forgetCountedSites();
});

test("goals and missing pages: counted from the tracker, shown on the stats page with where they came from", async () => {
	const { db, sql } = fakeD1();
	const env: Env = { DB: db, SITES: "paulobrien.com" };
	await addSites(db, "paulobrien.com");
	const now = Date.UTC(2026, 9, 13, 10);
	await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/a/", r: "https://t.co/x", v: "view1" }), env, now);
	assert.equal(await record(hitRequest({ k: "g", s: "paulobrien.com", u: "https://paulobrien.com/a/", t: "  Newsletter <b>sign-up</b>  ", v: "view1" }), env, now + 5000), "goal");
	await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/old-post/", r: "https://www.google.com/", v: "view2", m: 1 }, MAC_CHROME, "198.51.100.9"), env, now + 9000);
	const goal = sql.prepare("SELECT target, path FROM events WHERE kind = 'goal'").get() as { target: string; path: string };
	assert.equal(goal.path, "/a/");
	assert.ok(goal.target.startsWith("Newsletter") && goal.target.length <= 80);
	const report = await buildReport(db, "paulobrien.com", "7d", now + 60_000, false);
	assert.equal(report.goals?.length, 1);
	assert.equal(report.goalSources?.[0].name, "X (Twitter)", "a goal takes the source of the view it happened on");
	assert.equal(report.missing?.[0].path, "/old-post/");
	const page = renderDashboard(report, ["paulobrien.com"], { fixes: [] });
	assert.ok(page.includes("Goals and Sign-Ups") && page.includes("Missing Page Report"));
	assert.ok(TRACKER.includes("data-rc-goal") || TRACKER.includes("rcGoal"), "the tracker reads data-rc-goal");
	const empty = renderDashboard({ ...report, goals: [], goalSources: [], goalPages: [] }, ["paulobrien.com"], { fixes: [] });
	assert.ok(empty.includes("No goals yet") && empty.includes("https://github.com/pobren/readercount#goals") && empty.includes("data-copy"), "no goals yet: the steps, a Copy button and the guide");
	assert.ok(!empty.includes('<p class="empty"><div'), "the how-to isn't put inside a paragraph");
});

test("earnings per post: reads affiliate reports and shares each day's earnings by clicks to that shop", async () => {
	const { parseEarnings, saveEarnings, earningsByPage, readDay, readPence } = await import("../src/earnings.ts");
	assert.equal(readDay("19/10/2026"), "2026-10-19");
	assert.equal(readDay("Oct 19, 2026"), "2026-10-19");
	assert.equal(readPence("£1,234.56"), 123456);
	assert.equal(readPence("12,50 €"), 1250);
	assert.ok("error" in parseEarnings("Date,Commission\n2026-10-01,1.00"), "no shop column and no shop typed in");
	const amazon = parseEarnings("Fee-Earnings Report\nDate,Items Shipped,Ad Fees\n2026-10-01,2,3.00\n2026-10-01,1,1.00\nbad,line,x", "Amazon");
	assert.ok(!("error" in amazon));
	if ("error" in amazon) return;
	assert.deepEqual(amazon.rows, [{ day: "2026-10-01", shop: "Amazon", pence: 400 }]);
	assert.equal(amazon.skipped, 1);

	const { db, sql } = fakeD1();
	const ev = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, path, target) VALUES ('b.com', 0, '2026-10-01', 'outbound', ?, ?, ?)");
	ev.run("v1", "/kettles/", "https://www.amazon.co.uk/dp/1?tag=x-21");
	ev.run("v2", "/kettles/", "https://www.amazon.co.uk/dp/2?tag=x-21");
	ev.run("v3", "/toasters/", "https://amzn.to/abc");
	ev.run("v4", "/toasters/", "https://www.johnlewis.com/x");
	await saveEarnings(db, "b.com", amazon.rows);
	const byPage = await earningsByPage(db, "b.com", "2026-09-25", "2026-10-02");
	assert.deepEqual(byPage, [{ path: "/kettles/", pence: 267 }, { path: "/toasters/", pence: 133 }]);
});

test("broken link alerts: a link failing two checks in a row shows on the stats page and emails the owner once", async () => {
	const { checkLinks, brokenLinks, isBroken } = await import("../src/links.ts");
	assert.ok(isBroken(404) && isBroken(null) && isBroken(503) && !isBroken(200) && !isBroken(403));
	const { db, sql } = fakeD1();
	const sent: { to: string; subject: string; text: string }[] = [];
	const now = Date.UTC(2026, 9, 13, 10);
	sql.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('a1', 'p@example.com', 1)").run();
	sql.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES ('b.com', 'a1', 1)").run();
	const ev = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, path, target) VALUES ('b.com', 0, '2026-10-12', 'outbound', 'v', '/', ?)");
	ev.run("https://gone.example/x");
	ev.run("https://fine.example/");
	const env = { DB: db, APP_HOST: "app.readercount.com", EMAIL: { send: async (m: any) => void sent.push(m) } };
	const checker = async (t: string) => (t.includes("gone") ? 404 : 200);
	const stillThere = async () => true;
	assert.equal(await checkLinks(env, now, checker, stillThere), 2);
	assert.equal(await checkLinks(env, now + 3_600_000, checker, stillThere), 0, "checked links wait until tomorrow");
	assert.equal((await brokenLinks(db, "b.com")).length, 0, "one failure isn't enough");
	await checkLinks(env, now + 86_400_000, checker, stillThere);
	await checkLinks(env, now + 2 * 86_400_000, checker, stillThere);
	const broken = await brokenLinks(db, "b.com");
	assert.deepEqual(broken.map((b) => [b.target, b.status]), [["https://gone.example/x", 404]]);
	assert.deepEqual(broken[0].pages, [{ path: "/", clicks: 1, last: "2026-10-12" }], "shows the page the link is on");
	assert.equal((await brokenLinks(db, "b.com", now + 40 * 86_400_000)).length, 0, "a link nobody has clicked for 30 days (taken off the site) drops off");
	assert.equal(sent.length, 1, "one email, not one a day");
	assert.ok(sent[0].subject.includes("stopped working") && sent[0].text.includes("https://gone.example/x"));
	await checkLinks(env, now + 3 * 86_400_000, async () => 200);
	assert.equal((await brokenLinks(db, "b.com")).length, 0, "a fixed link drops off");
});

test("broken link alerts: a broken link already taken off the page isn't reported", async () => {
	const { checkLinks, brokenLinks, onPage } = await import("../src/links.ts");
	const page = (html: string, status = 200) => (async () => new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } })) as typeof fetch;
	const repo = "https://github.com/pobren/mail-app";
	assert.equal(await onPage("https://example.org/mail/", repo, page(`<a href="${repo}">Code</a>`)), true);
	assert.equal(await onPage("https://example.org/mail/", repo, page(`<a href="${repo}/">Code</a>`)), true, "trailing slash counts");
	assert.equal(await onPage("https://example.org/mail/", repo, page(`<a href="${repo}-app">App</a>`)), false, "a longer address isn't the same link");
	assert.equal(await onPage("https://example.org/mail/", "https://x.com/a?b=1&c=2", page(`<a href="https://x.com/a?b=1&amp;c=2">x</a>`)), true, "escaped & counts");
	assert.equal(await onPage("https://example.org/mail/", repo, page("<p>gone</p>", 500)), null, "a page that won't open proves nothing");
	assert.equal(await onPage("http://localhost/", repo, page("")), null);

	const { db, sql } = fakeD1();
	const now = Date.UTC(2026, 9, 29, 10);
	sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, path, target) VALUES ('example.org', 0, '2026-10-16', 'outbound', 'v', '/mail/', ?)").run(repo);
	const asked: string[] = [];
	const removed = async (p: string) => (asked.push(p), false);
	for (let d = 0; d < 3; d++) await checkLinks({ DB: db }, now + d * 86_400_000, async () => 404, removed);
	assert.deepEqual(asked[0], "https://example.org/mail/", "looks on the page it was clicked on");
	assert.equal((await brokenLinks(db, "example.org", now)).length, 0);
	// Already reported, then taken off the page: drops off at the next check.
	sql.prepare("UPDATE link_checks SET fails = 12, broken_since = 1, alerted = 1, checked_at = 0").run();
	assert.equal((await brokenLinks(db, "example.org", now)).length, 1);
	await checkLinks({ DB: db }, now, async () => 404, removed);
	assert.equal((await brokenLinks(db, "example.org", now)).length, 0, "cleared once it's off the page");
	// Couldn't read the page: carries on being reported.
	sql.prepare("UPDATE link_checks SET fails = 2, broken_since = 1, checked_at = 0").run();
	await checkLinks({ DB: db }, now, async () => 404, async () => null);
	assert.equal((await brokenLinks(db, "example.org", now)).length, 1);
});

test("broken link alerts: a site that says 404 to HEAD but opens fine is not broken", async () => {
	const { check } = await import("../src/links.ts");
	const asked: string[] = [];
	// Like Bluesky profiles: 404 to HEAD, 200 to GET.
	const getOnly = (async (_u: string, init: RequestInit) => (asked.push(init.method!), new Response(null, { status: init.method === "HEAD" ? 404 : 200 }))) as typeof fetch;
	assert.equal(await check("https://bsky.app/profile/someone", getOnly), 200);
	assert.deepEqual(asked, ["HEAD", "GET"]);
	// Like a referral link: HEAD 404, GET redirects to the sign-up page.
	const referral = (async (u: string, init: RequestInit) =>
		init.method === "HEAD" ? new Response(null, { status: 404 }) : u.includes("join.") ? new Response(null, { status: 302, headers: { Location: "https://app.example.com/signup/" } }) : new Response("ok", { status: 200 })) as typeof fetch;
	assert.equal(await check("https://join.example.com/abc", referral), 200);
	// Really gone, and a clear yes to HEAD needs no second ask.
	assert.equal(await check("https://gone.example/x", (async () => new Response(null, { status: 404 })) as typeof fetch), 404);
	asked.length = 0;
	const fine = (async (_u: string, init: RequestInit) => (asked.push(init.method!), new Response(null, { status: 200 }))) as typeof fetch;
	assert.equal(await check("https://fine.example/", fine), 200);
	assert.deepEqual(asked, ["HEAD"]);
});

test("planted links: the link check only opens public web addresses, and public pages only list links several readers clicked", async () => {
	const { checkLinks, offLimits } = await import("../src/links.ts");
	for (const t of ["http://localhost/", "http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/", "http://10.0.0.5/", "http://192.168.1.1/admin", "http://172.20.0.1/", "http://169.254.169.254/latest/", "http://[::1]/", "http://[fd00::1]/", "http://[::ffff:10.0.0.1]/", "http://printer.local/", "http://db.internal/", "http://intranet/", "file:///etc/passwd", "ftp://example.com/", "https://user:pw@example.com/", "not a link"])
		assert.ok(offLimits(t), t);
	for (const t of ["https://www.fastmail.com/", "http://example.com/x?y=1", "https://8.8.8.8/"]) assert.ok(!offLimits(t), t);
	const { db, sql } = fakeD1();
	const now = Date.now(); // The public page reads the last 30 days from today.
	const day = new Date(now).toISOString().slice(0, 10);
	sql.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES ('b.com', 'a1', 1)").run();
	const ev = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, view_id, path, target) VALUES ('b.com', ?, ?, ?, ?, ?, '/', ?)");
	ev.run(now, day, "outbound", "x", "w1", "http://169.254.169.254/latest/");
	const opened: string[] = [];
	await checkLinks({ DB: db }, now, async (t) => (opened.push(t), 200));
	assert.deepEqual(opened, [], "a private address is never opened");
	assert.equal(sql.prepare("SELECT fails FROM link_checks WHERE target = 'http://169.254.169.254/latest/'").get()!.fails, 0, "nor reported as broken");

	// Public page: a link three readers clicked on one day is listed; one planted by a single sender isn't.
	sql.prepare("INSERT INTO accounts (id, email, created_at, plan) VALUES ('a1', 'p@example.com', 1, 'founder')").run();
	sql.prepare("UPDATE sites SET public = 1, verified_at = 1 WHERE domain = 'b.com'").run();
	for (const v of ["r1", "r2", "r3"]) {
		ev.run(now, day, "view", v, "pv" + v, null);
		ev.run(now, day, "outbound", v, "pv" + v, "https://www.fastmail.com/");
		ev.run(now, day, "goal", v, "pv" + v, "Newsletter");
	}
	for (let i = 0; i < 20; i++) {
		ev.run(now, day, "outbound", "spammer", "pvs", "https://spam.example/");
		ev.run(now, day, "goal", "spammer", "pvs", "Visit spam.example");
	}
	const env: Env = { DB: db, SITES: "", APP_HOST: "app.readercount.com" };
	const pub = await (await worker.fetch(new Request("https://app.readercount.com/share/b.com"), env)).text();
	assert.ok(pub.includes("fastmail.com") && pub.includes("Newsletter"), "real links and goals are listed");
	assert.ok(!pub.includes("spam.example"), "planted ones aren't");
	const report = await buildReport(db, "b.com", "7d", now);
	assert.ok(report.clicks.some((c) => String(c.target).includes("spam.example")), "the owner still sees everything on their own stats page");
});

test("traffic spikes and the monthly review: emailed once, only to people who want them", async () => {
	const { sendSpikeAlerts, sendMonthlyReviews } = await import("../src/alerts.ts");
	const { db, sql } = fakeD1();
	const sent: { to: string; subject: string; text: string }[] = [];
	const now = Date.UTC(2026, 10, 1, 7);
	sql.prepare("INSERT INTO accounts (id, email, created_at, spikes, monthly) VALUES ('a1', 'yes@example.com', 1, 1, 1), ('a2', 'no@example.com', 1, 0, 0)").run();
	sql.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES ('b.com', 'a1', 1), ('c.com', 'a2', 1)").run();
	const ev = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, path, source) VALUES (?, ?, ?, 'view', ?, ?, ?)");
	const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
	for (const site of ["b.com", "c.com"]) for (let i = 0; i < 40; i++) ev.run(site, now - 600_000, day(now - 600_000), "s" + i, "/hot/", "Reddit");
	const env = { DB: db, APP_HOST: "app.readercount.com", EMAIL: { send: async (m: any) => void sent.push(m) } };
	assert.equal(await sendSpikeAlerts(env, now), 1);
	assert.equal(await sendSpikeAlerts(env, now + 3_600_000 - 1), 0, "one email per page per day");
	assert.equal(sent[0].to, "yes@example.com");
	assert.ok(sent[0].subject.includes("is taking off: 40 visitors") && sent[0].text.includes("Reddit: 40"));

	// October against September.
	for (let i = 0; i < 30; i++) ev.run("b.com", 0, "2026-10-1" + (i % 9), "o" + i, "/rising/", "");
	for (let i = 0; i < 10; i++) ev.run("b.com", 0, "2026-09-15", "p" + i, "/rising/", "");
	sent.length = 0;
	assert.equal(await sendMonthlyReviews(env, now), 1);
	assert.equal(await sendMonthlyReviews(env, now + 3_600_000), 0, "once a month");
	assert.ok(sent[0].subject.startsWith("Your October 2026 review"));
	assert.ok(sent[0].text.includes("Biggest risers:") && sent[0].text.includes("10 → 30"), sent[0].text);
});

test("Connect Ghost: checks the key and the website, reads published posts, and keeps up through the webhook", async () => {
	const { db } = fakeD1();
	const env = { DB: db, APP_HOST: "app.readercount.com", ADMIN_PASSWORD: "secret" } as unknown as Env;
	const now = Date.parse("2026-10-21T10:00:00Z");
	const KEY = "6ad88925af1e2e00014e0d30:3356dc6257753e8ca30de6bdf54d9470b7333c78cb85b6e05c395e0578f3dbb3";
	const calls: string[] = [];
	let hookUrl = "";
	const get = (async (input: string, init: RequestInit = {}) => {
		const u = new URL(input);
		calls.push(`${init.method ?? "GET"} ${u.pathname}`);
		assert.match(String((init.headers as Record<string, string>).Authorization), /^Ghost [\w-]+\.[\w-]+\.[\w-]+$/);
		if (u.pathname.endsWith("/site/")) return Response.json({ site: { url: u.hostname === "blog.other.com" ? "https://other.com/" : "https://www.myblog.com/" } });
		if (u.pathname.endsWith("/posts/")) {
			assert.equal(u.searchParams.get("filter"), "status:published");
			return Response.json({ posts: [{ title: "Best mesh Wi-Fi", url: "https://www.myblog.com/best-mesh-wifi/", published_at: "2026-10-20T09:00:00.000Z" }, { title: "Hello", url: "https://www.myblog.com/hello/", published_at: "2026-10-01T09:00:00.000Z" }], meta: { pagination: { next: null } } });
		}
		if (u.pathname.endsWith("/webhooks/") && init.method === "POST") {
			hookUrl = JSON.parse(String(init.body)).webhooks[0].target_url;
			return Response.json({ webhooks: [{ id: "6ad88930af1e2e00014e0d33" }] }, { status: 201 });
		}
		if (init.method === "DELETE") return new Response(null, { status: 204 });
		return new Response("nope", { status: 404 });
	}) as typeof fetch;

	assert.match((await connectGhost(env, "acct", "myblog.com", "not a url", KEY, now, get) as { error: string }).error, /API URL/);
	assert.match((await connectGhost(env, "acct", "myblog.com", "https://myblog.com", "abc", now, get) as { error: string }).error, /Admin API key/);
	assert.match((await connectGhost(env, "acct", "myblog.com", "https://blog.other.com", KEY, now, get) as { error: string }).error, /other\.com, not myblog\.com/);
	assert.deepEqual(await connectGhost(env, "acct", "myblog.com", "https://www.myblog.com/ghost/", KEY, now, get), { posts: 2 });
	assert.deepEqual(await ghostState(db, "myblog.com"), { connected: true, apiUrl: "https://www.myblog.com", posts: 2, error: null });
	assert.equal((await db.prepare("SELECT key FROM ghost_links").first<{ key: string }>())!.key.includes("3356dc"), false, "the key is kept encrypted");
	assert.deepEqual((await postsBetween(db, "myblog.com", "2026-10-15", "2026-10-21")).map((p) => ({ ...p })), [{ day: "2026-10-20", path: "/best-mesh-wifi/", title: "Best mesh Wi-Fi" }]);
	assert.equal((await titlesFor(db, "myblog.com", ["/hello/", "/"])).get("/hello/"), "Hello");

	// Ghost's webhook adds a new post straight away; a wrong address is a 404.
	assert.match(hookUrl, /^https:\/\/app\.readercount\.com\/ghost\/hook\/[\w-]+$/);
	const token = hookUrl.split("/").pop()!;
	const hook = (t: string, body: unknown) => ghostHook(new Request(`https://app.readercount.com/ghost/hook/${t}`, { method: "POST", body: JSON.stringify(body) }), env, t);
	assert.equal((await hook("wrong", {})).status, 404);
	assert.equal((await hook(token, { post: { current: { title: "Brand new", url: "https://www.myblog.com/brand-new/", published_at: "2026-10-21T08:00:00.000Z", status: "published" } } })).status, 204);
	assert.equal((await ghostState(db, "myblog.com")).posts, 3);

	// Titles replace addresses in Top pages, and new posts are marked on the chart.
	const sample = sampleReport("7d", now);
	const page = renderDashboard(sample, ["myblog.com"], { posts: [{ day: sample.days[2].day, title: "Brand new" }], titles: new Map([[String(sample.pages[0].path), "A proper title"]]) });
	assert.ok(page.includes("A proper title"));
	assert.ok(page.includes("New post: Brand new"));

	await disconnectGhost(env, "myblog.com", now, get);
	assert.ok(calls.includes("DELETE /ghost/api/admin/webhooks/6ad88930af1e2e00014e0d33/"));
	assert.deepEqual(await ghostState(db, "myblog.com"), { connected: false });
	assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM posts").first<{ n: number }>())!.n, 0);
});

test("live view: who's on the site now, the page they're on and their trail today, without the hash", async () => {
	const { buildLive, renderLive, deviceName, ago } = await import("../src/live.ts");
	const { db } = fakeD1();
	const env: Env = { DB: db, SITES: "paulobrien.com" };
	await addSites(db, "paulobrien.com");
	const t = Date.UTC(2026, 9, 23, 12);
	// An iPhone reader: home page, then a review, then a click to Fastmail.
	await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/", r: "https://www.google.com/", v: "live1" }), env, t);
	await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/fastmail-review/", v: "live2" }), env, t + 60_000);
	await record(hitRequest({ k: "o", s: "paulobrien.com", u: "https://paulobrien.com/fastmail-review/", t: "https://www.fastmail.com/?ref=x", v: "live2" }), env, t + 90_000);
	// A Mac reader who closed the page 9 minutes ago isn't live; nor is anyone whose last page was 6 minutes ago.
	await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/old/", v: "live3" }, MAC_CHROME, "198.51.100.20"), env, t - 10 * 60_000);
	await record(hitRequest({ k: "l", s: "paulobrien.com", v: "live3", d: 60 }, MAC_CHROME, "198.51.100.20"), env, t - 9 * 60_000);
	await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/older/", v: "live4" }, WIN_EDGE, "198.51.100.21"), env, t - 4 * 60_000);
	const live = await buildLive(db, "paulobrien.com", t + 120_000);
	assert.equal(live.visitors.length, 1);
	const v = live.visitors[0];
	assert.equal(v.page, "/fastmail-review/");
	assert.equal(v.source, "Google");
	assert.equal(v.views, 2);
	assert.deepEqual(v.steps.map((s) => s.kind), ["view", "view", "outbound"]);
	assert.equal(deviceName(v.device, v.os), "iPhone");
	assert.equal(ago(30_000), "30s ago");
	assert.equal(ago(5_000), "just now");
	const html = renderLive(live, ["paulobrien.com"], { email: "paul@example.com", titles: new Map([["/fastmail-review/", "Fastmail review"]]) });
	assert.ok(html.includes("<h1>Live Visitor Activity</h1>") && html.includes("Real-Time Active Visitors: <b>1</b>"));
	assert.ok(html.includes("Visitor from") && html.includes("iPhone · Safari · came from Google"));
	assert.ok(html.includes("Fastmail review<span class=\"lv-tag\">Now</span>") && html.includes("Clicked a link to Fastmail"));
	assert.ok(html.includes("setInterval(tick,5000)"), "updates every 5 seconds");
	const hash = (await db.prepare("SELECT visitor FROM events LIMIT 1").first<{ visitor: string }>())!.visitor;
	assert.ok(!html.includes(hash), "the visitor hash never reaches the page");
	// Hiding the tab drops the iPhone reader at once; coming back to it brings them back.
	await record(hitRequest({ k: "l", s: "paulobrien.com", v: "live2", d: 30 }), env, t + 130_000);
	assert.equal((await buildLive(db, "paulobrien.com", t + 131_000)).total, 0);
	assert.ok(renderLive(await buildLive(db, "paulobrien.com", t + 131_000), ["paulobrien.com"], { email: "x" }).includes("Nobody on the site right now"));
	await record(hitRequest({ k: "b", s: "paulobrien.com", v: "live2" }), env, t + 140_000);
	assert.equal((await buildLive(db, "paulobrien.com", t + 141_000)).total, 1);
	assert.ok(html.includes('href="https://paulobrien.com/#readercount-ignore"'), "links to leave your own visits out");
	// Signed in, the dashboard's pill opens the live view; the public page's doesn't.
	const r = await buildReport(db, "paulobrien.com", "today", t + 120_000);
	assert.ok(renderDashboard(r, ["paulobrien.com"], { account: { email: "x", sitesHtml: "" } }).includes('href="/live?site=paulobrien.com"'));
	assert.ok(!renderDashboard(r, ["paulobrien.com"], { shared: true }).includes("/live?"));
});

test("live view with hundreds on the site: 50 cards, but the count and cards cover everyone", async () => {
	const { buildLive, renderLive } = await import("../src/live.ts");
	const { db, sql } = fakeD1();
	const t = Date.UTC(2026, 9, 23, 12);
	const add = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, view_id, path, source, country, device, browser, os) VALUES ('b.com', ?, '2026-10-23', 'view', ?, ?, ?, ?, 'GB', 'mobile', 'Safari', 'iOS')");
	for (let i = 0; i < 300; i++) {
		add.run(t - 200_000 + i, "v" + i, "a" + i, "/", i % 3 ? "Google" : "");
		if (i % 3 === 0) add.run(t - 100_000 + i, "v" + i, "b" + i, "/post/", "");
	}
	const live = await buildLive(db, "b.com", t);
	assert.equal(live.total, 300);
	assert.equal(live.visitors.length, 50);
	assert.deepEqual(live.pages.map((p) => ({ ...p })), [{ path: "/", n: 200 }, { path: "/post/", n: 100 }]);
	assert.deepEqual(live.sources.map((p) => ({ ...p })), [{ name: "Google", n: 200 }, { name: "Direct", n: 100 }]);
	const html = renderLive(live, ["b.com"], { email: "x" });
	assert.ok(html.includes("Real-Time Active Visitors: <b>300</b>") && html.includes("Showing the 50 most recently active of 300 visitors"));
});

test("page extras: scroll depth, speed, problems and forms are checked and cleaned before they're kept", async () => {
	const { pageExtras, scrub } = await import("../src/collect.ts");
	assert.equal(scrub("Cannot read jo.bloggs+x@example.co.uk at https://a.com/x.js?token=abc order 1234567"), "Cannot read [email] at https://a.com/x.js order #");
	const x = pageExtras({ p: 140, c: 2300.4, i: 0, x: 80, e: [["i", "https://a.com/pic.jpg?w=10"], ["j", "https://a.com/app.js", "Oops at 1234567"], ["z", "https://a.com/"], ["f", "javascript:alert(1)"], ["i", "https://u:p@a.com/x.png"]], f: ["Form: contact", "", "Form: contact"] });
	assert.equal(x.scroll, 100, "capped at 100");
	assert.equal(x.lcp, 2300);
	assert.equal(x.inp, undefined, "0 means not measured");
	assert.equal(x.cls, 80);
	assert.deepEqual(x.problems, [{ kind: "image", url: "https://a.com/pic.jpg", message: "" }, { kind: "script", url: "https://a.com/app.js", message: "Oops at #" }], "only three looked at, bad kinds and addresses dropped, query strings gone");
	assert.deepEqual(x.forms, ["Form: contact"]);
	assert.deepEqual(parseHit({ k: "l", s: "paulobrien.com", v: "view1", d: 0 }, IPHONE, ["paulobrien.com"]), { ignored: "bad leave" }, "an empty quick leave is still ignored");
	const quick = parseHit({ k: "l", s: "paulobrien.com", v: "view1", d: 0, e: [["j", "https://paulobrien.com/app.js", "x is not defined:3"]] }, IPHONE, ["paulobrien.com"]);
	assert.ok(!("ignored" in quick) && quick.kind === "leave" && quick.problems?.length === 1, "a quick leave with a problem is kept");
	// Pictures cut off by a reader (or a bot) leaving within a few seconds aren't missing from the website.
	assert.deepEqual(parseHit({ k: "l", s: "paulobrien.com", v: "view1", d: 0, e: [["i", "https://paulobrien.com/a.png"], ["i", "https://paulobrien.com/b.png"]] }, IPHONE, ["paulobrien.com"]), { ignored: "bad leave" }, "pictures from a leave under a second aren't kept");
	const blink = parseHit({ k: "l", s: "paulobrien.com", v: "view1", d: 2, e: [["i", "https://paulobrien.com/a.png"], ["f", "https://paulobrien.com/a.css"]] }, IPHONE, ["paulobrien.com"]);
	assert.ok(!("ignored" in blink) && blink.problems?.length === 1 && blink.problems[0].kind === "file", "a quick leave keeps its other problems but not its pictures");
	const stayed = parseHit({ k: "l", s: "paulobrien.com", v: "view1", d: 3, e: [["i", "https://paulobrien.com/a.png"]] }, IPHONE, ["paulobrien.com"]);
	assert.ok(!("ignored" in stayed) && stayed.problems?.length === 1, "a picture that failed for a reader who stayed is kept");
	// Every picture failing at once (no picture on the page loaded) means the reader's browser was blocking pictures.
	const blocked = parseHit({ k: "l", s: "paulobrien.com", v: "view1", d: 40, a: 0, e: [["i", "https://paulobrien.com/a.png"], ["f", "https://paulobrien.com/a.css"]] }, IPHONE, ["paulobrien.com"]);
	assert.ok(!("ignored" in blocked) && blocked.problems?.length === 1 && blocked.problems[0].kind === "file", "pictures aren't kept when no picture on the page loaded");
	const one = parseHit({ k: "l", s: "paulobrien.com", v: "view1", d: 40, a: 1, e: [["i", "https://paulobrien.com/a.png"]] }, IPHONE, ["paulobrien.com"]);
	assert.ok(!("ignored" in one) && one.problems?.length === 1, "a broken picture is kept when others on the page loaded");
});

test("reader engagement and site problems: recorded from the leave message, shown on the stats page", async () => {
	const { behaviourReport, recordReports } = await import("../src/behaviour.ts");
	const { db, sql } = fakeD1();
	forgetCountedSites();
	const env: Env = { DB: db, SITES: "paulobrien.com" };
	await addSites(db, "paulobrien.com");
	const now = Date.UTC(2026, 9, 24, 10);
	for (let i = 0; i < 6; i++) {
		const ua = i % 2 ? IPHONE : MAC_CHROME;
		await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/review/", r: "https://www.google.com/", v: `view${i}` }, ua, `198.51.100.${i}`), env, now + i);
		assert.equal(await record(hitRequest({ k: "l", s: "paulobrien.com", v: `view${i}`, d: 30, p: 40 + i * 10, c: 1000 + i * 1000, x: 50, i: 120, e: [["i", "https://paulobrien.com/img/kettle.jpg?x=1"], ["j", "https://paulobrien.com/app.js", "x is not defined:12"]], f: i < 4 ? ["Form: contact"] : [] }, ua, `198.51.100.${i}`), env, now + 1000 + i), "leave");
	}
	// The same leave again (the tab hidden twice): figures only go up, reports aren't counted twice by the tracker (it clears them once sent).
	await record(hitRequest({ k: "l", s: "paulobrien.com", v: "view0", d: 31, p: 10 }, MAC_CHROME, "198.51.100.0"), env, now + 5000);
	assert.equal((sql.prepare("SELECT scroll FROM events WHERE view_id = 'view0'").get() as { scroll: number }).scroll, 40, "scroll depth never goes down");
	await record(hitRequest({ k: "g", s: "paulobrien.com", u: "https://paulobrien.com/review/", t: "Form: contact", v: "view1" }, IPHONE, "198.51.100.1"), env, now + 6000);
	// A missing page reached from another page of the site: that page has the broken link.
	await record(hitRequest({ k: "v", s: "paulobrien.com", u: "https://paulobrien.com/old-kettle/", r: "https://paulobrien.com/review/", v: "view9", m: 1 }, IPHONE, "198.51.100.9"), env, now + 7000);

	const b = await behaviourReport(db, "paulobrien.com", "2026-10-24", "2026-10-24", now);
	assert.equal(b.reading[0].path, "/review/");
	assert.equal(b.reading[0].end, 1, "one reader reached 90% or more");
	assert.equal(b.speed[0].lcp, 4000, "the 75th percentile of 1, 2, 3, 4, 5 and 6 seconds");
	assert.equal(b.speed[0].rating, "attention");
	assert.equal(b.devices.computer, undefined, "fewer than five computer visits: not shown");
	const img = b.problems.find((p) => p.kind === "image");
	assert.equal(img?.n, 6);
	assert.equal(img?.url, "https://paulobrien.com/img/kettle.jpg");
	assert.deepEqual(img?.browsers.sort(), ["Chrome", "Safari"]);
	assert.equal(b.problems.find((p) => p.kind === "script")?.message, "x is not defined:12");
	assert.deepEqual(b.forms, [{ form: "Form: contact", started: 4, sent: 1 }]);

	const report = await buildReport(db, "paulobrien.com", "today", now + 60_000, false);
	report.behaviour = b;
	assert.equal(report.missing?.[0].top_link, "/review/");
	const page = renderDashboard(report, ["paulobrien.com"], { fixes: [] });
	for (const text of ["Reader Engagement & Page Speed", "Site Problems Seen by Readers", "Scroll Depth", "Form Drop-Off", "Needs attention", "kettle.jpg", "Broken link on your page <a class=\"ln\" href=\"https://paulobrien.com/review/\""]) assert.ok(page.includes(text), text);
	assert.ok(!renderDashboard(report, ["paulobrien.com"], { shared: true }).includes("Site Problems"), "never on public stats pages");

	// The plan's monthly allowance: once it's used up nothing more is kept.
	sql.prepare("INSERT INTO accounts (id, email, created_at, plan) VALUES ('a1', 'a@b.com', 0, 'solo')").run();
	sql.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES ('b.com', 'a1', 0)").run();
	sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, view_id, path, browser) VALUES ('b.com', ?, '2026-10-24', 'view', 'v', 'vb', '/', 'Safari')").run(now);
	sql.prepare("INSERT INTO report_use (owner, month, n) VALUES ('a1', '2026-10', 199999)").run();
	assert.equal(await recordReports(db, "b.com", "vb", [{ kind: "image", url: "https://b.com/a.png", message: "" }], [], now), true);
	assert.equal(await recordReports(db, "b.com", "vb", [{ kind: "image", url: "https://b.com/a.png", message: "" }], [], now), false, "200,000 a month are kept");
	assert.equal((await behaviourReport(db, "b.com", "2026-10-24", "2026-10-24", now)).full, true);
});

test("triggers: a page visited, a link clicked or a form sent counts as a goal, with capped emails and webhooks", async () => {
	const { readTrigger, matches, hookBody, addTrigger, fireTriggers, triggerCounts, sendTriggerRoundups, forgetTriggers, HOOKS_PER_DAY } = await import("../src/triggers.ts");
	assert.deepEqual(readTrigger({ name: "  Order   placed ", kind: "page", pattern: "/thank-you", notify: "email" }), { name: "Order placed", kind: "page", pattern: "/thank-you", notify: "email", webhook: null });
	assert.ok("error" in readTrigger({ name: "x", kind: "page", pattern: "thank-you" }), "a page starts with /");
	assert.ok("error" in readTrigger({ name: "x", kind: "link", pattern: "amazon.", webhook: "http://hooks.slack.com/x" }), "webhooks must be https");
	assert.ok("error" in readTrigger({ name: "x", kind: "link", pattern: "amazon.", webhook: "https://127.0.0.1/hook" }), "nothing on a private network");
	assert.ok("error" in readTrigger({ name: "x", kind: "nope", pattern: "a" }));
	const hit = (kind: string, path: string, target: string | null = null) => ({ kind, path, target, source: "Google", country: "GB" });
	assert.ok(matches({ kind: "page", pattern: "/thank-you" }, hit("view", "/thank-you/")));
	assert.ok(matches({ kind: "page", pattern: "/order/*" }, hit("view", "/order/123")));
	assert.ok(!matches({ kind: "page", pattern: "/order/*" }, hit("view", "/orders")));
	assert.ok(matches({ kind: "link", pattern: "Amazon." }, hit("outbound", "/review/", "https://www.amazon.co.uk/dp/B0?tag=x-21")));
	assert.ok(matches({ kind: "form", pattern: "contact" }, hit("goal", "/", "Form: contact")));
	assert.ok(matches({ kind: "form", pattern: "*" }, hit("goal", "/", "Form: newsletter")));
	assert.ok(!matches({ kind: "form", pattern: "*" }, hit("goal", "/", "Signup")), "* is any form, not any goal");
	assert.equal(hookBody("https://hooks.slack.com/services/a", "Hi", { a: "1" }), '{"text":"Hi"}');
	assert.equal(hookBody("https://discord.com/api/webhooks/1", "Hi", { a: "1" }), '{"content":"Hi"}');
	assert.equal(hookBody("https://hooks.zapier.com/x", "Hi", { a: "1" }), '{"text":"Hi","a":"1"}');

	const { db, sql } = fakeD1();
	forgetCountedSites();
	forgetTriggers();
	const sent: any[] = [];
	const posted: { url: string; body: string }[] = [];
	const poster = (async (url: string, init: RequestInit) => (posted.push({ url, body: String(init.body) }), new Response(null))) as unknown as typeof fetch;
	const env: Env = { DB: db, SITES: "", APP_HOST: "app.readercount.com", EMAIL: { send: async (m) => void sent.push(m) } };
	const now = Date.UTC(2026, 9, 24, 10);
	sql.prepare("INSERT INTO accounts (id, email, created_at, plan) VALUES ('a1', 'owner@b.com', 0, 'solo')").run();
	sql.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES ('b.com', 'a1', 0)").run();
	await addTrigger(db, "b.com", { name: "Order placed", kind: "page", pattern: "/thank-you", notify: "email", webhook: "https://hooks.slack.com/services/T/B/x" }, now);
	await addTrigger(db, "b.com", { name: "Amazon click", kind: "link", pattern: "amazon.", notify: "daily", webhook: null }, now);
	assert.equal(await fireTriggers(env, "b.com", hit("view", "/thank-you"), now, poster), 1);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].to, "owner@b.com");
	assert.match(sent[0].text, /Order placed on b\.com: on \/thank-you from Google \(GB\)/);
	assert.deepEqual(JSON.parse(posted[0].body), { text: "Order placed on b.com: on /thank-you from Google (GB)" });
	// Up to 50 alert emails a day, and a webhook stops after its daily cap.
	for (let i = 0; i < 55; i++) await fireTriggers(env, "b.com", hit("view", "/thank-you"), now, poster);
	assert.equal(sent.length, 50, "the daily email cap");
	sql.prepare("UPDATE triggers SET sent_n = ? WHERE name = 'Order placed'").run(HOOKS_PER_DAY);
	const before = posted.length;
	await fireTriggers(env, "b.com", hit("view", "/thank-you"), now, poster);
	assert.equal(posted.length, before, "no more webhook posts today");
	assert.equal(await fireTriggers(env, "b.com", hit("outbound", "/review/", "https://amazon.co.uk/dp/1"), now, poster), 1, "a daily round-up trigger sends nothing now");
	assert.equal(sent.length, 50);

	// Counted from visits already recorded, so a new trigger shows its past too.
	const add = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, view_id, path, target) VALUES ('b.com', ?, '2026-10-24', ?, ?, ?, ?, ?)");
	add.run(now, "view", "v1", "a", "/thank-you/", null);
	add.run(now, "view", "v2", "b", "/thank-you", null);
	add.run(now, "outbound", "v1", "a", "/review/", "https://www.amazon.co.uk/dp/1");
	add.run(now, "outbound", "v1", "a", "/review/", "https://www.amazon.co.uk/dp/2");
	assert.deepEqual((await triggerCounts(db, "b.com", "2026-10-24", "2026-10-24")).map((c) => ({ ...c })), [
		{ name: "Order placed", completions: 2, visitors: 2, trigger: 1 },
		{ name: "Amazon click", completions: 2, visitors: 1, trigger: 1 },
	]);
	sql.prepare("DELETE FROM alert_sends").run();
	assert.equal(await sendTriggerRoundups(env, now + 86_400_000), 1);
	assert.match(sent.at(-1).text, /- Amazon click: 2 \(1 visitor\)/);
	assert.ok(!sent.at(-1).text.includes("Order placed"), "only the daily round-up triggers");
});

test("site health: down after two failed looks, one email, then one when it's back; the card lists what's wrong", async () => {
	const { checkSitesUp, siteHealth } = await import("../src/health.ts");
	const { renderDashboard: render } = await import("../src/dashboard.ts");
	const { db, sql } = fakeD1();
	forgetCountedSites();
	const sent: any[] = [];
	const env: Env = { DB: db, SITES: "", APP_HOST: "app.readercount.com", EMAIL: { send: async (m) => void sent.push(m) } };
	const t = Date.UTC(2026, 9, 24, 10);
	sql.prepare("INSERT INTO accounts (id, email, created_at, plan) VALUES ('a1', 'owner@b.com', 0, 'business')").run();
	sql.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES ('b.com', 'a1', 0)").run();
	let status: number | null = 503;
	const checker = async () => status;
	await checkSitesUp(env, t, checker);
	assert.equal(sent.length, 0, "one failed look isn't enough");
	await checkSitesUp(env, t + 300_000, checker);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].subject, "b.com is down");
	assert.match(sent[0].text, /error 503/);
	await checkSitesUp(env, t + 600_000, checker);
	assert.equal(sent.length, 1, "only one down email");
	const down = await siteHealth(db, "b.com", { visitors: 0, previousVisitors: 0, range: "7d" }, t + 600_000);
	assert.equal(down[0].title, "Your website is down");
	status = 200;
	await checkSitesUp(env, t + 900_000, checker);
	assert.equal(sent[1].subject, "b.com is back up");
	assert.match(sent[1].text, /after about 15 minutes/);
	assert.deepEqual(await siteHealth(db, "b.com", { visitors: 0, previousVisitors: 0, range: "7d" }, t + 900_000), []);

	// Switched off in the emails settings: no more down emails.
	sql.prepare("UPDATE accounts SET downs = 0").run();
	status = null;
	await checkSitesUp(env, t + 1_200_000, checker);
	await checkSitesUp(env, t + 1_500_000, checker);
	assert.equal(sent.length, 2);

	const items = await siteHealth(db, "c.com", {
		behaviour: { reading: [], speed: [{ path: "/slow/", n: 9, lcp: 5200, inp: 100, cls: 10, rating: "fix" }], devices: {}, problems: [{ kind: "image", url: "https://c.com/a.png", message: "", n: 25, pages: ["/post/"], browsers: [] }, { kind: "script", url: "https://c.com/a.js", message: "x is undefined:3", n: 2, pages: ["/"], browsers: [] }], forms: [] },
		missing: [{ path: "/old/", views: 3, top_link: "/post/" }],
		visitors: 50, previousVisitors: 200, range: "7d",
	}, t);
	assert.deepEqual(items.map((i) => i.level), ["fix", "fix", "fix", "attention", "attention"], "worst first");
	assert.deepEqual(items.map((i) => i.title), ["1 broken link on your own pages", "1 picture or file didn't load for readers", "1 page slow to load", "1 script error in readers' browsers", "Visitors are down sharply"]);
	const report = await buildReport(db, "c.com", "7d", t, false);
	const html = render(report, ["c.com"], { health: items });
	assert.ok(html.includes("Site Health") && html.includes("Requires fix") && html.includes("5.2 seconds"));
	assert.ok(render(report, ["c.com"], { health: [] }).includes("Site health: all clear"));
	assert.ok(!render(report, ["c.com"], { health: items, shared: true }).includes("Site Health"), "never on public pages");
});

test("site health: visits stopped only when every day last week was busy, not after one busy launch week", async () => {
	const { siteHealth } = await import("../src/health.ts");
	const { db, sql } = fakeD1();
	const now = Date.UTC(2026, 9, 30, 13);
	const ev = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, path) VALUES (?, ?, ?, 'view', 'v', '/')");
	const add = (site: string, counts: number[]) => counts.forEach((c, i) => {
		const day = `2026-10-${22 + i}`;
		for (let j = 0; j < c; j++) ev.run(site, Date.parse(day + "T12:00:00Z"), day);
	});
	const input = { visitors: 0, previousVisitors: 0, range: "7d" };
	// Busy while being tested, then quiet: an average of 47 a day, but only 9 on the quietest day.
	add("launch.com", [108, 91, 62, 38, 9, 11, 9]);
	assert.deepEqual((await siteHealth(db, "launch.com", input, now)).map((i) => i.title), []);
	add("busy.com", [30, 25, 40, 22, 35, 28, 31]);
	const items = await siteHealth(db, "busy.com", input, now);
	assert.equal(items[0].title, "Visits have stopped arriving");
	assert.match(items[0].detail, /at least 22 a day all week/);
	// A day with no visits at all in the week means gaps are normal for this site.
	add("gappy.com", [50, 50, 50, 0, 50, 50, 50]);
	assert.deepEqual(await siteHealth(db, "gappy.com", input, now), []);
});

test("site problems: a file on the home page is linked once, not a link inside a link", () => {
	const html = renderDashboard(sampleReport("7d", Date.UTC(2026, 9, 28)), ["yourblog.com"], { demo: true });
	assert.ok(html.includes('<a class="ln" href="https://yourblog.com/assets/menu.js" target="_blank" rel="noopener noreferrer">https://yourblog.com/assets/menu.js</a>'));
	assert.doesNotMatch(html, /href="<a /, "the home page address isn't linked again inside the file's link");
	assert.doesNotMatch(html, /<\/a>assets\/menu\.js/);
});

test("bounce advice: landing pages most people leave straight away, with the likeliest reason", async () => {
	const { bounceFixes } = await import("../src/fixes.ts");
	const { db, sql } = fakeD1();
	const t = Date.UTC(2026, 9, 20, 10);
	const add = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, view_id, path, source, device, scroll, lcp) VALUES ('b.com', ?, '2026-10-20', 'view', ?, ?, ?, ?, ?, ?, ?)");
	let id = 0;
	// /good/: 100 visits, 30 bounce. /slow/: 60 visits on phones, 54 bounce, 5 seconds to load. /short/: 60 on computers, 50 bounce, barely scrolled.
	for (let i = 0; i < 100; i++) {
		add.run(t + i, "g" + i, "x" + id++, "/good/", "Google", "desktop", 80, 1500);
		if (i >= 30) add.run(t + 1000 + i, "g" + i, "x" + id++, "/other/", "", "desktop", 50, 1500);
	}
	for (let i = 0; i < 60; i++) {
		add.run(t + i, "s" + i, "x" + id++, "/slow/", "Google", "mobile", 20, 5000);
		if (i >= 54) add.run(t + 1000 + i, "s" + i, "x" + id++, "/other/", "", "mobile", 50, 1500);
	}
	for (let i = 0; i < 60; i++) {
		add.run(t + i, "h" + i, "x" + id++, "/short/", "Google", "desktop", 15, 1200);
		if (i >= 50) add.run(t + 1000 + i, "h" + i, "x" + id++, "/other/", "", "desktop", 50, 1500);
	}
	const fixes = await bounceFixes(db, "b.com", "2026-10-01", "2026-10-28");
	assert.deepEqual(fixes.map((f) => f.page).sort(), ["/short/", "/slow/"]);
	const slow = fixes.find((f) => f.page === "/slow/")!;
	assert.equal(slow.kind, "bounce");
	assert.match(slow.what, /^90% of the 60 people who landed here left/);
	assert.match(slow.what, /5\.0 seconds/);
	assert.match(fixes.find((f) => f.page === "/short/")!.what, /don't scroll past the first third/);
	const page = renderDashboard(await buildReport(db, "b.com", "7d", t, false), ["b.com"], { fixes });
	assert.ok(page.includes("High bounce rate"));
});

test("triggers in Settings: added and removed from the stats page, counted under Goals, and set off by a real visit", async () => {
	const { forgetTriggers } = await import("../src/triggers.ts");
	const { db, sql } = fakeD1();
	forgetTriggers();
	const sent: { to: string; subject: string; text: string }[] = [];
	const env: Env = { DB: db, SITES: "", APP_HOST: "app.readercount.com", MCP_HOST: "mcp.readercount.com", EMAIL: { send: async (m) => void sent.push(m) } };
	const app = (path: string, init: RequestInit = {}) => worker.fetch(new Request("https://app.readercount.com" + path, { redirect: "manual", ...init }), env);
	const post = (path: string, form: Record<string, string>, cookie: string, origin = "https://app.readercount.com") =>
		app(path, { method: "POST", body: new URLSearchParams(form), headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } });
	sql.prepare("INSERT INTO accounts (id, email, created_at, plan) VALUES ('owner', 'me@example.com', 1, 'solo')").run();
	sql.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES ('myblog.co.uk', 'owner', 1)").run();
	sql.prepare("INSERT INTO sessions (token_hash, account_id, expires) VALUES (?, 'owner', ?)").run(await sha256("tok-a1"), Date.now() + 86_400_000);
	forgetCountedSites();
	const me = "rc_account=tok-a1";

	assert.equal((await post("/triggers", { site: "myblog.co.uk", name: "Thanks", kind: "page", pattern: "/thanks" }, me, "https://evil.example")).status, 403);
	assert.equal((await post("/triggers", { site: "theirs.com", name: "Thanks", kind: "page", pattern: "/thanks" }, me)).status, 404);
	assert.equal((await post("/triggers", { site: "myblog.co.uk", name: "Thanks", kind: "page", pattern: "thanks" }, me)).status, 400);
	const added = await post("/triggers", { site: "myblog.co.uk", name: "Thanks page", kind: "page", pattern: "/thanks", notify: "email" }, me);
	assert.equal(added.status, 303);
	assert.match(added.headers.get("Location") ?? "", /triggers=added#triggers/);

	await record(hitRequest({ k: "v", s: "myblog.co.uk", u: "https://myblog.co.uk/thanks/", r: "https://www.bing.com/", v: "t1" }), env, Date.now());
	assert.equal(sent.length, 1, "a visit to the page sets it off");
	assert.match(sent[0].text, /Thanks page on myblog\.co\.uk: on \/thanks\/ from Bing/);

	const home = await (await app("/?site=myblog.co.uk&range=today", { headers: { Cookie: me } })).text();
	for (const text of ["Triggers", "Thanks page", "Page visited: /thanks", "Email me each time", ">Trigger</span>", "Site health", "Site down alerts", "Connect a network", "Connect network"]) assert.ok(home.includes(text), text);
	assert.equal((await post("/affiliates", { site: "myblog.co.uk", network: "awin", account: "", token: "" }, me)).status, 400);
	assert.equal((await post("/affiliates", { site: "theirs.com", network: "awin", account: "1", token: "t" }, me)).status, 404);

	const id = String((sql.prepare("SELECT id FROM triggers").get() as { id: number }).id);
	assert.equal((await post("/triggers/remove", { site: "myblog.co.uk", id }, me)).status, 303);
	assert.equal((sql.prepare("SELECT COUNT(*) AS n FROM triggers").get() as { n: number }).n, 0);

	// The site down email switch.
	assert.equal((await post("/downs", {}, me)).status, 303);
	assert.equal((sql.prepare("SELECT downs FROM accounts").get() as { downs: number }).downs, 0);
});

test("affiliate networks: Awin, Impact and CJ read nightly, exact per post when the network says the page", async () => {
	const { readSales, connectNetwork, syncAffiliates, networksFor, disconnectNetwork, pageFrom } = await import("../src/affiliates.ts");
	const { earningsByPage } = await import("../src/earnings.ts");
	assert.equal(pageFrom("b.com", "", "https://www.b.com/best-vpn/?x=1"), "/best-vpn/");
	assert.equal(pageFrom("b.com", "/kettle/#top"), "/kettle/");
	assert.equal(pageFrom("b.com", "abc123", "https://other.com/x/"), "", "a sub-ID that isn't a page, and someone else's page, say nothing");

	const calls: { url: string; init: RequestInit }[] = [];
	const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
	const get = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		if (url.startsWith("https://api.awin.com/")) return json([
			{ transactionDate: "2026-10-20T10:00:00", commissionAmount: { amount: 4.5, currency: "GBP" }, advertiserName: "Currys", commissionStatus: "pending", publisherUrl: "https://b.com/best-tv/" },
			{ transactionDate: "2026-10-21T10:00:00", commissionAmount: { amount: 2, currency: "GBP" }, advertiserName: "Currys", commissionStatus: "approved", clickRefs: {} },
			{ transactionDate: "2026-10-21T11:00:00", commissionAmount: { amount: 9, currency: "GBP" }, advertiserName: "Currys", commissionStatus: "declined" },
		]);
		if (url.startsWith("https://api.impact.com/")) return url.includes("Page=2") ? json({ Actions: [{ EventDate: "2026-10-22T09:00:00-07:00", Payout: "1.25", CampaignName: "NordVPN", State: "APPROVED", SubId1: "/best-vpn/" }] }) : json({ Actions: [{ EventDate: "2026-10-22T08:00:00-07:00", Payout: "3.00", CampaignName: "NordVPN", State: "PENDING", SubId1: "/best-vpn/" }, { EventDate: "2026-10-22", Payout: "5", State: "REVERSED" }], "@nextpageuri": "/Mediapartners/IR1/Actions?Page=2" });
		if (url === "https://commissions.api.cj.com/query") return String(init.body).includes("bad") ? json({ errors: [{ message: "Not authorised" }] }) : json({ data: { publisherCommissions: { records: [{ postingDate: "2026-10-23T00:00:00Z", pubCommissionAmountUsd: 7.1, advertiserName: "Fastmail", shopperId: "", clickReferringURL: "https://b.com/fastmail-review/" }] } } });
		return json({}, 404);
	}) as unknown as typeof fetch;

	const awin = await readSales("awin", "b.com", "12345", "tok", "2026-10-01", "2026-10-24", get);
	assert.deepEqual(awin, [{ day: "2026-10-20", shop: "Currys", pence: 450, page: "/best-tv/" }, { day: "2026-10-21", shop: "Currys", pence: 200, page: "" }], "declined sales left out");
	assert.equal(calls[0].init.headers && (calls[0].init.headers as Record<string, string>).Authorization, "Bearer tok");
	assert.match(calls[0].url, /publishers\/12345\/transactions\/\?startDate=2026-10-01T00%3A00%3A00&endDate=2026-10-24T23%3A59%3A59/);
	const impact = await readSales("impact", "b.com", "IR1", "secret", "2026-10-01", "2026-10-24", get);
	assert.deepEqual(impact.map((s) => s.pence), [300, 125], "reversed left out, and the next page read");
	assert.equal((calls.at(-1)!.init.headers as Record<string, string>).Authorization, `Basic ${btoa("IR1:secret")}`);
	assert.deepEqual(await readSales("cj", "b.com", "777", "pat", "2026-10-01", "2026-10-24", get), [{ day: "2026-10-23", shop: "Fastmail", pence: 710, page: "/fastmail-review/" }]);
	await assert.rejects(readSales("cj", "b.com", "bad", "pat", "2026-10-01", "2026-10-24", get), /CJ said: Not authorised/);

	const { db, sql } = fakeD1();
	const env = { DB: db, ADMIN_PASSWORD: "k" };
	const now = Date.UTC(2026, 9, 24, 12);
	assert.deepEqual(await connectNetwork(env, "b.com", "awin", "12 34", "tok", 3, now, get), { error: "That Publisher ID doesn't look right. Copy it again from Awin." });
	assert.deepEqual(await connectNetwork(env, "b.com", "awin", "12345", "tok", 3, now, get), { sales: 2 });
	assert.deepEqual(await connectNetwork(env, "b.com", "impact", "IR1", "secret", 1, now, get), { error: "Your plan connects up to 1 networks for each website. Disconnect one first." });
	const stored = sql.prepare("SELECT token FROM affiliate_links").get() as { token: string };
	assert.ok(!stored.token.includes("tok") && stored.token.length > 20, "the token is kept encrypted");

	// The unattributed Currys sale is shared by clicks; the one Awin tied to a page goes to that page.
	const add = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, view_id, path, target) VALUES ('b.com', 1, '2026-10-21', 'outbound', 'v', 'x', ?, ?)");
	add.run("/tv-deals/", "https://www.currys.co.uk/tv");
	add.run("/tv-deals/", "https://www.currys.co.uk/tv2");
	add.run("/sale/", "https://www.currys.co.uk/tv");
	sql.prepare("INSERT INTO earnings (site, day, shop, pence) VALUES ('b.com', '2026-10-21', 'Currys', 300)").run();
	assert.deepEqual((await earningsByPage(db, "b.com", "2026-10-01", "2026-10-24")).map((x) => ({ ...x })), [{ path: "/best-tv/", pence: 450 }, { path: "/tv-deals/", pence: 333 }, { path: "/sale/", pence: 167 }]);

	// Nightly: a token the network now refuses shows on Settings, and the figures stay.
	const refuse = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
	await syncAffiliates(env, now + 86_400_000, refuse);
	const [state] = await networksFor(db, "b.com");
	assert.equal(state.error, "Awin didn't accept those details. Check the ID and token, then connect again.");
	assert.equal(state.syncedAt, now);
	await syncAffiliates(env, now + 86_400_000, get);
	assert.equal((await networksFor(db, "b.com"))[0].error, null);
	await disconnectNetwork(db, "b.com", "awin");
	assert.equal((sql.prepare("SELECT COUNT(*) AS n FROM affiliate_earnings").get() as { n: number }).n, 0);
});

test("site problems: trackers stopped by ad blockers aren't reported as broken files", async () => {
	const { blockedTracker } = await import("../src/behaviour.ts");
	assert.ok(blockedTracker({ kind: "file", url: "https://static.cloudflareinsights.com/beacon.min.js/vce70182" }));
	assert.ok(blockedTracker({ kind: "file", url: "https://www.googletagmanager.com/gtag/js?id=G-1" }));
	assert.ok(!blockedTracker({ kind: "file", url: "https://b.com/app.js" }));
	assert.ok(!blockedTracker({ kind: "image", url: "https://b.com/logo.png" }));
});

test("site problems: a picture or file whose address is the page itself isn't reported", async () => {
	const { pageItself } = await import("../src/behaviour.ts");
	assert.ok(pageItself({ kind: "image", url: "https://example.org/" }, "example.org", ["/"]));
	assert.ok(pageItself({ kind: "file", url: "https://www.example.org/mail/" }, "example.org", ["/mail/"]));
	assert.ok(!pageItself({ kind: "image", url: "https://example.org/" }, "example.org", ["/", "/mail/"]), "seen on another page too, so it's a real address");
	assert.ok(!pageItself({ kind: "image", url: "https://cdn.example.com/" }, "example.org", ["/"]));
	assert.ok(!pageItself({ kind: "script", url: "https://example.org/" }, "example.org", ["/"]), "script errors in the page itself still count");
	assert.ok(!pageItself({ kind: "image", url: "https://example.org/logo.png" }, "example.org", ["/"]));
});

test("site problems: \"Script error.\" with no details isn't reported, as there's nothing to fix", async () => {
	const { hiddenError } = await import("../src/behaviour.ts");
	assert.ok(hiddenError({ kind: "script", message: "Script error.:0" }));
	assert.ok(hiddenError({ kind: "script", message: "Script error." }));
	assert.ok(!hiddenError({ kind: "script", message: "TypeError: x is undefined:12" }));
	assert.ok(!hiddenError({ kind: "image", message: "" }));
});

test("today against yesterday: the period before stops at the same time of day", async () => {
	const { db, sql } = fakeD1();
	const now = Date.parse("2026-10-28T09:00:00Z");
	const ins = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, view_id, path, source, country, device, browser, duration) VALUES ('b.com', ?, ?, ?, ?, ?, '/', '', 'GB', 'desktop', 'Safari', 30)");
	ins.run(Date.parse("2026-10-28T08:00:00Z"), "2026-10-28", "view", "a", "v1");
	ins.run(Date.parse("2026-10-27T08:30:00Z"), "2026-10-27", "view", "b", "v2");
	ins.run(Date.parse("2026-10-27T08:31:00Z"), "2026-10-27", "outbound", "b", "v2");
	ins.run(Date.parse("2026-10-27T15:00:00Z"), "2026-10-27", "view", "c", "v3");
	ins.run(Date.parse("2026-10-27T15:01:00Z"), "2026-10-27", "outbound", "c", "v3");
	const r = await buildReport(db, "b.com", "today", now);
	assert.deepEqual([r.previous.visitors, r.previous.views, r.previous.clicks], [1, 1, 1], "yesterday afternoon isn't counted yet");
});

test("google searches: dates after Google's latest figures show its latest week, not nothing", async () => {
	const { searchReport } = await import("../src/google.ts");
	const { db, sql } = fakeD1();
	sql.prepare("INSERT INTO search_days (site, day, clicks, impressions, position) VALUES ('b.com', '2026-10-22', 2, 40, 8)").run();
	sql.prepare("INSERT INTO search (site, day, query, page, clicks, impressions, position) VALUES ('b.com', '2026-10-22', 'best email', '/', 2, 40, 8)").run();
	const today = await searchReport(db, "b.com", "2026-10-25", "2026-10-25");
	assert.ok(today.late && today.from === "2026-10-16" && today.to === "2026-10-22");
	assert.deepEqual(today.queries.map((q) => q.query), ["best email"]);
	const month = await searchReport(db, "b.com", "2026-09-26", "2026-10-25");
	assert.ok(!month.late && month.from === "2026-09-26", "a range that includes Google's days is left alone");
});

test("site health: broken link pages are full addresses that open them", async () => {
	const { healthCard } = await import("../src/dashboard.ts");
	const { siteHealth } = await import("../src/health.ts");
	const { db } = fakeD1();
	const items = await siteHealth(db, "example.org", { broken: [{ target: "https://github.com/x/y", pages: [{ path: "/mail/" }] }], visitors: 0, previousVisitors: 0, range: "today" }, Date.UTC(2026, 9, 25));
	const html = healthCard(items);
	assert.ok(html.includes('<a class="ln" href="https://example.org/mail/" target="_blank"'), "page links");
	assert.ok(html.includes('<a class="ln" href="https://github.com/x/y" target="_blank"'), "broken link links");
});

test("affiliate networks: Rakuten, Partnerize, Skimlinks, Sovrn and PartnerStack", async () => {
	const { readSales, connectNetwork, syncAffiliates, pageFrom } = await import("../src/affiliates.ts");
	assert.equal(pageFrom("b.com", "%2Fbest-vpn%2F"), "/best-vpn/", "an encoded sub-ID still finds its post");
	const calls: { url: string; init: RequestInit }[] = [];
	const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
	const get = (async (url: string, init: RequestInit = {}) => {
		calls.push({ url, init });
		if (url.startsWith("https://ran-reporting.rakutenmarketing.com/")) return new Response("Member ID (U1),Advertiser Name,Transaction Date,Total Commission\n/best-shoes/,Nike,10/20/26,4.20\n,Nike,10/21/2026,\"1,000.00\"\n");
		if (url.startsWith("https://api.partnerize.com/")) return json({ conversions: [{ conversion_data: { conversion_time: "2026-10-20 10:00:00", campaign_title: "Apple", publisher_reference: "%2Fipad-review%2F", conversion_value: { conversion_status: "approved", publisher_commission: 12.5 } } }, { conversion_data: { conversion_time: "2026-10-21 10:00:00", campaign_title: "Apple", conversion_value: { conversion_status: "rejected", publisher_commission: 99 } } }] });
		if (url === "https://authentication.skimapis.com/access_token") return JSON.parse(String(init.body)).client_secret === "s" ? json({ access_token: "AT" }) : json({}, 401);
		if (url.startsWith("https://reporting.skimapis.com/")) return json({ commissions: [{ transaction_details: { transaction_date: "2026-10-22", basket: { publisher_amount: 3.3 }, status: "active" }, merchant_details: { merchant_name: "John Lewis" }, click_details: { custom_id: "", page_url: "https://b.com/kettles/" } }] });
		if (url.startsWith("https://viglink.io/")) return json({ transactions: [{ commissionDate: "2026-10-23", merchantName: "Argos", publisherRevenue: 2, cuid: "/toasters/" }, { commissionDate: "2026-08-01", merchantName: "Argos", publisherRevenue: 50, cuid: "/old/" }] });
		if (url.startsWith("https://api.partnerstack.com/")) return json({ data: { items: [{ key: "r1", created_at: Date.UTC(2026, 9, 22), amount: 1500, company: { name: "Fastmail" } }], has_more: false } });
		return json({}, 404);
	}) as unknown as typeof fetch;

	const link = "https://ran-reporting.rakutenmarketing.com/en/reports/signature-orders-report/filters?start_date=2026-01-01&end_date=2026-01-31&network=3&token=ABC";
	assert.deepEqual(await readSales("rakuten", "b.com", "123", link, "2026-10-01", "2026-10-24", get), [{ day: "2026-10-20", shop: "Nike", pence: 420, page: "/best-shoes/" }, { day: "2026-10-21", shop: "Nike", pence: 100_000, page: "" }]);
	assert.match(calls.at(-1)!.url, /start_date=2026-10-01&end_date=2026-10-24.*token=ABC|token=ABC.*start_date=2026-10-01/, "the owner's link, with our dates");
	assert.deepEqual(await readSales("partnerize", "b.com", "P1", "user", "2026-10-01", "2026-10-24", get, "app"), [{ day: "2026-10-20", shop: "Apple", pence: 1250, page: "/ipad-review/" }], "rejected left out");
	assert.equal((calls.at(-1)!.init.headers as Record<string, string>).Authorization, `Basic ${btoa("app:user")}`);
	assert.deepEqual(await readSales("skimlinks", "b.com", "55", "c", "2026-10-01", "2026-10-24", get, "s"), [{ day: "2026-10-22", shop: "John Lewis", pence: 330, page: "/kettles/" }]);
	assert.deepEqual(await readSales("sovrn", "b.com", "My blog", "sk", "2026-10-01", "2026-10-24", get), [{ day: "2026-10-23", shop: "Argos", pence: 200, page: "/toasters/" }], "only the days asked for");
	assert.deepEqual(await readSales("partnerstack", "b.com", "Me", "pk", "2026-10-01", "2026-10-24", get), [{ day: "2026-10-22", shop: "Fastmail", pence: 1500, page: "" }], "PartnerStack gives cents already");

	const { db, sql } = fakeD1();
	const env = { DB: db, ADMIN_PASSWORD: "k" };
	const now = Date.UTC(2026, 9, 24, 12);
	assert.deepEqual(await connectNetwork(env, "b.com", "partnerize", "P1", "user", 3, now, get), { error: "Partnerize needs two keys. Paste your Application key too." });
	assert.deepEqual(await connectNetwork(env, "b.com", "rakuten", "123", "https://evil.example/?token=1", 3, now, get), { error: "Paste the report's API link from Rakuten: it starts with https:// and has token= in it." });
	assert.deepEqual(await connectNetwork(env, "b.com", "skimlinks", "55", "c", 3, now, get, "wrong"), { error: "Skimlinks didn't accept those details. Check the ID and token, then connect again." });
	assert.deepEqual(await connectNetwork(env, "b.com", "skimlinks", "55", "c", 3, now, get, "s"), { sales: 1 });
	const stored = sql.prepare("SELECT token FROM affiliate_links").get() as { token: string };
	assert.ok(!stored.token.includes("s\n") && stored.token.length > 20, "both keys kept encrypted");
	calls.length = 0;
	await syncAffiliates(env, now + 86_400_000, get);
	assert.equal(JSON.parse(String(calls[0].init.body)).client_secret, "s", "the second key comes back out for the nightly read");
});

test("link tagging: the tagger is added only for websites with a network, and adds the post as each network's sub-ID", async () => {
	const { TAGGER } = await import("../src/tracker.ts");
	const { setTagging } = await import("../src/affiliates.ts");
	const { db, sql } = fakeD1();
	const env: Env = { DB: db, SITES: "" };
	const script = async (page: string) => (await worker.fetch(new Request("https://stats.example/s.js", { headers: { Referer: page } }), env)).text();
	assert.ok(!(await script("https://plain.com/post/")).includes("clickref"), "no network, no tagger");
	sql.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES ('tagged.com', 'a1', 1)").run();
	sql.prepare("INSERT INTO affiliate_links (site, network, account, token, connected_at) VALUES ('tagged.com', 'awin', '1', 'x', 1)").run();
	assert.ok((await script("https://www.tagged.com/other/")).includes("clickref"), "added once a network is connected (www. or not)");
	assert.ok(!(await script("https://elsewhere.com/")).includes("clickref"));
	sql.prepare("INSERT INTO sites (domain, account_id, created_at) VALUES ('quiet.com', 'a1', 1)").run();
	sql.prepare("INSERT INTO affiliate_links (site, network, account, token, connected_at) VALUES ('quiet.com', 'cj', '1', 'x', 1)").run();
	await setTagging(db, "quiet.com", false);
	assert.ok(!(await script("https://quiet.com/")).includes("clickref"), "the owner turned it off");
	assert.ok(gzipSync(TRACKER).length < 2048, "the tracker on its own stays under 2 KB");

	// Run the tagger against a pretend page and links.
	const listeners: Record<string, (e: unknown) => void> = {};
	const document = { addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = f) };
	const location = { pathname: "/best-vpn-uk/", hostname: "myblog.com" };
	new Function("document", "location", TAGGER)(document, location);
	const press = (href: string) => {
		const a = { href };
		listeners.mousedown({ target: { closest: () => a } });
		return a.href.toString();
	};
	assert.equal(press("https://www.awin1.com/cread.php?awinmid=1&awinaffid=2"), "https://www.awin1.com/cread.php?awinmid=1&awinaffid=2&clickref=%2Fbest-vpn-uk%2F");
	assert.equal(press("https://www.awin1.com/cread.php?awinmid=1&clickref=mine"), "https://www.awin1.com/cread.php?awinmid=1&clickref=mine", "the owner's own tag stays");
	assert.match(press("https://www.anrdoezrs.net/click-1-2"), /sid=%2Fbest-vpn-uk%2F$/);
	assert.match(press("https://nordvpn.sjv.io/c/123/456/789"), /subId1=%2Fbest-vpn-uk%2F$/);
	assert.match(press("https://click.linksynergy.com/deeplink?id=x"), /u1=%2Fbest-vpn-uk%2F$/);
	assert.match(press("https://go.skimresources.com/?id=1&url=x"), /xcust=%2Fbest-vpn-uk%2F$/);
	assert.equal(press("https://prf.hn/click/camref:1100l/destination:https%3A%2F%2Fapple.com"), "https://prf.hn/click/camref:1100l/pubref:%2Fbest-vpn-uk%2F/destination:https%3A%2F%2Fapple.com");
	assert.equal(press("https://www.amazon.co.uk/dp/B0?tag=me-21"), "https://www.amazon.co.uk/dp/B0?tag=me-21", "Amazon has no sub-ID");
	assert.equal(press("https://myblog.com/c/1/2/3"), "https://myblog.com/c/1/2/3", "the website's own links are left alone");
});

test("earnings insights: money followed back to sources, searches, shops and devices, with problems found", async () => {
	const { moneyReport, moneyProblems, shareOut, wrongCountry } = await import("../src/money.ts");
	const shares = shareOut(
		[{ day: "2026-10-20", shop: "Amazon", pence: 300, page: "" }, { day: "2026-10-20", shop: "NordVPN", pence: 500, page: "/vpn/" }],
		[
			{ day: "2026-10-20", path: "/a/", target: "https://www.amazon.co.uk/x", source: "Google", country: "GB", device: "mobile", n: 2 },
			{ day: "2026-10-20", path: "/b/", target: "https://www.amazon.co.uk/y", source: "Reddit", country: "GB", device: "desktop", n: 1 },
		],
	);
	assert.deepEqual(shares.map((s) => [s.path, s.source, Math.round(s.pence)]), [["/a/", "Google", 200], ["/b/", "Reddit", 100], ["/vpn/", "", 500]], "shared by clicks, and a sale tied to a post with no clicks still counts for it");
	assert.deepEqual(wrongCountry([{ day: "d", path: "/", target: "https://www.amazon.com/x", source: "", country: "GB", device: "", n: 15 }, { day: "d", path: "/", target: "https://amazon.com/y", source: "", country: "US", device: "", n: 10 }]), [{ store: "amazon.com", country: "US", clicks: 25, elsewhere: 15, top: "GB" }]);

	const { db, sql } = fakeD1();
	const now = Date.UTC(2026, 9, 26, 12);
	const day = (back: number) => new Date(now - back * 86_400_000).toISOString().slice(0, 10);
	const ev = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, view_id, path, target, source, country, device) VALUES ('b.com', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
	for (let i = 0; i < 40; i++) {
		ev.run(day(3), "view", `g${i}`, `vg${i}`, "/vpn/", null, "Google", "GB", "mobile");
		ev.run(day(3), "outbound", `g${i}`, `vg${i}`, "/vpn/", "https://www.awin1.com/cread.php?awinmid=1&ued=https%3A%2F%2Fnordvpn.com", null, "GB", "mobile");
		ev.run(day(3), "outbound", `g${i}`, `vg${i}`, "/vpn/", "https://www.amazon.com/dp/1?tag=x", null, "GB", "mobile");
	}
	for (let i = 0; i < 10; i++) ev.run(day(3), "view", `r${i}`, `vr${i}`, "/vpn/", null, "Reddit", "GB", "desktop");
	const sale = sql.prepare("INSERT INTO affiliate_earnings (site, network, day, shop, page, pence) VALUES ('b.com', 'awin', ?, 'NordVPN', ?, ?)");
	sale.run(day(3), "/vpn/", 2000);
	for (let w = 2; w <= 5; w++) sale.run(day(w * 7), "/vpn/", 5000);
	sql.prepare("INSERT INTO search (site, day, query, page, clicks, impressions, position) VALUES ('b.com', ?, ?, '/vpn/', ?, 500, ?)").run(day(3), "best vpn uk", 30, 7.4);
	sql.prepare("INSERT INTO search (site, day, query, page, clicks, impressions, position) VALUES ('b.com', ?, ?, '/vpn/', ?, 500, ?)").run(day(3), "nordvpn deal", 10, 7.4);
	sql.prepare("INSERT INTO search (site, day, query, page, clicks, impressions, position) VALUES ('b.com', ?, ?, '/vpn/', ?, 500, ?)").run(day(40), "best vpn uk", 60, 2.6);

	const m = (await moneyReport(db, "b.com", day(29), day(0), now))!;
	assert.equal(m.total, 17000, "this week's £20 and the £50 weeks before it");
	assert.deepEqual(m.sources.map((s) => [s.name, s.pence, s.visitors]), [["Google", 17000, 40]], "all the clicks came from Google readers");
	assert.deepEqual(m.searches.map((s) => [s.name, s.pence]), [["best vpn uk", 12750], ["nordvpn deal", 4250]], "shared by the clicks each search brought");
	assert.deepEqual(m.shops.find((s) => s.name === "Amazon"), { name: "Amazon", pence: 0, clicks: 40 }, "clicks with no sales show");
	assert.deepEqual(m.devices.map((d) => d.name), ["mobile"]);
	assert.equal(m.update.length, 1);
	assert.match(m.update[0].why, /Slipped from 3rd to 7th on Google/);
	assert.equal(m.wrongCountry[0].store, "amazon.com");
	const problems = await moneyProblems(db, "b.com", now);
	assert.match(problems.map((p) => p.title).join(" | "), /Affiliate earnings are down sharply/, "£20 this week against £50 a week before");

	// The Claude connector answers the same.
	const { handleMcp } = await import("../src/mcp.ts");
	const res = await handleMcp(new Request("https://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_earnings", arguments: { site: "b.com", period: "30d" } } }) }), db, ["b.com"], now);
	const out = JSON.parse((await res.json()).result.content[0].text);
	assert.equal(out.total_gbp, 170);
	assert.equal(out.posts[0].page, "/vpn/");
	assert.equal(out.posts[0].per_1000_readers_gbp, 3400, "£170 from 50 readers");
});

test("AdSense: one Google sign-in, nightly earnings by day, website and URL channel, ad money shared by views", async () => {
	const { finishAdsense, adsenseState, disconnectAdsense, channelPage } = await import("../src/adsense.ts");
	const { earningsByPage } = await import("../src/earnings.ts");
	assert.deepEqual(channelPage("www.b.com/best-vpn/"), { site: "b.com", path: "/best-vpn/" });
	assert.equal(channelPage("b.com"), null, "a whole-site channel isn't a post");

	const { db, sql } = fakeD1();
	const env = { DB: db, ADMIN_PASSWORD: "k", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec" };
	const now = Date.UTC(2026, 9, 26, 12);
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT" }))) as typeof fetch;
	const asked: string[] = [];
	const get = (async (url: string) => {
		asked.push(url);
		if (url.endsWith("/v2/accounts")) return new Response(JSON.stringify({ accounts: [{ name: "accounts/pub-123" }] }));
		return new Response(JSON.stringify({
			headers: [{ name: "DATE" }, { name: "DOMAIN_NAME" }, { name: "URL_CHANNEL_NAME" }, { name: "ESTIMATED_EARNINGS" }],
			rows: [
				{ cells: [{ value: "2026-10-24" }, { value: "b.com" }, { value: "" }, { value: "3.00" }] },
				{ cells: [{ value: "2026-10-24" }, { value: "b.com" }, { value: "b.com/best-vpn/" }, { value: "1.50" }] },
				{ cells: [{ value: "2026-10-24" }, { value: "someone-else.com" }, { value: "" }, { value: "9.00" }] },
			],
		}));
	}) as unknown as typeof fetch;
	try {
		assert.equal(await finishAdsense(env, "acc1", "https://app.readercount.com", "code", ["b.com"], now, get), null);
	} finally {
		globalThis.fetch = realFetch;
	}
	assert.match(asked[1], /accounts\/pub-123\/reports:generate\?dateRange=CUSTOM.*dimensions=DATE&dimensions=DOMAIN_NAME&dimensions=URL_CHANNEL_NAME&metrics=ESTIMATED_EARNINGS/);
	const state = await adsenseState(db, "acc1");
	assert.equal(state.account, "accounts/pub-123");
	assert.ok(!(sql.prepare("SELECT token FROM adsense_links").get() as { token: string }).token.includes("RT"), "the refresh token is kept encrypted");

	const view = sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, view_id, path) VALUES ('b.com', 1, '2026-10-24', 'view', ?, ?, ?)");
	for (let i = 0; i < 3; i++) view.run(`v${i}`, `a${i}`, "/popular/");
	view.run("w", "b1", "/quiet/");
	assert.deepEqual((await earningsByPage(db, "b.com", "2026-10-01", "2026-10-26")).map((x) => ({ ...x })), [{ path: "/popular/", pence: 225 }, { path: "/best-vpn/", pence: 150 }, { path: "/quiet/", pence: 75 }], "the URL channel's post exactly; the rest by views; other websites ignored");

	await disconnectAdsense(env, "acc1", ["b.com"], (async () => new Response("")) as unknown as typeof fetch);
	assert.equal((sql.prepare("SELECT COUNT(*) AS n FROM affiliate_earnings").get() as { n: number }).n, 0);
	assert.equal((await adsenseState(db, "acc1")).connected, false);
});

test("shops and websites show their own logo, fetched through our address, with the letter underneath", async () => {
	assert.match(iconFor("Amazon"), /<img src="\/logo\/amazon\.com"[^>]*onerror="this\.remove\(\)"/);
	assert.match(iconFor("currys.co.uk"), /logo\/currys\.co\.uk"/);
	assert.match(iconFor("Currys"), /^<span class="ic" [^>]*>C<\/span>$/);
	assert.doesNotMatch(iconFor("Google"), /<img/);

	const seen: string[] = [];
	const png = (async (u: string) => (seen.push(u), new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } }))) as unknown as typeof fetch;
	const ok = await logo("amazon.com", undefined, png);
	assert.equal(ok.status, 200);
	assert.equal(ok.headers.get("Content-Type"), "image/png");
	assert.match(seen[0], /domain=amazon\.com&sz=64$/);
	const none = await logo("nosuchshop.com", undefined, (async () => new Response("", { status: 404 })) as unknown as typeof fetch);
	assert.equal(none.status, 404);
	assert.equal((await logo("evil.com/../x", undefined, png)).status, 404);
	assert.equal(seen.length, 1);
	assert.equal((await worker.fetch(new Request("https://app.readercount.com/logo/a b"), {} as Env)).status, 404);
});

test("a website source gets open, copy and find links; named sources don't", () => {
	const l = sourceLinks("aocr.org", "www.paulobrien.com");
	assert.equal(l.out, "https://aocr.org/");
	assert.equal(l.copy, "https://aocr.org/");
	assert.equal(l.find, `https://www.google.com/search?q=${encodeURIComponent('site:aocr.org "paulobrien.com"')}`);
	assert.deepEqual(sourceLinks("Google", "paulobrien.com"), {});
	assert.deepEqual(sourceLinks("newsletter", "paulobrien.com"), {});
	assert.deepEqual(sourceLinks("Direct", "paulobrien.com"), {});
});

test("probably robots: one page never on screen is shown to the owner but still counted", async () => {
	const { db, sql } = fakeD1();
	const now = Date.UTC(2026, 10, 1, 12);
	const day = "2026-11-01";
	const add = (visitor: string, kind: string, ts: number, duration: number | null, path = "/", country = "CN") =>
		sql.prepare("INSERT INTO events (site, ts, day, kind, visitor, view_id, path, referrer, source, country, device, browser, os, duration) VALUES ('paulobrien.com', ?, ?, ?, ?, ?, ?, '', '', ?, 'desktop', 'Chrome', 'Windows', ?)").run(ts, day, kind, visitor, visitor + kind, path, country, duration);
	const hour = 3_600_000;
	add("robot", "view", now - 2 * hour, null, "/tools/who-runs-this-email/");
	add("reader", "view", now - 2 * hour, 40, "/", "GB");
	add("quick", "view", now - 2 * hour, null, "/a/", "GB");
	add("quick", "view", now - 2 * hour + 5000, null, "/b/", "GB"); // opened a second page: a person
	add("clicker", "view", now - 2 * hour, null, "/c/", "US");
	add("clicker", "outbound", now - 2 * hour + 500, null, "/c/", "US"); // clicked a link: a person
	add("fresh", "view", now - 60_000, null, "/d/", "US"); // too new to judge
	const report = await buildReport(db, "paulobrien.com", "today", now);
	assert.equal(report.unseen?.visitors, 1);
	assert.equal(report.unseen?.latest[0].path, "/tools/who-runs-this-email/");
	assert.equal(report.totals.visitors, 5, "nothing is taken out of the numbers yet");
	const page = renderDashboard(report, ["paulobrien.com"], { account: { email: "me@example.com", sitesHtml: "", claude: "" } } as never);
	assert.match(page, /Probably robots: 1 visit \(20% of visitors\)/);
	assert.match(page, /China/);
	assert.ok(!renderDashboard(report, ["paulobrien.com"], { shared: true }).includes("Probably robots"), "only the owner sees it");
	assert.equal((await buildReport(db, "paulobrien.com", "today", now, false, { country: "GB" })).unseen, undefined, "not worked out for filtered views");
});
