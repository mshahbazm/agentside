# agentside

**A self-hosted backend for an AI agent that lives inside your app and operates it through your own API.**

Your users type "create a job posting for a senior React dev and invite Sarah to review applicants" into a chat panel — the agent calls *your* API endpoints, asks for confirmation through *your* UI components, and navigates the user to the result. agentside is the backend that makes that work: the agent loop, the streaming protocol, session persistence, and a markdown-based skills system. You bring the frontend and the API.

Built on [pi-mono](https://github.com/badlogic/pi-mono)'s `@mariozechner/pi-ai` + `@mariozechner/pi-agent-core` — a small, readable agent core — rather than a heavyweight framework.

> ⚠️ **Status: extraction in progress.** This code runs in production inside [Cuee](https://cuee.ai) (an ATS), and was just extracted from that codebase. It works, but tool catalogs, env var names, and the system prompt still reference the original app. See [Adapting it to your app](#adapting-it-to-your-app) for exactly what to swap. Generalization (pluggable auth, bring-your-own-API config) is the current focus.

---

## Why this exists

Most "add AI to your app" tooling is either a frontend widget that calls a model directly, or a framework that wants to own your whole stack. agentside takes a narrower position:

- **Backend-only.** A single Bun service (~5k lines you can read in an afternoon). Your frontend subscribes to one WebSocket and renders events however you like.
- **Your API is the security boundary.** The agent never touches your database. Every tool is a thin HTTP wrapper over your existing API, called with a service key plus an act-as-user header — so your API enforces the same authorization it always has. The LLM cannot escalate privileges, because it was never granted any.
- **Prompt engineering as files, not code.** Capabilities are markdown `SKILL.md` files the agent loads on demand. Iterating on agent behavior means editing markdown, not redeploying logic.

## How it works

```
┌────────────┐  WebSocket: user_message / agent_event   ┌─────────────────────┐
│  Your      │ ◄──────────────────────────────────────► │      agentside      │
│  frontend  │      (JWT cookie auth at upgrade)        │                     │
└────────────┘                                          │  ┌───────────────┐  │
                                                        │  │ pi-agent-core │  │
       one stateful Agent per (socket × session) ─────► │  │     Agent     │  │
                                                        │  └──────┬────────┘  │
┌────────────┐   HTTP: service key + act-as-user        │         │ tools    │
│  Your API  │ ◄────────────────────────────────────────┼─────────┘          │
│  (authz    │                                          │   MongoDB: session │
│   lives    │                                          │   event log        │
│   here)    │                                          │   Redis: rate      │
└────────────┘                                          │   limits           │
                                                        └─────────────────────┘
```

**Life of a message:**

1. Your frontend opens a WebSocket. The JWT in the auth cookie is verified at upgrade (`AUTH_SECRET`); the payload's user id + tenant id are bound to the socket — the client can never claim a different identity afterwards.
2. The client sends `{type: "user_message", sessionId, content, origin}`. `origin` carries the current page URL and visible entity ids.
3. The server rebuilds the system prompt with that fresh page context (so the agent knows "the user is looking at job #42") and either starts a run (`agent.prompt()`) or queues a follow-up if the agent is mid-run (`agent.followUp()`).
4. The agent reasons, lazily loads relevant skills via the `read_skill` tool, and calls tools. HTTP tools hit your API; UI tools emit interactive blocks (choices, confirmations) for your frontend to render.
5. Every `AgentEvent` (message deltas, tool starts/results, turn boundaries) streams to the client as `{type: "agent_event", ...}` and is persisted to MongoDB — streaming deltas excluded, so the stored log stays compact.
6. When the conversation outgrows the context window, it's compacted into a summary transparently (`transformContext` hook), using the same `<summary>` convention as pi-mono.

### Skills: lazy-loaded markdown procedures

A skill is a folder with a `SKILL.md`:

```markdown
---
name: create-job
description: User wants to create a job posting. Collect title, department, location...
---

# Create Job

1. Call `read_skill` first if you haven't...
2. Gather required fields. Infer from page context before asking.
3. Call `command_job_prepare` with ...
4. On success, call `navigate_to` with the new job's id.
```

The system prompt contains only an XML catalog of skill names + descriptions. When a user message matches one, the agent calls `read_skill(name)` and gets the full body — an in-memory lookup, never filesystem access. This keeps the system prompt small and lets you ship dozens of skills without paying for them on every request. One `example` skill ships in this repo as a smoke test.

### Tools: two kinds

- **HTTP tools** (`src/tools/ats-tools.ts`, `command-helpers.ts`) — declarative wrappers over API endpoints: name, description, TypeBox schema, method, path. ~10 lines each. Rate-limited per user+tenant via Redis (soft limit delays, hard limit blocks), wrapped in a circuit breaker, with API errors flattened into LLM-readable strings.
- **UI tools** (`src/tools/ui-tools.ts`) — no HTTP at all. They emit a typed *UI block* into the transcript as a custom message (`present_choices`, `confirm_action`, `show_simple_list`, `navigate_to`, ...). Your frontend renders the block natively; the user's click comes back as the next user message. `confirm_action` carries a `deferredAction` so approval executes the queued action without another LLM round-trip.

Tool drift is handled, not hoped away: providers ship schemas with `strict: false`, so models occasionally omit nested required fields or invent enum values. `AgentTool.prepareArguments` runs before validation to backfill and coerce (see `prepareCommonUiArgs`).

### Sessions

MongoDB, two collections: a header per session and an append-only event log (90-day TTL). Reconnect/reload replays the log — including UI blocks, which live in the transcript as `role: 'uiBlock'` messages — so the frontend restores the full conversation, interactive blocks included, from one `session_ready` payload.

## WebSocket protocol

Client → server:

| Message | Purpose |
|---|---|
| `{type:"ack"}` | Mark connection ready after `connected` |
| `{type:"user_message", sessionId, content, origin?}` | Send a message (origin = page URL, entity refs) |
| `{type:"abort", sessionId}` | Stop the current run |
| `{type:"dequeue_followups", sessionId}` | Clear queued follow-up messages |
| `{type:"new_session"}` / `{type:"load_session", sessionId}` / `{type:"list_sessions"}` / `{type:"close_session"}` | Session lifecycle |
| `{type:"ping"}` / `{type:"pong"}` | Keep-alive |

Server → client:

| Message | Purpose |
|---|---|
| `{type:"connected", socketId}` | Sent after upgrade + auth |
| `{type:"session_ready", sessionId, messages}` | Full replay after load/create |
| `{type:"agent_event", sessionId, event}` | Every pi-agent-core `AgentEvent` — the main channel |
| `{type:"queue_update", sessionId, followUps}` | Pending follow-up texts changed |
| `{type:"session_list" \| "session_created" \| "session_closed", ...}` | Lifecycle responses |
| `{type:"error", message, sessionId?}` | Protocol or runtime error |

Your frontend subscribes once and derives all UI state from the `agent_event` stream (pi-agent-core's typed event union: `agent_start`, `message_update`, `tool_execution_start`, ...).

## Security model

- **Client input is untrusted, always.** `origin` (page URL, entity refs) feeds the system prompt as *hints* — never tool arguments, never authorization. Only whitelisted fields are read from it.
- **Identity comes from the JWT at upgrade**, not from anything the client sends later.
- **Authorization happens in your API**, per request, exactly as it does for your normal frontend traffic. The agent's service key + `X-Act-As-User-Id` header means your API evaluates every call as that user.
- **No filesystem tools.** The agent cannot read paths, run shell commands, or write files. The only filesystem-adjacent tool is `read_skill`, an in-memory lookup of skills registered at boot.

## Quick start

Prereqs: [Bun](https://bun.sh), MongoDB, Redis.

```bash
bun install
cp .env.example .env   # set MONGODB_URI, REDIS_*, AUTH_SECRET, your API URL/key, LLM_MODEL + LLM_KEY
bun run dev            # http://localhost:3005, health check at /
```

`LLM_MODEL` is a pi-ai selector — `provider/model-id`, e.g. `anthropic/claude-sonnet-4-6` or `openai/gpt-4.1-mini`. Built-in pi-ai providers work out of the box; custom OpenAI-compatible providers get a JSON config in `src/llm/models/` (see `digitalocean.json` for the shape).

## Adapting it to your app

Honest list of what is still Cuee-specific today, in the order you'd replace it:

1. **Env vars** — `PRIVATE_ATS_API_URL`, `ATS_API_KEY`, `ATS_FRONTEND_URL`, `ATS_ADMIN_URL` are "your API base URL", "your service key", and "allowed CORS origins". Rename pending; semantics already generic.
2. **System prompt** (`src/agent/system-prompt.ts`) — the base prompt names the original product and its domain. Rewrite ~30 lines for yours.
3. **Tool catalogs** (`src/tools/ats-tools.ts`, `command-helpers.ts`) — replace with wrappers for your endpoints; each is a small declarative entry. `src/tools/shared/http-tool.ts` and `ats-client.ts` are the reusable machinery.
4. **Skills** (`src/skills/`) — write your own; the shipped `example` skill documents the format.
5. **Route manifest** (`src/lib/route-manifest.ts`) — the page-id → URL-pattern table behind `navigate_to`. Replace with your frontend's routes.
6. **JWT payload shape** (`src/types/auth.types.ts`) — adjust to your token's claims; only `sub` and the tenant id matter.

What you should *not* need to touch: the agent runtime, WS server, Mongo store, compaction, rate limiter, circuit breaker, model resolver, skill loader.

## Project layout

```
src/
├── agent/        runtime (Agent construction) · system prompt · mongo store · hooks · event logger
├── ws/           WebSocket server (protocol above) · connection registry + heartbeat
├── skills/       loader + SKILL.md folders
├── tools/        buildTools(ctx) · HTTP tool catalogs · UI tools · shared HTTP client
├── compaction/   context compaction wired into Agent.transformContext
├── llm/          model resolver + custom provider configs
├── services/     rate limiter (Redis) · circuit breaker · analytics
├── db/           Mongo connection + session models
├── auth/         JWT verification (cookie + bearer)
└── types/        UI block contract · custom message declarations
```

## Roadmap

- [ ] Generic env naming (`APP_API_URL`, `APP_SERVICE_KEY`, ...)
- [ ] Pluggable auth (`verifyToken` callback instead of baked-in JWT shape)
- [ ] Tool catalog as config / OpenAPI generator
- [ ] Runnable demo app (tiny CRUD API + minimal chat frontend)
- [ ] npm package + docs site

## Credits & license

MIT. Standing on the shoulders of [Mario Zechner](https://github.com/badlogic)'s pi-mono — `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` do the heavy lifting of the agent loop; agentside adds the app-integration layer (protocol, persistence, skills, tools, security model). Files derived from pi-mono code carry `Derived from pi-mono/...` headers.
