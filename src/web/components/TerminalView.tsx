import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { useUIStore } from '../hooks/useUI';
import { themes } from '../themes';
import { registerTerminalWriter, unregisterTerminalWriter } from '../terminalBus';
import { MobileToolbar } from './MobileToolbar';

interface TerminalViewProps {
  sessionId: string;
  isActive?: boolean;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onRedraw?: () => void;
}

export function TerminalView({ sessionId, isActive, onInput, onResize, onRedraw }: TerminalViewProps) {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [termReady, setTermReady] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

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
        customGlyphs: true,
        rescaleOverlappingGlyphs: true,
        macOptionIsMeta: false,
        scrollOnOutput: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(el);

      // WebGL renderer for proper box-drawing glyphs and performance
      try {
        term.loadAddon(new WebglAddon());
      } catch {
        // WebGL not available, fall back to default canvas renderer
      }

      const searchAddon = new SearchAddon();
      term.loadAddon(searchAddon);
      searchRef.current = searchAddon;

      // Intercept Shift+Enter: send backslash then Enter for newline in Claude Code
      // Claude Code uses `\` + Enter as the newline shortcut in non-kitty terminals
      term.attachCustomKeyEventHandler((e) => {
        if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
          if (e.type === 'keydown') {
            e.preventDefault();
            e.stopPropagation();
            onInput?.('\\');
            setTimeout(() => onInput?.('\r'), 30);
          }
          return false;
        }
        // Let Ctrl+` bubble up for tab switcher
        if (e.ctrlKey && (e.key === '`' || e.key === '~')) {
          return false;
        }
        // Option+key: send as Meta escape sequences (ESC + key) for tmux/readline
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
          // Option+letter/digit: send \x1b + key (e.g. Option+F → \x1bf)
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
        // Cmd+Shift+F to open search
        if (e.metaKey && e.shiftKey && e.key === 'f' && !e.ctrlKey && !e.altKey) {
          if (e.type === 'keydown') {
            e.preventDefault();
            setSearchOpen(true);
          }
          return false;
        }
        return true;
      });

      if (onInput) {
        term.onData(onInput);
      }

      const ro = new ResizeObserver(() => {
        requestAnimationFrame(() => {
          if (!el.clientWidth || !el.clientHeight) return;
          try {
            fitAddon.fit();
            onResize?.(term.cols, term.rows);
            term.scrollToBottom();
          } catch { /* ignore */ }
        });
      });
      ro.observe(el);
      observerRef.current = ro;

      termRef.current = term;
      fitRef.current = fitAddon;

      // Fit first, THEN signal ready — ensures buffered data is replayed
      // at the correct terminal dimensions, not the default 80x24.
      requestAnimationFrame(() => {
        try { fitAddon.fit(); } catch { /* ignore */ }
        setTermReady((c) => c + 1);
      });
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

  // Focus and scroll to bottom when tab becomes active
  useEffect(() => {
    if (!isActive) return;
    const term = termRef.current;
    if (!term) return;
    term.scrollToBottom();
    term.focus();
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

  // Focus search input when search opens
  useEffect(() => {
    if (searchOpen) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    } else {
      setSearchQuery('');
      searchRef.current?.clearDecorations();
      termRef.current?.focus();
    }
  }, [searchOpen]);

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

    // After (re)connecting, trigger a SIGWINCH on the PTY (at its current size)
    // so ink-based apps (Claude Code) redraw their UI on the fresh terminal.
    // This works for both local and non-local sessions (unlike onResize which
    // is blocked for local sessions).
    setTimeout(() => {
      onRedraw?.();
    }, 200);

    return () => {
      unregisterTerminalWriter(sessionId);
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
    </div>
    <MobileToolbar onInput={onInput} />
    </div>
  );
}
