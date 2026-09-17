export interface TerminalSize { cols: number; rows: number }

const sizes = new Map<string, TerminalSize>();
const listeners = new Map<string, Set<(size: TerminalSize) => void>>();

export function clearTerminalSize(sessionId: string): void {
  sizes.delete(sessionId);
  listeners.delete(sessionId);
}

export function getTerminalSize(sessionId: string): TerminalSize | undefined {
  return sizes.get(sessionId);
}

export function setTerminalSize(sessionId: string, size: TerminalSize): void {
  if (!Number.isInteger(size.cols) || !Number.isInteger(size.rows) || size.cols < 2 || size.rows < 1 || size.cols > 1000 || size.rows > 1000) return;
  sizes.set(sessionId, size);
  for (const listener of listeners.get(sessionId) ?? []) listener(size);
}

export function subscribeTerminalSize(sessionId: string, listener: (size: TerminalSize) => void): () => void {
  let group = listeners.get(sessionId);
  if (!group) listeners.set(sessionId, group = new Set());
  group.add(listener);
  const current = sizes.get(sessionId);
  if (current) listener(current);
  return () => {
    group.delete(listener);
    if (group.size === 0) listeners.delete(sessionId);
  };
}
