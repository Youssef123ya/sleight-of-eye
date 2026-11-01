// Attention (G): every frame decide where each spectator looks, by its rule.
//  - fox kits (follower): the gaze point CFG.followLag behind (a little more for each smaller kit); eye contact
//    ≥ CFG.eyeContactFox → they look back at the player's eyes (mood 'eyeContact').
//  - magpie (sparkle): candle flare / firework > shiny prop on the mat; ignores the gaze.
//  - Sir Brock (hands): the palming hand, else the most active hand — unless flustered (eye contact ≥
//    CFG.eyeContactCritic → blushScribble in his notebook for CFG.flusterDuration).
//  - firework bang: every head not in a notebook looks at the burst for CFG.bangLookDuration.
// Also counts the watchers of the mat (tension pad + eye glyphs) and shows sight cones when asked.
import { Vector3, type Signal } from '@iwsdk/core';
import { CFG } from '../config.js';
import type { AudioEngine, Cafe, Settings, Spectator, SpectatorKind, UI } from '../contracts.js';
import { L, type StageRig } from '../layout.js';
import type { GazeTracker } from './gaze.js';
import type { HandTracker } from './hands.js';
import { PointHistory } from './math.js';
import { PROP_IDS, type PropController } from './props.js';
import type { SeenTester } from './seen.js';

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

export interface Watcher {
  readonly spec: Spectator;
  readonly rule: Rule;
  /** Persistent per-spectator look target (never shared, in case a module keeps the reference). */
  readonly target: Vector3;
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
    rig.toWorld(L.mat.center, this.matFocus);
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
      const w: Watcher = {
        spec,
        rule,
        target: new Vector3(),
        hasTarget: false,
        lagExtra: rule === 'follower' ? 0.05 * kitIndex++ : 0,
        watchingMat: false,
        eyeContact: false,
        flusterUntil: 0,
        flusterArmed: true,
        glyph: '',
        cone: -1,
        mood: '',
      };
      this.watchers.push(w);
    }
    this.reset();
  }

  /** Lineup spectators (rule-driven). */
  audience(out: Spectator[]): Spectator[] {
    out.length = 0;
    for (const w of this.watchers) out.push(w.spec);
    return out;
  }

  watcher(id: string): Watcher | null {
    for (const w of this.watchers) if (w.spec.id === id) return w;
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
      this.safe(() => w.spec.lookAt(w.target, { urgency: 1 }));
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
    let count = 0;
    for (let i = 0; i < this.watchers.length; i++) {
      const w = this.watchers[i];
      try {
        this.decide(w, t);
        // a flustered critic is buried in his notebook: never watching
        w.watchingMat = w.flusterUntil > t ? false : this.seen.watching(w.spec, this.matFocus, 4);
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

  private warned = false;

  private decide(w: Watcher, t: number): void {
    const spec = w.spec;
    const flustered = w.flusterUntil > t;
    if (w.rule === 'hands' && w.flusterUntil > 0 && !flustered) {
      // fluster ended
      w.flusterUntil = 0;
      this.setMood(w, 'neutral');
    }
    const pin = this.pins.size ? this.pins.get(spec.id) : undefined;
    if (pin) {
      if (pin.until > t) {
        this.look(w, pin.target === 'player' ? this.gaze.origin : pin.target, 0.6);
        return;
      }
      this.pins.delete(spec.id);
    }
    // the gasp: everyone stares at the empty spot
    if (this.focusUntil > t && !flustered) {
      this.look(w, this.focusPoint, 0.9);
      return;
    }
    // the bang: every head not in a notebook looks at the burst
    if (this.bangUntil > t && !flustered) {
      this.look(w, this.bangPoint, 1);
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
    void spec;
  }

  private follower(w: Watcher, t: number): void {
    const g = this.gaze;
    const contact = g.targetId === w.spec.id && g.dwell >= CFG.eyeContactFox;
    if (contact) {
      if (!w.eyeContact) {
        w.eyeContact = true;
        this.setMood(w, 'eyeContact');
      }
      this.look(w, g.origin, 0.6);
      return;
    }
    if (w.eyeContact) {
      w.eyeContact = false;
      this.setMood(w, 'neutral');
    }
    if (!this.history.sample(t - CFG.followLag - w.lagExtra, this.tmp)) return;
    // never stare at our own face: when the (delayed) gaze point is our head, hold the previous target
    w.spec.getEyeWorldPosition(this.tmp2);
    if (this.tmp.distanceToSquared(this.tmp2) < 0.08 * 0.08) {
      if (!w.hasTarget) this.look(w, g.origin, 0.4);
      return;
    }
    this.look(w, this.tmp, 0.5);
  }

  private sparkle(w: Watcher): void {
    const gadgets = this.cafe.gadgets;
    const candle = gadgets.candle;
    const firework = gadgets.firework;
    if (candle && this.isActive(candle)) {
      candle.focus.getWorldPosition(this.tmp);
      this.look(w, this.tmp, 0.75);
      return;
    }
    if (firework && this.isActive(firework)) {
      firework.focus.getWorldPosition(this.tmp);
      this.look(w, this.tmp, 0.75);
      return;
    }
    // shiny props on the mat: a lifted one first, else the nearest to the mat centre
    let bestD = Infinity;
    let found = false;
    for (let i = 0; i < PROP_IDS.length; i++) {
      const id = PROP_IDS[i];
      const p = this.props.prop(id);
      if (!p || !p.shiny || !p.root.visible) continue;
      const mode = this.props.mode(id);
      if (mode === 'palmed' || mode === 'loaded' || mode === 'hidden') continue;
      this.props.centerWorld(id, this.tmp2);
      const d = mode === 'lifted' || mode === 'auto' ? -1 : this.tmp2.distanceToSquared(this.matFocus);
      if (d < bestD) {
        bestD = d;
        this.tmp.copy(this.tmp2);
        found = true;
      }
    }
    // nothing shiny left: she keeps staring at where the shine was
    this.look(w, found ? this.tmp : this.matFocus, 0.6);
  }

  private critic(w: Watcher, t: number, flustered: boolean): void {
    const g = this.gaze;
    if (g.targetId !== w.spec.id) w.flusterArmed = true;
    if (flustered) {
      try {
        w.spec.getAnchor('notebook').getWorldPosition(this.tmp);
      } catch {
        w.spec.getEyeWorldPosition(this.tmp);
        this.tmp.y -= 0.08;
      }
      this.look(w, this.tmp, 0.45);
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
      this.look(w, hand.pinching ? hand.pinchPoint : hand.palm, 0.55);
      return;
    }
    this.look(w, this.matFocus, 0.4);
  }

  private look(w: Watcher, p: Vector3, urgency: number): void {
    w.target.copy(p);
    w.hasTarget = true;
    w.spec.lookAt(w.target, { urgency });
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
