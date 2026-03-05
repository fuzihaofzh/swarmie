import { useEffect, useRef, useCallback } from 'react';
import { useSessionStore } from './useSessions';
import { writeToTerminal, clearTerminalBuffer } from '../terminalBus';

type WSMessage = {
  type: string;
  [key: string]: unknown;
};

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const shutdownRef = useRef(false);
  const { setSessions, addSession, removeSession, addEvent, addEventBatch } = useSessionStore();

  const connect = useCallback(() => {
    if (shutdownRef.current) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      // Subscribe to all sessions
      ws.send(JSON.stringify({ type: 'subscribe:all' }));
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as WSMessage;
        handleMessage(msg);
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (!shutdownRef.current) {
        reconnectTimer.current = setTimeout(connect, 2000);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMessage = useCallback((msg: WSMessage) => {
    switch (msg.type) {
      case 'session:list':
        setSessions(msg.sessions as SessionSummary[]);
        break;
      case 'session:added':
        addSession(msg.session as SessionSummary);
        break;
      case 'session:removed':
        clearTerminalBuffer(msg.sessionId as string);
        removeSession(msg.sessionId as string);
        break;
      case 'server:shutdown':
        shutdownRef.current = true;
        clearTimeout(reconnectTimer.current);
        wsRef.current?.close();
        wsRef.current = null;
        // Try to close the tab
        window.close();
        // Fallback if window.close() is blocked by browser
        document.title = '[Closed] swarmie';
        document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;color:#8b949e;font-size:14px;">swarmie server has stopped.</div>';
        return;
      case 'event': {
        const evt = msg.event as NormalizedEvent;
        // Route raw terminal output directly to xterm, bypass Zustand
        if (evt.type === 'raw:output') {
          const b64 = (evt.data as { data: string }).data;
          writeToTerminal(evt.sessionId, b64);
        } else {
          addEvent(evt);
        }
        break;
      }
      case 'event:batch': {
        const sid = msg.sessionId as string;
        const all = msg.events as NormalizedEvent[];
        // Split: raw:output goes direct, rest goes to Zustand.
        // Merge all raw:output into a single write so xterm processes
        // all escape sequences atomically — avoids garbled partial redraws.
        const structured: NormalizedEvent[] = [];
        const rawChunks: string[] = [];
        for (const evt of all) {
          if (evt.type === 'raw:output') {
            rawChunks.push((evt.data as { data: string }).data);
          } else {
            structured.push(evt);
          }
        }
        if (rawChunks.length > 0) {
          // Decode all base64 chunks, concatenate, re-encode as single chunk
          const parts: Uint8Array[] = [];
          let totalLen = 0;
          for (const b64 of rawChunks) {
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            parts.push(bytes);
            totalLen += bytes.length;
          }
          const merged = new Uint8Array(totalLen);
          let offset = 0;
          for (const p of parts) {
            merged.set(p, offset);
            offset += p.length;
          }
          // Convert back to base64 for the terminal writer
          let bin = '';
          for (let i = 0; i < merged.length; i++) bin += String.fromCharCode(merged[i]);
          writeToTerminal(sid, btoa(bin));
        }
        if (structured.length > 0) {
          addEventBatch(sid, structured);
        }
        break;
      }
    }
  }, [setSessions, addSession, removeSession, addEvent, addEventBatch]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: WSMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const sendInput = useCallback((sessionId: string, data: string) => {
    send({ type: 'input', sessionId, data });
  }, [send]);

  const sendResize = useCallback((sessionId: string, cols: number, rows: number) => {
    send({ type: 'resize', sessionId, cols, rows });
  }, [send]);

  const createSession = useCallback(async (opts: {
    tool: string;
    args?: string[];
    cwd?: string;
    sessionName?: string;
  }): Promise<{ id: string; name: string; tool: string; status: string } | null> => {
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      if (!res.ok) {
        const err = await res.json();
        console.error('Failed to create session:', err);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.error('Failed to create session:', err);
      return null;
    }
  }, []);

  return { send, sendInput, sendResize, createSession };
}

// Re-export types used in messages — matches server types
interface SessionSummary {
  id: string;
  name: string;
  tool: string;
  status: string;
  startTime: number;
  endTime?: number;
  displayName: string;
  icon: string;
}

interface NormalizedEvent {
  type: string;
  sessionId: string;
  timestamp: number;
  data: Record<string, unknown>;
}
