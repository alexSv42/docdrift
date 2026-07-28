import assert from 'node:assert/strict';
import { ledger, record, totalUsd } from './llm.js';

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });
const cost = (usd: string) => ({ gateway: { cost: usd } });

// A single call bills once.
record('scanner', { usage: usage(100, 20), providerMetadata: cost('0.0010') });

// A tool loop bills per step, not once from the result's own (last-step) metadata.
record('fixer', {
  usage: usage(999, 999),
  providerMetadata: cost('0.0300'),
  steps: [
    { usage: usage(200, 50), providerMetadata: cost('0.0100') },
    { usage: usage(300, 60), providerMetadata: cost('0.0200') },
  ],
});

// A provider that reports no cost must not produce NaN.
record('reporter', { usage: usage(10, 5) });

const rows = Object.fromEntries(ledger().map((r) => [r.agent, r]));
assert.deepEqual(rows['scanner'], {
  agent: 'scanner',
  calls: 1,
  inputTokens: 100,
  outputTokens: 20,
  usd: 0.001,
});
assert.deepEqual(rows['fixer'], {
  agent: 'fixer',
  calls: 2,
  inputTokens: 500,
  outputTokens: 110,
  usd: 0.03,
});
assert.equal(rows['reporter']?.usd, 0);
assert.equal(totalUsd().toFixed(4), '0.0310');

console.log('cost ledger ok');
