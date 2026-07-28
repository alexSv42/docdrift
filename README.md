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
  --max-usd <n>    hard spend ceiling for the run               (default 1.00)
  --dry-run        print the proposed pull request, change nothing
```

`--max-usd` is not advisory. It is a `stopWhen` condition on both tool loops, so an agent that
would otherwise keep re-linting and re-editing stops there.

Exit codes: `0` docs are clean · `1` drift was found · `2` the run failed.
Non-zero-on-drift makes it behave like any other linter in CI.

### A real run

Against the deliberately drifted `example/`, 18 findings in 83 seconds for 17 cents:

```
[0.0s]  Explorer: exploring /…/example/src…
[20.1s]  Explorer: read 4 files — bearer-auth.guard.ts, dto.ts, projects.controller.ts,
         projects.service.ts
[20.1s]  Explorer: found 5 endpoints, 6 models
[20.1s]  Auditor: comparing against 7 doc files (1 spec root) in 1 shard(s)…
  high   api-reference.md: Base URL and all endpoint paths use /v1, but the true API uses /v2.
  high   paths/projects.yaml: POST body requires only `name`, not the required `ownerEmail`.
  medium paths/projects.yaml: listProjects query parameter is `perPage`; the true API uses `limit`.
  medium components/schemas/project.yaml: omits `ownerEmail`, and uses `isArchived` not `archived`.
  high   paths/project-by-id.yaml: No DELETE operation defined, though the API supports it.
  …13 more…
[39.9s]  Fixer: rewriting docs, linting as it goes…
[72.5s]  Fixer: updated 6 files
[72.5s]  Reporter: writing the pull request…

Token usage and cost
  explorer   3 calls     6014 in    1074 out  $0.0228
  auditor    1 calls     4079 in    2436 out  $0.0325
  fixer      4 calls    27600 in    3256 out  $0.0878
  reporter   1 calls     6410 in    1014 out  $0.0230
  TOTAL                                      $0.1660
  runtime 82.7s
```

It found all six planted drifts plus the `rules.md` violations the code alone could not reveal,
across all seven doc files — including the leaf of the `$ref` chain, two directories down.

`explorer 3 calls` is the loop: list the tree, read the files it chose, report. `fixer 4 calls` is
edits interleaved with `lintSpec`. Both are one `record()` call each — the ledger sums over
`result.steps`, which is what `src/llm.test.ts` guards, and why per-step billing was the right shape
before there was a tool loop to need it.

And the honest number: **17 cents against 14** for the previous triage-then-scan design. On-demand
reading costs more round trips and a context that grows every step, and the price moves run to run
in a way one big prompt does not. What you buy is a tool with no extension list, no route patterns
and no retry constant.

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
   ┌──────────────┬─────────────┼──────────────┬──────────────┐
   ▼              ▼             ▼              ▼              ▼
Explorer ──▶  Auditor  ──▶   Fixer   ──▶  lint gate  ──▶  Reporter
(tool loop:   (inventory   (tool loop:    (redocly on    (PR title
 listFiles /   vs docs +    readDoc /      spec roots;     + body)
 readFile /    rules.md)    writeDoc /     deterministic,
 report)                    lintSpec)      not the
                                           agent's call)
```

| Stage | Responsibility | Output |
| --- | --- | --- |
| **Explorer** | Explore the code and establish the API as it is actually implemented | `Inventory` — endpoints, params, models, auth |
| **Auditor** | Diff that inventory against the docs, plus the user's rules | `Finding[]` — file, kind, severity, problem, correction |
| **Fixer** | Rewrite the affected doc files, linting its own work as it goes | paths written |
| **lint gate** | `redocly lint` every spec root, after the agent is done | PR or revert — *deterministic, no LLM* |
| **Reporter** | Turn the run into a readable pull request | title + markdown body |

### The two loops

Two stages are tool loops built on the tool-loop agent class from `ai`, pinned at `ai@5.0.221`
where it is exported as `Experimental_Agent`. In `ai@6`+ the same class is `ToolLoopAgent` and is
no longer experimental — `Experimental_Agent` remains only as an alias, `stepCountIs` becomes
`isStepCount`, and `system` becomes `instructions`.

1. **The Explorer decides what to read.** `listFiles` gives it the tree, `readFile` opens one file,
   `report` returns the finished `Inventory`. It follows what it finds — a controller's imports
   lead it to the DTO file — so docdrift needs no extension allowlist and no per-framework route
   table. Nothing here knows that Nest spells routes `@Get` or that Rails spells them
   `config/routes.rb`.
2. **The Fixer validates its own work.** `lintSpec` runs Redocly, so the agent sees an error
   against the line it just wrote and decides whether to try again. Linting used to be an outer
   loop it could not see: it edited blind, and only after finishing did the orchestrator tell it
   that attempt one of two had failed.

### Structured output from a tool loop

The Explorer returns its inventory through a `report` tool whose `inputSchema` is the Zod schema,
and `hasToolCall('report')` ends the loop.

`experimental_output` was the obvious first choice and **on `ai@5` it does not work**: it pins a
JSON response format, and with the response format pinned the model cannot call tools at all. It
answered from the prompt alone, having read nothing, and returned an empty inventory — a run that
cost a cent and found zero endpoints. The `report` tool gets identical Zod validation while leaving
tool calling intact.

That is a limitation of the pinned version, not a permanent one. On `ai@7.0.40` the equivalent
option (`output: Output.object({ schema })`) *does* coexist with tools — verified against the
Gateway: the agent called its tools across three steps and still returned a validated object, with
`steps[].usage` and `providerMetadata.gateway.cost` unchanged. On an upgrade, `report` and its stop
condition should be deleted in favour of `output`.

### Retries are a ceiling, not a count

There is no `MAX_REPAIRS` anywhere. `stopWhen` takes an array and any condition ends the loop:

```ts
stopWhen: [hasToolCall('report'), stepCountIs(EXPLORE_STEPS), () => totalUsd() >= maxUsd]
```

How many times the Fixer re-lints and re-edits is the model's judgement. How far it may go is not:
`--max-usd` is a hard stop over the same ledger that prints the cost table. The model decides
whether to continue, the harness decides how far — which is also why giving the agent more freedom
did not mean giving it the guarantees. After the loop, `cli.ts` lints the spec roots itself and
reverts rather than open a pull request containing a broken specification. The agent was asked to
lint its own work and may have skipped it, run out of steps, or given up; whether a PR exists is
not its call.

### Design decisions

- **Code is the source of truth.** The Fixer can only write inside the docs directory. It never
  edits source. If the code is wrong, that is a human's problem.
- **Cost comes from the provider, not from us.** AI Gateway returns the dollar cost of every call
  in `providerMetadata.gateway.cost`. A hardcoded price table would silently rot; this cannot.
  A tool loop bills per step, so `src/llm.ts` sums over `result.steps` rather than trusting the
  result's own (last-step-only) metadata — that is what `src/llm.test.ts` pins down.
- **Zod schemas are the only type definitions.** `Inventory`, `Finding` and `Report` are inferred
  from the schemas the model is constrained to, so the runtime contract and the compile-time type
  cannot disagree.
- **Exploration beats triage beats a regex.** A table of per-framework patterns (`@Get(`,
  `app.post(`, `Route::get(`) would keep `projects.controller.ts` and drop `dto.ts`, which declares
  no route and holds every field `Inventory` needs. Triaging file heads in one prompt fixed that
  but still read every candidate file whole to use 25 lines of each. The tool loop reads the tree
  and then only the four files it wants — and that deleted the triage agent, its schema, and the
  inventory merge that existed to work around the prompt size.
- **Tool arguments are untrusted input.** `confine()` resolves every path a tool is given inside
  its base directory and returns null if it escapes. `join(docsDir, path)` accepts
  `../../src/service.ts`, which would let the Fixer edit the source it is supposed to be treating
  as the truth. The tools return an error string rather than throwing, so the model corrects itself
  instead of the run dying.
- **Nothing outside the docs directory is ours.** `git status`, `diff`, `checkout` and `add` are
  all scoped to the docs directory. Repo-wide, an unrelated working-tree change gets described in
  the PR body by the Reporter, committed by `add -A`, and destroyed by the revert. All three
  happened while building this.
- **Roots only, never partials.** See *Split specifications* below.
- **A broken toolchain must never look like a documentation problem.** The Validator resolves the
  Redocly CLI out of docdrift's own `node_modules` (`createRequire(import.meta.url).resolve`) and
  runs it with `process.execPath`. `npx` would resolve against the *target* repo, and on a repo
  without `@redocly/cli` it exits non-zero printing `npx canceled due to missing packages` — which
  `lint()` would have returned as a lint failure, and the orchestrator would have fed to the Fixer
  as if it were invalid OpenAPI. It would have burned both repair attempts on npm's error text and
  then reverted correct work. `redoclyCli()` is also called at the top of `main()`, so a missing
  linter fails before a single token is spent.
- **Four agents are four functions.** No base class, no registry, no plugin system. A `bounds()`
  helper for the two `stopWhen` arrays was written and then deleted: the array literal types itself
  correctly by context, and two call sites are not a pattern.

`src/` is about 700 lines in four files: `cli.ts` (orchestrator and lint gate), `agents.ts` (the
four agents, their schemas and tools, file walking, sharding), `llm.ts` (model + cost ledger),
`repo.ts` (git, `gh`, `redocly` — every subprocess).

## Split specifications

Any specification of real size ends up spread across files, and that is a trap. A partial is not a
document: it has no `openapi:` key of its own, and `redocly lint paths/projects.yaml` exits
non-zero with `Unsupported specification`. That is a usage error, not a documentation error — and
the previous version linted every `.yaml` the Fixer touched, so the first edit to a partial would
have fed `Unsupported specification` back to the agent as though it were invalid OpenAPI, burned
its budget rewriting perfectly good YAML, and then reverted correct work. Same shape as the `npx`
bug below, through a different door.

So docdrift lints **roots only**, identified by `isSpecRoot()` (`/^(openapi|swagger|asyncapi):/m`).
Redocly resolves `$ref`, so linting the root validates the whole tree *and* reports each problem
against the partial's own path and line — exactly what the Fixer needs to fix it. Partials are
still read by the Auditor, still edited by the Fixer, and still validated; they are simply never
linted directly. `src/repo.test.ts` pins both halves of that against the real Redocly CLI.

`example/docs/` is split on purpose so a run exercises it, with a `$ref` chain four levels deep:

```
example/docs/
  openapi.yaml                            root — the only file with an `openapi:` key
    ├─ paths/projects.yaml                POST + GET on the collection
    ├─ paths/project-by-id.yaml           GET + PATCH on one project
    └─ components/schemas/project.yaml    the Project schema
         └─ project-status.yaml           the leaf of the chain
  api-reference.md
  getting-started.md
```

Only `openapi.yaml` can be linted. Each of the four partials exits non-zero on its own with
`Unsupported specification`, and linting the root exits 0 while validating all five files.

In the run above, drift was found in every one of them — down to the leaf — and the Fixer added the
missing `DELETE` operation to `paths/project-by-id.yaml`, the partial, rather than to the root.

## The example project

`example/` is a Nest API with five endpoints and documentation that has been deliberately left
behind, so a run has something real to find:

| # | Drift | Where |
| --- | --- | --- |
| 1 | Routes moved `/v1/projects` → `/v2/projects` | both markdown files, `openapi.yaml` |
| 2 | Query parameter `perPage` renamed to `limit` | `paths/projects.yaml`, both markdown files |
| 3 | Project field `isArchived` renamed to `archived` | `components/schemas/project.yaml`, `paths/project-by-id.yaml`, `api-reference.md` |
| 4 | `ownerEmail` became required on create | `paths/projects.yaml`, `components/schemas/project.yaml`, `api-reference.md` |
| 5 | `DELETE /v2/projects/{id}` is undocumented | `paths/project-by-id.yaml`, `api-reference.md` |
| 6 | Auth moved from `X-Api-Key` to `Authorization: Bearer` | `getting-started.md`, `openapi.yaml` |

A mix of renames, omissions and stale examples — the three kinds of drift that actually happen.
Only drifts 1 and 6 are in the root document. The rest live inside spec *partials*, so a run has to
reach through `$ref` to find them and has to lint through the root to check its own repair.

## Custom rules

`rules.md` is read at runtime and appended to the Auditor's and Fixer's system prompts. It is for
house style the code cannot tell you about: "every endpoint needs a curl example", "never show a
literal token". Absent file, no rules — the pipeline still runs.

## Limits

Deliberate, and worth knowing before you point this at a monorepo:

- **The tool loop costs more than one big prompt.** More round trips, context growing every step,
  and a price you cannot predict before the run — 22 cents where the single-prompt design cost 14.
  You are buying flexibility with reproducibility.
- **`listFiles` returns the whole tree in one result.** Bounded, and truncated with a note if it
  exceeds the budget, but on a very large repo the real answer is still `--code`.
- **The Explorer is the accuracy ceiling.** A file it never opens is an endpoint nothing
  downstream can miss the absence of. It is prompted to follow references and to over-include, and
  the run prints exactly which files it read so you can see when it read too few.
- **Docs cannot be explored the way code is.** The Auditor has to see every doc file to know what
  is *missing*, so it gets them whole, sharded only if they exceed the budget. When they do split,
  a "documented nowhere" finding can be reported once per shard.
- **Sequential stages.** Runtime is the sum of the stages, and doc shards run one after another. A
  4-wide `mapLimit` is the upgrade, deferred because the free tier rate-limits per model and a 429
  mid-run is worse than a slow run.
- **Markdown is never linted.** Only OpenAPI/AsyncAPI roots pass through Redocly, so a broken
  markdown link the Fixer introduces is not caught.
- **Whole-file rewrites.** The Fixer returns complete file contents rather than a patch. Simple and
  robust at this size; on a 2,000-line reference page it would be wasteful and a diff-based tool
  would be better.
- **A false positive becomes a wrong edit in a pull request.** That is why a human reviews it, and
  why the Reporter is instructed to flag anything uncertain.
- **No fork-and-PR.** docdrift runs on a repo you have checked out and can push to. Pointing it at
  a repository you do not own needs `gh repo fork` and a cross-repo `gh pr create --head`.

## Development

```bash
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest run
```

Thirty-one unit tests over the deterministic logic. No mocked LLM calls — the agents are prompts,
and asserting on a stubbed model response would only test the stub.

- `src/llm.test.ts` — the cost ledger. The one that matters is *bills a tool loop per step*: a
  multi-step result reports only the last step's cost in its own `providerMetadata`, so billing
  the result once would silently undercount the Fixer. The ledger is module state by design, so
  each test re-imports the module via `vi.resetModules()` rather than have production code export
  a reset that only tests would call.
- `src/agents.test.ts` — everything deterministic around the agents. `readFiles`: recursion,
  relative paths, multiple extensions, pruned `node_modules`, the file size cap. `shards()`: one
  shard when it fits, no shard ever over budget, path ordering, and an over-budget file truncated
  rather than dropped. `confine()`: the trust boundary on every tool that takes a path — `..`,
  absolute paths, a sibling directory that merely shares a prefix, and a `..` that legitimately
  stays inside.
- `src/repo.test.ts` — the Validator, against the real Redocly CLI, in two temp directories that
  are each the point. One has no `node_modules`: a target repo that has never heard of Redocly,
  which is what the `npx` implementation got wrong. One holds a spec split across `openapi.yaml`,
  `paths/` and `components/`, where the tests pin the whole nested contract: linting the root
  validates the tree, an error planted inside a partial is reported *against that partial's path*,
  and linting the partial directly yields `Unsupported specification` while saying nothing about
  the documentation. Two assertions exist purely to keep failure modes distinguishable — the output
  must never match `/npx|npm error|missing packages/`, and the partial's toolchain error must never
  be mistaken for a spec error.
