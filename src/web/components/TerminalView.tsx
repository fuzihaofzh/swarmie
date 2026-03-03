import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useSessionEvents, type NormalizedEvent } from '../hooks/useSessions';
import { useUIStore } from '../hooks/useUI';
import { themes } from '../themes';

interface TerminalViewProps {
  sessionId: string;
  isActive?: boolean;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

export function TerminalView({ sessionId, isActive, onInput, onResize }: TerminalViewProps) {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenCountRef = useRef(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [termReady, setTermReady] = useState(0);
  const events = useSessionEvents(sessionId);

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
    writtenCountRef.current = 0;

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

  // Write new events to terminal — also re-runs when termReady changes
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const rawEvents = events.filter(
      (e: NormalizedEvent) => e.type === 'raw:output',
    );

    const newEvents = rawEvents.slice(writtenCountRef.current);
    for (const event of newEvents) {
      const b64 = (event.data as { data: string }).data;
      // Decode base64 -> binary -> Uint8Array for proper UTF-8 handling
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      term.write(bytes);
    }
    writtenCountRef.current = rawEvents.length;
  }, [events, termReady]);

  return (
    <div
      ref={containerCallbackRef}
      style={{ flex: 1, width: '100%', height: '100%', minHeight: 0, padding: '4px' }}
    />
  );
}
