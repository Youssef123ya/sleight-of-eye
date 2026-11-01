// The mixing graph + voice bookkeeping shared by the live engine and the offline verifier (owned by A).
//
//   music ─► musicDuck ─┐
//   sfx ────────────────┤
//   voices ─────────────┼─► mix ─► pause ─► volume ─► compressor ─► soft limiter ─► destination
//   crowd ──────────────┤
//   pad ────────────────┘
//   per-event sends ─► reverbIn ─► high-pass ─► convolver (generated warm-room IR) ─► reverbOut ─► mix
//
// Every one-shot gets a pooled voice slot (cap 24; when full the oldest lower-priority voice is stolen with a
// 15 ms fade) and, when it has a position, a pooled HRTF PannerNode. Its nodes are disconnected as soon as its
// sources fire 'ended'. Nothing here runs per rendered frame except `setListenerPose` (allocation-free).
import {
  cachedData,
  clamp,
  harmonicWave,
  hold,
  makeFuseLoop,
  makePink,
  makeRoomIR,
  makeTickLoop,
  makeWhite,
  mulberry32,
  pulseWave,
  softClipCurve,
  toBuffer,
  type Rng,
} from './dsp.js';

export type BusName = 'music' | 'sfx' | 'voices' | 'crowd' | 'pad';
export interface P3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Bus trims (linear). Balanced with the offline report (src/audio/offline.ts): the café trio's loudest 50 ms sits
 * ~10 dB under the sleight foley and ~12 dB under voices; its whole-excerpt loudness ~10 LU under foley peaks.
 */
export const MIX = {
  music: 0.18,
  sfx: 0.85,
  voices: 0.95,
  crowd: 0.7,
  pad: 0.55,
  reverb: 0.5,
  master: 0.9,
};

export const MAX_VOICES = 24;
export const MAX_LOOPS = 6;
export const PANNERS = 10;
/** Scheduling lead for one-shots: never schedule into the render quantum that is already playing. */
export const LEAD = 0.012;
const STEAL_FADE = 0.015;

/** `v` when it is a finite number, else `fallback` (NaN / Infinity / undefined never reach an AudioParam). */
export const fin = (v: number | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const warned = new Set<string>();
/** Log an audio problem once per key (never throws, never spams the frame loop). */
export function warnOnce(key: string, e?: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[audio] ${key}`, e ?? '');
}

// ------------------------------------------------------------------------------------------- resources

/** Lazily generated, per-context shared data: noise, the room IR, loop buffers, wave tables. */
export class Resources {
  private _white: AudioBuffer | null = null;
  private _pink: AudioBuffer | null = null;
  private _ir: AudioBuffer | null = null;
  private _fuse: AudioBuffer | null = null;
  private _tick: AudioBuffer | null = null;
  private _piano: PeriodicWave | null = null;
  private _bass: PeriodicWave | null = null;
  private _pulse: PeriodicWave | null = null;
  private _reed: PeriodicWave | null = null;

  constructor(private readonly ctx: BaseAudioContext) {}

  private get sr(): number {
    return this.ctx.sampleRate;
  }
  get white(): AudioBuffer {
    return (this._white ??= toBuffer(this.ctx, cachedData(`white:${this.sr}`, () => makeWhite(this.sr, 2.2, 101))));
  }
  get pink(): AudioBuffer {
    return (this._pink ??= toBuffer(this.ctx, cachedData(`pink:${this.sr}`, () => makePink(this.sr, 3.1, 202))));
  }
  get ir(): AudioBuffer {
    // 1.25 s is enough for RT60 1.05 s (the cut tail is already below -65 dB) and keeps the convolver light on Quest
    return (this._ir ??= toBuffer(this.ctx, cachedData(`ir:${this.sr}`, () => makeRoomIR(this.sr, 1.25, 1.05, 303))));
  }
  get fuse(): AudioBuffer {
    return (this._fuse ??= toBuffer(this.ctx, cachedData(`fuse:${this.sr}`, () => makeFuseLoop(this.sr, 1.6, 404))));
  }
  get tick(): AudioBuffer {
    return (this._tick ??= toBuffer(this.ctx, cachedData(`tick:${this.sr}`, () => makeTickLoop(this.sr, 505))));
  }
  /** Soft felt-hammer piano: bright partials that the per-chord low-pass then darkens over time. */
  get piano(): PeriodicWave {
    return (this._piano ??= harmonicWave(this.ctx, [1, 0.42, 0.24, 0.15, 0.09, 0.065, 0.04, 0.03, 0.018, 0.012]));
  }
  /** Upright bass: strong 2nd/3rd harmonics so the line reads on small headset speakers. */
  get bass(): PeriodicWave {
    return (this._bass ??= harmonicWave(this.ctx, [1, 0.62, 0.3, 0.12, 0.05, 0.02]));
  }
  /** 25% pulse: nasal, chirpy source for small animal voices. */
  get pulse(): PeriodicWave {
    return (this._pulse ??= pulseWave(this.ctx, 0.25));
  }
  /** 40% pulse: rounder reed-like source (cheers, rabbit). */
  get reed(): PeriodicWave {
    return (this._reed ??= pulseWave(this.ctx, 0.4, 28));
  }
}

// -------------------------------------------------------------------------------------- node lifetime

/** A group of nodes that is torn down (disconnected) once all of its scheduled sources have ended. */
export class NodeBag {
  readonly nodes: AudioNode[] = [];
  readonly sources: AudioScheduledSourceNode[] = [];
  pending = 0;
  serial = 0;
  done = true;
  onFinish: (() => void) | null = null;

  open(serial: number): void {
    this.serial = serial;
    this.done = false;
    this.pending = 0;
  }

  add<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  /** Track + start + stop a source; the bag finishes when every tracked source has ended. */
  play<T extends AudioScheduledSourceNode>(s: T, t0: number, t1: number, offset = 0): T {
    this.nodes.push(s);
    this.sources.push(s);
    this.pending++;
    const serial = this.serial;
    s.onended = () => {
      if (this.serial === serial && !this.done && --this.pending <= 0) this.finish();
    };
    if (offset > 0 && s instanceof AudioBufferSourceNode) s.start(t0, offset);
    else s.start(t0);
    s.stop(Math.max(t1, t0 + 0.01));
    return s;
  }

  /** Keep the bag alive while a progressive track is still adding notes. */
  hold(): void {
    this.pending++;
  }
  unhold(): void {
    if (!this.done && --this.pending <= 0) this.finish();
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    for (let i = 0; i < this.nodes.length; i++) {
      try {
        this.nodes[i].disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
    const f = this.onFinish;
    if (f) f();
  }
}

/**
 * A pooled panner remembers where it last played from (and which way the listener faced): Chrome's HRTF panner
 * cross-fades from its previous direction over 2048 frames (~43 ms), which smears a short sound toward wherever the
 * last one was (measured offline: a right-hand tink after a left-hand one kept only 4.7 dB of its 9.2 dB level
 * difference). So a slot is reused as-is only for the same spot and head direction; otherwise it gets a fresh node.
 */
interface PannerSlot {
  node: PannerNode;
  busy: boolean;
  x: number;
  y: number;
  z: number;
  fx: number;
  fy: number;
  fz: number;
}
/** Reuse a panner as-is within this distance (m) of where it last played … */
const PANNER_SAME_SPOT = 0.03;
/** … and while the listener's forward is within ~6° of where it was (cos). */
const PANNER_SAME_HEAD = 0.9945;

/** A pooled one-shot voice. */
export class VoiceSlot extends NodeBag {
  priority = 0;
  loop = false;
  startedAt = 0;
  out: GainNode | null = null;
  panner: PannerSlot | null = null;
}

/** Progressive note source pumped by the lookahead scheduler (music box). */
export interface Track {
  /** Schedule everything that starts before `until`; return true when finished. */
  pump(until: number): boolean;
  /** Retired after an error: release what it holds (notes already scheduled ring out). */
  abort?(): void;
}

export interface BeginOpts {
  bus: BusName;
  at?: P3 | null;
  volume?: number;
  pitch?: number;
  /** 0 = UI hover … 3 = key moments; a full pool steals the oldest voice with priority <= this. */
  priority?: number;
  loop?: boolean;
  /** Reverb send level (pre-panner). */
  send?: number;
}

// ------------------------------------------------------------------------------------------- the core

export class AudioCore {
  readonly ctx: BaseAudioContext;
  readonly rng: Rng;
  readonly res: Resources;
  readonly bus: Record<BusName, GainNode>;
  readonly musicDuck: GainNode;
  readonly mix: GainNode;
  readonly pauseGain: GainNode;
  readonly volume: GainNode;
  readonly comp: DynamicsCompressorNode;
  readonly limiter: WaveShaperNode;
  readonly reverbIn: GainNode;
  readonly reverbOut: GainNode;
  private readonly convolver: ConvolverNode;
  private readonly reverbHp: BiquadFilterNode;
  private readonly slots: VoiceSlot[] = [];
  private readonly panners: PannerSlot[] = [];
  private readonly tracks: Track[] = [];
  private serial = 1;
  private duckLevel = 1;
  private duckUntil = 0;
  private listenerSet = false;
  /** How many times the listener AudioParams were written (QA: proves still heads cost nothing). */
  listenerWrites = 0;
  /** Last listener pose (world): position, forward, up. Used for the stereo fallback when panners run out. */
  readonly listener = { x: 0, y: 1.2, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0 };
  readonly stats = { stolen: 0, refused: 0, peakVoices: 0, fallbackPans: 0, pannersReused: 0, pannersFresh: 0 };

  constructor(ctx: BaseAudioContext, opts: { seed?: number; toDestination?: boolean } = {}) {
    this.ctx = ctx;
    this.rng = mulberry32(opts.seed ?? 0x5eed);
    this.res = new Resources(ctx);
    const g = (v: number): GainNode => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    this.mix = g(1);
    this.bus = { music: g(MIX.music), sfx: g(MIX.sfx), voices: g(MIX.voices), crowd: g(MIX.crowd), pad: g(MIX.pad) };
    this.musicDuck = g(1);
    this.bus.music.connect(this.musicDuck).connect(this.mix);
    this.bus.sfx.connect(this.mix);
    this.bus.voices.connect(this.mix);
    this.bus.crowd.connect(this.mix);
    this.bus.pad.connect(this.mix);

    // warm room: the reverb only ever sees what events send to it
    this.reverbIn = g(1);
    this.reverbHp = ctx.createBiquadFilter();
    this.reverbHp.type = 'highpass';
    this.reverbHp.frequency.value = 170;
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;
    this.convolver.buffer = this.res.ir;
    this.reverbOut = g(MIX.reverb);
    this.reverbIn.connect(this.reverbHp).connect(this.convolver).connect(this.reverbOut).connect(this.mix);

    // master: pause fade → volume → gentle glue compressor → soft limiter (output can never exceed 0.95)
    this.pauseGain = g(1);
    this.volume = g(MIX.master);
    this.comp = ctx.createDynamicsCompressor();
    // light touch: only stacked peaks (bang + ovation + voices) are squeezed, so the auto make-up gain stays
    // small and the music bed is not lifted relative to foley
    this.comp.threshold.value = -9;
    this.comp.knee.value = 8;
    this.comp.ratio.value = 3;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.25;
    this.limiter = ctx.createWaveShaper();
    this.limiter.curve = softClipCurve();
    this.limiter.oversample = 'none';
    this.mix.connect(this.pauseGain).connect(this.volume).connect(this.comp).connect(this.limiter);
    if (opts.toDestination !== false) this.limiter.connect(ctx.destination);

    for (let i = 0; i < MAX_VOICES; i++) this.slots.push(new VoiceSlot());
    for (let i = 0; i < PANNERS; i++) {
      this.panners.push({ node: this.makePanner(), busy: false, x: Number.NaN, y: 0, z: 0, fx: 0, fy: 0, fz: -1 });
    }
  }

  private makePanner(): PannerNode {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 0.5;
    p.maxDistance = 20;
    p.rolloffFactor = 1;
    p.coneInnerAngle = 360;
    p.coneOuterAngle = 360;
    p.coneOuterGain = 1;
    return p;
  }

  /** Extra output tap (offline verifier routes the limiter into a channel merger). */
  connectOutput(dest: AudioNode): void {
    this.limiter.connect(dest);
  }

  now(): number {
    return this.ctx.currentTime;
  }

  activeVoices(): number {
    let n = 0;
    for (let i = 0; i < this.slots.length; i++) if (!this.slots[i].done) n++;
    return n;
  }

  pannersInUse(): number {
    let n = 0;
    for (let i = 0; i < this.panners.length; i++) if (this.panners[i].busy) n++;
    return n;
  }

  // ------------------------------------------------------------------------------------------ events

  /** Open a one-shot event: a voice slot, an output gain (+ reverb send) routed to a bus, spatial if `at`. */
  begin(o: BeginOpts): Ev | null {
    // Sanitise first: a NaN reaching an AudioParam throws, and a throw after the slot opened would leak it.
    const prio = fin(o.priority, 1);
    const at = o.at && Number.isFinite(o.at.x) && Number.isFinite(o.at.y) && Number.isFinite(o.at.z) ? o.at : null;
    const slot = this.acquire(prio, !!o.loop);
    if (!slot) {
      this.stats.refused++;
      return null;
    }
    const ctx = this.ctx;
    const now = ctx.currentTime;
    slot.open(this.serial++);
    slot.priority = prio;
    slot.loop = !!o.loop;
    slot.startedAt = now;
    slot.onFinish = () => this.release(slot);
    const out = slot.add(ctx.createGain());
    out.gain.value = clamp(fin(o.volume, 1), 0, 8); // caller volume (clamped 0..2 by the engine) × calibration trim
    const send = slot.add(ctx.createGain());
    send.gain.value = clamp(fin(o.send, 0.15), 0, 1);
    out.connect(send);
    send.connect(this.reverbIn);
    slot.out = out;
    const busNode = this.bus[o.bus] ?? this.bus.sfx;
    if (at) this.route(slot, out, at, busNode, now);
    else out.connect(busNode);
    const active = this.activeVoices();
    if (active > this.stats.peakVoices) this.stats.peakVoices = active;
    const pitch = fin(o.pitch, 1);
    return new Ev(this, slot, now + LEAD, out, send, clamp(pitch > 0 ? pitch : 1, 0.25, 4));
  }

  /** An unpooled event straight into `dest` (music notes): no slot, no panner, no send of its own. */
  loose(dest: AudioNode, t: number): Ev {
    const bag = new NodeBag();
    bag.open(this.serial++);
    return new Ev(this, bag, t, dest, null, 1);
  }

  private acquire(prio: number, loop: boolean): VoiceSlot | null {
    let free: VoiceSlot | null = null;
    let victim: VoiceSlot | null = null;
    let oldestLoop: VoiceSlot | null = null;
    let loops = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.done) {
        if (!free) free = s;
        continue;
      }
      if (s.loop) {
        loops++;
        if (!oldestLoop || s.startedAt < oldestLoop.startedAt) oldestLoop = s;
        continue;
      }
      if (s.priority <= prio && (!victim || s.startedAt < victim.startedAt)) victim = s;
    }
    if (loop && loops >= MAX_LOOPS && oldestLoop) {
      this.steal(oldestLoop); // a leaked loop handle must never eat the whole pool
      return oldestLoop;
    }
    if (free) return free;
    if (!victim) return null;
    this.steal(victim);
    return victim;
  }

  /** Fade a voice out over 15 ms and hand its slot over immediately (old nodes are cleaned up later). */
  private steal(v: VoiceSlot): void {
    this.stats.stolen++;
    const now = this.ctx.currentTime;
    if (v.out) {
      hold(v.out.gain, now);
      v.out.gain.linearRampToValueAtTime(0, now + STEAL_FADE);
    }
    for (let i = 0; i < v.sources.length; i++) {
      try {
        v.sources[i].stop(now + STEAL_FADE + 0.005);
      } catch {
        /* already stopped */
      }
    }
    const zombies = v.nodes.slice();
    const panner = v.panner;
    v.nodes.length = 0;
    v.sources.length = 0;
    v.panner = null;
    v.out = null;
    v.done = true; // stale onended handlers are ignored (serial changes on the next open)
    setTimeout(() => {
      for (let i = 0; i < zombies.length; i++) {
        try {
          zombies[i].disconnect();
        } catch {
          /* gone */
        }
      }
      if (panner) {
        try {
          panner.node.disconnect();
        } catch {
          /* gone */
        }
        panner.busy = false;
      }
    }, (STEAL_FADE + 0.08) * 1000);
  }

  private release(slot: VoiceSlot): void {
    slot.out = null;
    const p = slot.panner;
    if (p) {
      try {
        p.node.disconnect();
      } catch {
        /* gone */
      }
      p.busy = false;
      slot.panner = null;
    }
  }

  private route(slot: VoiceSlot, out: GainNode, at: P3, busNode: AudioNode, now: number): void {
    // the idle panner that last played nearest to this spot
    const L = this.listener;
    const near2 = PANNER_SAME_SPOT * PANNER_SAME_SPOT;
    let p: PannerSlot | null = null;
    let best = Infinity;
    for (let i = 0; i < this.panners.length; i++) {
      const c = this.panners[i];
      if (c.busy) continue;
      // a never-used node ranks after a same-spot match but before any stale one
      const d = Number.isNaN(c.x) ? near2 * 1.0001 : (c.x - at.x) ** 2 + (c.y - at.y) ** 2 + (c.z - at.z) ** 2;
      if (d < best) {
        best = d;
        p = c;
      }
    }
    if (p) {
      const pristine = Number.isNaN(p.x);
      const sameHead = p.fx * L.fx + p.fy * L.fy + p.fz * L.fz >= PANNER_SAME_HEAD;
      if (pristine) {
        /* first use: no HRTF history */
      } else if (best <= near2 && sameHead) {
        this.stats.pannersReused++;
      } else {
        // stale HRTF direction: swap in a fresh node (the idle one is already disconnected and is dropped)
        p.node = this.makePanner();
        this.stats.pannersFresh++;
      }
      p.busy = true;
      p.x = at.x;
      p.y = at.y;
      p.z = at.z;
      p.fx = L.fx;
      p.fy = L.fy;
      p.fz = L.fz;
      slot.panner = p;
      const n = p.node;
      if (n.positionX) {
        n.positionX.setValueAtTime(at.x, now);
        n.positionY.setValueAtTime(at.y, now);
        n.positionZ.setValueAtTime(at.z, now);
      } else {
        n.setPosition(at.x, at.y, at.z);
      }
      n.connect(busNode);
      out.connect(n);
      return;
    }
    // Pool exhausted: equal-power stereo pan from the listener-relative bearing + inverse distance.
    this.stats.fallbackPans++;
    const dx = at.x - L.x, dy = at.y - L.y, dz = at.z - L.z;
    const dist = Math.hypot(dx, dy, dz);
    const rx = L.fy * L.uz - L.fz * L.uy, ry = L.fz * L.ux - L.fx * L.uz, rz = L.fx * L.uy - L.fy * L.ux;
    const sp = slot.add(this.ctx.createStereoPanner());
    const dg = slot.add(this.ctx.createGain());
    sp.pan.value = dist > 1e-4 ? clamp((dx * rx + dy * ry + dz * rz) / dist, -1, 1) * 0.85 : 0;
    dg.gain.value = 0.5 / (0.5 + Math.max(0, dist - 0.5));
    out.connect(dg).connect(sp).connect(busNode);
  }

  // ----------------------------------------------------------------------------------- scheduling

  addTrack(t: Track): void {
    this.tracks.push(t);
  }

  pumpTracks(until: number): void {
    for (let i = this.tracks.length - 1; i >= 0; i--) {
      let finished = true;
      try {
        finished = this.tracks[i].pump(until);
      } catch (e) {
        warnOnce('track pump failed', e);
        try {
          this.tracks[i].abort?.();
        } catch {
          /* already broken */
        }
      }
      if (finished) {
        this.tracks[i] = this.tracks[this.tracks.length - 1];
        this.tracks.pop();
      }
    }
  }

  /** Duck the music bus to `level` from t0 until t1 (nested ducks keep the deepest level and the latest end). */
  duck(level: number, t0: number, t1: number): void {
    const p = this.musicDuck.gain;
    const now = this.ctx.currentTime;
    if (now >= this.duckUntil) this.duckLevel = 1;
    this.duckLevel = Math.min(this.duckLevel, level);
    this.duckUntil = Math.max(this.duckUntil, t1);
    hold(p, now);
    p.setTargetAtTime(this.duckLevel, Math.max(now, t0 - 0.04), 0.06);
    p.setTargetAtTime(1, this.duckUntil + 0.08, 0.35);
  }

  /**
   * Listener pose in world space (allocation-free). Skips redundant writes; `immediate` for offline renders.
   * `write = false` only caches the pose (stereo fallback pans) while another owner — three's AudioListener, which
   * IWSDK keeps on the XR head — drives the shared context's listener: two writers would interleave their ramps.
   * Returns true when AudioParams were written.
   */
  setListenerPose(
    px: number, py: number, pz: number,
    fx: number, fy: number, fz: number,
    ux: number, uy: number, uz: number,
    immediate = false,
    write = true,
  ): boolean {
    if (!(Number.isFinite(px + py + pz + fx + fy + fz + ux + uy + uz))) return false;
    const L = this.listener;
    if (!write) {
      L.x = px; L.y = py; L.z = pz; L.fx = fx; L.fy = fy; L.fz = fz; L.ux = ux; L.uy = uy; L.uz = uz;
      this.listenerSet = false; // write in full when ownership comes back
      return false;
    }
    if (
      this.listenerSet &&
      Math.abs(px - L.x) + Math.abs(py - L.y) + Math.abs(pz - L.z) < 5e-4 &&
      Math.abs(fx - L.fx) + Math.abs(fy - L.fy) + Math.abs(fz - L.fz) + Math.abs(ux - L.ux) + Math.abs(uy - L.uy) + Math.abs(uz - L.uz) < 2e-3
    ) {
      return false;
    }
    this.listenerSet = true;
    this.listenerWrites++;
    L.x = px; L.y = py; L.z = pz; L.fx = fx; L.fy = fy; L.fz = fz; L.ux = ux; L.uy = uy; L.uz = uz;
    const l = this.ctx.listener;
    if (l.positionX) {
      const t = this.ctx.currentTime;
      if (immediate) {
        l.positionX.setValueAtTime(px, t); l.positionY.setValueAtTime(py, t); l.positionZ.setValueAtTime(pz, t);
        l.forwardX.setValueAtTime(fx, t); l.forwardY.setValueAtTime(fy, t); l.forwardZ.setValueAtTime(fz, t);
        l.upX.setValueAtTime(ux, t); l.upY.setValueAtTime(uy, t); l.upZ.setValueAtTime(uz, t);
      } else {
        // same smoothing scheme as three's AudioListener (which IWSDK also keeps on the head): no zipper noise
        const e = t + 0.02;
        l.positionX.linearRampToValueAtTime(px, e); l.positionY.linearRampToValueAtTime(py, e); l.positionZ.linearRampToValueAtTime(pz, e);
        l.forwardX.linearRampToValueAtTime(fx, e); l.forwardY.linearRampToValueAtTime(fy, e); l.forwardZ.linearRampToValueAtTime(fz, e);
        l.upX.linearRampToValueAtTime(ux, e); l.upY.linearRampToValueAtTime(uy, e); l.upZ.linearRampToValueAtTime(uz, e);
      }
    } else {
      l.setPosition(px, py, pz);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
    return true;
  }

  dispose(): void {
    for (let i = 0; i < this.slots.length; i++) if (!this.slots[i].done) this.slots[i].finish();
    for (let i = 0; i < this.panners.length; i++) {
      try {
        this.panners[i].node.disconnect();
      } catch {
        /* gone */
      }
    }
    try {
      this.limiter.disconnect();
      this.mix.disconnect();
    } catch {
      /* gone */
    }
    this.tracks.length = 0;
  }
}

// ------------------------------------------------------------------------------------------ the event

/** Builder for one sound event: every node it creates is tracked and torn down with the event. */
export class Ev {
  constructor(
    readonly core: AudioCore,
    readonly bag: NodeBag,
    /** Start time (audio clock). */
    readonly t: number,
    /** Event output (dry). */
    readonly out: AudioNode,
    /** Reverb send gain (pre-panner), null for loose events. */
    readonly send: GainNode | null,
    /** Pitch multiplier from the caller. */
    readonly pitch: number,
  ) {}

  get ctx(): BaseAudioContext {
    return this.core.ctx;
  }
  get rng(): Rng {
    return this.core.rng;
  }
  get res(): Resources {
    return this.core.res;
  }

  /** Pitch-scaled frequency, clamped below Nyquist. */
  hz(f: number): number {
    return clamp(f * this.pitch, 20, this.core.ctx.sampleRate * 0.45);
  }

  /** Raw frequency clamped below Nyquist (no pitch scaling). */
  safe(f: number): number {
    return clamp(f, 20, this.core.ctx.sampleRate * 0.45);
  }

  setSend(v: number): void {
    if (this.send) this.send.gain.value = v;
  }

  /** Tracked gain; `dest` may be a node, an AudioParam (modulation) or null (connect it yourself). */
  gain(v: number, dest: AudioNode | AudioParam | null): GainNode {
    const g = this.bag.add(this.ctx.createGain());
    g.gain.value = v;
    if (dest instanceof AudioParam) g.connect(dest);
    else if (dest) g.connect(dest);
    return g;
  }

  filter(type: BiquadFilterType, f: number, q: number, dest: AudioNode): BiquadFilterNode {
    const n = this.bag.add(this.ctx.createBiquadFilter());
    n.type = type;
    n.frequency.value = this.safe(f);
    n.Q.value = q;
    n.connect(dest);
    return n;
  }

  osc(wave: OscillatorType | PeriodicWave, f: number, t0: number, t1: number, dest: AudioNode): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (wave instanceof PeriodicWave) o.setPeriodicWave(wave);
    else o.type = wave;
    o.frequency.value = this.safe(f);
    o.connect(dest);
    return this.bag.play(o, t0, t1);
  }

  /** Noise from the shared buffers (random offset; loops when longer than the buffer). */
  noise(kind: 'white' | 'pink', t0: number, t1: number, dest: AudioNode, rate = 1): AudioBufferSourceNode {
    const b = kind === 'white' ? this.res.white : this.res.pink;
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.playbackRate.value = rate;
    const need = (t1 - t0) * rate;
    let offset = 0;
    if (need < b.duration - 0.05) offset = this.rng() * (b.duration - need - 0.03);
    else {
      s.loop = true;
      offset = this.rng() * b.duration * 0.9;
    }
    s.connect(dest);
    return this.bag.play(s, t0, t1, offset);
  }

  buffer(b: AudioBuffer, t0: number, t1: number, dest: AudioNode, loop = false, rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.loop = loop;
    s.playbackRate.value = rate;
    s.connect(dest);
    return this.bag.play(s, t0, t1);
  }
}
