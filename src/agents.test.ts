import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { confine, readFiles, shards, type File } from './agents.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'docdrift-'));
  mkdirSync(join(dir, 'nested'));
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'top.ts'), 'export const a = 1;');
  writeFileSync(join(dir, 'nested', 'deep.ts'), 'export const b = 2;');
  writeFileSync(join(dir, 'notes.md'), '# notes');
  writeFileSync(join(dir, 'ignored.txt'), 'nope');
  writeFileSync(join(dir, 'node_modules', 'dep.ts'), 'export const dep = 3;');
  writeFileSync(join(dir, 'huge.ts'), `// ${'x'.repeat(200_001)}`);
});

const sorted = (dir: string, exts: string[]) =>
  readFiles(dir, exts).sort((a, b) => a.path.localeCompare(b.path));

it('reads matching files recursively, with paths relative to the directory', () => {
  expect(sorted(dir, ['.ts'])).toEqual([
    { path: join('nested', 'deep.ts'), content: 'export const b = 2;' },
    { path: 'top.ts', content: 'export const a = 1;' },
  ]);
});

it('accepts several extensions at once', () => {
  expect(sorted(dir, ['.ts', '.md']).map((f) => f.path)).toEqual([
    join('nested', 'deep.ts'),
    'notes.md',
    'top.ts',
  ]);
});

it('ignores everything else', () => {
  expect(readFiles(dir, ['.ts', '.md']).map((f) => f.path)).not.toContain('ignored.txt');
});

it('returns nothing when no extension matches', () => {
  expect(readFiles(dir, ['.yaml'])).toEqual([]);
});

it('prunes dependency directories', () => {
  expect(readFiles(dir, ['.ts']).map((f) => f.path)).not.toContain(join('node_modules', 'dep.ts'));
});

it('skips files past the size cap, whatever their extension', () => {
  expect(readFiles(dir, ['.ts']).map((f) => f.path)).not.toContain('huge.ts');
});

/* ------------------------------------------------------------------ shards */

const file = (path: string, size: number): File => ({ path, content: 'x'.repeat(size) });
const bytes = (shard: readonly File[]): number =>
  shard.reduce((sum, f) => sum + f.content.length, 0);

describe('shards', () => {
  it('returns one shard when everything fits — the ordinary case after triage', () => {
    expect(shards([file('a.ts', 10), file('b.ts', 10)], 100)).toHaveLength(1);
  });

  it('splits when the total exceeds the budget, and no shard exceeds it', () => {
    const result = shards([file('a.ts', 60), file('b.ts', 60), file('c.ts', 60)], 100);
    expect(result).toHaveLength(3);
    for (const shard of result) expect(bytes(shard)).toBeLessThanOrEqual(100);
  });

  it('visits files in path order, so co-located files land in the same shard', () => {
    const result = shards(
      [file('z/late.ts', 40), file('a/dto.ts', 30), file('a/controller.ts', 30)],
      100,
    );
    expect(result[0]?.map((f) => f.path)).toEqual(['a/controller.ts', 'a/dto.ts', 'z/late.ts']);
  });

  it('truncates a file that is over budget by itself rather than dropping it', () => {
    const [shard] = shards([file('huge.ts', 500)], 100);
    expect(shard).toHaveLength(1);
    expect(bytes(shard!)).toBeLessThanOrEqual(100);
    expect(shard![0]!.content).toMatch(/truncated by docdrift/);
  });

  it('has nothing to shard when there are no files', () => {
    expect(shards([], 100)).toEqual([]);
  });
});

/* ----------------------------------------------------------------- confine */

/**
 * The trust boundary on every tool that takes a path. Tool arguments are model output, and
 * `join(base, path)` would happily accept `../../src/service.ts` — letting the Fixer edit the
 * source code it is supposed to be treating as the truth.
 */
describe('confine', () => {
  it('resolves a path inside the base directory', () => {
    expect(confine('/docs', 'api.md')).toBe(join('/docs', 'api.md'));
    expect(confine('/docs', 'paths/projects.yaml')).toBe(join('/docs', 'paths', 'projects.yaml'));
  });

  it('refuses to escape with ..', () => {
    expect(confine('/docs', '../src/service.ts')).toBeNull();
    expect(confine('/docs', 'paths/../../src/service.ts')).toBeNull();
  });

  it('refuses an absolute path outside the base', () => {
    expect(confine('/docs', '/etc/passwd')).toBeNull();
  });

  it('refuses a sibling directory that merely shares a prefix', () => {
    expect(confine('/docs', '../docs-private/secret.md')).toBeNull();
  });

  it('allows a .. that stays inside', () => {
    expect(confine('/docs', 'paths/../api.md')).toBe(join('/docs', 'api.md'));
  });
});
