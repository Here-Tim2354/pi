# @tim2354/pi-limit

One `/limit` command for the subscription quotas of the AI coding plans pi is signed in to.

```
/limit            list providers, mark which are configured and which match the active model
/limit codex      ChatGPT Codex (Plus / Pro / Business / Enterprise)
/limit kimi       Kimi For Coding (Kimi Code subscription)
/limit opencode   OpenCode Go (Zen)
/limit zai        GLM Coding Plan (CN / 智谱 bigmodel)
```

Tab completion works after `/limit `.

## Providers

| Argument   | Plan                    | Endpoint                                                    | API status |
| ---------- | ----------------------- | ----------------------------------------------------------- | ---------- |
| `codex`    | ChatGPT Codex           | `GET https://chatgpt.com/backend-api/wham/usage`             | private    |
| `kimi`     | Kimi For Coding         | `GET https://api.kimi.com/coding/v1/usages`                   | private    |
| `opencode` | OpenCode Go             | `GET https://opencode.ai/zen/go/v1/usage`                     | documented |
| `zai`      | GLM Coding Plan (CN)    | `GET {origin}/api/monitor/usage/quota/limit`                  | private    |

"Private" means the vendor uses the endpoint for its own client and publishes no contract for it
(`codex` is what the Codex CLI reads for `/status`; `kimi` is what the Kimi Code CLI uses; `zai` is what the
official `zai-org/zai-coding-plugins` → `glm-plan-usage` plugin uses). Responses are parsed defensively: a window
row without a ratio and without counts is dropped, and when every row is dropped the command reports
`<err:no-quota>` rather than an empty successful block.

## Credentials

Every provider resolves its credential through `ctx.modelRegistry.getProviderAuth(providerId)`, never by reading
`auth.json` or environment variables directly. That keeps one owner for:

- stored credential before environment variable (`kimi-coding`, `zai-coding-cn`, `opencode-go`, `openai-codex`);
- OAuth token refresh, including the rotating Kimi Code token;
- no silent fallback to another credential after a failed refresh.

The block shows pi's own label for the credential it used (`OAuth`, `stored credential`, `KIMI_API_KEY`) plus a
last-4 fingerprint, never the secret.

## Output

The report is persisted with `pi.appendEntry` and drawn by `registerEntryRenderer` as custom entry type
`limit-usage`. Custom entries are rendered in the TUI transcript but never enter the LLM context, and the block
can be re-rendered from the session file later. A failure still produces a block (`<err:no-key>`,
`<err:unauthorized>`, `<err:timeout>`, …) so a silent empty result is impossible.

While a request runs, the command sets a temporary footer status (`⠋ kimi quota`) using the same braille frames
and 80 ms cadence as pi's own loader, and clears it when the block lands. A stored OAuth credential may need a
refresh before the vendor call, so a command can take ten seconds; without the status the TUI looks
unresponsive for that whole time.

## Notes and limits

- **Codex**: needs a Plus/Pro/Business subscription. Account ids and the account email are deliberately not
  rendered. Per-model `additional_rate_limits` only appear when the backend reports them (null on many accounts).
  Window names come from `limit_window_seconds`, not from the backend's primary/secondary labels.
- **Kimi**: API keys authenticate but return an empty payload — only the subscription (OAuth) credential exposes
  plan quota, so that case says so explicitly. `KIMI_CODE_BASE_URL` is honored, like the CLI.
- **ZAI**: personal Coding Plan required; team or pay-as-you-go keys have no plan quota. The host follows the
  provider's `baseUrl`, so the same command works against `api.z.ai`. Auth failures arrive as HTTP 200 with
  `code: 1000/1001` and are decoded as such.
- **OpenCode**: a valid key without a Go subscription returns HTTP 403 with `error.type === "EntitlementError"`,
  reported as `<err:no-subscription>`.

## Layout
```
index.ts             /limit command, argument dispatch, entry renderer registration
types.ts             provider-agnostic report/window model
render.ts            report → TUI lines (the only place that knows about layout)
credentials.ts      pi-owned credential resolution
util.ts              defensive JSON narrowing, quota math, fetch, error mapping
providers/*.ts       one module per plan: parse the vendor payload into a report
```

## Checks

`npm run check` covers this folder: `biome.json` includes `.pi/extensions-src/**/*.ts`
and the root `tsconfig.json` includes `.pi/extensions-src/limit/**/*`, so Biome and tsgo
both see the package.
