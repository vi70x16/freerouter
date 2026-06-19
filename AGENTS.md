# API-Gateway (freellmapi)

Multi-provider LLM proxy with an Express backend, React dashboard, and SQLite storage. Users add API keys for providers (OpenAI, Google, Anthropic, Cerebras, Cohere, Cloudflare), the server routes requests across keys with automatic failover, rate-limit awareness, and weighted scoring.

## Structure

```
server/          Express 5 API — providers, routing, rate-limiting, auth, SSE events
client/          React 19 + Vite dashboard — key management, analytics, playground
shared/          Shared TypeScript types (ChatMessage, Provider interfaces)
scripts/         CLI entry point (cli.mjs)
docker/          Docker setup docs
docs/specs/      Design specs for features in progress
requirements/    Design docs, task tracking
```

Key server modules: `server/src/providers/` (per-provider adapters extending `BaseProvider`), `server/src/services/router.ts` (request routing + scoring), `server/src/routes/proxy.ts` (the /v1/chat/completions endpoint), `server/src/services/ratelimit.ts`.

## Commands

- `npm run dev` — start both server and client
- `npm run build` — build server then client
- `npm run test` — server vitest + client typecheck
- `npm run test -w server` — server tests only

## Rules

- **Never modify source code directly.** Delegate all code changes via `spawn_agent`.
- **Never commit secrets** — API keys, tokens, encryption keys go through the import script pattern (see `RULES.md §12`).
- Use `npm` (not yarn/pnpm) — this is an npm workspaces monorepo.
- After `spawn_agent` returns code, verify with jcodemunch (blast radius, references) before moving on.

## Delegation

`spawn_agent` is stateless — pass 100% of needed context every call. Include the repo identifier (`api-llm-local`), specific symbol_ids, and the jcodemunch usage mandate. Prefer `get_context_bundle` / `get_ranked_context` over copying source into prompts.

## Further Reference

Read these only when relevant to your current task:

- `RULES.md` — fork management, branching, sync, conflict resolution, testing, credential import
- `docs/specs/` — design specs for in-progress features
- `requirements/` — design docs and task tracking

## jcodemunch

Repo is indexed as `api-llm-local`. Prefer structured retrieval over reading full files:

- `plan_turn` → `search_symbols` → `get_symbol_source` / `get_context_bundle`
- `get_file_outline` before pulling source
- `get_blast_radius` / `find_references` before approving changes
- `register_edit` after edits land

Symbol ID format: `{file_path}::{qualified_name}#{kind}`
