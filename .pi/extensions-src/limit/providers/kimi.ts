/**
 * Kimi For Coding subscription quota (`/limit kimi`).
 *
 * Endpoint: `GET https://api.kimi.com/coding/v1/usages` with
 * `Authorization: Bearer <token>` — the unofficial endpoint the official Kimi
 * Code CLI uses. There is no public API reference, so the payload is parsed
 * defensively:
 *   limits[]        { window: { duration, timeUnit }, detail: { limit, used, remaining, resetTime } }
 *   usages{}        { limit_5h | limit_month_total | ... : { used_ratio, reset_time } }
 *   booster_wallet  pay-as-you-go extra usage (shown only while active)
 *
 * API keys authenticate fine but return an empty payload; only the subscription
 * (OAuth) credential exposes plan quota. That case is reported explicitly
 * instead of rendering an empty block.
 *
 * The usage endpoint honors `KIMI_CODE_BASE_URL`, like the CLI.
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
	hasWindowData,
	networkError,
	percentFromCounts,
} from "../util.ts";

const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
/** Same identity the official CLI sends; the endpoint is known to accept it. */
const USER_AGENT = "KimiCLI/1.6";
const SLOT_ORDER = ["5h", "daily", "weekly", "monthly"];

/** A window plus the dedupe key shared by the two representations. */
type SlotWindow = LimitWindow & { slot: string };

/**
 * `limits[]` windows describe themselves with `duration` + `timeUnit`; unknown
 * combinations keep their raw form instead of being folded into a wrong name.
 */
function slotFromWindow(window: Record<string, unknown> | undefined): SlotWindow | undefined {
	const duration = asNumber(window?.duration);
	const unit = asString(window?.timeUnit)?.toUpperCase() ?? "";
	if (duration === undefined || duration <= 0) return undefined;
	if (unit.includes("MINUTE")) {
		if (duration === 300) return { slot: "5h", label: "5h window" };
		if (duration % 60 === 0) return { slot: `${duration / 60}h`, label: `${duration / 60}h window` };
		return { slot: `${duration}m`, label: `${duration}m window` };
	}
	if (unit.includes("HOUR")) return { slot: `${duration}h`, label: `${duration}h window` };
	if (unit.includes("DAY")) {
		if (duration === 1) return { slot: "daily", label: "Daily" };
		if (duration === 7) return { slot: "weekly", label: "Weekly" };
		return { slot: `${duration}d`, label: `${duration}d window` };
	}
	if (unit.includes("WEEK")) {
		return duration === 1
			? { slot: "weekly", label: "Weekly" }
			: { slot: `${duration}w`, label: `${duration}w window` };
	}
	if (unit.includes("MONTH")) {
		return duration === 1
			? { slot: "monthly", label: "Monthly" }
			: { slot: `${duration}mo`, label: `${duration} months` };
	}
	return undefined;
}

/** `usages{}` keys are named windows such as `limit_5h` / `limit_month_total`. */
function slotFromUsageKey(key: string): SlotWindow {
	const normalized = key.toLowerCase();
	if (normalized === "limit_5h") return { slot: "5h", label: "5h window" };
	if (normalized === "limit_week" || normalized === "limit_week_total") return { slot: "weekly", label: "Weekly" };
	if (normalized === "limit_month" || normalized === "limit_month_total") return { slot: "monthly", label: "Monthly" };
	if (normalized === "limit_month_code") return { slot: normalized, label: "Monthly (code)" };
	return { slot: normalized, label: key.replace(/[_-]+/g, " ") };
}

/** `used_ratio` is a fraction, including values above 1 when usage exceeds quota. */
function percentFromRatio(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	const percent = clampPercent(value * 100);
	// Ratios arrive as floats; two decimals keep the stored entry readable.
	return Math.round(percent * 100) / 100;
}

function parseLimitRows(payload: Record<string, unknown>): SlotWindow[] {
	const rawLimits = payload.limits;
	if (!Array.isArray(rawLimits)) return [];

	const windows: SlotWindow[] = [];
	for (const item of rawLimits) {
		const entry = asRecord(item);
		if (!entry) continue;
		const detail = asRecord(entry.detail) ?? entry;
		const described = slotFromWindow(asRecord(entry.window));
		const limit = asNumber(detail.limit) ?? asNumber(detail.limit_amount);
		const remaining = asNumber(detail.remaining);
		const used =
			asNumber(detail.used) ?? (remaining !== undefined && limit !== undefined ? limit - remaining : undefined);
		if (used === undefined && limit === undefined) continue;
		const window: SlotWindow = {
			slot: described?.slot ?? `limit-${windows.length + 1}`,
			label: asString(detail.name) ?? described?.label ?? `Limit ${windows.length + 1}`,
			// Counts may be missing even when the limit is known; leaving the percent
			// undefined lets the `usages{}` ratio fill it in during the merge.
			percent: percentFromCounts(used, limit),
			used,
			limit,
			resetsAt: asString(detail.resetTime) ?? asString(detail.reset_at) ?? asString(detail.reset_time),
		};
		if (hasWindowData(window)) windows.push(window);
	}
	return windows;
}

function parseUsageRows(payload: Record<string, unknown>): SlotWindow[] {
	const usages = asRecord(payload.usages);
	if (!usages) return [];

	const windows: SlotWindow[] = [];
	for (const [key, value] of Object.entries(usages)) {
		const row = asRecord(value);
		if (!row) continue;
		const window: SlotWindow = {
			...slotFromUsageKey(key),
			percent: percentFromRatio(asNumber(row.used_ratio) ?? asNumber(row.usedRatio)),
			used: asNumber(row.used),
			limit: asNumber(row.limit),
			resetsAt: asString(row.reset_time) ?? asString(row.resetTime),
		};
		// A row such as `{}` or one carrying only a reset time says nothing about usage.
		if (hasWindowData(window)) windows.push(window);
	}
	return windows;
}

/** Booster wallet values are fixed-point with 6 decimals per cent. */
function fixedPointToCents(value: number): number {
	const cents = value / 1_000_000;
	if (cents > 0 && cents < 1) return 1;
	return Math.round(cents);
}

function parseMoneyCents(raw: unknown): { cents: number; currency: string } | undefined {
	const record = asRecord(raw);
	const cents = asNumber(record?.priceInCents);
	if (cents === undefined) return undefined;
	return { cents, currency: asString(record?.currency) ?? "" };
}

function formatMoney(cents: number, currency: string): string {
	const amount = (cents / 100).toFixed(2);
	if (currency === "CNY") return `¥${amount}`;
	if (currency === "USD") return `$${amount}`;
	return currency ? `${amount} ${currency}` : amount;
}

/** Only rendered while the pay-as-you-go wallet is actually in use. */
function parseExtraUsage(payload: Record<string, unknown>): LimitFact | undefined {
	const wallet = asRecord(payload.booster_wallet) ?? asRecord(payload.boosterWallet);
	if (!wallet) return undefined;
	const balance = asRecord(wallet.balance);
	const monthlyLimit = parseMoneyCents(wallet.monthlyChargeLimit);
	const monthlyUsed = parseMoneyCents(wallet.monthlyUsed);
	const currency = monthlyLimit?.currency || monthlyUsed?.currency || "USD";
	const usedCents = monthlyUsed?.cents ?? 0;
	const limitCents = monthlyLimit?.cents ?? 0;
	const balanceCents = fixedPointToCents(asNumber(balance?.amountLeft) ?? asNumber(balance?.amount) ?? 0);
	if (balanceCents <= 0 && usedCents <= 0 && !(wallet.monthlyChargeLimitEnabled === true && limitCents > 0)) {
		return undefined;
	}

	const parts: string[] = [];
	if (limitCents > 0) {
		parts.push(`${formatMoney(usedCents, currency)} / ${formatMoney(limitCents, currency)} monthly cap`);
	} else {
		parts.push(`used ${formatMoney(usedCents, currency)}`);
	}
	if (balanceCents > 0) parts.push(`balance ${formatMoney(balanceCents, currency)}`);
	return { label: "extra", value: parts.join(" · ") };
}

function slotRank(slot: string): number {
	const index = SLOT_ORDER.indexOf(slot);
	return index < 0 ? SLOT_ORDER.length : index;
}

/**
 * `limits[]` carries exact counts, `usages{}` carries ratios for windows that
 * have no entry there (the monthly window is the common case). Keep one row per
 * slot and merge the missing pieces in.
 */
function mergeWindows(limitRows: SlotWindow[], usageRows: SlotWindow[]): LimitWindow[] {
	const bySlot = new Map<string, SlotWindow>();
	for (const window of limitRows) bySlot.set(window.slot, window);
	for (const window of usageRows) {
		const existing = bySlot.get(window.slot);
		if (!existing) {
			bySlot.set(window.slot, window);
			continue;
		}
		existing.used ??= window.used;
		existing.limit ??= window.limit;
		existing.percent ??= percentFromCounts(existing.used, existing.limit) ?? window.percent;
		existing.resetsAt ??= window.resetsAt;
	}
	return [...bySlot.values()]
		.sort((a, b) => slotRank(a.slot) - slotRank(b.slot) || a.slot.localeCompare(b.slot))
		.map(({ slot, ...window }) => ({
			...window,
			percent: window.percent ?? percentFromCounts(window.used, window.limit),
		}));
}

const kimiProvider: LimitProvider = {
	name: "kimi",
	planName: "Kimi For Coding",
	providerId: "kimi-coding",
	loginHint: "KIMI_API_KEY or /login kimi-coding",
	aliases: ["kimi-coding"],
	async fetch(ctx: LimitContext, base: LimitBase): Promise<LimitReport> {
		const endpoint = `${(process.env.KIMI_CODE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "")}/usages`;
		const key = await requireKey(ctx, kimiProvider, base, endpoint);
		if (!key.ok) return key.report;
		const display = keyDisplay(key);

		let status: number;
		let body: unknown;
		try {
			({ status, body } = await fetchJson(endpoint, {
				Authorization: `Bearer ${key.token}`,
				"User-Agent": USER_AGENT,
			}));
		} catch (error) {
			return failureReport(base, endpoint, networkError(error, "the Kimi usage endpoint"), display);
		}

		if (status === 401 || status === 403) {
			return failureReport(
				base,
				endpoint,
				{
					code: "unauthorized",
					message: `Kimi rejected the credential (HTTP ${status}). Re-run /login kimi-coding, or reset KIMI_API_KEY.`,
				},
				display,
			);
		}
		if (status === 404) {
			return failureReport(
				base,
				endpoint,
				{
					code: "endpoint-missing",
					message: `The usage endpoint returned HTTP 404. Check KIMI_CODE_BASE_URL; the CLI default is ${DEFAULT_BASE_URL}.`,
				},
				display,
			);
		}
		if (status < 200 || status >= 300) {
			return failureReport(
				base,
				endpoint,
				{ code: `http-${status}`, message: `The Kimi usage endpoint returned HTTP ${status}.` },
				display,
			);
		}

		const payload = asRecord(body);
		if (!payload) {
			return failureReport(
				base,
				endpoint,
				{ code: "bad-json", message: "The Kimi usage endpoint returned an unexpected response shape." },
				display,
			);
		}

		const windows = mergeWindows(parseLimitRows(payload), parseUsageRows(payload));
		const extra = parseExtraUsage(payload);
		if (windows.length === 0 && !extra) {
			return failureReport(
				base,
				endpoint,
				{
					code: "no-quota",
					message:
						key.credentialKind === "api-key"
							? "Kimi returned no quota windows. API keys do not expose plan quota; sign in with the subscription login (/login kimi-coding)."
							: "Kimi returned no quota windows for this credential.",
				},
				display,
			);
		}

		return {
			kind: "report",
			...base,
			endpoint,
			...display,
			windows,
			facts: extra ? [extra] : [],
		};
	},
};

export { kimiProvider };
