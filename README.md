# agentside

> ⚠️ Work in progress — freshly extracted from a production codebase, generalization underway.

A self-hosted backend for an AI agent that lives **inside your app** and controls it through your own API. Bring your frontend; agentside gives you the agent loop, streaming protocol, session persistence, and a markdown-based skills system.

Built on [pi-mono](https://github.com/badlogic/pi-mono) (`@mariozechner/pi-ai` + `@mariozechner/pi-agent-core`).

## What's inside

- **WebSocket server** streaming typed `AgentEvent`s — your frontend subscribes once and drives all UI state from the event stream
- **Skills as markdown** — each capability is a `SKILL.md` file the agent loads lazily via a `read_skill` tool; prompt engineering as files, not code
- **Tools as thin HTTP wrappers** over your existing API — your API stays the single authorization authority; the LLM can never escalate
- **Session persistence** in MongoDB (append-only event log, compaction support)
- **UI tools** — the agent can emit rich interactive blocks (confirmations, lists) your frontend renders natively
- **Per-turn context refresh** — the agent always knows what page the user is on

## Status

Extracted as-is from the production system it was built for ([Cuee](https://cuee.ai)). The Cuee-specific tools and skills were removed; one example skill remains as a smoke test. Generalization (pluggable auth, bring-your-own-API tool config) is in progress.

## Quick start

```bash
bun install
cp .env.example .env   # fill in MongoDB, Redis, your API, and an LLM key
bun run dev            # WebSocket server on :3005
```

## License

MIT (pending — see pi-mono attribution headers in `src/`).
