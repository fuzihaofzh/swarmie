import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';
import { useUIStore } from '../hooks/useUI';
import { detectMath, renderMath, cellWidthOf, type MathItem } from '../latex';
import { themes } from '../themes';
import {
  registerTerminalWriter,
  unregisterTerminalWriter,
  getSessionMeta,
  subscribeSessionMeta,
  subscribeHistorySnapshot,
  markReachedEarliest,
  getRawCacheStart,
  getRawCacheEnd,
  getRawCacheChunks,
  prependRawCache,
  isRawCacheFull,
  type SessionMeta,
} from '../terminalBus';
import { MobileToolbar } from './MobileToolbar';
import { resolveKeyWithMods, useMobileModifiers } from '../mobileModifiers';
import { useKeybindingStore, matchesBinding } from '../hooks/useKeybindings';
import {
  shouldAutoFocusTerminal,
  shouldRestoreTerminalFocusAfterSearchClose,
  shouldShowMobileToolbar,
} from '../focusPolicy';
import { binaryStringToBytes } from '../base64';
import { protectStatusLineRedraws, stripDeviceQueries, stripAlternateScreen } from '../terminalQueries';
import type { ClipboardImagePaste } from '../hooks/useTerminalWebSocket';

interface TerminalViewProps {
  sessionId: string;
  isActive?: boolean;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onRedraw?: () => void;
  onLoadHistory?: (fromOffset: number, toOffset?: number) => boolean | void;
  onClipboardImagePaste?: (image: ClipboardImagePaste) => boolean | void;
}

// Per-frame term.write budget. Starts here and self-tunes between MIN and MAX
// based on the measured write duration (see the flush callback): term.write is
// atomic, so if a single write blocks the main thread past a frame it starves
// keyboard input — under heavy output the symptom is "typing does nothing". We
// shrink the batch when writes run long (slow Canvas/DOM fallback) so each frame
// yields to input, and grow it when writes are cheap (WebGL) to keep throughput.
const MAX_TERMINAL_WRITE_BYTES_PER_FRAME = 32 * 1024;
const MIN_TERMINAL_WRITE_BYTES_PER_FRAME = 4 * 1024;
// Hard cap on the unwritten write queue. When a tab is backgrounded the flush
// rAF pauses while the WS keeps pushing, so pendingChunks can balloon to
// hundreds of MB; on return each term.write blocks the main thread for seconds
// and the tab never catches up (full freeze). Capped at the server's 16MB raw
// ring — that is the most history a fresh replay could ever produce anyway, so
// dropping older queued bytes loses nothing the backend can still show.
const MAX_PENDING_WRITE_BYTES = 2 * 1024 * 1024;
// How many lines of local scrollback each terminal retains. The server owns the
// deep history (16MB raw ring), but the client cap is what actually decides how
// far back the user can scroll WITHOUT a round-trip — and, because every history
// render keeps only the last N lines, it's also the ceiling on what "Load
// earlier" can ever show (past N, older lines are discarded on render anyway).
// 10k was too low: a busy codex/Claude Code session blew past it and the earlier
// output became unreachable. Raised to 100k so the client holds essentially the
// whole server ring for these apps — most of their bytes are in-place redraws
// (statusline/spinner) that update existing rows rather than pushing new
// scrollback, so 100k lines comfortably covers 16MB of such output. Trade-off
// (accepted): a terminal actively scrolled through a huge session uses more
// memory and its history re-renders cost more. Hidden tabs are unsubscribed and
// stay small, so this only grows for the terminal you're actually reading.
const TERMINAL_SCROLLBACK_LINES = 100000;
// Tall inline math is shrunk to fit within this fraction of one row, so it never
// overlaps the lines above/below (user preference: no-overlap over size). Tall
// formulas (sqrt/fraction) end up smaller as a result. Display blocks ($$…$$)
// are never shrunk.
const MAX_INLINE_MATH_LINES = 0.95;
// How many bytes earlier to fetch each time the user asks for more history.
// Kept modest (not multi-MB) on purpose: the server's history:snapshot spans
// [fromOffset, current-end], so the client term.reset()s and re-renders the
// whole window on the main thread each load. A 2MB window made "scroll up a
// bit" stall for seconds (and risk the retry timeout, which re-requests another
// full snapshot and compounds). A smaller window loads near-instantly and the
// user can keep scrolling to pull more, infinite-scroll style.
const HISTORY_CHUNK_BYTES = 512 * 1024;
// How long to wait for a history:snapshot before re-sending the request. The
// reply can be lost (e.g. it raced a WS reconnect, or the socket was briefly
// not OPEN when we sent) — without a resend the load would just spin until the
// give-up timeout and then discard any late snapshot. Locally a snapshot is
// near-instant, so a missing reply after this long means it isn't coming.
const HISTORY_LOAD_RETRY_MS = 6_000;
// Re-send up to this many times before giving up. The final give-up flushes the
// live output captured during the load to the terminal — so a snapshot that
// never arrives can't lose the latest history or strand the viewport mid-buffer.
const HISTORY_LOAD_MAX_ATTEMPTS = 4;
/** Auto-trigger only fires if the user wheel/touch-swiped up within this window. */
const AUTO_LOAD_RECENT_WINDOW_MS = 600;
const MAX_CLIPBOARD_IMAGE_BYTES = 16 * 1024 * 1024;

function clipboardImageFromPaste(event: ClipboardEvent): File | null {
  const items = event.clipboardData?.items;
  if (!items) return null;
  for (const item of items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    return item.getAsFile();
  }
  return null;
}

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read clipboard image'));
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const comma = dataUrl.indexOf(',');
      if (comma < 0) {
        reject(new Error('Invalid clipboard image data'));
        return;
      }
      resolve(dataUrl.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

// Chunks here are raw latin1 binary strings (the WS layer already decoded any
// base64), so concatenation is all that's needed before the width-protection
// pass and the final bytes handed to xterm.
function decodeTerminalBytes(chunks: string[], term: Terminal): Uint8Array {
  const binary = chunks.length === 1 ? chunks[0] : chunks.join('');
  // When enabled (default on), strip alternate-screen switches so full-screen
  // apps (tmux/vim/less) render into the normal buffer and their scrolled-off
  // lines land in xterm's scrollback — the wheel then scrolls history instead of
  // xterm faking arrow keys (which cycles the shell's command history in tmux).
  // Applied here so EVERY write path — live flush, captured-during-load replay,
  // and history rebuild — is covered by the single choke point.
  const source = useUIStore.getState().keepAltScreenInScrollback
    ? stripAlternateScreen(binary)
    : binary;
  return binaryStringToBytes(protectStatusLineRedraws(source, term.cols, term.rows));
}

// Dev inspector for client-side freezes: run `__swarmieTerm()` in the browser
// console to dump each mounted terminal's xterm buffer size. The server debug
// endpoint can't see browser state, so this is how we check whether a giant
// client scrollback is the culprit.
const mountedTerms = new Map<string, Terminal>();
if (typeof window !== 'undefined') {
  (window as unknown as { __swarmieTerm?: () => unknown }).__swarmieTerm = () =>
    [...mountedTerms.entries()].map(([id, t]) => ({
      session: id,
      bufferLines: t.buffer.active.length,
      viewportY: t.buffer.active.viewportY,
      baseY: t.buffer.active.baseY,
      cols: t.cols,
      rows: t.rows,
    }));
}

export function TerminalView({
  sessionId,
  isActive,
  onInput,
  onResize,
  onRedraw,
  onLoadHistory,
  onClipboardImagePaste,
}: TerminalViewProps) {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  // GPU/canvas renderer addon for the ACTIVE terminal only (see effect below).
  const rendererRef = useRef<{ dispose(): void } | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const initStartedRef = useRef(false);
  const [termReady, setTermReady] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const isActiveRef = useRef(isActive);
  const activatedOnceRef = useRef(false);
  const reactivateRedrawRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevSearchOpenRef = useRef(searchOpen);
  const lastReportedSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  // KaTeX overlay layer (a div over .xterm-screen) + the math elements in it,
  // keyed by `${absLine}:${col}:${mode}:${rows}:${tex}`. Each entry keeps its
  // absolute buffer rows so it can be repositioned every frame as the buffer
  // scrolls, without re-running detection.
  const mathLayerRef = useRef<HTMLDivElement | null>(null);
  const mathOverlaysRef = useRef<Map<string, { el: HTMLDivElement; startAbs: number; endAbs: number }>>(new Map());

  const themeName = useUIStore((s) => s.theme);
  const fontSize = useUIStore((s) => s.fontSize);
  const fontFamily = useUIStore((s) => s.fontFamily);
  const mathRender = useUIStore((s) => s.mathRender);
  const currentTheme = themes[themeName] ?? themes['github-dark'];

  // History-load state. `historyLoading` drives the UI overlay + input lock.
  // The refs are used by the writer + auto-trigger paths where reading React
  // state would race with the render cycle.
  const [sessionMeta, setSessionMeta] = useState<SessionMeta>(() => getSessionMeta(sessionId));
  const [historyLoading, setHistoryLoading] = useState(false);
  /** xterm viewport is scrolled to the very top with scrollback available.
   *  Used to gate the "Load earlier" button so it only appears as an
   *  affordance once the user has actually scrolled all the way up. */
  const [atTop, setAtTop] = useState(false);
  const historyLoadingRef = useRef(false);
  const historyLoadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyLoadAttemptsRef = useRef(0);
  const armHistoryLoadRef = useRef<((fromOffset: number) => void) | null>(null);
  const capturedDuringLoadRef = useRef<Array<{ bin: string; offsetEnd?: number }>>([]);
  const capturedDuringLoadBytesRef = useRef(0);
  const pendingChunksRef = useRef<string[]>([]);
  // Self-tuning per-frame write budget (see flush callback). Persists across the
  // writer effect's re-runs so the tuned value survives tab switches.
  const frameBudgetRef = useRef(MAX_TERMINAL_WRITE_BYTES_PER_FRAME);
  const scheduleFlushRef = useRef<(() => void) | null>(null);
  const cancelScheduledFlushRef = useRef<(() => void) | null>(null);
  const scrolledUpAtRef = useRef(0);
  const handleLoadEarlierRef = useRef<(() => void) | null>(null);
  // Writes the live output parked during a history load straight to the
  // terminal and ends the loading state without a reset/anchor. Set inside the
  // writer effect (which owns `term`); called by the load timeout so a snapshot
  // that never arrives can't drop the captured tail.
  const flushCapturedDuringLoadRef = useRef<(() => void) | null>(null);

  // Refs for latest values (used in callback ref closure)
  const themeRef = useRef(currentTheme);
  const fontSizeRef = useRef(fontSize);
  const fontFamilyRef = useRef(fontFamily);

  const reportResize = useCallback((term: Terminal) => {
    const previous = lastReportedSizeRef.current;
    if (previous?.cols === term.cols && previous.rows === term.rows) return;
    lastReportedSizeRef.current = { cols: term.cols, rows: term.rows };
    onResize?.(term.cols, term.rows);
  }, [onResize]);

  // Latest reportResize via ref so the active-tab effect doesn't re-run every
  // parent render (parent passes an inline `onResize` arrow → new identity each
  // render → effect would refit/scrollToBottom on every render, dragging the
  // viewport away from scrolled-up users).
  const reportResizeRef = useRef(reportResize);

  useEffect(() => {
    themeRef.current = currentTheme;
    fontSizeRef.current = fontSize;
    fontFamilyRef.current = fontFamily;
    isActiveRef.current = isActive;
    reportResizeRef.current = reportResize;
  });

  const containerCallbackRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
  }, []);

  // Lazy-initialize xterm only when this panel becomes active for the first
  // time. Mounting all panels at page load was making mobile blank for many
  // seconds while every terminal init'd + replayed its 512KB ring buffer.
  useEffect(() => {
    if (!isActive) return;
    if (initStartedRef.current) return;
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;
    let rafId = 0;

    const init = () => {
      if (cancelled) return;
      if (el.clientWidth === 0 || el.clientHeight === 0) {
        rafId = requestAnimationFrame(init);
        return;
      }

      // Commit point: a real size exists and xterm is about to be created. Mark
      // init as started only here so that if the panel is deactivated/unmounted
      // before it ever gets a size, a later reactivation can retry instead of
      // being blocked forever by the guard above.
      initStartedRef.current = true;

      const t = themeRef.current;
      const term = new Terminal({
        cursorBlink: true,
        fontSize: fontSizeRef.current,
        fontFamily: fontFamilyRef.current,
        theme: t.terminal,
        allowProposedApi: true,
        customGlyphs: true,
        rescaleOverlappingGlyphs: true,
        macOptionIsMeta: false,
        scrollOnOutput: false,
        scrollback: TERMINAL_SCROLLBACK_LINES,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(el);

      const searchAddon = new SearchAddon();
      term.loadAddon(searchAddon);
      searchRef.current = searchAddon;

      // Match iTerm's default (Advanced pref `AlternateMouseScroll` = NO). In the
      // alternate-screen buffer (which tmux/vim/less use) xterm's built-in wheel
      // handling converts the mouse wheel into cursor-key presses — a convenience
      // for pagers, but inside tmux those ↑/↓ land in the shell and cycle its
      // command history, which is not what a scroll should do. Returning false
      // here cancels that conversion so a wheel scroll no longer fakes arrows.
      // Guard on mouseTrackingMode: when the app IS reporting mouse (e.g. tmux
      // with `set -g mouse on`) we return true so xterm forwards the wheel as a
      // mouse event and tmux copy-mode scrolling keeps working. In the normal
      // buffer we always return true so ordinary scrollback scrolling is intact.
      term.attachCustomWheelEventHandler((_ev) => {
        if (term.buffer.active.type === 'alternate' && term.modes.mouseTrackingMode === 'none') {
          return false;
        }
        return true;
      });

      term.attachCustomKeyEventHandler((e) => {
        // During history rebuild we lock input — swallow keys so they don't
        // race the snapshot apply.
        if (historyLoadingRef.current) return false;

        const { getBinding } = useKeybindingStore.getState();
        const newLineBinding = getBinding('new-line');
        const searchBinding = getBinding('search');
        const tabSwitchBinding = getBinding('tab-switcher');
        const tabSwitchPrevBinding = getBinding('tab-switcher-prev');

        if (matchesBinding(e, newLineBinding)) {
          if (e.type === 'keydown') {
            e.preventDefault();
            e.stopPropagation();
            onInput?.('\\');
            setTimeout(() => onInput?.('\r'), 30);
          }
          return false;
        }
        if (matchesBinding(e, tabSwitchBinding) || matchesBinding(e, tabSwitchPrevBinding)) {
          return false;
        }
        if (e.altKey && !e.ctrlKey && !e.metaKey) {
          const arrowSeq: Record<string, string> = {
            ArrowLeft: '\x1b[1;3D',
            ArrowRight: '\x1b[1;3C',
            ArrowUp: '\x1b[1;3A',
            ArrowDown: '\x1b[1;3B',
          };
          const seq = arrowSeq[e.key];
          if (seq) {
            if (e.type === 'keydown') onInput?.(seq);
            return false;
          }
          if (e.type === 'keydown' && e.code.length > 0) {
            const match = e.code.match(/^Key([A-Z])$/);
            if (match) {
              const ch = e.shiftKey ? match[1] : match[1].toLowerCase();
              onInput?.(`\x1b${ch}`);
              return false;
            }
            const digit = e.code.match(/^Digit([0-9])$/);
            if (digit) {
              onInput?.(`\x1b${digit[1]}`);
              return false;
            }
          }
        }
        if (matchesBinding(e, searchBinding)) {
          if (e.type === 'keydown') {
            e.preventDefault();
            setSearchOpen(true);
          }
          return false;
        }
        return true;
      });

      if (onInput) {
        term.onData((data) => {
          // Keep typing live during a history load. The echo comes back as raw
          // output that writer() parks in capturedDuringLoadRef, and it always
          // carries offsetEnd > snapshot.endOffset (the snapshot's end was
          // sampled before the keystroke), so afterSnapshot replays it. Dropping
          // input here instead silently ate keystrokes for the whole load.
          onInput(data);
        });
      }

      // --- Mobile soft-keyboard / IME input takeover ---------------------
      // xterm's textarea input path is unreliable on phones. It never clears
      // the helper textarea, so `_handleAnyTextareaChanges` diffs an
      // ever-growing value (`newValue.replace(oldValue, '')`) and words come
      // out garbled; and predictive/composition keyboards only flush on commit,
      // so plain typing appears to "do nothing" until Enter. On mobile we make
      // the `input`/`compositionend` events the single source of truth and keep
      // the textarea empty. These capture-phase listeners sit on the container,
      // which is an ancestor of the helper textarea, so they fire before
      // xterm's own capture listeners and can stop it from double-processing.
      const mobileInput = onInput;
      if (mobileInput && shouldShowMobileToolbar(getFocusPolicyEnv())) {
        const textarea = el.querySelector<HTMLTextAreaElement>('textarea.xterm-helper-textarea');
        if (textarea) {
          textarea.setAttribute('autocomplete', 'off');
          textarea.setAttribute('autocorrect', 'off');
          textarea.setAttribute('autocapitalize', 'none');
          textarea.setAttribute('spellcheck', 'false');

          const isTextarea = (e: Event) => e.target === textarea;

          // Swallow xterm's keypress so it never sends printable characters
          // (we send them from the `input` event instead). Real control keys —
          // Enter, Backspace, arrows, Ctrl-* — arrive via keydown, which xterm
          // still handles and cancels, so no `input` event follows for them.
          const onKeyPress = (e: Event) => {
            if (isTextarea(e)) e.stopImmediatePropagation();
          };
          // Block only the IME/composition keydown (keyCode 229), which would
          // otherwise drive xterm's fragile textarea-diff path.
          const onKeyDown = (e: KeyboardEvent) => {
            if (isTextarea(e) && (e.isComposing || e.keyCode === 229)) {
              e.stopImmediatePropagation();
            }
          };
          const swallow = (e: Event) => {
            if (isTextarea(e)) e.stopImmediatePropagation();
          };
          // Send a soft-keyboard key, applying any Ctrl/Alt modifier armed from
          // the mobile toolbar (tap Ctrl, then type "c" → \x03; Ctrl+Backspace →
          // \x08; …). The toolbar buttons and the soft keyboard share that
          // modifier via the store and resolve it the same way, so we consume +
          // clear it here. `key` is a named key ('Enter', 'Backspace') or a
          // single typed character; `raw` is the unmodified fallback.
          const sendKey = (key: string, raw: string) => {
            const { ctrl, alt, clear } = useMobileModifiers.getState();
            if (!ctrl && !alt) {
              mobileInput(raw);
              return;
            }
            // A chord is only meaningful for a single key/character; multi-char
            // commits (pastes, IME words) ignore the modifier and pass through.
            mobileInput([...key].length === 1 ? resolveKeyWithMods(key, ctrl, alt) || raw : raw);
            clear();
          };
          const onCompositionEnd = (e: CompositionEvent) => {
            if (!isTextarea(e)) return;
            e.stopImmediatePropagation();
            if (textarea.value) sendKey(textarea.value, textarea.value);
            textarea.value = '';
          };
          const onInputEvent = (e: Event) => {
            if (!isTextarea(e)) return;
            e.stopImmediatePropagation();
            const ie = e as InputEvent;
            // Intermediate composition states accumulate in the textarea and
            // are sent on compositionend; don't send them character-by-character.
            if (ie.isComposing || ie.inputType === 'insertCompositionText') return;
            if (ie.inputType === 'deleteContentBackward' || ie.inputType === 'deleteWordBackward') {
              sendKey('Backspace', '\x7f');
            } else if (ie.inputType === 'insertLineBreak' || ie.inputType === 'insertParagraph') {
              sendKey('Enter', '\r');
            } else if (ie.data) {
              sendKey(ie.data, ie.data);
            }
            textarea.value = '';
          };

          el.addEventListener('keypress', onKeyPress, true);
          el.addEventListener('keydown', onKeyDown, true);
          el.addEventListener('compositionstart', swallow, true);
          el.addEventListener('compositionupdate', swallow, true);
          el.addEventListener('compositionend', onCompositionEnd, true);
          el.addEventListener('input', onInputEvent, true);
        }
      }

      const ro = new ResizeObserver(() => {
        requestAnimationFrame(() => {
          if (!isActiveRef.current) return;
          if (!el.clientWidth || !el.clientHeight) return;
          try {
            // Preserve scroll position for users reading scrollback — only
            // snap to bottom on resize if they were already following live.
            const buf = term.buffer.active;
            const wasAtBottom = buf.viewportY >= buf.baseY;
            fitAddon.fit();
            reportResize(term);
            if (wasAtBottom) {
              term.scrollToBottom();
            }
          } catch { /* ignore */ }
        });
      });
      ro.observe(el);
      observerRef.current = ro;

      termRef.current = term;
      fitRef.current = fitAddon;
      mountedTerms.set(sessionId, term);

      // Fit first, THEN signal ready — ensures buffered data is replayed
      // at the correct terminal dimensions, not the default 80x24.
      requestAnimationFrame(() => {
        try { fitAddon.fit(); } catch { /* ignore */ }
        setTermReady((c) => c + 1);
      });
    };

    rafId = requestAnimationFrame(init);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, sessionId]);

  const handleClipboardImagePaste = useCallback(async (file: File) => {
    if (!onClipboardImagePaste) return;
    if (file.size > MAX_CLIPBOARD_IMAGE_BYTES) {
      // eslint-disable-next-line no-console
      console.warn(`[swarmie] clipboard image is too large: ${file.size} bytes`);
      return;
    }

    try {
      const data = await readFileBase64(file);
      onClipboardImagePaste({
        mimeType: file.type || 'image/png',
        filename: file.name || 'clipboard.png',
        data,
        size: file.size,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[swarmie] failed to read clipboard image', err);
    }
  }, [onClipboardImagePaste]);

  useEffect(() => {
    const term = termRef.current;
    const root = term?.element;
    if (!root || !onClipboardImagePaste) return;

    const onPaste = (event: ClipboardEvent) => {
      const file = clipboardImageFromPaste(event);
      if (!file) return;
      event.preventDefault();
      event.stopPropagation();
      void handleClipboardImagePaste(file);
    };

    root.addEventListener('paste', onPaste, true);
    return () => root.removeEventListener('paste', onPaste, true);
  }, [handleClipboardImagePaste, onClipboardImagePaste, termReady]);

  const getFocusPolicyEnv = useCallback(() => {
    return {
      userAgent: navigator.userAgent,
      viewportWidth: window.innerWidth,
      hasTouchStart: 'ontouchstart' in window,
      maxTouchPoints: navigator.maxTouchPoints,
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      if (historyLoadTimeoutRef.current) {
        clearTimeout(historyLoadTimeoutRef.current);
        historyLoadTimeoutRef.current = null;
      }
      if (reactivateRedrawRef.current) {
        clearTimeout(reactivateRedrawRef.current);
        reactivateRedrawRef.current = null;
      }
      historyLoadingRef.current = false;
      capturedDuringLoadRef.current = [];
      capturedDuringLoadBytesRef.current = 0;
      mountedTerms.delete(sessionId);
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fit, scroll, and focus when tab becomes active or terminal initializes.
  // New panels can become active before xterm is ready, so termReady must
  // retrigger this path after termRef has been assigned.
  //
  // Deliberately excluded from deps: reportResize (parent passes a new inline
  // arrow each render, so listing it here re-fired the effect on every render
  // and yanked scrolled-up users back to the bottom). Latest reportResize is
  // pulled via reportResizeRef. getFocusPolicyEnv is also pulled fresh inside.
  useEffect(() => {
    if (reactivateRedrawRef.current) {
      clearTimeout(reactivateRedrawRef.current);
      reactivateRedrawRef.current = null;
    }
    if (!isActive) return;
    const term = termRef.current;
    const fitAddon = fitRef.current;
    if (!term) return;
    // On a genuine re-activation (tab switched back, not the first show), force
    // ink/TUI apps (codex, Claude Code) to repaint. While hidden, live output is
    // buffered and the bounded pending queue may have dropped intermediate
    // frames, so the retained buffer can be stale/blank — a SIGWINCH makes the
    // app redraw the whole screen cleanly. The first show is covered by the
    // writer effect's mount/reconnect redraw, so skip it here to avoid a double.
    if (activatedOnceRef.current) {
      reactivateRedrawRef.current = setTimeout(() => {
        reactivateRedrawRef.current = null;
        onRedraw?.();
      }, 120);
    }
    activatedOnceRef.current = true;
    const autoFocus = shouldAutoFocusTerminal(getFocusPolicyEnv());
    requestAnimationFrame(() => {
      // The component may have unmounted (term disposed) between scheduling and
      // running this frame; bail rather than operate on a dead terminal.
      if (termRef.current !== term) return;
      // Capture whether the user was following live output BEFORE fit() can
      // shift the buffer. Only snap back to the bottom if they were already
      // there — otherwise returning to a tab would yank a scrolled-up reader
      // back down and lose their place.
      const buf = term.buffer.active;
      const wasAtBottom = buf.viewportY >= buf.baseY;
      try {
        fitAddon?.fit();
        reportResizeRef.current(term);
      } catch { /* ignore */ }
      if (wasAtBottom) term.scrollToBottom();
      if (autoFocus) {
        term.focus();
      }
      // The WebGL/Canvas renderer is disposed on blur and freshly re-attached on
      // focus (the effect below). A new renderer starts with an empty atlas and
      // only paints rows marked dirty — nothing marks the retained buffer dirty,
      // so the terminal can come back BLANK after a tab switch (notably for
      // in-place-redraw TUIs like codex/Claude Code that don't re-emit on their
      // own). Force a full repaint. This rAF runs after the renderer re-attaches.
      try { term.refresh(0, term.rows - 1); } catch { /* ignore */ }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, termReady]);

  // Attach a GPU renderer (WebGL) to the ACTIVE terminal only. xterm's default
  // DOM renderer rebuilds DOM nodes on every write, which is the main cause of
  // freezes on large output. Browsers cap simultaneous WebGL contexts (~16) and
  // every session keeps its terminal mounted, so giving each one a permanent
  // context would thrash; instead we attach on activate and dispose on
  // deactivate, keeping at most one live WebGL context while the visible
  // terminal gets accelerated rendering. WebGL unavailable or context-lost →
  // fall back to the 2D canvas renderer (still far faster than DOM).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const attachCanvas = () => {
      try {
        const canvas = new CanvasAddon();
        term.loadAddon(canvas);
        rendererRef.current = canvas;
      } catch { /* fall back to DOM renderer */ }
    };

    if (isActive && !rendererRef.current) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          rendererRef.current = null;
          attachCanvas();
        });
        term.loadAddon(webgl);
        rendererRef.current = webgl;
      } catch {
        attachCanvas();
      }
    } else if (!isActive && rendererRef.current) {
      rendererRef.current.dispose();
      rendererRef.current = null;
    }
  }, [isActive, termReady]);

  // Update terminal when theme/font changes
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = currentTheme.terminal;
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch { /* ignore */ }
    });
  }, [currentTheme, fontSize, fontFamily]);

  // NOTE: we intentionally do NOT bump term.options.lineHeight for math mode —
  // changing it forces an xterm resize/reflow, and rendering with a non-default
  // line height while scrolling triggers an xterm renderer crash (loadCell on an
  // undefined buffer line). Tall inline math is handled by scaling instead.

  // KaTeX math overlay. When enabled, scan the visible buffer (plus a little
  // lookback for multi-line blocks) for LaTeX and lay KaTeX-rendered HTML in an
  // absolutely-positioned layer ON TOP of the source text. Off by default and
  // fully torn down when off, so it costs nothing unless the user opts in.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const overlays = mathOverlaysRef.current;
    const debug = typeof localStorage !== 'undefined' && localStorage.getItem('swarmie-math-debug') === '1';

    const teardown = () => {
      for (const { el } of overlays.values()) el.remove();
      overlays.clear();
      mathLayerRef.current?.remove();
      mathLayerRef.current = null;
    };

    if (!mathRender) { teardown(); return; }

    const bg = currentTheme.terminal.background ?? '#000';
    const fg = currentTheme.terminal.foreground ?? '#fff';
    // Cell geometry cached by the (debounced) scan; the (per-frame) reposition
    // reads it without forcing a reflow.
    let cellH = 0;
    let gridRows = 0;

    // Cheap: runs on every scroll/render frame so formulas track the buffer
    // tightly (no ghosting). Only updates vertical position + visibility from
    // the current scroll offset; never re-runs detection or measurement.
    const reposition = () => {
      if (!cellH || !gridRows) return;
      const vt = term.buffer.active.viewportY;
      for (const { el, startAbs, endAbs } of overlays.values()) {
        const vTop = startAbs - vt;
        if (vTop >= gridRows || endAbs - vt < 0) {
          el.style.display = 'none';
        } else {
          el.style.display = '';
          el.style.top = `${vTop * cellH}px`;
        }
      }
    };

    const rescan = () => {
      const xtermEl = term.element;
      const screenEl = xtermEl?.querySelector('.xterm-screen') as HTMLElement | null;
      // The mount <div> that CONTAINS .xterm (term.open's target). It has no
      // React children, so adding our own child is safe, and it's OUTSIDE
      // xterm's render tree — putting the overlay anywhere inside .xterm can
      // corrupt the WebGL/Canvas renderer's row model and crash it (loadCell).
      const mount = xtermEl?.parentElement as HTMLElement | null;
      if (!xtermEl || !screenEl || !mount || screenEl.clientWidth === 0) {
        if (debug) console.log('[swarmie-math] no .xterm-screen yet');
        return;
      }
      mount.style.position = 'relative'; // positioning context for the layer
      let layer = mathLayerRef.current;
      if (!layer || layer.parentElement !== mount) {
        layer?.remove();
        layer = document.createElement('div');
        layer.className = 'term-math-layer';
        mount.appendChild(layer);
        mathLayerRef.current = layer;
      }
      const sr = screenEl.getBoundingClientRect();
      const mr = mount.getBoundingClientRect();
      layer.style.left = `${sr.left - mr.left}px`;
      layer.style.top = `${sr.top - mr.top}px`;
      layer.style.width = `${sr.width}px`;
      layer.style.height = `${sr.height}px`;

      const buf = term.buffer.active;
      const cols = term.cols;
      const rows = term.rows;
      const cw = sr.width / cols;
      const ch = sr.height / rows;
      cellH = ch;
      gridRows = rows;
      const viewTop = buf.viewportY;
      // Scan beyond the viewport in BOTH directions: a multi-line display block
      // (`\[ … \]`, `$$ … $$`) is only detected once BOTH delimiters are inside
      // the window, so a lookahead below the fold is as necessary as the
      // lookback above it — without it a tall block (e.g. a 20-row `aligned`)
      // whose closing `\]` sits just past the visible bottom never renders while
      // its top is on screen. Off-screen items are early-returned when placed.
      const lookback = 80;
      const lookahead = 80;
      const winStart = Math.max(0, viewTop - lookback);
      const winEnd = Math.min(buf.length, viewTop + rows + lookahead);

      // Build LOGICAL lines by joining xterm's wrapped continuation rows, so a
      // `$…$` split across a wrap is still detected. Each logical line records
      // the absolute buffer row it starts on; a logical (cell) column maps back
      // to a buffer row via floor(cellCol / cols).
      const logical: Array<{ text: string; bufStart: number; segCount: number }> = [];
      let abs = winStart;
      while (abs < winEnd) {
        const bufStart = abs;
        let text = buf.getLine(abs)?.translateToString(false) ?? '';
        let next = abs + 1;
        while (next < winEnd && buf.getLine(next)?.isWrapped) {
          text += buf.getLine(next)?.translateToString(false) ?? '';
          next += 1;
        }
        logical.push({ text, bufStart, segCount: next - bufStart });
        abs = next;
      }

      const items = detectMath(logical.map((l) => l.text));
      const seen = new Set<string>();
      let placed = 0;

      // Map a (logical line, char index) to absolute buffer row + cell column.
      const locate = (logIdx: number, charIdx: number) => {
        const log = logical[logIdx];
        const cellCol = cellWidthOf(log.text.slice(0, charIdx));
        return { absRow: log.bufStart + Math.floor(cellCol / cols), col: cellCol % cols };
      };

      const escHtml = (s: string) =>
        s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

      // A row qualifies for gap-closing if it uses only DEFAULT colors (we can
      // reproduce bold/italic/underline when re-rendering the text, but not
      // arbitrary palette/RGB colors without a full mapping). Colored lines fall
      // back to the per-formula overlay.
      const rowGapEligible = (rowAbs: number): boolean => {
        const line = buf.getLine(rowAbs);
        if (!line) return true;
        for (let x = 0; x < cols; x++) {
          const c = line.getCell(x);
          if (!c) continue;
          if (c.getChars() === '' && c.getWidth() === 1) continue; // blank cell
          if (!c.isFgDefault() || !c.isBgDefault() || c.isInverse()) return false;
        }
        return true;
      };

      // CSS for a cell's text attributes (bold/italic/underline). Colors are not
      // reproduced here — rowGapEligible already excluded non-default colors.
      const cellStyle = (c: ReturnType<NonNullable<ReturnType<typeof buf.getLine>>['getCell']> | undefined): string => {
        if (!c) return '';
        let s = '';
        if (c.isBold()) s += 'font-weight:bold;';
        if (c.isItalic()) s += 'font-style:italic;';
        if (c.isUnderline()) s += 'text-decoration:underline;';
        return s;
      };

      // Per-formula overlay (the fallback): covers the source span, math left-
      // aligned, tall math scaled to fit one cell so it doesn't bleed.
      const renderItem = (it: MathItem) => {
        const html = renderMath(it.tex, it.display);
        if (!html) return;
        const start = locate(it.startLine, it.startCol);
        const end = locate(it.endLine, Math.max(it.startCol, it.endCol - 1));
        const startAbs = start.absRow;
        const endAbs = end.absRow;
        const vTop = startAbs - viewTop;
        if (vTop >= rows || endAbs - viewTop < 0) return;
        const multiline = it.display || endAbs !== startAbs;
        const key = `${startAbs}:${start.col}:${it.display ? 'D' : 'I'}:${endAbs - startAbs}:${it.tex}`;
        seen.add(key);

        const existing = overlays.get(key);
        let el = existing?.el;
        const isNew = !el;
        if (!el) {
          el = document.createElement('div');
          el.className = `term-math${it.display ? ' term-math-display' : ''}`;
          el.style.background = bg;
          el.style.color = fg;
          el.style.fontSize = `${fontSize}px`;
          el.innerHTML = html;
          layer.appendChild(el);
        }
        // A display block claims adjacent BLANK rows for vertical room: a block
        // sitting in its own whitespace stays full-size, while one packed between
        // text lines (e.g. inside a list) shrinks to fit instead of overlapping.
        let boxTop = startAbs;
        let boxBottom = endAbs;
        if (it.display) {
          const isBlank = (r: number) => {
            const l = buf.getLine(r);
            return !l || l.translateToString(true).trim() === '';
          };
          let n = 0;
          while (n < 3 && isBlank(boxTop - 1)) { boxTop -= 1; n += 1; }
          n = 0;
          while (n < 3 && isBlank(boxBottom + 1)) { boxBottom += 1; n += 1; }
        }
        const boxRows = boxBottom - boxTop + 1;
        const maxH = boxRows * ch;
        overlays.set(key, { el, startAbs: boxTop, endAbs: boxBottom });
        el.style.display = '';
        el.style.top = `${(boxTop - viewTop) * ch}px`;
        if (multiline) {
          el.style.left = '0px';
          el.style.width = `${cols * cw}px`;
        } else {
          el.style.left = `${start.col * cw}px`;
          el.style.minWidth = `${Math.max(1, end.col + 1 - start.col) * cw}px`;
        }
        el.style.height = `${maxH}px`;
        const inner = el.firstElementChild as HTMLElement | null;
        if (inner) {
          if (isNew) {
            inner.style.transform = '';
            el.dataset.nh = String(inner.getBoundingClientRect().height || 0);
          }
          const nh = Number(el.dataset.nh) || 0;
          // Fit to the available box (display: source + claimed blank rows;
          // inline: one row) so a formula never bleeds onto neighbouring text.
          const limit = maxH * (it.display ? 0.96 : MAX_INLINE_MATH_LINES);
          const scale = nh > limit && nh > 0 ? limit / nh : 1;
          inner.style.transformOrigin = multiline ? 'center center' : 'left center';
          inner.style.transform = scale < 1 ? `scale(${scale})` : '';
        }
        placed += 1;
      };

      // Gap-closing overlay: re-render the WHOLE (unwrapped, default-color) line
      // as inline [text][math][text]… so the rendered math sits flush against the
      // text — no reserved-source whitespace. Text runs reproduce bold/italic/
      // underline. Tall math is shrunk via font-size (reflows, unlike transform)
      // so the line stays one row.
      const renderGapLine = (logIdx: number, lineItems: MathItem[]) => {
        const log = logical[logIdx];
        const startAbs = log.bufStart;
        const vTop = startAbs - viewTop;
        if (vTop >= rows || vTop < -1) return;
        lineItems.sort((a, b) => a.startCol - b.startCol);
        const text = log.text;
        const trimmed = text.replace(/\s+$/, '');
        const line = buf.getLine(startAbs);
        const mathAt = new Map(lineItems.map((it) => [it.startCol, it]));

        // Walk the line character by character (tracking the cell column so CJK
        // double-width chars stay aligned), grouping equal-styled runs and
        // splicing in rendered math at each span.
        let inner = '';
        let runStyle = '';
        let runText = '';
        const flushRun = () => {
          if (runText) inner += `<span class="tm-t" style="${runStyle}">${escHtml(runText)}</span>`;
          runText = '';
        };
        let cellCol = 0;
        let ci = 0;
        while (ci < trimmed.length) {
          const it = mathAt.get(ci);
          if (it) {
            const mhtml = renderMath(it.tex, it.display);
            if (mhtml) { flushRun(); inner += `<span class="tm-m">${mhtml}</span>`; }
            cellCol += cellWidthOf(text.slice(it.startCol, it.endCol));
            ci = it.endCol;
            continue;
          }
          const chr = text[ci];
          const style = cellStyle(line?.getCell(cellCol));
          if (style !== runStyle) { flushRun(); runStyle = style; }
          runText += chr;
          cellCol += cellWidthOf(chr);
          ci += 1;
        }
        flushRun();

        const key = `gap:${startAbs}:${trimmed}`;
        seen.add(key);
        const existing = overlays.get(key);
        let el = existing?.el;
        const isNew = !el;
        if (!el) {
          el = document.createElement('div');
          el.className = 'term-math term-math-line';
          el.style.background = bg;
          el.style.color = fg;
          el.style.fontSize = `${fontSize}px`;
          el.style.fontFamily = fontFamily;
          el.innerHTML = inner;
          layer.appendChild(el);
        }
        overlays.set(key, { el, startAbs, endAbs: startAbs });
        el.style.display = '';
        el.style.left = '0px';
        el.style.top = `${vTop * ch}px`;
        el.style.height = `${ch}px`;
        el.style.lineHeight = `${ch}px`;
        el.style.width = `${Math.max(1, cellWidthOf(trimmed)) * cw}px`;
        if (isNew) {
          // Keep formulas readable: only shrink ones taller than MAX_INLINE_H
          // lines, and only down to that bound (so a sqrt/fraction stays legible
          // while overflowing at most ~0.7 line onto its neighbours).
          el.querySelectorAll<HTMLElement>('.tm-m').forEach((m) => {
            const k = (m.querySelector('.katex') as HTMLElement | null) ?? m;
            const kh = k.getBoundingClientRect().height;
            const limit = ch * MAX_INLINE_MATH_LINES;
            if (kh > limit && kh > 0) m.style.fontSize = `${Math.max(6, fontSize * (limit / kh))}px`;
          });
        }
        placed += 1;
      };

      // Display blocks render per-item; single-line inline math is grouped per
      // logical line so a qualifying line can be gap-closed in one overlay.
      const inlineByLine = new Map<number, MathItem[]>();
      for (const it of items) {
        // Display blocks AND inline math that spans a hard line break both need
        // the per-formula overlay (it covers the full row span); only single-row
        // inline math can be gap-closed.
        if (it.display || it.startLine !== it.endLine) { renderItem(it); continue; }
        const arr = inlineByLine.get(it.startLine);
        if (arr) arr.push(it); else inlineByLine.set(it.startLine, [it]);
      }
      for (const [logIdx, lineItems] of inlineByLine) {
        const log = logical[logIdx];
        if (log.segCount === 1 && rowGapEligible(log.bufStart)) {
          renderGapLine(logIdx, lineItems);
        } else {
          for (const it of lineItems) renderItem(it);
        }
      }

      for (const [key, entry] of overlays) {
        if (!seen.has(key)) { entry.el.remove(); overlays.delete(key); }
      }
      if (debug) {
        console.log(`[swarmie-math] logical=${logical.length} detected=${items.length} placed=${placed} cell=${cw.toFixed(1)}x${ch.toFixed(1)}`);
      }
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer !== null) return;
      timer = setTimeout(() => { timer = null; rescan(); }, 100);
    };
    // Reposition existing overlays immediately (tracks scroll with no lag),
    // then schedule a debounced full re-scan to pick up newly-revealed math.
    const tick = () => { reposition(); schedule(); };

    const renderDisp = term.onRender(tick);
    const scrollDisp = term.onScroll(tick);
    // xterm sets suppressScrollEvent for wheel/touch-driven scrolls, so onScroll
    // misses those — listen to the viewport's native scroll too for tight tracking.
    const viewportEl = term.element?.querySelector('.xterm-viewport') as HTMLElement | null;
    viewportEl?.addEventListener('scroll', reposition, { passive: true });
    // Initial scan(s): the screen may not be laid out on the first tick.
    rescan();
    const kick = setTimeout(rescan, 150);

    return () => {
      renderDisp.dispose();
      scrollDisp.dispose();
      viewportEl?.removeEventListener('scroll', reposition);
      if (timer !== null) clearTimeout(timer);
      clearTimeout(kick);
      teardown();
    };
  }, [mathRender, termReady, currentTheme, fontSize, fontFamily]);

  // Focus search input when search opens
  useEffect(() => {
    if (searchOpen) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    } else {
      const wasOpen = prevSearchOpenRef.current;
      if (wasOpen) {
        setSearchQuery('');
        searchRef.current?.clearDecorations();
        if (shouldRestoreTerminalFocusAfterSearchClose(getFocusPolicyEnv())) {
          termRef.current?.focus();
        }
      }
    }
    prevSearchOpenRef.current = searchOpen;
  }, [searchOpen, getFocusPolicyEnv]);

  const handleSearch = useCallback((query: string, direction: 'next' | 'prev' = 'next') => {
    if (!searchRef.current || !query) return;
    if (direction === 'next') {
      searchRef.current.findNext(query, { regex: false, caseSensitive: false, decorations: { matchOverviewRuler: '#888', activeMatchColorOverviewRuler: '#ffb',  matchBackground: '#5a5a2a', activeMatchBackground: '#7a7a0a' } });
    } else {
      searchRef.current.findPrevious(query, { regex: false, caseSensitive: false, decorations: { matchOverviewRuler: '#888', activeMatchColorOverviewRuler: '#ffb', matchBackground: '#5a5a2a', activeMatchBackground: '#7a7a0a' } });
    }
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
  }, []);

  const clearHistoryLoadTimeout = useCallback(() => {
    if (historyLoadTimeoutRef.current) {
      clearTimeout(historyLoadTimeoutRef.current);
      historyLoadTimeoutRef.current = null;
    }
  }, []);

  const clearHistoryLoading = useCallback(() => {
    clearHistoryLoadTimeout();
    historyLoadingRef.current = false;
    historyLoadAttemptsRef.current = 0;
    capturedDuringLoadRef.current = [];
    capturedDuringLoadBytesRef.current = 0;
    setHistoryLoading(false);
  }, [clearHistoryLoadTimeout]);

  // Send (or re-send) the in-flight history request and arm a retry. A snapshot
  // reply can go missing — lost to a WS reconnect, or sent while the socket
  // wasn't OPEN — so we resend rather than spin out the whole wait and then
  // drop a late snapshot. The snapshot handler clears this timeout on arrival.
  const armHistoryLoad = useCallback((fromOffset: number, toOffset?: number) => {
    onLoadHistory?.(fromOffset, toOffset);
    historyLoadTimeoutRef.current = setTimeout(() => {
      clearHistoryLoadTimeout();
      historyLoadAttemptsRef.current += 1;
      if (historyLoadAttemptsRef.current < HISTORY_LOAD_MAX_ATTEMPTS) {
        armHistoryLoadRef.current?.(fromOffset, toOffset);
        return;
      }
      // Gave up. Don't discard what streamed in during the wait — flush it to
      // the terminal so the latest output survives. Fall back to a plain clear
      // if the writer effect isn't mounted (shouldn't happen).
      if (flushCapturedDuringLoadRef.current) {
        flushCapturedDuringLoadRef.current();
      } else {
        clearHistoryLoading();
      }
    }, HISTORY_LOAD_RETRY_MS);
  }, [onLoadHistory, clearHistoryLoadTimeout, clearHistoryLoading]);

  useEffect(() => {
    armHistoryLoadRef.current = armHistoryLoad;
  }, [armHistoryLoad]);

  const handleLoadEarlier = useCallback(() => {
    if (historyLoadingRef.current) return;
    if (sessionMeta.reachedEarliest) return;
    if (!onLoadHistory) return;
    // Anchor on the raw cache, not on lowestOffset. The client holds
    // [cacheStart, live edge], so it only needs the page BELOW cacheStart —
    // bounding a load to HISTORY_CHUNK_BYTES. Asking from lowestOffset instead
    // made the server reply with everything up to the live end (~21MB of base64
    // on a full ring), which is what froze the page on every "load earlier".
    const cacheStart = getRawCacheStart(sessionId);
    if (cacheStart === null) return; // nothing streamed yet — no anchor
    if (cacheStart <= 0) {
      // Already holding byte 0: nothing older can exist.
      markReachedEarliest(sessionId);
      return;
    }
    if (isRawCacheFull(sessionId)) {
      // Paging further back can't be retained — the live append side would just
      // evict it again. Same reasoning as xterm's scrollback cap below.
      markReachedEarliest(sessionId);
      return;
    }
    const toOffset = cacheStart;
    const fromOffset = Math.max(0, cacheStart - HISTORY_CHUNK_BYTES);
    if (fromOffset >= toOffset) return;
    historyLoadingRef.current = true;
    historyLoadAttemptsRef.current = 0;
    capturedDuringLoadRef.current = [];
    capturedDuringLoadBytesRef.current = 0;
    setHistoryLoading(true);
    armHistoryLoad(fromOffset, toOffset);
  }, [armHistoryLoad, sessionMeta, onLoadHistory, sessionId]);

  // Keep the latest handler reachable from imperative paths (onScroll, wheel)
  // without re-binding listeners every render.
  useEffect(() => {
    handleLoadEarlierRef.current = handleLoadEarlier;
  }, [handleLoadEarlier]);

  // Auto-trigger: when the user actively scrolls UP and lands at the top of
  // xterm's scrollback, request older history. We listen to the viewport's
  // native scroll event because xterm's term.onScroll uses
  // suppressScrollEvent=true for native-scroll-driven changes and so it
  // would never fire for wheel/touch input.
  //
  // Gating on a recent wheel/touch UP gesture avoids firing on initial render
  // or on programmatic scroll-to-bottom from the active-tab effect.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const root = term.element;
    if (!root) return;
    const viewport = root.querySelector('.xterm-viewport') as HTMLElement | null;
    if (!viewport) return;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) scrolledUpAtRef.current = performance.now();
    };
    const touchStartY: { y: number } = { y: 0 };
    const onTouchStart = (e: TouchEvent) => {
      touchStartY.y = e.touches[0]?.pageY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.pageY ?? 0;
      // Finger moving DOWN reveals OLDER content in xterm scrollback.
      if (y - touchStartY.y > 8) scrolledUpAtRef.current = performance.now();
    };
    // xterm's own viewportY is the authoritative scroll position. The DOM
    // `.xterm-viewport.scrollTop` transiently reads 0 while scrolling against
    // concurrent live output (and on sub-pixel rounding), which false-positived
    // "at top" — showing the Load-earlier button and firing the auto-load
    // before the user actually reached the top.
    const isAtScrollbackTop = () =>
      term.buffer.active.viewportY === 0 && term.buffer.active.baseY > 0;

    const onScroll = () => {
      const isTop = isAtScrollbackTop();
      setAtTop(isTop);
      if (!isTop) return;
      if (performance.now() - scrolledUpAtRef.current > AUTO_LOAD_RECENT_WINDOW_MS) return;
      // Consume the gesture timestamp so we don't refire each frame while
      // the viewport sits at the top.
      scrolledUpAtRef.current = 0;
      handleLoadEarlierRef.current?.();
    };

    root.addEventListener('wheel', onWheel, { passive: true });
    root.addEventListener('touchstart', onTouchStart, { passive: true });
    root.addEventListener('touchmove', onTouchMove, { passive: true });
    viewport.addEventListener('scroll', onScroll, { passive: true });
    // term.onScroll fires on output-driven and programmatic scroll where the
    // DOM 'scroll' event may not — keep the button's atTop state accurate, but
    // don't auto-load here (no user gesture drove it).
    const scrollDisposable = term.onScroll(() => setAtTop(isAtScrollbackTop()));

    return () => {
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
      viewport.removeEventListener('scroll', onScroll);
      scrollDisposable.dispose();
    };
  }, [termReady]);

  // xterm.js handles touch by directly mutating viewport.scrollTop and calls
  // preventDefault, which kills native iOS momentum. We observe the gesture
  // and run a simple deceleration animation after release.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const root = term.element;
    const viewport = root?.querySelector('.xterm-viewport') as HTMLElement | null;
    if (!root || !viewport) return;

    // Velocity is computed from the last ~80ms of touch samples — that's how
    // long native iOS looks at to estimate flick speed.
    const samples: { y: number; t: number }[] = [];
    let frame: number | null = null;

    const cancelInertia = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      cancelInertia();
      samples.length = 0;
      samples.push({ y: e.touches[0].pageY, t: performance.now() });
    };

    const onTouchMove = (e: TouchEvent) => {
      const now = performance.now();
      samples.push({ y: e.touches[0].pageY, t: now });
      while (samples.length > 1 && now - samples[0].t > 80) {
        samples.shift();
      }
    };

    const onTouchEnd = () => {
      if (samples.length < 2) return;
      const last = samples[samples.length - 1];
      const first = samples[0];
      const span = last.t - first.t;
      // Finger paused before lifting → no flick
      if (performance.now() - last.t > 80) return;
      if (span <= 0) return;

      // px/ms; positive = content scrolls down (finger moved up)
      let velocity = (first.y - last.y) / span;
      if (Math.abs(velocity) < 0.15) return;
      // Cap so a frantic flick doesn't run forever, but allow real momentum.
      velocity = Math.max(-9, Math.min(9, velocity));

      // ~0.97 per 16ms frame. A 3 px/ms flick travels ~1500px over ~1.7s,
      // a 5 px/ms flick travels ~2500px — snappier than the earlier ~1000px
      // ceiling, closer to a native flick on a long page.
      const decayPerMs = 0.998;
      const minSpeed = 0.1;
      let prev = performance.now();

      const tick = (now: number) => {
        const dt = Math.min(50, now - prev);
        prev = now;

        const before = viewport.scrollTop;
        viewport.scrollTop += velocity * dt;
        if (viewport.scrollTop === before) {
          frame = null;
          return;
        }

        velocity *= Math.pow(decayPerMs, dt);
        if (Math.abs(velocity) > minSpeed) {
          frame = requestAnimationFrame(tick);
        } else {
          frame = null;
        }
      };
      frame = requestAnimationFrame(tick);
    };

    root.addEventListener('touchstart', onTouchStart, { passive: true });
    root.addEventListener('touchmove', onTouchMove, { passive: true });
    root.addEventListener('touchend', onTouchEnd, { passive: true });
    root.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      cancelInertia();
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
      root.removeEventListener('touchend', onTouchEnd);
      root.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [termReady]);

  // Subscribe to session-level offset metadata for the "load earlier" UI.
  useEffect(() => {
    setSessionMeta(getSessionMeta(sessionId));
    return subscribeSessionMeta(sessionId, (m) => setSessionMeta({ ...m }));
  }, [sessionId]);

  // Register this terminal as a writer on the terminalBus so raw:output
  // data is written directly from useWebSocket without going through Zustand.
  // Also subscribes to history:snapshot so rebuild + replay happens inside
  // the same closure as the writer (so we can coordinate the pending queue,
  // captured-during-load queue, and the snapshot apply atomically).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const pendingChunks = pendingChunksRef.current;
    pendingChunks.length = 0;
    let pendingBytes = 0;
    let flushFrame: number | null = null;
    let writeInFlight = false;
    let disposed = false;

    const scheduleFlush = () => {
      if (disposed) return;
      if (!isActiveRef.current) return;
      if (flushFrame !== null) return;
      flushFrame = requestAnimationFrame(() => {
        flushFrame = null;
        if (disposed) return;
        if (!isActiveRef.current) return;
        if (writeInFlight) return;
        if (pendingChunks.length === 0) return;

        // Count how many leading chunks fit this frame's byte budget, then
        // remove them in a single splice. Repeated shift() on a queue that has
        // ballooned to hundreds of thousands of chunks is O(n²) (every shift
        // reindexes the whole array) — that alone stalls recovery from a big
        // backlog. One splice is O(n).
        let batchBytes = 0;
        let batchCount = 0;
        const frameBudget = frameBudgetRef.current;
        while (
          batchCount < pendingChunks.length &&
          (batchCount === 0 || batchBytes < frameBudget)
        ) {
          batchBytes += pendingChunks[batchCount].length;
          batchCount++;
        }
        const batch = pendingChunks.splice(0, batchCount);
        pendingBytes -= batchBytes;

        // Capture bottom state from xterm's own buffer right before writing.
        // Works for any input method (wheel, touch, keyboard) — no need to
        // listen for individual scroll events, which miss touch on mobile.
        const buf = term.buffer.active;
        const wasAtBottom = buf.viewportY >= buf.baseY;

        writeInFlight = true;
        const writeStart = performance.now();
        const writeBytes = batchBytes;
        term.write(decodeTerminalBytes(batch, term), () => {
          if (disposed) return;
          // Client-side jank visibility: a slow term.write is the main suspect
          // for a "frozen" tab. Log it with buffer size so we can see whether
          // xterm parse/layout is the bottleneck (server endpoint can't).
          const dur = performance.now() - writeStart;
          // Adapt the next frame's budget to keep each write short enough that
          // the frame still yields to keyboard input. >24ms (past one frame at
          // ~40fps) → halve; <8ms (plenty of headroom, e.g. WebGL) → grow.
          if (dur > 24) {
            frameBudgetRef.current = Math.max(
              MIN_TERMINAL_WRITE_BYTES_PER_FRAME,
              Math.floor(frameBudgetRef.current / 2),
            );
          } else if (dur < 8) {
            frameBudgetRef.current = Math.min(
              MAX_TERMINAL_WRITE_BYTES_PER_FRAME,
              frameBudgetRef.current + 8 * 1024,
            );
          }
          if (dur > 50) {
            // eslint-disable-next-line no-console
            console.warn(
              `[swarmie] slow term.write ${dur.toFixed(0)}ms bytes=${writeBytes} ` +
              `bufferLines=${term.buffer.active.length} pending=${pendingChunks.length} session=${sessionId}`,
            );
          }
          if (wasAtBottom) {
            term.scrollToBottom();
          }
          writeInFlight = false;
          if (pendingChunks.length > 0) {
            scheduleFlush();
          }
        });
      });
    };
    const cancelScheduledFlush = () => {
      if (flushFrame !== null) {
        cancelAnimationFrame(flushFrame);
        flushFrame = null;
      }
    };
    scheduleFlushRef.current = scheduleFlush;
    cancelScheduledFlushRef.current = cancelScheduledFlush;

    // Timeout fallback: write the parked live tail straight to the terminal and
    // end the load without a reset, so a snapshot that never arrives can't lose
    // the latest output or strand the viewport. scrollOnOutput is off, so a
    // scrolled-up reader stays put while the tail lands at the bottom.
    flushCapturedDuringLoadRef.current = () => {
      if (disposed) return;
      if (!historyLoadingRef.current) return;
      const tail = capturedDuringLoadRef.current;
      capturedDuringLoadRef.current = [];
      capturedDuringLoadBytesRef.current = 0;
      for (const c of tail) {
        term.write(decodeTerminalBytes([c.bin], term));
      }
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    };

    // `binData` is a raw latin1 binary string (live frames decoded at the WS
    // boundary; replay/history atob'd there too).
    const writer = (binData: string, offsetEnd?: number, isReplay?: boolean) => {
      if (disposed) return;
      let data = binData;
      if (isReplay) {
        // Strip device queries from replayed history so xterm doesn't answer
        // stale cursor/DA/color queries into the live PTY (idle-shell garbage).
        try { data = stripDeviceQueries(binData); } catch { /* keep original */ }
      }
      if (historyLoadingRef.current) {
        // Park new chunks until the snapshot is applied; we'll filter them by
        // offset and replay the ones newer than the snapshot afterwards.
        capturedDuringLoadRef.current.push({ bin: data, offsetEnd });
        capturedDuringLoadBytesRef.current += data.length;
        while (
          capturedDuringLoadBytesRef.current > MAX_PENDING_WRITE_BYTES &&
          capturedDuringLoadRef.current.length > 1
        ) {
          const dropped = capturedDuringLoadRef.current.shift();
          if (!dropped) break;
          capturedDuringLoadBytesRef.current -= dropped.bin.length;
        }
        return;
      }
      pendingChunks.push(data);
      pendingBytes += data.length;
      // Drop the oldest queued bytes once the backlog exceeds the cap. A
      // terminal only cares about its tail; keeping a giant backlog just makes
      // each frame's term.write block for seconds. Dropping mid-stream may cut
      // an escape sequence, so reset attributes once after a drop — the next
      // statusline redraw repaints cleanly.
      if (pendingBytes > MAX_PENDING_WRITE_BYTES) {
        while (pendingBytes > MAX_PENDING_WRITE_BYTES && pendingChunks.length > 1) {
          const dropped = pendingChunks.shift()!;
          pendingBytes -= dropped.length;
        }
        pendingChunks.unshift('\x1b[0m');
      }
      scheduleFlush();
    };
    registerTerminalWriter(sessionId, writer);

    // Apply a server snapshot: reset xterm, replay snapshot bytes, then any
    // live chunks that arrived during the load (filtered by offset so we
    // don't double-write the ones already inside the snapshot).
    const unsubscribeSnapshot = subscribeHistorySnapshot(sessionId, (snapshot) => {
      if (disposed) return;
      if (!historyLoadingRef.current) return;
      clearHistoryLoadTimeout();
      // Drop pending chunks — anything in there is already inside the snapshot
      // window (offsetEnd <= snapshot.endOffset).
      pendingChunks.length = 0;
      pendingBytes = 0;

      // Splice the fetched older page onto the front of the raw cache. The cache
      // then spans [snapshot.startOffset, live edge], so rebuilding FROM IT (and
      // not from the server payload, which now covers only the older delta)
      // still leaves the buffer ending at the present.
      // Cache raw, unstripped bytes: the cache mixes live output (never
      // stripped) with fetched history, so stripping here would make its
      // contents inconsistent. Device queries are stripped at rebuild time
      // instead, where every byte is historical by definition.
      const decoded = snapshot.chunks
        .map((c) => { try { return atob(c); } catch { return ''; } })
        .join('');
      // The reply may overshoot the requested upper bound: chunks are opaque
      // base64 units, so one straddling the boundary comes back whole rather
      // than being split (dropping it would leave a hole instead). Trim the
      // bytes we already hold so the splice is exact — offsets are byte counts,
      // so this is arithmetic, not guesswork.
      const cacheStartNow = getRawCacheStart(sessionId);
      const overlap = cacheStartNow === null
        ? 0
        : Math.max(0, Math.min(snapshot.endOffset - cacheStartNow, decoded.length));
      const older = overlap > 0 ? decoded.slice(0, decoded.length - overlap) : decoded;
      const olderEnd = snapshot.endOffset - overlap;
      prependRawCache(sessionId, older, snapshot.startOffset, olderEnd);

      // Anchor by distance-from-bottom. The rebuild ends at the same content
      // the user already had at the bottom, so the number of lines they were
      // scrolled up from the bottom maps to the same content after the rebuild.
      // This is robust to how many older lines get prepended AND to the
      // scrollback cap (counting prepended lines from the top breaks once the
      // buffer is already at the cap — old and new line counts match, so the
      // diff is 0 and the view jumps to the top, the original bug). During the
      // load live chunks are parked, so this reading is stable.
      const buf0 = term.buffer.active;
      const linesFromBottom = Math.max(0, buf0.baseY - buf0.viewportY);

      // Render the cache as of now; bytes still streaming in are parked and
      // replayed against this offset once the rebuild lands.
      const rebuildChunks = getRawCacheChunks(sessionId);
      const rebuiltThrough = getRawCacheEnd(sessionId) ?? snapshot.endOffset;

      const afterSnapshot = () => {
        if (disposed) return;
        const buf = term.buffer.active;
        const target = Math.max(0, buf.baseY - linesFromBottom);
        try { term.scrollToLine(target); } catch { /* ignore */ }
        // Replay live tail at the bottom; with scrollOnOutput off this leaves
        // the anchored viewport untouched. Filter against what the rebuild
        // actually covered (the cache's end), NOT snapshot.endOffset — the
        // snapshot now stops at the old cache start, so everything newer than it
        // is already in the rebuild and replaying it here would double-write.
        const tail = capturedDuringLoadRef.current.filter((c) =>
          typeof c.offsetEnd !== 'number' || c.offsetEnd > rebuiltThrough,
        );
        capturedDuringLoadRef.current = [];
        capturedDuringLoadBytesRef.current = 0;
        for (const c of tail) {
          term.write(decodeTerminalBytes([c.bin], term));
        }
        // If the rebuilt buffer already fills xterm's scrollback, older bytes
        // can't be displayed (they'd be discarded on the next rebuild), so stop
        // offering "load earlier". Without this, each further load re-renders an
        // ever-larger [start, END] window whose oldest lines are thrown away —
        // the "scrolling up keeps getting slower" problem.
        if (term.buffer.active.baseY >= TERMINAL_SCROLLBACK_LINES) {
          markReachedEarliest(sessionId);
        }
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      };

      term.reset();
      if (rebuildChunks.length > 0) {
        // Write ONE cached chunk at a time, chained on term.write's callback,
        // rather than joining and decoding the whole window up front:
        // protectStatusLineRedraws (a backtracking regex) and binaryStringToBytes
        // are full synchronous passes, so doing them over a multi-MB window in
        // one go blocked the page before the first write even started. xterm
        // parses asynchronously and fires the callback per chunk, so this yields
        // to the event loop between chunks and input/paint stay responsive.
        // protectStatusLineRedraws already runs per-batch on the live path, so
        // per-chunk application is not a new boundary risk. Everything replayed
        // here is historical, so strip device queries from all of it — the cache
        // holds raw bytes, live output included.
        let chunkIndex = 0;
        const writeNextChunk = () => {
          if (disposed) return;
          if (chunkIndex >= rebuildChunks.length) {
            afterSnapshot();
            return;
          }
          let bin = rebuildChunks[chunkIndex++];
          try { bin = stripDeviceQueries(bin); } catch { /* keep original */ }
          term.write(decodeTerminalBytes([bin], term), writeNextChunk);
        };
        writeNextChunk();
      } else {
        afterSnapshot();
      }
    });

    const cleanupFlush = () => {
      if (flushFrame !== null) {
        cancelAnimationFrame(flushFrame);
        flushFrame = null;
      }
      pendingChunks.length = 0;
      pendingBytes = 0;
    };

    // After (re)connecting, trigger a SIGWINCH on the PTY (at its current size)
    // so ink-based apps (Claude Code) redraw their UI on the fresh terminal.
    // Redraw works for both local and non-local sessions; resize is gated
    // server-side on Session.isLocal.
    const redrawTimer = setTimeout(() => {
      onRedraw?.();
    }, 200);

    return () => {
      disposed = true;
      clearTimeout(redrawTimer);
      cleanupFlush();
      unsubscribeSnapshot();
      if (scheduleFlushRef.current === scheduleFlush) scheduleFlushRef.current = null;
      if (cancelScheduledFlushRef.current === cancelScheduledFlush) cancelScheduledFlushRef.current = null;
      flushCapturedDuringLoadRef.current = null;
      unregisterTerminalWriter(sessionId, writer);
    };
  }, [sessionId, termReady]);

  // Do not let an inactive terminal keep draining a large xterm parse queue.
  // Switching away already unsubscribes raw WS output; this also stops any
  // bytes that were queued before the unsubscribe from blocking input in the
  // newly active tab. When the user comes back, we resume from the same queue
  // and the WS replay request is offset-based so it does not duplicate bytes.
  useEffect(() => {
    if (isActive) {
      scheduleFlushRef.current?.();
    } else {
      cancelScheduledFlushRef.current?.();
    }
  }, [isActive]);

  return (
    <div
      className={`terminal-view${isActive ? ' terminal-view-active' : ''}`}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, width: '100%', height: '100%', minHeight: 0 }}
    >
    <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      {searchOpen && (
        <div className="terminal-search-bar">
          <input
            ref={searchInputRef}
            type="text"
            className="terminal-search-input"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (e.target.value) handleSearch(e.target.value, 'next');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSearch(searchQuery, e.shiftKey ? 'prev' : 'next');
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
              }
            }}
          />
          <button className="terminal-search-btn" onClick={() => handleSearch(searchQuery, 'prev')} title="Previous (Shift+Enter)">&#x25B2;</button>
          <button className="terminal-search-btn" onClick={() => handleSearch(searchQuery, 'next')} title="Next (Enter)">&#x25BC;</button>
          <button className="terminal-search-btn" onClick={closeSearch} title="Close (Esc)">&times;</button>
        </div>
      )}
      <div
        ref={containerCallbackRef}
        style={{ width: '100%', height: '100%', minHeight: 0, padding: '4px' }}
      />
      {atTop && !sessionMeta.reachedEarliest && (
        <button
          type="button"
          className="terminal-load-earlier-btn"
          onClick={handleLoadEarlier}
          disabled={historyLoading}
          title="Load earlier history"
        >
          {historyLoading ? 'Loading…' : '↑ Load earlier'}
        </button>
      )}
      {historyLoading && (
        <div className="terminal-history-overlay" aria-busy="true" aria-live="polite">
          <div className="terminal-history-spinner" />
          <div className="terminal-history-overlay-label">Loading history…</div>
        </div>
      )}
    </div>
    <MobileToolbar onInput={onInput} />
    </div>
  );
}
