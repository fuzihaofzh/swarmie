import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { useUIStore } from '../hooks/useUI';
import { themes } from '../themes';
import {
  registerTerminalWriter,
  unregisterTerminalWriter,
  getSessionMeta,
  subscribeSessionMeta,
  subscribeHistorySnapshot,
  type SessionMeta,
} from '../terminalBus';
import { MobileToolbar } from './MobileToolbar';
import { useKeybindingStore, matchesBinding } from '../hooks/useKeybindings';
import {
  shouldAutoFocusTerminal,
  shouldRestoreTerminalFocusAfterSearchClose,
} from '../focusPolicy';
import { decodeBase64Chunks, estimateBase64Bytes } from '../base64';
import { stripDeviceQueries } from '../terminalQueries';

interface TerminalViewProps {
  sessionId: string;
  isActive?: boolean;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onRedraw?: () => void;
  onLoadHistory?: (fromOffset: number) => void;
}

const MAX_TERMINAL_WRITE_BYTES_PER_FRAME = 256 * 1024;
// Hard cap on the unwritten write queue. When a tab is backgrounded the flush
// rAF pauses while the WS keeps pushing, so pendingChunks can balloon to
// hundreds of MB; on return each term.write blocks the main thread for seconds
// and the tab never catches up (full freeze). Capped at the server's 16MB raw
// ring — that is the most history a fresh replay could ever produce anyway, so
// dropping older queued bytes loses nothing the backend can still show.
const MAX_PENDING_WRITE_BYTES = 16 * 1024 * 1024;
// Sized to comfortably hold a full MAX_RAW_BYTES (16MB) snapshot at typical
// terminal line widths. xterm only allocates per actual line written, so the
// cap is essentially free when usage is small.
const TERMINAL_SCROLLBACK_LINES = 200000;
/** How many bytes earlier to fetch each time the user asks for more history. */
const HISTORY_CHUNK_BYTES = 2 * 1024 * 1024;
/** Auto-trigger only fires if the user wheel/touch-swiped up within this window. */
const AUTO_LOAD_RECENT_WINDOW_MS = 600;

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

export function TerminalView({ sessionId, isActive, onInput, onResize, onRedraw, onLoadHistory }: TerminalViewProps) {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const initStartedRef = useRef(false);
  const [termReady, setTermReady] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const isActiveRef = useRef(isActive);
  const prevSearchOpenRef = useRef(searchOpen);
  const lastReportedSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  const themeName = useUIStore((s) => s.theme);
  const fontSize = useUIStore((s) => s.fontSize);
  const fontFamily = useUIStore((s) => s.fontFamily);
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
  const capturedDuringLoadRef = useRef<Array<{ b64: string; offsetEnd?: number }>>([]);
  const pendingChunksRef = useRef<string[]>([]);
  const scrolledUpAtRef = useRef(0);
  const handleLoadEarlierRef = useRef<(() => void) | null>(null);

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

    initStartedRef.current = true;

    const init = () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) {
        requestAnimationFrame(init);
        return;
      }

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

      try {
        term.loadAddon(new CanvasAddon());
      } catch {
        // Fall back to default DOM renderer
      }

      const searchAddon = new SearchAddon();
      term.loadAddon(searchAddon);
      searchRef.current = searchAddon;

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
          if (historyLoadingRef.current) return;
          onInput(data);
        });
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

    requestAnimationFrame(init);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, sessionId]);

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
      mountedTerms.delete(sessionId);
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
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
    if (!isActive) return;
    const term = termRef.current;
    const fitAddon = fitRef.current;
    if (!term) return;
    const autoFocus = shouldAutoFocusTerminal(getFocusPolicyEnv());
    requestAnimationFrame(() => {
      try {
        fitAddon?.fit();
        reportResizeRef.current(term);
      } catch { /* ignore */ }
      term.scrollToBottom();
      if (autoFocus) {
        term.focus();
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const handleLoadEarlier = useCallback(() => {
    if (historyLoadingRef.current) return;
    if (sessionMeta.reachedEarliest) return;
    if (sessionMeta.lowestOffset <= 0) return;
    const fromOffset = Math.max(0, sessionMeta.lowestOffset - HISTORY_CHUNK_BYTES);
    if (fromOffset >= sessionMeta.lowestOffset) return;
    historyLoadingRef.current = true;
    capturedDuringLoadRef.current = [];
    setHistoryLoading(true);
    onLoadHistory?.(fromOffset);
  }, [sessionMeta, onLoadHistory]);

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
      if (flushFrame !== null) return;
      flushFrame = requestAnimationFrame(() => {
        flushFrame = null;
        if (disposed) return;
        if (writeInFlight) return;
        if (pendingChunks.length === 0) return;

        // Count how many leading chunks fit this frame's byte budget, then
        // remove them in a single splice. Repeated shift() on a queue that has
        // ballooned to hundreds of thousands of chunks is O(n²) (every shift
        // reindexes the whole array) — that alone stalls recovery from a big
        // backlog. One splice is O(n).
        let batchBytes = 0;
        let batchCount = 0;
        while (
          batchCount < pendingChunks.length &&
          (batchCount === 0 || batchBytes < MAX_TERMINAL_WRITE_BYTES_PER_FRAME)
        ) {
          batchBytes += estimateBase64Bytes(pendingChunks[batchCount]);
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
        term.write(decodeBase64Chunks(batch), () => {
          if (disposed) return;
          // Client-side jank visibility: a slow term.write is the main suspect
          // for a "frozen" tab. Log it with buffer size so we can see whether
          // xterm parse/layout is the bottleneck (server endpoint can't).
          const dur = performance.now() - writeStart;
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

    const writer = (b64Data: string, offsetEnd?: number, isReplay?: boolean) => {
      if (disposed) return;
      let data = b64Data;
      if (isReplay) {
        // Strip device queries from replayed history so xterm doesn't answer
        // stale cursor/DA/color queries into the live PTY (idle-shell garbage).
        try { data = btoa(stripDeviceQueries(atob(b64Data))); } catch { /* keep original */ }
      }
      if (historyLoadingRef.current) {
        // Park new chunks until the snapshot is applied; we'll filter them by
        // offset and replay the ones newer than the snapshot afterwards.
        capturedDuringLoadRef.current.push({ b64: data, offsetEnd });
        return;
      }
      pendingChunks.push(data);
      pendingBytes += estimateBase64Bytes(data);
      // Drop the oldest queued bytes once the backlog exceeds the cap. A
      // terminal only cares about its tail; keeping a giant backlog just makes
      // each frame's term.write block for seconds. Dropping mid-stream may cut
      // an escape sequence, so reset attributes once after a drop — the next
      // statusline redraw repaints cleanly.
      if (pendingBytes > MAX_PENDING_WRITE_BYTES) {
        while (pendingBytes > MAX_PENDING_WRITE_BYTES && pendingChunks.length > 1) {
          const dropped = pendingChunks.shift()!;
          pendingBytes -= estimateBase64Bytes(dropped);
        }
        try { pendingChunks.unshift(btoa('\x1b[0m')); } catch { /* ignore */ }
      }
      scheduleFlush();
    };
    registerTerminalWriter(sessionId, writer);

    // Apply a server snapshot: reset xterm, replay snapshot bytes, then any
    // live chunks that arrived during the load (filtered by offset so we
    // don't double-write the ones already inside the snapshot).
    const unsubscribeSnapshot = subscribeHistorySnapshot(sessionId, (snapshot) => {
      if (disposed) return;
      // Drop pending chunks — anything in there is already inside the snapshot
      // window (offsetEnd <= snapshot.endOffset).
      pendingChunks.length = 0;
      pendingBytes = 0;

      const tail = capturedDuringLoadRef.current.filter((c) =>
        typeof c.offsetEnd !== 'number' || c.offsetEnd > snapshot.endOffset,
      );
      capturedDuringLoadRef.current = [];

      // Anchor by distance-from-bottom. The snapshot ends at the same content
      // the user already had at the bottom, so the number of lines they were
      // scrolled up from the bottom maps to the same content after the rebuild.
      // This is robust to how many older lines get prepended AND to the
      // scrollback cap (counting prepended lines from the top breaks once the
      // buffer is already at the cap — old and new line counts match, so the
      // diff is 0 and the view jumps to the top, the original bug). During the
      // load live chunks are parked, so this reading is stable.
      const buf0 = term.buffer.active;
      const linesFromBottom = Math.max(0, buf0.baseY - buf0.viewportY);

      const afterSnapshot = () => {
        if (disposed) return;
        const buf = term.buffer.active;
        const target = Math.max(0, buf.baseY - linesFromBottom);
        try { term.scrollToLine(target); } catch { /* ignore */ }
        // Replay live tail at the bottom; with scrollOnOutput off this leaves
        // the anchored viewport untouched.
        for (const c of tail) {
          term.write(decodeBase64Chunks([c.b64]));
        }
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      };

      term.reset();
      if (snapshot.chunks.length > 0) {
        // Strip device queries — this is historical output; answering its
        // stale cursor/DA/color queries into the live PTY produces garbage.
        const cleaned = snapshot.chunks.map((c) => {
          try { return btoa(stripDeviceQueries(atob(c))); } catch { return c; }
        });
        term.write(decodeBase64Chunks(cleaned), afterSnapshot);
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
    setTimeout(() => {
      onRedraw?.();
    }, 200);

    return () => {
      disposed = true;
      cleanupFlush();
      unsubscribeSnapshot();
      unregisterTerminalWriter(sessionId, writer);
    };
  }, [sessionId, termReady]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, width: '100%', height: '100%', minHeight: 0 }}>
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
      {atTop && !sessionMeta.reachedEarliest && sessionMeta.lowestOffset > 0 && (
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
