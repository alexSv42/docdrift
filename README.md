# docdrift

Finds where your documentation has drifted from your API source code, fixes it, and opens a pull
request. Multi-agent, TypeScript, Vercel AI SDK.

```bash
npm install
cp .env.example .env      # add an AI Gateway key from vercel.com/~/ai-gateway/api-keys
npm run docdrift -- --dry-run
```

## Usage

```
docdrift [options]

  --code   <dir>   source directory to read the true API from   (default example/src)
  --docs   <dir>   documentation directory to correct           (default example/docs)
  --rules  <file>  extra compliance rules for the agents        (default rules.md)
  --model  <id>    AI Gateway model id                          (default anthropic/claude-sonnet-5)
  --dry-run        print the proposed pull request, change nothing
```

Exit codes: `0` docs are clean · `1` drift was found · `2` the run failed.
Non-zero-on-drift makes it behave like any other linter in CI.

### A real run

Against the deliberately drifted `example/`, 19 findings in 66 seconds for 12 cents:

```
[0.0s]  Scanner: reading 4 source files…
[5.5s]  Scanner: found 5 endpoints, 5 models
[5.5s]  Auditor: comparing against 3 doc files…
  high   api-reference.md: Base URL and all endpoint paths use /v1/projects, but the true API uses /v2/projects.
  high   api-reference.md: Authentication example uses 'X-Api-Key' instead of the required Bearer token scheme.
  high   api-reference.md: Create project table omits required field 'ownerEmail'.
  medium api-reference.md: List projects query param documented as 'perPage', but the true API uses 'limit'.
  …14 more…
[26.0s]  Fixer: rewriting docs…
[53.5s]  Validator: redocly lint example/docs/openapi.yaml
[54.9s]  Fixer: updated 3 files
[54.9s]  Reporter: writing the pull request…

Token usage and cost
  scanner    1 calls     2795 in     598 out  $0.0116
  auditor    1 calls     3672 in    2320 out  $0.0305
  fixer      3 calls    16081 in    3015 out  $0.0623
  reporter   1 calls     5960 in     841 out  $0.0203
  TOTAL                                      $0.1248
  runtime 66.0s
```

It found all six planted drifts, plus four `rules.md` violations the code alone could not
reveal (endpoints with no runnable curl example). Note `fixer 3 calls` — that is the tool loop
billing per step, which is exactly what `src/cost.test.ts` guards.

### A note on AI Gateway's free tier

The free tier covers a subset of models and rate-limits them separately per model. The two
failure modes look similar but are not: HTTP 403 `no_providers_available` means the model is
**not** in the free subset, while HTTP 429 `rate_limit_exceeded` means it is, but you are
throttled right now. `--model` exists partly so you can move to a model with spare quota.

## Why a CLI

Drift detection is a repo-scoped batch job, not a request/response service. It belongs where the
code already is: a developer's terminal or a CI step. An HTTP API would need auth, a job queue and
repository checkout just to reach the starting point a CLI gets for free — and the output (a pull
request) is asynchronous anyway, so there is nothing useful to return in a response body.

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

| Agent | Responsibility | Output |
| --- | --- | --- |
| **Scanner** | Extract the API as the code actually implements it | `Inventory` — endpoints, params, models, auth |
| **Auditor** | Diff that inventory against the docs, plus the user's rules | `Finding[]` — file, kind, severity, problem, correction |
| **Fixer** | Rewrite the affected doc files | paths written |
| **Validator** | `redocly lint` any specification the Fixer touched | ok / errors — *deterministic, no LLM* |
| **Reporter** | Turn the run into a readable pull request | title + markdown body |

### The two loops

The brief rules out a single `generateText()` call, and for good reason — neither of these steps
can be done in one shot:

1. **The Fixer is a tool-calling loop.** It gets `readDoc` and `writeDoc` and decides for itself
   which files to open and in what order, bounded by `stepCountIs(2 × findings + 4)`.
2. **Validator → Fixer is a repair loop.** If Redocly CLI rejects the specification the agent just
   edited, the lint errors are fed back into the Fixer as new input. Two retries, then docdrift
   reverts the working tree rather than open a pull request containing a broken spec.

### Design decisions

- **Code is the source of truth.** The Fixer can only write inside the docs directory. It never
  edits source. If the code is wrong, that is a human's problem.
- **Cost comes from the provider, not from us.** AI Gateway returns the dollar cost of every call
  in `providerMetadata.gateway.cost`. A hardcoded price table would silently rot; this cannot.
  A tool loop bills per step, so `src/llm.ts` sums over `result.steps` rather than trusting the
  result's own (last-step-only) metadata — that is what `src/cost.test.ts` pins down.
- **Zod schemas are the only type definitions.** `Inventory`, `Finding` and `Report` are inferred
  from the schemas the model is constrained to, so the runtime contract and the compile-time type
  cannot disagree.
- **Whole files go in the prompt.** No chunking, no embeddings, no retrieval. Correct and simple
  for a service-sized repo; see *Limits*.
- **Four agents are four functions.** No base class, no registry, no plugin system.

`src/` is about 300 lines in four files: `cli.ts` (orchestrator), `agents.ts` (the four agents and
their schemas), `llm.ts` (model + cost ledger), `repo.ts` (git, `gh`, `redocly` — every subprocess).

## The example project

`example/` is a Nest API with five endpoints and documentation that has been deliberately left
behind, so a run has something real to find:

| # | Drift | Where |
| --- | --- | --- |
| 1 | Routes moved `/v1/projects` → `/v2/projects` | both markdown files, `openapi.yaml` |
| 2 | Query parameter `perPage` renamed to `limit` | `openapi.yaml`, both markdown files |
| 3 | Project field `isArchived` renamed to `archived` | `openapi.yaml`, `api-reference.md` |
| 4 | `ownerEmail` became required on create | `openapi.yaml`, `api-reference.md` |
| 5 | `DELETE /v2/projects/{id}` is undocumented | `openapi.yaml`, `api-reference.md` |
| 6 | Auth moved from `X-Api-Key` to `Authorization: Bearer` | `getting-started.md`, `openapi.yaml` |

A mix of renames, omissions and stale examples — the three kinds of drift that actually happen.

## Custom rules

`rules.md` is read at runtime and appended to the Auditor's and Fixer's system prompts. It is for
house style the code cannot tell you about: "every endpoint needs a curl example", "never show a
literal token". Absent file, no rules — the pipeline still runs.

## Limits

Deliberate, and worth knowing before you point this at a monorepo:

- **Context, not retrieval.** Every source and doc file is sent whole. Past roughly 100 source
  files this stops fitting; the fix is to shard the Scanner per file and merge inventories, which
  also parallelises the slowest step.
- **Sequential agents.** Runtime is the sum of five stages, ~30s on `example/`. The Scanner is the
  obvious thing to fan out first.
- **Whole-file rewrites.** The Fixer returns complete file contents rather than a patch. Simple and
  robust at this size; on a 2,000-line reference page it would be wasteful and a diff-based tool
  would be better.
- **Markdown is not validated.** Only OpenAPI/AsyncAPI documents pass through Redocly CLI. Broken
  markdown links introduced by the Fixer would not be caught.
- **The Auditor is the accuracy ceiling.** A false positive becomes a wrong edit in a pull request.
  That is why a human reviews it, and why the Reporter is instructed to flag anything uncertain.

## Development

```bash
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest run
```

Nine unit tests over the two pieces of non-obvious deterministic logic. No mocked LLM calls —
the agents are prompts, and asserting on a stubbed model response would only test the stub.

- `src/llm.test.ts` — the cost ledger. The one that matters is *bills a tool loop per step*: a
  multi-step result reports only the last step's cost in its own `providerMetadata`, so billing
  the result once would silently undercount the Fixer. The ledger is module state by design, so
  each test re-imports the module via `vi.resetModules()` rather than have production code export
  a reset that only tests would call.
- `src/agents.test.ts` — `readFiles`: recursion, relative paths, multiple extensions, no match.
