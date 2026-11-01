// Headless verification of the synth (owned by A). Renders every sound — and music excerpts — through an
// OfflineAudioContext running the SAME EngineImpl + master chain the game uses, then measures the output.
//
// Each render has 4 channels: 0/1 = the final output (after compressor + soft limiter), 2/3 = the raw pre-master
// mix (headroom check). Timed actions and the lookahead scheduler run at suspend() points, exactly like the
// live 25 ms timer. Used by src/demos/audio.demo.ts with ?render=1.
import type { CrowdKind, Mood, SfxName, SpectatorKind } from '../contracts.js';
import type { P3 } from './core.js';
import { EngineImpl, LOOKAHEAD, type LoopHandle } from './engine.js';
import type { MusicMood } from './music.js';
import { SFX_NAMES } from './sfx.js';

export interface AudioReportEntry {
  name: string;
  /** Final output peak (both channels, linear). Must stay < 0.99. */
  peak: number;
  /** Final output RMS over the whole render (linear). */
  rms: number;
  nan: boolean;
  /** Pre-master mix peak (linear): > 1 would mean the limiter is doing real work. */
  raw: number;
  /** Loudest 50 ms window, dBFS (short-term loudness proxy used to balance categories). */
  loud: number;
  /** Peak of the last 30 ms of the render (it should have decayed). */
  tail: number;
  /** Seconds until the output stays below -80 dBFS (includes the reverb tail). */
  dur: number;
  /** Active span: first → last 10 ms window within 24 dB of the loudest one (the "dry" length). */
  act: number;
  /**
   * Click detector: crest factor (peak / RMS) of the second difference (a steep high-pass) over the active
   * region. Smooth tonal or noisy material sits around 4–8; an envelope step or truncated waveform spikes far
   * above that. Designed transients (ticks, claps) are legitimately higher.
   */
  hf: number;
  ok: boolean;
  note?: string;
}

const SR = 48000;
const QUANTUM = 128 / SR;
const EYE: P3 = { x: 0, y: 1.2, z: 0 };
const W = (x: number, y: number, z: number): P3 => ({ x: EYE.x + x, y: EYE.y + y, z: EYE.z + z });

/** Positions as in the stage layout (rig-local offsets from the eye). */
export const SOUND_POS = {
  mat: W(0, -0.29, -0.4),
  cupRight: W(0.095, -0.29, -0.42),
  volunteer: W(0.1, -0.27, -0.33),
  plaque: W(-0.25, -0.288, -0.2),
  musicBox: W(-0.36, -0.13, -0.82),
  candle: W(0.36, -0.12, -0.82),
  fuse: W(0, -0.07, -0.92),
  burst: W(0, 0.12, -0.95),
  kit1: W(-0.18, -0.13, -0.66),
  kit2: W(-0.09, -0.13, -0.66),
  magpie: W(0, -0.13, -0.66),
  brock: W(0.09, -0.12, -0.66),
  rabbit: W(0.18, -0.13, -0.66),
  riser: W(0, -0.15, -0.66),
  notebook: W(0.09, -0.17, -0.6),
} as const;

const SFX_AT: Record<SfxName, P3 | null> = {
  tink: SOUND_POS.mat,
  fwip: SOUND_POS.mat,
  shh: SOUND_POS.cupRight,
  poof: SOUND_POS.volunteer,
  cupThunk: SOUND_POS.cupRight,
  cupLift: SOUND_POS.cupRight,
  flare: SOUND_POS.candle,
  fuse: SOUND_POS.fuse,
  bang: SOUND_POS.burst,
  musicBoxWind: SOUND_POS.musicBox,
  uiHover: SOUND_POS.plaque,
  uiPress: SOUND_POS.plaque,
  catch: null,
  rewind: null,
  star: null,
  curtain: null,
  pageFlip: null,
  scribble: SOUND_POS.notebook,
  hop: SOUND_POS.volunteer,
  tick: SOUND_POS.mat,
};
const SFX_SECS: Partial<Record<SfxName, number>> = {
  bang: 3.6, flare: 2.8, curtain: 3, star: 2.6, poof: 2.2, catch: 2, rewind: 1.8, fuse: 2.4,
  musicBoxWind: 1.8, scribble: 2.2, cupLift: 2, tink: 1.8, cupThunk: 1.8,
};

type At = (t: number, fn: () => void) => void;
interface Job {
  name: string;
  secs: number;
  /** Run the scheduler pump every ~24 ms of audio time (music, music box). */
  pumps?: boolean;
  /** Still sounding when the render ends (music excerpts): skip the tail-decay check. */
  continuous?: boolean;
  script: (e: EngineImpl, at: At) => void;
  /** Extra check on the rendered buffer; return a note (and set ok=false) on failure. */
  check?: (buf: AudioBuffer, r: AudioReportEntry, e: EngineImpl) => void;
}

function peakIn(buf: AudioBuffer, from: number, to: number): number {
  const a = buf.getChannelData(0);
  const b = buf.getChannelData(1);
  const i0 = Math.max(0, Math.floor(from * buf.sampleRate));
  const i1 = Math.min(buf.length, Math.floor(to * buf.sampleRate));
  let pk = 0;
  for (let i = i0; i < i1; i++) pk = Math.max(pk, Math.abs(a[i]), Math.abs(b[i]));
  return pk;
}

function activeSpan(L: Float32Array, R: Float32Array): number {
  const win = Math.floor(0.01 * SR);
  const count = Math.floor(L.length / win);
  const e = new Float64Array(count);
  let max = 0;
  for (let w = 0; w < count; w++) {
    let acc = 0;
    for (let i = w * win; i < (w + 1) * win; i++) acc += L[i] * L[i] + R[i] * R[i];
    e[w] = acc;
    if (acc > max) max = acc;
  }
  if (max <= 0) return 0;
  const thr = max * Math.pow(10, -24 / 10);
  let first = -1;
  let last = -1;
  for (let w = 0; w < count; w++) {
    if (e[w] >= thr) {
      if (first < 0) first = w;
      last = w;
    }
  }
  return first < 0 ? 0 : ((last - first + 1) * win) / SR;
}

function hfCrest(L: Float32Array, R: Float32Array, peak: number): number {
  const gate = peak * 0.01;
  let max = 0;
  let sum = 0;
  let count = 0;
  for (const x of [L, R]) {
    for (let i = 2; i < x.length; i++) {
      if (Math.abs(x[i - 1]) < gate) continue;
      const d2 = x[i] - 2 * x[i - 1] + x[i - 2];
      const a = Math.abs(d2);
      if (a > max) max = a;
      sum += d2 * d2;
      count++;
    }
  }
  return count > 0 && sum > 0 ? max / Math.sqrt(sum / count) : 0;
}

function analyse(name: string, buf: AudioBuffer, continuous: boolean): AudioReportEntry {
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const RL = buf.getChannelData(2);
  const RR = buf.getChannelData(3);
  const n = buf.length;
  let peak = 0, raw = 0, sum = 0, last = 0;
  let nan = false;
  for (let i = 0; i < n; i++) {
    const l = L[i], r = R[i], rl = RL[i], rr = RR[i];
    if (!Number.isFinite(l) || !Number.isFinite(r) || !Number.isFinite(rl) || !Number.isFinite(rr)) {
      nan = true;
      continue;
    }
    const a = Math.max(Math.abs(l), Math.abs(r));
    if (a > peak) peak = a;
    if (a > 1e-4) last = i;
    sum += l * l + r * r;
    raw = Math.max(raw, Math.abs(rl), Math.abs(rr));
  }
  const win = Math.floor(0.05 * SR);
  const hop = Math.floor(0.025 * SR);
  let best = 0;
  for (let s = 0; s + win <= n; s += hop) {
    let acc = 0;
    for (let i = s; i < s + win; i++) acc += L[i] * L[i] + R[i] * R[i];
    best = Math.max(best, acc / (2 * win));
  }
  const rms = Math.sqrt(sum / (2 * n));
  const tail = peakIn(buf, buf.duration - 0.03, buf.duration);
  const entry: AudioReportEntry = {
    name,
    peak,
    rms,
    nan,
    raw,
    loud: best > 0 ? 10 * Math.log10(best) : -200,
    tail,
    dur: last / SR,
    act: activeSpan(L, R),
    hf: hfCrest(L, R, peak),
    ok: false,
  };
  entry.ok = !nan && peak < 0.99 && rms > 0 && (continuous || tail < 0.01);
  if (!entry.ok && !entry.note) entry.note = nan ? 'NaN' : peak >= 0.99 ? 'clipping' : rms <= 0 ? 'silent' : 'tail not decayed';
  return entry;
}

async function render(job: Job): Promise<AudioReportEntry> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 4, length: Math.ceil(job.secs * SR), sampleRate: SR });
  const e = new EngineImpl(ctx, { seed: 1234, toDestination: false });
  const merger = ctx.createChannelMerger(4);
  const fin = ctx.createChannelSplitter(2);
  e.core.connectOutput(fin);
  fin.connect(merger, 0, 0);
  fin.connect(merger, 1, 1);
  const pre = ctx.createChannelSplitter(2);
  e.core.mix.connect(pre);
  pre.connect(merger, 0, 2);
  pre.connect(merger, 1, 3);
  ctx.destination.channelInterpretation = 'discrete';
  merger.connect(ctx.destination);
  e.setListenerPose(EYE.x, EYE.y, EYE.z, 0, 0, -1, 0, 1, 0, true);

  // timeline: quantum index → actions (suspend points land mid-quantum so rounding never collides)
  const actions = new Map<number, Array<() => void>>();
  const push = (q: number, fn: () => void): void => {
    const list = actions.get(q);
    if (list) list.push(fn);
    else actions.set(q, [fn]);
  };
  const now: Array<() => void> = [];
  const at: At = (t, fn) => {
    const q = Math.round(t / QUANTUM);
    if (q <= 0) now.push(fn);
    else push(q, fn);
  };
  job.script(e, at);
  if (job.pumps) {
    const step = Math.max(1, Math.round(0.024 / QUANTUM));
    for (let q = step; q * QUANTUM < job.secs; q += step) push(q, () => e.pump(q * QUANTUM + LOOKAHEAD));
  }
  for (const fn of now) fn();
  if (job.pumps) e.pump(LOOKAHEAD);
  const keys = [...actions.keys()].sort((a, b) => a - b);
  for (const q of keys) {
    if (q * QUANTUM >= job.secs - QUANTUM) continue;
    const fns = actions.get(q)!;
    void ctx.suspend((q + 0.5) * QUANTUM).then(() => {
      for (const fn of fns) {
        try {
          fn();
        } catch (err) {
          console.warn(`[audio-report] ${job.name}: action threw`, err);
        }
      }
      void ctx.resume();
    });
  }
  const buf = await ctx.startRendering();
  const entry = analyse(job.name, buf, !!job.continuous);
  try {
    job.check?.(buf, entry, e);
  } catch (err) {
    entry.ok = false;
    entry.note = `check threw: ${String(err)}`;
  }
  e.dispose();
  return entry;
}

const LINES: ReadonlyArray<readonly [SpectatorKind, Mood | undefined, string, P3]> = [
  ['fox', 'accusing', 'I SAW THAT!', SOUND_POS.kit1],
  ['magpie', 'surprised', 'Ooh! Shiny!', SOUND_POS.magpie],
  ['badger', 'proud', 'Make THIS disappear.', SOUND_POS.brock],
  ['rabbit', 'happy', 'Ta-da! Again, again!', SOUND_POS.rabbit],
  ['badger', 'flustered', 'Hmph. Most irregular...', SOUND_POS.brock],
  ['fox', 'curious', 'Where did it go?', SOUND_POS.kit2],
  ['magpie', 'happy', 'Mine! Mine!', SOUND_POS.magpie],
  ['fox', undefined, 'Hello there', SOUND_POS.kit1],
];

const CROWDS: ReadonlyArray<readonly [CrowdKind, number, number]> = [
  ['ooh', 0.6, 2.8],
  ['gasp', 0.8, 2],
  ['giggle', 0.7, 2.2],
  ['applause', 0.4, 4],
  ['applause', 1, 5.6],
  ['ovation', 1, 6.4],
];

function jobs(): Job[] {
  const list: Job[] = [];
  for (const name of SFX_NAMES) {
    list.push({ name: `sfx:${name}`, secs: SFX_SECS[name] ?? 1.5, script: (e) => e.sfx(name, { at: SFX_AT[name] ?? undefined }) });
  }
  list.push({
    name: 'loop:fuse',
    secs: 3.2,
    script: (e, at) => {
      let h: LoopHandle | null = null;
      at(0, () => (h = e.loop('fuse', SOUND_POS.fuse)));
      at(2.0, () => h?.stop());
    },
    check: (buf, r) => {
      if (peakIn(buf, 0.5, 1.9) < 0.01) {
        r.ok = false;
        r.note = 'loop silent';
      }
    },
  });
  list.push({
    name: 'loop:tick',
    secs: 2.8,
    script: (e, at) => {
      let h: LoopHandle | null = null;
      at(0, () => (h = e.loop('tick', SOUND_POS.mat)));
      at(1.6, () => h?.stop());
    },
  });
  for (const [voice, mood, text, pos] of LINES) {
    list.push({
      name: `say:${voice}/${mood ?? 'neutral'} "${text}"`,
      secs: text.length * 0.045 * 1.3 + 1.6,
      script: (e) => e.say(text, pos, voice, mood),
      check: (_buf, r) => {
        // duration ≈ text length × 45 ms (punctuation pauses + the last letter's decay add a little)
        const expect = text.length * 0.045;
        r.note = `spoken ${r.act.toFixed(2)}s vs ${expect.toFixed(2)}s (${text.length} chars)`;
        if (r.act < expect * 0.75 || r.act > expect * 1.3 + 0.12) r.ok = false;
      },
    });
  }
  for (const [kind, I, secs] of CROWDS) {
    list.push({ name: `crowd:${kind}@${I}`, secs, script: (e) => e.crowd(kind, I, SOUND_POS.riser) });
  }
  list.push({ name: 'musicBox:5s', secs: 8.4, pumps: true, script: (e) => e.musicBox(SOUND_POS.musicBox, 5) });
  list.push({
    name: 'musicBox:2s (shortened show)',
    secs: 5,
    pumps: true,
    script: (e) => e.musicBox(SOUND_POS.musicBox, 2),
    check: (buf, r) => {
      const late = peakIn(buf, 3.6, 5); // the last tine (≤ 2.3 s) has rung out by ~3.5 s
      r.note = `active ${r.act.toFixed(2)}s; after 3.6 s ${late.toExponential(1)}`;
      if (late > 0.01) r.ok = false;
    },
  });
  list.push({
    name: 'pad:0→2/5→5/5→0',
    secs: 6,
    script: (e, at) => {
      at(0.1, () => e.setTension(2, 5));
      at(1.6, () => e.setTension(5, 5));
      at(3.6, () => e.setTension(0, 5));
    },
    check: (buf, r) => {
      const after = peakIn(buf, 4.35, 6);
      const during = peakIn(buf, 2.4, 3.5);
      r.note = `peak@5/5 ${during.toFixed(3)}; after all-clear ${after === 0 ? 'exactly 0' : after.toExponential(2)}`;
      if (after !== 0 || during <= 0) r.ok = false;
    },
  });
  const moods: MusicMood[] = ['calm', 'tense', 'triumph'];
  for (const m of moods) {
    list.push({
      name: `music:${m} 6s`,
      secs: 6,
      pumps: true,
      continuous: true,
      script: (e) => {
        e.setMood(m);
        e.music.start();
      },
    });
  }
  const stems: Array<'piano' | 'bass' | 'brushes'> = ['piano', 'bass', 'brushes'];
  for (const s of stems) {
    list.push({
      name: `music:calm stem ${s}`,
      secs: 6,
      pumps: true,
      continuous: true,
      script: (e) => {
        e.music.stems.piano = s === 'piano';
        e.music.stems.bass = s === 'bass';
        e.music.stems.brushes = s === 'brushes';
        e.music.start();
      },
    });
  }
  list.push({
    name: 'music:calm→triumph cadence',
    secs: 10,
    pumps: true,
    continuous: true,
    script: (e, at) => {
      e.music.start();
      at(2.5, () => e.setMood('triumph'));
    },
  });
  list.push({
    name: 'music:stop(1.5)',
    secs: 6.5,
    pumps: true,
    script: (e, at) => {
      e.music.start();
      at(2.5, () => e.music.stop(1.5));
    },
    check: (buf, r) => {
      const after = peakIn(buf, 5.6, 6.5);
      r.note = `after stop+reverb ${after.toExponential(2)}`;
      if (after > 1e-3) r.ok = false;
    },
  });
  list.push({
    name: 'pause gain: music → pause → resume',
    secs: 4.5,
    pumps: true,
    continuous: true,
    script: (e, at) => {
      e.music.start();
      at(2.0, () => e.setPauseGain(0, 0.2));
      at(3.0, () => e.setPauseGain(1, 0.3));
    },
    check: (buf, r) => {
      const paused = peakIn(buf, 2.25, 2.95);
      const back = peakIn(buf, 3.6, 4.4);
      r.note = `while paused ${paused === 0 ? 'exactly 0' : paused.toExponential(2)}; after resume ${back.toFixed(3)}`;
      if (paused !== 0 || back <= 0) r.ok = false;
    },
  });
  list.push({
    name: 'mix:stress (everything at once + 64 cup thunks)',
    secs: 7,
    pumps: true,
    continuous: true,
    script: (e, at) => {
      e.music.start();
      e.setTension(3, 5);
      at(0.4, () => e.crowd('ovation', 1, SOUND_POS.riser));
      at(0.6, () => e.say('I SAW THAT!', SOUND_POS.kit1, 'fox', 'accusing'));
      at(0.9, () => e.sfx('bang', { at: SOUND_POS.burst }));
      at(1.0, () => e.sfx('poof', { at: SOUND_POS.volunteer }));
      at(1.05, () => e.crowd('gasp', 1, SOUND_POS.riser));
      at(1.1, () => e.musicBox(SOUND_POS.musicBox, 5));
      // far more voices than the 24-voice cap: the oldest low-priority ones must be stolen, nothing may clip
      for (let i = 0; i < 64; i++) at(1.2 + i * 0.012, () => e.sfx('cupThunk', { at: i % 3 ? SOUND_POS.cupRight : SOUND_POS.mat, pitch: 1 + (i % 6) * 0.08 }));
      at(1.5, () => e.sfx('catch'));
      at(1.6, () => e.sfx('star'));
    },
    check: (_buf, r, e) => {
      const s = e.core.stats;
      r.note = `peak voices ${s.peakVoices}/24, stolen ${s.stolen}, refused ${s.refused}, stereo fallbacks ${s.fallbackPans}`;
      if (s.peakVoices > 24) r.ok = false;
    },
  });
  return list;
}

/** Render and measure everything. `onEntry` fires as each result arrives (progressive UI). */
export async function renderAudioReport(onEntry?: (e: AudioReportEntry, i: number, n: number) => void): Promise<AudioReportEntry[]> {
  const list = jobs();
  const out: AudioReportEntry[] = [];
  for (let i = 0; i < list.length; i++) {
    let entry: AudioReportEntry;
    try {
      entry = await render(list[i]);
    } catch (err) {
      entry = { name: list[i].name, peak: 0, rms: 0, nan: false, raw: 0, loud: -200, tail: 0, dur: 0, act: 0, hf: 0, ok: false, note: `render failed: ${String(err)}` };
    }
    out.push(entry);
    onEntry?.(entry, i, list.length);
  }
  return out;
}
