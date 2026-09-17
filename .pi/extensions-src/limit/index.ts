/**
 * `/limit` — subscription quota for the AI coding plans pi is signed in to.
 *
 *   /limit            list providers and which ones are configured
 *   /limit codex      ChatGPT Codex (Plus/Pro/Business/Enterprise)
 *   /limit kimi       Kimi For Coding
 *   /limit opencode   OpenCode Go
 *   /limit zai        GLM Coding Plan (CN)
 *
 * Every provider resolves its credential through `ctx.modelRegistry`, so pi
 * keeps ownership of stored-vs-environment precedence and OAuth refresh. The
 * result is persisted with `pi.appendEntry` and rendered by
 * `registerEntryRenderer`: the block lands in the TUI transcript but never in
 * the LLM context, and it can be re-rendered from the session file later.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { codexProvider } from "./providers/codex.ts";
import { kimiProvider } from "./providers/kimi.ts";
import { opencodeProvider } from "./providers/opencode.ts";
import { zaiProvider } from "./providers/zai.ts";
import { renderEntry } from "./render.ts";
import type { LimitBase, LimitEntry, LimitHelp, LimitProvider } from "./types.ts";

const ENTRY_TYPE = "limit-usage";
const STATUS_KEY = "limit";
/** Same frames and cadence as pi's own loader (packages/tui/src/components/loader.ts). */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

const PROVIDERS: readonly LimitProvider[] = [codexProvider, kimiProvider, opencodeProvider, zaiProvider];

function baseFor(provider: LimitProvider, ctx: ExtensionCommandContext): LimitBase {
	const model = ctx.model;
	return {
		name: provider.name,
		planName: provider.planName,
		providerId: provider.providerId,
		modelLine: model ? `${model.provider}/${model.id}` : undefined,
		modelMatchesPlan: model?.provider === provider.providerId,
	};
}

function helpEntry(ctx: ExtensionCommandContext, unknown?: string): LimitHelp {
	return {
		kind: "help",
		unknown,
		entries: PROVIDERS.map((provider) => ({
			name: provider.name,
			planName: provider.planName,
			configured: ctx.modelRegistry.getProviderAuthStatus(provider.providerId).configured,
			current: ctx.model?.provider === provider.providerId,
		})),
	};
}

/**
 * Temporary footer status while the request runs. A stored OAuth credential may
 * need a refresh before the vendor call, so the command can take ten seconds;
 * without this the TUI looks unresponsive for that whole time.
 */
async function withStatus<T>(ctx: ExtensionCommandContext, label: string, run: () => Promise<T>): Promise<T> {
	let frame = 0;
	ctx.ui.setStatus(STATUS_KEY, `${SPINNER_FRAMES[0]} ${label}`);
	const timer = setInterval(() => {
		frame = (frame + 1) % SPINNER_FRAMES.length;
		ctx.ui.setStatus(STATUS_KEY, `${SPINNER_FRAMES[frame]} ${label}`);
	}, SPINNER_INTERVAL_MS);
	try {
		return await run();
	} finally {
		clearInterval(timer);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

export default function limitExtension(pi: ExtensionAPI): void {
	// Custom ENTRY (pi.appendEntry): rendered in the transcript, but never sent to the LLM.
	pi.registerEntryRenderer<LimitEntry>(ENTRY_TYPE, (entry, _options, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(renderEntry(entry.data, theme), 0, 0));
		return box;
	});

	pi.registerCommand("limit", {
		description: `Show subscription quota usage (${PROVIDERS.map((provider) => provider.name).join("|")})`,
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim().toLowerCase();
			return PROVIDERS.filter((provider) => provider.name.startsWith(query)).map((provider) => ({
				value: provider.name,
				label: provider.name,
				description: provider.planName,
			}));
		},
		handler: async (args, ctx) => {
			// Only the first argument selects the provider; ignore extra words.
			const name = args.trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase();
			if (!name) {
				pi.appendEntry(ENTRY_TYPE, helpEntry(ctx));
				return;
			}

			const provider = PROVIDERS.find((candidate) => candidate.name === name || candidate.aliases?.includes(name));
			if (!provider) {
				pi.appendEntry(ENTRY_TYPE, helpEntry(ctx, name));
				return;
			}

			pi.appendEntry(
				ENTRY_TYPE,
				await withStatus(ctx, `${provider.name} quota`, () =>
					provider.fetch({ modelRegistry: ctx.modelRegistry, model: ctx.model }, baseFor(provider, ctx)),
				),
			);
		},
	});
}
