// ReaderCount: checks that slow down scripts. A per-IP limit (a Workers Rate Limiting binding, see
// wrangler.jsonc) and Cloudflare Turnstile on the sign-in form. Both are skipped when not set up.

export type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

/** True when this key has gone over its limit. No binding (tests, local dev) means no limit. */
export async function overLimit(limiter: Limiter | undefined, key: string): Promise<boolean> {
	if (!limiter) return false;
	try {
		return !(await limiter.limit({ key })).success;
	} catch {
		return false; // A broken limiter never locks people out.
	}
}

export function clientIp(request: Request): string {
	return request.headers.get("CF-Connecting-IP") ?? "";
}

/** Turnstile is on once both the site key (a var) and the secret (`wrangler secret put TURNSTILE_SECRET`) are set. */
export type TurnstileEnv = { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET?: string };

export function turnstileOn(env: TurnstileEnv): boolean {
	return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
}

/** Asks Cloudflare whether the token from the Turnstile box is genuine. */
export async function turnstileOk(secret: string, token: string, ip: string, verify: typeof fetch = fetch): Promise<boolean> {
	if (!token || token.length > 2048) return false;
	try {
		const body = new FormData();
		body.append("secret", secret);
		body.append("response", token);
		if (ip) body.append("remoteip", ip);
		const res = await verify("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
		return Boolean(((await res.json()) as { success?: boolean }).success);
	} catch {
		return false;
	}
}

/** The host name in an Origin header, undefined when there isn't one, "" when it's "null", or null when it's junk. */
export function originHost(request: Request): string | null | undefined {
	const origin = request.headers.get("Origin");
	if (origin === null) return undefined;
	if (origin === "null") return "";
	try {
		return new URL(origin).hostname.toLowerCase();
	} catch {
		return null;
	}
}
