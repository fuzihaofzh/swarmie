/**
 * Play a short bell/chime notification sound using Web Audio API.
 * No external audio files needed.
 */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

export function playBellSound(): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Two-tone chime: high then slightly lower
    for (const [freq, offset] of [[880, 0], [660, 0.12]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.3, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.3);
    }
  } catch {
    // Audio not available — ignore silently
  }
}
