import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { isSpecRoot, lint, redoclyCli } from './repo.js';

/** A temp directory with no node_modules — i.e. a target repo that has never heard of Redocly. */
let bare: string;

/** A specification split across files, the layout Redocly itself recommends. */
let split: string;

const VALID = `openapi: 3.1.0
info:
  title: Test
  version: 1.0.0
servers:
  - url: https://api.example.com
paths: {}
`;

/** Root document: declares the spec version, and reaches the rest through `$ref`. */
const SPLIT_ROOT = `openapi: 3.1.0
info:
  title: Split
  version: 1.0.0
servers:
  - url: https://api.example.com
security:
  - bearerAuth: []
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
paths:
  /v2/projects:
    $ref: './paths/projects.yaml'
`;

/** A partial. Valid as a fragment, not a document — it has no `openapi:` of its own. */
const SPLIT_PARTIAL = `get:
  summary: List projects
  operationId: listProjects
  responses:
    '200':
      description: OK
      content:
        application/json:
          schema:
            type: array
            items:
              type: object
`;

/** The same partial, with a genuine structural error inside it: `description` must be a string. */
const SPLIT_PARTIAL_BROKEN = `get:
  summary: List projects
  operationId: listProjects
  responses:
    '200':
      description: 42
`;

beforeAll(() => {
  bare = mkdtempSync(join(tmpdir(), 'docdrift-lint-'));
  writeFileSync(join(bare, 'valid.yaml'), VALID);
  writeFileSync(join(bare, 'broken.yaml'), 'openapi: 3.1.0\npaths: {}\n'); // no `info`

  split = mkdtempSync(join(tmpdir(), 'docdrift-split-'));
  mkdirSync(join(split, 'paths'));
  writeFileSync(join(split, 'openapi.yaml'), SPLIT_ROOT);
  writeFileSync(join(split, 'paths', 'projects.yaml'), SPLIT_PARTIAL);
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

/* ------------------------------------------------- partial and nested specs */

/**
 * A specification split across files is the normal layout for anything non-trivial, and it is a
 * trap: a partial is not a document. Linting one directly exits non-zero with `Unsupported
 * specification`, which is a usage error. Feed that to the Fixer as if it were invalid OpenAPI and
 * it will spend its repair attempts rewriting perfectly good YAML, and then correct work gets
 * reverted. Same shape of bug as the `npx` one above, through a different door — hence
 * `isSpecRoot`, and hence linting roots only.
 */
describe('split specifications', () => {
  it('tells a root document from a partial', () => {
    expect(isSpecRoot(SPLIT_ROOT)).toBe(true);
    expect(isSpecRoot(SPLIT_PARTIAL)).toBe(false);
    expect(isSpecRoot(SPLIT_PARTIAL_BROKEN)).toBe(false);
  });

  it('recognises swagger and asyncapi roots too', () => {
    expect(isSpecRoot('swagger: "2.0"\ninfo: {}\n')).toBe(true);
    expect(isSpecRoot('asyncapi: 3.0.0\ninfo: {}\n')).toBe(true);
  });

  it('does not mistake a mention of openapi in prose for a root', () => {
    expect(isSpecRoot('# Our openapi: spec lives in ./openapi.yaml\n')).toBe(false);
  });

  it('validates the whole tree when given only the root', () => {
    expect(lint(split, ['openapi.yaml']).ok).toBe(true);
  });

  it('reports an error inside a partial against that partial, when linting the root', () => {
    writeFileSync(join(split, 'paths', 'projects.yaml'), SPLIT_PARTIAL_BROKEN);
    const result = lint(split, ['openapi.yaml']);
    writeFileSync(join(split, 'paths', 'projects.yaml'), SPLIT_PARTIAL);

    expect(result.ok).toBe(false);
    // The location the Fixer needs is the partial's own path, not the root's.
    expect(result.output).toMatch(/paths[/\\]projects\.yaml/);
    expect(result.output).toContain('responses');
  });

  it('cannot lint a partial on its own — the reason we never pass one', () => {
    const result = lint(split, [join('paths', 'projects.yaml')]);

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/unsupported specification/i);
    // And it says nothing about the actual documentation, which is exactly the danger.
    expect(result.output).not.toContain('responses');
  });
});
