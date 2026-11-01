// Silent audio stub (G): implements AudioEngine with no-ops, keeping a short log of what would have played
// (window.__app.sources tells which modules are stubs; `window.__audioStub.log` is handy in tests).
import type { AudioEngine } from '../contracts.js';

export interface StubAudio extends AudioEngine {
  readonly log: string[];
  tension: [number, number];
  paused: boolean;
}

export function createStubAudio(): StubAudio {
  const log: string[] = [];
  const push = (s: string) => {
    log.push(s);
    if (log.length > 64) log.splice(0, log.length - 64);
  };
  const engine: StubAudio = {
    log,
    tension: [0, 0],
    paused: false,
    async unlock() {
      push('unlock');
    },
    sfx(name) {
      push(`sfx:${name}`);
    },
    loop(name) {
      push(`loop:${name}`);
      return { stop: () => push(`stop:${name}`) };
    },
    say(text, opts) {
      push(`say:${opts.voice}:${text}`);
      console.debug(`[say] ${opts.voice} (${opts.mood ?? 'neutral'}): ${text}`);
    },
    crowd(kind) {
      push(`crowd:${kind}`);
    },
    music: {
      start: () => push('music:start'),
      stop: () => push('music:stop'),
      setMood: (m) => push(`music:${m}`),
    },
    musicBox(_at, seconds) {
      // Infinity (Easy Audience) plays until the game stops it; the log shows both ends of the melody
      push(`musicBox:${seconds}`);
      let stopped = false;
      return {
        stop: () => {
          if (stopped) return;
          stopped = true;
          push('stop:musicBox');
        },
      };
    },
    setTension(w, max) {
      engine.tension[0] = w;
      engine.tension[1] = max;
    },
    setListener() {
      /* positional audio needs a real engine */
    },
    setPaused(p) {
      engine.paused = p;
    },
    setMasterVolume() {
      /* silent */
    },
  };
  (window as unknown as { __audioStub?: StubAudio }).__audioStub = engine;
  return engine;
}
