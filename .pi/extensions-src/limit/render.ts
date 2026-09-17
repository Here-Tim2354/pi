/**
 * Report → TUI lines.
 *
 * The renderer is the only place that knows about layout, so providers stay
 * pure parsers and the block looks identical for every subscription:
 *
 *   Kimi For Coding usage
 *   provider  kimi-coding                    <- plan detail appended when present
 *   key       OAuth · …bap0
 *   model     zai-coding-cn/glm-5.3  (not Kimi For Coding)
 *   endpoint  https://api.kimi.com/coding/v1/usages
 *
 *   5h window  ████────────  33%  33/100  resets 4h 44m
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { LimitEntry, LimitHelp, LimitReport, LimitWindow } from "./types.ts";

const BAR_WIDTH = 12;
/** Keeps short labels such as `key` aligned with `provider`. */
const MIN_LABEL_WIDTH = 6;

interface Row {
	label: string;
	value: string;
}

function barColor(percent: number, status?: string): ThemeColor {
	if (status === "rate-limited" || percent >= 90) return "error";
	if (percent >= 80) return "warning";
	return "accent";
}

function formatPercent(percent: number): string {
	const rounded = Math.round(percent * 10) / 10;
	return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
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

/** Header rows are padded together so every value starts in the same column. */
function renderRows(rows: Row[], theme: Theme): string[] {
	if (rows.length === 0) return [];
	const width = Math.max(MIN_LABEL_WIDTH, ...rows.map((row) => row.label.length));
	return rows.map((row) => `${theme.fg("muted", row.label.padEnd(width))}  ${row.value}`);
}

function windowLine(window: LimitWindow, width: number, theme: Theme): string {
	const name = theme.fg("muted", window.label.padEnd(width));
	if (window.percent === undefined) {
		const counts =
			window.used !== undefined || window.limit !== undefined
				? `${window.used ?? "?"} / ${window.limit ?? "?"}`
				: "no data";
		return `${name}  ${theme.fg("dim", counts)}`;
	}

	const percent = Math.max(0, Math.min(100, window.percent));
	const filled = Math.round((percent / 100) * BAR_WIDTH);
	const token = barColor(percent, window.status);
	const bar = theme.fg(token, "█".repeat(filled)) + theme.fg("dim", "─".repeat(BAR_WIDTH - filled));
	const counts = window.used !== undefined && window.limit ? theme.fg("dim", `  ${window.used}/${window.limit}`) : "";
	const reset = window.resetsAt ? theme.fg("dim", `  resets ${formatUntil(window.resetsAt)}`) : "";
	const status = window.status ? theme.fg(token, `  ${window.status}`) : "";
	return `${name}  ${bar}  ${theme.fg(token, formatPercent(percent))}${counts}${reset}${status}`;
}

function renderWindows(windows: LimitWindow[], theme: Theme): string[] {
	const width = Math.max(...windows.map((window) => window.label.length));
	return windows.map((window) => windowLine(window, width, theme));
}

function headerRows(report: LimitReport, theme: Theme): Row[] {
	const rows: Row[] = [];
	const provider = report.detail ? `${report.providerId} (${report.detail})` : report.providerId;
	rows.push({ label: "provider", value: provider });
	if (report.keyLabel || report.keyFingerprint) {
		const fingerprint = report.keyFingerprint ? ` · ${report.keyFingerprint}` : "";
		rows.push({ label: "key", value: `${report.keyLabel ?? "pi credential"}${fingerprint}` });
	}
	if (report.modelLine) {
		const note = report.modelMatchesPlan ? "" : theme.fg("warning", " — not the active plan");
		rows.push({ label: "model", value: `${report.modelLine}${note}` });
	}
	rows.push({ label: "endpoint", value: theme.fg("dim", report.endpoint) });
	for (const fact of report.facts ?? []) rows.push({ label: fact.label, value: fact.value });
	return rows;
}

function renderFailure(report: LimitReport, theme: Theme): string {
	const code = report.error?.code ?? "error";
	const lines = [theme.bold(theme.fg("error", `${report.planName} usage: <err:${code}>`))];
	const message = report.error?.message ?? "Unknown error";
	const rows: Row[] = [{ label: "error", value: message }];
	if (report.keyLabel || report.keyFingerprint) {
		const fingerprint = report.keyFingerprint ? ` · ${report.keyFingerprint}` : "";
		rows.push({ label: "key", value: `${report.keyLabel ?? "pi credential"}${fingerprint}` });
	}
	rows.push({ label: "endpoint", value: theme.fg("dim", report.endpoint) });
	lines.push(...renderRows(rows, theme));
	return lines.join("\n");
}

function renderReport(report: LimitReport, theme: Theme): string {
	if (report.error) return renderFailure(report, theme);
	const lines = [
		theme.bold(theme.fg("accent", `${report.planName} usage`)),
		...renderRows(headerRows(report, theme), theme),
	];
	if (report.windows.length > 0) lines.push("", ...renderWindows(report.windows, theme));
	for (const note of report.notes ?? []) lines.push(theme.fg("dim", note));
	return lines.join("\n");
}

function renderHelp(help: LimitHelp, theme: Theme): string {
	const lines: string[] = [];
	if (help.unknown) lines.push(theme.bold(theme.fg("error", `Unknown provider: ${help.unknown}`)));
	lines.push(theme.bold(theme.fg("accent", "/limit — subscription quota usage")));
	const width = Math.max(...help.entries.map((entry) => entry.name.length));
	for (const entry of help.entries) {
		const tags: string[] = [];
		if (entry.current) tags.push("active model");
		tags.push(entry.configured ? theme.fg("accent", "configured") : theme.fg("dim", "not configured"));
		lines.push(`${theme.fg("muted", entry.name.padEnd(width))}  ${entry.planName.padEnd(22)}  ${tags.join(", ")}`);
	}
	lines.push(theme.fg("dim", `Usage: /limit <${help.entries.map((entry) => entry.name).join("|")}>`));
	return lines.join("\n");
}

export function renderEntry(entry: LimitEntry | undefined, theme: Theme): string {
	if (!entry) return "/limit";
	return entry.kind === "help" ? renderHelp(entry, theme) : renderReport(entry, theme);
}
