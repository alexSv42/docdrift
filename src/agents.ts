import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateObject, generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { model, record } from './llm.js';

/* ------------------------------------------------------------------ files */

export interface File {
  path: string;
  content: string;
}

/** Every file under `dir` (recursively) whose name ends in one of `exts`. */
export function readFiles(dir: string, exts: readonly string[]): File[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => exts.some((ext) => path.endsWith(ext)))
    .map((path) => ({ path, content: readFileSync(join(dir, path), 'utf8') }));
}

const bundle = (files: readonly File[]): string =>
  files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n');

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

/** 1. Scanner — reads source code and extracts the API surface as it actually is. */
export async function scan(ctx: AgentContext, source: readonly File[]): Promise<Inventory> {
  const result = await generateObject({
    model: model(ctx.modelId),
    schema: Inventory,
    system:
      'You extract the true HTTP API surface from server source code. ' +
      'Report only what the code does. Never guess at undocumented behaviour.',
    prompt: `Source files:\n\n${bundle(source)}`,
  });
  record('scanner', result);
  return result.object;
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
 * 3. Fixer — an agentic tool loop. It chooses which documentation files to open and
 * rewrites them, one `writeDoc` call per file, until every finding is addressed.
 * `lintErrors` is non-empty when the validator rejected a previous attempt.
 */
export async function fix(
  ctx: AgentContext,
  docsDir: string,
  findings: readonly Finding[],
  lintErrors = '',
): Promise<string[]> {
  const written = new Set<string>();

  const result = await generateText({
    model: model(ctx.modelId),
    stopWhen: stepCountIs(2 * findings.length + 4),
    tools: {
      readDoc: tool({
        description: 'Read a documentation file.',
        inputSchema: z.object({ path: z.string() }),
        execute: ({ path }) => readFileSync(join(docsDir, path), 'utf8'),
      }),
      writeDoc: tool({
        description: 'Overwrite a documentation file with its full corrected contents.',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: ({ path, content }) => {
          writeFileSync(join(docsDir, path), content);
          written.add(path);
          return `wrote ${path}`;
        },
      }),
    },
    system: withRules(
      'You correct documentation to match the source code. Read each file before editing it. ' +
        'Fix only the reported drift — preserve surrounding prose, structure and formatting. ' +
        'Keep OpenAPI documents valid. Write each file at most once, with its complete contents.',
      ctx.rules,
    ),
    prompt:
      `Drift to fix:\n${JSON.stringify(findings, null, 2)}` +
      (lintErrors ? `\n\nYour previous edit failed OpenAPI linting. Fix these errors:\n${lintErrors}` : ''),
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
