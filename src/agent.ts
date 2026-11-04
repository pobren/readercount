// ReaderCount: work out browser, operating system and device type from the user agent,
// and spot bots so they aren't counted. Nothing from the user agent is stored except these labels.

export type Agent = { browser: string; os: string; device: "desktop" | "mobile" | "tablet" };

const BOT = /bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|pagespeed|pingdom|uptime|monitor|preview|facebookexternalhit|embedly|whatsapp|curl\/|wget\/|python-|go-http|axios\/|node-fetch|java\/|httpclient|okhttp|scrapy|phantomjs|selenium|puppeteer|playwright/i;

export function isBot(ua: string): boolean {
	return ua.trim().length < 10 || BOT.test(ua);
}

export function parseAgent(ua: string): Agent {
	return { browser: browserOf(ua), os: osOf(ua), device: deviceOf(ua) };
}

function browserOf(ua: string): string {
	if (/Edg(e|A|iOS)?\//.test(ua)) return "Edge";
	if (/OPR\/|Opera/.test(ua)) return "Opera";
	if (/SamsungBrowser\//.test(ua)) return "Samsung Internet";
	if (/Firefox\/|FxiOS\//.test(ua)) return "Firefox";
	if (/Chrome\/|CriOS\//.test(ua)) return "Chrome";
	if (/Safari\//.test(ua) && /Version\//.test(ua)) return "Safari";
	if (/AppleWebKit\//.test(ua) && /Mobile\//.test(ua)) return "Safari"; // in-app views on iPhone
	return "Other";
}

function osOf(ua: string): string {
	if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
	if (/Android/.test(ua)) return "Android";
	if (/CrOS/.test(ua)) return "ChromeOS";
	if (/Windows/.test(ua)) return "Windows";
	if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
	if (/Linux/.test(ua)) return "Linux";
	return "Other";
}

function deviceOf(ua: string): Agent["device"] {
	if (/iPad|Tablet|Nexus (7|9|10)|SM-T|Kindle|Silk\//.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return "tablet";
	if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/.test(ua)) return "mobile";
	return "desktop";
}
