import type { StateSignal } from './types.js';

const SOURCE_PRIORITY: Record<StateSignal['source'], number> = {
  // A process can identify the program that owns a terminal, but cannot on its
  // own prove whether that program is working, idle, or blocked.
  process: 50,
  hook: 500,
  structured: 450,
  screen: 300,
  activity: 100,
};

export interface ArbiterOptions {
  now?: number;
  maxAgeMs?: number;
}

/** Select the strongest fresh status report without letting stale sources win. */
export function chooseStateSignal(signals: StateSignal[], options: ArbiterOptions = {}): StateSignal | undefined {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 5_000;
  const fresh = signals.filter((signal) => now - signal.observedAt <= maxAgeMs);
  if (fresh.length === 0) return undefined;

  const authoritative = fresh.filter((signal) => signal.authoritative);
  const candidates = authoritative.length > 0
    ? authoritative
    : fresh.some((signal) => signal.visibleBlocker)
      ? fresh.filter((signal) => signal.visibleBlocker)
      : fresh;

  return candidates.reduce((best, signal) => {
    const signalPriority = SOURCE_PRIORITY[signal.source];
    const bestPriority = SOURCE_PRIORITY[best.source];
    if (signalPriority !== bestPriority) return signalPriority > bestPriority ? signal : best;
    return signal.observedAt > best.observedAt ? signal : best;
  });
}
