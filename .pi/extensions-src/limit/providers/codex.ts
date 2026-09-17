/**
 * ChatGPT Codex subscription quota (`/limit codex`).
 *
 * Endpoint: `GET https://chatgpt.com/backend-api/wham/usage` — the private
 * endpoint the official Codex CLI itself reads for `/status`. It needs only the
 * OAuth access token (verified: `chatgpt-account-id` and `originator` make no
 * difference), and pi refreshes that token for us.
 *
 * Response fields used here:
 *   rate_limit.primary_window / secondary_window
 *                     { used_percent, limit_window_seconds, reset_at }
 *   rate_limit.limit_reached
 *   additional_rate_limits[]  per-model limits, each with a `limit_name` and
 *                             its own `rate_limit` window block
 *   credits                   { has_credits, unlimited, balance }
 *   spend_control             { reached, individual_limit }
 *   rate_limit_reset_credits  { available_count }
 *
 * Window names come from `limit_window_seconds`, not from the backend's
 * primary/secondary labels, which do not track plan changes.
 */

import { keyDisplay, requireKey } from "../credentials.ts";
import type { LimitBase, LimitContext, LimitFact, LimitProvider, LimitReport, LimitWindow } from "../types.ts";
import {
	asNumber,
	asRecord,
	asString,
	clampPercent,
	failureReport,
	fetchJson,
	isoFromEpochMs,
	networkError,
} from "../util.ts";

const ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
/** Codex sends its own identity; the endpoint only checks the bearer token. */
const ORIGINATOR = "pi";

const WINDOW_SLOTS = [
	{ key: "primary_window", fallback: "Primary" },
	{ key: "secondary_window", fallback: "Secondary" },
] as const;

function windowLabel(seconds: number | undefined, fallback: string): string {
	if (seconds === undefined) return fallback;
	const hours = seconds / 3600;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m window`;
	if (Math.abs(hours - 5) <= 0.5) return "5h window";
	if (Math.abs(hours - 24) <= 1) return "Daily";
	if (Math.abs(hours - 168) <= 12) return "Weekly";
	if (Math.abs(hours - 720) <= 36) return "Monthly";
	if (hours >= 7200) return "Annual";
	return `${Math.round(hours)}h window`;
}

function parseWindow(raw: unknown, fallbackLabel: string): LimitWindow | undefined {
	const record = asRecord(raw);
	if (!record) return undefined;
	const percent = asNumber(record.used_percent);
	if (percent === undefined) return undefined;
	const resetAt = asNumber(record.reset_at);
	return {
		label: windowLabel(asNumber(record.limit_window_seconds), fallbackLabel),
		percent: clampPercent(percent),
		resetsAt: resetAt === undefined ? undefined : isoFromEpochMs(resetAt * 1000),
	};
}

/**
 * Per-model limits, which many accounts do not have at all (`null`). No live
 * sample of the nested shape was available, so windows are accepted both under
 * the entry's own `rate_limit` block and directly on the entry; anything else
 * is dropped rather than guessed at.
 */
function parseAdditionalLimits(raw: unknown): LimitWindow[] {
	if (!Array.isArray(raw)) return [];
	const windows: LimitWindow[] = [];
	for (const item of raw) {
		const record = asRecord(item);
		if (!record) continue;
		const name = asString(record.limit_name) ?? asString(record.name) ?? asString(record.model);
		const container = asRecord(record.rate_limit) ?? record;
		for (const slot of WINDOW_SLOTS) {
			const parsed = parseWindow(container[slot.key], slot.fallback);
			if (parsed) windows.push(name ? { ...parsed, label: `${name} ${parsed.label}` } : parsed);
		}
	}
	return windows;
}

function parseFacts(payload: Record<string, unknown>): LimitFact[] {
	const facts: LimitFact[] = [];

	const credits = asRecord(payload.credits);
	if (credits?.unlimited === true) {
		facts.push({ label: "credits", value: "unlimited" });
	} else if (credits?.has_credits === true) {
		const balance = asNumber(credits.balance);
		facts.push({ label: "credits", value: balance === undefined ? "available" : `${balance}` });
	}

	const spendControl = asRecord(payload.spend_control);
	const spendLimit = asNumber(spendControl?.individual_limit);
	if (spendLimit !== undefined && spendLimit > 0) {
		const reached = spendControl?.reached === true ? " (reached)" : "";
		facts.push({ label: "spend cap", value: `${spendLimit}${reached}` });
	}

	const resetCredits = asRecord(payload.rate_limit_reset_credits);
	const available = asNumber(resetCredits?.available_count);
	if (available !== undefined && available > 0) {
		facts.push({ label: "reset credits", value: `${available} available` });
	}

	return facts;
}

function parseNotes(payload: Record<string, unknown>): string[] {
	const rateLimit = asRecord(payload.rate_limit);
	if (rateLimit?.limit_reached === true) {
		return ["Rate limit reached: Codex is rejecting requests until the window resets."];
	}
	return [];
}

const codexProvider: LimitProvider = {
	name: "codex",
	planName: "ChatGPT Codex",
	providerId: "openai-codex",
	loginHint: "/login openai-codex",
	async fetch(ctx: LimitContext, base: LimitBase): Promise<LimitReport> {
		const key = await requireKey(ctx, codexProvider, base, ENDPOINT);
		if (!key.ok) return key.report;
		const display = keyDisplay(key);

		let status: number;
		let body: unknown;
		try {
			({ status, body } = await fetchJson(ENDPOINT, {
				Authorization: `Bearer ${key.token}`,
				originator: ORIGINATOR,
			}));
		} catch (error) {
			return failureReport(base, ENDPOINT, networkError(error, "the Codex usage endpoint"), display);
		}

		if (status === 401 || status === 403) {
			return failureReport(
				base,
				ENDPOINT,
				{
					code: "unauthorized",
					message: `ChatGPT rejected the credential (HTTP ${status}). Re-run /login openai-codex.`,
				},
				display,
			);
		}
		if (status < 200 || status >= 300) {
			return failureReport(
				base,
				ENDPOINT,
				{ code: `http-${status}`, message: `The Codex usage endpoint returned HTTP ${status}.` },
				display,
			);
		}

		const payload = asRecord(body);
		if (!payload) {
			return failureReport(
				base,
				ENDPOINT,
				{ code: "bad-json", message: "The Codex usage endpoint returned an unexpected response shape." },
				display,
			);
		}

		const rateLimit = asRecord(payload.rate_limit);
		const windows: LimitWindow[] = [];
		for (const slot of WINDOW_SLOTS) {
			const parsed = parseWindow(rateLimit?.[slot.key], slot.fallback);
			if (parsed) windows.push(parsed);
		}
		windows.push(...parseAdditionalLimits(payload.additional_rate_limits));

		if (windows.length === 0) {
			return failureReport(
				base,
				ENDPOINT,
				{
					code: "no-quota",
					message:
						"The account returned no rate-limit windows. Codex limits require a Plus/Pro/Business subscription.",
				},
				display,
			);
		}

		return {
			kind: "report",
			...base,
			endpoint: ENDPOINT,
			...display,
			detail: asString(payload.plan_type),
			facts: parseFacts(payload),
			windows,
			notes: parseNotes(payload),
		};
	},
};

export { codexProvider };
