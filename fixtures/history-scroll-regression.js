// Paste into DevTools on the disposable :33219 page after reloading a terminal
// with long history. Repeat with Chrome CPU throttling and concurrent output.
// Checks the real wheel/scroll/replay path; never run against the user's :3200.
async function historyScrollRegression({ durationMs = 22000, intervalMs = 16, deltaY = -600 } = {}) {
  if (location.port !== '33219') throw new Error('Use the disposable :33219 server');
  const root = document.querySelector('.terminal-view-active .xterm');
  if (!root || !window.__swarmieTerm) throw new Error('Open a terminal first');
  const viewport = root.querySelector('.xterm-viewport');
  const started = performance.now();
  let wheels = 0;
  let loadingSince = null;
  let mismatchSince = null;
  let maxLoadingMs = 0;
  let maxMismatchMs = 0;
  let completedLoads = 0;
  const sample = () => {
    const now = performance.now();
    const loading = !!document.querySelector('.terminal-view-active .terminal-history-overlay');
    if (loading) loadingSince ??= now;
    else if (loadingSince !== null) {
      maxLoadingMs = Math.max(maxLoadingMs, now - loadingSince);
      completedLoads++;
      loadingSince = null;
    }
    // Locate this terminal even if more than one tab remains mounted.
    const active = window.__swarmieTerm().find(t => {
      const rowHeight = root.querySelector('.xterm-screen').clientHeight / t.rows;
      return Math.abs(viewport.scrollHeight - t.bufferLines * rowHeight) < rowHeight * 2;
    });
    const mismatched = !loading && viewport.scrollTop === 0 && active?.viewportY > 0;
    if (mismatched) {
      mismatchSince ??= now;
      maxMismatchMs = Math.max(maxMismatchMs, now - mismatchSince);
    } else mismatchSince = null;
  };
  const monitor = setInterval(sample, 20);
  try {
    while (performance.now() - started < durationMs) {
      root.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
      wheels++;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    sample();
    return { wheels, completedLoads, maxLoadingMs, maxMismatchMs,
      stuck: loadingSince !== null || maxMismatchMs > 1000,
      terms: window.__swarmieTerm() };
  } finally {
    clearInterval(monitor);
  }
}
