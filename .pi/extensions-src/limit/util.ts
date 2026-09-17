/**
 * Defensive JSON helpers, quota math, and fetch plumbing shared by providers.
 *
 * Vendor payloads are unofficial and untyped, so every field goes through
 * `asRecord`/`asNumber`/`asString` and unknown shapes are dropped instead of
 * guessed at.
 */

import type { LimitBase, LimitError, LimitReport, LimitWindow } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 10_000;

// -------------------------------------------------------------------------
// Unknown → primitive narrowing
// -------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

// -------------------------------------------------------------------------
// Quota math
// -------------------------------------------------------------------------

export function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

/** Undefined when the ratio is unknown, so callers can keep looking for a value. */
export function percentFromCounts(used: number | undefined, limit: number | undefined): number | undefined {
	if (used === undefined || limit === undefined || limit <= 0) return undefined;
	return clampPercent((used / limit) * 100);
}

/**
 * A window without a ratio and without counts has nothing to show. Providers
 * drop those instead of reporting an empty window as a successful query.
 */
export function hasWindowData(window: LimitWindow): boolean {
	return window.percent !== undefined || window.used !== undefined || window.limit !== undefined;
}

/** `Date` accepts out-of-range epoch values; `getTime()` reports them as NaN. */
export function isoFromEpochMs(value: unknown): string | undefined {
	const ms = asNumber(value);
	if (ms === undefined || ms <= 0) return undefined;
	const date = new Date(ms);
	return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

// -------------------------------------------------------------------------
// Credentials display
// -------------------------------------------------------------------------

/** Enough to tell two credentials apart; never the whole secret. */
export function maskToken(token: string): string {
	return token.length <= 8 ? `(${token.length} chars)` : `…${token.slice(-4)}`;
}

// -------------------------------------------------------------------------
// Fetch
// -------------------------------------------------------------------------

export async function fetchJson(
	url: string,
	headers: Record<string, string>,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ status: number; body: unknown }> {
	const response = await fetch(url, {
		headers: { Accept: "application/json", ...headers },
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await response.text();
	let body: unknown;
	try {
		body = text ? (JSON.parse(text) as unknown) : undefined;
	} catch {
		body = undefined;
	}
	return { status: response.status, body };
}

/** `AbortSignal.timeout` rejects with `TimeoutError`; anything else is a transport failure. */
export function networkError(error: unknown, subject: string): LimitError {
	const name = error instanceof Error && error.name ? error.name : "";
	if (name === "TimeoutError" || name === "AbortError") {
		return { code: "timeout", message: `The request to ${subject} timed out.` };
	}
	return { code: "network", message: `Failed to reach ${subject}.` };
}

// -------------------------------------------------------------------------
// Report construction
// -------------------------------------------------------------------------

/** Error reports keep the header rows and carry no windows. */
export function failureReport(
	base: LimitBase,
	endpoint: string,
	error: LimitError,
	key?: Pick<LimitReport, "keyLabel" | "keyFingerprint">,
): LimitReport {
	return {
		kind: "report",
		...base,
		endpoint,
		...key,
		windows: [],
		error,
	};
}
