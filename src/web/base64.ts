// Shared base64 helpers. PTY output arrives base64-encoded; `atob()` yields a
// Latin-1 string, so we must copy charCodes into a Uint8Array before handing
// bytes to xterm — otherwise UTF-8 sequences get mangled. Kept in one place so
// the terminal WS hook and TerminalView don't drift apart.

/** Decode one base64 chunk to its raw bytes. */
export function decodeBase64Chunk(b64Data: string): Uint8Array {
  const binary = atob(b64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Decode and concatenate multiple base64 chunks into a single byte buffer. */
export function decodeBase64Chunks(chunks: string[]): Uint8Array {
  if (chunks.length === 1) return decodeBase64Chunk(chunks[0]);

  const parts: Uint8Array[] = [];
  let totalLen = 0;
  for (const chunk of chunks) {
    const bytes = decodeBase64Chunk(chunk);
    parts.push(bytes);
    totalLen += bytes.length;
  }

  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

/** Merge multiple base64 chunks back into a single base64 string. */
export function mergeBase64Chunks(chunks: string[]): string {
  if (chunks.length === 1) return chunks[0];

  const merged = decodeBase64Chunks(chunks);
  const stringParts: string[] = [];
  const stringChunkSize = 0x8000;
  for (let i = 0; i < merged.length; i += stringChunkSize) {
    stringParts.push(String.fromCharCode(...merged.subarray(i, i + stringChunkSize)));
  }
  return btoa(stringParts.join(''));
}

/** Approximate decoded byte size of a base64 string without decoding it. */
export function estimateBase64Bytes(b64Data: string): number {
  return Math.ceil((b64Data.length * 3) / 4);
}
