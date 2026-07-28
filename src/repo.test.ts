import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { lint, redoclyCli } from './repo.js';

/** A temp directory with no node_modules — i.e. a target repo that has never heard of Redocly. */
let bare: string;

const VALID = `openapi: 3.1.0
info:
  title: Test
  version: 1.0.0
servers:
  - url: https://api.example.com
paths: {}
`;

beforeAll(() => {
  bare = mkdtempSync(join(tmpdir(), 'docdrift-lint-'));
  writeFileSync(join(bare, 'valid.yaml'), VALID);
  writeFileSync(join(bare, 'broken.yaml'), 'openapi: 3.1.0\npaths: {}\n'); // no `info`
});

it('resolves the Redocly CLI from docdrift, not from the working directory', () => {
  expect(redoclyCli()).toMatch(/@redocly[/\\]cli[/\\]bin[/\\]cli\.js$/);
});

it('lints a valid spec in a directory with no node_modules', () => {
  // Regression: with `npx --no-install` this returned ok:false and the orchestrator
  // handed "npx canceled due to missing packages" to the Fixer as if it were a spec error.
  expect(lint(bare, ['valid.yaml'])).toEqual({ ok: true, output: expect.any(String) });
});

it('reports a genuine spec error as a lint failure', () => {
  const result = lint(bare, ['broken.yaml']);

  expect(result.ok).toBe(false);
  expect(result.output).toContain('info');
});

it('never reports a toolchain failure as a lint failure', () => {
  for (const spec of ['valid.yaml', 'broken.yaml']) {
    expect(lint(bare, [spec]).output).not.toMatch(/npx|npm error|missing packages/i);
  }
});
