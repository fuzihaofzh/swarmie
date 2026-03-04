import { useEffect, useState } from 'react';

const SPINNER_CHARS = ['✻', '✳', '✺', '✹', '✷', '✶'];

function Spinner() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setIdx((i) => (i + 1) % SPINNER_CHARS.length), 150);
    return () => clearInterval(id);
  }, []);
  return <span className="status-spinner">{SPINNER_CHARS[idx]}</span>;
}

export function StatusIndicator({ status }: { status: string }) {
  if (status === 'waiting_input') {
    return <span className="status-bell">&#x1F514;</span>;
  }
  if (status === 'running' || status === 'thinking' || status === 'tool_executing') {
    return <Spinner />;
  }
  return <span className={`status-dot ${status}`} />;
}
