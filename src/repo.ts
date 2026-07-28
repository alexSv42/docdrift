import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/** Run a command, returning stdout. Throws with the command's own stderr on failure. */
function run(cmd: string, args: readonly string[], cwd: string): string {
  const { status, stdout, stderr } = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${stderr || stdout}`);
  return stdout;
}

/* --------------------------------------------------------------------- git */

export const repoRoot = (cwd: string): string =>
  run('git', ['rev-parse', '--show-toplevel'], cwd).trim();

export const currentBranch = (cwd: string): string =>
  run('git', ['branch', '--show-current'], cwd).trim();

/** Paths, relative to the repo root, that differ from HEAD. */
export const changedPaths = (cwd: string): string[] =>
  run('git', ['status', '--porcelain'], cwd)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));

export const diff = (cwd: string): string => run('git', ['diff'], cwd);

export const revert = (cwd: string): void => void run('git', ['checkout', '--', '.'], cwd);

/* --------------------------------------------------------------- validator */

export interface LintResult {
  ok: boolean;
  output: string;
}

/**
 * Absolute path to the Redocly CLI inside *docdrift's own* dependencies.
 *
 * Deliberately not `npx`: npx resolves against the current working directory, so on a target
 * repo without @redocly/cli it exits non-zero with "npx canceled due to missing packages".
 * `lint()` would have reported that as a lint failure, and the orchestrator would have fed
 * npm's error text to the Fixer as if it were invalid OpenAPI — burning both repair attempts
 * on nonsense and then reverting correct work. A missing linter is an install problem and must
 * never be able to look like a documentation problem.
 */
export function redoclyCli(): string {
  try {
    return createRequire(import.meta.url).resolve('@redocly/cli/bin/cli.js');
  } catch {
    throw new Error('@redocly/cli could not be resolved. Run `npm install` in docdrift.');
  }
}

/** Lint OpenAPI/AsyncAPI documents with the Redocly CLI. Never throws — the caller repairs. */
export function lint(cwd: string, specs: readonly string[]): LintResult {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    [redoclyCli(), 'lint', ...specs],
    { cwd, encoding: 'utf8' },
  );
  return { ok: status === 0, output: `${stdout}${stderr}`.trim() };
}

/* ------------------------------------------------------------ pull request */

/** Commit the working tree on a new branch, push it, and open a PR. Returns the PR URL. */
export function openPullRequest(
  cwd: string,
  pr: { branch: string; title: string; body: string; base: string },
): string {
  run('git', ['checkout', '-b', pr.branch], cwd);
  run('git', ['add', '-A'], cwd);
  run('git', ['commit', '-m', pr.title], cwd);
  run('git', ['push', '-u', 'origin', pr.branch], cwd);
  const url = run(
    'gh',
    ['pr', 'create', '--base', pr.base, '--title', pr.title, '--body', pr.body],
    cwd,
  );
  run('git', ['checkout', pr.base], cwd);
  return url.trim();
}
