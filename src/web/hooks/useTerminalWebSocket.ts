import { useCallback, useEffect, useRef } from 'react';
import { applyHistorySnapshot, getSessionMeta, writeToTerminal } from '../terminalBus';
import { bytesToBinaryString } from '../base64';
import { useServerStore, LOCAL_SERVER } from './useServers';
import { useSessionStore, type NormalizedEvent } from './useSessions';

type WSMessage = {
  type: string;
  [key: string]: unknown;
};

export interface ClipboardImagePaste {
  mimeType: string;
  filename?: string;
  data: string;
  size: number;
}

const REPLAY_GROUP_BYTES = 64 * 1024;

// Reused across every binary frame — decoding the few session-id header bytes
// is stateless, so allocating a fresh TextDecoder per frame (the hottest path
// in the app) was pure GC pressure during heavy output.
const SID_DECODER = new TextDecoder();

function wsUrlForServer(serverUrl: string): string {
  if (serverUrl === LOCAL_SERVER) {
    return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws?terminal=1`;
  }
  return `${serverUrl.replace(/^http/, 'ws')}/ws?terminal=1`;
}

// Replay batches still arrive as base64-in-JSON (a cold path). Decode each chunk
// to a latin1 binary string at the boundary so the rest of the pipeline only
// ever sees binary strings (the live path delivers those directly).
function writeRawBatch(sessionId: string, events: NormalizedEvent[]): void {
  let group: string[] = [];
  let groupBytes = 0;
  let groupOffsetEnd: number | undefined;

  const flushGroup = () => {
    if (group.length === 0) return;
    writeToTerminal(sessionId, group.join(''), groupOffsetEnd, true);
    group = [];
    groupBytes = 0;
    groupOffsetEnd = undefined;
  };

  for (const event of events) {
    if (event.type !== 'raw:output') continue;
    const data = event.data as { data: string; offsetEnd?: number };
    const bin = atob(data.data);
    group.push(bin);
    groupBytes += bin.length;
    if (typeof data.offsetEnd === 'number') groupOffsetEnd = data.offsetEnd;
    if (groupBytes >= REPLAY_GROUP_BYTES) flushGroup();
  }
  flushGroup();
}

export function useTerminalWebSocket(sessionId: string, isActive: boolean) {
  const serverUrl = useSessionStore((state) =>
    state.sessions.find((session) => session.id === sessionId)?.serverUrl,
  );
  const token = useServerStore((state) =>
    serverUrl ? state.servers.find((server) => server.url === serverUrl)?.token : undefined,
  );

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const subscribedRef = useRef(false);
  const activeRef = useRef(isActive);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  }, []);

  const send = useCallback((msg: WSMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }, []);

  const subscribe = useCallback((ws = wsRef.current) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (subscribedRef.current) return;
    const { highestOffset } = getSessionMeta(sessionId);
    ws.send(JSON.stringify({
      type: 'subscribe',
      sessionId,
      fromOffset: highestOffset > 0 ? highestOffset : undefined,
    }));
    subscribedRef.current = true;
  }, [sessionId]);

  const unsubscribe = useCallback(() => {
    if (!subscribedRef.current) return;
    send({ type: 'unsubscribe', sessionId });
    subscribedRef.current = false;
  }, [send, sessionId]);

  // Live raw output now arrives as a binary WS frame (see the server's
  // encodeRawFrame): [type:1][sidLen:1][sid][offsetEnd:f64 LE][raw bytes].
  // No base64, no JSON — decode the header and hand the raw bytes straight to
  // the terminal as a latin1 binary string.
  const handleBinaryFrame = useCallback((buf: ArrayBuffer) => {
    if (buf.byteLength < 10) return;
    const view = new DataView(buf);
    if (view.getUint8(0) !== 0x01) return; // unknown frame type
    const sidLen = view.getUint8(1);
    const headerEnd = 2 + sidLen + 8;
    if (buf.byteLength < headerEnd) return;
    const sid = SID_DECODER.decode(new Uint8Array(buf, 2, sidLen));
    if (sid !== sessionId) return;
    const offsetEnd = view.getFloat64(2 + sidLen, true);
    const bin = bytesToBinaryString(new Uint8Array(buf, headerEnd));
    writeToTerminal(sessionId, bin, offsetEnd, false);
  }, [sessionId]);

  const handleMessage = useCallback((msg: WSMessage) => {
    switch (msg.type) {
      case 'event': {
        const event = msg.event as NormalizedEvent;
        if (event?.sessionId !== sessionId || event.type !== 'raw:output') return;
        const data = event.data as { data: string; offsetEnd?: number };
        // Legacy JSON raw path (non-terminal subscribers); decode base64 here.
        writeToTerminal(sessionId, atob(data.data), data.offsetEnd);
        break;
      }
      case 'event:batch': {
        if (msg.sessionId !== sessionId) return;
        writeRawBatch(sessionId, (msg.events as NormalizedEvent[]) ?? []);
        break;
      }
      case 'history:snapshot': {
        if (msg.sessionId !== sessionId) return;
        applyHistorySnapshot(sessionId, {
          startOffset: Number(msg.startOffset),
          endOffset: Number(msg.endOffset),
          chunks: Array.isArray(msg.data) ? (msg.data as string[]) : [],
          reachedEarliest: !!msg.reachedEarliest,
        });
        break;
      }
    }
  }, [sessionId]);

  useEffect(() => {
    activeRef.current = isActive;
    if (isActive) {
      subscribe();
    } else {
      unsubscribe();
    }
  }, [isActive, subscribe, unsubscribe]);

  useEffect(() => {
    if (serverUrl === undefined) return;

    let disposed = false;
    const resolvedServerUrl = serverUrl;
    const protocols = token && resolvedServerUrl !== LOCAL_SERVER
      ? [`swarmie-token.${token}`]
      : undefined;

    const connect = () => {
      if (disposed) return;
      clearTimers();
      const ws = protocols
        ? new WebSocket(wsUrlForServer(resolvedServerUrl), protocols)
        : new WebSocket(wsUrlForServer(resolvedServerUrl));
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      subscribedRef.current = false;

      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) {
          ws.close();
          return;
        }
        if (activeRef.current) subscribe(ws);
        const size = lastSizeRef.current;
        if (size) {
          ws.send(JSON.stringify({ type: 'resize', sessionId, cols: size.cols, rows: size.rows }));
        }
        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 15000);
      };

      ws.onmessage = (ev) => {
        if (disposed || wsRef.current !== ws) return;
        const data = ev.data;
        if (typeof data !== 'string') {
          // Binary raw-output frame (ArrayBuffer) — the hot path.
          try { handleBinaryFrame(data as ArrayBuffer); } catch { /* ignore */ }
          return;
        }
        try {
          handleMessage(JSON.parse(data) as WSMessage);
        } catch {
          // ignore malformed messages on this per-terminal stream
        }
      };

      ws.onclose = () => {
        if (disposed || wsRef.current !== ws) return;
        clearTimers();
        wsRef.current = null;
        subscribedRef.current = false;
        reconnectTimerRef.current = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        if (disposed || wsRef.current !== ws) return;
        ws.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      clearTimers();
      const ws = wsRef.current;
      wsRef.current = null;
      subscribedRef.current = false;
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
    };
  }, [clearTimers, handleMessage, handleBinaryFrame, serverUrl, sessionId, subscribe, token]);

  const sendInput = useCallback((data: string) => {
    send({ type: 'input', sessionId, data });
  }, [send, sessionId]);

  const sendResize = useCallback((cols: number, rows: number) => {
    lastSizeRef.current = { cols, rows };
    send({ type: 'resize', sessionId, cols, rows });
  }, [send, sessionId]);

  const sendRedraw = useCallback(() => {
    send({ type: 'redraw', sessionId });
  }, [send, sessionId]);

  // toOffset bounds the reply to [fromOffset, toOffset) — the caller already
  // holds everything newer, so this keeps a page bounded instead of re-sending
  // the whole ring up to the live end.
  const sendLoadHistory = useCallback((fromOffset: number, toOffset?: number) => {
    return send({ type: 'history:load', sessionId, fromOffset, toOffset });
  }, [send, sessionId]);

  const sendClipboardImage = useCallback((image: ClipboardImagePaste) => {
    return send({
      type: 'clipboard:image',
      sessionId,
      mimeType: image.mimeType,
      filename: image.filename,
      size: image.size,
      data: image.data,
    });
  }, [send, sessionId]);

  return { sendInput, sendResize, sendRedraw, sendLoadHistory, sendClipboardImage };
}
