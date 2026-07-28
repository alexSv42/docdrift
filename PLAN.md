# docdrift — Implementation Plan

AI-powered documentation drift detection & correction.
CLI tool. TypeScript. Vercel AI SDK via Vercel AI Gateway.

## Why CLI (not API)

Drift detection is a **repo-scoped batch job**, not a request/response service. It runs
where the code lives: a dev's terminal or a CI step (`docdrift --code ./src --docs ./docs`).
An HTTP API would need auth, a job queue, and repo checkout just to reach the same
starting point a CLI already has for free. CLI also gives us stdout progress and a
non-zero exit code for CI, both for nothing.

## Architecture

```
                     orchestrator (src/cli.ts)
                             │
   ┌────────────┬────────────┼─────────────┬────────────┐
   ▼            ▼            ▼             ▼            ▼
Scanner ──▶ Auditor ──▶   Fixer   ──▶  Validator ──▶ Reporter
(source)   (source vs   (tool loop:    (redocly      (PR title
           docs +        read/write     lint;         + body)
           rules.md)     doc files)     feeds errors
                                        back to Fixer)
```

Five responsibilities, four LLM agents + one deterministic validator.
The pipeline is a real loop, not one `generateText()`:

1. **Fixer** is a tool-calling loop (`readDoc` / `writeDoc`, bounded by `stepCountIs`).
   It decides which files to touch and iterates until done.
2. **Validator → Fixer** is a repair loop. If `redocly lint` rejects the spec the agent
   just edited, the errors go back to the Fixer. Bounded retries, then give up and report.

Cheap models where the task is mechanical (Scanner), stronger where judgement is
needed (Auditor, Fixer). Configurable per agent.

## Phases

| # | Phase | Deliverable | Notes |
|---|-------|-------------|-------|
| 0 | Scaffold | `package.json`, `tsconfig.json`, `.env.example`, `.gitignore` | tsx for dev, no bundler |
| 1 | Example project | `example/` — Nest API, 5 endpoints, 2 markdown docs, `openapi.yaml` | Docs deliberately drifted from code, so there is something to find |
| 2 | LLM layer | `src/llm.ts` | Gateway client + usage/cost accumulator. Cost comes from `providerMetadata.gateway.cost` — no hardcoded price table to rot |
| 3 | Agents | `src/agents.ts` | 4 agents, each a typed function with a Zod output schema |
| 4 | Orchestrator | `src/cli.ts` | `parseArgs` from `node:util`, progress lines, cost table, exit code |
| 5 | Git / PR | `src/git.ts` | branch → commit → push → `gh pr create` |
| 6 | Rules | `rules.md` | Loaded at runtime, appended to Auditor + Fixer prompts |
| 7 | Press release | `press-release.html` | Working Backwards, styled after redocly.com docs pages |
| 8 | Ship | commit + push to GitHub | |

## Constraints held throughout

- **Minimum code.** Target ~300 lines of `src/`. Every line must be explainable in a demo.
- **No `any`.** Zod schemas are the single source of truth for agent I/O types.
- **No speculative abstraction.** No plugin system, no agent base class, no DI container.
  Four agents are four functions.
- **Deterministic where possible.** Linting, git, and cost maths are plain code. LLMs are
  used only for judgement.

## Known limits (deliberate, documented in README)

- Whole files go into the prompt. Fine for a small repo, needs chunking or a retrieval
  step beyond ~100 source files.
- Agents run sequentially. Scanner could shard across files in parallel if runtime hurts.
- The Fixer edits docs only. It never touches source code — the code is the truth.
