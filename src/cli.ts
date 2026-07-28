#!/usr/bin/env -S npx tsx
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  audit,
  explore,
  fix,
  readFiles,
  report,
  shards,
  type AgentContext,
  type File,
  type Finding,
} from './agents.js';
import { DEFAULT_MODEL, ledger, totalUsd } from './llm.js';
import {
  changedPaths,
  currentBranch,
  diff,
  isSpecRoot,
  lint,
  openPullRequest,
  redoclyCli,
  repoRoot,
  revert,
  type LintResult,
} from './repo.js';

// There is no SOURCE_EXTS list any more. The Explorer lists the code directory itself and decides
// what is source, so docdrift never has to enumerate the languages it supports.
const DOC_EXTS = ['.md', '.yaml', '.yml', '.json'] as const;

const { values } = parseArgs({
  options: {
    code: { type: 'string', default: 'example/src' },
    docs: { type: 'string', default: 'example/docs' },
    rules: { type: 'string', default: 'rules.md' },
    model: { type: 'string', default: DEFAULT_MODEL },
    'max-usd': { type: 'string', default: '1.00' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const started = Date.now();
const step = (message: string): void =>
  console.log(`\x1b[2m[${((Date.now() - started) / 1000).toFixed(1)}s]\x1b[0m ${message}`);

/**
 * The specification documents in `docs` that Redocly can lint on its own, as paths relative to
 * the repository root.
 *
 * Only roots, never the partials they `$ref`. Redocly follows references, so linting the root
 * validates the whole tree and reports errors against the partial's own path and line — while
 * linting a partial directly exits non-zero with `Unsupported specification`, which is not a
 * documentation problem and must never be handed to an agent as though it were.
 */
const specRoots = (root: string, docsDir: string, docs: readonly File[]): string[] =>
  docs
    .filter((f) => isSpecRoot(f.content))
    .map((f) => join(relative(root, docsDir), f.path));

function printCosts(): void {
  console.log('\nToken usage and cost');
  for (const row of ledger()) {
    console.log(
      `  ${row.agent.padEnd(9)} ${String(row.calls).padStart(2)} calls  ` +
        `${String(row.inputTokens).padStart(7)} in  ${String(row.outputTokens).padStart(6)} out  ` +
        `$${row.usd.toFixed(4)}`,
    );
  }
  console.log(`  ${'TOTAL'.padEnd(9)} ${' '.repeat(33)}$${totalUsd().toFixed(4)}`);
  console.log(`  runtime ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function main(): Promise<number> {
  if (!process.env['AI_GATEWAY_API_KEY']) {
    throw new Error('AI_GATEWAY_API_KEY is not set. See .env.example.');
  }
  redoclyCli(); // Fail before spending a token: the Validator is not optional.

  const root = repoRoot(process.cwd());
  const codeDir = resolve(values.code);
  const docsDir = resolve(values.docs);
  const ctx: AgentContext = {
    modelId: values.model,
    rules: existsSync(values.rules) ? readFileSync(values.rules, 'utf8') : '',
  };

  const maxUsd = Number(values['max-usd']);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
    throw new Error(`--max-usd must be a positive number, got ${values['max-usd']}`);
  }

  const docs = readFiles(docsDir, DOC_EXTS);
  const roots = specRoots(root, docsDir, docs);

  step(`Explorer: exploring ${codeDir}…`);
  const { inventory, opened } = await explore(ctx, codeDir, maxUsd);
  step(`Explorer: read ${opened.length} files — ${opened.join(', ')}`);
  step(`Explorer: found ${inventory.endpoints.length} endpoints, ${inventory.models.length} models`);

  const docShards = shards(docs);
  step(
    `Auditor: comparing against ${docs.length} doc files ` +
      `(${roots.length} spec root${roots.length === 1 ? '' : 's'}) in ${docShards.length} shard(s)…`,
  );
  const findings: Finding[] = [];
  for (const shard of docShards) findings.push(...(await audit(ctx, inventory, shard)));
  if (findings.length === 0) {
    step('No drift found. Docs match the code.');
    printCosts();
    return 0;
  }
  for (const f of findings) {
    console.log(`  \x1b[33m${f.severity.padEnd(6)}\x1b[0m ${f.docFile}: ${f.problem}`);
  }

  /**
   * Lint every spec root currently on disk — the Fixer's `lintSpec` tool and, after the loop, the
   * gate that decides whether a pull request may exist at all. Rediscovering roots on each call
   * costs a directory read and means a root the Fixer created is linted too.
   *
   * Roots only, never the partials they reference: that is what keeps `Unsupported specification`
   * out of the agent's context.
   */
  const lintDocs = (): LintResult => {
    const found = specRoots(root, docsDir, readFiles(docsDir, DOC_EXTS));
    return found.length > 0 ? lint(root, found) : { ok: true, output: '' };
  };

  step('Fixer: rewriting docs, linting as it goes…');
  const written = await fix(ctx, docsDir, findings, lintDocs, maxUsd);

  // Every git operation is scoped here. Whatever else is in the working tree is not docdrift's to
  // describe, commit, or throw away.
  const scope = relative(root, docsDir);

  const changed = changedPaths(root, scope);
  if (changed.length === 0) {
    step('Fixer made no changes. Nothing to open a PR for.');
    printCosts();
    return 1;
  }

  // The agent was told to lint its own work; it may have skipped it, run out of steps, or given up.
  // Whether a pull request exists is not its decision to make.
  const lintResult = lintDocs();
  if (!lintResult.ok) {
    step('\x1b[31mSpec does not lint — reverting rather than opening a broken PR.\x1b[0m');
    console.log(lintResult.output);
    revert(root, scope);
    printCosts();
    return 1;
  }
  step(`Fixer: updated ${written.length} files`);

  step('Reporter: writing the pull request…');
  const pr = await report(ctx, findings, changed, diff(root, scope));

  if (values['dry-run']) {
    step('Dry run — no PR opened. Proposed pull request:');
    console.log(`\n# ${pr.title}\n\n${pr.body}\n`);
    revert(root, scope);
  } else {
    const url = openPullRequest(root, {
      branch: `docdrift/${started}`,
      base: currentBranch(root),
      scope,
      title: pr.title,
      body: `${pr.body}\n\n---\n_Opened by docdrift — ${findings.length} findings, $${totalUsd().toFixed(4)}._`,
    });
    step(`Pull request opened: ${url}`);
  }

  printCosts();
  return 1; // drift was found — non-zero so CI notices.
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`);
    process.exit(2);
  },
);
