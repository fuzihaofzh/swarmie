/**
 * Pipeline profiler. Disabled unless SWARMIE_PROFILE is set to an output path.
 *
 * Records per-stage durations along the keystroke->echo path so we can see
 * where wall-clock actually goes on a high-latency link: server-side work vs
 * the 16ms coalescing window vs time blocked in ws.send vs pure network RTT.
 *
 * Every measurement is server-local, so no clock sync with the client is
 * needed: subtract the server-internal total from the client-observed RTT to
 * get the network component.
 */
import { appendFileSync } from 'node:fs';

const OUT = process.env.SWARMIE_PROFILE ?? '';
export const profiling = OUT.length > 0;

type Sample = { t: number; phase: string; us: number; n?: number; sid?: string };

let buf: Sample[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
const t0 = Date.now();

export const nowNs = (): bigint => process.hrtime.bigint();

/** Record a completed stage. `us` is microseconds; `n` is an optional size/count. */
export function mark(phase: string, startNs: bigint, n?: number, sid?: string): void {
  if (!profiling) return;
  const us = Number(process.hrtime.bigint() - startNs) / 1000;
  buf.push({ t: Date.now() - t0, phase, us, n, sid });
  if (buf.length >= 512) flush();
}

/** Record a value that is already a duration in ms (e.g. queue wait). */
export function markMs(phase: string, ms: number, n?: number, sid?: string): void {
  if (!profiling) return;
  buf.push({ t: Date.now() - t0, phase, us: ms * 1000, n, sid });
  if (buf.length >= 512) flush();
}

export function flush(): void {
  if (!profiling || buf.length === 0) return;
  const lines = buf.map((s) => JSON.stringify(s)).join('\n') + '\n';
  buf = [];
  try { appendFileSync(OUT, lines); } catch { /* best effort */ }
}

if (profiling) {
  flushTimer = setInterval(flush, 1000);
  flushTimer.unref?.();
  process.on('exit', flush);
  // eslint-disable-next-line no-console
  console.error(`[swarmie] profiling -> ${OUT}`);
}
