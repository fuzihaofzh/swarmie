/** Ignore the decorative particle overlay in Codex's composer, not OSC titles. */
export function normalizeCodexScreen(text: string): string {
  return text.split('\n').flatMap((line) => {
    const plain = line.replace(/[\u2800-\u28ff]/g, ' ');
    return plain !== line && plain.trim() === '' ? [] : [plain];
  }).join('\n');
}
