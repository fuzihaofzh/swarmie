/**
 * Direct channel for raw terminal output — bypasses Zustand to avoid O(n²) overhead.
 * useWebSocket writes here; TerminalView reads from here.
 *
 * Buffers data when no writer is registered yet (terminal still initializing),
 * then flushes the buffer as soon as a writer registers.
 */

type Writer = (b64Data: string) => void;

const MAX_BUFFERED_BYTES_PER_SESSION = 512 * 1024;

const writers = new Map<string, Writer>();
const buffers = new Map<string, { chunks: string[]; bytes: number }>();

function estimateBase64Bytes(b64Data: string): number {
  return Math.ceil((b64Data.length * 3) / 4);
}

function appendBufferedChunk(sessionId: string, b64Data: string): void {
  let buffer = buffers.get(sessionId);
  if (!buffer) {
    buffer = { chunks: [], bytes: 0 };
    buffers.set(sessionId, buffer);
  }

  buffer.chunks.push(b64Data);
  buffer.bytes += estimateBase64Bytes(b64Data);

  while (buffer.bytes > MAX_BUFFERED_BYTES_PER_SESSION && buffer.chunks.length > 1) {
    const removed = buffer.chunks.shift();
    if (!removed) break;
    buffer.bytes -= estimateBase64Bytes(removed);
  }
}

export function registerTerminalWriter(sessionId: string, writer: Writer): void {
  writers.set(sessionId, writer);

  // Flush any buffered data that arrived before the writer was ready
  const buffer = buffers.get(sessionId);
  if (buffer && buffer.chunks.length > 0) {
    for (const b64 of buffer.chunks) {
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

  // No writer yet — buffer bounded recent output for remounts.
  appendBufferedChunk(sessionId, b64Data);
  return false;
}

/** Clean up buffer when a session is removed */
export function clearTerminalBuffer(sessionId: string): void {
  buffers.delete(sessionId);
  writers.delete(sessionId);
}
