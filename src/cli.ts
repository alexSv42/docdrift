#!/usr/bin/env -S npx tsx
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { audit, fix, readFiles, report, scan, type AgentContext, type Finding } from './agents.js';
import { DEFAULT_MODEL, ledger, totalUsd } from './llm.js';
import {
  changedPaths,
  currentBranch,
  diff,
  lint,
  openPullRequest,
  repoRoot,
  revert,
  type LintResult,
} from './repo.js';

const SOURCE_EXTS = ['.ts'] as const;
const DOC_EXTS = ['.md', '.yaml', '.yml', '.json'] as const;
const SPEC = /\.(ya?ml|json)$/;
/** How many times the Fixer may retry after the Redocly validator rejects its spec edit. */
const MAX_REPAIRS = 2;

const { values } = parseArgs({
  options: {
    code: { type: 'string', default: 'example/src' },
    docs: { type: 'string', default: 'example/docs' },
    rules: { type: 'string', default: 'rules.md' },
    model: { type: 'string', default: DEFAULT_MODEL },
    'dry-run': { type: 'boolean', default: false },
  },
});

const started = Date.now();
const step = (message: string): void =>
  console.log(`\x1b[2m[${((Date.now() - started) / 1000).toFixed(1)}s]\x1b[0m ${message}`);

/**
 * The Fixer/Validator loop: edit the docs, lint any OpenAPI document that was touched,
 * and hand the linter's errors back to the Fixer until the spec is valid or we give up.
 */
async function fixAndValidate(
  ctx: AgentContext,
  root: string,
  docsDir: string,
  findings: readonly Finding[],
): Promise<{ written: string[]; lint: LintResult }> {
  const written = new Set<string>();
  let result: LintResult = { ok: true, output: '' };

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    step(attempt === 0 ? 'Fixer: rewriting docs…' : `Fixer: repairing lint errors (${attempt}/${MAX_REPAIRS})…`);
    for (const path of await fix(ctx, docsDir, findings, result.ok ? '' : result.output)) {
      written.add(path);
    }

    const specs = [...written].filter((p) => SPEC.test(p)).map((p) => join(relative(root, docsDir), p));
    if (specs.length === 0) break;

    step(`Validator: redocly lint ${specs.join(' ')}`);
    result = lint(root, specs);
    if (result.ok) break;
  }

  return { written: [...written], lint: result };
}

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

  const root = repoRoot(process.cwd());
  const codeDir = resolve(values.code);
  const docsDir = resolve(values.docs);
  const ctx: AgentContext = {
    modelId: values.model,
    rules: existsSync(values.rules) ? readFileSync(values.rules, 'utf8') : '',
  };

  const source = readFiles(codeDir, SOURCE_EXTS);
  const docs = readFiles(docsDir, DOC_EXTS);
  step(`Scanner: reading ${source.length} source files…`);
  const inventory = await scan(ctx, source);
  step(`Scanner: found ${inventory.endpoints.length} endpoints, ${inventory.models.length} models`);

  step(`Auditor: comparing against ${docs.length} doc files…`);
  const findings = await audit(ctx, inventory, docs);
  if (findings.length === 0) {
    step('No drift found. Docs match the code.');
    printCosts();
    return 0;
  }
  for (const f of findings) {
    console.log(`  \x1b[33m${f.severity.padEnd(6)}\x1b[0m ${f.docFile}: ${f.problem}`);
  }

  const { written, lint: lintResult } = await fixAndValidate(ctx, root, docsDir, findings);
  const changed = changedPaths(root);
  if (changed.length === 0) {
    step('Fixer made no changes. Nothing to open a PR for.');
    printCosts();
    return 1;
  }
  if (!lintResult.ok) {
    step(`\x1b[31mSpec still fails lint after ${MAX_REPAIRS} repairs — reverting.\x1b[0m`);
    console.log(lintResult.output);
    revert(root);
    printCosts();
    return 1;
  }
  step(`Fixer: updated ${written.length} files`);

  step('Reporter: writing the pull request…');
  const pr = await report(ctx, findings, changed, diff(root));

  if (values['dry-run']) {
    step('Dry run — no PR opened. Proposed pull request:');
    console.log(`\n# ${pr.title}\n\n${pr.body}\n`);
    revert(root);
  } else {
    const url = openPullRequest(root, {
      branch: `docdrift/${started}`,
      base: currentBranch(root),
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
