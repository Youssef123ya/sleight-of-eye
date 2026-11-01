// Hands (G): per-hand world-space state from raw XR joints, pinch edges, tracking grace and fingertip pokes
// over the PokeRegistry (with hysteresis). Either hand works everywhere; controllers fall back to the grip.
import { Vector3, type World } from '@iwsdk/core';
import { CFG } from '../config.js';
import type { GameEvents, HandState, PokeTarget, Side } from '../contracts.js';
import type { Emitter } from '../events.js';
import { PokeRegistryImpl } from './registries.js';

export const SIDES: readonly Side[] = ['left', 'right'];

const JOINT_NAMES: XRHandJoint[] = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'ring-finger-metacarpal',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',
  'pinky-finger-metacarpal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip',
];
const J_WRIST = 0;
const J_THUMB_TIP = 4;
const J_INDEX_TIP = 9;
const J_MIDDLE_PROX = 11;
const NEEDED_JOINTS = [J_WRIST, J_THUMB_TIP, J_INDEX_TIP, J_MIDDLE_PROX] as const;

export class HandStateImpl implements HandState {
  tracked = false; // with CFG.trackingGrace applied
  rawTracked = false; // this frame
  readonly pinchPoint = new Vector3();
  readonly indexTip = new Vector3();
  readonly palm = new Vector3();
  readonly wrist = new Vector3();
  readonly thumbTip = new Vector3();
  /** All 25 joints in world space (valid while tracked; controllers fill only the first). */
  readonly joints: Vector3[] = JOINT_NAMES.map(() => new Vector3());
  readonly velocity = new Vector3();
  pinching = false;
  pinchStrength = 0;
  /** Edges this frame. */
  pinchStarted = false;
  pinchEnded = false;
  isHand = false;
  /** Smoothed palm speed (m/s): "how active" this hand is. */
  speed = 0;
  /** Seconds since the raw tracking dropped (0 while tracked). */
  lostFor = 0;
  /** Seconds since the hand last moved or pinched noticeably. */
  stillFor = 0;
  readonly prevPalm = new Vector3();
  hasPrev = false;

  constructor(readonly side: Side) {}
}

interface PokeSlot {
  armed: [boolean, boolean];
  hover: [boolean, boolean];
}

export class HandTracker {
  readonly states: Record<Side, HandStateImpl> = { left: new HandStateImpl('left'), right: new HandStateImpl('right') };
  /** Last poke this tracker reported (debug). */
  lastPoke: { id: string; side: Side; t: number } | null = null;

  private readonly jointSpaces: Record<Side, XRJointSpace[] | null> = { left: null, right: null };
  private readonly spacesFor: Record<Side, XRInputSource | null> = { left: null, right: null };
  private readonly poses = new Float32Array(25 * 16);
  private readonly tmp = new Vector3();
  private readonly slots = new WeakMap<PokeTarget, PokeSlot>();
  private readonly failed = new WeakSet<PokeTarget>();
  private prevActive: Record<Side, boolean> = { left: false, right: false };
  private time = 0;

  constructor(
    private readonly world: World,
    private readonly pokes: PokeRegistryImpl,
    private readonly events: Emitter<GameEvents>,
  ) {}

  update(dt: number): void {
    this.time += dt;
    for (let k = 0; k < 2; k++) this.updateSide(SIDES[k], dt);
    this.updatePokes();
  }

  /** The tracked hand that moved most recently / most (for Brock), or null. */
  mostActive(): HandStateImpl | null {
    const l = this.states.left;
    const r = this.states.right;
    if (l.tracked && r.tracked) return l.speed > r.speed * 1.15 ? l : r;
    if (r.tracked) return r;
    if (l.tracked) return l;
    return null;
  }

  private updateSide(side: Side, dt: number): void {
    const s = this.states[side];
    const world = this.world;
    const frame = world.xrFrame;
    const ref = world.xrReferenceSpace;
    let ok = false;
    let src: XRInputSource | undefined;
    try {
      src = world.session ? world.input.xr.getPrimaryInputSource(side) : undefined;
      if (frame && ref && src) {
        if (src.hand) {
          s.isHand = true;
          ok = this.readHand(side, src, frame, ref, s);
        } else {
          s.isHand = false;
          const grip = world.player.gripSpaces[side];
          grip.getWorldPosition(s.palm);
          s.pinchPoint.copy(s.palm);
          s.indexTip.copy(s.palm);
          s.wrist.copy(s.palm);
          s.thumbTip.copy(s.palm);
          s.joints[0].copy(s.palm);
          ok = true;
        }
      }
    } catch {
      ok = false;
    }

    // tracking with grace
    if (ok) {
      s.rawTracked = true;
      s.lostFor = 0;
      if (!s.tracked) {
        s.tracked = true;
        s.hasPrev = false;
        this.events.emit('hands:trackingFound', { side });
      }
      if (s.hasPrev && dt > 0) {
        s.velocity.copy(s.palm).sub(s.prevPalm).divideScalar(dt);
        const v = s.velocity.length();
        s.speed += (Math.min(v, 3) - s.speed) * (1 - Math.exp(-8 * dt));
        s.stillFor = v > 0.12 ? 0 : s.stillFor + dt;
      }
      s.prevPalm.copy(s.palm);
      s.hasPrev = true;
    } else {
      s.rawTracked = false;
      s.lostFor += dt;
      s.speed += (0 - s.speed) * (1 - Math.exp(-4 * dt));
      if (s.tracked && s.lostFor >= CFG.trackingGrace) {
        s.tracked = false;
        this.events.emit('hands:trackingLost', { side });
      }
    }

    // pinch edges
    let start = false;
    let end = false;
    let active = false;
    try {
      if (world.session) {
        const sel = world.input.xr.getSelectState(side);
        start = sel.start;
        end = sel.end;
        active = sel.active;
      }
    } catch {
      /* no input this frame */
    }
    if (this.prevActive[side] && !active && !end) end = true; // source vanished mid-pinch
    if (!this.prevActive[side] && active && !start) start = true; // missed edge
    this.prevActive[side] = active;
    s.pinchStarted = start && s.tracked;
    s.pinchEnded = end;
    s.pinching = active;
    if (start || active) s.stillFor = 0;
    let strength = active ? 1 : 0;
    if (s.isHand && s.tracked) {
      try {
        strength = Math.max(strength, world.input.xr.visualAdapters.hand[side].getPinchStrength() || 0);
      } catch {
        /* keep binary strength */
      }
    }
    s.pinchStrength = strength;
    if (s.pinchStarted) this.events.emit('pinch:start', { side, point: s.pinchPoint });
    if (s.pinchEnded) this.events.emit('pinch:end', { side });
  }

  private readHand(side: Side, src: XRInputSource, frame: XRFrame, ref: XRReferenceSpace, s: HandStateImpl): boolean {
    const hand = src.hand!;
    if (this.spacesFor[side] !== src) {
      this.spacesFor[side] = src;
      const list: XRJointSpace[] = [];
      for (let i = 0; i < JOINT_NAMES.length; i++) {
        const sp = hand.get(JOINT_NAMES[i]);
        if (!sp) {
          this.jointSpaces[side] = null;
          return false;
        }
        list.push(sp);
      }
      this.jointSpaces[side] = list;
    }
    const spaces = this.jointSpaces[side];
    if (!spaces) return false;
    const m = this.world.player.matrixWorld;
    const batch = frame as XRFrame & { fillPoses?: (spaces: XRSpace[], base: XRSpace, out: Float32Array) => boolean };
    if (typeof batch.fillPoses === 'function') {
      if (!batch.fillPoses(spaces, ref, this.poses)) return false;
      const p = this.poses;
      for (let i = 0; i < 25; i++) {
        const x = p[i * 16 + 12];
        const y = p[i * 16 + 13];
        const z = p[i * 16 + 14];
        if (x !== x || y !== y || z !== z) return false; // NaN = untracked
        s.joints[i].set(x, y, z).applyMatrix4(m);
      }
    } else {
      for (let k = 0; k < NEEDED_JOINTS.length; k++) {
        const i = NEEDED_JOINTS[k];
        const pose = frame.getJointPose?.(spaces[i], ref);
        if (!pose) return false;
        const p = pose.transform.position;
        s.joints[i].set(p.x, p.y, p.z).applyMatrix4(m);
      }
    }
    s.wrist.copy(s.joints[J_WRIST]);
    s.thumbTip.copy(s.joints[J_THUMB_TIP]);
    s.indexTip.copy(s.joints[J_INDEX_TIP]);
    s.pinchPoint.copy(s.thumbTip).add(s.indexTip).multiplyScalar(0.5);
    s.palm.copy(s.wrist).add(s.joints[J_MIDDLE_PROX]).multiplyScalar(0.5);
    return true;
  }

  private slotFor(t: PokeTarget): PokeSlot {
    let slot = this.slots.get(t);
    if (!slot) {
      slot = { armed: [false, false], hover: [false, false] };
      this.slots.set(t, slot);
    }
    return slot;
  }

  /** Fingertip enters a target sphere → onPoke + 'poke'; it must leave radius + hysteresis before the next one. */
  private updatePokes(): void {
    const list = this.pokes.targets;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t || this.failed.has(t)) continue;
      const slot = this.slotFor(t);
      let enabled = false;
      try {
        enabled = t.enabled();
        if (enabled) t.getWorldPosition(this.tmp);
      } catch (e) {
        this.failed.add(t);
        console.warn(`[hands] poke target "${t.id}" threw; ignoring it`, e);
        continue;
      }
      const r = PokeRegistryImpl.radiusOf(t);
      for (let k = 0; k < 2; k++) {
        const side = SIDES[k];
        const s = this.states[side];
        if (!enabled || !s.tracked || !s.rawTracked) {
          slot.armed[k] = false;
          if (slot.hover[k]) {
            slot.hover[k] = false;
            this.safeHover(t, false, side);
          }
          continue;
        }
        const d = s.indexTip.distanceTo(this.tmp);
        if (d > r + CFG.pokeHysteresis) slot.armed[k] = true;
        const hover = d < r + 0.04;
        if (hover !== slot.hover[k]) {
          slot.hover[k] = hover;
          this.safeHover(t, hover, side);
        }
        if (slot.armed[k] && d < r) {
          slot.armed[k] = false;
          this.lastPoke = { id: t.id, side, t: this.time };
          try {
            t.onPoke(side);
          } catch (e) {
            console.warn(`[hands] onPoke for "${t.id}" threw`, e);
          }
          this.events.emit('poke', { targetId: t.id, side });
          if (i >= list.length || list[i] !== t) break; // the callback changed the registry
        }
      }
    }
  }

  private safeHover(t: PokeTarget, hovered: boolean, side: Side): void {
    try {
      t.onHover?.(hovered, side);
    } catch {
      /* cosmetic */
    }
  }
}
