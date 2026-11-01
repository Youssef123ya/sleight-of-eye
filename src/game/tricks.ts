// Trick runner (G): interprets the act data (acts.ts) beat by beat — intro, demo, show, steal, load, lookBack,
// reveal, bow — with gadgets fired by gaze dwell, catches that rewind to a checkpoint, hints, assist mode,
// stars and act transitions. Per-frame work is allocation-free; async sequences run on the runner's own
// (pause-aware) clock and are cancelled by an epoch counter when a beat changes.
import { Group, Vector3, type Object3D } from '@iwsdk/core';
import { SPECTATOR_ACCENT } from '../art/palette.js';
import { CFG } from '../config.js';
import type {
  GadgetId,
  GameContext,
  Gadget,
  Mood,
  PropId,
  Side,
  Spectator,
  SpectatorAnchor,
} from '../contracts.js';
import { L } from '../layout.js';
import { ACTS, ALL_ACTS, CATCH_LINE, FLUSTER_LINES, type ActDef, type BeatDef, type CastMember, type Line } from './acts.js';
import type { Attention, Watcher } from './attention.js';
import type { GazeTracker } from './gaze.js';
import { SIDES, type HandTracker } from './hands.js';
import type { Hints } from './hints.js';
import { clamp01, hash01 } from './math.js';
import type { Holder, PropController, PropSnapshot } from './props.js';
import type { GazeTargetRegistryImpl, PokeRegistryImpl } from './registries.js';
import type { SeenTester } from './seen.js';
import { refreshWorld, rigFrame, worldPos, worldPosNow, type RigFrame } from './space.js';

export type Phase = 'idle' | 'transition' | 'active' | 'prep' | 'ready' | 'resolving' | 'caught' | 'done';

export const GADGET_IDS: readonly GadgetId[] = ['musicBox', 'candle', 'firework'];
const BASE_DURATION: Record<GadgetId, number> = {
  musicBox: CFG.musicBoxDuration,
  candle: CFG.candleDuration,
  firework: CFG.bangLookDuration,
};
const LOOKBACK_HOLD = 0.35;
/**
 * Rig-local height for flat sight cones: the café's velvet mat is 6 mm thick (props stand on its top, at the
 * L.propMarks height) while the puppets draw their cone at L.tableY + 4.5 mm, which hid it under the velvet
 * exactly where it matters. Lifted to just above the mat top (still below every prop's body).
 */
const MAT_TOP = L.propMarks.coin[1];
const CONE_Y = MAT_TOP + 0.0012;
const QUICK_REVEAL_S = 3.0;
const ANCHORS: SpectatorAnchor[] = ['eyes', 'head', 'ear', 'hand', 'notebook', 'beak', 'hatTop'];
/** fx/sfx options used from per-frame code (constants: nothing allocated per call). */
const EAR_SPARKLE = { count: 3, scale: 0.6 } as const;
const TINK_OPTS = { at: new Vector3(), volume: 0.35, pitch: 1.4 };

export interface RunnerDeps {
  ctx: GameContext;
  props: PropController;
  attention: Attention;
  seen: SeenTester;
  gaze: GazeTracker;
  handTracker: HandTracker;
  hints: Hints;
  pokes: PokeRegistryImpl;
  gazeTargets: GazeTargetRegistryImpl;
  /** Beat boundary reached (autosave). */
  onBeatBoundary: () => void;
}

interface Waiter {
  at: number;
  resolve: () => void;
}

export class TrickRunner {
  act = 0;
  beat = 0;
  phase: Phase = 'idle';
  beatTime = 0;
  clock = 0;
  /** False while paused / "Hold it!" / before calibration. */
  running = false;
  started = false;
  caughtTotal = 0;
  catchesThisAct = 0;
  lastCatch: { by: string; prop: PropId | null; act: number; beat: number } | null = null;
  readonly stars = [0, 0, 0];
  quickReveal = false;
  actDef: ActDef = ACTS[0];
  readonly lineup: Spectator[] = [];
  readonly spectators = new Map<string, Spectator>();
  /** Reveal poke/gaze target id while a reveal waits for the player. */
  revealTargetId: string | null = null;
  /** Gadgets fired / currently active this attempt. */
  readonly gadgetUsed: Record<GadgetId, boolean> = { musicBox: false, candle: false, firework: false };
  readonly gadgetActive: Record<GadgetId, boolean> = { musicBox: false, candle: false, firework: false };
  rabbit: Spectator | null = null;
  /** The bow's newspaper review has been handed to the UI. */
  reviewShown = false;

  private epoch = 0;
  private waiters: Waiter[] = [];
  private checkpointSnap: PropSnapshot | null = null;
  private readonly dwellShown: Record<GadgetId, number> = { musicBox: 0, candle: 0, firework: 0 };
  private fuseLoop: { stop(): void } | null = null;
  private tickLoop: { stop(): void } | null = null;
  private volunteer: Spectator | null = null;
  private liftSeen = false;
  private liftOk = false;
  private liftSide: Side | null = null;
  private lookBackHold = 0;
  private readonly tinked: [boolean, boolean] = [false, false];
  private sparkleTimer = 0;
  private wobbleTimer = 0;
  private gadgetsSpentFor = 0;
  private flusterCount = 0;
  private demoDone = false;
  private introDone = false;
  private revealClock = -1;
  private revealChecked = false;
  private revealOff: Array<() => void> = [];
  private readonly audienceScratch: Spectator[] = [];
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly frame: RigFrame;
  private readonly gazeMarker: Group;
  private assist = false;
  /** Spectators that hopped onto the mat and have not hopped back yet. */
  private readonly away = new Set<Spectator>();
  /** Spectators that cannot see right now (Brock buried in his notebook). */
  private readonly blind = (s: Spectator): boolean => this.d.attention.isFlustered(s.id);

  constructor(private readonly d: RunnerDeps) {
    const { ctx } = d;
    this.frame = rigFrame(ctx.rig);
    // invisible marker the look-back gaze hint drifts to (the mat spot the audience will gasp at)
    this.gazeMarker = new Group();
    this.gazeMarker.name = 'lookback-target';
    ctx.rig.root.add(this.gazeMarker);
    this.gazeMarker.position.set(L.mat.center[0], L.mat.center[1], L.mat.center[2]);
    // the firework's bang turns every free head
    const fw = ctx.cafe.gadgets.firework;
    if (fw) fw.onBurst = () => this.onFireworkBurst();
    d.attention.onFluster = (w) => this.onFluster(w);
    // gadgets are gaze targets (look to fire them)
    for (const id of GADGET_IDS) {
      const g = ctx.cafe.gadgets[id];
      if (!g) continue;
      if (g.root && !g.root.name) g.root.name = id;
      if (g.focus && !g.focus.name) g.focus.name = `${id}-focus`;
      d.gazeTargets.add({
        id,
        radius: g.gazeRadius || 0.06,
        getWorldPosition: (out) => worldPos(g.focus, out),
        enabled: () => g.root.visible !== false,
      });
    }
    // props are gaze targets too (the gaze point snaps onto them)
    for (const id of ['coin', 'ball', 'cupLeft', 'cupMid', 'cupRight', 'watch', 'cupcake'] as PropId[]) {
      const p = ctx.cafe.props[id];
      if (!p) continue;
      d.gazeTargets.add({
        id,
        radius: Math.max(0.025, p.radius || 0.02),
        getWorldPosition: (out) => d.props.centerWorld(id, out),
        enabled: () => p.root.visible && d.props.mode(id) !== 'palmed' && d.props.mode(id) !== 'loaded',
      });
    }
  }

  // ------------------------------------------------------------------------------------------- public API
  get def(): BeatDef | null {
    return this.actDef.beats[this.beat] ?? null;
  }

  /** Start the show (first stable XR frames) — optionally resuming an autosaved act/beat. */
  begin(act = 1, beat = 0): void {
    this.started = true;
    this.running = true;
    void this.startAct(Math.max(1, Math.min(4, act)), beat, false);
  }

  /** Before the show: Act I's cast and coin on stage (the 2D attract view behind the landing page). */
  skipToIdle(): void {
    this.actDef = ACTS[0];
    this.act = 0;
    this.beat = 0;
    this.phase = 'idle';
    this.setupAct(ACTS[0], 0);
  }

  /** Debug/QA: jump straight to an act/beat (props, cast and gadgets set up to match). */
  skipTo(act: number, beat = 0): void {
    const a = Math.max(1, Math.min(ALL_ACTS.length, Math.round(act)));
    const def = ALL_ACTS[a - 1];
    const b = Math.max(0, Math.min(def.beats.length - 1, Math.round(beat)));
    this.started = true;
    void this.startAct(a, b, true);
  }

  /** "Retry beat" plaque: back to the attempt's checkpoint, no penalty. */
  retry(): void {
    const def = this.def;
    if (!def || this.phase === 'transition' || this.phase === 'caught') return;
    if (def.kind === 'bow') {
      this.restartShow();
      return;
    }
    const my = ++this.epoch;
    this.d.hints.clear();
    void this.within(this.d.ctx.ui.rewindSmear(), CFG.rewindTime + 0.3);
    this.safe(() => this.d.ctx.audio.sfx('rewind'));
    void this.wait(CFG.rewindTime * 0.5).then(() => {
      if (my !== this.epoch) return;
      this.rewindTo(this.checkpointOf(def));
    });
  }

  /** A whole new show from Act I (bow → Retry). */
  restartShow(): void {
    this.stars[0] = this.stars[1] = this.stars[2] = 0;
    this.caughtTotal = 0;
    this.reviewShown = false;
    this.safe(() => this.d.ctx.ui.review(null)); // the paper leaves with the old show
    this.d.hints.forget();
    void this.startAct(1, 0, false);
  }

  setAssist(on: boolean): void {
    this.assist = on;
    if (on && !this.rabbit) {
      try {
        const r = this.d.ctx.spectatorFactory.create('rabbit', { id: 'rabbit', seed: 7, accent: SPECTATOR_ACCENT.rabbit, scale: 1 });
        r.root.name = 'rabbit';
        this.nameAnchors(r);
        // the rabbit sits in its top hat on the cloth left of the mat, turned a little toward the props
        this.d.ctx.rig.root.add(r.root);
        r.root.position.set(-0.235, L.tableY + 0.0005, -0.37);
        r.root.rotation.set(0, 0.5, 0);
        this.liftCone(r);
        this.rabbit = r;
        this.spectators.set('rabbit', r);
        this.d.ctx.spectators.push(r);
      } catch (e) {
        console.warn('[tricks] could not create the assist rabbit', e);
      }
    }
    if (this.rabbit) this.rabbit.root.visible = on;
  }

  /** Per-frame. */
  update(dt: number): void {
    if (!this.running) return;
    this.clock += dt;
    this.beatTime += dt;
    this.resolveWaiters();
    this.trackGadgets();
    const def = this.def;
    if (!def || this.phase === 'idle' || this.phase === 'transition') return;
    this.updateMatFocus(def);

    // pinch edges (either hand)
    for (let k = 0; k < 2; k++) {
      const side = SIDES[k];
      const s = this.d.handTracker.states[side];
      if (s.pinchStarted) this.onPinchStart(side, def);
      if (s.pinchEnded) this.onPinchEnd(side, def);
    }
    if (def.gadgets) this.updateGadgets(def, dt);
    this.updateProximityTink(def);

    switch (def.kind) {
      case 'intro':
        this.updateIntro(def);
        break;
      case 'demo':
        this.updateDemo(def, dt);
        break;
      case 'show':
        this.updateShow(def);
        break;
      case 'lookBack':
        this.updateLookBack(def, dt);
        break;
      case 'reveal':
        this.updateReveal(def, dt);
        break;
      default:
        break;
    }
    this.updateHints(def);
    this.d.hints.update(dt);
  }

  // --------------------------------------------------------------------------------------- acts & beats
  private async startAct(n: number, beatIndex: number, instant: boolean): Promise<void> {
    const my = ++this.epoch;
    const { ui } = this.d.ctx;
    this.phase = 'transition';
    this.d.hints.clear();
    this.removeRevealTargets();
    this.stopLoops();
    this.act = n;
    this.actDef = ALL_ACTS[n - 1];
    if (this.reviewShown) this.safe(() => ui.review(null));
    this.reviewShown = false;
    this.beat = beatIndex;
    if (!instant) {
      this.safe(() => this.d.ctx.audio.sfx('curtain'));
      await this.within(ui.curtain('closed'), 1.8);
      if (my !== this.epoch) return;
    }
    this.setupAct(this.actDef, beatIndex);
    if (!instant) {
      await this.within(ui.titleCard(this.actDef.title, this.actDef.subtitle), 3.4);
      if (my !== this.epoch) return;
      this.safe(() => this.d.ctx.audio.sfx('curtain'));
      await this.within(ui.curtain('open'), 1.8);
      if (my !== this.epoch) return;
    } else {
      void this.within(ui.curtain('open'), 1.0);
    }
    this.enterBeat(beatIndex);
  }

  private setupAct(def: ActDef, beatIndex: number): void {
    const { cafe } = this.d.ctx;
    // lineup
    const keep = new Set(def.cast.map((c) => c.id));
    for (const [id, spec] of this.spectators) {
      if (id === 'rabbit' || keep.has(id)) continue;
      spec.root.visible = false;
      this.safe(() => spec.setSightCone(false));
      this.safe(() => spec.setEyeGlyph('hidden'));
    }
    this.lineup.length = 0;
    for (const member of def.cast) {
      const spec = this.ensureSpectator(member);
      if (!spec) continue;
      const seat = cafe.seats[member.seat] ?? cafe.seats[0];
      if (seat) seat.add(spec.root);
      spec.root.position.set(0, 0, 0);
      spec.root.quaternion.identity();
      spec.root.visible = true;
      this.liftCone(spec);
      this.safe(() => spec.setFrozen(false));
      if (this.away.has(spec)) this.sendHome(spec, seat);
      else this.safe(() => void spec.react('idle').catch(() => {}));
      this.safe(() => spec.setMood('neutral'));
      this.lineup.push(spec);
    }
    this.d.attention.setLineup(this.lineup);
    this.volunteer = null;
    // props + gadgets
    this.d.props.setActProps(def.props);
    this.resetGadgets();
    this.catchesThisAct = 0;
    this.quickReveal = false;
    this.revealClock = -1;
    this.revealChecked = false;
    this.flusterCount = 0;
    // a mid-act start (resume / skipTo): replay the state the earlier beats would have left behind
    this.checkpointSnap = null;
    const target = def.beats[beatIndex];
    const cp = target ? this.checkpointOf(target, beatIndex) : beatIndex;
    for (let i = 0; i < beatIndex; i++) {
      if (i === cp) this.checkpointSnap = this.d.props.checkpoint();
      const b = def.beats[i];
      if (b.appear) this.d.props.showHome(b.appear);
      if (b.kind === 'steal' && b.prop) this.d.props.palm(b.prop, 'right');
      if (b.kind === 'load' && b.prop && b.into) this.d.props.load(b.prop, b.into);
    }
  }

  private enterBeat(i: number): void {
    const def = this.actDef.beats[i];
    if (!def) {
      void this.finishAct();
      return;
    }
    this.epoch++;
    this.beat = i;
    this.beatTime = 0;
    this.phase = 'active';
    const { ctx, attention, props, hints } = this.d;
    hints.clear();
    this.removeRevealTargets();
    this.liftSeen = this.liftOk = false;
    this.liftSide = null;
    this.lookBackHold = 0;
    this.tinked[0] = this.tinked[1] = false;
    this.sparkleTimer = 0;
    this.wobbleTimer = 0;
    this.gadgetsSpentFor = 0;
    this.demoDone = false;
    this.introDone = false;
    this.liftLineSaid = false;
    if (this.checkpointOf(def, i) === i || !this.checkpointSnap) this.checkpointSnap = props.checkpoint();

    props.clearGlints();
    this.applyGadgetAvailability(def);
    attention.alarmId = null;
    attention.conesVisible = def.kind === 'steal' || def.kind === 'load';
    attention.glyphsVisible =
      def.kind === 'show' || def.kind === 'steal' || def.kind === 'load' || def.kind === 'lookBack' || def.kind === 'demo';
    attention.demoConeId = def.kind === 'demo' ? (def.focus ?? null) : null;
    this.updateMatFocus(def);
    this.safe(() =>
      ctx.audio.music.setMood(def.kind === 'steal' || def.kind === 'load' ? 'tense' : def.kind === 'bow' ? 'triumph' : 'calm'),
    );
    this.speakLines(def.lines);

    switch (def.kind) {
      case 'intro':
        this.d.gaze.resetTravel();
        if (def.appear) {
          props.showHome(def.appear);
          const p = props.prop(def.appear);
          if (p) this.safe(() => void p.animate('appear').catch(() => {}));
          props.centerWorld(def.appear, this.tmp);
          this.safe(() => ctx.fx.burst('stars', this.tmp, { count: 8, scale: 0.6 }));
          const brock = this.spectators.get('brock');
          if (brock) this.safe(() => void brock.react('leanIn').catch(() => {}));
        }
        break;
      case 'demo':
        if (def.prop) {
          props.setGlint(def.prop, 'gold');
          this.wobble(def.prop);
        }
        break;
      case 'show':
        if (def.prop) props.setGlint(def.prop, 'gold');
        break;
      case 'steal':
        if (def.prop) props.setGlint(def.prop, 'blue');
        break;
      case 'load':
        if (def.into) props.setGlint(def.into, 'target');
        break;
      case 'lookBack':
        this.endWindows();
        if (def.prop) {
          props.homeWorld(def.prop, this.tmp);
          ctx.rig.toLocal(this.tmp, this.gazeMarker.position);
        }
        break;
      case 'reveal':
        this.enterReveal(def);
        break;
      case 'bow':
        this.enterBow();
        break;
    }
    ctx.events.emit('beat:start', { act: this.act, beat: i, kind: def.kind });
    this.d.onBeatBoundary();
  }

  private completeBeat(): void {
    const def = this.def;
    if (!def) return;
    this.d.hints.clear();
    this.d.ctx.events.emit('beat:complete', { act: this.act, beat: this.beat });
    if (def.final) {
      void this.finishAct();
      return;
    }
    this.enterBeat(this.beat + 1);
  }

  private async finishAct(): Promise<void> {
    const my = ++this.epoch;
    const { ctx } = this.d;
    this.phase = 'done';
    this.d.hints.clear();
    this.removeRevealTargets();
    this.d.attention.conesVisible = false;
    this.d.attention.glyphsVisible = false;
    if (this.act <= 3) {
      const clean = this.catchesThisAct === 0;
      const stars = 1 + (clean ? 1 : 0) + (clean && this.quickReveal ? 1 : 0);
      this.stars[this.act - 1] = stars;
      ctx.events.emit('act:complete', { act: this.act, stars });
      for (let k = 0; k < stars; k++) {
        // each star keeps its own point (the runner's scratch vectors are reused before these fire)
        const at = this.frame.toWorld([(k - (stars - 1) / 2) * 0.06, L.tableY + 0.16, -0.45], new Vector3());
        void this.wait(0.35 + 0.3 * k).then(() => {
          if (my !== this.epoch) return;
          this.safe(() => ctx.audio.sfx('star', { at, pitch: 1 + 0.12 * k }));
          this.safe(() => ctx.fx.burst('stars', at, { count: 6, scale: 0.8 }));
        });
      }
      this.d.onBeatBoundary();
      if (this.volunteer) {
        const v = this.volunteer;
        await this.wait(1.6);
        if (my !== this.epoch) return;
        await this.hopHome(v);
        if (my !== this.epoch) return;
      }
      await this.wait(1.8);
      if (my !== this.epoch) return;
      void this.startAct(this.act + 1, 0, false);
    }
  }

  // -------------------------------------------------------------------------------------- beat handlers
  private updateIntro(def: BeatDef): void {
    if (def.appear) {
      if (this.beatTime >= (def.duration ?? 3.5)) this.completeBeat();
      return;
    }
    if (this.introDone) return;
    const minTime = def.minTime ?? 2.5;
    const goal = (def.travelDeg ?? 40) <= this.d.gaze.travel && this.beatTime >= minTime;
    if (goal || this.beatTime >= (def.duration ?? 9)) {
      this.introDone = true;
      const my = this.epoch;
      // the first giggle: they noticed they follow you
      this.forLineup((s, i) => this.later(0.1 + 0.13 * i, my, () => void s.react('giggle').catch(() => {})));
      this.safe(() => this.d.ctx.audio.crowd('giggle', 0.5, this.d.attention.matFocus));
      this.speakLines(def.successLines);
      void this.wait(1.3).then(() => {
        if (my === this.epoch) this.completeBeat();
      });
    }
  }

  private updateDemo(def: BeatDef, dt: number): void {
    if (def.prop) {
      this.wobbleTimer += dt;
      if (this.wobbleTimer > 2.6) {
        this.wobbleTimer = 0;
        this.wobble(def.prop);
      }
    }
    if (this.demoDone) return;
    const flustered = !!def.untilFluster && !!def.focus && this.d.attention.isFlustered(def.focus);
    if (flustered || this.beatTime >= (def.duration ?? 8)) {
      this.demoDone = true;
      const my = this.epoch;
      void this.wait(flustered ? 2.2 : 0.2).then(() => {
        if (my === this.epoch) this.completeBeat();
      });
    }
  }

  private updateShow(def: BeatDef): void {
    if (!def.prop) return;
    const mode = this.d.props.mode(def.prop);
    if (mode === 'lifted' && this.d.props.liftTime(def.prop) >= 0.35) this.liftOk = true;
    if (this.liftSeen && mode === 'home') {
      if (this.liftOk) {
        this.liftSeen = false;
        this.completeBeat();
      } else {
        this.liftSeen = false; // too quick: let them try again
      }
    }
  }

  private updateLookBack(def: BeatDef, dt: number): void {
    if (this.phase !== 'active') return;
    const g = this.d.gaze;
    const p = g.pointLocal;
    const cx = L.mat.center[0];
    const cz = L.mat.center[2];
    const onMat =
      g.surface !== 'backdrop' &&
      Math.abs(p.x - cx) <= L.mat.size[0] / 2 + 0.04 &&
      Math.abs(p.z - cz) <= L.mat.size[1] / 2 + 0.04 &&
      p.y < L.tableY + 0.06;
    this.lookBackHold = onMat ? this.lookBackHold + dt : Math.max(0, this.lookBackHold - dt * 2);
    if (this.lookBackHold >= LOOKBACK_HOLD) this.resolveLookBack(def);
  }

  private resolveLookBack(def: BeatDef): void {
    this.phase = 'resolving';
    const my = this.epoch;
    const { ctx, attention } = this.d;
    this.d.hints.clear();
    const spot = this.tmp;
    if (def.prop) this.d.props.homeWorld(def.prop, spot);
    else ctx.rig.toWorld(L.mat.center, spot);
    attention.focusAll(spot, 2.4);
    this.forLineup((s, i) => this.later(0.12 + 0.14 * i, my, () => void s.react('gasp').catch(() => {})));
    this.safe(() => ctx.audio.crowd('gasp', 0.9, spot));
    this.speakLines(def.successLines);
    if (def.topple) {
      const who = this.spectators.get(def.topple);
      if (who) this.later(0.55, my, () => void who.react('topple').catch(() => {}));
    }
    void this.wait(1.9).then(() => {
      if (my === this.epoch) this.completeBeat();
    });
  }

  private enterReveal(def: BeatDef): void {
    if (def.at === 'volunteer' && def.volunteer) {
      const spec = this.spectators.get(def.volunteer);
      if (!spec) {
        this.revealReady(def);
        return;
      }
      this.phase = 'prep';
      const my = this.epoch;
      void this.hopToVolunteer(spec).then(() => {
        if (my !== this.epoch) return;
        this.revealReady(def);
      });
    } else {
      this.revealReady(def);
    }
  }

  private revealReady(def: BeatDef): void {
    const { pokes, gazeTargets, props } = this.d;
    this.phase = 'ready';
    if (this.revealClock < 0) this.revealClock = this.clock;
    let id: string;
    let pos: (out: Vector3) => Vector3;
    let radius: number;
    if (def.at === 'volunteer' && this.volunteer) {
      const v = this.volunteer;
      id = `${v.id}-ear`;
      const ear = this.anchor(v, 'ear');
      pos = (out) => worldPos(ear, out);
      radius = 0.04;
      this.revealOff.push(
        gazeTargets.add({ id, radius: 0.035, getWorldPosition: pos, enabled: () => this.phase === 'ready' }),
      );
    } else if (def.at && def.at !== 'volunteer') {
      const pid = def.at;
      const prop = props.prop(pid);
      id = pid;
      radius = Math.max(0.045, (prop?.radius ?? 0.035) * 1.1);
      pos = (out) => {
        props.worldPos(pid, out);
        out.y += Math.min(0.05, (prop?.radius ?? 0.03) * 1.2);
        return out;
      };
      props.setGlint(pid, 'target');
    } else {
      return;
    }
    this.revealTargetId = id;
    this.revealOff.push(
      pokes.add({
        id,
        radius,
        getWorldPosition: pos,
        enabled: () => this.phase === 'ready' && this.running,
        onHover: (h) => {
          if (h) this.safe(() => this.d.ctx.audio.sfx('uiHover', { volume: 0.4 }));
        },
        onPoke: () => this.doReveal(def),
      }),
    );
  }

  private updateReveal(def: BeatDef, dt: number): void {
    if (this.phase !== 'ready' || def.at !== 'volunteer' || !this.volunteer) return;
    // the volunteer's ear sparkles while it waits
    this.sparkleTimer -= dt;
    if (this.sparkleTimer <= 0) {
      this.sparkleTimer = 1.1;
      worldPos(this.anchor(this.volunteer, 'ear'), this.tmp);
      try {
        this.d.ctx.fx.burst('tick', this.tmp, EAR_SPARKLE);
      } catch (e) {
        console.warn('[tricks] fx failed', e);
      }
    }
  }

  private doReveal(def: BeatDef): void {
    if (this.phase !== 'ready') return;
    this.phase = 'resolving';
    const my = this.epoch;
    const { ctx, props } = this.d;
    const { audio, fx, events } = ctx;
    const reduced = ctx.settings.peek().reducedMotion;
    this.d.hints.clear();
    const id = this.revealTargetId ?? def.at ?? 'reveal';
    this.removeRevealTargets();
    props.clearGlints();
    if (!this.revealChecked) {
      this.revealChecked = true;
      this.quickReveal = this.clock - this.revealClock <= QUICK_REVEAL_S;
    }
    events.emit('revealed', { target: id });
    this.safe(() => audio.music.setMood('triumph'));
    const at = new Vector3();
    const applause = (kind: 'applause' | 'ovation', big: boolean) => {
      this.safe(() => audio.crowd(kind, 1, at));
      this.forLineup((s, i) =>
        this.later(0.08 + 0.11 * i + hash01(i + this.act) * 0.1, my, () => void s.react(big ? 'cheer' : 'clap').catch(() => {})),
      );
      ctx.rig.toWorld([0, L.tableY + 0.1, -0.42], this.tmp2);
      this.safe(() => fx.burst('confetti', this.tmp2, { count: reduced ? 18 : 60 }));
      if (!reduced) this.safe(() => fx.burst('roses', this.tmp2, { count: 14 }));
    };

    switch (def.result) {
      case 'appear': {
        const v = this.volunteer;
        if (v) this.anchor(v, 'ear').getWorldPosition(at);
        else props.homeWorld(def.prop ?? 'coin', at);
        this.safe(() => fx.burst('poof', at, { scale: 1 }));
        this.safe(() => audio.sfx('poof', { at }));
        if (def.prop) props.appearAt(def.prop, at, 0.9);
        if (v) this.safe(() => void v.react('cheer').catch(() => {}));
        applause('applause', false);
        this.speakLines(def.successLines);
        void this.wait(2.8).then(() => my === this.epoch && this.completeBeat());
        break;
      }
      case 'empty': {
        const cup = def.at && def.at !== 'volunteer' ? props.prop(def.at) : null;
        if (cup) {
          props.worldPos(cup.id, at);
          this.safe(() => void cup.animate('lift').catch(() => {}));
          this.safe(() => audio.sfx('cupLift', { at }));
        }
        this.forLineup((s, i) => this.later(0.45 + 0.12 * i, my, () => void s.react('gasp').catch(() => {})));
        this.later(0.45, my, () => audio.crowd('gasp', 0.6, at));
        this.speakLines(def.successLines);
        this.later(1.7, my, () => {
          if (cup) void cup.animate('lower').catch(() => {});
          audio.sfx('cupThunk', { at });
        });
        void this.wait(2.3).then(() => my === this.epoch && this.completeBeat());
        break;
      }
      case 'under': {
        const cup = def.at && def.at !== 'volunteer' ? props.prop(def.at) : null;
        if (cup) {
          props.worldPos(cup.id, at);
          this.safe(() => void cup.animate('lift').catch(() => {}));
          this.safe(() => audio.sfx('cupLift', { at }));
        }
        if (def.prop) props.revealLoaded(def.prop);
        this.later(0.35, my, () => {
          if (def.prop) props.centerWorld(def.prop, at);
          fx.burst('stars', at, { count: 10, scale: 0.8 });
          audio.sfx('poof', { at });
          applause('applause', true);
        });
        this.speakLines(def.successLines);
        void this.wait(3.0).then(() => my === this.epoch && this.completeBeat());
        break;
      }
      case 'rise': {
        const box = def.at && def.at !== 'volunteer' ? props.prop(def.at) : null;
        if (box) {
          props.worldPos(box.id, at);
          this.safe(() => void box.animate('lift').catch(() => {}));
          this.safe(() => audio.sfx('cupLift', { at }));
        }
        if (def.prop) {
          props.revealLoaded(def.prop);
          const watch = props.prop(def.prop);
          if (watch) this.safe(() => void watch.animate('rise').catch(() => {}));
        }
        this.safe(() => {
          this.tickLoop = audio.loop('tick', at);
        });
        this.safe(() => fx.burst('tick', at, { count: 6 }));
        this.later(0.9, my, () => applause('ovation', true));
        this.speakLines(def.successLines);
        this.later(3.6, my, () => this.stopTick());
        void this.wait(3.8).then(() => my === this.epoch && this.completeBeat());
        break;
      }
      default:
        void this.wait(1.0).then(() => my === this.epoch && this.completeBeat());
    }
  }

  private enterBow(): void {
    const { ctx } = this.d;
    const my = this.epoch;
    this.d.attention.conesVisible = false;
    this.d.attention.glyphsVisible = false;
    this.forLineup((s, i) => this.later(0.3 + 0.18 * i, my, () => void s.react('bow').catch(() => {})));
    this.later(0.2, my, () => ctx.audio.crowd('ovation', 1));
    const total = this.stars[0] + this.stars[1] + this.stars[2];
    const headline =
      total >= 9
        ? 'A FLAWLESS NIGHT OF WONDERS'
        : total >= 7
          ? 'MAGICIAN DAZZLES MIDNIGHT CROWD'
          : total >= 5
            ? 'CAFÉ CROWD LEFT GASPING'
            : 'PLUCKY MAGICIAN WINS OVER CRITIC';
    // Brock's one-liner (the paper adds the quotation mark and his byline)
    const quote =
      total >= 9
        ? 'I watched every finger. I saw nothing. Remarkable.'
        : total >= 6
          ? 'Hmph. I shall return. With a bigger notebook.'
          : 'Adequate. Mostly. Very well: bravo.';
    this.later(1.2, my, () => {
      ctx.ui.review({ headline, stars: this.stars.slice(), quote });
      this.reviewShown = true;
      ctx.audio.sfx('pageFlip');
    });
  }

  // ------------------------------------------------------------------------------------------ the verbs
  private onPinchStart(side: Side, def: BeatDef): void {
    if (this.phase !== 'active' && this.phase !== 'ready') return;
    const hands = this.d.handTracker.states;
    const pinch = hands[side].pinchPoint;
    switch (def.kind) {
      case 'show': {
        if (!def.prop || this.d.props.isBusy(def.prop)) return;
        if (this.assist) {
          this.d.props.autoLift(def.prop);
          this.rabbitPop(def.prop);
          this.onLifted(def, side);
          this.liftOk = true;
          return;
        }
        if (this.near(def.prop, pinch, CFG.pinchMagnet) && this.d.props.lift(def.prop, side)) this.onLifted(def, side);
        return;
      }
      case 'steal': {
        if (!def.prop || this.d.props.mode(def.prop) !== 'home') return;
        if (this.assist) {
          this.attemptSteal(def, 'rabbit');
          return;
        }
        if (this.near(def.prop, pinch, CFG.pinchMagnet)) this.attemptSteal(def, side);
        return;
      }
      case 'load': {
        if (!def.prop || !def.into || this.d.props.mode(def.prop) !== 'palmed') return;
        if (this.assist) {
          this.attemptLoad(def, null);
          return;
        }
        if (this.near(def.into, pinch, CFG.loadRadius)) this.attemptLoad(def, side);
        return;
      }
      case 'reveal': {
        // Assist: reveals become look + pinch
        if (this.assist && this.phase === 'ready' && this.revealTargetId && this.d.gaze.targetId === this.revealTargetId) {
          this.doReveal(def);
        } else if (this.assist && this.phase === 'ready' && def.at && def.at !== 'volunteer' && this.d.gaze.targetId === def.at) {
          this.doReveal(def);
        }
        return;
      }
      default:
        return;
    }
  }

  private onPinchEnd(side: Side, def: BeatDef): void {
    if (def.kind === 'show' && def.prop && this.liftSide === side) {
      this.d.props.release(def.prop);
      this.liftSide = null;
    }
  }

  private onLifted(def: BeatDef, side: Side): void {
    const { ctx } = this.d;
    this.liftSeen = true;
    this.liftSide = this.assist ? null : side;
    this.d.hints.progress();
    const my = this.epoch;
    if (def.prop) this.d.props.centerWorld(def.prop, this.tmp);
    this.safe(() => ctx.audio.sfx('tink', { at: this.tmp }));
    this.safe(() => ctx.audio.crowd('ooh', 0.6, this.tmp));
    this.forLineup((s, i) => this.later(0.06 + 0.1 * i, my, () => void s.react('leanIn').catch(() => {})));
    if (!this.liftLineSaid) {
      this.liftLineSaid = true;
      this.speakLines(def.successLines);
    }
  }
  private liftLineSaid = false;

  private attemptSteal(def: BeatDef, holder: Holder): void {
    if (!def.prop) return;
    const { props, seen, ctx } = this.d;
    const point = props.centerWorld(def.prop, new Vector3());
    const hit = seen.seen(point, this.d.attention.audience(this.audienceScratch), [def.prop], this.blind);
    if (hit) {
      void this.caught(hit.by, def.prop, point);
      return;
    }
    props.palm(def.prop, holder);
    if (holder === 'rabbit') this.rabbitPop(def.prop);
    this.safe(() => ctx.audio.sfx('fwip', { at: point, volume: 0.8 }));
    this.d.hints.progress();
    this.completeBeat();
  }

  private attemptLoad(def: BeatDef, side: Side | null): void {
    if (!def.prop || !def.into) return;
    const { props, seen, ctx, handTracker } = this.d;
    const audience = this.d.attention.audience(this.audienceScratch);
    const target = props.centerWorld(def.into, new Vector3());
    const exclude: PropId[] = [def.into, def.prop];
    let hit = seen.seen(target, audience, exclude, this.blind);
    let point = target;
    if (!hit && side) {
      point = handTracker.states[side].pinchPoint.clone();
      hit = seen.seen(point, audience, exclude, this.blind);
    }
    if (hit) {
      void this.caught(hit.by, def.prop, point);
      return;
    }
    props.load(def.prop, def.into);
    if (!side) this.rabbitPop(def.into);
    this.safe(() => ctx.audio.sfx('shh', { at: target }));
    this.d.hints.progress();
    this.completeBeat();
  }

  /** "I SAW THAT!" → giggles → rewind smear → back to the checkpoint. */
  private async caught(by: Spectator, prop: PropId | null, point: Vector3): Promise<void> {
    const my = ++this.epoch;
    const def = this.def;
    const { ctx, attention } = this.d;
    const { ui, audio, fx, events } = ctx;
    this.phase = 'caught';
    this.d.hints.clear();
    this.catchesThisAct++;
    this.caughtTotal++;
    this.lastCatch = { by: by.id, prop, act: this.act, beat: this.beat };
    const at = new Vector3();
    this.safe(() => by.getEyeWorldPosition(at));
    attention.alarmId = by.id;
    attention.conesVisible = true;
    this.safe(() => void by.react('pointSqueak', { target: point.clone(), intensity: 1 }).catch(() => {}));
    this.safe(() => ui.caption(CATCH_LINE, this.anchor(by, 'head'), { seconds: CFG.catchCaptionTime, style: 'shout' }));
    this.safe(() => audio.sfx('catch', { at }));
    this.safe(() => audio.say('I saw that!', { at, voice: by.kind, mood: 'accusing' }));
    this.safe(() => fx.burst('catchFlash', point, { scale: 1 }));
    this.later(0.35, my, () => audio.crowd('giggle', 0.7, at));
    let k = 0;
    for (const s of this.lineup) {
      if (s === by) continue;
      const i = k++;
      this.later(0.3 + 0.12 * i, my, () => void s.react('giggle').catch(() => {}));
    }
    events.emit('caught', { by: by.id, prop });
    await this.wait(CFG.catchCaptionTime);
    if (my !== this.epoch) return;
    void this.within(ui.rewindSmear(), CFG.rewindTime + 0.3);
    this.safe(() => audio.sfx('rewind'));
    await this.wait(CFG.rewindTime * 0.5);
    if (my !== this.epoch) return;
    this.rewindTo(def ? this.checkpointOf(def) : this.beat);
  }

  private rewindTo(beatIndex: number): void {
    const { props, attention } = this.d;
    if (this.checkpointSnap) props.restore(this.checkpointSnap);
    this.resetGadgets();
    attention.reset();
    for (const s of this.lineup) this.safe(() => void s.react('idle').catch(() => {}));
    // a volunteer that already hopped down goes straight back to its seat
    if (this.volunteer) this.seatInstantly(this.volunteer);
    this.enterBeat(beatIndex);
  }

  // ----------------------------------------------------------------------------------------- gadgets
  private updateGadgets(def: BeatDef, dt: number): void {
    const allowed = def.gadgets;
    if (!allowed) return;
    const gadgets = this.d.ctx.cafe.gadgets;
    let anyActive = false;
    let allSpent = true;
    for (let i = 0; i < GADGET_IDS.length; i++) {
      const id = GADGET_IDS[i];
      const g = gadgets[id];
      if (!g || allowed.indexOf(id) < 0) continue;
      if (this.gadgetActive[id]) anyActive = true;
      if (!this.gadgetUsed[id]) allSpent = false;
      const can = !this.gadgetUsed[id] && this.phase === 'active';
      let p = 0;
      if (can && this.d.gaze.targetId === id) p = clamp01(this.d.gaze.dwell / CFG.gadgetDwell);
      if (p !== this.dwellShown[id]) {
        this.dwellShown[id] = p;
        try {
          g.setDwell(p);
        } catch (e) {
          console.warn('[tricks] setDwell failed', e);
        }
      }
      if (can && p >= 1) this.activateGadget(id, g);
    }
    // never soft-lock: once every window here is spent (and nothing is running), the gadgets re-arm
    if (allSpent && !anyActive && this.phase === 'active') {
      this.gadgetsSpentFor += dt;
      if (this.gadgetsSpentFor > 2.0) {
        this.gadgetsSpentFor = 0;
        for (const id of allowed) {
          const g = gadgets[id];
          if (!g) continue;
          this.gadgetUsed[id] = false;
          this.safe(() => g.reset());
          this.safe(() => g.setUsed(false));
          this.safe(() => g.setAvailable(true));
        }
      }
    } else {
      this.gadgetsSpentFor = 0;
    }
  }

  private activateGadget(id: GadgetId, g: Gadget): void {
    const { audio } = this.d.ctx;
    const easy = this.d.ctx.settings.peek().easyAudience;
    this.gadgetUsed[id] = true;
    this.gadgetActive[id] = true;
    g.duration = easy ? Infinity : this.baseDuration(id, g);
    this.safe(() => g.activate());
    this.safe(() => g.setDwell(0));
    this.dwellShown[id] = 0;
    worldPos(g.focus, this.tmp);
    this.d.ctx.events.emit('gadget:activated', { gadget: id });
    this.d.hints.progress();
    const at = this.tmp;
    this.safe(() => {
      if (id === 'musicBox') {
        audio.sfx('musicBoxWind', { at });
        audio.musicBox(at, easy ? 30 : g.duration);
      } else if (id === 'candle') {
        audio.sfx('flare', { at });
      } else {
        this.fuseLoop?.stop();
        this.fuseLoop = audio.loop('fuse', at);
      }
      audio.crowd('ooh', 0.45, at);
    });
  }

  private onFireworkBurst(): void {
    const { ctx, attention } = this.d;
    ctx.rig.toWorld(L.burst, this.tmp);
    attention.bang(this.tmp);
    this.fuseLoop?.stop();
    this.fuseLoop = null;
    this.safe(() => ctx.audio.sfx('bang', { at: this.tmp }));
    this.safe(() => ctx.audio.crowd('ooh', 1, this.tmp));
  }

  private onFluster(w: Watcher): void {
    const { ctx } = this.d;
    const text = FLUSTER_LINES[this.flusterCount++ % FLUSTER_LINES.length];
    this.safe(() => ctx.audio.sfx('scribble', { at: w.target }));
    this.speak({ who: w.spec.id, text, mood: 'flustered' });
  }

  /** Track gadget activity edges; a finished gadget is dimmed (used) for the rest of the attempt. */
  private trackGadgets(): void {
    const gadgets = this.d.ctx.cafe.gadgets;
    for (let i = 0; i < GADGET_IDS.length; i++) {
      const id = GADGET_IDS[i];
      const g = gadgets[id];
      if (!g) continue;
      let active = false;
      try {
        active = g.isActive();
      } catch {
        active = false;
      }
      if (this.gadgetActive[id] && !active) {
        this.gadgetActive[id] = false;
        this.d.ctx.events.emit('gadget:ended', { gadget: id });
        this.safe(() => g.setUsed(true));
        this.safe(() => g.setAvailable(false));
        if (id === 'firework') {
          this.fuseLoop?.stop();
          this.fuseLoop = null;
        }
      } else if (!this.gadgetActive[id] && active) {
        this.gadgetActive[id] = true;
      }
    }
  }

  private applyGadgetAvailability(def: BeatDef): void {
    const gadgets = this.d.ctx.cafe.gadgets;
    for (const id of GADGET_IDS) {
      const g = gadgets[id];
      if (!g) continue;
      const available = !!def.gadgets && def.gadgets.indexOf(id) >= 0 && !this.gadgetUsed[id];
      this.safe(() => g.setAvailable(available));
      if (!available && this.dwellShown[id] !== 0) {
        this.dwellShown[id] = 0;
        this.safe(() => g.setDwell(0));
      }
    }
  }

  private resetGadgets(): void {
    const gadgets = this.d.ctx.cafe.gadgets;
    for (const id of GADGET_IDS) {
      const g = gadgets[id];
      this.gadgetUsed[id] = false;
      this.gadgetActive[id] = false;
      this.dwellShown[id] = 0;
      if (!g) continue;
      this.safe(() => g.reset());
      g.duration = this.baseDuration(id, g);
      this.safe(() => g.setUsed(false));
      this.safe(() => g.setAvailable(false));
      this.safe(() => g.setDwell(0));
    }
    this.stopLoops();
  }

  /** Easy Audience windows last until used: close them when the move is done (look back). */
  private endWindows(): void {
    this.d.attention.endWindows();
    const gadgets = this.d.ctx.cafe.gadgets;
    for (const id of GADGET_IDS) {
      const g = gadgets[id];
      if (g && this.gadgetActive[id] && !Number.isFinite(g.duration)) g.duration = 0.05;
    }
  }

  private baseDuration(id: GadgetId, g: Gadget): number {
    const v = this.capturedDuration.get(g);
    if (v !== undefined) return v;
    const d = Number.isFinite(g.duration) && g.duration > 0 ? g.duration : BASE_DURATION[id];
    this.capturedDuration.set(g, d);
    return d;
  }
  private readonly capturedDuration = new WeakMap<Gadget, number>();

  // ------------------------------------------------------------------------------------------- hints
  private updateHints(def: BeatDef): void {
    const { hints, props, ctx } = this.d;
    if (this.phase !== 'active' && this.phase !== 'ready') {
      hints.want(null, null);
      return;
    }
    const side = this.preferredSide();
    switch (def.kind) {
      case 'show':
        if (def.prop && props.mode(def.prop) === 'home') hints.want('pinch', this.propRoot(def.prop), side);
        else hints.want(null, null);
        return;
      case 'steal': {
        if (!def.prop) return;
        const anyActive = this.anyGadgetActive(def);
        const sug = def.suggest;
        if (!anyActive && sug && !this.gadgetUsed[sug]) {
          const g = ctx.cafe.gadgets[sug];
          hints.want('gaze', g ? g.focus : null);
        } else hints.want('pinch', this.propRoot(def.prop), side);
        return;
      }
      case 'load': {
        if (!def.into || !def.prop) return;
        const anyActive = this.anyGadgetActive(def);
        const sug = def.suggest ?? (def.gadgets ? def.gadgets[def.gadgets.length - 1] : undefined);
        if (!anyActive && sug && !this.gadgetUsed[sug]) {
          const g = ctx.cafe.gadgets[sug];
          hints.want('gaze', g ? g.focus : null);
        } else {
          const holder = props.palmHolder();
          hints.want('pinch', this.propRoot(def.into), holder && holder !== 'rabbit' ? holder : side);
        }
        return;
      }
      case 'lookBack':
        hints.want('gaze', this.gazeMarker);
        return;
      case 'reveal':
        if (this.phase === 'ready') {
          const target = this.revealObject(def);
          hints.want(this.assist ? 'gaze' : 'poke', target, side);
        } else hints.want(null, null);
        return;
      case 'demo':
        if (def.untilFluster && def.focus && this.beatTime > 4) {
          const s = this.spectators.get(def.focus);
          hints.want('gaze', s ? this.anchor(s, 'eyes') : null);
        } else hints.want(null, null);
        return;
      default:
        hints.want(null, null);
    }
  }

  private anyGadgetActive(def: BeatDef): boolean {
    const list = def.gadgets;
    if (!list) return false;
    for (let i = 0; i < list.length; i++) if (this.gadgetActive[list[i]]) return true;
    return false;
  }

  private preferredSide(): Side {
    const hs = this.d.handTracker.states;
    if (hs.right.tracked) return 'right';
    if (hs.left.tracked) return 'left';
    return 'right';
  }

  /** Proximity "tink" as the fingers close in on the active prop/target. */
  private updateProximityTink(def: BeatDef): void {
    if (def.kind !== 'show' && def.kind !== 'steal' && def.kind !== 'load') return;
    const id = def.kind === 'load' ? def.into : def.prop;
    if (!id) return;
    const hs = this.d.handTracker.states;
    for (let k = 0; k < 2; k++) {
      const s = hs[SIDES[k]];
      if (!s.tracked || s.pinchStrength < 0.3) {
        this.tinked[k] = false;
        continue;
      }
      if (this.tinked[k] || s.pinchStrength < 0.55) continue;
      if (this.near(id, s.pinchPoint, (def.kind === 'load' ? CFG.loadRadius : CFG.pinchMagnet) * 1.3)) {
        this.tinked[k] = true;
        this.d.props.centerWorld(id, TINK_OPTS.at);
        try {
          this.d.ctx.audio.sfx('tink', TINK_OPTS);
        } catch (e) {
          console.warn('[tricks] sfx failed', e);
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------- spectators
  private ensureSpectator(member: CastMember): Spectator | null {
    let spec = this.spectators.get(member.id);
    if (spec) return spec;
    const { ctx, gazeTargets } = this.d;
    try {
      spec = ctx.spectatorFactory.create(member.kind, {
        id: member.id,
        seed: member.seed,
        scale: member.scale,
        accent: SPECTATOR_ACCENT[member.kind],
      });
    } catch (e) {
      console.warn(`[tricks] could not create spectator ${member.id}`, e);
      return null;
    }
    const s = spec;
    s.root.name = member.id;
    this.nameAnchors(s);
    this.spectators.set(member.id, s);
    ctx.spectators.push(s);
    const head = this.anchor(s, 'head');
    gazeTargets.add({
      id: s.id,
      radius: s.headRadius || 0.03,
      getWorldPosition: (out) => worldPos(head, out),
      enabled: () => s.root.visible && this.lineup.indexOf(s) >= 0,
    });
    return s;
  }

  private nameAnchors(s: Spectator): void {
    const claimed = new Set<Object3D>();
    for (const a of ANCHORS) {
      let o: Object3D | null = null;
      try {
        o = s.getAnchor(a);
      } catch {
        o = null;
      }
      if (!o || o === s.root || claimed.has(o)) continue;
      claimed.add(o);
      if (!o.name || !o.name.startsWith(`${s.id}-`)) o.name = `${s.id}-${a}`;
    }
  }

  private anchor(s: Spectator, a: SpectatorAnchor): Object3D {
    try {
      return s.getAnchor(a) ?? s.root;
    } catch {
      return s.root;
    }
  }

  private async hopToVolunteer(spec: Spectator): Promise<void> {
    const { cafe } = this.d.ctx;
    const spot = cafe.volunteerSpot;
    const target = worldPosNow(spot, new Vector3());
    // the spot is on the velvet mat: land on its top (L.volunteerSpot assumes a thinner mat)
    this.frame.toLocal(target, this.tmp);
    if (this.tmp.y < MAT_TOP) {
      this.tmp.y = MAT_TOP;
      this.frame.toWorld(this.tmp, target);
    }
    const before = worldPosNow(spec.root, new Vector3());
    const eyesBefore = this.eyesOf(spec, new Vector3());
    this.safe(() => this.d.ctx.audio.sfx('hop', { at: before }));
    // the volunteer faces the magician, ear presented, until it hops back
    this.d.attention.pin(spec.id, 'player');
    this.away.add(spec);
    await this.within(spec.react('hopToVolunteer', { target: target.clone() }), 1.8);
    this.volunteer = spec;
    this.placeAfterHop(spec, spot, before, eyesBefore);
  }

  private async hopHome(spec: Spectator): Promise<void> {
    const seatIndex = this.actDef.cast.find((c) => c.id === spec.id)?.seat ?? 0;
    const seat = this.d.ctx.cafe.seats[seatIndex];
    if (!seat) return;
    const target = worldPosNow(seat, new Vector3());
    const before = worldPosNow(spec.root, new Vector3());
    const eyesBefore = this.eyesOf(spec, new Vector3());
    this.safe(() => this.d.ctx.audio.sfx('hop', { at: before }));
    await this.within(spec.react('hopBack', { target: target.clone() }), 1.8);
    this.placeAfterHop(spec, seat, before, eyesBefore);
    this.away.delete(spec);
    this.d.attention.unpin(spec.id);
    if (this.volunteer === spec) this.volunteer = null;
  }

  /**
   * After a hop the spectator must stand at its new spot. A module that moves the root (the stub) is re-parented
   * there (same world pose); a module that hops an inner node (the puppets: `root` never moves) is left alone;
   * a module that moved nothing at all is teleported.
   */
  private placeAfterHop(spec: Spectator, parent: Object3D, before: Vector3, eyesBefore: Vector3): void {
    const root = spec.root;
    const rootMoved = worldPosNow(root, this.tmp).distanceTo(before) > 0.02;
    const eyesMoved = this.eyesOf(spec, this.tmp2).distanceTo(eyesBefore) > 0.02;
    if (rootMoved || !eyesMoved) {
      parent.add(root);
      root.position.set(0, 0, 0);
      root.quaternion.identity();
    }
  }

  private eyesOf(spec: Spectator, out: Vector3): Vector3 {
    try {
      return spec.getEyeWorldPosition(out);
    } catch {
      return worldPosNow(spec.root, out);
    }
  }

  /** Lift a flat sight cone lying on the tabletop so the 6 mm velvet mat no longer hides it (once per spectator). */
  private liftCone(s: Spectator): void {
    if (this.coneLifted.has(s)) return;
    const cone = s.root.getObjectByName(`${s.id}-cone`);
    if (!cone || !cone.parent) return;
    if (!this.frame.rig.root.getObjectById(cone.id)) return; // not on stage yet
    this.coneLifted.add(s);
    refreshWorld(cone);
    this.frame.toLocal(worldPos(cone, this.tmp), this.tmp2);
    // only a flat cone drawn on the cloth (a cone hanging from the eyes needs nothing)
    if (Math.abs(this.tmp2.y - L.tableY) > 0.012) return;
    const dy = CONE_Y - this.tmp2.y;
    if (dy > 0) cone.position.y += dy;
  }
  private readonly coneLifted = new WeakSet<Spectator>();

  private seatInstantly(spec: Spectator): void {
    const seatIndex = this.actDef.cast.find((c) => c.id === spec.id)?.seat ?? 0;
    const seat = this.d.ctx.cafe.seats[seatIndex];
    if (seat) {
      seat.add(spec.root);
      spec.root.position.set(0, 0, 0);
      spec.root.quaternion.identity();
    }
    if (this.away.has(spec)) this.sendHome(spec, seat);
    this.d.attention.unpin(spec.id);
    this.volunteer = null;
  }

  /**
   * A spectator still standing at the volunteer spot goes home. Modules that hop an inner bone (the root never
   * moves) need the reaction itself; for root-moving modules the root was already re-seated above.
   */
  private sendHome(spec: Spectator, seat: Object3D | undefined): void {
    this.away.delete(spec);
    const target = seat ? seat.getWorldPosition(new Vector3()) : undefined;
    this.safe(() => void spec.react('hopBack', target ? { target } : undefined).catch(() => {}));
  }

  private rabbitPop(propId: PropId): void {
    const r = this.rabbit;
    if (!r || !r.root.visible) return;
    this.d.props.centerWorld(propId, this.tmp);
    const target = this.tmp.clone();
    this.safe(() => r.lookAt(target, { urgency: 1 }));
    this.safe(() => void r.react('cheer').catch(() => {}));
    this.safe(() => this.d.ctx.audio.sfx('hop', { at: target, pitch: 1.3 }));
  }

  private wobble(id: PropId): void {
    const p = this.d.props.prop(id);
    if (p) this.safe(() => void p.animate('wobble').catch(() => {}));
  }

  private forLineup(fn: (s: Spectator, i: number) => void): void {
    for (let i = 0; i < this.lineup.length; i++) fn(this.lineup[i], i);
  }

  // -------------------------------------------------------------------------------------- lines
  private speakLines(lines: Line[] | undefined): void {
    if (!lines) return;
    const my = this.epoch;
    for (const line of lines) {
      if (line.delay && line.delay > 0) this.later(line.delay, my, () => this.speak(line));
      else this.speak(line);
    }
  }

  private speak(line: Line): void {
    const spec = this.resolveSpeaker(line.who);
    if (!spec || !spec.root.visible) return;
    const { audio, ui, settings } = this.d.ctx;
    const at = new Vector3();
    this.safe(() => spec.getEyeWorldPosition(at));
    this.safe(() => audio.say(line.text, { at, voice: spec.kind, mood: line.mood }));
    if (settings.peek().captions && !line.silent) {
      this.safe(() => ui.caption(line.text, this.anchor(spec, 'head'), { seconds: 2.4, style: 'speech' }));
    }
  }

  private resolveSpeaker(who: string): Spectator | null {
    if (who === '*kit') return this.lineup.find((s) => s.kind === 'fox') ?? null;
    return this.spectators.get(who) ?? null;
  }

  // ------------------------------------------------------------------------------------- reveal targets
  private revealObject(def: BeatDef): Object3D | null {
    if (def.at === 'volunteer') return this.volunteer ? this.anchor(this.volunteer, 'ear') : null;
    if (def.at) return this.propRoot(def.at);
    return null;
  }

  private removeRevealTargets(): void {
    for (const off of this.revealOff) off();
    this.revealOff.length = 0;
    this.revealTargetId = null;
  }

  // --------------------------------------------------------------------------------------- helpers
  checkpointOf(def: BeatDef, index = this.beat): number {
    return def.checkpoint ?? index;
  }

  private updateMatFocus(def: BeatDef): void {
    const { props, attention, ctx } = this.d;
    const id = def.kind === 'load' ? def.into : def.prop;
    if (id && props.has(id)) {
      const m = props.mode(id);
      if (m === 'palmed' || m === 'loaded' || m === 'hidden') props.homeWorld(id, attention.matFocus);
      else props.centerWorld(id, attention.matFocus);
    } else this.frame.toWorld(L.mat.center, attention.matFocus);
  }

  private propRoot(id: PropId): Object3D | null {
    return this.d.props.prop(id)?.root ?? null;
  }

  private near(id: PropId, p: Vector3, radius: number): boolean {
    this.d.props.centerWorld(id, this.tmp2);
    return this.tmp2.distanceTo(p) <= radius;
  }

  private stopTick(): void {
    this.tickLoop?.stop();
    this.tickLoop = null;
  }

  private stopLoops(): void {
    this.fuseLoop?.stop();
    this.fuseLoop = null;
    this.stopTick();
  }

  /** Resolve after `seconds` of runner time (pauses with the game). */
  wait(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push({ at: this.clock + Math.max(0, seconds), resolve });
    });
  }

  private resolveWaiters(): void {
    if (this.waiters.length === 0) return;
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (w.at <= this.clock) {
        this.waiters.splice(i, 1);
        w.resolve();
      }
    }
  }

  /** Run `fn` after `seconds` if the beat (epoch) has not changed meanwhile. */
  private later(seconds: number, epoch: number, fn: () => void): void {
    void this.wait(seconds).then(() => {
      if (epoch !== this.epoch) return;
      this.safe(fn);
    });
  }

  /** Await a module promise, but never longer than `seconds` of runner time. */
  private within(p: Promise<unknown> | undefined | void, seconds: number): Promise<void> {
    const guarded = p && typeof (p as Promise<unknown>).then === 'function' ? (p as Promise<unknown>).then(() => {}, () => {}) : Promise.resolve();
    return Promise.race([guarded, this.wait(seconds)]);
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.warn('[tricks] module call failed', e);
    }
  }

  /** Mood helper for lines. */
  static mood(m: Mood | undefined): Mood {
    return m ?? 'happy';
  }
}
