/**
 * Direct channel for raw terminal output — bypasses Zustand to avoid O(n²) overhead.
 * useWebSocket writes here; TerminalView reads from here.
 *
 * Buffers data when no writer is registered yet (terminal still initializing),
 * then flushes the buffer as soon as a writer registers.
 */

type Writer = (b64Data: string) => void;

const writers = new Map<string, Writer>();
const buffers = new Map<string, string[]>();

export function registerTerminalWriter(sessionId: string, writer: Writer): void {
  writers.set(sessionId, writer);

  // Flush any buffered data that arrived before the writer was ready
  const buf = buffers.get(sessionId);
  if (buf && buf.length > 0) {
    for (const b64 of buf) {
      writer(b64);
    }
    buffers.delete(sessionId);
  }
}

export function unregisterTerminalWriter(sessionId: string): void {
  writers.delete(sessionId);
  // Keep the buffer — if the terminal re-mounts it will get the data back
}

/** Returns true if a writer was found and data was delivered */
export function writeToTerminal(sessionId: string, b64Data: string): boolean {
  const writer = writers.get(sessionId);
  if (writer) {
    writer(b64Data);
    return true;
  }

  // No writer yet — buffer the data
  let buf = buffers.get(sessionId);
  if (!buf) {
    buf = [];
    buffers.set(sessionId, buf);
  }
  buf.push(b64Data);
  return false;
}

/** Clean up buffer when a session is removed */
export function clearTerminalBuffer(sessionId: string): void {
  buffers.delete(sessionId);
  writers.delete(sessionId);
}
