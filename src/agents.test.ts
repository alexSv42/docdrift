import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { readFiles } from './agents.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'docdrift-'));
  mkdirSync(join(dir, 'nested'));
  writeFileSync(join(dir, 'top.ts'), 'export const a = 1;');
  writeFileSync(join(dir, 'nested', 'deep.ts'), 'export const b = 2;');
  writeFileSync(join(dir, 'notes.md'), '# notes');
  writeFileSync(join(dir, 'ignored.txt'), 'nope');
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
