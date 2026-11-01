// Headless verification of the synth (owned by A). Renders every sound — and music excerpts — through an
// OfflineAudioContext running the SAME EngineImpl + master chain the game uses, then measures the output.
//
// Each render has 6 channels: 0/1 = the final output (after compressor + soft limiter), 2/3 = the pre-master mix
// (headroom), 4/5 = the dry bus sum (no reverb, no master): onsets and endings are measured there, where the room
// cannot mask a click. Every GainNode the engine creates is instrumented and its automation calls are replayed
// through a model of the Web Audio timeline, so EVERY envelope is audited, not just the first one: the steepest rise
// and fall (as a full-scale ramp time, must be >= 5 ms), the largest step, and anything scheduled into the past
// (which would start mid-envelope = a click). Timed actions and the lookahead scheduler run at suspend() points,
// exactly like the live 25 ms timer. Used by src/demos/audio.demo.ts with ?render=1.
import type { CrowdKind, Mood, SfxName, SpectatorKind } from '../contracts.js';
import type { P3 } from './core.js';
import { envAHD, hold, PopWriter, TargetChain } from './dsp.js';
import { EngineImpl, LOOKAHEAD, type LoopHandle } from './engine.js';
import { MB_STOP_FADE, type MusicMood } from './music.js';
import { SFX_NAMES } from './sfx.js';

export interface AudioReportEntry {
  name: string;
  /** Final output peak (both channels, linear). Must stay < 0.99. */
  peak: number;
  /** Final output RMS over the whole render (linear). Must be > 0. */
  rms: number;
  nan: boolean;
  /** Pre-master mix peak (linear): > 1 means the compressor/limiter did real work. */
  raw: number;
  /** Loudest 50 ms window of the final output, dBFS (short-term loudness proxy used to balance categories). */
  loud: number;
  /** K-weighted momentary loudness (ITU-R BS.1770, 400 ms windows), loudest window, LUFS. */
  lufs: number;
  /** K-weighted loudness of the whole render (meaningful for continuous renders: the music bed), LUFS. */
  lufsI: number;
  /** DC offset: |mean| of the final output (worst channel), linear. Must stay < 1e-3 (-60 dBFS). */
  dc: number;
  /** Peak of the last 30 ms of the render (one-shots must have decayed). */
  tail: number;
  /** Seconds until the output stays below -80 dBFS (includes the reverb tail). */
  dur: number;
  /** Active span: first → last 10 ms window within 24 dB of the loudest one (the "dry" length). */
  act: number;
  /** Crest factor of the second difference over the active region (info: designed transients sit higher). */
  hf: number;
  /** Dry onset: peak of the first 1 ms after the first sound / peak of the first 50 ms. A step ≈ 1; a 5 ms ramp ≤ 0.2. */
  onset: number;
  /** Dry ending: peak of the last 1 ms before silence / dry peak. A truncated sound ends high; a glide ends ≈ 0. */
  end: number;
  /** Envelope audit: steepest gain RISE anywhere in the render, as the time a full-scale ramp would take (ms). */
  atk: number;
  /** Envelope audit: steepest gain FALL, same unit (ms). */
  rel: number;
  /** Envelope audit: largest instantaneous gain step, relative to that param's peak. */
  jump: number;
  /** Automation events or source starts scheduled earlier than the audio clock at the call (late = click). */
  late: number;
  /** Automated gain params audited in this render. */
  params: number;
  ok: boolean;
  note?: string;
}

/** Pass thresholds (exported so the demo can print them). */
export const LIMITS = {
  peak: 0.99,
  dc: 1e-3,
  rampMs: 4.95, // >= 5 ms (float tolerance)
  jump: 1e-3,
  onset: 0.35,
  end: 0.01,
  tail: 0.01,
} as const;

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
  musicBox: W(-0.3, -0.065, -0.84),
  candle: W(0.3, -0.065, -0.84),
  fuse: W(0, -0.02, -0.92),
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
  /** No pumps inside [from, to): a main-thread stall (seconds). */
  stall?: readonly [number, number];
  /** Still sounding when the render ends (music excerpts): skip the tail-decay and ending checks. */
  continuous?: boolean;
  script: (e: EngineImpl, at: At) => void;
  /** Extra check on the rendered buffer; set r.ok = false (and a note) on failure. */
  check?: (buf: AudioBuffer, r: AudioReportEntry, e: EngineImpl) => void;
}

// ----------------------------------------------------------------------------------------- measuring

function peakIn(buf: AudioBuffer, from: number, to: number, ch0 = 0): number {
  const a = buf.getChannelData(ch0);
  const b = buf.getChannelData(ch0 + 1);
  const i0 = Math.max(0, Math.floor(from * buf.sampleRate));
  const i1 = Math.min(buf.length, Math.floor(to * buf.sampleRate));
  let pk = 0;
  for (let i = i0; i < i1; i++) pk = Math.max(pk, Math.abs(a[i]), Math.abs(b[i]));
  return pk;
}

function energyIn(x: Float32Array, from: number, to: number): number {
  const i0 = Math.max(0, Math.floor(from * SR));
  const i1 = Math.min(x.length, Math.floor(to * SR));
  let s = 0;
  for (let i = i0; i < i1; i++) s += x[i] * x[i];
  return s;
}

/** Interaural level difference R vs L on the dry channels, dB (positive = louder in the right ear). */
function ild(buf: AudioBuffer, from: number, to: number): number {
  const l = energyIn(buf.getChannelData(4), from, to);
  const r = energyIn(buf.getChannelData(5), from, to);
  return 10 * Math.log10((r + 1e-20) / (l + 1e-20));
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

/** ITU-R BS.1770 K-weighting at 48 kHz: high-shelf pre-filter, then the RLB high-pass. */
function kWeight(x: Float32Array): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = 1.53512485958697 * x[i] - 2.69169618940638 * x1 + 1.19839281085285 * x2 + 1.69065929318241 * y1 - 0.73248077421585 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  x1 = x2 = y1 = y2 = 0;
  for (let i = 0; i < y.length; i++) {
    const xi = y[i];
    const v = xi - 2 * x1 + x2 + 1.99004745483398 * y1 - 0.99007225036621 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/** [momentary max (400 ms windows, 100 ms hop), whole render] in LUFS. */
function loudnessK(L: Float32Array, R: Float32Array): [number, number] {
  const kl = kWeight(L);
  const kr = kWeight(R);
  const n = kl.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + kl[i] * kl[i] + kr[i] * kr[i];
  const lufs = (ms: number): number => (ms > 0 ? -0.691 + 10 * Math.log10(ms) : -200);
  const win = Math.floor(0.4 * SR);
  const hop = Math.floor(0.1 * SR);
  let best = 0;
  for (let s = 0; s + win <= n; s += hop) best = Math.max(best, (cum[s + win] - cum[s]) / win);
  return [lufs(best), lufs(cum[n] / Math.max(1, n))];
}

const THRESH = 1e-5; // -100 dBFS: "sound present" for the dry onset / ending checks

/** Peak of the first 1 ms after the dry signal starts, over the peak of its first 50 ms. */
function onsetRatio(L: Float32Array, R: Float32Array): number {
  let i0 = -1;
  for (let i = 0; i < L.length; i++) {
    if (Math.abs(L[i]) > THRESH || Math.abs(R[i]) > THRESH) {
      i0 = i;
      break;
    }
  }
  if (i0 < 0) return 0;
  const a = range(L, R, i0, i0 + Math.round(0.001 * SR));
  const b = range(L, R, i0, i0 + Math.round(0.05 * SR));
  return b > 0 ? a / b : 0;
}

/** Peak of the last 1 ms before the dry signal falls silent for good, over the dry peak. */
function endRatio(L: Float32Array, R: Float32Array): number {
  let e = -1;
  for (let i = L.length - 1; i >= 0; i--) {
    if (Math.abs(L[i]) > THRESH || Math.abs(R[i]) > THRESH) {
      e = i;
      break;
    }
  }
  if (e < 0) return 0;
  const pk = range(L, R, 0, L.length);
  return pk > 0 ? range(L, R, e - Math.round(0.001 * SR), e + 1) / pk : 0;
}

function range(L: Float32Array, R: Float32Array, i0: number, i1: number): number {
  let pk = 0;
  for (let i = Math.max(0, i0); i < Math.min(L.length, i1); i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  return pk;
}

/** Butterworth section Qs for an 8th-order filter: 1 / (2 cos(π(2k−1)/16)), k = 1..4. */
const BW8_Q = [0.5098, 0.6013, 0.9, 2.5629];

/**
 * Click detector, independent of the envelope audit: the dry channels (4/5) through an 8th-order Butterworth
 * high-pass at 18 kHz, peak |y| inside [from, to). A step or a truncated waveform is broadband and shows up here;
 * smooth envelopes on partials below ~11 kHz (the music box) stay >= 34 dB down. Filtered from t = 0 (no warm-up).
 */
function hfPeak(buf: AudioBuffer, from: number, to: number): number {
  const w = (2 * Math.PI * 18000) / SR;
  const c = Math.cos(w);
  // RBJ high-pass biquads, normalised by a0: [b0, b1, b2, a1, a2] per section
  const co = new Float64Array(BW8_Q.length * 5);
  for (let k = 0; k < BW8_Q.length; k++) {
    const al = Math.sin(w) / (2 * BW8_Q[k]);
    const a0 = 1 + al;
    co.set([(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, (-2 * c) / a0, (1 - al) / a0], k * 5);
  }
  const st = new Float64Array(BW8_Q.length * 4); // per section: x1, x2, y1, y2
  const i0 = Math.max(0, Math.floor(from * SR));
  const i1 = Math.min(buf.length, Math.floor(to * SR));
  let pk = 0;
  for (const ch of [4, 5]) {
    const x = buf.getChannelData(ch);
    st.fill(0);
    for (let i = 0; i < i1; i++) {
      let v = x[i];
      for (let k = 0; k < BW8_Q.length; k++) {
        const c5 = k * 5;
        const s4 = k * 4;
        const y = co[c5] * v + co[c5 + 1] * st[s4] + co[c5 + 2] * st[s4 + 1] - co[c5 + 3] * st[s4 + 2] - co[c5 + 4] * st[s4 + 3];
        st[s4 + 1] = st[s4];
        st[s4] = v;
        st[s4 + 3] = st[s4 + 2];
        st[s4 + 2] = y;
        v = y;
      }
      if (i >= i0) pk = Math.max(pk, Math.abs(v));
    }
  }
  return pk;
}

/** Dry (no reverb, no master) peak inside [from, to): what the voices themselves still play. */
const dryPeak = (buf: AudioBuffer, from: number, to: number): number => peakIn(buf, from, to, 4);

/**
 * Chrome's HRTF panner delays its output by its FFT latency and rings for its impulse response: measured, a source's
 * last sample leaves the panner ~10.7 ms after it went in (then the node's output is zeroed). "After the fade" checks
 * start this much later.
 */
const PANNER_TAIL = 0.02;

/** Quietest 100 ms window (dry peak) inside [from, to): a hole in a continuous part (a phrase seam) shows up here. */
function dryFloor(buf: AudioBuffer, from: number, to: number): number {
  let lo = Infinity;
  for (let t = from; t + 0.1 <= to; t += 0.05) lo = Math.min(lo, dryPeak(buf, t, t + 0.1));
  return lo;
}

// ------------------------------------------------------------------------------------ envelope audit

type OpKind = 'set' | 'lin' | 'exp' | 'tgt' | 'hold' | 'cancel' | 'curve';
interface Op {
  k: OpKind;
  t: number;
  v: number;
  tau: number;
  /** Audio clock when the call was made. */
  at: number;
}
interface ParamRec {
  born: number;
  init: number;
  ops: Op[];
}
interface TEv {
  /** 'held' = the marker Chrome's cancelAndHoldAtTime leaves over a running setTarget. */
  k: 'set' | 'lin' | 'exp' | 'tgt' | 'held';
  t: number;
  v: number;
  tau: number;
}
interface Seg {
  k: 'const' | 'lin' | 'exp' | 'tgt';
  t0: number;
  v0: number;
  t1: number;
  v1: number;
  tau: number;
  /** setTarget segments: the value approached. */
  target: number;
}
interface Audit {
  rise: number;
  fall: number;
  jump: number;
  late: number;
  params: number;
  flags: Set<string>;
}

const PARAM_VALUE = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value');

/** Shadow one AudioParam's automation methods (and `.value`) with recording wrappers. */
function watchParam(p: AudioParam, ctx: BaseAudioContext, recs: ParamRec[]): void {
  const rec: ParamRec = { born: ctx.currentTime, init: p.defaultValue, ops: [] };
  recs.push(rec);
  const P = AudioParam.prototype;
  const log = (k: OpKind, t: number, v: number, tau = 0): void => {
    rec.ops.push({ k, t, v, tau, at: ctx.currentTime });
  };
  const def = (value: unknown): PropertyDescriptor => ({ configurable: true, writable: true, value });
  const props: PropertyDescriptorMap = {
    setValueAtTime: def((v: number, t: number) => (log('set', t, v), P.setValueAtTime.call(p, v, t))),
    linearRampToValueAtTime: def((v: number, t: number) => (log('lin', t, v), P.linearRampToValueAtTime.call(p, v, t))),
    exponentialRampToValueAtTime: def((v: number, t: number) => (log('exp', t, v), P.exponentialRampToValueAtTime.call(p, v, t))),
    setTargetAtTime: def((v: number, t: number, tau: number) => (log('tgt', t, v, tau), P.setTargetAtTime.call(p, v, t, tau))),
    cancelAndHoldAtTime: def((t: number) => (log('hold', t, 0), P.cancelAndHoldAtTime.call(p, t))),
    cancelScheduledValues: def((t: number) => (log('cancel', t, 0), P.cancelScheduledValues.call(p, t))),
    setValueCurveAtTime: def((c: number[], t: number, d: number) => (log('curve', t, 0, d), P.setValueCurveAtTime.call(p, c, t, d))),
  };
  if (PARAM_VALUE?.get && PARAM_VALUE.set) {
    const { get, set } = PARAM_VALUE;
    props.value = {
      configurable: true,
      get: () => get.call(p),
      set: (v: number) => {
        log('set', ctx.currentTime, v);
        set.call(p, v);
      },
    };
  }
  Object.defineProperties(p, props);
}

/** Count source starts scheduled into the past. */
function watchSource<T extends AudioScheduledSourceNode>(s: T, ctx: BaseAudioContext, late: { n: number }): T {
  const start = s.start;
  Object.defineProperty(s, 'start', {
    configurable: true,
    writable: true,
    value: (when?: number, ...rest: number[]) => {
      if (typeof when === 'number' && when > 0 && when < ctx.currentTime - 1e-7) late.n++;
      return (start as (...a: unknown[]) => void).call(s, when, ...rest);
    },
  });
  return s;
}

/** Route every gain / source the engine creates on `ctx` through the recorders. */
function instrument(ctx: OfflineAudioContext, recs: ParamRec[], late: { n: number }): void {
  const C = ctx as unknown as Record<string, unknown>;
  const createGain = ctx.createGain.bind(ctx);
  C.createGain = () => {
    const g = createGain();
    watchParam(g.gain, ctx, recs);
    return g;
  };
  const createOsc = ctx.createOscillator.bind(ctx);
  C.createOscillator = () => watchSource(createOsc(), ctx, late);
  const createBuf = ctx.createBufferSource.bind(ctx);
  C.createBufferSource = () => watchSource(createBuf(), ctx, late);
  const createConst = ctx.createConstantSource.bind(ctx);
  C.createConstantSource = () => watchSource(createConst(), ctx, late);
}

/** Insert like Chromium's AudioParamTimeline: sorted by time, after equal times; same time + same type replaces. */
function insertEv(evs: TEv[], e: TEv): void {
  let i = evs.length;
  while (i > 0 && evs[i - 1].t > e.t) i--;
  for (let j = i - 1; j >= 0 && evs[j].t === e.t; j--) {
    if (evs[j].k === e.k) {
      evs[j] = e;
      return;
    }
  }
  evs.splice(i, 0, e);
}

/**
 * The piecewise curve Chrome renders from `evs`: a set holds its value, a setTarget approaches its target from the
 * curve's value at its start, a ramp runs from the PREVIOUS event to itself, and — measured, see dsp.ts hold() — a
 * ramp right after a 'held' marker starts from 0. (A ramp straight after a setTarget has version-dependent semantics
 * and is flagged: the engine always pins the curve with a set first.) `jumps` receives every instantaneous change
 * after the param was created.
 */
function segments(evs: readonly TEv[], init: number, born: number, flags: Set<string> | null, jumps: number[] | null): Seg[] {
  const out: Seg[] = [];
  let prevT = born;
  let prevV = init;
  let tgt: { target: number; tau: number } | null = null; // the curve since prevT is a setTarget approach
  let held = false;
  const close = (t1: number): number => {
    const v1 = tgt ? tgt.target + (prevV - tgt.target) * Math.exp(-Math.max(0, t1 - prevT) / tgt.tau) : prevV;
    if (t1 > prevT) out.push({ k: tgt ? 'tgt' : 'const', t0: prevT, v0: prevV, t1, v1, tau: tgt ? tgt.tau : 0, target: tgt ? tgt.target : prevV });
    return v1;
  };
  for (const e of evs) {
    if (e.k === 'set' || e.k === 'held') {
      const before = close(e.t);
      const v = e.k === 'held' ? before : e.v;
      if (jumps && e.t > born + 1e-9) jumps.push(Math.abs(v - before));
      prevT = e.t;
      prevV = v;
      tgt = null;
      held = e.k === 'held';
    } else if (e.k === 'tgt') {
      const v0 = close(e.t);
      prevT = e.t;
      prevV = v0;
      tgt = { target: e.v, tau: Math.max(1e-6, e.tau) };
      held = false;
    } else {
      if (tgt && flags) flags.add('ramp directly after setTarget');
      if (held) {
        // Chrome starts this ramp from 0: the held value is lost (a cut)
        if (flags) flags.add('ramp after cancelAndHoldAtTime without a pinning setValueAtTime');
        if (jumps && e.t > born + 1e-9) jumps.push(Math.abs(prevV));
        prevV = 0;
      }
      tgt = null;
      held = false;
      if (e.t > prevT) out.push({ k: e.k, t0: prevT, v0: prevV, t1: e.t, v1: e.v, tau: 0, target: e.v });
      else if (jumps && e.t > born + 1e-9) jumps.push(Math.abs(e.v - prevV));
      prevT = Math.max(prevT, e.t);
      prevV = e.v;
    }
  }
  close(Infinity);
  return out;
}

function valueOn(s: Seg, t: number): number {
  if (t <= s.t0) return s.v0;
  switch (s.k) {
    case 'const':
      return s.v0;
    case 'lin':
      return t >= s.t1 ? s.v1 : s.v0 + ((s.v1 - s.v0) * (t - s.t0)) / (s.t1 - s.t0);
    case 'exp':
      return t >= s.t1 ? s.v1 : s.v0 * Math.pow(s.v1 / s.v0, (t - s.t0) / (s.t1 - s.t0));
    default:
      return s.target + (s.v0 - s.target) * Math.exp(-(Math.min(t, s.t1) - s.t0) / s.tau);
  }
}

function evalAt(evs: readonly TEv[], init: number, born: number, t: number): number {
  const segs = segments(evs, init, born, null, null);
  if (!segs.length || t < segs[0].t0) return init;
  for (const s of segs) if (t < s.t1) return valueOn(s, t);
  return segs[segs.length - 1].v1;
}

/**
 * Replay a param's calls in call order (holds and cancels act on the timeline as it was at the call) → the final
 * timeline. `callJumps` receives retroactive changes: the value at the moment of a call, before vs. after it (a ramp
 * whose start lies in the past re-shapes the present = a step that the final timeline alone would hide).
 */
function timeline(rec: ParamRec, flags: Set<string>, callJumps: number[]): TEv[] {
  const evs: TEv[] = [];
  for (const op of rec.ops) {
    const live = op.at > rec.born + 1e-9; // calls made after creation can change what is sounding
    const before = live ? evalAt(evs, rec.init, rec.born, op.at) : 0;
    switch (op.k) {
      case 'set':
      case 'lin':
      case 'exp':
      case 'tgt':
        insertEv(evs, { k: op.k, t: op.t, v: op.v, tau: op.tau });
        break;
      case 'cancel': {
        let i = 0;
        while (i < evs.length && evs[i].t < op.t) i++;
        evs.length = i;
        break;
      }
      case 'hold': {
        // Chromium: a ramp spanning t is cut at t (+ a set there); a setTarget running at t leaves a 'held' marker;
        // otherwise nothing is inserted (a later ramp then starts from the previous event)
        const v = evalAt(evs, rec.init, rec.born, op.t);
        let i = 0;
        while (i < evs.length && evs[i].t < op.t) i++;
        const prev = i > 0 ? evs[i - 1] : null;
        const prevT = prev ? prev.t : rec.born;
        const spanning = i < evs.length && (evs[i].k === 'lin' || evs[i].k === 'exp') && prevT < op.t ? evs[i] : null;
        evs.length = i;
        if (spanning) {
          evs.push({ k: spanning.k, t: op.t, v, tau: 0 });
          evs.push({ k: 'set', t: op.t, v, tau: 0 });
        } else if (prev && prev.k === 'tgt' && prev.t < op.t) {
          evs.push({ k: 'held', t: op.t, v, tau: 0 });
        }
        break;
      }
      case 'curve':
        flags.add('setValueCurveAtTime (not audited)');
        break;
    }
    if (live) callJumps.push(Math.abs(evalAt(evs, rec.init, rec.born, op.at) - before));
  }
  return evs;
}

/** Audit every recorded gain param: steepest rise / fall (full-scale ramp time), largest step, late calls. */
function auditParams(recs: ParamRec[], lateStarts: number): Audit {
  const a: Audit = { rise: Infinity, fall: Infinity, jump: 0, late: lateStarts, params: 0, flags: new Set() };
  for (const rec of recs) {
    for (const op of rec.ops) if (op.k !== 'hold' && op.k !== 'cancel' && op.t < op.at - 1e-7) a.late++;
    const jumps: number[] = [];
    const evs = timeline(rec, a.flags, jumps);
    const segs = segments(evs, rec.init, rec.born, a.flags, jumps);
    let moving = false;
    let peak = 0;
    for (const s of segs) {
      if (s.k !== 'const' && (s.v1 !== s.v0 || s.target !== s.v0)) moving = true;
      peak = Math.max(peak, Math.abs(s.v0), Math.abs(s.v1));
    }
    for (const e of evs) if (e.k === 'set' && e.t > rec.born + 1e-9) peak = Math.max(peak, Math.abs(e.v));
    if (peak <= 0) continue;
    let biggest = 0;
    for (const j of jumps) biggest = Math.max(biggest, j);
    if (biggest > 0) moving = true;
    if (!moving) continue; // a static mixing gain
    a.params++;
    a.jump = Math.max(a.jump, biggest / peak);
    for (const s of segs) {
      let slope = 0; // signed, per second, at the steepest point of the segment
      if (s.k === 'lin') slope = (s.v1 - s.v0) / (s.t1 - s.t0);
      else if (s.k === 'exp') {
        const big = Math.max(Math.abs(s.v0), Math.abs(s.v1));
        slope = (Math.sign(s.v1 - s.v0) * big * Math.abs(Math.log(Math.abs(s.v1 / s.v0)))) / (s.t1 - s.t0);
      } else if (s.k === 'tgt') {
        slope = (s.target - s.v0) / s.tau; // steepest at the start of the approach
      }
      if (slope === 0 || !Number.isFinite(slope)) continue;
      const ms = (peak / Math.abs(slope)) * 1000;
      if (slope > 0) a.rise = Math.min(a.rise, ms);
      else a.fall = Math.min(a.fall, ms);
    }
  }
  return a;
}

/** The value a param actually had at `t`: the timeline as it stood at `t` (later calls cannot rewrite the past). */
function renderedAt(rec: ParamRec, t: number): number {
  const ops = rec.ops.filter((op) => op.at <= t + 1e-9);
  return evalAt(timeline({ born: rec.born, init: rec.init, ops }, new Set(), []), rec.init, rec.born, t);
}

type Pattern = readonly [name: string, prior: (p: AudioParam) => void, op: ((p: AudioParam, now: number) => void) | null];

/**
 * Ground truth for the envelope audit: render a constant 1 through a gain driven by each automation pattern (raw
 * Chrome edge cases and the engine's own helpers) and compare the model's curve with the rendered samples.
 */
async function auditModelSelfTest(): Promise<AudioReportEntry> {
  const T = 1.0;
  const tgtPrior = (p: AudioParam): void => {
    p.value = 0;
    p.setTargetAtTime(0.5, 0.1, 0.35);
  };
  const patterns: Pattern[] = [
    ['raw: setTarget → cancelAndHold + linearRamp', tgtPrior, (p, now) => (p.cancelAndHoldAtTime(now), p.linearRampToValueAtTime(0, now + 0.6))],
    ['raw: setTarget → cancelAndHold + setTarget', tgtPrior, (p, now) => (p.cancelAndHoldAtTime(now), p.setTargetAtTime(0, now, 0.2))],
    ['raw: value → cancelAndHold + linearRamp', (p) => (p.value = 0.5), (p, now) => (p.cancelAndHoldAtTime(now), p.linearRampToValueAtTime(0, now + 0.6))],
    ['raw: finished ramp → cancelAndHold + ramp', (p) => (p.setValueAtTime(0, 0), p.linearRampToValueAtTime(0.5, 0.5)), (p, now) => (p.cancelAndHoldAtTime(now), p.linearRampToValueAtTime(0, now + 0.6))],
    ['hold(): setTarget → ramp', tgtPrior, (p, now) => (hold(p, now), p.linearRampToValueAtTime(0, now + 0.6))],
    ['hold(): value → ramp', (p) => (p.value = 0.5), (p, now) => (hold(p, now), p.linearRampToValueAtTime(0, now + 0.06))],
    ['hold(): ramp in progress → ramp', (p) => (p.setValueAtTime(0, 0), p.linearRampToValueAtTime(0.5, 1.8)), (p, now) => (hold(p, now), p.linearRampToValueAtTime(0, now + 0.3))],
    ['hold(): setTarget → setTarget', tgtPrior, (p, now) => (hold(p, now), p.setTargetAtTime(0.8, now, 0.1))],
    ['envAHD', (p) => (p.value = 0, envAHD(p, 0.2, 0.7, 0.006, 0.05, 0.08, 1.4)), null],
    [
      'PopWriter train',
      (p) => {
        p.value = 0;
        const w = new PopWriter(p, 0.005, 0.02);
        for (let t = 0.2; t < 1.6; t += 0.037) w.pop(t, 0.3 + 0.5 * Math.abs(Math.sin(t * 9)));
        w.close();
      },
      null,
    ],
    [
      'TargetChain letters + close',
      (p) => {
        p.value = 0;
        const c = new TargetChain(p, 0.2, 0);
        for (let i = 0; i < 20; i++) {
          c.to(0.4 + 0.3 * (i % 3), 0.2 + i * 0.045, 0.006);
          c.to(0.05, 0.2 + i * 0.045 + 0.03, 0.008);
        }
        c.to(0, 1.1, 0.012);
        c.close(1.26, 0.012);
      },
      null,
    ],
  ];
  let worst = 0;
  let worstName = '';
  for (const [name, prior, op] of patterns) {
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 2 * SR, sampleRate: SR });
    const recs: ParamRec[] = [];
    const late = { n: 0 };
    instrument(ctx, recs, late);
    const src = ctx.createConstantSource();
    const g = ctx.createGain();
    src.connect(g).connect(ctx.destination);
    src.start(0);
    prior(g.gain);
    if (op) void ctx.suspend(T).then(() => (op(g.gain, ctx.currentTime), void ctx.resume()));
    const d = (await ctx.startRendering()).getChannelData(0);
    for (let t = 0.05; t < 1.95; t += 0.0013) {
      const i = Math.round(t * SR);
      // Chrome applies events on sample frames, and a setTarget that follows a ramp decays from the ramp's value one
      // frame before its end (measured: 0.34% under the analytic peak). So the rendered sample must lie on the model
      // curve within ±2 frames, with 0.5% relative slack: shapes (cuts, jumps, wrong ramp origins) still fail.
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = -2; k <= 2; k++) {
        const v = renderedAt(recs[0], (i + k) / SR);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      const err = Math.max(0, (d[i] < lo ? lo - d[i] : d[i] > hi ? d[i] - hi : 0) - 0.005 * Math.abs(d[i]));
      if (err > worst) {
        worst = err;
        worstName = `${name} @${(i / SR).toFixed(3)}s`;
      }
    }
  }
  const pass = worst < 1e-3;
  const e = failedEntry(
    `audit model vs Chrome (${patterns.length} automation patterns)`,
    `max deviation beyond ±2 frames / 0.5%: ${worst.toExponential(1)}${worstName ? ` (${worstName})` : ''}`,
  );
  e.params = patterns.length;
  e.ok = pass;
  return e;
}

// ----------------------------------------------------------------------------------------- rendering

function analyse(name: string, buf: AudioBuffer, continuous: boolean, audit: Audit): AudioReportEntry {
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const RL = buf.getChannelData(2);
  const RR = buf.getChannelData(3);
  const DL = buf.getChannelData(4);
  const DR = buf.getChannelData(5);
  const n = buf.length;
  let peak = 0, raw = 0, sum = 0, last = 0, sumL = 0, sumR = 0;
  let nan = false;
  for (let i = 0; i < n; i++) {
    const l = L[i], r = R[i], rl = RL[i], rr = RR[i];
    if (!Number.isFinite(l) || !Number.isFinite(r) || !Number.isFinite(rl) || !Number.isFinite(rr) || !Number.isFinite(DL[i]) || !Number.isFinite(DR[i])) {
      nan = true;
      continue;
    }
    const a = Math.max(Math.abs(l), Math.abs(r));
    if (a > peak) peak = a;
    if (a > 1e-4) last = i;
    sum += l * l + r * r;
    sumL += l;
    sumR += r;
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
  const [lufs, lufsI] = nan ? [-200, -200] : loudnessK(L, R);
  const entry: AudioReportEntry = {
    name,
    peak,
    rms: Math.sqrt(sum / (2 * n)),
    nan,
    raw,
    loud: best > 0 ? 10 * Math.log10(best) : -200,
    lufs,
    lufsI,
    dc: Math.max(Math.abs(sumL), Math.abs(sumR)) / n,
    tail: peakIn(buf, buf.duration - 0.03, buf.duration),
    dur: last / SR,
    act: activeSpan(L, R),
    hf: hfCrest(L, R, peak),
    onset: onsetRatio(DL, DR),
    end: continuous ? 0 : endRatio(DL, DR),
    atk: audit.rise,
    rel: audit.fall,
    jump: audit.jump,
    late: audit.late,
    params: audit.params,
    ok: false,
  };
  const fails: string[] = [];
  if (nan) fails.push('NaN');
  if (!(peak < LIMITS.peak)) fails.push('clipping');
  if (!(entry.rms > 0)) fails.push('silent');
  if (!(entry.dc < LIMITS.dc)) fails.push(`DC ${entry.dc.toExponential(1)}`);
  if (!continuous && !(entry.tail < LIMITS.tail)) fails.push('tail not decayed');
  if (entry.atk < LIMITS.rampMs) fails.push(`attack ramp ${entry.atk.toFixed(1)} ms`);
  if (entry.rel < LIMITS.rampMs) fails.push(`release ramp ${entry.rel.toFixed(1)} ms`);
  if (entry.jump > LIMITS.jump) fails.push(`gain step ${entry.jump.toExponential(1)}`);
  if (entry.late > 0) fails.push(`${entry.late} late events`);
  if (entry.onset > LIMITS.onset) fails.push(`onset ${entry.onset.toFixed(2)}`);
  if (!continuous && entry.end > LIMITS.end) fails.push(`ending ${entry.end.toExponential(1)}`);
  for (const f of audit.flags) fails.push(f);
  entry.ok = fails.length === 0;
  if (fails.length) entry.note = fails.join('; ');
  return entry;
}

async function render(job: Job): Promise<{ entry: AudioReportEntry; buf: AudioBuffer }> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 6, length: Math.ceil(job.secs * SR), sampleRate: SR });
  // taps first (not instrumented), then the engine (every gain it makes is audited)
  const merger = ctx.createChannelMerger(6);
  // stereo taps: 'speakers' up-mix so a mono bus lands in both channels (a splitter alone up-mixes 'discrete')
  const stereo = (): GainNode => {
    const g = ctx.createGain();
    g.channelCount = 2;
    g.channelCountMode = 'explicit';
    g.channelInterpretation = 'speakers';
    return g;
  };
  const finSum = stereo();
  const preSum = stereo();
  const drySum = stereo();
  const fin = ctx.createChannelSplitter(2);
  const pre = ctx.createChannelSplitter(2);
  const dry = ctx.createChannelSplitter(2);
  finSum.connect(fin);
  preSum.connect(pre);
  drySum.connect(dry);
  const recs: ParamRec[] = [];
  const late = { n: 0 };
  instrument(ctx, recs, late);
  const e = new EngineImpl(ctx, { seed: 1234, toDestination: false });
  e.core.connectOutput(finSum);
  e.core.mix.connect(preSum);
  e.core.musicDuck.connect(drySum);
  e.core.bus.sfx.connect(drySum);
  e.core.bus.voices.connect(drySum);
  e.core.bus.crowd.connect(drySum);
  e.core.bus.pad.connect(drySum);
  fin.connect(merger, 0, 0);
  fin.connect(merger, 1, 1);
  pre.connect(merger, 0, 2);
  pre.connect(merger, 1, 3);
  dry.connect(merger, 0, 4);
  dry.connect(merger, 1, 5);
  ctx.destination.channelInterpretation = 'discrete';
  merger.connect(ctx.destination);
  e.setListenerPose(EYE.x, EYE.y, EYE.z, 0, 0, -1, 0, 1, 0, true);

  // timeline: quantum index → actions (suspend points land mid-quantum so rounding never collides)
  const errors: string[] = [];
  const run = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      errors.push(String(err));
    }
  };
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
  run(() => job.script(e, at));
  if (job.pumps) {
    const step = Math.max(1, Math.round(0.024 / QUANTUM));
    for (let q = step; q * QUANTUM < job.secs; q += step) {
      const t = q * QUANTUM;
      if (job.stall && t >= job.stall[0] && t < job.stall[1]) continue;
      push(q, () => e.pump(t + LOOKAHEAD));
    }
  }
  for (const fn of now) run(fn);
  if (job.pumps) run(() => e.pump(LOOKAHEAD));
  const keys = [...actions.keys()].sort((a, b) => a - b);
  for (const q of keys) {
    if (q * QUANTUM >= job.secs - QUANTUM) continue;
    const fns = actions.get(q)!;
    void ctx.suspend((q + 0.5) * QUANTUM).then(() => {
      for (const fn of fns) run(fn);
      void ctx.resume();
    });
  }
  const buf = await ctx.startRendering();
  const entry = analyse(job.name, buf, !!job.continuous, auditParams(recs, late.n));
  if (errors.length) {
    entry.ok = false;
    entry.note = `${entry.note ? `${entry.note}; ` : ''}threw: ${errors[0]}`;
  }
  try {
    job.check?.(buf, entry, e);
  } catch (err) {
    entry.ok = false;
    entry.note = `check threw: ${String(err)}`;
  }
  e.dispose();
  return { entry, buf };
}

/** Append a check result to the entry's note; failing checks fail the entry. */
function note(r: AudioReportEntry, text: string, pass: boolean): void {
  r.note = r.note ? `${r.note}; ${text}` : text;
  if (!pass) r.ok = false;
}

/**
 * A music box `seconds` long (Infinity = endless) closed with stop() at `stopT`, and stop() again mid-fade. Checks: no
 * click (nothing above 18 kHz beyond what the tines' own attacks make: calibrated offline, a hard cut of the same box
 * measures ~9e-3 there, stop() ~3e-7, the tines' attacks ~7e-6), the dry output silent after the fade + panner tail
 * (nothing truncated, nothing scheduled in the lookahead window leaks out), voice + box released, the trio's duck
 * engaged while it played and released after.
 */
function musicBoxStopJob(name: string, seconds: number, stopT: number, secs: number): Job {
  const probe = { duckWhile: Number.NaN, boxesWhile: -1, voicesAfter: -1, boxesAfter: -1, duckAfter: Number.NaN };
  return {
    name,
    secs,
    pumps: true,
    script: (e, at) => {
      const h = e.musicBox(SOUND_POS.musicBox, seconds);
      at(stopT - 0.5, () => {
        probe.duckWhile = e.core.musicDuck.gain.value;
        probe.boxesWhile = e.musicBoxes;
      });
      at(stopT, () => h.stop());
      at(stopT + 0.05, () => h.stop()); // again, mid-fade: a no-op
      at(stopT + 1.2, () => {
        probe.voicesAfter = e.core.activeVoices();
        probe.boxesAfter = e.musicBoxes;
      });
      at(Math.min(secs - 0.1, stopT + 2.6), () => (probe.duckAfter = e.core.musicDuck.gain.value));
    },
    check: (buf, r) => {
      const playing = peakIn(buf, 0.3, stopT);
      const hfPlay = hfPeak(buf, 0.3, stopT - 0.005);
      const hfStop = hfPeak(buf, stopT - 0.005, stopT + MB_STOP_FADE + 0.05);
      const after = dryPeak(buf, stopT + MB_STOP_FADE + PANNER_TAIL, secs);
      note(
        r,
        `playing ${playing.toFixed(3)}; >18 kHz while playing ${hfPlay.toExponential(1)}, around stop() ${hfStop.toExponential(1)} ` +
          `(a hard cut measures ~9e-3); dry after the ${Math.round(MB_STOP_FADE * 1000)} ms fade ${after === 0 ? 'exactly 0' : after.toExponential(1)}`,
        playing > 0.01 && hfStop <= Math.max(2 * hfPlay, 1e-5) && after <= 1e-6,
      );
      note(
        r,
        `while playing: ${probe.boxesWhile} box, trio ducked to ${probe.duckWhile.toFixed(2)}; 1.2 s after stop(): ` +
          `${probe.voicesAfter} voices, ${probe.boxesAfter} boxes; trio back to ${probe.duckAfter.toFixed(3)}`,
        probe.boxesWhile === 1 && probe.duckWhile < 0.45 && probe.voicesAfter === 0 && probe.boxesAfter === 0 && probe.duckAfter > 0.99,
      );
    },
  };
}

// --------------------------------------------------------------------------------------------- jobs

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
      const mid = peakIn(buf, 0.5, 1.9);
      note(r, `sounding ${mid.toFixed(3)}`, mid >= 0.01);
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
        note(r, `spoken ${r.act.toFixed(2)}s vs ${expect.toFixed(2)}s (${text.length} chars)`, r.act >= expect * 0.75 && r.act <= expect * 1.3 + 0.12);
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
    script: (e, at) => {
      const h = e.musicBox(SOUND_POS.musicBox, 2);
      at(4.9, () => (h.stop(), h.stop())); // after the show has ended: a no-op
    },
    check: (buf, r) => {
      const late = peakIn(buf, 3.6, 5); // the last tine (≤ 2.3 s) has rung out by ~3.5 s
      note(r, `active ${r.act.toFixed(2)}s; after 3.6 s ${late.toExponential(1)}`, late <= 0.01);
    },
  });
  // stop(): an endless box and a finite one closed mid-note (a melody tine started 28 ms earlier: near its loudest)
  list.push(musicBoxStopJob('musicBox:∞ → stop() mid-note (+ again)', Infinity, 3.24, 6.4));
  list.push(musicBoxStopJob('musicBox:5s → stop() early, mid-note', 5, 2.04, 5.2));
  {
    const probe = { maxTines: 0, maxVoices: 0, boxes: -1, voicesAfter: -1 };
    list.push({
      // Easy Audience: plays until stopped, phrase after phrase; resources must stay flat and the seams seamless
      name: 'musicBox:∞ for 18 s (A/B/A/B) → stop()',
      secs: 20.4,
      pumps: true,
      script: (e, at) => {
        const h = e.musicBox(SOUND_POS.musicBox, Infinity);
        for (let t = 0.5; t < 18; t += 0.5) {
          at(t, () => {
            probe.maxTines = Math.max(probe.maxTines, e.musicBoxTines);
            probe.maxVoices = Math.max(probe.maxVoices, e.core.activeVoices());
          });
        }
        at(17.9, () => (probe.boxes = e.musicBoxes));
        at(18.03, () => h.stop());
        at(19.6, () => (probe.voicesAfter = e.core.activeVoices()));
      },
      check: (buf, r) => {
        const floor = dryFloor(buf, 0.3, 18);
        const last = dryPeak(buf, 16.5, 18);
        const after = dryPeak(buf, 18.03 + MB_STOP_FADE + PANNER_TAIL, 20.4);
        note(
          r,
          `quietest 100 ms before stop() ${floor.toFixed(4)} (no seams); at 16.5–18 s ${last.toFixed(3)}; dry after the fade ` +
            `${after === 0 ? 'exactly 0' : after.toExponential(1)}; voices ≤ ${probe.maxVoices}, tines ringing ≤ ${probe.maxTines}; ` +
            `boxes at 17.9 s ${probe.boxes}, voices after stop() ${probe.voicesAfter}`,
          floor > 0.003 && last > 0.01 && after <= 1e-6 && probe.maxVoices === 1 && probe.maxTines <= 32 && probe.boxes === 1 && probe.voicesAfter === 0,
        );
      },
    });
  }
  list.push({
    name: 'musicBox:5s + 700 ms main-thread stall',
    secs: 9,
    pumps: true,
    stall: [1.5, 2.2],
    script: (e) => e.musicBox(SOUND_POS.musicBox, 5),
    check: (buf, r) => {
      const after = peakIn(buf, 2.4, 5);
      note(r, `late events ${r.late} (the box slides instead); playing after ${after.toFixed(3)}`, r.late === 0 && after > 0.01);
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
      note(r, `peak@5/5 ${during.toFixed(3)}; after all-clear ${after === 0 ? 'exactly 0' : after.toExponential(2)}`, after === 0 && during > 0);
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
    // the beat at 2.076 s falls due mid-stall: the first pump after it finds the beat 36 ms behind the audio clock
    name: 'music:calm + 250 ms stall (a beat falls due)',
    secs: 4,
    pumps: true,
    continuous: true,
    stall: [1.85, 2.1],
    script: (e) => e.music.start(),
    check: (_buf, r) => note(r, `late events ${r.late}`, r.late === 0),
  });
  list.push({
    // long enough to blow past the 200 ms horizon AND the next beat (92 BPM: a beat every 652 ms)
    name: 'music:calm + 1.3 s main-thread stall',
    secs: 6,
    pumps: true,
    continuous: true,
    stall: [1.6, 2.9],
    script: (e) => e.music.start(),
    check: (buf, r) => {
      const after = peakIn(buf, 3.0, 6.0);
      note(r, `late events ${r.late}; playing after the stall ${after.toFixed(3)}`, r.late === 0 && after > 0.01);
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
      note(r, `after stop+reverb ${after.toExponential(2)}`, after <= 1e-3);
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
      note(r, `while paused ${paused === 0 ? 'exactly 0' : paused.toExponential(2)}; after resume ${back.toFixed(3)}`, paused === 0 && back > 0);
    },
  });
  list.push({
    // the probe is uiHover: fixed partials (1.6 + 3.1 kHz), so every render images identically
    name: 'spatial: left / right, then again on recycled panners',
    secs: 5.4,
    script: (e, at) => {
      const left = W(-0.5, -0.29, -0.4);
      const right = W(0.5, -0.29, -0.4);
      at(0.1, () => e.sfx('uiHover', { at: left, volume: 2 })); // reference: pristine panners
      at(1.1, () => e.sfx('uiHover', { at: right, volume: 2 }));
      // dirty all 10 pooled panners with overlapping sounds straight ahead (shh: not rate-limited) …
      for (let i = 0; i < 10; i++) at(2.1 + i * 0.02, () => e.sfx('shh', { at: W(-0.09 + i * 0.02, -0.29, -0.45), volume: 0.3 }));
      at(3.3, () => e.sfx('uiHover', { at: left, volume: 2 })); // … so these must recycle one
      at(4.3, () => e.sfx('uiHover', { at: right, volume: 2 }));
    },
    check: (buf, r) => {
      const refL = -ild(buf, 0.1, 1.05); // L louder → positive
      const refR = ild(buf, 1.1, 2.05);
      const recL = -ild(buf, 3.3, 4.25);
      const recR = ild(buf, 4.3, 5.25);
      // a recycled panner must image exactly like a pristine one (Chrome's HRTF cross-fade would smear it)
      note(
        r,
        `L>R ${refL.toFixed(1)} dB / R>L ${refR.toFixed(1)} dB; on recycled panners ${recL.toFixed(1)} / ${recR.toFixed(1)} dB`,
        refL > 6 && refR > 6 && Math.abs(recL - refL) < 1 && Math.abs(recR - refR) < 1,
      );
    },
  });
  list.push({
    name: 'listener: 90° head turn while the fuse burns',
    secs: 3.4,
    script: (e, at) => {
      let h: LoopHandle | null = null;
      at(0, () => (h = e.loop('fuse', SOUND_POS.fuse)));
      // 60 Hz listener updates (like setListener every frame): turn left 90° over one second
      for (let k = 0; k <= 60; k++) {
        const yaw = (Math.PI / 2) * (k / 60);
        at(1.0 + k / 60, () => e.setListenerPose(EYE.x, EYE.y, EYE.z, -Math.sin(yaw), 0, -Math.cos(yaw), 0, 1, 0));
      }
      at(3.0, () => h?.stop());
    },
    check: (buf, r) => {
      const before = ild(buf, 0.3, 0.95);
      const after = ild(buf, 2.2, 2.95); // facing -X now: the fuse (world -Z) is at the right ear
      note(r, `ILD R−L before ${before.toFixed(1)} dB, after a 90° left turn ${after.toFixed(1)} dB`, Math.abs(before) < 3 && after > 6);
    },
  });
  list.push({
    name: 'robust: NaN / Infinity / unknown inputs',
    secs: 4,
    pumps: true,
    continuous: true,
    script: (e, at) => {
      const bad = { x: Number.NaN, y: 1, z: 0 };
      at(0.05, () => {
        e.sfx('tink', { volume: Number.NaN, pitch: Infinity, at: SOUND_POS.mat });
        e.sfx('poof', { pitch: Number.NaN, at: bad });
        e.sfx('fwip', { pitch: -2, volume: -1 });
        e.sfx('nope' as SfxName);
        e.say('', SOUND_POS.kit1, 'fox');
        e.say('🎩✨ ¿¡ÀÉÎ!? 1234 …', SOUND_POS.rabbit, 'rabbit', 'happy');
        e.say('hi', SOUND_POS.kit1, 'unicorn' as SpectatorKind, 'angry' as Mood);
        e.say('blah '.repeat(60), SOUND_POS.brock, 'badger');
        e.crowd('nope' as CrowdKind, Number.NaN);
        e.crowd('applause', Infinity, { x: Infinity, y: 0, z: 0 });
        e.musicBox(SOUND_POS.musicBox, Number.NaN);
        // handles from odd requests (endless, negative, zero, -Infinity, not a number, NaN position): stop() twice each
        const boxes = [
          e.musicBox(SOUND_POS.musicBox, Infinity),
          e.musicBox(bad, -3),
          e.musicBox(null, 0),
          e.musicBox(SOUND_POS.musicBox, -Infinity),
          e.musicBox(SOUND_POS.musicBox, 'soon' as unknown as number),
        ];
        for (const b of boxes) {
          b.stop();
          b.stop();
        }
        e.setTension(Number.NaN, 0);
        e.setTension(3, Number.NaN);
        e.setTension(Infinity, 5);
        e.setMasterVolume(Number.NaN);
        e.setListenerPose(Number.NaN, 0, 0, 0, 0, -1, 0, 1, 0);
        const h = e.loop('fuse', null);
        h.stop();
        h.stop();
      });
    },
    check: (_buf, r) => note(r, 'no throw, no NaN', !r.nan),
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
      note(r, `peak voices ${s.peakVoices}/24, stolen ${s.stolen}, refused ${s.refused}, stereo fallbacks ${s.fallbackPans}`, s.peakVoices <= 24);
    },
  });
  return list;
}

// ------------------------------------------------------------------------------------------- summary

export interface AudioBalance {
  /** Mean loudest-50 ms window (dBFS) per category. */
  loud: Record<string, number>;
  /** Mean K-weighted momentary max (LUFS) per category; music also has its whole-excerpt loudness. */
  lufs: Record<string, number>;
  musicLufsI: number;
  /** How far the café trio sits under foley / voices, dB (50 ms metric and LUFS-M metric). */
  underFoley: number;
  underVoices: number;
  underFoleyLufs: number;
  underVoicesLufs: number;
  ok: boolean;
}

const FOLEY = ['sfx:tink', 'sfx:fwip', 'sfx:shh', 'sfx:poof', 'sfx:cupThunk', 'sfx:cupLift'];
const MUSIC = ['music:calm 6s', 'music:tense 6s', 'music:triumph 6s'];

export function balanceOf(entries: AudioReportEntry[]): AudioBalance {
  const pick = (pred: (n: string) => boolean, key: 'loud' | 'lufs' | 'lufsI'): number => {
    const xs = entries.filter((e) => pred(e.name)).map((e) => e[key]);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;
  };
  const cats: Record<string, (n: string) => boolean> = {
    music: (n) => MUSIC.includes(n),
    voices: (n) => n.startsWith('say:'),
    foley: (n) => FOLEY.includes(n),
    crowd: (n) => n.startsWith('crowd:'),
    ui: (n) => n === 'sfx:uiHover' || n === 'sfx:uiPress',
    pad: (n) => n.startsWith('pad:'),
  };
  const loud: Record<string, number> = {};
  const lufs: Record<string, number> = {};
  for (const [k, pred] of Object.entries(cats)) {
    loud[k] = pick(pred, 'loud');
    lufs[k] = pick(pred, 'lufs');
  }
  const b: AudioBalance = {
    loud,
    lufs,
    musicLufsI: pick(cats.music, 'lufsI'),
    underFoley: loud.foley - loud.music,
    underVoices: loud.voices - loud.music,
    underFoleyLufs: lufs.foley - lufs.music,
    underVoicesLufs: lufs.voices - lufs.music,
    ok: false,
  };
  // "music sits ~10 dB under foley and voices": 7..14 dB on the short-term metric
  b.ok = b.underFoley >= 7 && b.underFoley <= 14 && b.underVoices >= 7 && b.underVoices <= 14;
  return b;
}

function failedEntry(name: string, note: string): AudioReportEntry {
  return {
    name, peak: 0, rms: 0, nan: false, raw: 0, loud: -200, lufs: -200, lufsI: -200, dc: 0, tail: 0, dur: 0, act: 0,
    hf: 0, onset: 0, end: 0, atk: Infinity, rel: Infinity, jump: 0, late: 0, params: 0, ok: false, note,
  };
}

/** QA: render only the jobs whose names match, keeping the buffers (6 channels: final, pre-master, dry). */
export async function renderAudioJobs(match: (name: string) => boolean): Promise<Array<{ entry: AudioReportEntry; buf: AudioBuffer }>> {
  const out: Array<{ entry: AudioReportEntry; buf: AudioBuffer }> = [];
  for (const job of jobs()) if (match(job.name)) out.push(await render(job));
  return out;
}

/** Render and measure everything. `onEntry` fires as each result arrives (progressive UI). */
export async function renderAudioReport(onEntry?: (e: AudioReportEntry, i: number, n: number) => void): Promise<AudioReportEntry[]> {
  const list = jobs();
  const out: AudioReportEntry[] = [];
  const n = list.length + 1;
  let self: AudioReportEntry;
  try {
    self = await auditModelSelfTest();
  } catch (err) {
    self = failedEntry('audit model vs Chrome', `self-test failed: ${String(err)}`);
  }
  out.push(self);
  onEntry?.(self, 0, n);
  for (let i = 0; i < list.length; i++) {
    let entry: AudioReportEntry;
    try {
      entry = (await render(list[i])).entry;
    } catch (err) {
      entry = failedEntry(list[i].name, `render failed: ${String(err)}`);
    }
    out.push(entry);
    onEntry?.(entry, i + 1, n);
  }
  return out;
}
