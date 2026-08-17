import { BaseAdapter, type AdapterOptions } from './base.js';
import type { AdapterInfo, NormalizedEvent, RawOutputData, SessionStatus, ToolDetectData } from './types.js';

/**
 * A virtual adapter that represents a session from a remote swarmie instance.
 * Events are pushed in via `pushEvent()` rather than spawning a process.
 *
 * Status policy: the local headless screen is authoritative for whether a
 * prompt is currently visible (it runs on the forwarded raw output, same as
 * any local adapter). The remote also forwards its own status:change events,
 * but its "running" detection can be busy-output spam (e.g. sub-agents
 * streaming during a prompt) and would mask a visible prompt. We only drop
 * remote "running" while local detection still sees a prompt; otherwise we
 * apply it so the dashboard does not leave active remote tabs stuck gray.
 */
export class RemoteAdapter extends BaseAdapter {
  private _info: AdapterInfo;
  private _isRunning = true;

  constructor(
    options: AdapterOptions,
    info: AdapterInfo,
  ) {
    super(options);
    this._info = info;
  }

  get info(): AdapterInfo {
    return this._info;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  start(): void {
    this.setStatus('running');
  }

  /** Push an event from the IPC server into this adapter */
  pushEvent(event: NormalizedEvent): void {
    if (event.type === 'session:end') {
      this._isRunning = false;
    }
    if (event.type === 'raw:output') {
      try {
        const data = (event.data as RawOutputData).data;
        this.handleActivityDetection(Buffer.from(data, 'base64').toString('utf8'));
      } catch {
        // Ignore malformed remote output; still forward the original event.
      }
    }
    if (event.type === 'status:change') {
      const data = event.data as { to: string };
      const nextStatus = data.to as SessionStatus;
      // Remote "running" can be noisy while a prompt is still visible. Drop
      // only in that case; otherwise let the dashboard show that the agent is
      // actively working instead of leaving the tab stuck in idle gray.
      if (nextStatus === 'running' && (this._status === 'waiting_input' || this.getScreenSnapshot().promptVisible)) {
        return;
      }
      // For other statuses, apply locally without re-emitting (we synthesize
      // status:change ourselves when _status actually changes), then forward
      // the original event so upstream consumers see the transition.
      this.applyExternalStatus(nextStatus);
    }
    if (event.type === 'tool:detect') {
      const data = event.data as ToolDetectData;
      this._info = {
        ...this._info,
        name: data.tool,
        displayName: data.displayName,
      };
    }
    if (event.type === 'session:end') {
      this.disposeScreen();
    }
    this.emit('event', event);
  }

  /** Set by coordinator to forward input via IPC */
  onWrite?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onKill?: (signal?: string) => void;

  write(data: string): void {
    this.handleUserInput(data);
    this.onWrite?.(data);
  }

  /** Forward keys to the remote PTY without running the local input state
   *  machine — the remote's own detection drives status. */
  forwardKeys(data: string): void {
    this.onWrite?.(data);
  }

  protected applyResize(cols: number, rows: number): void {
    this.onResize?.(cols, rows);
  }

  protected shouldEmitDetectionEvents(): boolean {
    return false;
  }

  kill(signal?: string): void {
    this.onKill?.(signal);
  }
}

/**
 * Resolve a session's adapter to a RemoteAdapter, or null if the session is
 * missing or backed by a local adapter. Typed structurally so this helper
 * doesn't pull SessionManager into the adapter layer.
 */
export function getRemoteAdapter(
  manager: { getSession(id: string): { adapter: BaseAdapter } | undefined },
  sessionId: string,
): RemoteAdapter | null {
  const adapter = manager.getSession(sessionId)?.adapter;
  return adapter instanceof RemoteAdapter ? adapter : null;
}
