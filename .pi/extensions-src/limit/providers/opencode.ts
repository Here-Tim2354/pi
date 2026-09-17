/**
 * OpenCode Go (Zen) plan quota (`/limit opencode`).
 *
 * Endpoint: `GET https://opencode.ai/zen/go/v1/usage` with
 * `Authorization: Bearer <key>` — OpenCode's own usage API, which reports
 * `{ usage: { rolling | weekly | monthly: { percent, status, resetsAt } } }`.
 *
 * A key without a Go subscription is rejected with HTTP 403 and
 * `error.type === "EntitlementError"`, which is reported as its own case
 * instead of a generic HTTP failure.
 */

import { keyDisplay, requireKey } from "../credentials.ts";
import type { LimitBase, LimitContext, LimitProvider, LimitReport, LimitWindow } from "../types.ts";
import { asNumber, asRecord, clampPercent, failureReport, fetchJson, networkError } from "../util.ts";

const ENDPOINT = "https://opencode.ai/zen/go/v1/usage";

const WINDOWS = [
	{ key: "rolling", label: "Rolling 5h" },
	{ key: "weekly", label: "Weekly" },
	{ key: "monthly", label: "Monthly" },
] as const;

function parseWindows(body: unknown): LimitWindow[] {
	const usage = asRecord(asRecord(body)?.usage);
	if (!usage) return [];

	const windows: LimitWindow[] = [];
	for (const slot of WINDOWS) {
		const row = asRecord(usage[slot.key]);
		if (!row) continue;
		const percent = asNumber(row.percent);
		if (percent === undefined) continue;
		windows.push({
			label: slot.label,
			percent: clampPercent(percent),
			resetsAt: typeof row.resetsAt === "string" ? row.resetsAt : undefined,
			status: row.status === "rate-limited" ? "rate-limited" : undefined,
		});
	}
	return windows;
}

function missingEntitlement(body: unknown): boolean {
	return asRecord(asRecord(body)?.error)?.type === "EntitlementError";
}

const opencodeProvider: LimitProvider = {
	name: "opencode",
	planName: "OpenCode Go",
	providerId: "opencode-go",
	loginHint: "OPENCODE_API_KEY or /login opencode-go",
	async fetch(ctx: LimitContext, base: LimitBase): Promise<LimitReport> {
		const key = await requireKey(ctx, opencodeProvider, base, ENDPOINT);
		if (!key.ok) return key.report;
		const display = keyDisplay(key);

		let status: number;
		let body: unknown;
		try {
			({ status, body } = await fetchJson(ENDPOINT, { Authorization: `Bearer ${key.token}` }));
		} catch (error) {
			return failureReport(base, ENDPOINT, networkError(error, "the OpenCode Go usage endpoint"), display);
		}

		if (status === 401) {
			return failureReport(
				base,
				ENDPOINT,
				{
					code: "unauthorized",
					message: "OpenCode rejected the API key (HTTP 401). Reset OPENCODE_API_KEY or re-login.",
				},
				display,
			);
		}
		if (status === 403 && missingEntitlement(body)) {
			return failureReport(
				base,
				ENDPOINT,
				{ code: "no-subscription", message: "This OpenCode key is valid but has no Go subscription." },
				display,
			);
		}
		if (status < 200 || status >= 300) {
			return failureReport(
				base,
				ENDPOINT,
				{ code: `http-${status}`, message: `The OpenCode Go usage endpoint returned HTTP ${status}.` },
				display,
			);
		}

		const windows = parseWindows(body);
		if (windows.length === 0) {
			return failureReport(
				base,
				ENDPOINT,
				{ code: "bad-json", message: "The usage endpoint returned an unexpected response shape." },
				display,
			);
		}

		return { kind: "report", ...base, endpoint: ENDPOINT, ...display, windows };
	},
};

export { opencodeProvider };
