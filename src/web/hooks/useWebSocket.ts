import { useEffect, useRef, useCallback } from 'react';
import { useSessionStore } from './useSessions';

type WSMessage = {
  type: string;
  [key: string]: unknown;
};

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const { setSessions, addSession, removeSession, addEvent, addEventBatch } = useSessionStore();

  const connect = useCallback(() => {
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
      // Reconnect after a delay
      reconnectTimer.current = setTimeout(connect, 2000);
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
        removeSession(msg.sessionId as string);
        break;
      case 'event':
        addEvent(msg.event as NormalizedEvent);
        break;
      case 'event:batch':
        addEventBatch(msg.sessionId as string, msg.events as NormalizedEvent[]);
        break;
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

  return { send, sendInput, sendResize };
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
