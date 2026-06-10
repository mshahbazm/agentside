# agentside

Self-hosted backend for an in-app AI agent, built on pi-mono (`@mariozechner/pi-ai` + `@mariozechner/pi-agent-core`, https://github.com/badlogic/pi-mono). One stateful `Agent` per `(socketId × sessionId)`, streaming `AgentEvent`s to MongoDB and the WebSocket.

## Layout

```
src/
├── agent/           runtime.ts + system-prompt + convert-to-llm + mongo-store + hooks
├── compaction/      maybeCompact() — wired into Agent.transformContext
├── llm/             service-local LLM model resolver + provider JSON configs
├── skills/          loader.ts + <name>/SKILL.md folders (EXTENSION POINT)
├── tools/           buildTools(ctx) + app-tools (EXTENSION POINT) + ui-tools + shared/{api-client,http-tool} + builtin/read-skill
├── lib/             route-manifest.ts (EXTENSION POINT — navigate_to page table)
├── db/models/       agent-session.ts (append-only, 90d TTL)
├── ws/              server.ts (AgentEvent protocol) + connections.ts
├── auth/ services/ config/ utils/
└── types/           ui-block.types.ts + custom-messages.ts (CustomAgentMessages decl-merge) + auth.types.ts
```

## Rules

- **Conventions:** `tName` types, `iName` interfaces. Tool names snake_case (`invoice_create`). Skill names kebab-case (`create-invoice`).
- **Versions:** pi-mono packages are pinned **exact** to the latest tested version (no caret). Upgrades are manual + smoke-tested.
- **Error handling in tools:** `throw` from `execute`. pi-agent-core surfaces it as `tool_result` with `isError: true`.
- **Never ship filesystem tools:** no `read(path)`, `bash`, `grep`, `ls`, `find`, `write`, `edit`. The only filesystem-adjacent tool is `read_skill(name)`, which does an in-memory lookup.
- **Skill prompts are the product.** Iterate deliberately; when adding a skill, follow the style of existing ones.
- **Don't add speculative tools.** Only add a tool when a skill needs it.
- **Security:** client-sent `origin` (pageUrl, entityRefs) feeds the system prompt only — never tool args, never authz. Identity comes from the JWT verified at WS upgrade; the host app's API authorizes every tool call (`x-internal-key` + `X-Act-As-User-Id`).

## Adding a skill

1. Create `src/skills/<kebab-name>/SKILL.md` with frontmatter: `name` (matches folder), `description` (≤1024 chars), optional `category`.
2. Write the body as step-by-step instructions. Reference tools inline by their snake_case name (must already exist in `src/tools/`).
3. Restart — skills load at boot, no hot reload.

## Adding a tool

1. **HTTP wrapper (80% case):** add one `httpTool(api, { name, label, description, parameters, method, path })` entry in `src/tools/app-tools.ts`. TypeBox schema with `Type.Object`, `Type.Optional`, `Type.Union([Type.Literal(...)])` for enums.
2. **Custom logic:** write a plain `AgentTool<typeof schema>` object. Pattern in `src/tools/builtin/read-skill.ts` and `src/tools/ui-tools.ts`.
3. Register by pushing into the array returned by `buildAppTools(api)`.
4. Reference the tool by name inside at least one `SKILL.md` — unreferenced tools are dead weight.
5. **Drift normalization (don't skip).** Pi-ai ships tools to OpenAI with `strict: false`, so the LLM treats schemas as suggestions and frequently omits required nested fields or picks invalid enum values. **Pi-agent-core has a built-in hook for this exact problem: `AgentTool.prepareArguments`** — runs before schema validation, lets you backfill defaults and coerce drift. Project pattern: `src/tools/ui-tools.ts:prepareCommonUiArgs`. Use it whenever you have a drift-prone field.

> **Reviewing tools? Read the WHOLE `AgentTool` interface in pi-mono's `packages/agent/src/types.ts` first.** Hooks: `prepareArguments`, `beforeToolCall`, `afterToolCall`. Don't review only the slice you're touching.

## Adding a UI tool (client-side, no HTTP)

1. Implement in `src/tools/ui-tools.ts`. Build the block, then `await ctx.emitCustomMessage({ role: 'uiBlock', block, toolCallId, timestamp: Date.now() })` and return a short text-only `toolResult`. The block must NOT go in `details`.
2. If the tool should end the turn and wait for a user click, add its name to `UI_TOOL_NAMES`.

## Known deviations from pi-mono idioms

Everywhere else we try to match pi-mono's shapes and naming. These are the intentional departures — if you're cross-referencing pi-mono code and something here looks off, check this list first.

- **`iSkill.body` is eager-loaded.** Pi-mono loads skill bodies lazily via the `read` tool. We inline at boot so `read_skill` is a pure in-memory lookup — no filesystem access from any tool.
- **Mongo session schema uses linear `seq`, not pi-mono's UUID tree.** Pi-mono uses parent-child IDs for branching; we don't need branching.
- **Single convenience `maybeCompact()`** in `src/compaction/index.ts` wraps pi-mono's compaction primitives.
- **Custom message emission via our own dispatcher.** We declare `CustomAgentMessages` subtypes (`uiBlock`, `refreshResource` in `src/types/custom-messages.ts`). Because pi-agent-core's `Agent.processEvents` rejects external invocations, `runtime.ts` owns a local `dispatch(event)` and exposes `emitCustomMessage(msg)` that pushes to `agent.state.messages` then calls `dispatch` for `message_start`/`message_end` directly. Mirrors pi-mono's `coding-agent/src/core/agent-session.ts:sendCustomMessage`.
- **No pi-coding-agent dep.** Pulls in ~15 runtime deps (`pi-tui`, `photon-node`, `marked`, ...) we don't need. We copied the ~400 lines we use with `Derived from pi-mono/...` headers.

## Per-turn system prompt refresh

On every incoming `user_message`, `ws/server.ts:handleUserMessage` rebuilds the system prompt from the latest `origin.pageUrl` / `origin.entityRefs` and mutates `built.agent.state.systemPrompt`. Pi-agent-core's `createContextSnapshot()` reads `_state.systemPrompt` fresh per run, so both `agent.prompt()` and follow-ups queued via `agent.followUp()` see the refreshed value. This is how the LLM learns "the user is on `/items/42/edit`" without baking it into a static prompt or polluting the user transcript.

Precedent: pi-mono's `packages/mom/src/agent.ts` does the structurally identical thing for memory / channel / user context before each Slack run. Pi-mono's `agent/README.md` documents `agent.state.systemPrompt = "..."` as the supported API.

**Security:** `pageUrl` and `entityRefs` are client-sent, therefore untrusted. They feed the system prompt only — never tool args, never authz. The LLM may *decide* which resource to operate on based on the hint, but the tool call still goes through the host app's API, which validates every resource access against the acting user's identity.

## WebSocket protocol (authoritative summary)

**Client → server:**
```
{type:"user_message", sessionId, content, origin?}
{type:"abort", sessionId} / {type:"dequeue_followups", sessionId}
{type:"load_session", sessionId}
{type:"list_sessions"} / {type:"new_session"} / {type:"close_session"}
{type:"ping"} / {type:"pong"} / {type:"ack"}
```

**Server → client:**
```
{type:"connected", socketId, message}
{type:"session_ready", sessionId, messages}
{type:"session_list", sessions}
{type:"session_created", sessionId} / {type:"session_closed"}
{type:"agent_event", sessionId, event: AgentEvent}   // main channel
{type:"queue_update", sessionId, followUps}
{type:"error", message, sessionId?}
```

`AgentEvent` is pi-agent-core's typed union. Frontend subscribes once and drives all UI state from it.

## Routing discipline

- Idle agent → `user_message` calls `agent.prompt()`.
- Streaming agent → `user_message` calls `agent.followUp()` (queued for after the current run).
- Dupes of the same `(socket, session, content)` within 2s are dropped silently by `isDuplicateSend` in `ws/server.ts`.

## Persistence

- `agent_sessions` — one header per session.
- `agent_session_entries` — append-only log. Types: `message`, `ui_block`, `compaction`. Streaming deltas never persisted.
- 90-day TTL on both collections.
- Failure messages from `handleRunFailure` are captured on `agent_end` via a dedupe Set in `MongoSessionStore`.

## Env vars

Required: `MONGODB_URI`, `APP_API_URL`, `APP_API_KEY`, `CORS_ORIGINS`, `AUTH_SECRET`, `LLM_MODEL`, `LLM_KEY`.

Optional: `PORT` (3005), `APP_NAME`, `REDIS_*`, `RATE_LIMIT_*`, `API_REQUEST_TIMEOUT_MS`, `API_MAX_RETRIES`, `VERBOSE_AGENT_LOG`.

`LLM_MODEL` must be a selector in `provider/model-id` format, e.g. `anthropic/claude-sonnet-4-6` or `openai/gpt-4.1-mini`. Custom OpenAI-compatible providers get a JSON config in `src/llm/models/`.

> When adding a new environment variable, document it in `.env.example` and the README env section in the same change.

## Scripts

```
bun run dev         # port 3005, hot reload
bun run start       # production
bun run build       # type-check + copy LLM model JSON into dist
bun run typecheck   # type check only
```
