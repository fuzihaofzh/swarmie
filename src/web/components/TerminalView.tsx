import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useUIStore } from '../hooks/useUI';
import { themes } from '../themes';
import { registerTerminalWriter, unregisterTerminalWriter } from '../terminalBus';

interface TerminalViewProps {
  sessionId: string;
  isActive?: boolean;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

export function TerminalView({ sessionId, isActive, onInput, onResize }: TerminalViewProps) {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [termReady, setTermReady] = useState(0);

  const themeName = useUIStore((s) => s.theme);
  const fontSize = useUIStore((s) => s.fontSize);
  const fontFamily = useUIStore((s) => s.fontFamily);
  const currentTheme = themes[themeName] ?? themes['github-dark'];

  // Refs for latest values (used in callback ref closure)
  const themeRef = useRef(currentTheme);
  const fontSizeRef = useRef(fontSize);
  const fontFamilyRef = useRef(fontFamily);

  useEffect(() => {
    themeRef.current = currentTheme;
    fontSizeRef.current = fontSize;
    fontFamilyRef.current = fontFamily;
  });

  const containerCallbackRef = useCallback((el: HTMLDivElement | null) => {
    // Cleanup previous
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (termRef.current) {
      termRef.current.dispose();
      termRef.current = null;
      fitRef.current = null;
    }

    if (!el) return;

    // Wait for the container to have layout dimensions
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
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(el);

      // WKWebView: clear native DOM selection on click
      const screen = el.querySelector('.xterm-screen');
      if (screen) {
        screen.addEventListener('mousedown', () => {
          window.getSelection()?.removeAllRanges();
        });
      }

      // Intercept Shift+Enter: send backslash then Enter for newline in Claude Code
      // Claude Code uses `\` + Enter as the newline shortcut in non-kitty terminals
      // Block both keydown and keypress to prevent xterm from also sending \r
      let shiftEnterPending = false;
      term.attachCustomKeyEventHandler((e) => {
        if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
          if (e.type === 'keydown') {
            shiftEnterPending = true;
            onInput?.('\\');
            setTimeout(() => {
              shiftEnterPending = false;
              onInput?.('\r');
            }, 30);
          }
          return false; // block both keydown and keypress
        }
        return true;
      });

      // Delay fit() to ensure renderer is initialized
      requestAnimationFrame(() => {
        try { fitAddon.fit(); } catch { /* ignore */ }
      });

      if (onInput) {
        term.onData(onInput);
      }

      const ro = new ResizeObserver(() => {
        requestAnimationFrame(() => {
          try {
            fitAddon.fit();
            onResize?.(term.cols, term.rows);
          } catch { /* ignore */ }
        });
      });
      ro.observe(el);
      observerRef.current = ro;

      termRef.current = term;
      fitRef.current = fitAddon;

      // Signal that terminal is ready so the events effect re-runs
      setTermReady((c) => c + 1);
    };

    requestAnimationFrame(init);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Focus terminal when it becomes active
  useEffect(() => {
    if (isActive && termRef.current) {
      termRef.current.focus();
    }
  }, [isActive]);

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

  // Register this terminal as a writer on the terminalBus so raw:output
  // data is written directly from useWebSocket without going through Zustand.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    registerTerminalWriter(sessionId, (b64Data: string) => {
      const binary = atob(b64Data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      term.write(bytes);
    });

    return () => {
      unregisterTerminalWriter(sessionId);
    };
  }, [sessionId, termReady]);

  return (
    <div
      ref={containerCallbackRef}
      style={{ flex: 1, width: '100%', height: '100%', minHeight: 0, padding: '4px' }}
    />
  );
}
