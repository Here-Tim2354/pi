/**
 * limit-opencode — show OpenCode Go plan usage quotas in the TUI.
 *
 * Registers a `/limit-opencode` slash command that queries the official OpenCode
 * Go usage endpoint (`GET https://opencode.ai/zen/go/v1/usage`) with the
 * `opencode-go` API key, then renders each window (5h rolling / weekly / monthly)
 * as an ASCII progress bar plus the current API details.
 *
 * The command resolves the key from the same places pi does:
 *   1. `OPENCODE_API_KEY` env var (source: env)
 *   2. pi's own credential store via `ctx.modelRegistry` (source: pi)
 *   3. OpenCode's local `auth.json` (`opencode-go` entry) (source: auth-file)
 *
 * Output is persisted as a custom entry (`pi.appendEntry`) rendered by
 * `registerEntryRenderer`, so the block (not just a toast) is printed in the
 * TUI transcript — while custom entries never participate in the LLM context.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "ocgo-usage";
const DEFAULT_ENDPOINT = "https://opencode.ai/zen/go/v1/usage";
const TIMEOUT_MS = 10_000;
const BAR_WIDTH = 12;

type WindowKind = "rolling" | "weekly" | "monthly";
type UsageStatus = "ok" | "rate-limited";
type KeySource = "env" | "pi" | "auth-file" | "none";
type ResultKind = "ok" | "error";

interface UsageWindow {
	kind: WindowKind;
	percent: number;
	status: UsageStatus;
	resetsAt?: string;
}

interface UsageMeta {
	endpoint: string;
	provider: string;
	keySource: KeySource;
	keyFingerprint?: string;
	currentModel?: string;
	usingOpencodeGo: boolean;
	fetchedAt: number;
}

interface OcgoDetails {
	result: ResultKind;
	windows: Partial<Record<WindowKind, UsageWindow>>;
	error?: { code: string; message: string };
	meta: UsageMeta;
}

type ApiOutcome =
	| { kind: "ok"; windows: Partial<Record<WindowKind, UsageWindow>> }
	| { kind: "unauthorized" }
	| { kind: "no-subscription" }
	| { kind: "http"; status: number }
	| { kind: "bad-json" };

const WINDOW_LABELS: Record<WindowKind, string> = {
	rolling: "Rolling 5h",
	weekly: "Weekly",
	monthly: "Monthly",
};

// -------------------------------------------------------------------------
// Small record/primitive helpers (defensive JSON parsing, no `any`)
// -------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

// -------------------------------------------------------------------------
// Key resolution (never logs or displays the full key)
// -------------------------------------------------------------------------

function maskKey(key: string): string {
	if (key.length <= 8) return `(${key.length} chars)`;
	const suffix = key.slice(-4);
	const prefix = key.startsWith("sk-") ? "sk-" : "…";
	return `${prefix}…${suffix} (${key.length} chars)`;
}

function readOpencodeAuthKey(): string | undefined {
	try {
		const filePath = join(homedir(), ".local", "share", "opencode", "auth.json");
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<
			string,
			{ type?: string; key?: string } | undefined
		>;
		const entry = parsed["opencode-go"] ?? parsed.opencode;
		if (entry && typeof entry.key === "string" && entry.key.trim().length > 0) return entry.key.trim();
	} catch {
		// Missing/unreadable auth.json is the normal "not logged in via CLI" case.
	}
	return undefined;
}

async function resolveKey(
	ctx: ExtensionCommandContext,
): Promise<{ key: string; source: Exclude<KeySource, "none"> } | undefined> {
	const envKey = process.env.OPENCODE_API_KEY?.trim();
	if (envKey) return { key: envKey, source: "env" };

	try {
		const key = await ctx.modelRegistry.getApiKeyForProvider("opencode-go");
		if (key && key !== "proxy-managed" && key.trim().length > 0) return { key: key.trim(), source: "pi" };
	} catch {
		// Not configured through pi; fall through.
	}

	const fileKey = readOpencodeAuthKey();
	if (fileKey) return { key: fileKey, source: "auth-file" };

	return undefined;
}

// -------------------------------------------------------------------------
// Official endpoint fetch + response parsing
// -------------------------------------------------------------------------

async function fetchUsage(key: string): Promise<{ status: number; body: unknown }> {
	const response = await fetch(DEFAULT_ENDPOINT, {
		headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
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

function parseUsage(body: unknown): Partial<Record<WindowKind, UsageWindow>> {
	const usage = asRecord(asRecord(body)?.usage);
	if (!usage) return {};

	const windows: Partial<Record<WindowKind, UsageWindow>> = {};
	for (const kind of ["rolling", "weekly", "monthly"] as const) {
		const raw = asRecord(usage[kind]);
		if (!raw) continue;
		const percent = asNumber(raw.percent);
		if (percent === undefined) continue;
		windows[kind] = {
			kind,
			percent: Math.max(0, Math.min(100, percent)),
			status: raw.status === "rate-limited" ? "rate-limited" : "ok",
			resetsAt: typeof raw.resetsAt === "string" ? raw.resetsAt : undefined,
		};
	}
	return windows;
}

function missingEntitlement(body: unknown): boolean {
	return asRecord(asRecord(body)?.error)?.type === "EntitlementError";
}

function parseOutcome(status: number, body: unknown): ApiOutcome {
	if (status === 401) return { kind: "unauthorized" };
	if (status === 403) return missingEntitlement(body) ? { kind: "no-subscription" } : { kind: "http", status };
	if (status >= 200 && status < 300) {
		const windows = parseUsage(body);
		return Object.keys(windows).length > 0 ? { kind: "ok", windows } : { kind: "bad-json" };
	}
	return { kind: "http", status };
}

// -------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------

function barColorToken(percent: number, status: UsageStatus): ThemeColor {
	if (status === "rate-limited" || percent >= 90) return "error";
	if (percent >= 80) return "warning";
	return "accent";
}

function formatUntil(resetsAt: string): string {
	const target = Date.parse(resetsAt);
	if (Number.isNaN(target)) return resetsAt;
	const sec = Math.max(0, Math.floor((target - Date.now()) / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ${min % 60}m`;
	const day = Math.floor(hr / 24);
	return `${day}d ${hr % 24}h`;
}

function keyLine(meta: UsageMeta, theme: Theme): string {
	const sourceLabel =
		meta.keySource === "env"
			? "OPENCODE_API_KEY (env)"
			: meta.keySource === "pi"
				? "pi auth / /login opencode-go"
				: meta.keySource === "auth-file"
					? "opencode auth.json"
					: "not configured";
	const detail = meta.keyFingerprint ? ` · ${meta.keyFingerprint}` : "";
	return `${theme.fg("muted", "key")}  ${sourceLabel}${detail}`;
}

function windowLine(kind: WindowKind, window: UsageWindow, theme: Theme): string {
	const percent = Math.max(0, Math.min(100, window.percent));
	const filled = Math.round((percent / 100) * BAR_WIDTH);
	const token = barColorToken(percent, window.status);
	const bar = theme.fg(token, "█".repeat(filled)) + theme.fg("dim", "─".repeat(BAR_WIDTH - filled));
	const percentText = theme.fg(token, `${percent}%`);
	const resetText = window.resetsAt ? theme.fg("dim", `resets ${formatUntil(window.resetsAt)}`) : "";
	const statusText = window.status === "rate-limited" ? theme.fg("error", "  rate-limited") : "";
	return `${theme.fg("muted", WINDOW_LABELS[kind].padEnd(10))}  ${bar}  ${percentText}${statusText}${
		resetText ? `  ${resetText}` : ""
	}`;
}

function buildSuccessLines(details: OcgoDetails, theme: Theme): string[] {
	const { meta, windows } = details;
	const lines: string[] = [];
	lines.push(theme.bold(theme.fg("accent", "OpenCode Go usage")));
	lines.push(`${theme.fg("muted", "endpoint")}  ${theme.fg("dim", meta.endpoint)}`);
	lines.push(`${theme.fg("muted", "provider")}  ${meta.provider}`);
	lines.push(keyLine(meta, theme));
	if (meta.currentModel) {
		const note = meta.usingOpencodeGo ? "" : theme.fg("warning", "  (current session is not OpenCode Go)");
		lines.push(`${theme.fg("muted", "model")}   ${meta.currentModel}${note}`);
	}
	lines.push("");
	for (const kind of ["rolling", "weekly", "monthly"] as const) {
		const window = windows[kind];
		if (window) lines.push(windowLine(kind, window, theme));
	}
	return lines;
}

function buildErrorLines(details: OcgoDetails, theme: Theme): string[] {
	const code = details.error?.code ?? "error";
	const message = details.error?.message ?? "Unknown error";
	return [theme.bold(theme.fg("error", `OpenCode Go usage: <err:${code}>`)), theme.fg("dim", message)];
}

// -------------------------------------------------------------------------
// Extension
// -------------------------------------------------------------------------

export default function limitOpencodeExtension(pi: ExtensionAPI): void {
	// Custom ENTRY (pi.appendEntry): rendered in the transcript, but never sent to the LLM.
	pi.registerEntryRenderer<OcgoDetails>(CUSTOM_TYPE, (entry, _options, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const details = entry.data;
		const lines = details
			? details.result === "ok"
				? buildSuccessLines(details, theme)
				: buildErrorLines(details, theme)
			: [];
		box.addChild(new Text(lines.length > 0 ? lines.join("\n") : "OpenCode Go usage", 0, 0));
		return box;
	});

	// Legacy renderer: sessions recorded before the appendEntry switch still contain
	// custom *messages* with `details`; keep them rendering nicely on reload.
	pi.registerMessageRenderer<OcgoDetails>(CUSTOM_TYPE, (message, { outputPad }, theme) => {
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		const details = message.details;
		const lines = details
			? details.result === "ok"
				? buildSuccessLines(details, theme)
				: buildErrorLines(details, theme)
			: [];
		box.addChild(new Text(lines.length > 0 ? lines.join("\n") : String(message.content), 0, 0));
		return box;
	});

	pi.registerCommand("limit-opencode", {
		description: "Show OpenCode Go usage limits",
		handler: async (_args, ctx) => {
			const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const usingOpencodeGo =
				!!ctx.model && (ctx.model.provider === "opencode-go" || ctx.model.id.startsWith("opencode-go/"));
			const meta: UsageMeta = {
				endpoint: DEFAULT_ENDPOINT,
				provider: "opencode-go",
				keySource: "none",
				currentModel,
				usingOpencodeGo,
				fetchedAt: Date.now(),
			};

			const resolved = await resolveKey(ctx);
			if (resolved) {
				meta.keySource = resolved.source;
				meta.keyFingerprint = maskKey(resolved.key);
			}

			if (!resolved) {
				pi.appendEntry(CUSTOM_TYPE, {
					result: "error",
					windows: {},
					meta,
					error: {
						code: "no-key",
						message: "No OpenCode Go API key found. Set OPENCODE_API_KEY or run /login opencode-go.",
					},
				});
				return;
			}

			try {
				const { status, body } = await fetchUsage(resolved.key);
				const outcome = parseOutcome(status, body);

				switch (outcome.kind) {
					case "ok":
						pi.appendEntry(CUSTOM_TYPE, { result: "ok", windows: outcome.windows, meta });
						return;
					case "unauthorized":
						pi.appendEntry(CUSTOM_TYPE, {
							result: "error",
							windows: {},
							meta,
							error: {
								code: "unauthorized",
								message: "OpenCode rejected the API key (HTTP 401). Re-authenticate or reset OPENCODE_API_KEY.",
							},
						});
						return;
					case "no-subscription":
						pi.appendEntry(CUSTOM_TYPE, {
							result: "error",
							windows: {},
							meta,
							error: {
								code: "no-subscription",
								message: "This OpenCode Go key is valid but has no Go subscription.",
							},
						});
						return;
					case "http":
						pi.appendEntry(CUSTOM_TYPE, {
							result: "error",
							windows: {},
							meta,
							error: {
								code: `http-${outcome.status}`,
								message: `The OpenCode Go usage endpoint returned HTTP ${outcome.status}.`,
							},
						});
						return;
					case "bad-json":
						pi.appendEntry(CUSTOM_TYPE, {
							result: "error",
							windows: {},
							meta,
							error: {
								code: "bad-json",
								message: "The usage endpoint returned an unexpected response shape.",
							},
						});
						return;
				}
			} catch (error) {
				const name = error instanceof Error && error.name ? error.name : "";
				const code = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
				pi.appendEntry(CUSTOM_TYPE, {
					result: "error",
					windows: {},
					meta,
					error: {
						code,
						message:
							code === "timeout"
								? "The request to the OpenCode Go usage endpoint timed out."
								: "Failed to reach the OpenCode Go usage endpoint.",
					},
				});
			}
		},
	});
}
