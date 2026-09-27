import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import {
  extendFromWord,
  moveRangeEnd,
  rangeFromArgs,
  selectionArgs,
  wordBoundsAt,
  type CellPos,
  type CellRange,
} from '../touchSelection';

/** Hold this long without moving to start a selection. */
const LONG_PRESS_MS = 450;
/** Moving further than this before the timer fires means the user is scrolling. */
const MOVE_TOLERANCE_PX = 10;
/** A contextmenu this soon after a touch came from the long press, not a mouse. */
const TOUCH_CONTEXTMENU_WINDOW_MS = 1500;
const EDGE_SCROLL_INTERVAL_MS = 70;
/** Vertical room the menu needs above the selection before it flips below. */
const MENU_ROOM_PX = 52;
/** Height of a handle's knob below the selected row. */
const HANDLE_KNOB_PX = 22;

type End = 'start' | 'end';

export interface TouchSelectionHandle {
  /** Position in the wrapper's coordinates: the selection edge at row top. */
  x: number;
  y: number;
  /** Row height; the handle's stem spans it. */
  height: number;
}

export interface TouchSelectionMenu {
  x: number;
  y: number;
  below: boolean;
}

// Without a secure context (swarmie served over plain HTTP on the LAN) the
// page cannot read the system clipboard. Remember what our own Copy put there
// so Copy → Paste inside swarmie still works directly. Anything copied
// elsewhere makes it stale: another app means this page was hidden, and a copy
// on this page fires a `copy` event we did not cause.
let lastCopied: string | null = null;
let copyingOurselves = false;
let clipboardWatchInstalled = false;

function watchForForeignCopies() {
  if (clipboardWatchInstalled) return;
  clipboardWatchInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') lastCopied = null;
  });
  document.addEventListener('copy', () => {
    if (!copyingOurselves) lastCopied = null;
  }, true);
}

function copyWithExecCommand(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '-9999px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    copyingOurselves = true;
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    copyingOurselves = false;
    ta.remove();
  }
}

/**
 * Phone text selection for an xterm terminal. xterm.js has no touch selection,
 * so a long press only produced the browser's "Paste" bubble for its hidden
 * textarea. Here a long press selects the word under the finger (keep holding
 * and drag to extend it), and releasing leaves two draggable handles at the
 * selection's ends plus a Copy / Paste menu, all rendered by the caller.
 * Dragging near the top/bottom edge scrolls the terminal.
 */
export function useTouchSelection(
  termRef: RefObject<Terminal | null>,
  wrapperRef: RefObject<HTMLDivElement | null>,
  termReady: number,
) {
  const [range, setRange] = useState<CellRange | null>(null);
  const [dragging, setDragging] = useState<End | null>(null);
  // Plain-HTTP pages have no async clipboard API; paste then goes through a
  // native input the user can long-press.
  const [pasteInputOpen, setPasteInputOpen] = useState(false);
  // Bumped on scroll/resize so the handles follow the text.
  const [, setLayoutTick] = useState(0);
  const rangeRef = useRef<CellRange | null>(null);
  const draggingRef = useRef<End | null>(null);
  const edgeRef = useRef<{ timer: ReturnType<typeof setInterval> | null; x: number; y: number }>({ timer: null, x: 0, y: 0 });

  const geometry = useCallback(() => {
    const term = termRef.current;
    const screen = term?.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!term || !screen) return null;
    const rect = screen.getBoundingClientRect();
    return { term, rect, cellW: rect.width / term.cols, cellH: rect.height / term.rows };
  }, [termRef]);

  /** Buffer cell under a client point, clamped to the visible screen. */
  const cellAt = useCallback((x: number, y: number): CellPos | null => {
    const g = geometry();
    if (!g) return null;
    const { term, rect, cellW, cellH } = g;
    const col = Math.max(0, Math.min(term.cols - 1, Math.floor((x - rect.left) / cellW)));
    const row = Math.max(0, Math.min(term.rows - 1, Math.floor((y - rect.top) / cellH)));
    return { col, row: term.buffer.active.viewportY + row };
  }, [geometry]);

  const applyRange = useCallback((next: CellRange | null) => {
    rangeRef.current = next;
    setRange(next);
    const term = termRef.current;
    if (!term) return;
    if (!next) {
      term.clearSelection();
      return;
    }
    const { col, row, length } = selectionArgs(next.start, next.end, term.cols);
    term.select(col, row, length);
  }, [termRef]);

  const stopEdgeScroll = useCallback(() => {
    if (edgeRef.current.timer) clearInterval(edgeRef.current.timer);
    edgeRef.current.timer = null;
  }, []);

  /** While the finger sits in the top/bottom row, keep scrolling and re-apply
   *  `onTick` so the selection follows the newly revealed text. */
  const updateEdgeScroll = useCallback((x: number, y: number, onTick: (x: number, y: number) => void) => {
    const edge = edgeRef.current;
    edge.x = x;
    edge.y = y;
    const direction = () => {
      const g = geometry();
      if (!g) return 0;
      return edge.y < g.rect.top + g.cellH ? -1 : edge.y > g.rect.bottom - g.cellH ? 1 : 0;
    };
    if (direction() === 0) {
      stopEdgeScroll();
      return;
    }
    if (edge.timer) return;
    edge.timer = setInterval(() => {
      const d = direction();
      if (d === 0) return;
      termRef.current?.scrollLines(d);
      onTick(edge.x, edge.y);
    }, EDGE_SCROLL_INTERVAL_MS);
  }, [geometry, stopEdgeScroll, termRef]);

  const dismiss = useCallback(() => {
    stopEdgeScroll();
    draggingRef.current = null;
    setDragging(null);
    setPasteInputOpen(false);
    applyRange(null);
  }, [applyRange, stopEdgeScroll]);

  // Long press on the terminal itself.
  useEffect(() => {
    const term = termRef.current;
    const root = term?.element;
    const host = root?.parentElement;
    if (!term || !root || !host) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let start: { x: number; y: number } | null = null;
    let word: CellRange | null = null;
    let selected: { col: number; row: number; length: number } | null = null;
    let lastTouchAt = 0;

    const extendTo = (x: number, y: number) => {
      const head = cellAt(x, y);
      if (!word || !head) return;
      selected = extendFromWord(word, head, term.cols);
      term.select(selected.col, selected.row, selected.length);
    };

    const beginSelection = () => {
      timer = null;
      const pos = start && cellAt(start.x, start.y);
      if (!pos) return;
      const line = term.buffer.active.getLine(pos.row);
      const bounds = line
        ? wordBoundsAt((c) => {
          const cell = line.getCell(c);
          return cell ? { chars: cell.getChars(), width: cell.getWidth() } : undefined;
        }, pos.col, term.cols)
        : { start: pos.col, end: pos.col };
      // A new long press replaces any selection that is already up.
      rangeRef.current = null;
      setRange(null);
      setPasteInputOpen(false);
      word = { start: { col: bounds.start, row: pos.row }, end: { col: bounds.end, row: pos.row } };
      selected = selectionArgs(word.start, word.end, term.cols);
      term.select(selected.col, selected.row, selected.length);
      navigator.vibrate?.(10);
    };

    const onTouchStart = (e: TouchEvent) => {
      lastTouchAt = Date.now();
      if (timer) clearTimeout(timer);
      timer = null;
      word = null;
      if (e.touches.length !== 1) {
        start = null;
        return;
      }
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY };
      timer = setTimeout(beginSelection, LONG_PRESS_MS);
    };

    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      if (word) {
        // Selecting: the finger drags the selection instead of scrolling.
        e.preventDefault();
        e.stopPropagation();
        extendTo(t.clientX, t.clientY);
        updateEdgeScroll(t.clientX, t.clientY, extendTo);
        return;
      }
      if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > MOVE_TOLERANCE_PX) {
        if (timer) clearTimeout(timer);
        timer = null;
        start = null;
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      lastTouchAt = Date.now();
      if (timer) clearTimeout(timer);
      timer = null;
      if (word) {
        // No synthesized click: it would focus the textarea and pop the keyboard.
        e.preventDefault();
        e.stopPropagation();
        stopEdgeScroll();
        if (selected) applyRange(rangeFromArgs(selected, term.cols));
        word = null;
        selected = null;
        start = null;
        return;
      }
      // A still tap clears an existing selection (and only that: it must not
      // also focus the textarea). A scroll leaves the selection in place.
      if (start && rangeRef.current) {
        e.preventDefault();
        dismiss();
      }
      start = null;
    };

    // The long press also fires contextmenu. Left alone, xterm moves its
    // textarea under the finger and the browser shows its lone "Paste" bubble.
    const onContextMenu = (e: Event) => {
      if (Date.now() - lastTouchAt > TOUCH_CONTEXTMENU_WINDOW_MS) return;
      e.preventDefault();
      e.stopPropagation();
    };

    // Keep handles on the text as it scrolls; drop them if xterm clears the
    // selection itself (e.g. the lines were trimmed from scrollback).
    const bump = () => setLayoutTick((n) => n + 1);
    const scrollSub = term.onScroll(bump);
    const resizeSub = term.onResize(bump);
    const viewport = root.querySelector('.xterm-viewport');
    viewport?.addEventListener('scroll', bump, { passive: true });
    const selectionSub = term.onSelectionChange(() => {
      if (rangeRef.current && !draggingRef.current && !term.hasSelection()) {
        rangeRef.current = null;
        setRange(null);
        setPasteInputOpen(false);
      }
    });

    host.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    host.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    host.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
    host.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: false });
    host.addEventListener('contextmenu', onContextMenu, true);
    return () => {
      if (timer) clearTimeout(timer);
      stopEdgeScroll();
      scrollSub.dispose();
      resizeSub.dispose();
      selectionSub.dispose();
      viewport?.removeEventListener('scroll', bump);
      host.removeEventListener('touchstart', onTouchStart, true);
      host.removeEventListener('touchmove', onTouchMove, true);
      host.removeEventListener('touchend', onTouchEnd, true);
      host.removeEventListener('touchcancel', onTouchEnd, true);
      host.removeEventListener('contextmenu', onContextMenu, true);
    };
  }, [applyRange, cellAt, dismiss, stopEdgeScroll, termReady, termRef, updateEdgeScroll]);

  // Handle dragging. The finger holds the knob below the text, so remember
  // where it grabbed relative to the cell and track that cell, not the finger.
  const handlePointerDown = useCallback((which: End, e: ReactPointerEvent<HTMLElement>) => {
    const g = geometry();
    const current = rangeRef.current;
    if (!g || !current) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const pos = current[which];
    const cellCenterX = g.rect.left + (pos.col + 0.5) * g.cellW;
    const cellCenterY = g.rect.top + (pos.row - g.term.buffer.active.viewportY + 0.5) * g.cellH;
    const offsetX = e.clientX - cellCenterX;
    const offsetY = e.clientY - cellCenterY;
    draggingRef.current = which;
    setDragging(which);
    setPasteInputOpen(false);

    const moveTo = (x: number, y: number) => {
      const held = draggingRef.current;
      const next = cellAt(x - offsetX, y - offsetY);
      if (!held || !next || !rangeRef.current) return;
      const moved = moveRangeEnd(rangeRef.current, held, next);
      draggingRef.current = moved.active;
      setDragging(moved.active);
      applyRange(moved.range);
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      ev.preventDefault();
      moveTo(ev.clientX, ev.clientY);
      updateEdgeScroll(ev.clientX, ev.clientY - offsetY, (x, y) => moveTo(x, y + offsetY));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      stopEdgeScroll();
      draggingRef.current = null;
      setDragging(null);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }, [applyRange, cellAt, geometry, stopEdgeScroll, updateEdgeScroll]);

  // Layout, recomputed each render (scroll/resize bump a render).
  let handles: { start: TouchSelectionHandle | null; end: TouchSelectionHandle | null } = { start: null, end: null };
  let menu: TouchSelectionMenu | null = null;
  const g = range ? geometry() : null;
  const wrapper = wrapperRef.current;
  if (range && g && wrapper) {
    const w = wrapper.getBoundingClientRect();
    const left = g.rect.left - w.left;
    const top = g.rect.top - w.top;
    const viewportY = g.term.buffer.active.viewportY;
    const place = (pos: CellPos, edge: number): TouchSelectionHandle | null => {
      const row = pos.row - viewportY;
      if (row < 0 || row >= g.term.rows) return null;
      return { x: left + (pos.col + edge) * g.cellW, y: top + row * g.cellH, height: g.cellH };
    };
    handles = { start: place(range.start, 0), end: place(range.end, 1) };
    if (!dragging) {
      const clampX = (x: number) => Math.max(80, Math.min(w.width - 80, x));
      const s = handles.start;
      const e = handles.end;
      if (s && s.y >= MENU_ROOM_PX) {
        menu = { x: clampX(e && e.y === s.y ? (s.x + e.x) / 2 : s.x), y: s.y, below: false };
      } else if (e) {
        menu = { x: clampX(e.x), y: e.y + e.height + HANDLE_KNOB_PX, below: true };
      } else {
        menu = { x: clampX(w.width / 2), y: w.height / 2, below: false };
      }
    }
  }

  const copy = useCallback(async () => {
    const text = termRef.current?.getSelection() ?? '';
    dismiss();
    if (!text) return;
    watchForForeignCopies();
    lastCopied = text;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch { /* fall back below */ }
    if (!copyWithExecCommand(text)) console.warn('[swarmie] copy to clipboard failed');
  }, [dismiss, termRef]);

  const pasteText = useCallback((text: string) => {
    const term = termRef.current;
    dismiss();
    // term.paste applies bracketed-paste mode and goes out through onData.
    if (term && text) term.paste(text);
  }, [dismiss, termRef]);

  const paste = useCallback(async () => {
    try {
      if (navigator.clipboard?.readText) {
        pasteText(await navigator.clipboard.readText());
        return;
      }
    } catch { /* permission denied: fall back below */ }
    if (lastCopied) {
      pasteText(lastCopied);
      return;
    }
    // Text copied in another app: let the user paste it into a real input.
    setPasteInputOpen(true);
  }, [pasteText]);

  return { handles, menu, pasteInputOpen, handlePointerDown, copy, paste, pasteText, dismiss };
}
