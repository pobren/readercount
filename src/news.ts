// "What's new": the latest ReaderCount releases, shown in a box on the stats page.
// Newest first. Each one links to its release on GitHub, so add a matching entry to CHANGELOG.md too.

export type News = { day: string; title: string; text: string; id: string };

export const NEWS: News[] = [
	{ day: "2026-11-04", title: "ReaderCount you host yourself", text: "ReaderCount now runs on your own Cloudflare account, with every feature included: the live view, Google searches, goals and triggers, earnings per post, site health, emails and the Claude connector.", id: "v1.0.0" },
];

export const CHANGES_URL = "https://github.com/pobren/readercount/releases";
