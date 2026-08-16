import type { AgentDetectionResult, AgentLifecycleState } from './types.js';

export interface StabilizerOptions {
  startupGraceMs?: number;
  idleConfirmations?: number;
  idleMaxHoldMs?: number;
}

export interface StabilizedState {
  state: AgentLifecycleState;
  decision: 'accepted' | 'held' | 'skipped';
  reason?: string;
}

const DEFAULT_STARTUP_GRACE_MS = 3_000;
const DEFAULT_IDLE_CONFIRMATIONS = 3;
const DEFAULT_IDLE_MAX_HOLD_MS = 700;

/**
 * Smooth short-lived screen states without hiding explicit UI evidence.
 * Visible idle/working/blocking states apply immediately. Only weak idle and
 * unknown frames are held, because those commonly occur during redraws.
 */
export class DetectionStabilizer {
  private readonly startedAt: number;
  private readonly startupGraceMs: number;
  private readonly idleConfirmations: number;
  private readonly idleMaxHoldMs: number;
  private stableState: AgentLifecycleState = 'unknown';
  private pendingIdleSince: number | null = null;
  private pendingIdleCount = 0;

  constructor(startedAt = Date.now(), options: StabilizerOptions = {}) {
    this.startedAt = startedAt;
    this.startupGraceMs = options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
    this.idleConfirmations = options.idleConfirmations ?? DEFAULT_IDLE_CONFIRMATIONS;
    this.idleMaxHoldMs = options.idleMaxHoldMs ?? DEFAULT_IDLE_MAX_HOLD_MS;
  }

  observe(result: AgentDetectionResult, now = result.observedAt): StabilizedState {
    if (result.skipStateUpdate) {
      return { state: this.stableState, decision: 'skipped', reason: 'rule_preserves_previous_state' };
    }

    if (result.state === 'unknown') {
      this.clearPendingIdle();
      this.stableState = 'unknown';
      return { state: 'unknown', decision: 'accepted' };
    }

    const hasVisibleEvidence = result.visibleIdle || result.visibleWorking || result.visibleBlocker;
    if (result.state === 'idle' && !hasVisibleEvidence && now - this.startedAt < this.startupGraceMs) {
      return { state: this.stableState, decision: 'held', reason: 'startup_grace' };
    }

    if (result.state === 'idle' && this.stableState === 'working' && !result.visibleIdle) {
      if (this.pendingIdleSince == null) {
        this.pendingIdleSince = now;
        this.pendingIdleCount = 1;
      } else {
        this.pendingIdleCount++;
      }
      const heldFor = now - this.pendingIdleSince;
      if (this.pendingIdleCount < this.idleConfirmations && heldFor < this.idleMaxHoldMs) {
        return { state: this.stableState, decision: 'held', reason: 'working_to_idle_confirmation' };
      }
    }

    this.clearPendingIdle();
    this.stableState = result.state;
    return { state: this.stableState, decision: 'accepted' };
  }

  reset(state: AgentLifecycleState = 'unknown'): void {
    this.stableState = state;
    this.clearPendingIdle();
  }

  get state(): AgentLifecycleState {
    return this.stableState;
  }

  private clearPendingIdle(): void {
    this.pendingIdleSince = null;
    this.pendingIdleCount = 0;
  }
}
