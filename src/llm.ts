import { gateway } from '@ai-sdk/gateway';
import type { LanguageModel, ProviderMetadata } from 'ai';

/** One model for every agent by default; override per run with `--model`. */
export const DEFAULT_MODEL = 'google/gemini-2.5-flash';

export const model = (id: string): LanguageModel => gateway(id);

/** The part of an AI SDK result the ledger reads — nothing more, so it is cheap to fake in tests. */
export interface Billable {
  usage: { inputTokens?: number; outputTokens?: number };
  providerMetadata?: ProviderMetadata;
}

export interface LedgerRow {
  agent: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

// ponytail: module-level ledger. One CLI run = one process, so a singleton is honest here.
const rows = new Map<string, LedgerRow>();

/**
 * Fold an agent's LLM usage into the run ledger.
 *
 * Cost comes from AI Gateway's own `providerMetadata.gateway.cost` rather than a local
 * price table, so it stays correct when providers change their prices.
 */
export function record(agent: string, result: Billable & { steps?: readonly Billable[] }): void {
  const row = rows.get(agent) ?? { agent, calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
  // A tool loop bills per step; `providerMetadata` on the result only covers the last one.
  for (const step of result.steps?.length ? result.steps : [result]) {
    row.calls += 1;
    row.inputTokens += step.usage.inputTokens ?? 0;
    row.outputTokens += step.usage.outputTokens ?? 0;
    row.usd += Number(step.providerMetadata?.['gateway']?.['cost'] ?? 0);
  }
  rows.set(agent, row);
}

export const ledger = (): LedgerRow[] => [...rows.values()];

export const totalUsd = (): number => ledger().reduce((sum, r) => sum + r.usd, 0);
