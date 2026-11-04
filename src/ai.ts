// ReaderCount: "Found by AI", visits from ChatGPT, Perplexity and other AI services, and the pages they send people to.

/** Each AI service: the source name we store, and the hosts (or utm_source tags) it can also arrive as. */
export const AI_SERVICES: { name: string; hosts: string[] }[] = [
	{ name: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"] },
	{ name: "Perplexity", hosts: ["perplexity.ai"] },
	{ name: "Claude", hosts: ["claude.ai"] },
	{ name: "Gemini", hosts: ["gemini.google.com"] },
	{ name: "Copilot", hosts: ["copilot.microsoft.com", "copilot.cloud.microsoft"] },
	{ name: "DeepSeek", hosts: ["chat.deepseek.com"] },
	{ name: "Meta AI", hosts: ["meta.ai"] },
	{ name: "Grok", hosts: ["grok.com"] },
	{ name: "Le Chat (Mistral)", hosts: ["chat.mistral.ai"] },
	{ name: "Duck.ai", hosts: ["duck.ai"] },
	{ name: "You.com", hosts: ["you.com"] },
	{ name: "Phind", hosts: ["phind.com"] },
];

const BY_ALIAS = new Map(AI_SERVICES.flatMap((s) => [s.name, ...s.hosts].map((a) => [a.toLowerCase(), s.name] as const)));

/** Every stored source that means an AI service, lower case, for SQL: LOWER(source) IN (...). */
export const AI_ALIASES = [...BY_ALIAS.keys()];

/** "ChatGPT" for "chatgpt.com", "ChatGPT" or "www.chatgpt.com"; "" when the source isn't an AI service. */
export function aiService(source: string): string {
	return BY_ALIAS.get(String(source ?? "").toLowerCase().replace(/^www\./, "")) ?? "";
}

export type FoundByAi = {
	/** Visitors from AI services in the dates on screen, and in the same number of days before. */
	visitors: number;
	previous: number;
	services: { name: string; visitors: number }[];
	pages: { path: string; visitors: number }[];
	/** Visitors from AI services each day, oldest first, for the small chart. */
	days: { day: string; visitors: number }[];
};

type Q = <T>(sql: string, ...args: unknown[]) => Promise<T[]>;

/** inRange is the stats page's WHERE clause (site, dates and filters); cur and prev are its values for now and the period before. */
export async function foundByAi(all: Q, inRange: string, cur: unknown[], prev: unknown[], from: string, to: string): Promise<FoundByAi> {
	const ai = `LOWER(COALESCE(source, '')) IN (${AI_ALIASES.map(() => "?").join(", ")})`;
	const V = "COUNT(DISTINCT visitor || day)";
	const [bySource, pages, days, before] = await Promise.all([
		all<{ source: string; visitors: number }>(`SELECT source, ${V} AS visitors FROM events WHERE kind = 'view' AND ${ai} AND ${inRange} GROUP BY source`, ...AI_ALIASES, ...cur),
		all<{ path: string; visitors: number }>(`SELECT path, ${V} AS visitors FROM events WHERE kind = 'view' AND ${ai} AND ${inRange} GROUP BY path ORDER BY visitors DESC LIMIT 20`, ...AI_ALIASES, ...cur),
		all<{ day: string; visitors: number }>(`SELECT day, COUNT(DISTINCT visitor) AS visitors FROM events WHERE kind = 'view' AND ${ai} AND ${inRange} GROUP BY day`, ...AI_ALIASES, ...cur),
		all<{ visitors: number }>(`SELECT ${V} AS visitors FROM events WHERE kind = 'view' AND ${ai} AND ${inRange}`, ...AI_ALIASES, ...prev),
	]);
	// "chatgpt.com" (ChatGPT's own utm_source tag) and "ChatGPT" (from the referrer) are the same service.
	const services = new Map<string, number>();
	for (const s of bySource) {
		const name = aiService(s.source);
		services.set(name, (services.get(name) ?? 0) + Number(s.visitors));
	}
	const perDay = new Map(days.map((d) => [d.day, Number(d.visitors)]));
	const list: { day: string; visitors: number }[] = [];
	for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z"); t += 86_400_000) {
		const day = new Date(t).toISOString().slice(0, 10);
		list.push({ day, visitors: perDay.get(day) ?? 0 });
	}
	return {
		visitors: [...services.values()].reduce((a, b) => a + b, 0),
		previous: Number(before[0]?.visitors ?? 0),
		services: [...services].map(([name, visitors]) => ({ name, visitors })).sort((a, b) => b.visitors - a.visitors),
		pages: pages.map((p) => ({ path: String(p.path), visitors: Number(p.visitors) })),
		days: list,
	};
}
