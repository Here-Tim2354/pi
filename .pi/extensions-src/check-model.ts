/**
 * check-model — probe model connectivity/availability from the TUI.
 *
 * Registers a `/check-model` slash command that sends a tiny completion request
 * to each model in a scope (concurrently) and reports reachability as a
 * green/red list in the transcript.
 *
 * Usage:
 *   /check-model      interactive panel; Tab switches scope, Enter re-runs
 *   /check-model on   also inject the results into the LLM context
 *
 * Scopes (switch with Tab inside the panel; first activation auto-starts):
 *   scoped  models currently scoped to the session (ctx.scopedModels); falls
 *           back to all available models when no scope is configured
 *   custom  every model from non-builtin (user-configured / extension)
 *           providers
 *   all     every available model
 *
 * The result list is a windowed selector like /model: type to filter,
 * arrow keys move the selection, and the window scrolls with it.
 *
 * Statuses: ok (green, seconds), timeout (no reply within 15s),
 * unavailable (API clearly rejected the model), error, no-auth, aborted.
 * The TUI only shows binary green/red; details live in the structured data.
 *
 * Context vs TUI: closing the panel stores results with pi.appendEntry() and
 * only renders them in the TUI. With `on` they are sent via pi.sendMessage():
 * `content` (compact JSON) becomes a user message for the LLM, while `details`
 * feeds the visual renderer only — the model never sees the green/red list.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ModelRegistry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	Box,
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "check-model";
const PROBE_PROMPT = "Connectivity probe. Reply with the single word: ok";
const CHECK_TIMEOUT_MS = 15_000;
const AUTH_TIMEOUT_MS = 8_000;
const CONCURRENCY = 8;
const MAX_TOKENS = 512;
const SCOPES = ["scoped", "custom", "all"] as const;
const TAB_LABELS = ["Scoped", "Custom", "All"] as const;
const MODEL_COLUMN_WIDTH = 42;
const LINE_WIDTH = 72;
const MAX_VISIBLE_ROWS = 12;

/** Provider ids compiled into pi; anything else is a user/extension provider. */
const BUILTIN_PROVIDER_IDS = new Set(builtinProviders().map((provider) => provider.id));
// Provider responses that clearly say "this model does not exist / is not supported".
const UNAVAILABLE_PATTERN =
	/\b(404|not found|does not exist|no such model|unknown model|invalid model|unsupported|decommissioned|not available)\b/i;

type CheckScope = (typeof SCOPES)[number];
type ItemStatus = "ok" | "timeout" | "unavailable" | "error" | "no-auth" | "aborted";

interface CheckItem {
	model: string;
	provider: string;
	status: ItemStatus;
	latencyMs?: number;
	/** true when the reply contained "ok"; false when it replied with something else */
	saidOk?: boolean;
	detail?: string;
}

interface CheckModelDetails {
	result: "complete" | "cancelled";
	scope: CheckScope;
	scopeLabel: string;
	checkedAt: string;
	items: CheckItem[];
}

interface ScopeConfig {
	models: Model<Api>[];
	scopeLabel: string;
}

interface PanelScopeResult {
	scope: CheckScope;
	scopeLabel: string;
	cancelled: boolean;
	items: CheckItem[];
}

// -------------------------------------------------------------------------
// Model check (one completion per model, fail fast on missing auth)
// -------------------------------------------------------------------------

type AuthResolution = Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Auth resolution is provider-wide and can involve OAuth refreshes that hang or
 * race under burst concurrency. Cache one promise per provider (per run) and
 * bound it with its own timeout so a stuck auth cannot freeze the whole check.
 */
function getAuthCached(
	model: Model<Api>,
	registry: ModelRegistry,
	authCache: Map<string, Promise<AuthResolution>>,
): Promise<AuthResolution> {
	let pending = authCache.get(model.provider);
	if (!pending) {
		pending = withTimeout(
			registry.getApiKeyAndHeaders(model),
			AUTH_TIMEOUT_MS,
			`auth for provider "${model.provider}"`,
		);
		authCache.set(model.provider, pending);
	}
	return pending;
}

function classifyError(detail: string): "unavailable" | "error" {
	return UNAVAILABLE_PATTERN.test(detail) ? "unavailable" : "error";
}

const TIMEOUT_MARKER = "timed out after";

async function checkModel(
	model: Model<Api>,
	registry: ModelRegistry,
	signal: AbortSignal,
	authCache: Map<string, Promise<AuthResolution>>,
): Promise<CheckItem> {
	const base: CheckItem = { model: `${model.provider}/${model.id}`, provider: model.provider, status: "ok" };

	if (!registry.getProviderAuthStatus(model.provider).configured) {
		return { ...base, status: "no-auth", detail: `Provider "${model.provider}" is not configured` };
	}

	try {
		const auth = await getAuthCached(model, registry, authCache);
		if (!auth.ok) return { ...base, status: "no-auth", detail: auth.error };

		const probe = async (): Promise<CheckItem> => {
			const controller = new AbortController();
			const onOuterAbort = () => controller.abort();
			if (signal.aborted) return { ...base, status: "aborted" };
			signal.addEventListener("abort", onOuterAbort, { once: true });
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, CHECK_TIMEOUT_MS);
			const started = Date.now();
			try {
				const response = await registry.complete(
					model,
					{ messages: [{ role: "user", content: PROBE_PROMPT, timestamp: started }] },
					{ signal: controller.signal, maxTokens: MAX_TOKENS },
				);
				const latencyMs = Date.now() - started;
				if (response.stopReason === "aborted") {
					return timedOut ? { ...base, status: "timeout", latencyMs } : { ...base, status: "aborted", latencyMs };
				}
				if (response.stopReason === "error") {
					const detail = response.errorMessage ?? "request failed";
					return { ...base, status: classifyError(detail), latencyMs, detail };
				}
				const text = response.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("")
					.trim()
					.toLowerCase();
				return {
					...base,
					latencyMs,
					saidOk: text.includes("ok"),
					detail: text.length > 0 ? undefined : "empty reply",
				};
			} finally {
				clearTimeout(timer);
				signal.removeEventListener("abort", onOuterAbort);
			}
		};

		// The soft abort above may never return (providers can hang past abort),
		// so race the whole probe against a hard deadline instead of trusting it.
		return await withTimeout(probe(), CHECK_TIMEOUT_MS + 2_000, `probe for ${model.provider}/${model.id}`);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		if (signal.aborted) return { ...base, status: "aborted" };
		if (detail.includes(TIMEOUT_MARKER)) return { ...base, status: "timeout" };
		return { ...base, status: classifyError(detail), detail };
	}
}

async function runChecks(
	models: readonly Model<Api>[],
	registry: ModelRegistry,
	signal: AbortSignal,
	authCache: Map<string, Promise<AuthResolution>>,
	onStart: (done: number, total: number, current: string) => void,
	onResult: (item: CheckItem) => void,
): Promise<CheckItem[]> {
	const results: CheckItem[] = new Array(models.length);
	let next = 0;
	let done = 0;

	const worker = async (): Promise<void> => {
		while (next < models.length) {
			if (signal.aborted) return;
			const index = next++;
			const model = models[index]!;
			onStart(done, models.length, `${model.provider}/${model.id}`);
			const item = await checkModel(model, registry, signal, authCache);
			results[index] = item;
			done++;
			onResult(item);
		}
	};

	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, models.length) }, () => worker()));

	// Models never started because of a cancel still need a row. Map over the
	// dense models list: `results` can be sparse when workers abort early.
	return models.map((model, index) => {
		const result = results[index];
		if (result) return result;
		return { model: `${model.provider}/${model.id}`, provider: model.provider, status: "aborted" as const };
	});
}

// -------------------------------------------------------------------------
// Scope resolution
// -------------------------------------------------------------------------

function collectScopeConfigs(ctx: ExtensionCommandContext): {
	scoped: ScopeConfig;
	custom: ScopeConfig;
	all: ScopeConfig;
	warning?: string;
} {
	const available = ctx.modelRegistry.getAvailable();
	const allConfig: ScopeConfig = { models: [...available], scopeLabel: `all (${available.length})` };
	const customModels = available.filter((model) => !BUILTIN_PROVIDER_IDS.has(model.provider));
	const customConfig: ScopeConfig = {
		models: customModels,
		scopeLabel: `custom providers (${customModels.length})`,
	};
	const scoped = ctx.scopedModels.map((scopedModel) => scopedModel.model);
	if (scoped.length === 0) {
		return {
			scoped: allConfig,
			custom: customConfig,
			all: allConfig,
			warning: "No scoped models configured; the Scoped tab checks all available models instead.",
		};
	}
	return {
		scoped: { models: scoped, scopeLabel: `scoped (${scoped.length})` },
		custom: customConfig,
		all: allConfig,
	};
}

// -------------------------------------------------------------------------
// Rendering helpers (shared by the live panel and the transcript renderer)
// -------------------------------------------------------------------------

// Explicit green instead of the theme's `success` token: some themes render it
// as olive/yellow, and reachability must read as unambiguous green/red.
const GREEN_ANSI = "\x1b[38;2;76;175;80m";

function greenText(text: string): string {
	return `${GREEN_ANSI}${text}\x1b[39m`; // Reset only foreground color, same as Theme.fg
}

function statusGlyph(status: ItemStatus): { glyph: string; reachable: boolean } {
	// TUI keeps it binary: green = reachable, red = not reachable.
	return status === "ok" ? { glyph: "✓", reachable: true } : { glyph: "✗", reachable: false };
}

function statusWord(item: CheckItem): string {
	switch (item.status) {
		case "ok":
			return item.latencyMs !== undefined ? `${(item.latencyMs / 1000).toFixed(2)}s` : "";
		case "timeout":
			return "timeout";
		case "unavailable":
			return "unavailable";
		case "error":
			return "error";
		case "no-auth":
			return "no-auth";
		case "aborted":
			return "cancelled";
	}
}

function formatItemLine(item: CheckItem, theme: Theme, width: number, selected = false): string {
	const { glyph, reachable } = statusGlyph(item.status);
	const model = truncateToWidth(item.model, MODEL_COLUMN_WIDTH).padEnd(MODEL_COLUMN_WIDTH);
	const line = truncateToWidth(`${selected ? "→" : " "} ${glyph} ${model} ${statusWord(item)}`, width);
	return reachable ? greenText(line) : theme.fg("error", line);
}

function summaryLine(items: CheckItem[], theme: Theme): string {
	const count = (status: ItemStatus): number => items.filter((item) => item.status === status).length;
	const parts = [`${items.length} checked`, greenText(`${count("ok")} ok`)];
	const failed = count("unavailable") + count("error");
	if (failed > 0) parts.push(theme.fg("error", `${failed} failed`));
	if (count("timeout") > 0) parts.push(theme.fg("error", `${count("timeout")} timeout`));
	if (count("no-auth") > 0) parts.push(theme.fg("error", `${count("no-auth")} no-auth`));
	if (count("aborted") > 0) parts.push(theme.fg("muted", `${count("aborted")} cancelled`));
	return parts.join(theme.fg("muted", " / "));
}

// -------------------------------------------------------------------------
// Interactive panel: first activation of a scope auto-starts its check;
// Tab only switches, Enter force-re-runs the current scope
// -------------------------------------------------------------------------

interface ScopeState {
	runId: number;
	started: boolean;
	running: boolean;
	cancelled: boolean;
	items: CheckItem[];
	total: number;
	done: number;
	current: string;
	scopeLabel: string;
	models: Model<Api>[];
	controller?: AbortController;
}

class ModelCheckPanel extends Container implements Focusable {
	private tabIndex: number;
	private readonly states: Record<CheckScope, ScopeState>;
	private readonly theme: Theme;
	private readonly registry: ModelRegistry;
	private readonly tui: TUI;
	private readonly searchInput = new Input();
	private readonly authCache = new Map<string, Promise<AuthResolution>>();
	private selectedIndex = 0;

	public onFinish?: (results: PanelScopeResult[]) => void;

	// Focusable implementation - propagate to searchInput for IME cursor positioning.
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private readonly tabRowText: Text;
	private readonly searchText: Text;
	private readonly bodyText: Text;
	private readonly footerText: Text;

	constructor(
		tui: TUI,
		theme: Theme,
		registry: ModelRegistry,
		scoped: ScopeConfig,
		custom: ScopeConfig,
		all: ScopeConfig,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.registry = registry;
		this.tabIndex = 0;
		const emptyState = (scopeLabel: string, models: Model<Api>[]): ScopeState => ({
			runId: 0,
			started: false,
			running: false,
			cancelled: false,
			items: [],
			total: models.length,
			done: 0,
			current: "",
			scopeLabel,
			models,
		});
		this.states = {
			scoped: emptyState(scoped.scopeLabel, scoped.models),
			custom: emptyState(custom.scopeLabel, custom.models),
			all: emptyState(all.scopeLabel, all.models),
		};

		this.tabRowText = new Text("", 1, 0);
		this.searchText = new Text("", 1, 0);
		this.bodyText = new Text("", 1, 0);
		this.footerText = new Text("", 1, 0);

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Check model connectivity")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.tabRowText);
		this.addChild(new Spacer(1));
		this.addChild(this.searchText);
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.bodyText);
		this.addChild(new Spacer(1));
		this.addChild(this.footerText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.refresh();
		this.ensureStarted(this.currentScope());
	}

	private currentScope(): CheckScope {
		return SCOPES[this.tabIndex]!;
	}

	/** Auto-start a scope's first check; already-checked scopes keep their results. */
	private ensureStarted(scope: CheckScope): void {
		if (!this.states[scope]!.started) this.startScope(scope);
		else this.refresh();
	}

	private startScope(scope: CheckScope, force = false): void {
		const state = this.states[scope]!;
		if (state.running && !force) return;
		if (state.running) state.controller?.abort();
		if (force) this.authCache.clear(); // A rerun must not inherit stale or poisoned auth promises.

		const controller = new AbortController();
		const runId = ++state.runId;
		state.started = true;
		state.running = true;
		state.cancelled = false;
		state.items = [];
		state.total = state.models.length;
		state.done = 0;
		state.current = "";
		state.controller = controller;
		runChecks(
			state.models,
			this.registry,
			controller.signal,
			this.authCache,
			(done, total, current) => {
				if (state.runId !== runId) return; // stale run after a rerun
				state.done = done;
				state.total = total;
				state.current = current;
				this.refresh();
				this.tui.requestRender();
			},
			(item) => {
				if (state.runId !== runId) return; // stale run after a rerun
				state.items.push(item);
				this.refresh();
				this.tui.requestRender();
			},
		).then((items) => {
			if (state.runId !== runId) return; // stale run after a rerun
			state.running = false;
			state.cancelled = controller.signal.aborted;
			state.items = items;
			this.refresh();
			this.tui.requestRender();
		});
		this.refresh();
	}

	private cancelAll(): void {
		for (const scope of SCOPES) {
			const state = this.states[scope]!;
			if (state.running) {
				state.controller?.abort();
				state.running = false;
				state.cancelled = true;
			}
		}
	}

	private collectResults(): PanelScopeResult[] {
		const results: PanelScopeResult[] = [];
		for (const scope of SCOPES) {
			const state = this.states[scope]!;
			if (!state.started) continue;
			results.push({ scope, scopeLabel: state.scopeLabel, cancelled: state.cancelled, items: state.items });
		}
		return results;
	}

	private filteredItems(state: ScopeState): CheckItem[] {
		const query = this.searchInput.getValue().trim();
		if (!query) return state.items;
		return fuzzyFilter(state.items, query, (item) => item.model);
	}

	private moveSelection(delta: number): void {
		const items = this.filteredItems(this.states[this.currentScope()]!);
		if (items.length === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + items.length) % items.length;
		this.refresh();
	}

	private scopeBody(state: ScopeState, width: number): string[] {
		const lines: string[] = [];
		if (state.running) {
			const current = state.current ? ` — ${state.current}` : "";
			lines.push(this.theme.fg("accent", truncateToWidth(`Checking ${state.done}/${state.total}${current}`, width)));
		} else {
			lines.push(summaryLine(state.items, this.theme));
		}

		// Windowed list like the /model selector: the view follows the selection.
		const items = this.filteredItems(state);
		if (items.length === 0) {
			// Only a non-matching filter produces an empty list; an empty result
			// set during an early run just has no rows yet.
			if (this.searchInput.getValue().trim()) lines.push(this.theme.fg("muted", "  No matching models"));
			return lines;
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, items.length - 1));
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE_ROWS / 2), items.length - MAX_VISIBLE_ROWS),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE_ROWS, items.length);
		for (let index = startIndex; index < endIndex; index++) {
			lines.push(formatItemLine(items[index]!, this.theme, width, index === this.selectedIndex));
		}
		if (items.length > MAX_VISIBLE_ROWS) {
			lines.push(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${items.length})`));
		}
		return lines;
	}

	private refresh(): void {
		const theme = this.theme;
		const scope = this.currentScope();
		const parts = TAB_LABELS.map((label, index) =>
			index === this.tabIndex ? theme.fg("accent", theme.bold(`[${label}]`)) : theme.fg("muted", label),
		);
		this.tabRowText.setText(
			`${theme.fg("muted", "scope:")} ${parts.join(theme.fg("muted", " · "))}${
				this.states[scope]!.running ? theme.fg("dim", "  (running)") : ""
			}`,
		);
		const query = this.searchInput.getValue();
		this.searchText.setText(query ? theme.fg("muted", `filter: ${query}`) : theme.fg("dim", "type to filter"));
		this.bodyText.setText(this.scopeBody(this.states[scope]!, LINE_WIDTH).join("\n"));
		this.footerText.setText(theme.fg("dim", "tab switch · ↑↓ navigate · enter rerun · type to filter · esc close"));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			// Same convention as the /model panel: first ctrl+c clears the filter,
			// only an empty filter closes the panel.
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.selectedIndex = 0;
				this.refresh();
			} else {
				this.close();
			}
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			const delta = matchesKey(data, Key.shift("tab")) ? TAB_LABELS.length - 1 : 1;
			this.tabIndex = (this.tabIndex + delta) % TAB_LABELS.length;
			// Switching only reveals cached results; a scope's first activation
			// auto-starts its check. Enter is the explicit re-run.
			this.ensureStarted(this.currentScope());
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.startScope(this.currentScope(), true);
			return;
		}
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		this.searchInput.handleInput(data);
		this.selectedIndex = 0; // new filter, restart from the top
		this.refresh();
	}

	private close(): void {
		this.cancelAll();
		this.onFinish?.(this.collectResults());
	}

	dispose(): void {
		this.cancelAll();
	}
}

// -------------------------------------------------------------------------
// Result rendering (TUI visualization; the LLM never sees this)
// -------------------------------------------------------------------------

function renderDetails(details: CheckModelDetails | undefined, expanded: boolean, theme: Theme, pad: number) {
	const box = new Box(pad, 1, (text) => theme.bg("customMessageBg", text));
	if (!details) {
		box.addChild(new Text(theme.fg("muted", "Model check: no details"), 0, 0));
		return box;
	}
	const title = theme.bold(theme.fg("accent", `Model check · ${details.scopeLabel}`));
	box.addChild(new Text(`${title}  ${theme.fg("muted", "·")}  ${summaryLine(details.items, theme)}`, 0, 0));
	box.addChild(new Text(theme.fg("dim", new Date(details.checkedAt).toLocaleString()), 0, 0));
	box.addChild(new Text("", 0, 0));
	for (const item of details.items) {
		box.addChild(new Text(formatItemLine(item, theme, LINE_WIDTH), 0, 0));
		if (expanded && item.detail) {
			box.addChild(new Text(theme.fg("dim", `    ${item.detail}`), 0, 0));
		}
	}
	if (details.result === "cancelled") {
		box.addChild(new Text("", 0, 0));
		box.addChild(new Text(theme.fg("warning", "Cancelled — partial results shown."), 0, 0));
	}
	return box;
}

// -------------------------------------------------------------------------
// LLM-facing structured content (what the model receives when `on` is used)
// -------------------------------------------------------------------------

function buildContextContent(details: CheckModelDetails): string {
	const count = (status: ItemStatus): number => details.items.filter((item) => item.status === status).length;
	return JSON.stringify({
		type: "model-check",
		checkedAt: details.checkedAt,
		scope: details.scopeLabel,
		summary: {
			total: details.items.length,
			ok: count("ok"),
			timeout: count("timeout"),
			unavailable: count("unavailable"),
			error: count("error"),
			noAuth: count("no-auth"),
			cancelled: count("aborted"),
		},
		items: details.items.map((item) => ({
			model: item.model,
			status: item.status,
			...(item.latencyMs !== undefined ? { latencyMs: item.latencyMs } : {}),
			...(item.status === "ok" && item.saidOk === false ? { note: "responded but did not reply with ok" } : {}),
			...(item.detail ? { detail: item.detail } : {}),
		})),
	});
}

// -------------------------------------------------------------------------
// Extension
// -------------------------------------------------------------------------

export default function checkModelExtension(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<CheckModelDetails>(CUSTOM_TYPE, (message, { expanded, outputPad }, theme) =>
		renderDetails(message.details, expanded, theme, outputPad),
	);

	pi.registerEntryRenderer<CheckModelDetails>(CUSTOM_TYPE, (entry, { expanded }, theme) =>
		renderDetails(entry.data, expanded, theme, 0),
	);

	pi.registerCommand("check-model", {
		description: "Check model connectivity/availability (Tab switches scope, Enter re-runs)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items: AutocompleteItem[] = [{ value: "on", label: "on — also inject results into LLM context" }];
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const unknown = tokens.filter((token) => token !== "on");
			if (unknown.length > 0) {
				ctx.ui.notify(
					`Unknown argument "${unknown[0]}". Usage: /check-model [on] — switch scope with Tab in the panel.`,
					"error",
				);
				return;
			}
			const intoContext = tokens.includes("on");

			const writeResults = (results: PanelScopeResult[]): void => {
				for (const scopeResult of results) {
					if (scopeResult.items.length === 0) continue;
					const details: CheckModelDetails = {
						result: scopeResult.cancelled ? "cancelled" : "complete",
						scope: scopeResult.scope,
						scopeLabel: scopeResult.scopeLabel,
						checkedAt: new Date().toISOString(),
						items: scopeResult.items,
					};
					if (intoContext) {
						pi.sendMessage({
							customType: CUSTOM_TYPE,
							content: buildContextContent(details),
							display: true,
							details,
						});
					} else {
						pi.appendEntry<CheckModelDetails>(CUSTOM_TYPE, details);
					}
				}
			};

			if (ctx.mode !== "tui") {
				const configs = collectScopeConfigs(ctx);
				const items = await runChecks(
					configs.scoped.models,
					ctx.modelRegistry,
					new AbortController().signal,
					new Map(),
					() => {},
					() => {},
				);
				writeResults([{ scope: "scoped", scopeLabel: configs.scoped.scopeLabel, cancelled: false, items }]);
				return;
			}

			const { scoped, custom, all, warning } = collectScopeConfigs(ctx);
			if (warning) ctx.ui.notify(warning, "warning");

			const results = await ctx.ui.custom<PanelScopeResult[]>((tui, theme, _keybindings, done) => {
				const panel = new ModelCheckPanel(tui, theme, ctx.modelRegistry, scoped, custom, all);
				panel.onFinish = (panelResults) => done(panelResults);
				return panel;
			});
			writeResults(results);
		},
	});
}
