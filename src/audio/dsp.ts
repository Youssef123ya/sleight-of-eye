// DSP building blocks for the synthesized audio engine (owned by A).
// Everything here runs at event time (a sound starting) or once per AudioContext (buffers, wave tables) —
// never per rendered frame. All envelopes are click-free: ramps are >= MIN_RAMP and every decay lands on
// EXACTLY zero before its source stops, so nothing is ever truncated mid-waveform.

export type Rng = () => number;

/** Deterministic PRNG (mulberry32): offline renders and per-line animalese are reproducible. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Small string hash (FNV-1a) for seeding per-text variation. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
export const semis = (s: number): number => Math.pow(2, s / 12);
export const rnd = (r: Rng, a: number, b: number): number => a + (b - a) * r();
export function pick<T>(r: Rng, arr: readonly T[]): T {
  return arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))];
}

/** Shortest gain ramp used anywhere in the engine (anything faster can click). */
export const MIN_RAMP = 0.005;

// ------------------------------------------------------------------------------------------- envelopes

/**
 * Attack (linear) → optional hold → exponential decay that lands on exactly 0 at `end`.
 * The param must be idle (a fresh node). Returns the time the param reaches 0.
 */
export function envAHD(
  p: AudioParam,
  t: number,
  peak: number,
  attack: number,
  hold: number,
  tau: number,
  end: number,
): number {
  const a = Math.max(MIN_RAMP, attack);
  const d0 = t + a + Math.max(0, hold);
  const e1 = Math.max(d0 + 0.002, end - 0.012);
  const fin = Math.max(e1 + MIN_RAMP, end);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  if (hold > 0) p.setValueAtTime(peak, d0);
  p.setTargetAtTime(0, d0, tau);
  // Continue the exact same curve analytically, then glide the last few ms to a true zero.
  p.setValueAtTime(peak * Math.exp(-(e1 - d0) / tau), e1);
  p.linearRampToValueAtTime(0, fin);
  return fin;
}

/** Attack → exponential decay, exact zero at `end` (default: 7 time constants). */
export function envAD(p: AudioParam, t: number, peak: number, attack: number, tau: number, end?: number): number {
  return envAHD(p, t, peak, attack, 0, tau, end ?? t + Math.max(MIN_RAMP, attack) + tau * 7);
}

/** Exponential swell (setTarget attack) → release at `relAt` → exact zero at `end`. */
export function envSwell(
  p: AudioParam,
  t: number,
  peak: number,
  atkTau: number,
  relAt: number,
  relTau: number,
  end?: number,
): number {
  const r = Math.max(t + 0.002, relAt);
  const stop = end ?? r + relTau * 6;
  const e1 = Math.max(r + 0.002, stop - 0.015);
  const fin = Math.max(e1 + MIN_RAMP, stop);
  const aT = Math.max(MIN_RAMP, atkTau); // exponential approach: smooth from 0, never steeper than MIN_RAMP
  p.setValueAtTime(0, t);
  p.setTargetAtTime(peak, t, aT);
  const vr = peak * (1 - Math.exp(-(r - t) / aT));
  p.setTargetAtTime(0, r, relTau);
  p.setValueAtTime(vr * Math.exp(-(e1 - r) / relTau), e1);
  p.linearRampToValueAtTime(0, fin);
  return fin;
}

/** Note envelope: attack → decay toward sustain → release at `relAt` → exact zero. Returns the end time. */
export function envNote(
  p: AudioParam,
  t: number,
  peak: number,
  attack: number,
  decTau: number,
  sustain: number,
  relAt: number,
  relTau: number,
): number {
  const a = Math.max(MIN_RAMP, attack);
  const r = Math.max(t + a + 0.002, relAt);
  const s = peak * sustain;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.setTargetAtTime(s, t + a, decTau);
  const vr = s + (peak - s) * Math.exp(-(r - t - a) / decTau);
  p.setTargetAtTime(0, r, relTau);
  const end = r + relTau * 5.5;
  const e1 = end - 0.01;
  p.setValueAtTime(vr * Math.exp(-(e1 - r) / relTau), e1);
  p.linearRampToValueAtTime(0, end);
  return end;
}

/**
 * Stateful train of short blips on ONE gain param (claps, crackles, ratchet clicks, brush taps, voice clicks):
 * dozens of transients for the cost of a single node. Each blip continues from the analytic residual of the
 * previous one, so the curve is continuous. Call `close()` once to land on exactly zero.
 */
export class PopWriter {
  private lastT = -1;
  private lastA = 0;
  private lastTau = 0.01;

  constructor(
    readonly p: AudioParam,
    readonly attack = MIN_RAMP,
    public tau = 0.012,
  ) {}

  /** True once at least one pop was written since the last close(). */
  get open(): boolean {
    return this.lastT >= 0;
  }

  pop(t: number, amp: number, tau = this.tau): void {
    const atk = Math.max(MIN_RAMP, this.attack);
    if (this.lastT >= 0 && t < this.lastT + 0.0005) t = this.lastT + 0.0005; // keep events ordered
    const res = this.lastT < 0 ? 0 : this.lastA * Math.exp(-(t - this.lastT) / this.lastTau);
    const pk = Math.max(amp, res);
    this.p.setValueAtTime(res, t);
    this.p.linearRampToValueAtTime(pk, t + atk);
    this.p.setTargetAtTime(0, t + atk, tau);
    this.lastT = t + atk;
    this.lastA = pk;
    this.lastTau = tau;
  }

  /** Land on exactly zero after the last pop; returns the time it gets there (0 when nothing was written). */
  close(): number {
    if (this.lastT < 0) return 0;
    const end = this.lastT + this.lastTau * 6.5;
    const e1 = end - 0.008;
    this.p.setValueAtTime(this.lastA * Math.exp(-(e1 - this.lastT) / this.lastTau), e1);
    this.p.linearRampToValueAtTime(0, end);
    this.lastT = -1;
    return end;
  }
}

/**
 * Mirrors a chain of setTargetAtTime events on one param (scheduled in time order), so the curve can be continued
 * analytically and closed on an exact zero with a linear glide instead of a step.
 */
export class TargetChain {
  private t0: number;
  private v0: number;
  private target: number;
  private tau = 1;

  constructor(
    readonly p: AudioParam,
    t: number,
    v = 0,
  ) {
    this.t0 = t;
    this.v0 = v;
    this.target = v;
  }

  valueAt(t: number): number {
    return t <= this.t0 ? this.v0 : this.target + (this.v0 - this.target) * Math.exp(-(t - this.t0) / this.tau);
  }

  to(target: number, t: number, tau: number): void {
    const tt = Math.max(t, this.t0);
    const k = Math.max(MIN_RAMP, tau);
    this.v0 = this.valueAt(tt);
    this.t0 = tt;
    this.target = target;
    this.tau = k;
    this.p.setTargetAtTime(target, tt, k);
  }

  /** Continue the curve to `end - glide`, then glide linearly to exactly 0 at `end`. Returns `end`. */
  close(end: number, glide = 0.012): number {
    const e1 = Math.max(this.t0 + 0.001, end - Math.max(MIN_RAMP, glide));
    const fin = Math.max(e1 + MIN_RAMP, end);
    this.p.setValueAtTime(this.valueAt(e1), e1);
    this.p.linearRampToValueAtTime(0, fin);
    return fin;
  }
}

/** Exponential glide from → to (frequencies; both > 0). */
export function glide(p: AudioParam, t: number, from: number, to: number, dur: number): number {
  p.setValueAtTime(Math.max(1e-3, from), t);
  const e = t + Math.max(MIN_RAMP, dur);
  p.exponentialRampToValueAtTime(Math.max(1e-3, to), e);
  return e;
}

/** Piecewise exponential path through `values`; segment i lasts `durs[i]`. Returns the end time. */
export function path(p: AudioParam, t: number, values: readonly number[], durs: readonly number[]): number {
  p.setValueAtTime(Math.max(1e-3, values[0]), t);
  let tt = t;
  for (let i = 1; i < values.length; i++) {
    tt += Math.max(MIN_RAMP, durs[i - 1] ?? 0.05);
    p.exponentialRampToValueAtTime(Math.max(1e-3, values[i]), tt);
  }
  return tt;
}

/**
 * Freeze a param at its current value at `t` (= ctx.currentTime), dropping later automation, so the next ramp or
 * target starts from exactly here. The explicit setValueAtTime pin is essential: measured in Chrome (offline renders),
 * cancelAndHoldAtTime alone makes a following linearRamp start from 0 after a running setTarget (a hard cut), and
 * from the PREVIOUS event otherwise (a jump at t). `p.value` is the param's value at the current render quantum.
 */
export function hold(p: AudioParam, t: number): void {
  const v = p.value;
  if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(t);
  else p.cancelScheduledValues(t);
  p.setValueAtTime(v, t);
}

// --------------------------------------------------------------------------------------- generated data
// Raw sample data is cached per (kind, sampleRate, seed) so every AudioContext (and every offline render)
// reuses it; AudioBuffers are then cheap copies.

const dataCache = new Map<string, Float32Array<ArrayBuffer>[]>();

export function cachedData(key: string, make: () => Float32Array<ArrayBuffer>[]): Float32Array<ArrayBuffer>[] {
  let d = dataCache.get(key);
  if (!d) {
    d = make();
    dataCache.set(key, d);
  }
  return d;
}

export function toBuffer(ctx: BaseAudioContext, chans: Float32Array<ArrayBuffer>[]): AudioBuffer {
  const b = ctx.createBuffer(chans.length, chans[0].length, ctx.sampleRate);
  for (let c = 0; c < chans.length; c++) b.copyToChannel(chans[c], c);
  return b;
}

function normalizePeak(d: Float32Array, target: number): void {
  let pk = 0;
  for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
  if (pk <= 0) return;
  const k = target / pk;
  for (let i = 0; i < d.length; i++) d[i] *= k;
}

/** Remove the mean (dense noise only: a sparse buffer would gain a constant offset instead). */
function removeMean(d: Float32Array): void {
  let s = 0;
  for (let i = 0; i < d.length; i++) s += d[i];
  const m = s / Math.max(1, d.length);
  for (let i = 0; i < d.length; i++) d[i] -= m;
}

export function makeWhite(sr: number, secs: number, seed: number): Float32Array<ArrayBuffer>[] {
  const r = mulberry32(seed);
  const d = new Float32Array(Math.floor(sr * secs));
  for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
  removeMean(d); // lowpassed recipes (thumps, puffs) pass DC straight through
  return [d];
}

/**
 * Pink noise (Paul Kellet's refined filter), DC-blocked, peak-normalised and a seamless loop (the brushes loop it
 * for minutes): the tail is equal-power crossfaded into the head, so the seam has no step.
 */
export function makePink(sr: number, secs: number, seed: number): Float32Array<ArrayBuffer>[] {
  const r = mulberry32(seed);
  const n = Math.floor(sr * secs);
  const xf = Math.floor(0.05 * sr);
  const warm = Math.floor(0.25 * sr); // let the 1/f poles and the DC blocker settle before recording
  const tmp = new Float32Array(n + xf);
  const R = 1 - (2 * Math.PI * 4) / sr; // one-pole DC blocker at ~4 Hz: no slow wander reaches a lowpassed recipe
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, x1 = 0, y1 = 0;
  for (let i = -warm; i < tmp.length; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const p = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    const y = p - x1 + R * y1;
    x1 = p;
    y1 = y;
    if (i >= 0) tmp[i] = y;
  }
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = tmp[i];
  for (let i = 0; i < xf; i++) {
    const x = (i + 0.5) / xf;
    d[i] = tmp[i] * Math.sqrt(x) + tmp[n + i] * Math.sqrt(1 - x);
  }
  removeMean(d);
  normalizePeak(d, 0.95);
  return [d];
}

/**
 * Warm room impulse response: 8 ms pre-delay, smoothed early reflections (table, wood panels, window),
 * then a decorrelated noise tail whose brightness falls over time (highs die first = warm, never splashy).
 */
export function makeRoomIR(sr: number, secs: number, rt60: number, seed: number): Float32Array<ArrayBuffer>[] {
  const n = Math.floor(sr * secs);
  const pre = Math.floor(0.008 * sr);
  const decay = Math.pow(10, -3 / (rt60 * sr)); // per-sample factor: -60 dB after rt60
  const fadeIn = 0.003 * sr;
  const fadeOut = 0.15 * sr;
  const out: Float32Array<ArrayBuffer>[] = [];
  for (let ch = 0; ch < 2; ch++) {
    const r = mulberry32(seed + ch * 7919);
    const d = new Float32Array(n);
    let env = 1, y1 = 0, y2 = 0, a = 0;
    for (let i = pre; i < n; i++) {
      const k = i - pre;
      if ((k & 63) === 0) {
        const fc = 850 + 6500 * Math.exp((-k / sr) * 2.4);
        a = Math.exp((-2 * Math.PI * fc) / sr);
      }
      const w = r() * 2 - 1;
      y1 = (1 - a) * w + a * y1;
      y2 = (1 - a) * y1 + a * y2;
      let g = env;
      if (k < fadeIn) g *= k / fadeIn;
      if (i > n - fadeOut) g *= (n - i) / fadeOut;
      d[i] = y2 * g;
      env *= decay;
    }
    const taps = ch === 0 ? [0.0071, 0.0123, 0.0189, 0.0262, 0.0347, 0.0431] : [0.0083, 0.0137, 0.0171, 0.0293, 0.0368, 0.0452];
    const amps = [0.9, -0.7, 0.55, -0.45, 0.35, -0.28];
    for (let j = 0; j < taps.length; j++) {
      const c = Math.floor(taps[j] * sr);
      for (let m = -12; m <= 12; m++) {
        const idx = c + m;
        if (idx < 0 || idx >= n) continue;
        d[idx] += amps[j] * (0.5 + 0.5 * Math.cos((Math.PI * m) / 13)) * 0.22;
      }
    }
    out.push(d);
  }
  return out;
}

/** Firework fuse sizzle with crackles: a seamless loop (the tail is equal-power crossfaded into the head). */
export function makeFuseLoop(sr: number, secs: number, seed: number): Float32Array<ArrayBuffer>[] {
  const r = mulberry32(seed);
  const n = Math.floor(sr * secs);
  const xf = Math.floor(0.06 * sr);
  const m = n + xf;
  const tmp = new Float32Array(m);
  let hp = 0, prev = 0, bp = 0, flut = 0.6, flutT = 0.6, lp = 0;
  const flutStep = Math.max(1, Math.floor(sr * 0.012));
  for (let i = 0; i < m; i++) {
    if (i % flutStep === 0) flutT = 0.3 + 0.7 * r();
    flut += (flutT - flut) * 0.004;
    const w = r() * 2 - 1;
    hp = 0.86 * (hp + w - prev); // one-pole high-pass (~1 kHz)
    prev = w;
    bp += 0.35 * (hp - bp); // soften the very top
    lp += 0.02 * (w - lp); // low sputter
    tmp[i] = bp * 0.5 * flut + lp * 0.8 * (0.35 + 0.65 * flut);
  }
  const count = Math.floor(secs * 24);
  for (let k = 0; k < count; k++) {
    const at = Math.floor(r() * (m - 0.03 * sr));
    const f = 1800 + r() * 4200;
    const tau = 0.0012 + r() * 0.0025;
    const amp = 0.2 + r() * 0.55;
    const len = Math.min(Math.floor(tau * 6 * sr), m - at - 1);
    const w = (2 * Math.PI * f) / sr;
    for (let j = 0; j < len; j++) tmp[at + j] += amp * Math.exp(-j / (tau * sr)) * Math.sin(w * j) * Math.min(1, j / 6);
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = tmp[i];
  for (let i = 0; i < xf; i++) {
    const x = i / xf;
    out[i] = tmp[i] * Math.sqrt(x) + tmp[n + i] * Math.sqrt(1 - x);
  }
  removeMean(out);
  normalizePeak(out, 0.8);
  return [out];
}

/**
 * Pocket-watch ticking loop: 1 s, four ticks alternating tick / tock. Every tick follows the engine's envelope rule
 * (5 ms linear attack, decays no steeper than tau = 5 ms) — crispness comes from the bright ring, not a hard edge.
 */
export function makeTickLoop(sr: number, seed: number): Float32Array<ArrayBuffer>[] {
  const r = mulberry32(seed);
  const d = new Float32Array(sr);
  const atk = MIN_RAMP;
  for (let k = 0; k < 4; k++) {
    const at = Math.floor((0.02 + k * 0.25) * sr);
    const f = k % 2 === 0 ? 4300 : 3500;
    const len = Math.floor(0.09 * sr); // long enough that every partial has decayed below -80 dB (no truncation)
    let lp = 0;
    for (let j = 0; j < len; j++) {
      const tt = j / sr;
      const a = Math.min(1, tt / atk); // 5 ms linear attack
      const dt = Math.max(0, tt - atk);
      lp += 0.35 * (r() * 2 - 1 - lp); // softened noise: the escapement's scrape
      const click = lp * Math.exp(-dt / 0.005);
      const ring = Math.sin(2 * Math.PI * f * tt) * Math.exp(-dt / 0.006);
      const body = Math.sin(2 * Math.PI * 1650 * tt) * Math.exp(-dt / 0.008) * 0.35;
      d[at + j] += (click * 0.6 + ring * 0.8 + body) * a;
    }
  }
  normalizePeak(d, 0.7);
  return [d];
}

/** Soft-knee limiter curve for a WaveShaper: linear to `knee`, then tanh toward `ceil` (odd length: 0 → 0). */
export function softClipCurve(n = 4097, knee = 0.6, ceil = 0.95): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const room = ceil - knee;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    const ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + room * Math.tanh((ax - knee) / room);
    c[i] = x < 0 ? -y : y;
  }
  c[(n - 1) >> 1] = 0;
  return c;
}

// ----------------------------------------------------------------------------------------- wave tables

/** Harmonic (sine-phase) wave from partial amplitudes [h1, h2, ...]. Normalised by WebAudio. */
export function harmonicWave(ctx: BaseAudioContext, amps: readonly number[]): PeriodicWave {
  const n = amps.length + 1;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 1; i < n; i++) imag[i] = amps[i - 1];
  return ctx.createPeriodicWave(real, imag);
}

/** Band-limited pulse wave with the given duty cycle (0.5 = square), softened at the top harmonics. */
export function pulseWave(ctx: BaseAudioContext, duty: number, harmonics = 36): PeriodicWave {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) {
    const soft = k > harmonics * 0.5 ? Math.cos(((k - harmonics * 0.5) / (harmonics * 0.5)) * (Math.PI / 2)) : 1;
    real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty) * soft;
  }
  return ctx.createPeriodicWave(real, imag);
}
