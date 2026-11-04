// A made-up report for tests that render the stats page.
import type { MoneyReport } from "../src/money.ts";
import { RANGES, type Day, type Range, type Report } from "../src/dashboard.ts";
import { utcDay } from "../src/visitor.ts";

export function sampleReport(range: Range, now: number): Report {
	const span = RANGES[range];
	let seed = 7 + span;
	const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
	const makeDay = (t: number, i: number, scale: number): Day => {
		const dow = new Date(t).getUTCDay();
		const visitors = Math.round((span === 1 ? 140 : 180) * scale * (dow === 0 || dow === 6 ? 0.7 : 1) * (0.8 + rnd() * 0.5) * (1 + i / (span * 3)));
		return { day: utcDay(t), visitors, views: Math.round(visitors * (1.35 + rnd() * 0.2)), secs: Math.round(120 + rnd() * 60), bounce: Math.round(52 + rnd() * 12), clicks: Math.round(visitors * (0.12 + rnd() * 0.05)) };
	};
	const days = Array.from({ length: span }, (_, i) => makeDay(now - (span - 1 - i) * 86_400_000, i, 1));
	const prevDays = Array.from({ length: span }, (_, i) => makeDay(now - (2 * span - 1 - i) * 86_400_000, i, 0.88));
	const visitors = days.reduce((a, d) => a + d.visitors, 0);
	const views = days.reduce((a, d) => a + d.views, 0);
	const share = (n: number) => Math.max(1, Math.round(visitors * n));
	const pages = [
		["/best-budget-phones-2026/", 0.22, 184, 0.05],
		["/fastmail-review/", 0.16, 236, 0.04],
		["/", 0.14, 41, 0],
		["/how-to-move-your-email-domain/", 0.11, 312, 0.015],
		["/kindle-colorsoft-review/", 0.08, 201, 0.025],
		["/best-vpn-uk/", 0.07, 158, 0.02],
		["/about/", 0.03, 63, 0],
	].map(([path, s, secs, c]) => ({ path, visitors: share(s as number), views: Math.round(share(s as number) * 1.15), secs, clicks: c ? share(c as number) : 0 }));
	const named = (rows: [string, number][]) => rows.map(([name, s]) => ({ name, visitors: share(s) }));
	return {
		site: "yourblog.com",
		range,
		from: days[0].day,
		to: days.at(-1)!.day,
		totals: { views, visitors, avgSeconds: 148, bounce: 58, now: span === 1 ? 7 : 5, clicks: days.reduce((a, d) => a + (d.clicks ?? 0), 0) },
		previous: { views: Math.round(views * 0.86), visitors: Math.round(visitors * 0.88), clicks: prevDays.reduce((a, d) => a + (d.clicks ?? 0), 0) },
		days,
		prevDays,
		pages,
		entries: pages.map((p, i) => ({ path: p.path, visitors: Math.round(Number(p.visitors) * [0.9, 0.85, 0.6, 0.8, 0.85, 0.8, 0.4][i]) })),
		exits: pages.map((p, i) => ({ path: p.path, visitors: Math.round(Number(p.visitors) * [0.7, 0.75, 0.5, 0.85, 0.65, 0.7, 0.9][i]) })).sort((a, b) => b.visitors - a.visitors),
		sources: named([["Google", 0.41], ["Direct", 0.24], ["Reddit", 0.09], ["newsletter", 0.07], ["X (Twitter)", 0.05], ["DuckDuckGo", 0.04], ["Bing", 0.03], ["ChatGPT", 0.02], ["Perplexity", 0.008], ["Gemini", 0.004], ["Claude", 0.003]]),
		campaigns: named([["october-newsletter", 0.07]]),
		countries: named([["GB", 0.58], ["US", 0.17], ["IE", 0.06], ["AU", 0.04], ["DE", 0.03], ["CA", 0.03]]),
		devices: named([["mobile", 0.61], ["desktop", 0.34], ["tablet", 0.05]]),
		browsers: named([["Safari", 0.46], ["Chrome", 0.41], ["Edge", 0.06], ["Firefox", 0.04], ["Samsung Internet", 0.03]]),
		clicks: [
			["outbound", "https://www.amazon.co.uk/dp/B0EXAMPLE1?tag=yourblog-21", "/best-budget-phones-2026/", 0.05],
			["outbound", "https://www.awin1.com/cread.php?awinmid=1001&p=fastmail.com", "/fastmail-review/", 0.04],
			["outbound", "https://www.amazon.co.uk/dp/B0EXAMPLE2?tag=yourblog-21", "/kindle-colorsoft-review/", 0.025],
			["outbound", "https://nordvpn.com/special/?ref=yourblog", "/best-vpn-uk/", 0.02],
			["download", "https://yourblog.com/files/email-move-checklist.pdf", "/how-to-move-your-email-domain/", 0.015],
		].map(([kind, target, path, s]) => ({ kind, target, path, clicks: share(s as number) })),
		goals: [["Newsletter sign-up", 0.031, 1.05], ["Amazon click", 0.022, 1.4, 1], ["Form: contact", 0.006, 1.1], ["Download checklist", 0.012, 1.2]].map(([name, s, x, trigger]) => ({ name, visitors: share(s as number), completions: Math.round(share(s as number) * (x as number)), ...(trigger ? { trigger: 1 } : {}) })),
		goalSources: named([["Google", 0.012], ["newsletter", 0.009], ["Direct", 0.008], ["Reddit", 0.004]]),
		goalPages: [["/how-to-move-your-email-domain/", 0.014], ["/fastmail-review/", 0.011], ["/", 0.009]].map(([path, s]) => ({ path, visitors: share(s as number) })),
		missing: [["/best-budget-phones-2025/", 0.006, "google.com", "/best-vpn-uk/"], ["/fastmail-review/amp/", 0.003, "Direct", null]].map(([path, s, top_from, top_link]) => ({ path, views: share(s as number), top_from, top_link })),
		behaviour: {
			reading: [["/best-budget-phones-2026/", 0.22, 58, 0.71, 0.34], ["/fastmail-review/", 0.16, 66, 0.8, 0.45], ["/", 0.14, 41, 0.38, 0.12], ["/how-to-move-your-email-domain/", 0.11, 74, 0.86, 0.52], ["/kindle-colorsoft-review/", 0.08, 37, 0.33, 0.11], ["/best-vpn-uk/", 0.07, 49, 0.55, 0.21]].map(([path, s, avg, half, end]) => {
				const v = Math.round(share(s as number) * 1.15);
				return { path: path as string, views: v, avg: avg as number, half: Math.round(v * (half as number)), end: Math.round(v * (end as number)) };
			}),
			speed: [["/kindle-colorsoft-review/", 0.08, 4600, 180, 40, "fix"], ["/best-budget-phones-2026/", 0.22, 3100, 240, 120, "attention"], ["/fastmail-review/", 0.16, 1900, 120, 20, "good"], ["/how-to-move-your-email-domain/", 0.11, 1700, 90, 10, "good"], ["/", 0.14, 1400, 80, 0, "good"]].map(([path, s, lcp, inp, cls, rating]) => ({ path: path as string, n: share(s as number), lcp: lcp as number, inp: inp as number, cls: cls as number, rating: rating as "good" | "attention" | "fix" })),
			devices: { phone: { path: "phone", n: share(0.62), lcp: 2900, inp: 210, cls: 60, rating: "attention" }, computer: { path: "computer", n: share(0.33), lcp: 1600, inp: 90, cls: 20, rating: "good" } },
			problems: [
				{ kind: "image", url: "https://yourblog.com/images/colorsoft-hero.jpg", message: "", n: share(0.02), pages: ["/kindle-colorsoft-review/"], browsers: ["Safari", "Chrome"] },
				{ kind: "file", url: "https://cdn.example-widgets.com/compare.js", message: "", n: share(0.006), pages: ["/best-budget-phones-2026/", "/best-vpn-uk/"], browsers: ["Chrome", "Edge"] },
				{ kind: "script", url: "https://yourblog.com/assets/menu.js", message: "Uncaught TypeError: Cannot read properties of null (reading 'classList'):42", n: share(0.011), pages: ["/", "/about/"], browsers: ["Samsung Internet"] },
			],
			forms: [{ form: "Form: contact", started: share(0.021), sent: share(0.006) }, { form: "Newsletter sign-up", started: share(0.05), sent: share(0.031) }],
		},
		ai: {
			visitors: share(0.02) + share(0.008) + share(0.004) + share(0.003),
			previous: Math.round((share(0.02) + share(0.008) + share(0.004) + share(0.003)) * 0.7),
			services: named([["ChatGPT", 0.02], ["Perplexity", 0.008], ["Gemini", 0.004], ["Claude", 0.003]]),
			pages: [["/best-vpn-uk/", 0.012], ["/how-to-move-your-email-domain/", 0.01], ["/fastmail-review/", 0.008], ["/best-budget-phones-2026/", 0.005]].map(([path, s]) => ({ path: path as string, visitors: share(s as number) })),
			days: days.map((d, i) => ({ day: d.day, visitors: Math.round(d.visitors * 0.035 * (0.6 + i / (span * 1.5)) * (0.6 + rnd() * 0.8)) })),
		},
		earnings: [["/best-budget-phones-2026/", 0.21], ["/fastmail-review/", 0.17], ["/kindle-colorsoft-review/", 0.08], ["/best-vpn-uk/", 0.06]].map(([path, s]) => ({ path: path as string, pence: Math.round(visitors * (s as number) * 9) })),
		money: sampleMoney(visitors, share),
	};
}

/** Made-up Earnings Insights for the demo (src/money.ts), in line with its made-up earnings. */
function sampleMoney(visitors: number, share: (s: number) => number): MoneyReport {
	const total = Math.round(visitors * 0.52 * 9);
	const p = (x: number) => Math.round(total * x);
	return {
		total,
		sources: [["Google", 0.58, 0.46], ["Direct", 0.14, 0.22], ["newsletter", 0.13, 0.06], ["Reddit", 0.09, 0.12], ["ChatGPT", 0.06, 0.02]].map(([name, m, v]) => ({ name: name as string, pence: p(m as number), visitors: share(v as number) })),
		searches: [["best budget phone uk", "/best-budget-phones-2026/", 0.21, 412], ["fastmail review", "/fastmail-review/", 0.17, 298], ["kindle colorsoft review", "/kindle-colorsoft-review/", 0.07, 121], ["fastmail vs proton", "/fastmail-review/", 0.04, 52], ["best vpn uk 2026", "/best-vpn-uk/", 0.03, 64]].map(([name, page, m, clicks]) => ({ name: name as string, page: page as string, pence: p(m as number), clicks: clicks as number })),
		shops: [["Amazon", 0.55, 0.075], ["Fastmail", 0.29, 0.04], ["NordVPN", 0.12, 0.02], ["Currys", 0, 0.012]].map(([name, m, c]) => ({ name: name as string, pence: p(m as number), clicks: share(c as number) })),
		devices: [["mobile", 0.41, 0.09], ["desktop", 0.55, 0.05], ["tablet", 0.04, 0.007]].map(([name, m, c]) => ({ name: name as string, pence: p(m as number), clicks: share(c as number) })),
		update: [{ path: "/kindle-colorsoft-review/", monthly: p(0.08), why: "Slipped from 4th to 7th on Google." }],
		wrongCountry: [{ store: "amazon.com", country: "US", clicks: share(0.008), elsewhere: Math.round(share(0.008) * 0.64), top: "GB" }],
		stopped: [],
	};
}
