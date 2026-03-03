import { useSessionEvents, type NormalizedEvent } from '../hooks/useSessions';

interface StructuredViewProps {
  sessionId: string;
}

export function StructuredView({ sessionId }: StructuredViewProps) {
  const events = useSessionEvents(sessionId);

  const conversationEvents = events.filter(
    (e) =>
      e.type === 'assistant:message' ||
      e.type === 'tool:use' ||
      e.type === 'tool:result' ||
      e.type === 'user:input' ||
      e.type === 'error',
  );

  if (conversationEvents.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
        No structured messages yet. Structured view requires <code style={{ margin: '0 4px', background: 'var(--header-bg)', padding: '2px 6px', borderRadius: '3px' }}>-p</code> mode.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {conversationEvents.map((event, i) => (
          <ConversationBlock key={i} event={event} />
        ))}
      </div>
    </div>
  );
}

function ConversationBlock({ event }: { event: NormalizedEvent }) {
  const blockStyle: React.CSSProperties = {
    borderRadius: '8px',
    border: '1px solid var(--border)',
    padding: '14px',
  };

  switch (event.type) {
    case 'assistant:message':
      return (
        <div style={{ ...blockStyle, background: 'var(--header-bg)' }}>
          <div style={{ fontSize: '11px', color: 'var(--accent)', marginBottom: '8px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
            Assistant
          </div>
          <div style={{ fontSize: '13px', color: 'var(--fg)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
            {(event.data as { text: string }).text}
          </div>
        </div>
      );

    case 'tool:use':
      return (
        <div style={{ ...blockStyle, background: 'var(--drawer-bg)' }}>
          <div style={{ fontSize: '11px', color: 'var(--warning)', marginBottom: '8px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
            Tool: {(event.data as { toolName: string }).toolName}
          </div>
          <pre style={{ fontSize: '12px', color: 'var(--text-secondary)', overflowX: 'auto', margin: 0, fontFamily: 'inherit' }}>
            {JSON.stringify((event.data as { input: unknown }).input, null, 2)}
          </pre>
        </div>
      );

    case 'tool:result':
      return (
        <div style={{ ...blockStyle, background: 'var(--drawer-bg)' }}>
          <div style={{ fontSize: '11px', color: 'var(--warning)', marginBottom: '8px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
            Result: {(event.data as { toolName: string }).toolName}
          </div>
          <pre style={{ fontSize: '12px', color: 'var(--text-secondary)', overflowX: 'auto', maxHeight: '160px', overflowY: 'auto', margin: 0, fontFamily: 'inherit' }}>
            {(event.data as { output: string }).output}
          </pre>
        </div>
      );

    case 'user:input':
      return (
        <div style={{ ...blockStyle, background: 'var(--header-bg)' }}>
          <div style={{ fontSize: '11px', color: 'var(--success)', marginBottom: '8px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
            User
          </div>
          <div style={{ fontSize: '13px', color: 'var(--fg)' }}>
            {(event.data as { text: string }).text}
          </div>
        </div>
      );

    case 'error':
      return (
        <div style={{ ...blockStyle, background: 'var(--header-bg)', borderColor: 'var(--error)' }}>
          <div style={{ fontSize: '11px', color: 'var(--error)', marginBottom: '8px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
            Error
          </div>
          <div style={{ fontSize: '13px', color: 'var(--fg)' }}>
            {(event.data as { message: string }).message}
          </div>
        </div>
      );

    default:
      return null;
  }
}
