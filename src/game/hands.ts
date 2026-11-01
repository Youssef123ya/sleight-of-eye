// Hands (G): per-hand world-space state from raw XR joints, pinch edges, tracking grace and fingertip pokes
// over the PokeRegistry (with hysteresis). Either hand works everywhere; controllers fall back to the grip.
import { Vector3, type World } from '@iwsdk/core';
import { CFG } from '../config.js';
import type { GameEvents, HandState, PokeTarget, Side } from '../contracts.js';
import type { Emitter } from '../events.js';
import { copyV, setV } from './math.js';
import { PokeRegistryImpl } from './registries.js';
import { worldPos } from './space.js';

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
  /** Cached world centre: re-read every frame while a fingertip is near, else every POKE_REFRESH frames. */
  readonly pos: Vector3;
  age: number;
}

/** A fingertip farther than radius + this from a target's cached centre cannot hover or poke it this frame. */
const POKE_NEAR = 0.2;
const POKE_REFRESH = 12;

export class HandTracker {
  readonly states: Record<Side, HandStateImpl> = { left: new HandStateImpl('left'), right: new HandStateImpl('right') };
  /** Last poke this tracker reported (debug). */
  lastPoke: { id: string; side: Side; t: number } | null = null;

  private readonly jointSpaces: Record<Side, XRJointSpace[] | null> = { left: null, right: null };
  private readonly spacesFor: Record<Side, XRInputSource | null> = { left: null, right: null };
  private readonly poses = new Float32Array(25 * 16);
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
          worldPos(world.player.gripSpaces[side], s.palm);
          copyV(s.pinchPoint, s.palm);
          copyV(s.indexTip, s.palm);
          copyV(s.wrist, s.palm);
          copyV(s.thumbTip, s.palm);
          copyV(s.joints[0], s.palm);
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
        const vx = (s.palm.x - s.prevPalm.x) / dt;
        const vy = (s.palm.y - s.prevPalm.y) / dt;
        const vz = (s.palm.z - s.prevPalm.z) / dt;
        setV(s.velocity, vx, vy, vz);
        const v = Math.sqrt(vx * vx + vy * vy + vz * vz);
        s.speed += (Math.min(v, 3) - s.speed) * (1 - Math.exp(-8 * dt));
        s.stillFor = v > 0.12 ? 0 : s.stillFor + dt;
      }
      copyV(s.prevPalm, s.palm);
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
      const e = m.elements;
      for (let i = 0; i < 25; i++) {
        const x = p[i * 16 + 12];
        const y = p[i * 16 + 13];
        const z = p[i * 16 + 14];
        if (x !== x || y !== y || z !== z) return false; // NaN = untracked
        // player space → world (the XR origin is rigid; plain arithmetic, no three helpers per joint)
        const j = s.joints[i];
        j.x = e[0] * x + e[4] * y + e[8] * z + e[12];
        j.y = e[1] * x + e[5] * y + e[9] * z + e[13];
        j.z = e[2] * x + e[6] * y + e[10] * z + e[14];
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
    const w = copyV(s.wrist, s.joints[J_WRIST]);
    const th = copyV(s.thumbTip, s.joints[J_THUMB_TIP]);
    const ix = copyV(s.indexTip, s.joints[J_INDEX_TIP]);
    setV(s.pinchPoint, (th.x + ix.x) * 0.5, (th.y + ix.y) * 0.5, (th.z + ix.z) * 0.5);
    const mp = s.joints[J_MIDDLE_PROX];
    setV(s.palm, (w.x + mp.x) * 0.5, (w.y + mp.y) * 0.5, (w.z + mp.z) * 0.5);
    return true;
  }

  private slotFor(t: PokeTarget): PokeSlot {
    let slot = this.slots.get(t);
    if (!slot) {
      slot = { armed: [false, false], hover: [false, false], pos: new Vector3(), age: -1 };
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
      const r = PokeRegistryImpl.radiusOf(t);
      let enabled = false;
      try {
        enabled = t.enabled();
        // targets barely move: re-read the centre when a fingertip is close to it (or now and then)
        if (enabled && (slot.age < 0 || slot.age >= POKE_REFRESH || this.tipNear(slot.pos, r + POKE_NEAR))) {
          t.getWorldPosition(slot.pos);
          slot.age = 0;
        } else if (enabled) slot.age++;
        else slot.age = -1;
      } catch (e) {
        this.failed.add(t);
        console.warn(`[hands] poke target "${t.id}" threw; ignoring it`, e);
        continue;
      }
      const tx = slot.pos.x;
      const ty = slot.pos.y;
      const tz = slot.pos.z;
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
        const tip = s.indexTip;
        const dx = tip.x - tx;
        const dy = tip.y - ty;
        const dz = tip.z - tz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
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

  /** Is a tracked index fingertip within `dist` of `p`? */
  private tipNear(p: Vector3, dist: number): boolean {
    const d2 = dist * dist;
    for (let k = 0; k < 2; k++) {
      const s = this.states[SIDES[k]];
      if (!s.tracked) continue;
      const tip = s.indexTip;
      const dx = tip.x - p.x;
      const dy = tip.y - p.y;
      const dz = tip.z - p.z;
      if (dx * dx + dy * dy + dz * dz < d2) return true;
    }
    return false;
  }

  private safeHover(t: PokeTarget, hovered: boolean, side: Side): void {
    try {
      t.onHover?.(hovered, side);
    } catch {
      /* cosmetic */
    }
  }
}
