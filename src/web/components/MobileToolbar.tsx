import { useEffect, useState, useCallback, useRef } from 'react';
import { shouldShowMobileToolbar } from '../focusPolicy';
import { useMobileModifiers, resolveKeyWithMods } from '../mobileModifiers';

function getFocusPolicyEnv() {
  return {
    userAgent: navigator.userAgent,
    viewportWidth: window.innerWidth,
    hasTouchStart: 'ontouchstart' in window,
    maxTouchPoints: navigator.maxTouchPoints,
  };
}

const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

interface MobileToolbarProps {
  onInput?: (data: string) => void;
}

export function MobileToolbar({ onInput }: MobileToolbarProps) {
  const [visible, setVisible] = useState(false);
  // Modifier state lives in a shared store so the soft keyboard's input path
  // (in TerminalView) can honour an armed Ctrl/Alt too, not just these buttons.
  const ctrlActive = useMobileModifiers((s) => s.ctrl);
  const altActive = useMobileModifiers((s) => s.alt);
  const setCtrlActive = useMobileModifiers((s) => s.setCtrl);
  const setAltActive = useMobileModifiers((s) => s.setAlt);
  const ctrlTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const check = () => {
      setVisible(shouldShowMobileToolbar(getFocusPolicyEnv()));
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Handle native keyboard pushing the viewport up. Only constrain height
  // when the viewport is *clearly* shrunk by the keyboard; iOS Safari's URL
  // bar hide/show causes vv.height to oscillate during scroll, and forcing
  // a height on every event triggers a refit→resize→SIGWINCH storm that
  // garbles ink-based TUI output mid-render.
  useEffect(() => {
    // Gate on `visible` (kept in sync by the resize effect) rather than a
    // one-time env check, and depend on it below — otherwise rotating/resizing
    // into the mobile layout after mount would never install the soft-keyboard
    // viewport handling.
    if (!visible || !window.visualViewport) return;

    const vv = window.visualViewport;
    let maxHeight = vv.height;

    const apply = () => {
      const root = document.getElementById('root');
      if (!root) return;
      if (vv.height > maxHeight) maxHeight = vv.height;
      // Treat as "keyboard is open" only if viewport is at least 20% shorter
      // than the largest height we've seen this session. URL-bar transitions
      // are typically <10% and should be ignored.
      if (vv.height < maxHeight * 0.8) {
        root.style.height = vv.height + 'px';
      } else if (root.style.height) {
        root.style.height = '';
      }
    };

    const onScroll = () => {
      window.scrollTo(0, 0);
    };

    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', onScroll);
    apply();

    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', onScroll);
      const root = document.getElementById('root');
      if (root) root.style.height = '';
    };
  }, [visible]);

  const resolveKey = useCallback(
    (key?: string, seq?: string): string => {
      let effectiveKey = key;
      if (seq) {
        // A single-character seq (the "/", "[", "]" buttons) should still honour
        // an active Ctrl/Alt modifier so chords like Ctrl+[ (= ESC) work from the
        // toolbar. Multi-char escape sequences pass straight through.
        if (seq.length === 1 && (ctrlActive || altActive)) {
          effectiveKey = seq;
        } else {
          return seq;
        }
      }
      if (!effectiveKey) return '';
      return resolveKeyWithMods(effectiveKey, ctrlActive, altActive);
    },
    [ctrlActive, altActive],
  );

  const sendKey = useCallback(
    (key?: string, seq?: string) => {
      const data = resolveKey(key, seq);
      if (data && onInput) {
        onInput(data);
        setCtrlActive(false);
        setAltActive(false);
        if (ctrlTimeoutRef.current) {
          clearTimeout(ctrlTimeoutRef.current);
          ctrlTimeoutRef.current = null;
        }
      }
    },
    [resolveKey, onInput],
  );

  const handleCtrl = useCallback(() => {
    setCtrlActive((prev) => {
      const next = !prev;
      if (ctrlTimeoutRef.current) clearTimeout(ctrlTimeoutRef.current);
      if (next) {
        ctrlTimeoutRef.current = setTimeout(() => setCtrlActive(false), 10000);
      }
      return next;
    });
  }, []);

  const handleAlt = useCallback(() => {
    setAltActive((prev) => !prev);
  }, []);

  const stopRepeat = useCallback(() => {
    if (repeatRef.current) {
      clearInterval(repeatRef.current);
      repeatRef.current = null;
    }
  }, []);

  const startRepeat = useCallback(
    (key?: string, seq?: string) => {
      sendKey(key, seq);
      if (key && ARROW_KEYS.has(key) && !ctrlActive && !altActive) {
        repeatRef.current = setInterval(() => sendKey(key, seq), 100);
      }
    },
    [sendKey, ctrlActive, altActive],
  );

  useEffect(() => stopRepeat, [stopRepeat]);

  // React registers `touchstart` as a passive listener, so calling
  // `e.preventDefault()` inside `onTouchStart` is a silent no-op. Without it
  // the browser still synthesises mouse events (mousedown/mouseup/click) after
  // each tap, which (a) fires the button action a *second* time — e.g. "/"
  // gets sent twice — and (b) moves focus onto the button, dismissing the soft
  // keyboard. Attaching our own non-passive listener lets preventDefault take
  // effect: no synthetic mouse events, no double input, no lost keyboard.
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const onTouchStart = (e: TouchEvent) => {
      if ((e.target as HTMLElement | null)?.closest('.mobile-toolbar-btn')) {
        e.preventDefault();
      }
    };
    el.addEventListener('touchstart', onTouchStart, { passive: false });
    return () => el.removeEventListener('touchstart', onTouchStart);
  }, [visible]);

  const pressButton = (btn: { key?: string; seq?: string; mod?: 'ctrl' | 'alt' }) => {
    if (btn.mod === 'ctrl') handleCtrl();
    else if (btn.mod === 'alt') handleAlt();
    else startRepeat(btn.key, btn.seq);
  };

  if (!visible) return null;

  const buttons: { label: string; key?: string; seq?: string; mod?: 'ctrl' | 'alt' }[] = [
    { label: 'Esc', key: 'Escape' },
    { label: 'Tab', key: 'Tab' },
    { label: 'Ctrl', mod: 'ctrl' },
    { label: 'Alt', mod: 'alt' },
    { label: '←', key: 'ArrowLeft' },
    { label: '→', key: 'ArrowRight' },
    { label: '↑', key: 'ArrowUp' },
    { label: '↓', key: 'ArrowDown' },
    { label: '⌫', key: 'Backspace' },
    { label: '↵', key: 'Enter' },
    { label: '/', seq: '/' },
    { label: '[', seq: '[' },
    { label: ']', seq: ']' },
  ];

  return (
    <div className="mobile-toolbar" ref={toolbarRef}>
      {buttons.map((btn) => {
        const isActive =
          (btn.mod === 'ctrl' && ctrlActive) || (btn.mod === 'alt' && altActive);
        return (
          <button
            key={btn.label}
            className={`mobile-toolbar-btn ${isActive ? 'active' : ''}`}
            // Touch: the native non-passive listener above prevents the
            // synthetic mouse events, so onMouseDown won't fire on touch and
            // the action runs exactly once.
            onTouchStart={() => pressButton(btn)}
            onTouchEnd={stopRepeat}
            onTouchCancel={stopRepeat}
            // Mouse (desktop): preventDefault keeps focus on the terminal.
            onMouseDown={(e) => {
              e.preventDefault();
              pressButton(btn);
            }}
            onMouseUp={stopRepeat}
            onMouseLeave={stopRepeat}
          >
            {btn.label}
          </button>
        );
      })}
    </div>
  );
}
