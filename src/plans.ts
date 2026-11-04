// What a self-hosted ReaderCount allows. Every feature is on, with generous ceilings that only stop runaway use
// (such as a trigger firing thousands of emails). Nothing here checks a licence: the licence is in LICENSE.

import { clientPlan } from "./clients.ts";

/** Websites the free licence covers. Shown as a reminder; never enforced. */
export const LICENCE_SITES = 10;

/** What an account may do. */
export type PlanState = {
	plan: string;
	name: string;
	sites: number;
	views: number;
	/** Problem and form reports kept a month (broken pictures, script errors, forms started). */
	reports: number;
	/** Alert emails a day (site down, triggers), triggers per website, and webhooks per website. */
	alerts: number;
	triggers: number;
	hooks: number;
	/** Affiliate networks connected per website. */
	networks: number;
	/** Always false: a self-hosted ReaderCount never stops. Kept so the shared code reads the same. */
	ended: boolean;
};

export type PlanRow = { plan: string | null; trial_ends: number | null };

export const SELF: PlanState = { plan: "self", name: "Self-hosted", sites: 1000, views: 10_000_000, reports: 200_000, alerts: 50, triggers: 50, hooks: 10, networks: 10, ended: false };

export function planState(_row: PlanRow | null, _now: number): PlanState {
	return { ...SELF };
}

/** The owner gets everything. A client (client mode) gets the websites their plan allows, while it's free or paid. */
export async function accountPlan(db: D1Database, accountId: string, _now: number): Promise<PlanState> {
	if (accountId === "owner") return { ...SELF };
	return clientPlan(db, accountId, { ...SELF });
}
