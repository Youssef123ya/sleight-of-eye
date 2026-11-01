// Sleight of Eye audio engine (owned by A): every sound is synthesized at runtime with WebAudio.
//
// `createAudioEngine()` implements the AudioEngine contract. It is inert until `unlock()` (call it from the
// Enter gesture): unlock resumes the ONE AudioContext (three's shared context, which IWSDK's AudioSystem also
// uses, so the page never runs two audio threads) and builds the graph. Before that every method is a safe
// no-op; state set early (music on/mood, tension, volume, pause) is remembered and applied on unlock.
//
// `EngineImpl` holds all of the actual sound logic and runs on any BaseAudioContext, so the offline verifier
// (src/audio/offline.ts) renders exactly the code the game plays.
import { AudioContext as ThreeAudioContext, Quaternion, Vector3, type Object3D } from '@iwsdk/core';
import type { AudioEngine, CrowdKind, Mood, SfxName, SpectatorKind } from '../contracts.js';
import { AudioCore, MIX, warnOnce, type Ev, type P3 } from './core.js';
import { CROWD_PRIORITY, crowdSound } from './crowd.js';
import { clamp, hold } from './dsp.js';
import { Music, MusicBoxTrack, type MusicMood } from './music.js';
import { TensionPad } from './pad.js';
import { SFX } from './sfx.js';
import { speak } from './voice.js';

/** Lookahead scheduler: a 25 ms timer schedules everything within the next 100 ms of audio time. */
export const TICK_MS = 25;
export const LOOKAHEAD = 0.1;

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
      volume: clamp(Number.isFinite(opts?.volume) ? (opts?.volume as number) : 1, 0, 2) * spec.trim,
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
    g.gain.setValueAtTime(0, ev.t);
    g.gain.linearRampToValueAtTime(level, ev.t + 0.03);
    const src = ev.buffer(name === 'fuse' ? ev.res.fuse : ev.res.tick, ev.t, ev.t + 36000, g, true);
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
    const secs = clamp(Number.isFinite(seconds) ? seconds : 30, 0.5, 30);
    const ev = this.core.begin({ bus: 'sfx', at, priority: 3, send: 0.3 });
    if (!ev) return;
    const track = new MusicBoxTrack(ev, secs);
    this.core.addTrack(track);
    this.core.duck(0.4, ev.t, ev.t + track.duration - 1.6); // the trio listens to the music box
    track.pump(this.ctx.currentTime + LOOKAHEAD);
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
  ): void {
    this.core.setListenerPose(px, py, pz, fx, fy, fz, ux, uy, uz, immediate);
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

const _pos = new Vector3();
const _quat = new Quaternion();
const _fwd = new Vector3();
const _up = new Vector3();

export interface AudioMeter {
  peak: number;
  rms: number;
}

/** Debug/QA view of a live engine (demo meters, tests). Not part of the game contract. */
export interface AudioDebug {
  /** 'locked' before unlock, else the AudioContext state. */
  readonly state: string;
  readonly voices: number;
  readonly panners: number;
  readonly stats: { stolen: number; refused: number; peakVoices: number; fallbackPans: number } | null;
  /** Master output level over the last ~20 ms (allocation-free; writes into `out`). */
  meter(out: AudioMeter): AudioMeter;
  impl(): EngineImpl | null;
  context(): AudioContext | null;
  dispose(): void;
}

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
          this.impl?.music.stop(fadeSeconds ?? 1.5);
        }),
      setMood: (mood) =>
        this.guard('music.setMood', () => {
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

  /** True when one-shots should sound (unlocked, running, not paused): queued sounds never burst on resume. */
  private live(): EngineImpl | null {
    const impl = this.impl;
    if (!impl || this.paused || !this.ctx || this.ctx.state !== 'running') return null;
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
        if (this.paused) this.applyPause(true);
        setTimeout(() => this.guard('warm-up', () => impl.warm()), 0); // ~10 ms of buffer synthesis, off the gesture
      }
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

  sfx(name: SfxName, opts?: { at?: Vector3; volume?: number; pitch?: number }): void {
    const impl = this.live();
    if (impl) this.guard(`sfx ${name}`, () => impl.sfx(name, opts));
  }

  loop(name: 'fuse' | 'tick', at?: Vector3): { stop(): void } {
    const impl = this.live();
    if (!impl) return NOOP_LOOP;
    try {
      return impl.loop(name, at);
    } catch (e) {
      warnOnce(`loop ${name} failed`, e);
      return NOOP_LOOP;
    }
  }

  say(text: string, opts: { at: Vector3; voice: SpectatorKind; mood?: Mood }): void {
    const impl = this.live();
    if (impl && opts) this.guard('say', () => impl.say(text, opts.at, opts.voice, opts.mood));
  }

  crowd(kind: CrowdKind, intensity: number, at?: Vector3): void {
    const impl = this.live();
    if (impl) this.guard(`crowd ${kind}`, () => impl.crowd(kind, intensity, at));
  }

  musicBox(at: Vector3, seconds: number): void {
    const impl = this.live();
    if (impl) this.guard('musicBox', () => impl.musicBox(at, seconds));
  }

  setTension(watchers: number, maxWatchers: number): void {
    this.watchers = watchers;
    this.maxWatchers = maxWatchers;
    const impl = this.impl;
    if (impl) this.guard('setTension', () => impl.setTension(watchers, maxWatchers));
  }

  /** Per frame: allocation-free (scratch vectors) and skips the AudioParam writes when the head is still. */
  setListener(head: Object3D): void {
    const impl = this.impl;
    if (!impl || !head) return;
    try {
      head.getWorldPosition(_pos);
      head.getWorldQuaternion(_quat);
      _fwd.set(0, 0, -1).applyQuaternion(_quat);
      _up.set(0, 1, 0).applyQuaternion(_quat);
      impl.setListenerPose(_pos.x, _pos.y, _pos.z, _fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
    } catch (e) {
      warnOnce('setListener failed', e);
    }
  }

  setPaused(paused: boolean): void {
    this.paused = !!paused;
    this.guard('setPaused', () => this.applyPause(this.paused));
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
        if (this.paused && ctx.state === 'running') ctx.suspend().catch(() => undefined);
      }, 320);
    } else {
      impl.setPauseGain(1, 0.3);
      if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
    }
  }

  setMasterVolume(v: number): void {
    this.volume = Number.isFinite(v) ? v : 1;
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
    try {
      this.analyser?.disconnect();
    } catch {
      /* gone */
    }
    this.analyser = null;
    this.impl?.dispose();
    this.impl = null;
  }
}

const registry = new WeakMap<AudioEngine, LiveAudioEngine>();

/** The game's audio engine (contract: AudioEngine). Call `unlock()` from the Enter gesture. */
export function createAudioEngine(): AudioEngine {
  const e = new LiveAudioEngine();
  registry.set(e, e);
  return e;
}

/** Debug/QA access to an engine created by `createAudioEngine` (null for anything else). */
export function audioDebug(engine: AudioEngine): AudioDebug | null {
  return registry.get(engine)?.debug ?? null;
}
