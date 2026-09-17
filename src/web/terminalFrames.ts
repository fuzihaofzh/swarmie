const BEGIN = '\x1b[?2026h';
const END = '\x1b[?2026l';
const MAX_FRAME_BYTES = 1024 * 1024;

/** Keep synchronized redraws together for xterm versions without mode 2026.
 * The caller must flush an unfinished frame after a timeout, and reset on
 * stream discontinuities. Control bytes are preserved exactly.
 */
export class TerminalFrameBuffer {
  private pending = '';

  get hasPending(): boolean { return this.pending.length > 0; }

  write(binary: string): string {
    const source = this.pending + binary;
    let open = -1;
    for (const match of source.matchAll(/\x1b\[\?2026[hl]/g)) {
      if (match[0] === BEGIN) {
        if (open < 0) open = match.index;
      } else {
        open = -1;
      }
    }
    let end = open < 0 ? source.length : open;
    if (open < 0) {
      // A PTY chunk can end in the middle of the opening marker itself.
      for (let length = Math.min(BEGIN.length - 1, source.length); length > 0; length--) {
        const suffix = source.slice(-length);
        if (BEGIN.startsWith(suffix) || END.startsWith(suffix)) {
          end -= length;
          break;
        }
      }
    }
    this.pending = source.slice(end);
    if (this.pending.length > MAX_FRAME_BYTES) {
      this.pending = '';
      return source;
    }
    return source.slice(0, end);
  }

  flush(): string {
    const pending = this.pending;
    this.pending = '';
    return pending;
  }

  reset(): void { this.pending = ''; }
}
