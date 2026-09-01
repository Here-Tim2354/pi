/**
 * fetch extension: fetch a URL and return its content as markdown via Jina Reader.
 *
 * Auth: JINA_API_KEY environment variable. Without it, anonymous Jina access
 * applies (20 requests/minute, and popular domains are often blocked for
 * anonymous users).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const JINA_READER_BASE = "https://r.jina.ai/";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 100 * 1024; // 100KB: modern docs sites carry heavy nav noise before the content

/** Jina Reader success envelope (Accept: application/json). */
interface JinaReaderData {
	title?: string;
	description?: string;
	url?: string;
	content?: string;
	publishedTime?: string;
	warning?: string;
	httpStatus?: number;
	usage?: { tokens?: number };
}

interface JinaReaderResponse {
	code?: number;
	status?: number;
	data?: JinaReaderData | null;
	name?: string;
	message?: string;
}

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".");
	if (parts.length !== 4) return false;
	const octets = parts.map((p) => Number.parseInt(p, 10));
	if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return false;
	const [a, b] = octets as [number, number];
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true; // link-local
	if (a === 172 && b >= 16 && b <= 31) return true; // private
	if (a === 192 && b === 168) return true; // private
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	return false;
}

function isPrivateIpv6(rawHostname: string): boolean {
	const hostname = rawHostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (hostname === "::" || hostname === "::1") return true;
	const mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) return isPrivateIpv4(mapped[1]);
	return hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe8");
}

function validateTargetUrl(raw: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`fetch: invalid URL: ${raw}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`fetch: only http/https URLs are supported: ${raw}`);
	}
	const hostname = parsed.hostname.toLowerCase();
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal")
	) {
		throw new Error(`fetch: local hostnames are not allowed: ${raw}`);
	}
	if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
		throw new Error(`fetch: private network addresses are not allowed: ${raw}`);
	}
	return parsed;
}

function buildJinaErrorMessage(res: { status: number; body: string }): string {
	let parsed: JinaReaderResponse | undefined;
	try {
		parsed = JSON.parse(res.body) as JinaReaderResponse;
	} catch {
		// Body was not JSON; fall through to status-based messages.
	}
	if (res.status === 401) {
		return "fetch: Jina Reader rejected the API key (401). Check the JINA_API_KEY environment variable.";
	}
	if (res.status === 403) {
		if (parsed?.name === "AbuseAlleviationError" || parsed?.status === 40305) {
			return "fetch: Jina Reader blocked anonymous access to this domain (403, abuse mitigation from other users' traffic). Set the JINA_API_KEY environment variable for reliable access.";
		}
		return `fetch: Jina Reader denied the request (403).${parsed?.message ? ` ${parsed.message}` : ""}`;
	}
	if (res.status === 429) {
		return "fetch: Jina Reader rate limit reached (429). Set the JINA_API_KEY environment variable for higher limits, or retry later.";
	}
	return `fetch: Jina Reader returned HTTP ${res.status}.${parsed?.message ? ` ${parsed.message}` : ""}`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function truncateHead(
	content: string,
	maxBytes: number,
): { content: string; truncated: boolean; outputBytes: number; totalBytes: number } {
	const totalBytes = Buffer.byteLength(content, "utf-8");
	if (totalBytes <= maxBytes) {
		return { content, truncated: false, outputBytes: totalBytes, totalBytes };
	}
	// Truncate on a UTF-8 character boundary.
	const buf = Buffer.from(content, "utf-8");
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) {
		end--;
	}
	return { content: buf.subarray(0, end).toString("utf-8"), truncated: true, outputBytes: end, totalBytes };
}

function formatFetchOutput(data: JinaReaderData, truncation: ReturnType<typeof truncateHead>): string {
	const headerLines: string[] = [];
	const title = data.title?.trim();
	const sourceUrl = data.url?.trim();
	const publishedTime = data.publishedTime?.trim();
	const warning = data.warning?.trim();
	if (title) headerLines.push(`Title: ${title}`);
	if (sourceUrl) headerLines.push(`URL Source: ${sourceUrl}`);
	if (publishedTime) headerLines.push(`Published Time: ${publishedTime}`);
	if (warning) headerLines.push(`Warning: ${warning}`);

	const notes: string[] = [];
	const targetStatus = data.httpStatus;
	if (targetStatus !== undefined && targetStatus >= 400) {
		notes.push(
			`[Note: the target site returned HTTP ${targetStatus}. The content below may be a bot-block or error page rather than the real content; do not retry the same URL.]`,
		);
	}

	let output = "";
	if (notes.length > 0) {
		output += `${notes.join("\n")}\n`;
	}
	if (headerLines.length > 0) {
		output += `${headerLines.join("\n")}\n`;
	}
	output += "Markdown Content:\n";
	output += truncation.content;
	if (truncation.truncated) {
		output += `\n\n[Truncated: showing first ${formatBytes(truncation.outputBytes)} of ${formatBytes(truncation.totalBytes)}]`;
	}
	return output;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "fetch",
		label: "fetch",
		description: `Fetch a URL and return its content as markdown. Works well for docs and articles.
Heads up:
- Heavy navigation noise precedes the content on some docs sites; scan past it.
- JS-rendered tables/leaderboards may lose structure; prefer the site's JSON API endpoint if one exists (JSON is returned verbatim).
- A Warning line means the target blocked the request (anti-bot page); do not retry the same URL.
- Reliable use requires JINA_API_KEY; anonymous access is rate-limited.
Output is truncated to ${formatBytes(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Fetch a URL and return its content as markdown",
		promptGuidelines: [
			"Use fetch instead of bash curl or PowerShell web requests when you need to read a web page",
			"Do not retry a URL whose fetch result carries a block warning",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Absolute URL to fetch (http/https)" }),
			mode: Type.Optional(
				StringEnum(["markdown", "text", "html"], { description: "Output format (default: markdown)" }),
			),
		}),
		async execute(_toolCallId, { url, mode }, signal) {
			const target = validateTargetUrl(url);
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const apiKey = process.env.JINA_API_KEY;
			const headers: Record<string, string> = {
				Accept: "application/json",
				"X-Respond-With": mode ?? "markdown",
				// Let the service give up server-side before the client timeout fires.
				"X-Timeout": String(Math.ceil(DEFAULT_TIMEOUT_MS / 1000)),
				"X-Retain-Images": "none",
			};
			if (apiKey) {
				headers.Authorization = `Bearer ${apiKey}`;
			}

			const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

			let res: { status: number; body: string };
			try {
				const response = await fetch(JINA_READER_BASE + target.href, {
					headers,
					signal: combinedSignal,
				});
				res = { status: response.status, body: await response.text() };
			} catch (e) {
				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}
				const message = e instanceof Error ? e.message : String(e);
				throw new Error(`fetch: request failed: ${message}`);
			}

			if (res.status >= 400) {
				throw new Error(buildJinaErrorMessage(res));
			}

			let parsed: JinaReaderResponse;
			try {
				parsed = JSON.parse(res.body) as JinaReaderResponse;
			} catch {
				throw new Error(`fetch: Jina Reader returned a non-JSON response (HTTP ${res.status}).`);
			}
			const data = parsed.data;
			if (!data) {
				throw new Error(`fetch: Jina Reader returned no data${parsed.message ? `: ${parsed.message}` : "."}`);
			}
			if (data.content === undefined) {
				throw new Error("fetch: Jina Reader returned no content.");
			}

			const truncation = truncateHead(data.content, DEFAULT_MAX_BYTES);
			const details: Record<string, unknown> = {};
			if (data.httpStatus !== undefined) details.httpStatus = data.httpStatus;
			if (data.warning) details.warning = data.warning;
			if (data.usage?.tokens !== undefined) details.tokens = data.usage.tokens;
			if (truncation.truncated) details.truncation = truncation;

			return {
				content: [{ type: "text", text: formatFetchOutput(data, truncation) }],
				details,
			};
		},
	});
}
