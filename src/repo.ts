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

/**
 * Every git operation is scoped to a path, and callers pass the documentation directory.
 *
 * docdrift only ever edits docs, so a repo-wide scope is both wrong and dangerous: `git diff` would
 * describe unrelated work in the pull request body, `git add -A` would commit it, and `revert`
 * would destroy it. Nothing outside `scope` is docdrift's to read or to throw away.
 */
export const changedPaths = (cwd: string, scope: string): string[] =>
  run('git', ['status', '--porcelain', '--', scope], cwd)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));

export const diff = (cwd: string, scope: string): string => run('git', ['diff', '--', scope], cwd);

export const revert = (cwd: string, scope: string): void =>
  void run('git', ['checkout', '--', scope], cwd);

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

/**
 * Whether a document can be linted on its own, i.e. it declares a specification version at the
 * top level rather than being a fragment `$ref`d from somewhere else.
 *
 * This distinction is not cosmetic. Redocly resolves `$ref`s, so linting the root validates the
 * whole tree and reports problems against the *partial's* own path and line numbers — everything
 * a repair needs. Linting a partial directly exits non-zero with `Unsupported specification`,
 * which is a usage error, not a documentation error. Handing that text to an agent as if it were
 * invalid OpenAPI is how correct work gets reverted.
 */
export const isSpecRoot = (content: string): boolean => /^(openapi|swagger|asyncapi):/m.test(content);

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

/** Commit the documentation changes on a new branch, push it, and open a PR. Returns the PR URL. */
export function openPullRequest(
  cwd: string,
  pr: { branch: string; title: string; body: string; base: string; scope: string },
): string {
  run('git', ['checkout', '-b', pr.branch], cwd);
  run('git', ['add', '--', pr.scope], cwd);
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
