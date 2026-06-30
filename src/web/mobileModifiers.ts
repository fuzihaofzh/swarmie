import { create } from 'zustand';

// Shared armed-modifier state + key resolution for the mobile soft keyboard.
//
// The on-screen `Ctrl`/`Alt` buttons live in `MobileToolbar`, but the keys they
// modify are typed on the device's soft keyboard, whose input flows through a
// *separate* path in `TerminalView` (`input`/`compositionend` events). Without a
// shared bridge the two never meet: tapping `Ctrl` then `c` would send a literal
// "c" instead of `\x03`. This store is that bridge — the toolbar writes it, the
// soft-keyboard handler reads + clears it — and `resolveKeyWithMods` is the one
// place that turns a key + armed modifier into bytes, so both paths agree.
interface MobileModifierState {
  ctrl: boolean;
  alt: boolean;
  setCtrl: (v: boolean | ((prev: boolean) => boolean)) => void;
  setAlt: (v: boolean | ((prev: boolean) => boolean)) => void;
  clear: () => void;
}

export const useMobileModifiers = create<MobileModifierState>((set) => ({
  ctrl: false,
  alt: false,
  setCtrl: (v) => set((s) => ({ ctrl: typeof v === 'function' ? v(s.ctrl) : v })),
  setAlt: (v) => set((s) => ({ alt: typeof v === 'function' ? v(s.alt) : v })),
  clear: () => set({ ctrl: false, alt: false }),
}));

// Base (no-modifier) byte sequences for named keys.
export const KEY_MAP: Record<string, string> = {
  Escape: '\x1b',
  Tab: '\t',
  Backspace: '\x7f',
  Enter: '\r',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
};

// Ctrl-modified sequences for named keys (where they differ from a plain
// control-code derivation — e.g. CSI arrows carry the ;5 modifier param).
export const CTRL_KEY_MAP: Record<string, string> = {
  Escape: '\x1b',
  Tab: '\t',
  Backspace: '\x08',
  Enter: '\r',
  ArrowUp: '\x1b[1;5A',
  ArrowDown: '\x1b[1;5B',
  ArrowRight: '\x1b[1;5C',
  ArrowLeft: '\x1b[1;5D',
};

// Alt-modified sequences for named keys.
export const ALT_KEY_MAP: Record<string, string> = {
  ArrowUp: '\x1b[1;3A',
  ArrowDown: '\x1b[1;3B',
  ArrowRight: '\x1b[1;3C',
  ArrowLeft: '\x1b[1;3D',
};

// Turn a key — either a named key ('Enter', 'ArrowUp', …) or a single typed
// character — plus the armed Ctrl/Alt state into the bytes to send. This is the
// single source of truth shared by the toolbar buttons and the soft keyboard so
// every chord (Ctrl+C, Ctrl+Backspace, Alt+B, …) resolves the same way.
export function resolveKeyWithMods(key: string, ctrl: boolean, alt: boolean): string {
  if (!key) return '';

  if (ctrl) {
    if (CTRL_KEY_MAP[key]) return CTRL_KEY_MAP[key];
    if (key.length === 1) {
      // Standard control-code derivation: Ctrl+A..Z / @[\]^_ → 0x00..0x1f.
      const code = key.toUpperCase().charCodeAt(0) - 64;
      if (code >= 0 && code <= 31) return String.fromCharCode(code);
      return key; // not chord-able (e.g. "/", a digit) → send literal
    }
    return KEY_MAP[key] || '';
  }

  if (alt) {
    if (ALT_KEY_MAP[key]) return ALT_KEY_MAP[key];
    if (key.length === 1) return '\x1b' + key; // Alt+x → ESC x
    return KEY_MAP[key] || '';
  }

  return KEY_MAP[key] || '';
}
