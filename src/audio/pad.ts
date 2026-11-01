// Tension pad (owned by A): detuned saws on the key's dominant (a pedal that fits every chord of the loop)
// through a resonant low-pass, with a slow LFO that quickens toward a heartbeat as more eyes watch the mat.
// Level follows watchers / max with smoothing and is EXACTLY zero at 0 watchers (a linear ramp to 0, the
// audible "all clear"). The oscillators sleep (are stopped and released) after a few silent seconds.
import { NodeBag, type AudioCore } from './core.js';
import { clamp, hold, midiHz } from './dsp.js';

const PAD_PEAK = 0.075;
/** [semitones above the pedal root, cents detune]. */
const VOICES: ReadonlyArray<readonly [number, number]> = [
  [0, -6],
  [12, 5],
  [19, -4],
  [24, 7],
];
/** A flat-nine "edge" voice that creeps in only when nearly everyone is watching. */
const EDGE: readonly [number, number] = [13, 3];
const SLEEP_MS = 2500;

interface PadNodes {
  bag: NodeBag;
  oscs: OscillatorNode[];
  lp: BiquadFilterNode;
  level: GainNode;
  edge: GainNode;
  lfo: OscillatorNode;
}

export class TensionPad {
  private nodes: PadNodes | null = null;
  private level = 0;
  private root = 36; // C2
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly core: AudioCore,
    /** Live engines stop the oscillators after a silent spell; offline renders keep them. */
    private readonly canSleep: boolean,
  ) {}

  /** Current smoothed target (0..1). */
  get value(): number {
    return this.level;
  }

  /** Cheap when unchanged: safe to call every frame. */
  set(watchers: number, max: number): void {
    const L = max > 0 && Number.isFinite(watchers) ? clamp(watchers / max, 0, 1) : 0;
    if (Math.abs(L - this.level) < 1e-4) return;
    this.level = L;
    const now = this.core.ctx.currentTime;
    if (L <= 0) {
      const n = this.nodes;
      if (!n) return;
      hold(n.level.gain, now);
      n.level.gain.linearRampToValueAtTime(0, now + 0.6); // the all-clear: a true zero, not an asymptote
      hold(n.edge.gain, now);
      n.edge.gain.setTargetAtTime(0, now, 0.2);
      this.scheduleSleep();
      return;
    }
    this.cancelSleep();
    const n = this.nodes ?? this.build(now);
    hold(n.level.gain, now);
    n.level.gain.setTargetAtTime(PAD_PEAK * Math.pow(L, 0.8), now, 0.35);
    hold(n.lp.frequency, now);
    n.lp.frequency.setTargetAtTime(240 + 1500 * L * L, now, 0.5);
    hold(n.lfo.frequency, now);
    n.lfo.frequency.setTargetAtTime(0.12 + 0.95 * L, now, 0.8);
    hold(n.edge.gain, now);
    n.edge.gain.setTargetAtTime(L > 0.7 ? ((L - 0.7) / 0.3) * 0.5 : 0, now, 0.6);
  }

  /** Move the pedal to a new pitch class (the music's dominant); glides if sounding. */
  setRoot(pc: number): void {
    const target = 33 + ((((pc - 9) % 12) + 12) % 12); // A1..G#2: always the lowest octave near C2
    if (target === this.root) return;
    this.root = target;
    const n = this.nodes;
    if (!n) return;
    const now = this.core.ctx.currentTime;
    for (let i = 0; i < n.oscs.length; i++) {
      const st = i < VOICES.length ? VOICES[i][0] : EDGE[0];
      hold(n.oscs[i].frequency, now);
      n.oscs[i].frequency.setTargetAtTime(midiHz(this.root + st), now, 0.4);
    }
  }

  private build(now: number): PadNodes {
    const ctx = this.core.ctx;
    const bag = new NodeBag();
    bag.open(1);
    const gain = (v: number): GainNode => {
      const g = bag.add(ctx.createGain());
      g.gain.value = v;
      return g;
    };
    const level = gain(0);
    level.connect(this.core.bus.pad);
    const trem = gain(0.8);
    trem.connect(level);
    const lp = bag.add(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    lp.Q.value = 2.2;
    lp.connect(trem);
    const oscs: OscillatorNode[] = [];
    const far = now + 36000;
    for (const [st, cents] of VOICES) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midiHz(this.root + st);
      o.detune.value = cents;
      o.connect(lp);
      oscs.push(bag.play(o, now, far));
    }
    const edge = gain(0);
    edge.connect(lp);
    const eo = ctx.createOscillator();
    eo.type = 'sawtooth';
    eo.frequency.value = midiHz(this.root + EDGE[0]);
    eo.detune.value = EDGE[1];
    eo.connect(edge);
    oscs.push(bag.play(eo, now, far));
    // one LFO breathes both the level (tremolo) and the filter (a slow "wah")
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.15;
    const lfoAmp = gain(0.2);
    const lfoCut = gain(110);
    lfo.connect(lfoAmp).connect(trem.gain);
    lfo.connect(lfoCut).connect(lp.frequency);
    bag.play(lfo, now, far);
    this.nodes = { bag, oscs, lp, level, edge, lfo };
    return this.nodes;
  }

  private scheduleSleep(): void {
    if (!this.canSleep) return;
    this.cancelSleep();
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = null;
      const n = this.nodes;
      if (!n || this.level > 0) return;
      const t = this.core.ctx.currentTime + 0.02;
      for (let i = 0; i < n.bag.sources.length; i++) {
        try {
          n.bag.sources[i].stop(t);
        } catch {
          /* already stopped */
        }
      }
      this.nodes = null; // the bag disconnects itself when the sources report 'ended'
    }, SLEEP_MS);
  }

  private cancelSleep(): void {
    if (this.sleepTimer !== null) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
  }

  dispose(): void {
    this.cancelSleep();
    this.nodes?.bag.finish();
    this.nodes = null;
  }
}
