import { beforeEach, expect, it, vi } from 'vitest';
import type * as Llm from './llm.js';

let llm: typeof Llm;

// The ledger is deliberately module state (one CLI run = one process),
// so re-import the module for each test instead of exporting a test-only reset.
beforeEach(async () => {
  vi.resetModules();
  llm = await import('./llm.js');
});

const call = (inputTokens: number, outputTokens: number, usd?: string) => ({
  usage: { inputTokens, outputTokens },
  ...(usd === undefined ? {} : { providerMetadata: { gateway: { cost: usd } } }),
});

it('bills a single call once', () => {
  llm.record('explorer', call(100, 20, '0.0010'));

  expect(llm.ledger()).toEqual([
    { agent: 'explorer', calls: 1, inputTokens: 100, outputTokens: 20, usd: 0.001 },
  ]);
});

it('bills a tool loop per step, ignoring the result-level last-step metadata', () => {
  llm.record('fixer', {
    ...call(999, 999, '0.0300'), // what the result reports: the last step only
    steps: [call(200, 50, '0.0100'), call(300, 60, '0.0200')],
  });

  expect(llm.ledger()).toEqual([
    { agent: 'fixer', calls: 2, inputTokens: 500, outputTokens: 110, usd: 0.03 },
  ]);
});

it('accumulates repeated calls by the same agent', () => {
  llm.record('fixer', call(10, 5, '0.0010'));
  llm.record('fixer', call(20, 5, '0.0020'));

  expect(llm.ledger()).toEqual([
    { agent: 'fixer', calls: 2, inputTokens: 30, outputTokens: 10, usd: 0.003 },
  ]);
});

it('treats a provider that reports no cost as free rather than NaN', () => {
  llm.record('reporter', call(10, 5));

  expect(llm.totalUsd()).toBe(0);
});

it('totals cost across agents', () => {
  llm.record('explorer', call(100, 20, '0.0110'));
  llm.record('auditor', call(200, 40, '0.0220'));

  expect(llm.totalUsd()).toBeCloseTo(0.033, 10);
});
