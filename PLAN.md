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
   ┌──────────────┬─────────────┼──────────────┬──────────────┐
   ▼              ▼             ▼              ▼              ▼
Explorer ──▶  Auditor  ──▶   Fixer   ──▶  lint gate  ──▶  Reporter
(tool loop:   (inventory   (tool loop:    (redocly on    (PR title
 listFiles /   vs docs +    readDoc /      spec roots;     + body)
 readFile /    rules.md)    writeDoc /     deterministic,
 report)                    lintSpec)      not the
                                           agent's call)
```

Two tool-loop agents, two single-shot agents, one deterministic gate.

1. **Explorer** decides for itself which files define the API. It lists the code
   directory, opens only what looks relevant, follows a controller's imports to the DTO
   file, and calls `report` with the `Inventory`. There is no extension allowlist and no
   per-framework route table: nothing in docdrift knows that Nest spells routes `@Get` or
   that Rails spells them `config/routes.rb`.
2. **Fixer** edits the docs and validates its own work through a `lintSpec` tool, so it
   sees a Redocly error against the line it just wrote and decides whether to try again.

Both use the tool-loop agent class from `ai`, pinned at **`ai@5.0.221`**, where it is
exported as `Experimental_Agent`. In `ai@6`+ the same class is named **`ToolLoopAgent`**
and is no longer experimental; `Experimental_Agent` survives there only as an alias, as
does `stepCountIs` for the renamed `isStepCount`. `system` also becomes `instructions`.

### Structured output from a tool loop

The Explorer returns its `Inventory` through a `report` tool whose `inputSchema` is the
Zod schema, and `hasToolCall('report')` ends the loop.

`experimental_output` was the obvious first choice and **on `ai@5` it does not work**: it
pins a JSON response format, and with the response format pinned the model cannot call
tools at all — it answered from the prompt alone, having read nothing, and returned an
empty inventory. The `report` tool gets identical Zod validation while leaving tool
calling intact.

This is a version limitation, not a permanent one. On `ai@7.0.40` the equivalent option
(`output: Output.object({ schema })`) *does* coexist with tools — verified: the agent
called its tools across three steps and still returned a validated object. On an upgrade
the `report` tool and its `hasToolCall` stop condition should be deleted in favour of
`output`, which is what makes the Explorer genuinely one stage rather than one stage with
a hand-rolled exit.

### Retries are a ceiling, not a count

There is no `MAX_REPAIRS`. `stopWhen` takes an array and any condition ends the loop:

```ts
stopWhen: [hasToolCall('report'), stepCountIs(EXPLORE_STEPS), () => totalUsd() >= maxUsd]
```

So how many times the Fixer re-lints and re-edits is the model's judgement, bounded by a
step ceiling and by `--max-usd`. The model decides *whether* to continue; the harness
decides *how far it can go*. `StopCondition` is `(opts) => boolean`, so the cost guard is
one line over the existing ledger.

### What stays deterministic

Giving the agent more freedom does not mean giving it the guarantees. After the Fixer
loop, `cli.ts` lints the spec roots again itself and reverts rather than open a pull
request containing a broken specification. The agent was asked to lint its own work and
may have skipped it, run out of steps, or given up — whether a PR exists is not its call.

One model for all agents (`anthropic/claude-sonnet-5`), overridable with `--model`.
Splitting tiers per agent — cheap for the mechanical Explorer, stronger for the Auditor
and Fixer — is a one-line change per agent, or a `prepareStep` that swaps model per step,
but not worth the config surface until a run shows a quality or cost problem.

## Split and nested specifications

A specification of any size ends up spread across files, and this is a trap worth naming.
A partial is **not** a document: it has no `openapi:` key, and `redocly lint partial.yaml`
exits non-zero with `Unsupported specification`. That is a usage error, not a
documentation error — hand it to the Fixer as though it were invalid OpenAPI and the agent
burns its budget rewriting perfectly good YAML, after which correct work gets reverted.

Therefore docdrift lints **roots only**, identified by `isSpecRoot()`
(`/^(openapi|swagger|asyncapi):/m`). Redocly resolves `$ref`, so linting the root
validates the whole tree *and* reports each problem against the partial's own path and
line numbers — which is exactly what the Fixer needs to fix it. Partials are still read by
the Auditor, still edited by the Fixer, and still validated; they are simply never linted
directly.

`example/docs/` is split this way on purpose, so a run exercises it.

## Phases

| # | Phase | Deliverable | Notes |
|---|-------|-------------|-------|
| 0 | Scaffold | `package.json`, `tsconfig.json`, `.env.example`, `.gitignore` | tsx for dev, no bundler |
| 1 | Example project | `example/` — Nest API, 5 endpoints, 2 markdown docs, split `openapi.yaml` | Docs deliberately drifted from code, spec deliberately split across files |
| 2 | LLM layer | `src/llm.ts` | Gateway client + usage/cost accumulator. Cost comes from `providerMetadata.gateway.cost` — no hardcoded price table to rot |
| 3 | Agents | `src/agents.ts` | 2 tool loops + 2 single-shot agents, each a typed function with a Zod schema |
| 4 | Orchestrator | `src/cli.ts` | `parseArgs` from `node:util`, progress lines, cost table, exit code, lint gate |
| 5 | Git / PR | `src/repo.ts` | branch → commit → push → `gh pr create`, every operation scoped to the docs directory |
| 6 | Rules | `rules.md` | Loaded at runtime, appended to Auditor + Fixer prompts |
| 7 | Press release | `press-release.html` | Working Backwards, styled after redocly.com docs pages |
| 8 | Ship | commit + push to GitHub | |

## Constraints held throughout

- **Minimum code.** Every line must be explainable in a demo. The tool loops earned their
  keep by deleting the triage agent, the inventory merge, and the outer repair loop.
- **No `any`.** Zod schemas are the single source of truth for agent I/O types, including
  the `report` tool's input.
- **No speculative abstraction.** No plugin system, no agent base class, no DI container.
  A `bounds()` helper for the two `stopWhen` arrays was written and then deleted — the
  array literal types itself correctly by context, and two call sites are not a pattern.
- **Deterministic where possible.** Linting, git, path confinement, and cost maths are
  plain code. LLMs are used for judgement, never for guarantees.
- **Nothing outside the docs directory is ours.** `confine()` rejects a tool path that
  escapes, and `git status`/`diff`/`checkout`/`add` are all scoped, so unrelated working
  tree changes are never described in a PR, committed, or destroyed.

## Known limits (deliberate, documented in README)

- The tool loop costs more than one big prompt: more round trips, context growing every
  step, and a price you cannot predict before the run. Flexibility bought with
  reproducibility.
- `listFiles` returns the whole tree in one tool result. Bounded, but on a very large repo
  the answer is still `--code`.
- Docs go to the Auditor whole, sharded only if they exceed the budget. The Auditor has to
  see every doc file to know what is missing, so it cannot explore the way the Explorer does.
- Markdown is never linted. Only OpenAPI/AsyncAPI roots pass through Redocly.
- Agents run sequentially, and so do doc shards.
- The Fixer edits docs only. It never touches source code — the code is the truth.
