// Sleight of Eye audio engine (owned by A): every sound is synthesized at runtime with WebAudio.
//
// `createAudioEngine()` implements the AudioEngine contract. It is inert until `unlock()` (call it from the
// Enter gesture): unlock resumes the ONE AudioContext (three's shared context, which IWSDK's AudioSystem also
// uses, so the page never runs two audio threads) and builds the graph. Before that every method is a safe
// no-op; state set early (music on/mood, tension, volume, pause) is remembered and applied on unlock.
//
// `EngineImpl` holds all of the actual sound logic and runs on any BaseAudioContext, so the offline verifier
// (src/audio/offline.ts) renders exactly the code the game plays.
//
// Robustness: the page going hidden suspends the context (and resuming it waits for visibility AND the game's
// setPaused(false)); the scheduler slides its grid after main-thread stalls instead of scheduling into the past;
// non-finite inputs never reach an AudioParam; every public method swallows (and logs once) its own errors.
// QA: `window.__audio` is the debug view of the most recently created engine (state, voices, meter, …).
import { AudioContext as ThreeAudioContext, type Object3D } from '@iwsdk/core';
import type { AudioEngine, CrowdKind, Mood, SfxName, SpectatorKind } from '../contracts.js';
import { AudioCore, fin, MIX, warnOnce, type Ev, type P3 } from './core.js';
import { CROWD_PRIORITY, crowdSound } from './crowd.js';
import { clamp, hold } from './dsp.js';
import { Music, MusicBoxTrack, type MusicMood } from './music.js';
import { TensionPad } from './pad.js';
import { SFX } from './sfx.js';
import { speak } from './voice.js';

/**
 * Lookahead scheduler: a 25 ms timer schedules everything within the next 200 ms of audio time, so a main-thread
 * hitch of up to ~175 ms (shader compile, GC, a long frame on Quest) never makes the music late.
 */
export const TICK_MS = 25;
export const LOOKAHEAD = 0.2;
/** Music box length when the caller passes NaN; Infinity (Easy Audience) plays the longest show. */
const MUSIC_BOX_DEFAULT = 5;
const MUSIC_BOX_MAX = 30;

export interface LoopHandle {
  stop(): void;
}
const NOOP_LOOP: LoopHandle = { stop() {} };

/** Close an event that turned out to create no sources (keeps the voice pool clean). */
function settle(ev: Ev, end: number): void {
  if (!Number.isFinite(end)) warnOnce('a recipe returned a non-finite end time');
  if (ev.bag.pending <= 0) ev.bag.finish();
}

// --------------------------------------------------------------------------------------- the sound logic

export class EngineImpl {
  readonly core: AudioCore;
  readonly music: Music;
  readonly pad: TensionPad;
  private lastHover = -1;
  private lastTink = -1;

  constructor(
    readonly ctx: BaseAudioContext,
    opts: { seed?: number; toDestination?: boolean; live?: boolean } = {},
  ) {
    this.core = new AudioCore(ctx, { seed: opts.seed, toDestination: opts.toDestination });
    this.pad = new TensionPad(this.core, !!opts.live);
    this.music = new Music(this.core);
  }

  sfx(name: SfxName, opts?: { at?: P3; volume?: number; pitch?: number }): void {
    const spec = SFX[name];
    if (!spec) return;
    const now = this.ctx.currentTime;
    if (name === 'uiHover') {
      if (now - this.lastHover < 0.08) return; // hands sweep across many targets
      this.lastHover = now;
    } else if (name === 'tink') {
      if (now - this.lastTink < 0.06) return;
      this.lastTink = now;
    }
    const ev = this.core.begin({
      bus: 'sfx',
      at: opts?.at,
      volume: clamp(fin(opts?.volume, 1), 0, 2) * spec.trim,
      pitch: opts?.pitch,
      priority: spec.prio,
      send: spec.send,
    });
    if (!ev) return;
    try {
      settle(ev, spec.play(ev));
    } catch (e) {
      ev.bag.finish();
      throw e;
    }
  }

  loop(name: 'fuse' | 'tick', at?: P3 | null): LoopHandle {
    const ev = this.core.begin({ bus: 'sfx', at, priority: 3, loop: true, send: name === 'fuse' ? 0.12 : 0.06 });
    if (!ev) return NOOP_LOOP;
    const g = ev.gain(0, ev.out);
    const level = name === 'fuse' ? 1.4 : 1.0;
    let src: AudioBufferSourceNode;
    try {
      g.gain.setValueAtTime(0, ev.t);
      g.gain.linearRampToValueAtTime(level, ev.t + 0.03);
      src = ev.buffer(name === 'fuse' ? ev.res.fuse : ev.res.tick, ev.t, ev.t + 36000, g, true);
    } catch (e) {
      ev.bag.finish(); // never leak the voice slot
      throw e;
    }
    const bag = ev.bag;
    const serial = bag.serial;
    const ctx = this.ctx;
    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (bag.done || bag.serial !== serial) return;
        try {
          const now = ctx.currentTime;
          hold(g.gain, now);
          g.gain.linearRampToValueAtTime(0, now + 0.06);
          src.stop(now + 0.075);
        } catch (e) {
          warnOnce('loop stop failed', e);
        }
      },
    };
  }

  say(text: string, at: P3 | null | undefined, voice: SpectatorKind, mood?: Mood): void {
    if (!text) return;
    const ev = this.core.begin({ bus: 'voices', at, priority: 3, send: 0.1 });
    if (!ev) return;
    try {
      const end = speak(ev, String(text), voice, mood);
      this.core.duck(0.6, ev.t, end); // music steps back while anyone talks
      settle(ev, end);
    } catch (e) {
      ev.bag.finish();
      throw e;
    }
  }

  crowd(kind: CrowdKind, intensity: number, at?: P3 | null): void {
    const I = clamp(Number.isFinite(intensity) ? intensity : 0.5, 0, 1);
    const ev = this.core.begin({ bus: 'crowd', at, priority: CROWD_PRIORITY[kind] ?? 2, send: 0.28 });
    if (!ev) return;
    try {
      settle(ev, crowdSound(ev, kind, I));
    } catch (e) {
      ev.bag.finish();
      throw e;
    }
  }

  musicBox(at: P3 | null | undefined, seconds: number): void {
    // Easy Audience passes Infinity: the contract has no stop for it, so the box plays up to 30 s.
    const s = typeof seconds === 'number' && !Number.isNaN(seconds) ? seconds : MUSIC_BOX_DEFAULT;
    const secs = clamp(s === Infinity ? MUSIC_BOX_MAX : s, 0.5, MUSIC_BOX_MAX);
    const ev = this.core.begin({ bus: 'sfx', at, priority: 3, send: 0.3 });
    if (!ev) return;
    let track: MusicBoxTrack;
    try {
      track = new MusicBoxTrack(ev, secs);
    } catch (e) {
      ev.bag.finish(); // never leak the voice slot
      throw e;
    }
    this.core.addTrack(track);
    this.core.duck(0.4, ev.t, ev.t + track.duration - 1.6); // the trio listens to the music box
    this.core.pumpTracks(this.ctx.currentTime + LOOKAHEAD); // first notes now (guarded: a throwing track is retired)
  }

  setMood(m: MusicMood): void {
    this.music.setMood(m);
    this.pad.setRoot(Music.padRoot(m));
  }

  setTension(watchers: number, max: number): void {
    this.pad.set(watchers, max);
  }

  /** Lookahead pump: schedule music + progressive tracks up to `until` (audio clock). */
  pump(until: number): void {
    this.music.pump(until);
    this.core.pumpTracks(until);
  }

  setListenerPose(
    px: number, py: number, pz: number,
    fx: number, fy: number, fz: number,
    ux: number, uy: number, uz: number,
    immediate = false,
    write = true,
  ): boolean {
    return this.core.setListenerPose(px, py, pz, fx, fy, fz, ux, uy, uz, immediate, write);
  }

  setMasterVolume(v: number): void {
    const p = this.core.volume.gain;
    const now = this.ctx.currentTime;
    hold(p, now);
    p.setTargetAtTime(clamp(Number.isFinite(v) ? v : 1, 0, 1.5) * MIX.master, now, 0.03);
  }

  /** Pause fade: down is a linear ramp to an exact 0 (the context is suspended after it), up is smooth. */
  setPauseGain(level: number, seconds: number): void {
    const p = this.core.pauseGain.gain;
    const now = this.ctx.currentTime;
    hold(p, now);
    if (level <= 0) p.linearRampToValueAtTime(0, now + Math.max(0.02, seconds));
    else p.setTargetAtTime(level, now, Math.max(0.01, seconds / 3));
  }

  /** Generate every shared buffer / wave table now, so no sound ever pays for it on first use. */
  warm(): void {
    const r = this.core.res;
    const made = [r.white, r.pink, r.fuse, r.tick, r.piano, r.bass, r.pulse, r.reed];
    if (made.some((x) => !x)) warnOnce('warm-up incomplete');
  }

  dispose(): void {
    this.music.stop(0.05);
    this.pad.dispose();
    this.core.dispose();
  }
}

// ------------------------------------------------------------------------------------- the live engine

export interface AudioMeter {
  peak: number;
  rms: number;
}

/** Debug/QA view of a live engine (demo meters, tests, `window.__audio`). Not part of the game contract. */
export interface AudioDebug {
  /** 'locked' before unlock, else the AudioContext state. */
  readonly state: string;
  readonly voices: number;
  readonly panners: number;
  readonly stats: { stolen: number; refused: number; peakVoices: number; fallbackPans: number } | null;
  /** Who writes the context's listener: 'engine', 'three' (IWSDK's AudioListener on the XR head) or 'none' yet. */
  readonly listenerOwner: 'engine' | 'three' | 'none';
  /** Listener AudioParam writes by this engine so far (a still head adds none). */
  readonly listenerWrites: number;
  /** setPaused(true) from the game. */
  readonly paused: boolean;
  /** The page is hidden (the engine suspends itself). */
  readonly hidden: boolean;
  /** The engine itself (QA scripts call the contract through it). */
  readonly engine: AudioEngine;
  /** Master output level over the last ~20 ms (allocation-free; writes into `out`). */
  meter(out: AudioMeter): AudioMeter;
  impl(): EngineImpl | null;
  context(): AudioContext | null;
  dispose(): void;
}

/** DOM events that count as user activation: a context the browser refused to start retries on the next one. */
const GESTURES = ['pointerdown', 'pointerup', 'keydown', 'touchend', 'click'] as const;
/** How often to look again for a three AudioListener driving the shared context (ms). */
const LISTENER_SCAN_MS = 2000;

class LiveAudioEngine implements AudioEngine {
  private impl: EngineImpl | null = null;
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private analyser: AnalyserNode | null = null;
  private scope: Float32Array<ArrayBuffer> | null = null;
  private wantMusic = false;
  private mood: MusicMood = 'calm';
  private watchers = 0;
  private maxWatchers = 1;
  private volume = 1;
  private paused = false;
  private hidden = false;
  private pageHooked = false;
  private gestureArmed = false;
  private threeListener: Object3D | null = null;
  private scanRoot: Object3D | null = null;
  private listenerScanAt = -Infinity;
  private owner: 'engine' | 'three' | 'none' = 'none';
  readonly music: AudioEngine['music'];
  readonly debug: AudioDebug;

  constructor() {
    this.music = {
      start: () =>
        this.guard('music.start', () => {
          this.wantMusic = true;
          this.impl?.music.start();
        }),
      stop: (fadeSeconds?: number) =>
        this.guard('music.stop', () => {
          this.wantMusic = false;
          this.impl?.music.stop(fin(fadeSeconds, 1.5));
        }),
      setMood: (mood) =>
        this.guard('music.setMood', () => {
          if (mood !== 'calm' && mood !== 'tense' && mood !== 'triumph') return;
          this.mood = mood;
          this.impl?.setMood(mood);
        }),
    };
    const self = this;
    this.debug = {
      get state() {
        return self.ctx && self.impl ? self.ctx.state : 'locked';
      },
      get voices() {
        return self.impl ? self.impl.core.activeVoices() : 0;
      },
      get panners() {
        return self.impl ? self.impl.core.pannersInUse() : 0;
      },
      get stats() {
        return self.impl ? self.impl.core.stats : null;
      },
      get listenerOwner() {
        return self.owner;
      },
      get listenerWrites() {
        return self.impl ? self.impl.core.listenerWrites : 0;
      },
      get paused() {
        return self.paused;
      },
      get hidden() {
        return self.hidden;
      },
      engine: this,
      meter: (out) => this.readMeter(out),
      impl: () => this.impl,
      context: () => this.ctx,
      dispose: () => this.dispose(),
    };
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      warnOnce(`${what} failed`, e);
    }
  }

  /** True when one-shots should sound (unlocked, running, not paused/hidden): queued sounds never burst on resume. */
  private live(): EngineImpl | null {
    const impl = this.impl;
    if (!impl || this.paused || this.hidden || !this.ctx || this.ctx.state !== 'running') return null;
    return impl;
  }

  unlock(): Promise<void> {
    try {
      // @types/three types getContext() as its own wrapper class; at runtime it is the native AudioContext
      const ctx = (this.ctx ??= ThreeAudioContext.getContext() as unknown as AudioContext);
      // resume() first, synchronously inside the user gesture
      const resumed: Promise<unknown> = ctx.state === 'running' ? Promise.resolve() : ctx.resume().catch(() => undefined);
      if (!this.impl) {
        const impl = new EngineImpl(ctx, { seed: (Date.now() & 0xffff) ^ 0x5eed, live: true });
        this.impl = impl;
        impl.setMasterVolume(this.volume);
        impl.setMood(this.mood);
        impl.setTension(this.watchers, this.maxWatchers);
        if (this.wantMusic) impl.music.start();
        this.timer = setInterval(this.tick, TICK_MS);
        this.hookPage();
        if (this.paused || this.hidden) this.applyPause(true);
        setTimeout(() => this.guard('warm-up', () => impl.warm()), 0); // ~10 ms of buffer synthesis, off the gesture
      }
      if (ctx.state !== 'running') this.armGestureRetry();
      // never hang the Enter flow: resume() stays pending forever when the browser refuses to start audio
      return Promise.race([resumed, new Promise((r) => setTimeout(r, 1500))]).then(() => undefined);
    } catch (e) {
      warnOnce('unlock failed', e);
      return Promise.resolve();
    }
  }

  private readonly tick = (): void => {
    const impl = this.impl;
    const ctx = this.ctx;
    if (!impl || !ctx || ctx.state !== 'running') return;
    try {
      impl.pump(ctx.currentTime + LOOKAHEAD);
    } catch (e) {
      warnOnce('scheduler failed', e);
    }
  };

  // ------------------------------------------------------------------------------- page lifecycle

  /** Hidden page → fade + suspend (no CPU, no backlog); visible again → resume unless the game paused us. */
  private hookPage(): void {
    if (this.pageHooked || typeof document === 'undefined') return;
    this.pageHooked = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.onVisibility();
  }

  private readonly onVisibility = (): void => {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.guard('visibility', () => this.applyPause(this.paused || this.hidden));
  };

  /** The browser refused to start audio (no activation yet): retry on the next user gesture. */
  private armGestureRetry(): void {
    if (this.gestureArmed || typeof window === 'undefined') return;
    this.gestureArmed = true;
    for (const t of GESTURES) window.addEventListener(t, this.onGesture, true);
  }

  private disarmGestureRetry(): void {
    if (!this.gestureArmed) return;
    this.gestureArmed = false;
    for (const t of GESTURES) window.removeEventListener(t, this.onGesture, true);
  }

  private readonly onGesture = (): void => {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') {
      this.disarmGestureRetry();
      return;
    }
    if (this.paused || this.hidden) return;
    ctx
      .resume()
      .then(() => {
        if (ctx.state === 'running') this.disarmGestureRetry();
      })
      .catch(() => undefined);
  };

  // ------------------------------------------------------------------------------------ contract

  sfx(name: SfxName, opts?: { at?: Vector3Like; volume?: number; pitch?: number }): void {
    const impl = this.live();
    if (impl) this.guard(`sfx ${name}`, () => impl.sfx(name, opts));
  }

  loop(name: 'fuse' | 'tick', at?: Vector3Like): { stop(): void } {
    const impl = this.live();
    if (!impl) return NOOP_LOOP;
    try {
      return impl.loop(name, at);
    } catch (e) {
      warnOnce(`loop ${name} failed`, e);
      return NOOP_LOOP;
    }
  }

  say(text: string, opts: { at: Vector3Like; voice: SpectatorKind; mood?: Mood }): void {
    const impl = this.live();
    if (impl && opts) this.guard('say', () => impl.say(text, opts.at, opts.voice, opts.mood));
  }

  crowd(kind: CrowdKind, intensity: number, at?: Vector3Like): void {
    const impl = this.live();
    if (impl) this.guard(`crowd ${kind}`, () => impl.crowd(kind, intensity, at));
  }

  musicBox(at: Vector3Like, seconds: number): void {
    const impl = this.live();
    if (impl) this.guard('musicBox', () => impl.musicBox(at, seconds));
  }

  /** Safe to call every frame: no allocation, and the pad ignores unchanged levels. */
  setTension(watchers: number, maxWatchers: number): void {
    this.watchers = fin(watchers, 0);
    this.maxWatchers = fin(maxWatchers, 1);
    const impl = this.impl;
    if (!impl) return;
    try {
      impl.setTension(this.watchers, this.maxWatchers);
    } catch (e) {
      warnOnce('setTension failed', e);
    }
  }

  /**
   * Per frame, allocation-free: one world-matrix update, then position + forward (-Z) + up (+Y) read straight from
   * the matrix columns. While IWSDK's three AudioListener (on the XR head) drives the shared context's listener, only
   * the pose is cached (stereo fallback pans) — two writers would interleave their ramps a frame apart and wobble
   * the HRTF image during head turns. Otherwise the AudioParams are written, skipping writes when the head is still.
   */
  setListener(head: Object3D): void {
    const impl = this.impl;
    if (!impl || !head) return;
    try {
      head.updateWorldMatrix(true, false);
      const m = head.matrixWorld.elements;
      const ux = m[4], uy = m[5], uz = m[6];
      const bx = m[8], by = m[9], bz = m[10];
      const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
      const bl = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
      const own = !this.threeListenerDrives(head);
      this.owner = own ? 'engine' : 'three';
      impl.setListenerPose(m[12], m[13], m[14], -bx / bl, -by / bl, -bz / bl, ux / ul, uy / ul, uz / ul, false, own);
    } catch (e) {
      warnOnce('setListener failed', e);
    }
  }

  /** Is a three AudioListener on our context attached to the scene `head` lives in? (rescanned every 2 s) */
  private threeListenerDrives(head: Object3D): boolean {
    let root: Object3D = head;
    while (root.parent) root = root.parent;
    const now = performance.now();
    if (root === this.scanRoot && now - this.listenerScanAt < LISTENER_SCAN_MS) return this.threeListener !== null;
    this.scanRoot = root;
    this.listenerScanAt = now;
    this.threeListener = this.findListener(root);
    return this.threeListener !== null;
  }

  private findListener(o: Object3D): Object3D | null {
    if (o.type === 'AudioListener' && (o as Object3D & { context?: unknown }).context === this.ctx) return o;
    const ch = o.children;
    for (let i = 0; i < ch.length; i++) {
      const hit = this.findListener(ch[i]);
      if (hit) return hit;
    }
    return null;
  }

  setPaused(paused: boolean): void {
    this.paused = !!paused;
    this.guard('setPaused', () => this.applyPause(this.paused || this.hidden));
  }

  private applyPause(p: boolean): void {
    const impl = this.impl;
    const ctx = this.ctx;
    if (!impl || !ctx) return;
    if (this.suspendTimer !== null) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    if (p) {
      impl.setPauseGain(0, 0.2); // ramp to an exact 0, then suspend the whole audio thread (no CPU while paused)
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        if ((this.paused || this.hidden) && ctx.state === 'running') ctx.suspend().catch(() => undefined);
      }, 320);
    } else {
      impl.setPauseGain(1, 0.3);
      if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
    }
  }

  setMasterVolume(v: number): void {
    this.volume = fin(v, 1);
    const impl = this.impl;
    if (impl) this.guard('setMasterVolume', () => impl.setMasterVolume(this.volume));
  }

  private readMeter(out: AudioMeter): AudioMeter {
    out.peak = 0;
    out.rms = 0;
    const impl = this.impl;
    const ctx = this.ctx;
    if (!impl || !ctx) return out;
    if (!this.analyser) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      impl.core.connectOutput(this.analyser);
      this.scope = new Float32Array(this.analyser.fftSize);
    }
    const s = this.scope!;
    this.analyser.getFloatTimeDomainData(s);
    let pk = 0;
    let sum = 0;
    for (let i = 0; i < s.length; i++) {
      const a = Math.abs(s[i]);
      if (a > pk) pk = a;
      sum += s[i] * s[i];
    }
    out.peak = pk;
    out.rms = Math.sqrt(sum / s.length);
    return out;
  }

  private dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.suspendTimer !== null) clearTimeout(this.suspendTimer);
    this.timer = null;
    this.suspendTimer = null;
    this.disarmGestureRetry();
    if (this.pageHooked && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.pageHooked = false;
    try {
      this.analyser?.disconnect();
    } catch {
      /* gone */
    }
    this.analyser = null;
    this.impl?.dispose();
    this.impl = null;
    this.threeListener = null;
    this.scanRoot = null;
  }
}

/** Anything with x/y/z (three's Vector3 included): positions are read once, at call time. */
type Vector3Like = P3;

const registry = new WeakMap<AudioEngine, LiveAudioEngine>();

/** The game's audio engine (contract: AudioEngine). Call `unlock()` from the Enter gesture. */
export function createAudioEngine(): AudioEngine {
  const e = new LiveAudioEngine();
  registry.set(e, e);
  try {
    (globalThis as { __audio?: AudioDebug }).__audio = e.debug; // QA handle: the most recent engine
  } catch {
    /* frozen global: QA only */
  }
  return e;
}

/** Debug/QA access to an engine created by `createAudioEngine` (null for anything else). */
export function audioDebug(engine: AudioEngine): AudioDebug | null {
  return registry.get(engine)?.debug ?? null;
}
