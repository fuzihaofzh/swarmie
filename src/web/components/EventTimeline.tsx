import { useSessionEvents, type NormalizedEvent } from '../hooks/useSessions';

interface EventTimelineProps {
  sessionId: string;
}

const typeLabels: Record<string, string> = {
  'session:start': 'Started',
  'session:end': 'Ended',
  'assistant:message': 'Assistant',
  'assistant:message:delta': 'Delta',
  'tool:use': 'Tool Call',
  'tool:result': 'Tool Result',
  'user:input': 'User Input',
  error: 'Error',
  'raw:output': 'Output',
  'status:change': 'Status',
  metadata: 'Metadata',
};

function getTypeColor(type: string): string {
  switch (type) {
    case 'session:start': return 'var(--success)';
    case 'session:end': return 'var(--text-secondary)';
    case 'assistant:message':
    case 'assistant:message:delta': return 'var(--accent)';
    case 'tool:use':
    case 'tool:result': return 'var(--warning)';
    case 'error': return 'var(--error)';
    default: return 'var(--text-secondary)';
  }
}

export function EventTimeline({ sessionId }: EventTimelineProps) {
  const events = useSessionEvents(sessionId);

  const filteredEvents = events.filter(
    (e) => e.type !== 'raw:output' && e.type !== 'assistant:message:delta',
  );

  if (filteredEvents.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
        No events yet
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {filteredEvents.map((event, i) => (
          <EventItem key={i} event={event} />
        ))}
      </div>
    </div>
  );
}

function EventItem({ event }: { event: NormalizedEvent }) {
  const time = new Date(event.timestamp).toLocaleTimeString();
  const label = typeLabels[event.type] ?? event.type;
  const color = getTypeColor(event.type);

  return (
    <div style={{ display: 'flex', gap: '12px', fontSize: '12px', fontFamily: 'inherit', lineHeight: '20px' }}>
      <span style={{ color: 'var(--text-secondary)', flexShrink: 0, width: '72px', textAlign: 'right' }}>
        {time}
      </span>
      <span style={{ color, flexShrink: 0, width: '80px', fontWeight: 600 }}>
        {label}
      </span>
      <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
        <EventDataSummary event={event} />
      </span>
    </div>
  );
}

function EventDataSummary({ event }: { event: NormalizedEvent }) {
  const data = event.data;

  switch (event.type) {
    case 'session:start':
      return <>{(data as { command?: string[] }).command?.join(' ')}</>;
    case 'session:end':
      return <>Exit code: {(data as { exitCode?: number }).exitCode}</>;
    case 'assistant:message':
      return <>{((data as { text?: string }).text ?? '').slice(0, 120)}</>;
    case 'tool:use':
      return <>{(data as { toolName?: string }).toolName}: {JSON.stringify((data as { input?: unknown }).input).slice(0, 100)}</>;
    case 'tool:result':
      return <>{(data as { toolName?: string }).toolName}: {((data as { output?: string }).output ?? '').slice(0, 100)}</>;
    case 'status:change':
      return <>{(data as { from?: string }).from} &rarr; {(data as { to?: string }).to}</>;
    case 'metadata': {
      const meta = data as { costUsd?: number; durationMs?: number };
      const parts: string[] = [];
      if (meta.costUsd !== undefined) parts.push(`$${meta.costUsd.toFixed(4)}`);
      if (meta.durationMs !== undefined) parts.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
      return <>{parts.join(' \u00b7 ')}</>;
    }
    case 'error':
      return <span style={{ color: 'var(--error)' }}>{(data as { message?: string }).message}</span>;
    default:
      return <>{JSON.stringify(data).slice(0, 100)}</>;
  }
}
