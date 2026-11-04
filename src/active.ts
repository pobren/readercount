// ReaderCount: who is on a website right now, for the Real-Time Active Visitors count and the live view.
// A visitor is on the site while their latest page view is under 5 minutes old (as before) and they haven't left it:
// the tracker says when a page is closed or its tab hidden (left_at), and when the tab comes back (left_at = 0).
// Rows from before left_at existed only have the time on page, which also arrives when the reader leaves.

import { utcDay } from "./visitor.ts";

export const ACTIVE_MS = 5 * 60_000;

/** SQL for each active visitor's latest page view (visitor, path, ts), then the values to bind. `where` narrows the rows (the dashboard's filters). */
export function activeViews(site: string, now: number, where = "", args: unknown[] = []): [string, unknown[]] {
	return [
		`SELECT visitor, path, ts FROM (SELECT visitor, path, ts, left_at, duration, ROW_NUMBER() OVER (PARTITION BY visitor ORDER BY ts DESC) AS rn FROM events WHERE site = ? AND day IN (?, ?) AND ts >= ? AND kind = 'view'${where}) WHERE rn = 1 AND (left_at = 0 OR (left_at IS NULL AND duration IS NULL))`,
		[site, utcDay(now), utcDay(now - ACTIVE_MS), now - ACTIVE_MS, ...args],
	];
}
