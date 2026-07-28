import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Experimental_Agent as Agent, generateObject, hasToolCall, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { model, record, totalUsd } from './llm.js';

/* ------------------------------------------------------------------ files */

export interface File {
  path: string;
  content: string;
}

/** Directories that are never source: dependencies, build output, caches. */
const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
  '.next',
]);

/** Minified bundles and generated clients are not source, whatever their extension says. */
const MAX_FILE_BYTES = 200_000;

/**
 * Relative paths of every file under `dir`, pruning `IGNORED` directories as it descends rather
 * than walking them and filtering after — on a real repository `node_modules` is most of the tree.
 * Symlinks are skipped: neither `isFile()` nor `isDirectory()` holds for them, so cycles cannot
 * happen either.
 */
function* walk(dir: string, prefix = ''): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const path = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) yield* walk(join(dir, entry.name), path);
    else if (entry.isFile()) yield path;
  }
}

/** Every file under `dir` (recursively) whose name ends in one of `exts`. */
export function readFiles(dir: string, exts: readonly string[]): File[] {
  return [...walk(dir)]
    .filter((path) => exts.some((ext) => path.endsWith(ext)))
    .filter((path) => statSync(join(dir, path)).size <= MAX_FILE_BYTES)
    .map((path) => ({ path, content: readFileSync(join(dir, path), 'utf8') }));
}

const bundle = (files: readonly File[]): string =>
  files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n');

/* ------------------------------------------------------------------ budget */

/** Roughly four characters to a token, leaving room for the system prompt and the response. */
const BUDGET_CHARS = 400_000;

const TRUNCATED = '\n\n… file truncated by docdrift …';

/**
 * Group files so that no one bundle exceeds `budget` — and into a single shard when everything
 * fits, which for a normal docs directory is the ordinary case.
 *
 * Used for the docs only. The Auditor has to see every doc file to know what is *missing*, so it
 * cannot explore its way through them the way the Explorer does with source. Files are visited in
 * path order so a spec root and the partials beneath it land in the same shard where possible; a
 * file over budget on its own is truncated rather than dropped.
 */
export function shards(files: readonly File[], budget = BUDGET_CHARS): File[][] {
  const out: File[][] = [];
  let current: File[] = [];
  let size = 0;

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const capped =
      file.content.length > budget - TRUNCATED.length
        ? { ...file, content: file.content.slice(0, budget - TRUNCATED.length) + TRUNCATED }
        : file;
    if (current.length > 0 && size + capped.content.length > budget) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(capped);
    size += capped.content.length;
  }

  if (current.length > 0) out.push(current);
  return out;
}

/* ----------------------------------------------------------------- schemas */

const Endpoint = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().describe('Full route including any controller prefix, e.g. /v2/projects/{id}'),
  successStatus: z.number(),
  queryParams: z.array(z.string()),
  requiredBodyFields: z.array(z.string()),
  optionalBodyFields: z.array(z.string()),
});

const Inventory = z.object({
  auth: z.string().describe('How a caller authenticates, naming the exact header'),
  endpoints: z.array(Endpoint),
  models: z.array(z.object({ name: z.string(), fields: z.array(z.string()) })),
});

const Finding = z.object({
  docFile: z.string().describe('Path of the documentation file, relative to the docs directory'),
  kind: z.enum(['missing', 'renamed', 'outdated', 'rule-violation']),
  severity: z.enum(['high', 'medium', 'low']),
  problem: z.string().describe('What the docs currently say that is wrong'),
  correction: z.string().describe('What they should say, per the source code'),
});

const Report = z.object({
  title: z.string().describe('Pull request title, under 70 characters'),
  body: z.string().describe('Pull request description in GitHub-flavoured markdown'),
});

export type Inventory = z.infer<typeof Inventory>;
export type Finding = z.infer<typeof Finding>;
export type Report = z.infer<typeof Report>;

/* ------------------------------------------------------------------ agents */

export interface AgentContext {
  modelId: string;
  /** Contents of the user's rules file, appended to the prompts that need it. */
  rules: string;
}

const withRules = (prompt: string, rules: string): string =>
  rules.trim() ? `${prompt}\n\nAdditional compliance rules the docs must satisfy:\n${rules}` : prompt;

/* ------------------------------------------------------------------- loops */

/**
 * Resolve `path` inside `base`, or null if it escapes.
 *
 * Tool arguments are model output, which is untrusted input. `join(base, path)` happily accepts
 * `../../src/service.ts`, which would let the Fixer edit the source it is supposed to be treating
 * as the truth.
 */
export function confine(base: string, path: string): string | null {
  const full = resolve(base, path);
  return full === base || full.startsWith(base + sep) ? full : null;
}

/**
 * Step ceilings for the two loops. Generous, because they are the backstop rather than the bound
 * that matters: each loop also stops on `--max-usd`, and normally ends earlier than either when
 * the model stops calling tools.
 *
 * This is where "how many retries" lives now. Not a constant the agent must obey — a ceiling it
 * cannot talk its way past, with the count inside it left to the model.
 */
const EXPLORE_STEPS = 30;
const REPAIR_STEPS = 40;

/**
 * 1. Explorer — a tool loop that finds the HTTP API for itself and returns it as an `Inventory`.
 *
 * Replaces reading the whole tree and triaging it in one prompt. It lists the directory, opens
 * only the files it judges relevant, and follows what it finds: a controller's imports lead it to
 * the DTO file, and nothing here needs to know that Nest spells routes `@Get` or that Rails
 * spells them `config/routes.rb`.
 *
 * The inventory comes back through a `report` tool rather than `experimental_output`. That was the
 * first attempt and it does not work here: `experimental_output` pins a JSON response format, and
 * with the response format pinned the model cannot call tools at all — it answered from the prompt
 * alone, having read nothing, and returned an empty inventory. A tool whose `inputSchema` is the
 * schema gets the same Zod validation while leaving tool calling intact, and
 * `hasToolCall('report')` is then the natural end of the loop.
 */
export async function explore(
  ctx: AgentContext,
  codeDir: string,
  maxUsd: number,
): Promise<{ inventory: Inventory; opened: string[] }> {
  const opened: string[] = [];
  let inventory: Inventory | null = null;

  const agent = new Agent({
    model: model(ctx.modelId),
    system:
      'You establish the true HTTP API surface of a codebase by exploring it. ' +
      'Start by listing the files. Then read only the ones that could define routes, handlers, ' +
      'request or response bodies, or authentication. Follow what you read: if a route handler ' +
      'references a type you have not seen, open the file that defines it before reporting its ' +
      'fields. Skip tests, fixtures, migrations, build output and infrastructure. ' +
      'Report only what the code does, and never guess at undocumented behaviour. ' +
      'When you have the whole surface, call report exactly once with it.',
    tools: {
      listFiles: tool({
        description: 'List every file in the code directory, as paths relative to its root.',
        inputSchema: z.object({}),
        execute: () => {
          const listing = [...walk(codeDir)].join('\n');
          if (listing === '') return '(the directory is empty)';
          // No extension allowlist: the agent recognises `config/routes.rb` or `go.mod` without
          // docdrift enumerating languages. The one thing it cannot do is read a listing that
          // does not fit, so that is the only case bounded here.
          return listing.length <= BUDGET_CHARS
            ? listing
            : `${listing.slice(0, BUDGET_CHARS)}\n… listing truncated — narrow --code to the API's directory`;
        },
      }),
      readFile: tool({
        description: 'Read one file from the listing, by its relative path.',
        inputSchema: z.object({ path: z.string() }),
        execute: ({ path }) => {
          const full = confine(codeDir, path);
          if (!full) return `error: ${path} is outside the code directory`;
          try {
            opened.push(path);
            return readFileSync(full, 'utf8');
          } catch {
            return `error: ${path} could not be read — check the listing for its exact path`;
          }
        },
      }),
      report: tool({
        description: 'Report the complete API surface. Call this exactly once, when finished.',
        inputSchema: Inventory,
        execute: (found) => {
          inventory = found;
          return 'recorded';
        },
      }),
    },
    // The model ends the loop by reporting; the rest are ceilings it cannot talk its way past.
    stopWhen: [hasToolCall('report'), stepCountIs(EXPLORE_STEPS), () => totalUsd() >= maxUsd],
  });

  const result = await agent.generate({
    prompt: `Establish the HTTP API surface of the code in ${codeDir}. Start by listing the files.`,
  });
  record('explorer', result);

  if (inventory === null) {
    throw new Error(
      `The Explorer read ${opened.length} files but never reported an API surface. ` +
        'Check that --code points at server source, or raise --max-usd.',
    );
  }
  return { inventory, opened };
}

/** 2. Auditor — diffs the inventory against the docs and lists concrete drift. */
export async function audit(
  ctx: AgentContext,
  inventory: Inventory,
  docs: readonly File[],
): Promise<Finding[]> {
  const result = await generateObject({
    model: model(ctx.modelId),
    schema: z.object({ findings: z.array(Finding) }),
    system: withRules(
      'You compare documentation against the true API surface. The code is the source of truth. ' +
        'Report only verifiable drift: endpoints, parameters, fields, status codes, auth headers, ' +
        'paths and examples that contradict the code. Ignore wording and style.',
      ctx.rules,
    ),
    prompt: `True API surface:\n${JSON.stringify(inventory, null, 2)}\n\nDocumentation:\n\n${bundle(docs)}`,
  });
  record('auditor', result);
  return result.object.findings;
}

/**
 * 3. Fixer — a tool loop that corrects the docs and validates its own work.
 *
 * `lintSpec` is the change that matters. Linting used to be an outer loop the agent could not
 * see: it edited blindly, and only after it had finished did the orchestrator tell it that
 * attempt one of two had failed. Now the linter is a tool, so the agent checks after each edit,
 * sees the error against the line it just wrote, and decides for itself whether to try again —
 * bounded by `bounds()`, never by a hardcoded retry count.
 *
 * `lintSpecs` is injected rather than imported so this module stays free of subprocess concerns,
 * and so a test can supply a linter that fails on demand.
 */
export async function fix(
  ctx: AgentContext,
  docsDir: string,
  findings: readonly Finding[],
  lintSpecs: () => { ok: boolean; output: string },
  maxUsd: number,
): Promise<string[]> {
  const written = new Set<string>();

  const agent = new Agent({
    model: model(ctx.modelId),
    system: withRules(
      'You correct documentation to match the source code. Read each file before editing it. ' +
        'Fix only the reported drift — preserve surrounding prose, structure and formatting. ' +
        'After editing any OpenAPI or AsyncAPI document, call lintSpec and repair anything it ' +
        'reports before moving on. A specification may be split across files: lintSpec follows ' +
        '$ref, so an error it reports in a partial is fixed by editing that partial, not the root. ' +
        'When every finding is addressed and lintSpec is clean, stop calling tools.',
      ctx.rules,
    ),
    tools: {
      readDoc: tool({
        description: 'Read a documentation file by its path, relative to the docs directory.',
        inputSchema: z.object({ path: z.string() }),
        execute: ({ path }) => {
          const full = confine(docsDir, path);
          if (!full) return `error: ${path} is outside the documentation directory`;
          try {
            return readFileSync(full, 'utf8');
          } catch {
            return `error: ${path} could not be read`;
          }
        },
      }),
      writeDoc: tool({
        description: 'Overwrite a documentation file with its full corrected contents.',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: ({ path, content }) => {
          const full = confine(docsDir, path);
          if (!full) return `error: ${path} is outside the documentation directory`;
          writeFileSync(full, content);
          written.add(path);
          return `wrote ${path}`;
        },
      }),
      lintSpec: tool({
        description:
          'Lint every specification document in the docs directory, following $ref into ' +
          'partial files. Returns "valid" or the linter errors. Call after editing a spec.',
        inputSchema: z.object({}),
        execute: () => {
          const result = lintSpecs();
          return result.ok ? 'valid' : result.output;
        },
      }),
    },
    stopWhen: [stepCountIs(REPAIR_STEPS), () => totalUsd() >= maxUsd],
  });

  const result = await agent.generate({
    prompt: `Drift to fix:\n${JSON.stringify(findings, null, 2)}`,
  });
  record('fixer', result);
  return [...written];
}

/** 4. Reporter — turns the run into a pull request a reviewer can read cold. */
export async function report(
  ctx: AgentContext,
  findings: readonly Finding[],
  changedFiles: readonly string[],
  diff: string,
): Promise<Report> {
  const result = await generateObject({
    model: model(ctx.modelId),
    schema: Report,
    system:
      'You write pull request descriptions for documentation fixes. Be precise and brief. ' +
      'Group findings by severity, state what changed and why, and note anything a human should check. ' +
      'Do not invent changes that are not in the diff.',
    prompt:
      `Findings:\n${JSON.stringify(findings, null, 2)}\n\n` +
      `Files changed: ${changedFiles.join(', ')}\n\nDiff:\n${diff}`,
  });
  record('reporter', result);
  return result.object;
}
