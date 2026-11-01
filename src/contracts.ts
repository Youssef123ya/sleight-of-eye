// Shared module contracts (owned by the lead). Agents IMPLEMENT these; they never edit this file.
// If you need something that is missing, implement the closest thing locally and report the request.
import type { Object3D, Signal, Vector3, World } from '@iwsdk/core';
import type { Emitter } from './events.js';
import type { StageRig } from './layout.js';

export type Side = 'left' | 'right';

// ---------------------------------------------------------------------------------------------- settings
export interface Settings {
  easyAudience: boolean; // no gadget time windows, narrower sight cones
  assist: boolean; // pinch anywhere performs the beat's action; reveals become look + pinch
  compactStage: boolean; // gadgets come in and up (limited neck movement)
  captions: boolean; // show captions for spectator lines (default true)
  reducedMotion: boolean; // calmer confetti, no camera-adjacent bursts
}
export const DEFAULT_SETTINGS: Settings = {
  easyAudience: false,
  assist: false,
  compactStage: false,
  captions: true,
  reducedMotion: false,
};

// ---------------------------------------------------------------------------------------- registries (G)
/** Anything that can be poked with an index fingertip (reveal targets, plaques). Implemented by game/hands. */
export interface PokeTarget {
  id: string;
  /** World-space centre of the poke sphere. */
  getWorldPosition(out: Vector3): Vector3;
  /** Sphere radius in metres (the registry enforces >= CFG.pokeRadiusMin). */
  radius: number;
  enabled(): boolean;
  onHover?(hovered: boolean, side: Side): void;
  onPoke(side: Side): void;
}
export interface PokeRegistry {
  add(target: PokeTarget): () => void;
}

/** Anything the gaze can focus (spectator heads, gadgets, props, plaques). Implemented by game/gaze. */
export interface GazeTarget {
  id: string;
  getWorldPosition(out: Vector3): Vector3;
  /** Physical radius in metres; converted to an angular radius from the eye each frame. */
  radius: number;
  enabled(): boolean;
}
export interface GazeTargetRegistry {
  add(target: GazeTarget): () => void;
}

/** Read-only gaze state other modules may sample each frame. */
export interface GazeState {
  /** World point the player is looking at (on a target, the tabletop, or a far backdrop). */
  readonly point: Vector3;
  /** World position of the gaze ray origin (eyes). */
  readonly origin: Vector3;
  /** Unit world direction of the filtered gaze ray. */
  readonly direction: Vector3;
  /** Focused target id, or null. */
  readonly targetId: string | null;
  /** Seconds the current target has been focused. */
  readonly dwell: number;
  /** 'eyes' when a real eye-gaze input source drives it, else 'head'. */
  readonly source: 'head' | 'eyes';
}

/** Read-only per-hand state (world space) sampled each frame. Implemented by game/hands. */
export interface HandState {
  readonly side: Side;
  readonly tracked: boolean;
  readonly pinchPoint: Vector3; // midpoint of thumb tip and index tip
  readonly indexTip: Vector3;
  readonly palm: Vector3;
  readonly pinching: boolean;
  readonly pinchStrength: number; // 0..1
}

// ----------------------------------------------------------------------------------------- spectators (S)
export type SpectatorKind = 'fox' | 'magpie' | 'badger' | 'rabbit';
export type ReactionName =
  | 'leanIn' // "ooh", curious
  | 'gasp' // shock at an empty mat
  | 'topple' // falls off the seat and climbs back
  | 'pointSqueak' // "I SAW THAT!" accusation
  | 'clap' // applause
  | 'cheer' // big applause / standing ovation hop
  | 'giggle' // at the magician's expense after a catch
  | 'blushScribble' // Brock flustered: blushes, scribbles in notebook (lasts until `react('idle')` or duration)
  | 'hopToVolunteer' // hop from seat to the volunteer spot (game provides the target via `setSeat`)
  | 'hopBack' // hop from the volunteer spot back to its seat
  | 'bow'
  | 'idle'; // cancel a looping reaction
export type SpectatorAnchor = 'eyes' | 'head' | 'ear' | 'hand' | 'notebook' | 'beak' | 'hatTop';

export interface Spectator {
  readonly id: string;
  readonly kind: SpectatorKind;
  /** Root object; origin at the feet, faces the player (+Z of the rig) by default. Parent it where you like. */
  readonly root: Object3D;
  /** Head-sphere radius in metres (used as its gaze-target radius). */
  readonly headRadius: number;
  /** Eye midpoint in world space. */
  getEyeWorldPosition(out: Vector3): Vector3;
  /** Unit world direction the head currently faces (what the seen-test uses). */
  getLookDirection(out: Vector3): Vector3;
  getAnchor(name: SpectatorAnchor): Object3D;
  /**
   * Where to look (world point) — null returns to an idle glance. Head turns are springy with anticipation and
   * overshoot; `urgency` 0..1 scales speed (1 = snap for a firework bang). Eyes lead the head slightly.
   */
  lookAt(target: Vector3 | null, opts?: { urgency?: number }): void;
  /** Play a reaction; resolves when it ends (looping reactions resolve when cancelled with 'idle'). */
  react(name: ReactionName, opts?: { intensity?: number; duration?: number; target?: Vector3 }): Promise<void>;
  /** Freeze all motion (pause / "Hold it!"). */
  setFrozen(frozen: boolean): void;
  /** Eye-glyph above the head: 'open' = watching the mat, 'closed' = distracted, 'hidden'. */
  setEyeGlyph(state: 'open' | 'closed' | 'hidden'): void;
  /** Sight-cone wedge on the cloth in the spectator's colour; `alarm` flashes it red (the catcher). */
  setSightCone(visible: boolean, alarm?: boolean): void;
  /** Width of the drawn cone (CFG.sightHalfAngle, or sightHalfAngleEasy in Easy Audience). */
  setSightHalfAngle(deg: number): void;
  /** Visual state for eye contact (kit looks back warmly) / flustered (Brock blushes). */
  setMood(mood: 'neutral' | 'eyeContact' | 'flustered' | 'suspicious'): void;
  update(dt: number, time: number): void;
  dispose(): void;
}
export interface SpectatorFactory {
  create(kind: SpectatorKind, opts: { id: string; seed?: number; accent?: number; scale?: number }): Spectator;
}

// ---------------------------------------------------------------------------------- environment & props (E)
export type PropId = 'coin' | 'ball' | 'cupLeft' | 'cupMid' | 'cupRight' | 'watch' | 'cupcake';
export type GadgetId = 'musicBox' | 'candle' | 'firework';
export type Glint = 'none' | 'gold' | 'blue' | 'target';
export type PropAnimation =
  | 'lift' // cups: lift up and tilt to show what's under; cupcake box: lid opens
  | 'lower' // cups: back down
  | 'wobble' // attention wiggle
  | 'appear' // pop into existence with a squash
  | 'vanish' // shrink-pop out
  | 'rise'; // watch rises out of the cupcake frosting, ticking

export interface Prop {
  readonly id: PropId;
  /** Movable object; the game moves it (lift/carry/return) by writing its world pose. */
  readonly root: Object3D;
  /** Rough bounding radius in metres (grab + gaze). */
  readonly radius: number;
  /** Magpies are drawn to shiny props. */
  readonly shiny: boolean;
  /** True for objects that block sight lines when they sit over something (cups, cupcake box lid). */
  readonly cover: boolean;
  /** Rig-local home mark on the mat (from layout). */
  readonly home: Vector3;
  setGlint(glint: Glint): void;
  setVisible(visible: boolean): void;
  animate(anim: PropAnimation): Promise<void>;
  /** Snap back to the home mark, upright, visible, no glint. */
  reset(): void;
}

export interface Gadget {
  readonly id: GadgetId;
  readonly root: Object3D;
  /** World point spectators look at while it performs (flame, dancer, burst). */
  readonly focus: Object3D;
  /** Gaze target radius in metres. */
  readonly gazeRadius: number;
  /** How long its effect holds attention (seconds); Infinity when Easy Audience keeps it going. */
  duration: number;
  /** Start its show: music box opens + dancer spins, candle flares, firework fuse lights then bangs. */
  activate(): void;
  isActive(): boolean;
  /** 0..1 remaining-time meter (shrinking flame, fuse, fading sparks). */
  progress(): number;
  /** 0..1 dwell ring fill while the player is looking at it. */
  setDwell(p: number): void;
  /** Dim + disable after use within an attempt. */
  setUsed(used: boolean): void;
  setAvailable(available: boolean): void;
  /** Firework only: fires when the burst happens. */
  onBurst?: (() => void) | null;
  reset(): void;
  update(dt: number, time: number): void;
}

export type FxKind = 'poof' | 'confetti' | 'roses' | 'sparks' | 'catchFlash' | 'stars' | 'tick';
export interface Fx {
  burst(kind: FxKind, at: Vector3, opts?: { scale?: number; count?: number }): void;
  update(dt: number, time: number): void;
}

export interface Cafe {
  readonly root: Object3D;
  readonly props: Record<PropId, Prop>;
  readonly gadgets: Record<GadgetId, Gadget>;
  /** 5 seat anchors on the riser (layout.seats); origin at the feet, facing the player. */
  readonly seats: Object3D[];
  /** Where a volunteer stands on the mat for an ear reveal. */
  readonly volunteerSpot: Object3D;
  /** Parent for posters (UI fills it); faces the player. */
  readonly posterWall: Object3D;
  /** Parents for the plaques (UI fills them); tilted toward the player. */
  readonly plaqueAnchors: Object3D[];
  /** Apply the compact-stage gadget layout. */
  setCompact(compact: boolean): void;
  /** 0..1 warm lamp pool brightness (dims during the curtain). */
  setLamp(level: number): void;
  update(dt: number, time: number): void;
}
export interface EnvironmentFactory {
  build(world: World, rig: StageRig): Promise<{ cafe: Cafe; fx: Fx }>;
}

// ---------------------------------------------------------------------------------------------- audio (A)
export type SfxName =
  | 'tink' // proximity cue as fingers close on a prop
  | 'fwip' // palm
  | 'shh' // load
  | 'poof' // reveal
  | 'cupThunk'
  | 'cupLift'
  | 'flare' // candle
  | 'fuse' // firework fuse (looping until bang)
  | 'bang'
  | 'musicBoxWind'
  | 'uiHover'
  | 'uiPress'
  | 'catch' // record-scratch-ish sting
  | 'rewind'
  | 'star'
  | 'curtain'
  | 'pageFlip'
  | 'scribble'
  | 'hop'
  | 'tick'; // watch ticking
export type Mood = 'happy' | 'surprised' | 'accusing' | 'curious' | 'flustered' | 'proud';
export type CrowdKind = 'ooh' | 'gasp' | 'giggle' | 'applause' | 'ovation';

export interface AudioEngine {
  /** Create/resume the AudioContext. Must be called from a user gesture (Enter button). */
  unlock(): Promise<void>;
  sfx(name: SfxName, opts?: { at?: Vector3; volume?: number; pitch?: number }): void;
  /** Start/stop a looping sfx (fuse, tick) — returns a stop handle. */
  loop(name: 'fuse' | 'tick', at?: Vector3): { stop(): void };
  /** Animalese speech for a spectator: blips follow the text's syllables, pitch by voice. */
  say(text: string, opts: { at: Vector3; voice: SpectatorKind; mood?: Mood }): void;
  crowd(kind: CrowdKind, intensity: number, at?: Vector3): void;
  music: {
    start(): void;
    stop(fadeSeconds?: number): void;
    setMood(mood: 'calm' | 'tense' | 'triumph'): void;
  };
  /** Music box melody from the gadget's position (plays for `seconds`, Infinity = until stopped). */
  musicBox(at: Vector3, seconds: number): { stop(): void };
  /** Tension pad level: number of spectators currently watching the mat. 0 → silent. */
  setTension(watchers: number, maxWatchers: number): void;
  /** Keep positional audio aligned with the head (call every frame with the camera). */
  setListener(head: Object3D): void;
  setPaused(paused: boolean): void;
  setMasterVolume(v: number): void;
}

// ------------------------------------------------------------------------------------------------- UI (U)
export type PlaqueAction = 'retry' | 'easy' | 'assist' | 'recenter' | 'exit';
export interface Hint {
  stop(): void;
}
export interface ReviewData {
  headline: string;
  stars: number[]; // per act, 0..3
  quote: string; // Brock's one-liner
}
export interface PosterData {
  title: string;
  date: string;
  stars: number;
}

export interface UI {
  /** Soft warm spotlight decal at the gaze point on the cloth (null hides it). */
  spotlight(point: Vector3 | null, strength?: number): void;
  /** Caption / speech bubble above an object (billboards to the player). */
  caption(text: string, at: Object3D, opts?: { seconds?: number; style?: 'speech' | 'shout' | 'whisper' }): void;
  /** Ghost hand miming a pinch / poke at a target; ghost gaze trail from the gaze point to a target. */
  hintPinch(target: Object3D, side?: Side): Hint;
  hintPoke(target: Object3D, side?: Side): Hint;
  hintGaze(from: () => Vector3, to: Object3D): Hint;
  clearHints(): void;
  /** Plaques on the table edge; poke them to emit `plaque` events. `toggles` lights easy/assist. */
  setPlaques(actions: PlaqueAction[], toggles: Partial<Record<'easy' | 'assist', boolean>>): void;
  /** Theatre curtain between acts / on pause. */
  curtain(state: 'open' | 'closed'): Promise<void>;
  titleCard(title: string, subtitle?: string): Promise<void>;
  /** Brief rewind smear over the stage after a catch. */
  rewindSmear(): Promise<void>;
  /** Newspaper at the bow; null hides it (new show / Retry). */
  review(data: ReviewData | null): void;
  posters(list: PosterData[]): void;
  /** "Hold it!" style banner (tracking loss, pause). */
  banner(text: string | null): void;
  update(dt: number, time: number): void;
}
export interface UIFactory {
  build(
    world: World,
    rig: StageRig,
    deps: { pokes: PokeRegistry; gazeTargets: GazeTargetRegistry; events: Emitter<GameEvents>; cafe: Cafe | null },
  ): Promise<UI>;
}

/** The 2D landing page (index.html) controller. */
export interface Landing {
  /** Called once the world exists; wires the Enter button to `onEnter`. */
  mount(opts: { onEnter: () => void; settings: Signal<Settings>; xrSupported: boolean }): void;
  /** Show/hide the page (hidden while immersive). */
  setVisible(visible: boolean): void;
}

// --------------------------------------------------------------------------------------------- game events
export interface GameEvents {
  'gaze:focus': { targetId: string | null };
  'gaze:dwell': { targetId: string; seconds: number };
  'pinch:start': { side: Side; point: Vector3 };
  'pinch:end': { side: Side };
  poke: { targetId: string; side: Side };
  'prop:lifted': { prop: PropId; side: Side };
  'prop:returned': { prop: PropId };
  'prop:palmed': { prop: PropId; side: Side };
  'prop:loaded': { prop: PropId; into: PropId };
  caught: { by: string; prop: PropId | null };
  revealed: { target: string };
  'gadget:activated': { gadget: GadgetId };
  'gadget:ended': { gadget: GadgetId };
  'beat:start': { act: number; beat: number; kind: string };
  'beat:complete': { act: number; beat: number };
  'act:complete': { act: number; stars: number };
  plaque: { action: PlaqueAction };
  'session:visibility': { state: 'visible' | 'blurred' | 'hidden' | 'non-immersive' };
  'hands:trackingLost': { side: Side };
  'hands:trackingFound': { side: Side };
}

/** Everything the game core wires together; passed to modules that need several services. */
export interface GameContext {
  world: World;
  rig: StageRig;
  events: Emitter<GameEvents>;
  settings: Signal<Settings>;
  gaze: GazeState;
  hands: Record<Side, HandState>;
  pokes: PokeRegistry;
  gazeTargets: GazeTargetRegistry;
  cafe: Cafe;
  fx: Fx;
  spectators: Spectator[];
  spectatorFactory: SpectatorFactory;
  audio: AudioEngine;
  ui: UI;
}

/** Test/debug hooks exposed as `window.__app` (implemented by game/debug.ts). */
export interface DebugApi {
  /**
   * Snapshot for tests. Fields the scenarios rely on: act, beat, beatKind, caught (count), palmed (PropId|null),
   * loaded (Record<PropId,PropId>), gazeTarget, watchers, calibrated, paused, stars (per act), revealTarget,
   * settings, spectators [{id, rule, watchingMat}].
   */
  debugState(): Record<string, unknown>;
  skipTo(act: number, beat?: number): void;
  setSettings(patch: Partial<Settings>): void;
  /** Angles (deg) of key objects relative to the current head forward, for FoV checks. */
  fovReport(): Array<{ id: string; yaw: number; pitch: number; distance: number }>;
}
declare global {
  interface Window {
    __app?: DebugApi;
  }
}
