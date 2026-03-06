import { useEffect, useState, useCallback, useRef } from 'react';

function isMobileDevice(): boolean {
  return (
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent,
    )
  );
}

const KEY_MAP: Record<string, string> = {
  Escape: '\x1b',
  Tab: '\t',
  Backspace: '\x7f',
  Enter: '\r',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
};

const CTRL_KEY_MAP: Record<string, string> = {
  Escape: '\x1b',
  Tab: '\t',
  Backspace: '\x08',
  Enter: '\r',
  ArrowUp: '\x1b[1;5A',
  ArrowDown: '\x1b[1;5B',
  ArrowRight: '\x1b[1;5C',
  ArrowLeft: '\x1b[1;5D',
};

const ALT_KEY_MAP: Record<string, string> = {
  ArrowUp: '\x1b[1;3A',
  ArrowDown: '\x1b[1;3B',
  ArrowRight: '\x1b[1;3C',
  ArrowLeft: '\x1b[1;3D',
};

const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

interface MobileToolbarProps {
  onInput?: (data: string) => void;
}

export function MobileToolbar({ onInput }: MobileToolbarProps) {
  const [visible, setVisible] = useState(false);
  const [ctrlActive, setCtrlActive] = useState(false);
  const [altActive, setAltActive] = useState(false);
  const ctrlTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const check = () => {
      const isTouch = isMobileDevice();
      const isSmall = window.innerWidth < 768;
      setVisible(isTouch || isSmall);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const resolveKey = useCallback(
    (key?: string, seq?: string): string => {
      if (seq) return seq;
      if (!key) return '';
      if (ctrlActive) {
        if (CTRL_KEY_MAP[key]) return CTRL_KEY_MAP[key];
        if (key.length === 1) return String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64);
        return KEY_MAP[key] || '';
      }
      if (altActive) {
        if (ALT_KEY_MAP[key]) return ALT_KEY_MAP[key];
        if (key.length === 1) return '\x1b' + key;
        return KEY_MAP[key] || '';
      }
      return KEY_MAP[key] || '';
    },
    [ctrlActive, altActive],
  );

  const sendKey = useCallback(
    (key?: string, seq?: string) => {
      const data = resolveKey(key, seq);
      if (data && onInput) {
        onInput(data);
        // Reset modifiers after sending
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
    <div className="mobile-toolbar">
      {buttons.map((btn) => {
        const isActive =
          (btn.mod === 'ctrl' && ctrlActive) || (btn.mod === 'alt' && altActive);
        return (
          <button
            key={btn.label}
            className={`mobile-toolbar-btn ${isActive ? 'active' : ''}`}
            onTouchStart={(e) => {
              e.preventDefault();
              if (btn.mod === 'ctrl') handleCtrl();
              else if (btn.mod === 'alt') handleAlt();
              else startRepeat(btn.key, btn.seq);
            }}
            onTouchEnd={stopRepeat}
            onTouchCancel={stopRepeat}
            onMouseDown={() => {
              if (btn.mod === 'ctrl') handleCtrl();
              else if (btn.mod === 'alt') handleAlt();
              else startRepeat(btn.key, btn.seq);
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
