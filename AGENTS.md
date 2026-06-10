# Command Service

> **Cross-package rule:** Before making changes in any other package of this monorepo, always read that package's `CLAUDE.md` first.

AI command processing, built on pi-mono (`@mariozechner/pi-ai` + `@mariozechner/pi-agent-core`). One stateful `Agent` per `(socketId × sessionId)`, streaming `AgentEvent`s to Mongo and the WebSocket.
Its also clonned at ~/www/airbase/pi-mono if even need to read the code.

## Layout

```
src/
├── agent/           runtime.ts + system-prompt + convert-to-llm + mongo-store + hooks
├── compaction/      maybeCompact() — wired into Agent.transformContext
├── llm/             service-local LLM model resolver + provider JSON configs
├── skills/          loader.ts + 15 × <name>/SKILL.md
├── tools/           buildTools(ctx) + ats-tools + command-helpers + ui-tools + shared/{ats-client,http-tool} + builtin/read-skill
├── db/models/       command-session.ts (append-only, 90d TTL)
├── ws/              server.ts (AgentEvent protocol) + connections.ts (shared)
├── auth/ services/ lib/ config/ utils/   kept from the old service
└── types/           ui-block.types.ts + custom-messages.ts (CustomAgentMessages decl-merge) + legacy.types.ts (DEPRECATED shim)
```

## Rules

- **Conventions:** `tName` types, `iName` interfaces. Tool names snake_case (`job_create`). Skill names kebab-case (`create-job`).
- **Versions:** pi-mono packages are pinned **exact** to the latest tested version (no caret). Upgrades are manual + smoke-tested.
- **Error handling in tools:** `throw` from `execute`. pi-agent-core surfaces it as `tool_result` with `isError: true`.
- **Never import from deleted dirs:** `src/ai/`, `src/executor/`, `src/processor/` — all gone. Don't recreate them.
- **Never ship filesystem tools:** no `read(path)`, `bash`, `grep`, `ls`, `find`, `write`, `edit`. The only filesystem-adjacent tool is `read_skill(name)`, which does an in-memory lookup.
- **Skill prompts are the product.** They represent months of prompt engineering. Don't rewrite casually — propose changes, get approval. When adding a skill, follow the style of existing ones.
- **Don't add speculative tools.** Only add a tool when an existing skill needs it.
- **Database rules (inherited from root CLAUDE.md):** no writing migrations, no running drizzle, no modifying schemas without prompting the user.

## Adding a skill

1. Create `src/skills/<kebab-name>/SKILL.md` with frontmatter: `name` (matches folder), `description` (≤1024 chars), optional `category`.
2. Write the body as step-by-step instructions. Reference tools inline by their snake_case name (must already exist in `src/tools/`).
3. Restart — skills load at boot, no hot reload.

## Adding a tool

1. **HTTP wrapper (80% case):** add one `httpTool(ats, { name, label, description, parameters, method, path })` entry to `src/tools/ats-tools.ts` or `command-helpers.ts`. TypeBox schema with `Type.Object`, `Type.Optional`, `Type.Union([Type.Literal(...)])` for enums.
2. **Custom logic:** write a plain `AgentTool<typeof schema>` object. Pattern in `src/tools/builtin/read-skill.ts` and `src/tools/ui-tools.ts`.
3. Register by pushing into the array returned by `buildTools(ctx)` in `src/tools/index.ts`.
4. Reference the tool by name inside at least one `SKILL.md` — unreferenced tools are dead weight.
5. **Drift normalization (don't skip).** Pi-ai ships tools to OpenAI with `strict: false`, so the LLM treats schemas as suggestions and frequently omits required nested fields or picks invalid enum values. **Pi-agent-core has a built-in hook for this exact problem: `AgentTool.prepareArguments`** — runs before schema validation, lets you backfill defaults and coerce drift. Reference: `pi-mono/packages/coding-agent/src/core/tools/edit.ts:prepareEditArguments`. Project pattern: `src/tools/ui-tools.ts:prepareCommonUiArgs` / `prepareSimpleListArgs`. Use it whenever you have a drift-prone field.

> **Reviewing tools? Read the WHOLE `AgentTool` interface in `pi-mono/packages/agent/src/types.ts` first.** Hooks: `prepareArguments`, `beforeToolCall`, `afterToolCall`. Don't review only the slice you're touching.

## Adding a UI tool (client-side, no HTTP)

1. Implement in `src/tools/ui-tools.ts`. Build the block, then `await ctx.emitCustomMessage({ role: 'uiBlock', block, toolCallId, timestamp: Date.now() })` and return a short text-only `toolResult`. The block must NOT go in `details`.
2. Add the tool name to `UI_TOOL_NAMES` so `afterToolCall` aborts the agent and lets the frontend wait for the user click.

## Known deviations from pi-mono idioms

Everywhere else we try to match pi-mono's shapes and naming. These are the intentional departures — if you're cross-referencing pi-mono code and something here looks off, check this list first.

- **UI-tool abort trick** (`src/agent/hooks.ts`). `afterToolCall` calls `agent.abort()` after any `UI_TOOL_NAMES` tool. Idiomatic alternative is letting the LLM finish with a "here are the options" reply — we abort to save one LLM round-trip.
- **`iSkill.body` is eager-loaded.** Pi-mono loads skill bodies lazily via the `read` tool. We inline at boot so `read_skill` is a pure in-memory lookup — no filesystem access from any tool.
- **Mongo session schema uses linear `seq`, not pi-mono's UUID tree.** Pi-mono uses parent-child IDs for branching; we don't need branching.
- **Single convenience `maybeCompact()`** in `src/compaction/index.ts` wraps pi-mono's compaction primitives.
- **Custom message emission via our own dispatcher.** We declare exactly one `CustomAgentMessages` subtype (`uiBlock` in `src/types/custom-messages.ts`). Because pi-agent-core's `Agent.processEvents` rejects external invocations, `runtime.ts` owns a local `dispatch(event)` and exposes `emitCustomMessage(msg)` that pushes to `agent.state.messages` then calls `dispatch` for `message_start`/`message_end` directly. Mirrors `pi-mono/packages/coding-agent/src/core/agent-session.ts:sendCustomMessage`.
- **No pi-coding-agent dep.** Pulls in ~15 runtime deps (`pi-tui`, `photon-node`, `marked`, ...) we don't need. We copied the ~400 lines we use with `Derived from pi-mono/...` headers.

## Per-turn system prompt refresh

On every incoming `user_message`, `ws/server.ts:handleUserMessage` rebuilds the system prompt from the latest `origin.pageUrl` / `origin.entityRefs` and mutates `built.agent.state.systemPrompt`. Pi-agent-core's `createContextSnapshot()` reads `_state.systemPrompt` fresh per run, so both `agent.prompt()` and follow-ups queued via `agent.followUp()` see the refreshed value. This is how the LLM learns "the user is on `/jobs/42/refine`" without anyone having to bake it into a static prompt or pollute the user transcript.

Precedent: `pi-mono/packages/mom/src/agent.ts:666-675` does the structurally identical thing for memory / channel / user context before each Slack run. Pi-mono's `agent/README.md` documents `agent.state.systemPrompt = "..."` as the supported API.

**Security:** `pageUrl` and `entityRefs` are client-sent, therefore untrusted. They feed the system prompt only — never tool args, never authz. The LLM may *decide* which resource to operate on based on the hint, but the tool call still goes through `beforeToolCall` and the server-side ats-api which validates every resource access against the user's identity (via `x-internal-key` + `X-Act-As-User-Id` service impersonation).

## WebSocket protocol (authoritative summary)

**Client → server:**
```
{type:"user_message", sessionId, content, origin?}
{type:"load_session", sessionId}
{type:"list_sessions"} / {type:"new_session"} / {type:"close_session"}
{type:"ping"} / {type:"pong"} / {type:"ack"}
```

**Server → client:**
```
{type:"connected", socketId, message}
{type:"session_ready", sessionId, messages, uiBlocks}
{type:"session_list", sessions}
{type:"session_created", sessionId} / {type:"session_closed"}
{type:"agent_event", sessionId, event: AgentEvent}   // main channel
{type:"error", message, sessionId?}
```

`AgentEvent` is pi-agent-core's typed union. Frontend subscribes once and drives all UI state from it.

## Routing discipline

- Idle agent → `user_message` calls `agent.prompt()`.
- Streaming agent → `user_message` calls `agent.followUp()` (queued for after the current run).
- Steering (`agent.steer`) is wired but **not exposed on the UI** in v1.
- Dupes of the same `(socket, session, content)` within 2s are dropped silently by `isDuplicateSend` in `ws/server.ts`.

## Persistence

- `command_sessions` — one header per session.
- `command_session_entries` — append-only log. Types: `message`, `ui_block`, `compaction`. Streaming deltas never persisted.
- 90-day TTL on both collections.
- Failure messages from `handleRunFailure` are captured on `agent_end` via a dedupe Set in `MongoSessionStore`.

## Env vars

Required: `MONGODB_URI`, `REDIS_HOST`, `PRIVATE_ATS_API_URL`, `ATS_FRONTEND_URL`, `ATS_ADMIN_URL`, `AUTH_SECRET`, `ATS_API_KEY`, `LLM_MODEL`, `LLM_KEY`.

`LLM_MODEL` must be a selector in `provider/model-id` format, e.g. `digitalocean/kimi-k2.6` or `openai/gpt-4.1-mini`. Command-service local provider configs live in `src/llm/models/`.

> **Important:** When a new environment variable is added to this package, immediately stop and remind the user to update `infrastructure/` for the relevant service. Do not proceed until the user confirms the infra update.

## Scripts

```
bun run dev         # port 3005, hot reload
bun run start       # production
bun run build       # type-check + copy LLM model JSON into dist
bunx tsc --noEmit   # type check
```
