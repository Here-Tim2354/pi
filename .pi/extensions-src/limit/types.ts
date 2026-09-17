/**
 * Shared quota model for the `/limit` command.
 *
 * Providers only parse vendor payloads into this shape; the entry renderer
 * turns the shape into TUI lines. Keeping the model vendor-agnostic is what
 * lets one renderer and one persisted entry type cover every subscription.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** One quota window: rolling 5h, weekly, monthly, ... as the vendor reports it. */
export interface LimitWindow {
	label: string;
	/** 0..100 when the vendor reports a ratio; undefined when only counts are known. */
	percent?: number;
	used?: number;
	limit?: number;
	/** ISO timestamp of the next reset. */
	resetsAt?: string;
	/** Vendor state suffix, e.g. `rate-limited`. */
	status?: string;
}

/** Provider-specific extra row, e.g. a credits balance. */
export interface LimitFact {
	label: string;
	value: string;
}

export interface LimitError {
	code: string;
	message: string;
}

/** Everything the renderer needs; it never fetches anything itself. */
export interface LimitReport {
	kind: "report";
	/** `/limit <name>` argument that produced this report. */
	name: string;
	/** Plan name as the vendor markets it, e.g. `Kimi For Coding`. Headlines the block. */
	planName: string;
	endpoint: string;
	/** pi provider id the quota belongs to. */
	providerId: string;
	/** pi's label for the credential that was used, e.g. `OAuth`. */
	keyLabel?: string;
	keyFingerprint?: string;
	/** `provider/model` of the session that ran the command. */
	modelLine?: string;
	modelMatchesPlan?: boolean;
	/** Provider summary appended to the provider row, e.g. `Lite, credits`. */
	detail?: string;
	facts?: LimitFact[];
	windows: LimitWindow[];
	notes?: string[];
	error?: LimitError;
}

export interface LimitHelpEntry {
	name: string;
	planName: string;
	configured: boolean;
	/** True when the session's active model belongs to this provider. */
	current: boolean;
}

export interface LimitHelp {
	kind: "help";
	/** Set when the user asked for a name that does not exist. */
	unknown?: string;
	entries: LimitHelpEntry[];
}

/** Payload of the `limit-usage` custom entry. */
export type LimitEntry = LimitReport | LimitHelp;

/** Common fields the command fills in before a provider runs. */
export interface LimitBase {
	name: string;
	planName: string;
	providerId: string;
	modelLine?: string;
	modelMatchesPlan?: boolean;
}

/** Subset of `ExtensionCommandContext` that providers depend on. */
export interface LimitContext {
	modelRegistry: Pick<ModelRegistry, "getProviderAuth" | "getProvider">;
	model?: Model<Api>;
}

export interface LimitProvider {
	/** `/limit <name>` argument. */
	name: string;
	/** Plan name as the vendor markets it, e.g. `Kimi For Coding`. */
	planName: string;
	providerId: string;
	/** Shown when no credential is configured, e.g. `KIMI_API_KEY or /login kimi-coding`. */
	loginHint: string;
	/** Additional accepted names, e.g. the pi provider id. */
	aliases?: readonly string[];
	fetch(ctx: LimitContext, base: LimitBase): Promise<LimitReport>;
}
