/**
 * analyze_image — vision subagent tool
 *
 * Ported from pi-image-subagent (github.com/AlvaroRausell/pi-image-subagent),
 * which was written for the pre-rename @mariozechner/* package scope. The
 * subprocess invocation follows this repo's subagent example
 * (packages/coding-agent/examples/extensions/subagent).
 *
 * Registers an `analyze_image` tool. When the current model cannot view
 * images, it delegates analysis to a vision-capable subagent: a separate
 * headless `pi` process with only the `read` tool. The subagent reads the
 * image files (pixels enter the vision model's context as attachments),
 * reasons about them, and returns a plain-text answer. The main conversation
 * only receives that final text — subagent turns never enter it.
 *
 * The subagent is stateless: no session file, no conversation history from
 * the caller. Only the task text and image paths are passed in.
 *
 * Config (JSON, all fields optional except "model"):
 *   <agentDir>/extensions/analyze-image/config.json
 *   {
 *     "model": "google/gemini-2.5-flash",   // vision model, provider/model-id
 *     "systemPrompt": "...",                 // subagent system prompt
 *     "maxImagesPerCall": 10
 *   }
 * The `model` tool parameter overrides the configured default per call.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Configuration ──────────────────────────────────────────────────────────

interface AnalyzeImageConfig {
	model?: string;
	systemPrompt: string;
	maxImagesPerCall: number;
}

const CONFIG_PATH = path.join(getAgentDir(), "extensions", "analyze-image", "config.json");

const DEFAULT_CONFIG: AnalyzeImageConfig = {
	model: undefined,
	systemPrompt: [
		"You are an image analysis assistant. You MUST:",
		"1. Read EVERY image file listed below using the `read` tool before answering",
		"2. Answer the user's question about the images accurately and thoroughly",
		"3. Return ONLY your analysis as plain text",
		"",
		"Do NOT describe images without reading them first.",
		"Do NOT suggest further actions or offer to do additional work.",
		"Focus entirely on answering the user's question about the images.",
	].join("\n"),
	maxImagesPerCall: 10,
};

const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

function loadConfig(): AnalyzeImageConfig {
	try {
		if (fs.existsSync(CONFIG_PATH)) {
			const raw: unknown = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
			if (raw && typeof raw === "object") {
				const obj = raw as { model?: unknown; systemPrompt?: unknown; maxImagesPerCall?: unknown };
				return {
					model: typeof obj.model === "string" && obj.model.length > 0 ? obj.model : undefined,
					systemPrompt:
						typeof obj.systemPrompt === "string" && obj.systemPrompt.length > 0
							? obj.systemPrompt
							: DEFAULT_CONFIG.systemPrompt,
					maxImagesPerCall:
						typeof obj.maxImagesPerCall === "number" && Number.isFinite(obj.maxImagesPerCall)
							? Math.max(1, Math.floor(obj.maxImagesPerCall))
							: DEFAULT_CONFIG.maxImagesPerCall,
				};
			}
		}
	} catch (error) {
		console.error(`[analyze-image] Failed to load config from '${CONFIG_PATH}':`, error);
	}
	return { ...DEFAULT_CONFIG };
}

// ─── Image validation ───────────────────────────────────────────────────────

function validateImagePath(imagePath: string, cwd: string): string {
	const absolutePath = path.resolve(cwd, imagePath);

	if (!fs.existsSync(absolutePath)) {
		throw new Error(`Image file not found: ${absolutePath}`);
	}

	const ext = path.extname(absolutePath).toLowerCase();
	if (!SUPPORTED_EXTENSIONS.has(ext)) {
		throw new Error(`Unsupported image format '${ext}'. Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`);
	}

	return absolutePath;
}

// ─── Subagent execution ─────────────────────────────────────────────────────

interface SubagentResult {
	exitCode: number;
	output: string;
	stderr: string;
}

/** Minimal shape of one NDJSON event from `pi --mode json` output. */
interface SubagentStreamEvent {
	type?: unknown;
	message?: unknown;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

async function runVisionSubagent(
	model: string,
	systemPrompt: string,
	task: string,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<SubagentResult> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-analyze-image-"));
	const promptPath = path.join(tmpDir, "system-prompt.md");

	const result: SubagentResult = { exitCode: 0, output: "", stderr: "" };
	const messages: Message[] = [];
	let wasAborted = false;

	try {
		await fs.promises.writeFile(promptPath, systemPrompt, { encoding: "utf-8", mode: 0o600 });

		const args: string[] = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			model,
			"--tools",
			"read",
			"--append-system-prompt",
			promptPath,
			`Task: ${task}`,
		];

		result.exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdoutBuffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line) as SubagentStreamEvent;
					if (event.type === "message_end" && event.message) {
						messages.push(event.message as Message);
					}
				} catch {
					/* skip non-JSON lines */
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				stdoutBuffer += data.toString();
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: Buffer) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (stdoutBuffer.trim()) processLine(stdoutBuffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		if (wasAborted) throw new Error("Image analysis was aborted");

		result.output = getFinalOutput(messages);
		return result;
	} finally {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

// ─── Tool ───────────────────────────────────────────────────────────────────

interface AnalyzeImageDetails {
	model: string;
	imageCount: number;
	imagePaths: string[];
	question: string;
	exitCode: number;
	durationMs: number;
}

const AnalyzeImageParams = Type.Object({
	images: Type.Array(Type.String({ description: "Local file path to an image" }), {
		description: "One or more local image file paths to analyze",
	}),
	question: Type.String({ description: "Question about the image(s)" }),
	model: Type.Optional(
		Type.String({ description: "Override the configured default vision model (provider/model-id)" }),
	),
});

export default function analyzeImageExtension(pi: ExtensionAPI) {
	let config = loadConfig();

	// Reload config on each new session
	pi.on("session_start", () => {
		config = loadConfig();
	});

	pi.registerTool({
		name: "analyze_image",
		label: "Analyze Image",
		description: [
			"Analyze one or more images using a vision-capable model.",
			"Provide local file paths and a question about the images.",
			"A vision subagent reads the images and returns a plain text description.",
			"Use this tool when you cannot view images directly.",
			"Supports PNG, JPG, JPEG, GIF, WebP, and BMP formats.",
		].join(" "),
		promptSnippet: "Analyze images with a vision model",
		promptGuidelines: [
			"Use analyze_image when you need to understand image content but cannot view images directly.",
			"Provide specific, focused questions for best results.",
		],
		parameters: AnalyzeImageParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<AnalyzeImageDetails>> {
			const model = params.model ?? config.model;

			if (!model) {
				throw new Error(
					[
						"analyze_image is not configured: no vision model set.",
						`Create ${CONFIG_PATH} with a "model" field, for example:`,
						'{ "model": "google/gemini-2.5-flash" }',
						"The model must support image input and have configured auth.",
					].join("\n"),
				);
			}

			if (params.images.length === 0) {
				throw new Error("No images provided. Pass at least one image path.");
			}

			if (params.images.length > config.maxImagesPerCall) {
				throw new Error(`Too many images (${params.images.length}). Maximum is ${config.maxImagesPerCall}.`);
			}

			// validateImagePath throws with a descriptive message on failure
			const absolutePaths = params.images.map((img) => validateImagePath(img, ctx.cwd));

			const imageList = absolutePaths.map((p) => `  - ${p}`).join("\n");
			const task = [
				"Read and analyze the following image(s):",
				imageList,
				"",
				`Question: ${params.question}`,
				"",
				"Remember: Read each image file first using the read tool, then answer the question.",
			].join("\n");

			const startTime = Date.now();
			const subResult = await runVisionSubagent(model, config.systemPrompt, task, ctx.cwd, signal);
			const durationMs = Date.now() - startTime;

			if (subResult.exitCode !== 0 || !subResult.output) {
				const errorMsg = subResult.stderr || subResult.output || "Subagent failed with no output";
				throw new Error(`Image analysis failed: ${errorMsg}`);
			}

			return {
				content: [{ type: "text", text: subResult.output }],
				details: {
					model,
					imageCount: absolutePaths.length,
					imagePaths: absolutePaths,
					question: params.question,
					exitCode: 0,
					durationMs,
				},
			};
		},

		renderCall(args, theme) {
			const images = args.images ?? [];
			const preview = args.question
				? args.question.length > 50
					? `${args.question.slice(0, 50)}...`
					: args.question
				: "(no question)";

			let text = theme.fg("toolTitle", theme.bold("analyze_image "));
			text += theme.fg("accent", `${images.length} image${images.length !== 1 ? "s" : ""}`);
			if (args.model) text += theme.fg("muted", ` [${args.model}]`);
			text += `\n  ${theme.fg("dim", preview)}`;

			if (images.length > 0 && images.length <= 3) {
				for (const img of images) {
					text += `\n  ${theme.fg("dim", `- ${path.basename(img)}`)}`;
				}
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme, context) {
			const details = result.details as AnalyzeImageDetails | undefined;
			const icon = context.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

			let text = `${icon} ${theme.fg("toolTitle", theme.bold("analyze_image"))}`;

			if (details?.model) text += theme.fg("muted", ` (${details.model})`);
			if (details?.durationMs) {
				const seconds = (details.durationMs / 1000).toFixed(1);
				text += theme.fg("dim", ` ${seconds}s`);
			}

			const output = result.content[0];
			if (output?.type === "text") {
				if (options.expanded) {
					text += `\n${theme.fg("toolOutput", output.text)}`;
				} else {
					const lines = output.text.split("\n");
					text += `\n${theme.fg("toolOutput", lines.slice(0, 5).join("\n"))}`;
					if (lines.length > 5) {
						text += theme.fg("muted", `\n... (${lines.length - 5} more lines, Ctrl+O to expand)`);
					}
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
