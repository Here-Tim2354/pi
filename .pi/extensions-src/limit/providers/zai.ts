/**
 * GLM Coding Plan (Zhipu / Z.AI, CN) quota (`/limit zai`).
 *
 * Endpoint: `GET {base}/api/monitor/usage/quota/limit` with
 * `Authorization: <api key>` — the endpoint the official `glm-plan-usage`
 * plugin uses. `base` is the pi provider's `baseUrl` origin, so the same
 * command follows a platform switch between open.bigmodel.cn and api.z.ai.
 *
 * The CN plan has two credit windows (docs.bigmodel.cn → Coding Plan → 套餐概览):
 * a 5-hour one (Lite: 2,000 credits) and a weekly one (Lite: 10,000). Both
 * arrive as `CREDIT_LIMIT` rows carrying a `{ unit, number }` duration; older
 * plans use `TOKENS_LIMIT` (5h tokens) and `TIME_LIMIT` (MCP, monthly) instead.
 *
 * This API reports failures inside a HTTP 200 envelope
 * (`code: 1000/1001`, `success: false`), so the envelope is checked rather
 * than the status line.
 */

import { keyDisplay, requireKey } from "../credentials.ts";
import type { LimitBase, LimitContext, LimitProvider, LimitReport, LimitWindow } from "../types.ts";
import {
	asNumber,
	asRecord,
	asString,
	clampPercent,
	failureReport,
	fetchJson,
	hasWindowData,
	isoFromEpochMs,
	networkError,
	percentFromCounts,
} from "../util.ts";

const DEFAULT_BASE_URL = "https://open.bigmodel.cn";
const USAGE_PATH = "/api/monitor/usage/quota/limit";
const SLOT_ORDER = ["5h", "weekly", "mcp"];

function slotRank(slot: string): number {
	const index = SLOT_ORDER.indexOf(slot);
	return index < 0 ? SLOT_ORDER.length : index;
}

/**
 * `unit` is an opaque duration enum. Only the pairs the CN credit plan actually
 * emits are named; anything else keeps the raw pair instead of guessing.
 */
function describeWindow(row: Record<string, unknown>): { slot: string; label: string; unit: string } {
	const type = asString(row.type)?.toUpperCase() ?? "";
	const unit = asNumber(row.unit);
	const number = asNumber(row.number);

	if (type === "TOKENS_LIMIT") return { slot: "5h", label: "5h window", unit: "tokens" };
	if (type === "TIME_LIMIT") return { slot: "mcp", label: "MCP (monthly)", unit: "calls" };
	if (unit === 3 && number === 5) return { slot: "5h", label: "5h window", unit: "credits" };
	if (unit === 6 && number === 1) return { slot: "weekly", label: "Weekly", unit: "credits" };
	if (unit !== undefined && number !== undefined) {
		return { slot: `u${unit}x${number}`, label: `${number} × unit ${unit}`, unit: "amounts" };
	}
	const fallback = type.toLowerCase();
	return { slot: fallback || "limit", label: fallback ? fallback.replace(/_/g, " ") : "Limit", unit: "amounts" };
}

function parseLimitRows(data: Record<string, unknown>): QuotaWindow[] {
	const rawLimits = data.limits;
	if (!Array.isArray(rawLimits)) return [];

	const windows: QuotaWindow[] = [];
	for (const item of rawLimits) {
		const row = asRecord(item);
		if (!row) continue;
		const described = describeWindow(row);
		const limit = asNumber(row.usage);
		const remaining = asNumber(row.remaining);
		const used =
			asNumber(row.currentValue) ?? (remaining !== undefined && limit !== undefined ? limit - remaining : undefined);
		const reported = asNumber(row.percentage);
		const window: QuotaWindow = {
			...described,
			percent: reported === undefined ? percentFromCounts(used, limit) : clampPercent(reported),
			used,
			limit,
			resetsAt: isoFromEpochMs(row.nextResetTime),
		};
		// `limits: [{}]` (and anything else without a ratio or counts) is not a quota row.
		if (hasWindowData(window)) windows.push(window);
	}
	return windows.sort((a, b) => slotRank(a.slot) - slotRank(b.slot) || a.slot.localeCompare(b.slot));
}

type QuotaWindow = LimitWindow & { slot: string; unit: string };

const zaiProvider: LimitProvider = {
	name: "zai",
	planName: "GLM Coding Plan (CN)",
	providerId: "zai-coding-cn",
	loginHint: "ZAI_CODING_CN_API_KEY or /login zai-coding-cn",
	aliases: ["glm"],
	async fetch(ctx: LimitContext, base: LimitBase): Promise<LimitReport> {
		const endpoint = `${resolveBaseUrl(ctx)}${USAGE_PATH}`;
		const key = await requireKey(ctx, zaiProvider, base, endpoint);
		if (!key.ok) return key.report;
		const display = keyDisplay(key);

		let status: number;
		let body: unknown;
		try {
			({ status, body } = await fetchJson(endpoint, {
				Authorization: key.token,
				"Accept-Language": "en-US,en",
			}));
		} catch (error) {
			return failureReport(base, endpoint, networkError(error, "the Zhipu quota endpoint"), display);
		}

		if (status < 200 || status >= 300) {
			return failureReport(
				base,
				endpoint,
				{ code: `http-${status}`, message: `The quota endpoint returned HTTP ${status}.` },
				display,
			);
		}

		const payload = asRecord(body);
		if (!payload) {
			return failureReport(
				base,
				endpoint,
				{ code: "bad-json", message: "The quota endpoint returned an unexpected response shape." },
				display,
			);
		}

		const code = asNumber(payload.code);
		const message = asString(payload.msg) ?? "Unknown error";
		if (payload.success === false || (code !== undefined && code !== 200)) {
			if (code === 1000 || code === 1001) {
				return failureReport(
					base,
					endpoint,
					{
						code: "unauthorized",
						message: `Zhipu rejected the API key: ${message}. Reset ZAI_CODING_CN_API_KEY or re-login.`,
					},
					display,
				);
			}
			return failureReport(
				base,
				endpoint,
				{ code: `api-${code ?? "unknown"}`, message: `The quota endpoint returned code ${code}: ${message}` },
				display,
			);
		}

		const data = asRecord(payload.data);
		const windows = data ? parseLimitRows(data) : [];
		if (windows.length === 0) {
			return failureReport(
				base,
				endpoint,
				{
					code: "no-quota",
					message:
						"The quota endpoint returned no credit windows. Personal Coding Plan subscriptions are required; team or pay-as-you-go keys have no plan quota.",
				},
				display,
			);
		}

		const units = new Set(windows.map((window) => window.unit));
		const summary = [
			asString(data?.level),
			units.size === 1 ? [...units][0] : units.size > 1 ? "mixed units" : undefined,
		];
		return {
			kind: "report",
			...base,
			endpoint,
			...display,
			detail: summary.filter(Boolean).join(", ") || undefined,
			windows: windows.map(({ slot, unit, ...window }) => window),
		};
	},
};

/** The stats endpoint shares the platform host with the model API on both platforms. */
function resolveBaseUrl(ctx: LimitContext): string {
	const configured = ctx.modelRegistry.getProvider(zaiProvider.providerId)?.baseUrl;
	if (configured) {
		try {
			const url = new URL(configured);
			return `${url.protocol}//${url.host}`;
		} catch {
			// Unparseable base URL: fall back to the CN platform.
		}
	}
	return DEFAULT_BASE_URL;
}

export { zaiProvider };
