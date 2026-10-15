import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import type { ExtensionCommandContext, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { getThemeByName, initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";

const extensionPath = fileURLToPath(new URL("../../../.pi/extensions-src/check-model.ts", import.meta.url));
const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test model",
	provider: "check-model-test",
	api: "openai-completions",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 512,
};

async function setup(mode: ExtensionCommandContext["mode"] = "tui") {
	const loaded = await loadExtensions([extensionPath], process.cwd());
	expect(loaded.errors).toEqual([]);
	const command = loaded.extensions[0]!.commands.get("check-model")!;
	const appendEntry = vi.fn();
	const sendMessage = vi.fn();
	const sendUserMessage = vi.fn();
	Object.assign(loaded.runtime, { appendEntry, sendMessage, sendUserMessage });
	const requestRender = vi.fn();
	const notify = vi.fn();
	const getAvailable = vi.fn(() => [model]);
	const getProviderAuthStatus = vi.fn(() => ({ configured: false }));
	const getApiKeyAndHeaders = vi.fn<ModelRegistry["getApiKeyAndHeaders"]>(async () => ({
		ok: true,
		apiKey: "test-key",
	}));
	const complete = vi.fn<ModelRegistry["complete"]>(async () => {
		throw new Error("Unexpected completion");
	});
	let interact: (component: { handleInput?(data: string): void; render(width: number): string[] }) => Promise<void> =
		async () => {};
	initTheme("dark");
	const custom = vi.fn<ExtensionUIContext["custom"]>(
		async <T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		) => {
			let finished = false;
			let result!: T;
			const component = await factory(
				{ requestRender } as unknown as TUI,
				getThemeByName("dark")!,
				new KeybindingsManager(),
				(value) => {
					result = value;
					finished = true;
				},
			);
			try {
				await interact(component);
				expect(finished).toBe(true);
			} finally {
				component.dispose?.();
			}
			return result;
		},
	);
	const ctx = {
		mode,
		scopedModels: [{ model }],
		modelRegistry: { getAvailable, getProviderAuthStatus, getApiKeyAndHeaders, complete },
		ui: { custom, notify },
	} as unknown as ExtensionCommandContext;
	return {
		command,
		ctx,
		appendEntry,
		sendMessage,
		sendUserMessage,
		requestRender,
		notify,
		custom,
		getAvailable,
		getProviderAuthStatus,
		complete,
		setInteraction: (handler: typeof interact) => {
			interact = handler;
		},
	};
}

describe("check-model panel-only results", () => {
	it.each(["escape", "ctrl+c"])("discards completed results when closed with %s", async (key) => {
		const fixture = await setup();
		fixture.setInteraction(async (panel) => {
			await vi.waitFor(() => expect(panel.render(100).join("\n")).toContain("1 checked"));
			expect(panel.render(100).join("\n")).toContain("check-model-test/test-model");
			panel.handleInput?.(key === "escape" ? "\x1b" : "\x03");
		});
		await fixture.command.handler("", fixture.ctx);
		expect(fixture.appendEntry).not.toHaveBeenCalled();
		expect(fixture.sendMessage).not.toHaveBeenCalled();
		expect(fixture.sendUserMessage).not.toHaveBeenCalled();
	});

	it("does not persist partial results or render after closing an active check", async () => {
		const fixture = await setup();
		fixture.getProviderAuthStatus.mockReturnValue({ configured: true });
		let probeSignal: AbortSignal | undefined;
		fixture.complete.mockImplementation(
			(_model, _context, options) =>
				new Promise((_resolve, reject) => {
					probeSignal = options?.signal;
					probeSignal?.addEventListener("abort", () => reject(new Error("Probe aborted")), { once: true });
				}),
		);
		let renderCountAtClose = 0;
		fixture.setInteraction(async (panel) => {
			await vi.waitFor(() => expect(fixture.complete).toHaveBeenCalledOnce());
			panel.handleInput?.("\x1b");
			expect(probeSignal?.aborted).toBe(true);
			renderCountAtClose = fixture.requestRender.mock.calls.length;
		});
		await fixture.command.handler("", fixture.ctx);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(fixture.requestRender).toHaveBeenCalledTimes(renderCountAtClose);
		expect(fixture.appendEntry).not.toHaveBeenCalled();
		expect(fixture.sendMessage).not.toHaveBeenCalled();
	});

	it("keeps scope switching, filtering and reruns inside the panel", async () => {
		const fixture = await setup();
		fixture.setInteraction(async (panel) => {
			await vi.waitFor(() => expect(panel.render(100).join("\n")).toContain("1 checked"));
			panel.handleInput?.("\t");
			await vi.waitFor(() => expect(panel.render(100).join("\n")).toContain("[Custom]"));
			panel.handleInput?.("\t");
			await vi.waitFor(() => expect(panel.render(100).join("\n")).toContain("1 checked"));
			panel.handleInput?.("\r");
			await vi.waitFor(() => expect(fixture.getProviderAuthStatus).toHaveBeenCalledTimes(4));
			panel.handleInput?.("unmatched");
			expect(panel.render(100).join("\n")).toContain("No matching models");
			panel.handleInput?.("\x03");
			expect(panel.render(100).join("\n")).toContain("check-model-test/test-model");
			panel.handleInput?.("\x1b");
		});
		await fixture.command.handler("", fixture.ctx);
		expect(fixture.appendEntry).not.toHaveBeenCalled();
		expect(fixture.sendMessage).not.toHaveBeenCalled();
	});

	it("rejects the context-injection argument without running checks", async () => {
		const fixture = await setup();
		await fixture.command.handler("on", fixture.ctx);
		expect(fixture.notify).toHaveBeenCalledWith(expect.stringContaining("does not accept arguments"), "error");
		expect(fixture.custom).not.toHaveBeenCalled();
		expect(fixture.getAvailable).not.toHaveBeenCalled();
		expect(fixture.command.getArgumentCompletions?.("") ?? null).toBeNull();
		expect(fixture.appendEntry).not.toHaveBeenCalled();
		expect(fixture.sendMessage).not.toHaveBeenCalled();
	});

	it.each(["rpc", "print", "json"] as const)("skips checks in %s mode", async (mode) => {
		const fixture = await setup(mode);
		await fixture.command.handler("", fixture.ctx);
		expect(fixture.custom).not.toHaveBeenCalled();
		expect(fixture.getAvailable).not.toHaveBeenCalled();
		expect(fixture.appendEntry).not.toHaveBeenCalled();
		expect(fixture.sendMessage).not.toHaveBeenCalled();
	});
});
