import { nanoid } from 'nanoid';

export interface ObservabilityFields {
  request_id: string;
  session_id: string | null;
  error_code: string | null;
}

export type ObservabilityLevel = 'info' | 'warn' | 'error';

interface RequestLike {
  id?: string;
  headers?: Record<string, unknown>;
}

interface LogOptions {
  level?: ObservabilityLevel;
  requestId?: string | null;
  sessionId?: string | null;
  errorCode?: string | null;
  details?: Record<string, unknown>;
}

export function resolveRequestId(request?: RequestLike | null): string {
  const header = request?.headers?.['x-request-id'];
  if (typeof header === 'string' && header.trim()) {
    return header.trim();
  }
  if (Array.isArray(header)) {
    const first = header.find((v): v is string => typeof v === 'string' && v.trim().length > 0);
    if (first) return first.trim();
  }
  if (typeof request?.id === 'string' && request.id.length > 0) {
    return request.id;
  }
  return `req_${nanoid(10)}`;
}

export function buildObservabilityFields(options: Pick<LogOptions, 'requestId' | 'sessionId' | 'errorCode'>): ObservabilityFields {
  return {
    request_id: options.requestId ?? `req_${nanoid(10)}`,
    session_id: options.sessionId ?? null,
    error_code: options.errorCode ?? null,
  };
}

export function logObservabilityEvent(event: string, options: LogOptions = {}): void {
  const level = options.level ?? 'info';
  const fields = buildObservabilityFields(options);
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(options.details ?? {}),
    ...fields,
  };
  console.error(`[swarmie][${level}] ${JSON.stringify(payload)}`);
}
