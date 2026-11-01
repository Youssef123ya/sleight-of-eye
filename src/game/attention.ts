// Attention (G): every frame decide where each spectator looks, by its rule.
//  - fox kits (follower): the gaze point CFG.followLag behind (a little more for each smaller kit); eye contact
//    ≥ CFG.eyeContactFox → they look back at the player's eyes (mood 'eyeContact').
//  - magpie (sparkle): candle flare / firework > shiny prop on the mat; ignores the gaze.
//  - Sir Brock (hands): the palming hand, else the most active hand — unless flustered (eye contact ≥
//    CFG.eyeContactCritic → blushScribble in his notebook for CFG.flusterDuration).
//  - firework bang: every head not in a notebook looks at the burst for CFG.bangLookDuration.
// Also counts the watchers of the mat (tension pad + eye glyphs), shows sight cones when asked and keeps the drawn
// cone width in step with the rule (Easy Audience narrows it). Per-frame work allocates nothing: each watcher's
// eye position and look direction are sampled once per frame into its own vectors, and lookAt options are
// constants per call site.
import { Vector3, type Object3D, type Signal } from '@iwsdk/core';
import { CFG } from '../config.js';
import type { AudioEngine, Cafe, Settings, Spectator, SpectatorKind, UI } from '../contracts.js';
import { L, type StageRig } from '../layout.js';
import type { GazeTracker } from './gaze.js';
import type { HandTracker } from './hands.js';
import { PointHistory, copyV, dist2 } from './math.js';
import { PROP_IDS, type PropController } from './props.js';
import type { SeenTester } from './seen.js';
import { rigFrame, worldPos } from './space.js';

export type Rule = 'follower' | 'sparkle' | 'hands' | 'none';

export function ruleFor(kind: SpectatorKind): Rule {
  switch (kind) {
    case 'fox':
      return 'follower';
    case 'magpie':
      return 'sparkle';
    case 'badger':
      return 'hands';
    default:
      return 'none';
  }
}

/** lookAt options, one constant object per call site (Spectator.lookAt reads them immediately). */
const URGENCY = {
  pinned: { urgency: 0.6 },
  gasp: { urgency: 0.9 },
  bang: { urgency: 1 },
  eyeContact: { urgency: 0.6 },
  followFirst: { urgency: 0.4 },
  follow: { urgency: 0.5 },
  sparkleGadget: { urgency: 0.75 },
  sparkleProp: { urgency: 0.6 },
  notebook: { urgency: 0.45 },
  hand: { urgency: 0.55 },
  mat: { urgency: 0.4 },
} as const;

export interface Watcher {
  readonly spec: Spectator;
  readonly rule: Rule;
  /** Persistent per-spectator look target (never shared, in case a module keeps the reference). */
  readonly target: Vector3;
  /** This frame's eye midpoint and unit look direction (world). */
  readonly eye: Vector3;
  readonly dir: Vector3;
  /** The 'eyes' anchor (null: fall back to getEyeWorldPosition). */
  readonly eyes: Object3D | null;
  hasTarget: boolean;
  lagExtra: number;
  watchingMat: boolean;
  eyeContact: boolean;
  /** Brock: flustered until this clock time (Infinity = until windows end). */
  flusterUntil: number;
  flusterArmed: boolean;
  glyph: 'open' | 'closed' | 'hidden' | '';
  cone: 0 | 1 | 2 | -1; // 0 off, 1 on, 2 alarm, -1 unknown
  mood: string;
  /** Drawn sight-cone half angle last sent (deg). */
  half: number;
}

export class Attention {
  readonly watchers: Watcher[] = [];
  /** Spectators not driven by rules but still updated (e.g. the assist rabbit). */
  conesVisible = false;
  glyphsVisible = false;
  /** Spectator id whose cone flashes red (the catcher), or null. */
  alarmId: string | null = null;
  /** Featured spectator whose cone is shown in a rule demo. */
  demoConeId: string | null = null;
  watcherCount = 0;
  frozen = false;
  /** World point everyone stares at during a gasp (until focusUntil). */
  readonly focusPoint = new Vector3();
  focusUntil = -1;
  readonly bangPoint = new Vector3();
  bangUntil = -1;
  /** Current point of interest on the mat (the beat's prop), written by the trick runner. */
  readonly matFocus = new Vector3();
  /** Fired when Brock gets flustered (the runner adds lines/sounds). */
  onFluster: ((w: Watcher) => void) | null = null;
  /** Spectators whose look is pinned (e.g. the volunteer faces the magician during the reveal). */
  private readonly pins = new Map<string, { target: Vector3 | 'player'; until: number }>();

  private readonly history = new PointHistory(160);
  private clock = 0;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private lastTension = -1;
  private lastTensionMax = -1;
  private warned = false;

  constructor(
    private readonly rig: StageRig,
    private readonly cafe: Cafe,
    private readonly gaze: GazeTracker,
    private readonly hands: HandTracker,
    private readonly props: PropController,
    private readonly seen: SeenTester,
    private readonly audio: AudioEngine,
    private readonly settings: Signal<Settings>,
    private readonly ui: UI,
  ) {
    rigFrame(rig).toWorld(L.mat.center, this.matFocus);
  }

  get time(): number {
    return this.clock;
  }

  setLineup(specs: readonly Spectator[]): void {
    this.watchers.length = 0;
    let kitIndex = 0;
    for (const spec of specs) {
      const rule = ruleFor(spec.kind);
      if (rule === 'none') continue;
      let eyes: Object3D | null = null;
      try {
        eyes = spec.getAnchor('eyes') ?? null;
        if (eyes === spec.root) eyes = null;
      } catch {
        eyes = null;
      }
      const w: Watcher = {
        spec,
        rule,
        target: new Vector3(),
        eye: new Vector3(),
        dir: new Vector3(0, 0, 1),
        eyes,
        hasTarget: false,
        lagExtra: rule === 'follower' ? 0.05 * kitIndex++ : 0,
        watchingMat: false,
        eyeContact: false,
        flusterUntil: 0,
        flusterArmed: true,
        glyph: '',
        cone: -1,
        mood: '',
        half: -1,
      };
      this.watchers.push(w);
    }
    this.reset();
  }

  /** Lineup spectators (rule-driven). */
  audience(out: Spectator[]): Spectator[] {
    out.length = 0;
    for (let i = 0; i < this.watchers.length; i++) out.push(this.watchers[i].spec);
    return out;
  }

  watcher(id: string): Watcher | null {
    for (let i = 0; i < this.watchers.length; i++) if (this.watchers[i].spec.id === id) return this.watchers[i];
    return null;
  }

  isFlustered(id: string): boolean {
    const w = this.watcher(id);
    return !!w && w.flusterUntil > this.clock;
  }

  /** Clear follow history, bang, fluster, alarms (beat rewinds, act changes, recalibration). */
  reset(): void {
    this.history.clear();
    this.pins.clear();
    this.bangUntil = -1;
    this.focusUntil = -1;
    this.alarmId = null;
    for (const w of this.watchers) {
      if (w.flusterUntil > this.clock) this.safe(() => w.spec.react('idle'));
      w.flusterUntil = 0;
      w.flusterArmed = true;
      w.eyeContact = false;
      w.hasTarget = false;
      this.setMood(w, 'neutral');
    }
  }

  resetHistory(): void {
    this.history.clear();
  }

  /** Firework bang: every free head looks at the burst. */
  bang(point: Vector3): void {
    this.bangPoint.copy(point);
    this.bangUntil = this.clock + (this.settings.peek().easyAudience ? Infinity : CFG.bangLookDuration);
    for (const w of this.watchers) {
      if (w.flusterUntil > this.clock) continue;
      w.target.copy(point);
      w.hasTarget = true;
      this.safe(() => w.spec.lookAt(w.target, URGENCY.bang));
    }
  }

  /** Pin one spectator's look ('player' = the magician's eyes) for `seconds` (Infinity until unpinned). */
  pin(id: string, target: Vector3 | 'player', seconds = Infinity): void {
    this.pins.set(id, { target: target === 'player' ? 'player' : target.clone(), until: this.clock + seconds });
  }

  unpin(id: string): void {
    this.pins.delete(id);
  }

  /** Everyone stares at one point for a moment (the gasp at an empty mat). */
  focusAll(point: Vector3, seconds: number): void {
    this.focusPoint.copy(point);
    this.focusUntil = this.clock + seconds;
  }

  /** End every "window" (Easy Audience keeps them open until used): bang look and fluster. */
  endWindows(): void {
    this.bangUntil = -1;
    for (const w of this.watchers) {
      if (w.flusterUntil > this.clock) {
        w.flusterUntil = 0;
        w.flusterArmed = false;
        this.safe(() => w.spec.react('idle'));
        this.setMood(w, 'neutral');
      }
    }
  }

  update(dt: number): void {
    this.clock += dt;
    this.history.push(this.clock, this.gaze.point);
    if (this.frozen) return;
    const t = this.clock;
    const half = this.seen.halfAngleDeg();
    let count = 0;
    for (let i = 0; i < this.watchers.length; i++) {
      const w = this.watchers[i];
      try {
        this.sample(w);
        if (w.half !== half) {
          w.half = half;
          const s = w.spec as Spectator & { setSightHalfAngle?: (deg: number) => void };
          if (typeof s.setSightHalfAngle === 'function') s.setSightHalfAngle(half);
        }
        this.decide(w, t);
        // a flustered critic is buried in his notebook: never watching
        w.watchingMat = w.flusterUntil > t ? false : this.seen.watchingFrom(w.eye, w.dir, this.matFocus, 4);
      } catch (e) {
        w.watchingMat = false;
        if (!this.warned) {
          this.warned = true;
          console.warn('[attention] spectator update failed', e);
        }
      }
      if (w.watchingMat) count++;
      // eye glyph
      const glyph = this.glyphsVisible ? (w.watchingMat ? 'open' : 'closed') : 'hidden';
      if (glyph !== w.glyph) {
        w.glyph = glyph;
        this.safe(() => w.spec.setEyeGlyph(glyph));
      }
      // sight cone
      const alarm = this.alarmId === w.spec.id;
      const coneState: 0 | 1 | 2 = alarm ? 2 : this.conesVisible || this.demoConeId === w.spec.id ? 1 : 0;
      if (coneState !== w.cone) {
        w.cone = coneState;
        this.safe(() => w.spec.setSightCone(coneState > 0, coneState === 2));
      }
    }
    this.watcherCount = count;
    const max = this.watchers.length;
    if (count !== this.lastTension || max !== this.lastTensionMax) {
      this.lastTension = count;
      this.lastTensionMax = max;
      this.safe(() => this.audio.setTension(count, max));
    }
  }

  /** This frame's eye position + look direction (one read per spectator per frame). */
  private sample(w: Watcher): void {
    if (w.eyes) worldPos(w.eyes, w.eye);
    else w.spec.getEyeWorldPosition(w.eye);
    w.spec.getLookDirection(w.dir);
  }

  private decide(w: Watcher, t: number): void {
    const flustered = w.flusterUntil > t;
    if (w.rule === 'hands' && w.flusterUntil > 0 && !flustered) {
      // fluster ended
      w.flusterUntil = 0;
      this.setMood(w, 'neutral');
    }
    const pin = this.pins.size ? this.pins.get(w.spec.id) : undefined;
    if (pin) {
      if (pin.until > t) {
        this.look(w, pin.target === 'player' ? this.gaze.origin : pin.target, URGENCY.pinned);
        return;
      }
      this.pins.delete(w.spec.id);
    }
    // the gasp: everyone stares at the empty spot
    if (this.focusUntil > t && !flustered) {
      this.look(w, this.focusPoint, URGENCY.gasp);
      return;
    }
    // the bang: every head not in a notebook looks at the burst
    if (this.bangUntil > t && !flustered) {
      this.look(w, this.bangPoint, URGENCY.bang);
      return;
    }
    switch (w.rule) {
      case 'follower':
        this.follower(w, t);
        break;
      case 'sparkle':
        this.sparkle(w);
        break;
      case 'hands':
        this.critic(w, t, flustered);
        break;
      default:
        break;
    }
  }

  private follower(w: Watcher, t: number): void {
    const g = this.gaze;
    const contact = g.targetId === w.spec.id && g.dwell >= CFG.eyeContactFox;
    if (contact) {
      if (!w.eyeContact) {
        w.eyeContact = true;
        this.setMood(w, 'eyeContact');
      }
      this.look(w, g.origin, URGENCY.eyeContact);
      return;
    }
    if (w.eyeContact) {
      w.eyeContact = false;
      this.setMood(w, 'neutral');
    }
    if (!this.history.sample(t - CFG.followLag - w.lagExtra, this.tmp)) return;
    // never stare at our own face: when the (delayed) gaze point is our head, hold the previous target
    const ex = this.tmp.x - w.eye.x;
    const ey = this.tmp.y - w.eye.y;
    const ez = this.tmp.z - w.eye.z;
    if (ex * ex + ey * ey + ez * ez < 0.08 * 0.08) {
      if (!w.hasTarget) this.look(w, g.origin, URGENCY.followFirst);
      return;
    }
    this.look(w, this.tmp, URGENCY.follow);
  }

  private sparkle(w: Watcher): void {
    const gadgets = this.cafe.gadgets;
    const candle = gadgets.candle;
    const firework = gadgets.firework;
    if (candle && this.isActive(candle)) {
      worldPos(candle.focus, this.tmp);
      this.look(w, this.tmp, URGENCY.sparkleGadget);
      return;
    }
    if (firework && this.isActive(firework)) {
      worldPos(firework.focus, this.tmp);
      this.look(w, this.tmp, URGENCY.sparkleGadget);
      return;
    }
    // shiny props on the mat: a lifted one first, else the nearest to the mat centre
    let bestD = Infinity;
    let found = false;
    for (let i = 0; i < PROP_IDS.length; i++) {
      const id = PROP_IDS[i];
      const p = this.props.prop(id);
      // the ball counts as treasure whatever its material says (spec §7: the magpie stares at the shiny ball)
      if (!p || !(p.shiny || id === 'ball') || !p.root.visible) continue;
      const mode = this.props.mode(id);
      if (mode === 'palmed' || mode === 'loaded' || mode === 'hidden') continue;
      this.props.centerWorld(id, this.tmp2);
      const d = mode === 'lifted' || mode === 'auto' ? -1 : dist2(this.tmp2, this.matFocus);
      if (d < bestD) {
        bestD = d;
        copyV(this.tmp, this.tmp2);
        found = true;
      }
    }
    // nothing shiny left: she keeps staring at where the shine was
    this.look(w, found ? this.tmp : this.matFocus, URGENCY.sparkleProp);
  }

  private critic(w: Watcher, t: number, flustered: boolean): void {
    const g = this.gaze;
    if (g.targetId !== w.spec.id) w.flusterArmed = true;
    if (flustered) {
      let notebook: Object3D | null = null;
      try {
        notebook = w.spec.getAnchor('notebook');
      } catch {
        notebook = null;
      }
      if (notebook) worldPos(notebook, this.tmp);
      else {
        copyV(this.tmp, w.eye);
        this.tmp.y -= 0.08;
      }
      this.look(w, this.tmp, URGENCY.notebook);
      return;
    }
    if (w.flusterArmed && g.targetId === w.spec.id && g.dwell >= CFG.eyeContactCritic) {
      w.flusterArmed = false;
      const easy = this.settings.peek().easyAudience;
      w.flusterUntil = t + (easy ? Infinity : CFG.flusterDuration);
      this.setMood(w, 'flustered');
      this.safe(() => {
        void w.spec.react('blushScribble', { duration: easy ? Infinity : CFG.flusterDuration }).catch(() => {});
      });
      this.safe(() => this.onFluster?.(w));
      return;
    }
    // the palming hand first, then the most active hand
    const holder = this.props.palmHolder();
    let hand = null;
    if (holder && holder !== 'rabbit' && this.hands.states[holder].tracked) hand = this.hands.states[holder];
    else hand = this.hands.mostActive();
    if (hand) {
      this.look(w, hand.pinching ? hand.pinchPoint : hand.palm, URGENCY.hand);
      return;
    }
    this.look(w, this.matFocus, URGENCY.mat);
  }

  private look(w: Watcher, p: Vector3, opts: { readonly urgency: number }): void {
    copyV(w.target, p);
    w.hasTarget = true;
    w.spec.lookAt(w.target, opts);
  }

  private isActive(g: { isActive(): boolean }): boolean {
    try {
      return g.isActive();
    } catch {
      return false;
    }
  }

  private setMood(w: Watcher, mood: 'neutral' | 'eyeContact' | 'flustered' | 'suspicious'): void {
    if (w.mood === mood) return;
    w.mood = mood;
    this.safe(() => w.spec.setMood(mood));
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        console.warn('[attention] spectator call failed', e);
      }
    }
  }
}
