/**
 * Credential resolution for providers.
 *
 * pi owns credential precedence (stored credential before environment),
 * refreshes expiring OAuth tokens, and refuses to silently fall back to another
 * credential after a failed refresh. Extensions must not re-implement any of
 * that, so every provider goes through `ctx.modelRegistry.getProviderAuth()`.
 */

import type { LimitBase, LimitContext, LimitProvider, LimitReport } from "./types.ts";
import { failureReport, maskToken } from "./util.ts";

export type CredentialKind = "oauth" | "api-key" | "unknown";

export type KeyOutcome =
	| { ok: true; token: string; label: string; credentialKind: CredentialKind }
	| { ok: false; report: LimitReport };

/**
 * pi hands OAuth providers their token as an `Authorization` header and
 * API-key providers as `apiKey`; accept both so one code path covers every
 * subscription and key.
 */
function tokenFromAuth(auth: { apiKey?: string; headers?: Record<string, string | null | undefined> }):
	| {
			token: string;
			credentialKind: CredentialKind;
	  }
	| undefined {
	const apiKey = auth.apiKey?.trim();
	if (apiKey && apiKey !== "proxy-managed") return { token: apiKey, credentialKind: "api-key" };
	for (const [name, value] of Object.entries(auth.headers ?? {})) {
		if (name.toLowerCase() !== "authorization") continue;
		const token = value?.replace(/^Bearer\s+/i, "").trim();
		if (token) return { token, credentialKind: "oauth" };
	}
	return undefined;
}

/** `keyLabel`/`keyFingerprint` for a report; never the raw token. */
export function keyDisplay(key: Extract<KeyOutcome, { ok: true }>): Pick<LimitReport, "keyLabel" | "keyFingerprint"> {
	return { keyLabel: key.label, keyFingerprint: maskToken(key.token) };
}

/**
 * Resolve the provider's credential, or return the report that should be shown
 * instead of a quota block.
 */
export async function requireKey(
	ctx: LimitContext,
	provider: LimitProvider,
	base: LimitBase,
	endpoint: string,
): Promise<KeyOutcome> {
	let resolved: Awaited<ReturnType<LimitContext["modelRegistry"]["getProviderAuth"]>>;
	try {
		resolved = await ctx.modelRegistry.getProviderAuth(provider.providerId);
	} catch (error) {
		// Refreshing an expiring OAuth token happens in here; report it instead of
		// pretending nothing is configured.
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			report: failureReport(base, endpoint, {
				code: "auth-error",
				message: `Could not obtain a ${provider.providerId} credential: ${message}`,
			}),
		};
	}

	const auth = resolved ? tokenFromAuth(resolved.auth) : undefined;
	if (!auth) {
		return {
			ok: false,
			report: failureReport(base, endpoint, {
				code: "no-key",
				message: `No ${provider.planName} credential found. Configure ${provider.loginHint}.`,
			}),
		};
	}

	return {
		ok: true,
		token: auth.token,
		label: resolved?.source ?? "pi credential",
		credentialKind: auth.credentialKind,
	};
}
