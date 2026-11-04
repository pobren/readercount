// ReaderCount: turn a referring page into a short, friendly source name ("Google", "Reddit", "example.com").

import { aiService } from "./ai.ts";

const NAMED: [RegExp, string][] = [
	[/(^|\.)google\.[a-z.]+$/, "Google"],
	[/(^|\.)bing\.com$/, "Bing"],
	[/(^|\.)duckduckgo\.com$/, "DuckDuckGo"],
	[/(^|\.)search\.yahoo\.[a-z.]+$|(^|\.)yahoo\.com$/, "Yahoo"],
	[/(^|\.)ecosia\.org$/, "Ecosia"],
	[/(^|\.)search\.brave\.com$/, "Brave Search"],
	[/(^|\.)yandex\.[a-z.]+$/, "Yandex"],
	[/(^|\.)baidu\.com$/, "Baidu"],
	[/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/, "ChatGPT"],
	[/(^|\.)perplexity\.ai$/, "Perplexity"],
	[/(^|\.)claude\.ai$/, "Claude"],
	[/(^|\.)gemini\.google\.com$/, "Gemini"],
	[/(^|\.)facebook\.com$|(^|\.)fb\.com$|^l\.facebook\.com$/, "Facebook"],
	[/(^|\.)instagram\.com$/, "Instagram"],
	[/^t\.co$|(^|\.)twitter\.com$|(^|\.)x\.com$/, "X (Twitter)"],
	[/(^|\.)linkedin\.com$|^lnkd\.in$/, "LinkedIn"],
	[/(^|\.)reddit\.com$/, "Reddit"],
	[/^news\.ycombinator\.com$/, "Hacker News"],
	[/(^|\.)youtube\.com$|^youtu\.be$/, "YouTube"],
	[/(^|\.)pinterest\.[a-z.]+$/, "Pinterest"],
	[/(^|\.)threads\.net$/, "Threads"],
	[/(^|\.)bsky\.app$/, "Bluesky"],
	[/(^|\.)mastodon\.[a-z.]+$/, "Mastodon"],
	[/(^|\.)flipboard\.com$/, "Flipboard"],
	[/(^|\.)news\.google\.com$/, "Google News"],
];

/** The referring site's host without "www.", or "" when there is none or it is the same site. */
export function referrerHost(referrer: string, siteHost: string): string {
	let host: string;
	try {
		host = new URL(referrer).hostname.toLowerCase();
	} catch {
		return "";
	}
	host = host.replace(/^www\./, "");
	const site = siteHost.toLowerCase().replace(/^www\./, "");
	if (!host || host === site || host.endsWith("." + site)) return "";
	return host;
}

export function sourceName(host: string): string {
	if (!host) return "";
	// Google News before Google, as both match.
	if (/^news\.google\.com$/.test(host)) return "Google News";
	if (/^gemini\.google\.com$/.test(host)) return "Gemini";
	const ai = aiService(host);
	if (ai) return ai;
	for (const [re, name] of NAMED) if (re.test(host)) return name;
	return host;
}
