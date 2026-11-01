// Generative café jazz trio + the music box melody (owned by A).
//
// Trio = brushes (persistent pink-noise swish + a white-noise tap pop-train: zero nodes created per beat),
// upright bass (walking quarters / two-feel, a harmonic-rich pluck through a closing low-pass) and soft piano
// (rootless voicings with voice-leading, swung comping, a per-chord low-pass that darkens as notes ring).
// Scheduled on the audio clock by the engine's lookahead pump (25 ms timer, 100 ms horizon); everything
// within one beat is scheduled when that beat comes into the horizon. Moods change at the next bar line:
//   calm    — F major ii–V–I loops, 92 BPM, walking bass, gentle brushes (default)
//   tense   — D minor, 86 BPM, two-feel bass, sparse low piano, swishes only, darker
//   triumph — a resolving ii–V–I cadence (rolled F6/9) and then a brighter, fuller F major loop at 98 BPM
import type { AudioCore, Ev, Track } from './core.js';
import { LEAD, NodeBag, warnOnce } from './core.js';
import { clamp, envAD, envNote, hold, midiHz, MIN_RAMP, pick, PopWriter, semis, type Rng } from './dsp.js';

export type MusicMood = 'calm' | 'tense' | 'triumph';

// ----------------------------------------------------------------------------------------------- harmony

type Quality = 'maj9' | '69' | 'm9' | 'm7' | 'm6' | '13' | '7b9' | 'm7b5';
interface Seg {
  root: number;
  q: Quality;
  beats: number;
}
type Bar = readonly Seg[];

const PC = { C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, G: 7, A: 9, Bb: 10, B: 11 } as const;
const sg = (root: number, q: Quality, beats = 4): Seg => ({ root, q, beats });

/** Rootless piano voicings (intervals above the root, in stacking order). */
const VOICE: Record<Quality, readonly number[]> = {
  maj9: [4, 7, 11, 14],
  '69': [4, 9, 14, 19],
  m9: [3, 7, 10, 14],
  m7: [3, 7, 10, 12],
  m6: [3, 7, 9, 14],
  '13': [10, 14, 16, 21],
  '7b9': [10, 13, 16, 19],
  m7b5: [3, 6, 10, 12],
};
/** Chord tones for the bass: root, 3rd, 5th, 7th/6th. */
const TONES: Record<Quality, readonly number[]> = {
  maj9: [0, 4, 7, 11],
  '69': [0, 4, 7, 9],
  m9: [0, 3, 7, 10],
  m7: [0, 3, 7, 10],
  m6: [0, 3, 7, 9],
  '13': [0, 4, 7, 10],
  '7b9': [0, 4, 7, 10],
  m7b5: [0, 3, 6, 10],
};

const CALM_A: Bar[] = [
  [sg(PC.F, 'maj9')], [sg(PC.D, 'm9')], [sg(PC.G, 'm9')], [sg(PC.C, '13')],
  [sg(PC.A, 'm7', 2), sg(PC.D, '7b9', 2)], [sg(PC.G, 'm9', 2), sg(PC.C, '13', 2)], [sg(PC.F, 'maj9')], [sg(PC.G, 'm9', 2), sg(PC.C, '7b9', 2)],
];
const CALM_B: Bar[] = [
  [sg(PC.F, 'maj9')], [sg(PC.Bb, '13')], [sg(PC.A, 'm7', 2), sg(PC.D, '7b9', 2)], [sg(PC.G, 'm9')],
  [sg(PC.C, '13')], [sg(PC.A, 'm7', 2), sg(PC.D, '7b9', 2)], [sg(PC.G, 'm9', 2), sg(PC.C, '13', 2)], [sg(PC.F, '69', 2), sg(PC.C, '7b9', 2)],
];
const TENSE_A: Bar[] = [
  [sg(PC.D, 'm6')], [sg(PC.Bb, 'maj9')], [sg(PC.E, 'm7b5')], [sg(PC.A, '7b9')],
  [sg(PC.D, 'm6')], [sg(PC.G, 'm9')], [sg(PC.E, 'm7b5', 2), sg(PC.A, '7b9', 2)], [sg(PC.D, 'm6', 2), sg(PC.A, '7b9', 2)],
];
const TRIUMPH_A: Bar[] = [
  [sg(PC.F, 'maj9')], [sg(PC.Bb, '13')], [sg(PC.A, 'm7', 2), sg(PC.D, '7b9', 2)], [sg(PC.G, 'm9', 2), sg(PC.C, '13', 2)],
  [sg(PC.F, 'maj9')], [sg(PC.D, 'm9')], [sg(PC.G, 'm9', 2), sg(PC.C, '13', 2)], [sg(PC.F, '69')],
];
/** Played once when the mood turns to triumph: ii–V → a rolled tonic 6/9. */
const CADENCE: Bar[] = [[sg(PC.G, 'm9', 2), sg(PC.C, '7b9', 2)], [sg(PC.F, '69')]];

const F_MAJOR = [5, 7, 9, 10, 0, 2, 4];
const D_MINOR = [2, 4, 5, 7, 9, 10, 1];

/** Comping patterns: [beat, length (beats), velocity]; x.5 = the swung "and". */
type Pat = ReadonlyArray<readonly [number, number, number]>;
const COMP4: Record<MusicMood, Pat[]> = {
  calm: [
    [[0, 1.5, 0.9]],
    [[0, 0.6, 0.85], [1.5, 1.6, 0.95]],
    [[1, 1.2, 0.8], [2.5, 1.2, 0.9]],
    [[0, 3.2, 0.8]],
    [[0.5, 1.2, 0.85], [2.5, 1.1, 0.8]],
  ],
  tense: [[[0, 3.4, 0.75]], [[1.5, 2.2, 0.7]], [], [[0, 1.2, 0.7], [2, 1.8, 0.65]]],
  triumph: [
    [[0, 0.6, 1], [1.5, 0.6, 0.95], [2.5, 1.2, 1]],
    [[0, 1.2, 1], [2, 1.2, 0.95]],
    [[0, 0.5, 0.95], [1.5, 1.4, 1], [3.5, 0.4, 0.85]],
  ],
};
const COMP2: Record<MusicMood, Pat[]> = {
  calm: [[[0, 1.3, 0.9]], [[0.5, 1.2, 0.85]], [[0, 0.6, 0.8], [1.5, 0.45, 0.75]]],
  tense: [[[0, 1.7, 0.7]], []],
  triumph: [[[0, 0.6, 1], [1, 0.9, 0.95]], [[0, 1.4, 1]], [[0.5, 1.2, 1]]],
};

interface MoodCfg {
  bpm: number;
  swing: number;
  progs: Bar[][];
  bass: 'walk' | 'two';
  bassVel: number;
  center: number;
  bright: number;
  pianoVel: number;
  brush: number;
  taps: number;
  fills: number;
  push: number;
  scale: readonly number[];
  /** Tension-pad root pitch class (the key's dominant). */
  padRoot: number;
}
const MOODS: Record<MusicMood, MoodCfg> = {
  calm: { bpm: 92, swing: 0.64, progs: [CALM_A, CALM_B], bass: 'walk', bassVel: 1, center: 60, bright: 1, pianoVel: 0.9, brush: 1, taps: 1, fills: 0, push: 0.25, scale: F_MAJOR, padRoot: PC.C },
  tense: { bpm: 86, swing: 0.62, progs: [TENSE_A], bass: 'two', bassVel: 0.85, center: 55, bright: 0.55, pianoVel: 0.75, brush: 0.6, taps: 0, fills: 0, push: 0.1, scale: D_MINOR, padRoot: PC.A },
  triumph: { bpm: 98, swing: 0.66, progs: [TRIUMPH_A], bass: 'walk', bassVel: 1, center: 63, bright: 1.45, pianoVel: 1, brush: 1.1, taps: 1.05, fills: 0.55, push: 0.35, scale: F_MAJOR, padRoot: PC.C },
};

// Instrument levels (pre music bus), balanced with stem renders: piano and bass about level (the bass a
// touch under, since headset speakers lose its fundamental anyway), brushes ~6 dB under the piano.
const PIANO = 0.14;
const BASS = 0.29;
const BRUSH = 0.6;
const TAP = 0.9;
const BASS_LO = 36;
const BASS_HI = 55;

const pcOf = (m: number): number => ((m % 12) + 12) % 12;

/** MIDI note with pitch class `pc` nearest to `ref` inside [lo, hi]. */
function near(pc: number, ref: number, lo = BASS_LO, hi = BASS_HI): number {
  let best = -1;
  let bd = Infinity;
  for (let m = lo; m <= hi; m++) {
    if (pcOf(m) !== pcOf(pc)) continue;
    const d = Math.abs(m - ref);
    if (d < bd) {
      bd = d;
      best = m;
    }
  }
  return best < 0 ? lo + pcOf(pc) : best;
}

function inRange(m: number, lo = BASS_LO, hi = BASS_HI): number {
  while (m < lo) m += 12;
  while (m > hi) m -= 12;
  return m;
}

function scaleStep(n: number, dir: number, scale: readonly number[]): number {
  let m = n;
  for (let i = 0; i < 3; i++) {
    m += dir;
    if (scale.includes(pcOf(m))) break;
  }
  return inRange(m);
}

/** Last note of a walking segment: lead into `target` chromatically, by step, or from its fifth. */
function approach(target: number, prev: number, r: Rng): number {
  const from = prev > target ? 1 : -1;
  const x = r();
  let n = x < 0.5 ? target + from : x < 0.75 ? target + 2 * from : target + (from > 0 ? 7 : -5);
  if (n === prev) n = target - from;
  return inRange(n);
}

/** Close-position voicing of a chord, picked for smooth voice-leading from `prev`. */
function voiceChord(seg: Seg, center: number, prev: number[] | null, r: Rng): number[] {
  const iv = VOICE[seg.q];
  const pcs = iv.map((x) => (seg.root + x) % 12);
  let best: number[] = [];
  let bestScore = Infinity;
  for (let rot = 0; rot < pcs.length; rot++) {
    for (let b = 0; b < 2; b++) {
      const base = center - (b === 0 ? 7 : 2);
      const notes: number[] = [];
      let n = base + pcOf(pcs[rot] - base);
      notes.push(n);
      for (let k = 1; k < pcs.length; k++) {
        n = n + 1 + pcOf(pcs[(rot + k) % pcs.length] - (n + 1));
        notes.push(n);
      }
      let mean = 0;
      for (const x of notes) mean += x / notes.length;
      let score = Math.abs(mean - center) * 0.6;
      if (prev && prev.length === notes.length) {
        let mv = 0;
        for (let k = 0; k < notes.length; k++) mv += Math.abs(notes[k] - prev[k]);
        score += mv * 0.5;
      }
      if (notes[notes.length - 1] > center + 13) score += 6;
      if (notes[0] < center - 10) score += 6;
      if (notes[0] < 52 && notes[1] - notes[0] < 4) score += 4; // no low mud
      score += r() * 0.8;
      if (score < bestScore) {
        bestScore = score;
        best = notes;
      }
    }
  }
  return best;
}

const swingPos = (x: number, swing: number): number => Math.floor(x) + (x % 1 > 0.25 ? swing : 0);

interface Hit {
  at: number;
  len: number;
  vel: number;
  notes: number[];
  roll: number;
}
interface BassNote {
  at: number;
  midi: number;
  len: number;
  vel: number;
}

// ------------------------------------------------------------------------------------------- session

/** One continuous performance (its own persistent nodes); stop() fades it out and it cleans itself up. */
class MusicSession {
  playing = true;
  private readonly bag = new NodeBag();
  readonly out: GainNode;
  private readonly pianoSend: GainNode;
  private readonly brushSend: GainNode;
  private readonly swish: GainNode;
  private readonly swishBp: BiquadFilterNode;
  private readonly taps: PopWriter;
  private mood: MusicMood;
  private cfg: MoodCfg;
  private beatDur: number;
  private beatT: number;
  private beatInBar = 0;
  private bars: Bar[];
  private barIdx = 0;
  private after: Bar[] | null = null;
  private cadence = false;
  private bar: Bar = [];
  private readonly hits: Hit[] = [];
  private readonly bass: BassNote[] = [];
  private voicing: number[] | null = null;
  private lastBass = 41;
  private pushed = false;

  constructor(
    private readonly core: AudioCore,
    mood: MusicMood,
    private readonly wantMood: () => MusicMood,
    private readonly stems: MusicStems,
  ) {
    const ctx = core.ctx;
    const now = ctx.currentTime;
    const t0 = now + 0.12;
    this.bag.open(1);
    const g = (v: number): GainNode => {
      const n = this.bag.add(ctx.createGain());
      n.gain.value = v;
      return n;
    };
    this.out = g(0);
    this.out.connect(core.bus.music);
    this.out.gain.setValueAtTime(0, now);
    this.out.gain.setTargetAtTime(1, now, 0.6);
    this.pianoSend = g(0.24);
    this.pianoSend.connect(core.reverbIn);
    const brushSend = (this.brushSend = g(0.2));
    brushSend.connect(core.reverbIn);

    // brushes: a circular sweep (pink noise, band-pass) whose level swells into every beat ...
    this.swish = g(0);
    this.swish.connect(this.out);
    this.swish.connect(brushSend);
    this.swishBp = this.bag.add(ctx.createBiquadFilter());
    this.swishBp.type = 'bandpass';
    this.swishBp.frequency.value = 2400;
    this.swishBp.Q.value = 0.7;
    const swishHp = this.bag.add(ctx.createBiquadFilter());
    swishHp.type = 'highpass';
    swishHp.frequency.value = 550;
    this.swishBp.connect(swishHp).connect(this.swish);
    const pink = ctx.createBufferSource();
    pink.buffer = core.res.pink;
    pink.loop = true;
    pink.connect(this.swishBp);
    this.bag.play(pink, t0 - 0.1, t0 + 36000);
    // ... and soft right-hand taps on the snare (one pop-train on one gain)
    const tapGain = g(0);
    tapGain.connect(this.out);
    tapGain.connect(brushSend);
    const tapBp = this.bag.add(ctx.createBiquadFilter());
    tapBp.type = 'bandpass';
    tapBp.frequency.value = 3800;
    tapBp.Q.value = 0.9;
    tapBp.connect(tapGain);
    const white = ctx.createBufferSource();
    white.buffer = core.res.white;
    white.loop = true;
    white.connect(tapBp);
    this.bag.play(white, t0 - 0.1, t0 + 36000);
    this.taps = new PopWriter(tapGain.gain, MIN_RAMP, 0.03);

    this.mood = mood;
    this.cfg = MOODS[mood];
    this.beatDur = 60 / this.cfg.bpm;
    this.beatT = t0;
    this.bars = pick(core.rng, this.cfg.progs);
  }

  stop(fade: number): void {
    if (!this.playing) return;
    this.playing = false;
    const now = this.core.ctx.currentTime;
    const f = Math.max(0.05, fade);
    // the dry output and both reverb sends fade together (notes already scheduled must not leak into the room)
    const tau = f / 6;
    const e1 = now + f - 0.02;
    for (const p of [this.out.gain, this.pianoSend.gain, this.brushSend.gain]) {
      const v0 = p.value;
      hold(p, now);
      p.setTargetAtTime(0, now, tau);
      p.setValueAtTime(v0 * Math.exp(-(e1 - now) / tau), e1); // continue the curve, then glide to a true zero
      p.linearRampToValueAtTime(0, now + f);
    }
    this.taps.close();
    const stopAt = now + f + 0.05;
    for (let i = 0; i < this.bag.sources.length; i++) {
      try {
        this.bag.sources[i].stop(stopAt);
      } catch {
        /* already stopped */
      }
    }
  }

  /** Schedule every beat that starts before `until`. */
  pump(until: number): void {
    if (!this.playing) return;
    const now = this.core.ctx.currentTime;
    // Main thread stalled past the next beat (or the tab slept): slide the grid. Scheduling into the past would
    // start notes mid-envelope (the attack collapses into a click) and burst the whole backlog at once.
    if (this.beatT < now + LEAD * 0.5) this.beatT = now + LEAD;
    let guard = 0;
    while (this.beatT < until && guard++ < 8) {
      this.beat(this.beatT);
      this.beatT += this.beatDur;
    }
  }

  // ---------------------------------------------------------------------------------------- planning

  private switchMood(m: MusicMood): void {
    this.mood = m;
    this.cfg = MOODS[m];
    this.beatDur = 60 / this.cfg.bpm;
    this.barIdx = 0;
    this.pushed = false;
    if (m === 'triumph') {
      this.bars = CADENCE;
      this.after = pick(this.core.rng, this.cfg.progs);
      this.cadence = true;
    } else {
      this.bars = pick(this.core.rng, this.cfg.progs);
      this.after = null;
      this.cadence = false;
    }
  }

  private peekBar(): Bar {
    const want = this.wantMood();
    if (want !== this.mood) return want === 'triumph' ? CADENCE[0] : MOODS[want].progs[0][0];
    if (this.barIdx < this.bars.length) return this.bars[this.barIdx];
    return (this.after ?? this.cfg.progs[0])[0];
  }

  private startBar(): void {
    const want = this.wantMood();
    if (want !== this.mood) this.switchMood(want);
    if (this.barIdx >= this.bars.length) {
      if (this.after) {
        this.bars = this.after;
        this.after = null;
        this.cadence = false;
      } else {
        this.bars = pick(this.core.rng, this.cfg.progs);
      }
      this.barIdx = 0;
    }
    const isFinalCadenceBar = this.cadence && this.barIdx === this.bars.length - 1;
    this.bar = this.bars[this.barIdx++];
    this.plan(isFinalCadenceBar);
  }

  private plan(finalCadence: boolean): void {
    const r = this.core.rng;
    const cfg = this.cfg;
    this.hits.length = 0;
    this.bass.length = 0;
    const next = this.peekBar();
    let sb = 0;
    for (let si = 0; si < this.bar.length; si++) {
      const seg = this.bar[si];
      const nextRoot = si + 1 < this.bar.length ? this.bar[si + 1].root : next[0].root;
      const notes = voiceChord(seg, cfg.center, this.voicing, r);
      this.voicing = notes;
      if (this.cadence) {
        if (finalCadence) {
          // rolled tonic 6/9 with the root underneath and a high F on top
          const top = notes[notes.length - 1];
          const roll = [near(seg.root, notes[0] - 7, 41, 53), ...notes, top + 1 + pcOf(seg.root - (top + 1))];
          this.hits.push({ at: sb, len: 3.7, vel: 1.05, notes: roll, roll: 0.045 });
        } else {
          this.hits.push({ at: sb, len: seg.beats * 0.85, vel: 1, notes, roll: 0 });
        }
      } else {
        const pat = pick(r, (seg.beats >= 4 ? COMP4 : COMP2)[this.mood]);
        for (const [at, len, vel] of pat) {
          if (this.pushed && sb === 0 && at === 0) continue; // anticipated on the previous "and" of 4
          this.hits.push({ at: sb + swingPos(at, cfg.swing), len, vel, notes, roll: 0 });
        }
      }
      this.planBass(seg, sb, nextRoot, finalCadence);
      sb += seg.beats;
    }
    this.pushed = false;
    let lateHit = false;
    for (const h of this.hits) if (h.at >= 3.3) lateHit = true;
    if (!this.cadence && !lateHit && r() < cfg.push && this.wantMood() === this.mood) {
      const nv = voiceChord(next[0], cfg.center, this.voicing, r);
      this.hits.push({ at: 3 + cfg.swing, len: 1.3, vel: 0.9, notes: nv, roll: 0 });
      this.voicing = nv;
      this.pushed = true;
    }
    if (cfg.fills > 0 && !this.cadence && this.bar.length === 1 && r() < cfg.fills && this.voicing) {
      // right-hand flourish up the chord tones on the swung eighths of beats 2–4
      const seg = this.bar[0];
      const tones = TONES[seg.q].map((x) => (seg.root + x) % 12);
      let n = this.voicing[this.voicing.length - 1];
      const at = [1.5, 2, 2.5, 3];
      for (let k = 0; k < at.length; k++) {
        do n++;
        while (!tones.includes(pcOf(n)));
        this.hits.push({ at: swingPos(at[k], cfg.swing), len: 0.4, vel: 0.7 + k * 0.06, notes: [n], roll: 0 });
      }
    }
  }

  private planBass(seg: Seg, sb: number, nextRoot: number, finalCadence: boolean): void {
    const r = this.core.rng;
    const cfg = this.cfg;
    const vel = cfg.bassVel;
    const add = (at: number, midi: number, len: number, v: number): void => {
      this.bass.push({ at, midi, len, vel: v });
      this.lastBass = midi;
    };
    const root = near(seg.root, this.lastBass);
    if (finalCadence) {
      add(sb, near(seg.root, this.lastBass - 6), 3.6, vel * 1.1);
      return;
    }
    const target = near(nextRoot, root);
    if (cfg.bass === 'two') {
      add(sb, root, Math.min(2, seg.beats) * 0.95, vel);
      if (seg.beats >= 4) {
        const n2 = r() < 0.5 ? near(seg.root + 7, root) : approach(target, root, r);
        add(sb + 2, n2, 1.9, vel * 0.9);
      }
      return;
    }
    add(sb, root, 0.92, vel * 1.05);
    if (seg.beats >= 4) {
      const dir = target > root ? 1 : target < root ? -1 : r() < 0.5 ? 1 : -1;
      const tones = TONES[seg.q];
      const style = r();
      let n1: number;
      let n2: number;
      if (style < 0.4) {
        n1 = inRange(root + (dir > 0 ? tones[1] : tones[2] - 12));
        n2 = inRange(root + (dir > 0 ? tones[2] : tones[1] - 12));
      } else if (style < 0.75) {
        n1 = scaleStep(root, dir, cfg.scale);
        n2 = scaleStep(n1, dir, cfg.scale);
      } else {
        n1 = near(seg.root + 7, root);
        n2 = r() < 0.5 ? inRange(root + (root + 12 <= BASS_HI ? 12 : -12)) : near(seg.root + tones[1], n1);
      }
      add(sb + 1, n1, 0.9, vel * 0.9);
      add(sb + 2, n2, 0.9, vel * 0.95);
      add(sb + 3, approach(target, n2, r), 0.9, vel * 0.88);
    } else if (seg.beats >= 2) {
      add(sb + 1, approach(target, root, r), 0.9, vel * 0.9);
    }
  }

  // --------------------------------------------------------------------------------------- playing

  private beat(t: number): void {
    if (this.beatInBar === 0) this.startBar();
    const b = this.beatInBar;
    const bd = this.beatDur;
    const st = this.stems;
    if (st.bass) for (const n of this.bass) if (n.at >= b && n.at < b + 1) this.bassNote(t + (n.at - b) * bd, n.midi, n.len * bd, n.vel);
    if (st.piano) for (const h of this.hits) if (h.at >= b && h.at < b + 1) this.chord(t + (h.at - b) * bd, h);
    if (st.brushes) this.brushes(t, b);
    this.beatInBar = (b + 1) % 4;
  }

  private bassNote(t: number, midi: number, dur: number, vel: number): void {
    const ev = this.core.loose(this.out, t);
    const f = midiHz(midi);
    const g = ev.gain(0, this.out);
    const lp = ev.filter('lowpass', 1100 * clamp(this.cfg.bright, 0.7, 1.3), 0.8, g);
    lp.frequency.setValueAtTime(1100 * clamp(this.cfg.bright, 0.7, 1.3), t);
    lp.frequency.setTargetAtTime(420, t + 0.01, 0.12);
    const end = envNote(g.gain, t, BASS * vel, 0.007, 0.2, 0.55, t + dur, 0.05);
    const o = ev.osc(ev.res.bass, f * semis(0.25), t, end + 0.01, lp);
    o.frequency.setValueAtTime(f * semis(0.25), t); // the string settles from a hair sharp
    o.frequency.exponentialRampToValueAtTime(f, t + 0.045);
  }

  private chord(t: number, h: Hit): void {
    const ev = this.core.loose(this.out, t);
    const c = this.cfg;
    const lp = ev.filter('lowpass', 2600, 0.4, this.out);
    lp.connect(this.pianoSend);
    const b0 = 2600 * c.bright * (0.85 + 0.3 * h.vel);
    lp.frequency.setValueAtTime(b0, t);
    lp.frequency.setTargetAtTime(800 * c.bright, t + 0.02, 0.5);
    const dur = h.len * this.beatDur;
    const scale = h.notes.length > 4 ? Math.sqrt(4 / h.notes.length) : 1;
    for (let i = 0; i < h.notes.length; i++) {
      const tn = t + i * h.roll;
      const top = i === h.notes.length - 1;
      const amp = PIANO * c.pianoVel * h.vel * scale * (top ? 1.2 : 1) * (0.92 + 0.16 * ev.rng());
      const g = ev.gain(0, lp);
      const end = envNote(g.gain, tn, amp, 0.006, 0.28, 0.32, t + Math.max(dur, i * h.roll + 0.1), 0.11);
      const o = ev.osc(ev.res.piano, midiHz(h.notes[i]), tn, end + 0.01, g);
      o.detune.value = (ev.rng() - 0.5) * 6;
    }
  }

  private brushes(t: number, b: number): void {
    const c = this.cfg;
    const bd = this.beatDur;
    if (this.mood !== 'tense' || b % 2 === 0) {
      const lvl = BRUSH * c.brush * (b % 2 === 1 ? 1 : 0.8);
      const swell = Math.max(this.core.ctx.currentTime, t - 0.08 * bd);
      this.swish.gain.setTargetAtTime(lvl, swell, 0.05);
      this.swish.gain.setTargetAtTime(lvl * 0.3, t + 0.2 * bd, this.mood === 'tense' ? 0.2 : 0.11);
      this.swishBp.frequency.setTargetAtTime(3400 * Math.sqrt(c.bright), swell, 0.06);
      this.swishBp.frequency.setTargetAtTime(2300 * Math.sqrt(c.bright), t + 0.2 * bd, 0.12);
    }
    if (c.taps > 0) {
      const a = TAP * c.taps;
      this.taps.pop(t, a * (b % 2 === 1 ? 0.55 : 0.3));
      if (b % 2 === 1) this.taps.pop(t + c.swing * bd, a * 0.22);
    }
  }
}

// --------------------------------------------------------------------------------------------- facade

/** Per-instrument mutes (QA: the offline report renders stems to balance the trio). */
export interface MusicStems {
  piano: boolean;
  bass: boolean;
  brushes: boolean;
}

export class Music {
  private session: MusicSession | null = null;
  private mood: MusicMood = 'calm';
  readonly stems: MusicStems = { piano: true, bass: true, brushes: true };

  constructor(private readonly core: AudioCore) {}

  static padRoot(m: MusicMood): number {
    return MOODS[m].padRoot;
  }

  get playing(): boolean {
    return !!this.session?.playing;
  }

  get currentMood(): MusicMood {
    return this.mood;
  }

  start(): void {
    if (this.session?.playing) return;
    // a previous session that is still fading out keeps fading on its own: this is a clean cross-fade
    this.session = new MusicSession(this.core, this.mood, () => this.mood, this.stems);
  }

  stop(fade = 1.5): void {
    const s = this.session;
    if (!s) return;
    s.stop(Number.isFinite(fade) ? fade : 1.5);
    this.session = null;
  }

  setMood(m: MusicMood): void {
    if (m === 'calm' || m === 'tense' || m === 'triumph') this.mood = m;
  }

  pump(until: number): void {
    try {
      this.session?.pump(until);
    } catch (e) {
      warnOnce('music pump failed', e);
    }
  }
}

// ------------------------------------------------------------------------------------------ music box

type MbNote = readonly [beat: number, midi: number];
/** An original waltz (3/4) in F. Phrase A ends on the tonic, so a 5 s show resolves. */
const MB_A: MbNote[] = [[0, 84], [1, 81], [1.5, 84], [2, 89], [3, 88], [4.5, 86], [5, 84], [6, 86], [7, 82], [7.5, 79], [8, 88], [9, 89]];
const MB_B: MbNote[] = [[0, 81], [0.5, 84], [1, 89], [2, 93], [3, 91], [4, 89], [4.5, 88], [5, 86], [6, 88], [7, 91], [7.5, 88], [8, 84], [9, 89]];
/** Oom-pah-pah per beat of each 3-beat bar: [bass, dyad, dyad] chords. */
const CH = {
  F: [[65], [69, 72], [69, 72]],
  C7: [[60], [70, 76], [70, 76]],
  GmC7: [[67], [70, 74], [70, 76]],
  Dm: [[62], [65, 69], [65, 69]],
} as const;
const MB_A_BARS = [CH.F, CH.C7, CH.GmC7, CH.F];
const MB_B_BARS = [CH.F, CH.Dm, CH.C7, CH.F];
const MB_BEAT = 0.4; // 150 BPM

const MB_PHRASE = 12; // beats: 4 bars of 3/4
/** How long a tine rings (its envelope lands on exactly 0): melody / accompaniment. */
const MB_RING = 2.4;
const MB_RING_ACC = 1.7;
/** The café trio steps back while the box plays. */
const MB_DUCK = 0.4;
/** stop(): the lid closes — the box's own output is damped to exactly 0 over this long. */
export const MB_STOP_FADE = 0.12;
/** Never faster than this: a shorter fade of a ringing tine can click. */
export const MB_STOP_MIN = 0.03;

interface MbEvent {
  /** Beat from the start of the show (multiples of 0.5). */
  beat: number;
  midi: number;
  amp: number;
  melody: boolean;
}

/**
 * Plays the music box progressively from the scheduler, one phrase at a time (A, B, A, … — every phrase resolves
 * on the tonic). A finite show ends with whole phrases and a ritardando like a spring running down; `seconds =
 * Infinity` plays until `stop()`. Every tine is its own little node bag that tears itself down when it has rung out
 * (an endless box holds ~15 of them at a time, never a growing pile), and holds the voice slot open meanwhile.
 * `stop()` (idempotent) fades the box's output to exactly 0 over >= 30 ms, then stops whatever still rings or is
 * already scheduled inside the lookahead window, so the voice, its panner and the music duck are released at once.
 */
export class MusicBoxTrack implements Track {
  /** Seconds from the first tine until the last one has rung out (Infinity: endless, until stop()). */
  readonly duration: number;
  readonly endless: boolean;
  /** Called once when the box stops scheduling notes (natural end, stop(), stolen voice, error). */
  onEnd: (() => void) | null = null;
  private readonly t0: number;
  private readonly phrases: number;
  private readonly totalBeats: number;
  /** Finite shows: half-beat index → seconds after t0, with the closing ritardando. Null when endless. */
  private readonly warp: Float64Array | null;
  /** The box's own output (into the voice): stop() fades this, never the pooled slot's gain. */
  private readonly bus: GainNode;
  private readonly serial: number;
  /** Notes of the phrase being played (objects reused phrase after phrase), first `count` valid. */
  private readonly events: MbEvent[] = [];
  private count = 0;
  private idx = 0;
  private phrase = 0;
  /** Tines still ringing (or scheduled inside the lookahead window). */
  private readonly live: NodeBag[] = [];
  /** Seconds the remaining timeline has slid after main-thread stalls. */
  private slip = 0;
  private lastT = 0;
  private released = false;
  private ducked = false;
  private stopped = false;
  private ended = false;

  constructor(
    private readonly ev: Ev,
    seconds: number,
  ) {
    this.serial = ev.bag.serial;
    this.t0 = ev.t;
    this.endless = !Number.isFinite(seconds);
    if (this.endless) {
      this.phrases = Infinity;
      this.totalBeats = Infinity;
      this.warp = null;
      this.duration = Infinity;
    } else {
      const phrases = Math.max(1, Math.round(seconds / (MB_PHRASE * MB_BEAT)));
      // whole phrases (they resolve on the tonic), but never longer than asked: a 2 s show plays 5 beats
      const totalBeats = Math.min(phrases * MB_PHRASE, Math.max(3, Math.round(seconds / MB_BEAT)));
      // time warp: the last ~5 beats stretch up to 1.6x (ritardando)
      const warp = new Float64Array(totalBeats * 2 + 1);
      for (let j = 1; j < warp.length; j++) {
        const mid = (j - 0.5) / 2;
        const x = clamp((mid - (totalBeats - 5.5)) / 4.5, 0, 1);
        warp[j] = warp[j - 1] + 0.5 * MB_BEAT * (1 + 0.6 * x * x);
      }
      this.phrases = phrases;
      this.totalBeats = totalBeats;
      this.warp = warp;
      // the last note of the show (a peek at the final phrase; the play-through regenerates it)
      this.fill(phrases - 1);
      let last = 0;
      for (let i = 0; i < this.count; i++) last = Math.max(last, this.events[i].beat);
      this.count = 0;
      this.duration = warp[Math.round(last * 2)] + MB_RING;
    }
    this.bus = ev.gain(1, ev.out);
    ev.bag.hold(); // keep the voice alive between notes (each ringing tine holds it too)
    ev.core.holdDuck(MB_DUCK, ev.t); // last: nothing after this can throw and leak the hold
    this.ducked = true;
  }

  /** Tines currently ringing (QA: an endless box must not pile them up). */
  get ringing(): number {
    return this.live.length;
  }

  /** Still scheduling notes (not stopped, not finished, voice not stolen). */
  get playing(): boolean {
    return !this.ended;
  }

  pump(until: number): boolean {
    if (this.stopped || this.ended) return true;
    const voice = this.ev.bag;
    const now = this.ev.ctx.currentTime;
    if (voice.done || voice.serial !== this.serial) {
      // the voice was stolen (its gain is already fading out over 15 ms) or the engine went away
      this.silence(now + 0.02);
      this.end(now);
      return true;
    }
    let e = this.peek();
    if (e) {
      const next = this.timeOf(e.beat) + this.slip;
      // main thread stalled: the box hesitates like a sticky comb instead of starting tines mid-envelope
      if (next < now + LEAD * 0.5) this.slip += now + LEAD - next;
    }
    // never more than 2 s ahead, whatever `until` says (a NaN or huge horizon must not flood the graph)
    const horizon = until < now + 2 ? until : now + 2;
    let guard = 0;
    while (e && guard++ < 128) {
      const t = this.timeOf(e.beat) + this.slip;
      if (!(t < horizon)) break;
      this.idx++;
      this.tine(e, t);
      this.lastT = t;
      e = this.peek();
    }
    if (!e) {
      this.end(this.lastT + 0.8); // every tine is scheduled: the trio comes back up as the last one rings out
      return true;
    }
    return false;
  }

  abort(): void {
    this.end(this.ev.ctx.currentTime); // the tines already scheduled ring out
  }

  /** Close the lid: fade to exactly 0 (>= 30 ms), stop everything that rings, release voice + duck. Idempotent. */
  stop(fade = MB_STOP_FADE): void {
    if (this.stopped) return;
    this.stopped = true;
    const core = this.ev.core;
    core.removeTrack(this);
    const voice = this.ev.bag;
    const now = this.ev.ctx.currentTime;
    if (!voice.done && voice.serial === this.serial) {
      const f = Math.max(MB_STOP_MIN, Number.isFinite(fade) ? fade : MB_STOP_FADE);
      // A damper, not a ramp: exponential decay (tau f/6), continued analytically, then a short linear glide to a true
      // zero at f. A linear fade still carries ~8% of the signal into its last 10 ms, and Chrome cuts the HRTF panner's
      // convolution tail ~10 ms after its input falls silent: measured offline, that cut was a -60..-80 dBFS step;
      // this shape leaves ~26 dB less signal in the tail.
      const p = this.bus.gain;
      const v0 = p.value;
      const tau = f / 6;
      const e1 = now + f - Math.min(0.012, f / 3);
      hold(p, now);
      p.setTargetAtTime(0, now, tau);
      p.setValueAtTime(v0 * Math.exp(-(e1 - now) / tau), e1);
      p.linearRampToValueAtTime(0, now + f);
      // sources end once the output is silent; tines due later inside the lookahead window never start
      this.silence(now + f + 0.005);
    }
    this.end(now);
  }

  // ----------------------------------------------------------------------------------------------- notes

  /** The next note to play, moving on to the next phrase when this one is spent; null when the show is over. */
  private peek(): MbEvent | null {
    while (this.idx >= this.count) {
      if (this.phrase >= this.phrases) return null;
      this.fill(this.phrase++);
    }
    return this.events[this.idx];
  }

  /** Load phrase `p` (beats 12p … 12p+11) into `events`, in time order. Allocation-free after the first phrases. */
  private fill(p: number): void {
    const final = p === this.phrases - 1; // never for an endless box
    const mel = p % 2 === 0 ? MB_A : MB_B;
    const bars = p % 2 === 0 ? MB_A_BARS : MB_B_BARS;
    const b0 = p * MB_PHRASE;
    let n = 0;
    for (let i = 0; i < mel.length; i++) n = this.put(n, b0 + mel[i][0], mel[i][1], 0.3, true);
    for (let bar = 0; bar < 4; bar++) {
      if (final && bar === 3) {
        // final bar: just the tonic underneath the last melody note
        n = this.put(n, b0 + 9, 65, 0.15, false);
        n = this.put(n, b0 + 9, 69, 0.09, false);
        continue;
      }
      const ch = bars[bar];
      for (let beat = 0; beat < 3; beat++) {
        const notes = ch[beat];
        for (let k = 0; k < notes.length; k++) n = this.put(n, b0 + bar * 3 + beat, notes[k], beat === 0 ? 0.15 : 0.08, false);
      }
    }
    // stable insertion sort by beat: a chord under a melody note keeps the melody first
    const ev = this.events;
    for (let i = 1; i < n; i++) {
      const x = ev[i];
      let j = i - 1;
      while (j >= 0 && ev[j].beat > x.beat) {
        ev[j + 1] = ev[j];
        j--;
      }
      ev[j + 1] = x;
    }
    this.count = n;
    this.idx = 0;
  }

  /** Append a note unless it falls past a shortened show; returns the new count. */
  private put(n: number, beat: number, midi: number, amp: number, melody: boolean): number {
    if (beat > this.totalBeats - 0.5) return n;
    let e = this.events[n];
    if (!e) {
      e = { beat: 0, midi: 0, amp: 0, melody: false };
      this.events[n] = e;
    }
    e.beat = beat;
    e.midi = midi;
    e.amp = amp;
    e.melody = melody;
    return n + 1;
  }

  private timeOf(beat: number): number {
    const w = this.warp;
    return this.t0 + (w ? w[Math.round(beat * 2)] : beat * MB_BEAT);
  }

  /** A comb tine: bright sine with a fast-decaying inharmonic overtone (the "tink" of the pin). */
  private tine(e: MbEvent, t: number): void {
    const voice = this.ev.bag;
    const f = this.ev.hz(midiHz(e.midi));
    const ev = this.ev.core.loose(this.bus, t); // its own bag: torn down as soon as this tine has rung out
    const bag = ev.bag;
    voice.hold();
    this.live.push(bag);
    bag.onFinish = () => this.tineDone(bag);
    try {
      const g = ev.gain(0, ev.out);
      const e1 = envAD(g.gain, t, e.amp, MIN_RAMP, e.melody ? 0.42 : 0.3, t + (e.melody ? MB_RING : MB_RING_ACC));
      ev.osc('sine', f, t, e1 + 0.01, g);
      if (e.melody) {
        const g2 = ev.gain(0, ev.out);
        const e2 = envAD(g2.gain, t, e.amp * 0.28, MIN_RAMP, 0.03, t + 0.25);
        ev.osc('sine', ev.safe(f * 6.27), t, e2 + 0.01, g2);
        const g3 = ev.gain(0, ev.out);
        const e3 = envAD(g3.gain, t, e.amp * 0.12, MIN_RAMP, 0.12, t + 0.9);
        ev.osc('sine', ev.safe(f * 2), t, e3 + 0.01, g3);
      }
    } catch (err) {
      bag.finish(); // gives the voice hold back
      throw err;
    }
  }

  private tineDone(bag: NodeBag): void {
    const i = this.live.indexOf(bag);
    if (i >= 0) {
      this.live[i] = this.live[this.live.length - 1];
      this.live.pop();
    }
    const voice = this.ev.bag;
    if (voice.serial === this.serial) voice.unhold(); // the voice ends with the last tine
  }

  /** Stop every tine that still rings (or has not started yet) at `at`. */
  private silence(at: number): void {
    for (let i = 0; i < this.live.length; i++) {
      const src = this.live[i].sources;
      for (let k = 0; k < src.length; k++) {
        try {
          src[k].stop(at);
        } catch {
          /* already stopped */
        }
      }
    }
  }

  /** Stop scheduling: give back the track's hold on the voice and the music duck (which lasts until `duckAt`). */
  private end(duckAt: number): void {
    if (!this.released) {
      this.released = true;
      const voice = this.ev.bag;
      if (voice.serial === this.serial) voice.unhold();
    }
    if (this.ducked) {
      this.ducked = false;
      this.ev.core.releaseDuck(duckAt);
    }
    if (!this.ended) {
      this.ended = true;
      const f = this.onEnd;
      this.onEnd = null;
      if (f) f();
    }
  }
}
