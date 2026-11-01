// Allocation-free world-space reads (G).
//
// IWSDK binds the transform of every ECS entity (the StageRig root, the scene, the player, its head and controller
// spaces) to typed-array storage through per-object accessors. Recomposing a matrix (getWorldPosition,
// getWorldQuaternion, localToWorld and worldToLocal all call updateWorldMatrix(true, …)) reads position, quaternion
// and scale through property loads that IWSDK's accessors have made megamorphic in three's shared Matrix4.compose,
// and every double read that way is boxed: measured at ~8 KB of garbage per frame for a few dozen reads.
//
// So per-frame code reads world matrices AS THEY ARE: the renderer refreshes every matrixWorld once per frame,
// StageRig.calibrateAt does it at once for the whole stage, and IWSDK's input manager flushes the XR origin (head,
// grips) before the systems run. Animated nodes are therefore at most one frame stale (13.9 ms at 72 Hz), which is
// below anything the gaze filter, the attention springs or the seen test can notice. Event-time code (a steal, a
// hop, act setup) uses the exact variants, which recompose the plain nodes below the nearest entity first.
// The arithmetic is done here on plain numbers so it never goes through three's shared (megamorphic) helpers.
import { Matrix4, Quaternion, Vector3, type Object3D } from '@iwsdk/core';
import type { StageRig, V3 } from '../layout.js';

const MAX_DEPTH = 48;
const chain: Array<Object3D | null> = new Array(MAX_DEPTH).fill(null);
const _p = new Vector3();
const _s = new Vector3();

function isEntity(o: Object3D): boolean {
  return (o as Object3D & { entityIdx?: number }).entityIdx !== undefined;
}

/** World position of `obj` from its current matrixWorld (≤ 1 frame stale for animated nodes). Per-frame safe. */
export function worldPos(obj: Object3D, out: Vector3): Vector3 {
  const e = obj.matrixWorld.elements;
  out.x = e[12];
  out.y = e[13];
  out.z = e[14];
  return out;
}

/** World rotation of `obj` from its current matrixWorld (unscaled or uniformly scaled nodes). Per-frame safe. */
export function worldQuat(obj: Object3D, out: Quaternion): Quaternion {
  obj.matrixWorld.decompose(_p, out, _s);
  return out;
}

/** Recompute the world matrix of `obj` and of its plain (non-entity) ancestors, top-down. Event-time only. */
export function refreshWorld(obj: Object3D): void {
  let n = 0;
  for (let o: Object3D | null = obj; o && n < MAX_DEPTH && !isEntity(o); o = o.parent) chain[n++] = o;
  for (let i = n - 1; i >= 0; i--) {
    const o = chain[i]!;
    chain[i] = null;
    if (o.matrixAutoUpdate) o.updateMatrix();
    if (!o.matrixWorldAutoUpdate) continue;
    const parent = o.parent;
    if (parent) o.matrixWorld.multiplyMatrices(parent.matrixWorld, o.matrix);
    else o.matrixWorld.copy(o.matrix);
  }
}

/** Exact world position (this frame's local edits included). Event-time only. */
export function worldPosNow(obj: Object3D, out: Vector3): Vector3 {
  refreshWorld(obj);
  return worldPos(obj, out);
}

/** Write a world position into `obj.position` through its parent's current world matrix. Per-frame safe. */
export function setWorldPos(obj: Object3D, world: Vector3, scratch: Matrix4): void {
  const parent = obj.parent;
  const pos = obj.position;
  if (!parent) {
    pos.x = world.x;
    pos.y = world.y;
    pos.z = world.z;
    return;
  }
  const e = scratch.copy(parent.matrixWorld).invert().elements;
  const x = world.x;
  const y = world.y;
  const z = world.z;
  pos.x = e[0] * x + e[4] * y + e[8] * z + e[12];
  pos.y = e[1] * x + e[5] * y + e[9] * z + e[13];
  pos.z = e[2] * x + e[6] * y + e[10] * z + e[14];
}

/** out = M · p for an affine matrix (allocation-free, plain arithmetic). */
function affine(e: ArrayLike<number>, x: number, y: number, z: number, out: Vector3): Vector3 {
  out.x = e[0] * x + e[4] * y + e[8] * z + e[12];
  out.y = e[1] * x + e[5] * y + e[9] * z + e[13];
  out.z = e[2] * x + e[6] * y + e[10] * z + e[14];
  return out;
}

/**
 * Rig-local ↔ world conversions straight from the rig root's world matrix (StageRig.toWorld / toLocal call
 * localToWorld / worldToLocal, which recompose the entity on every call). `sync()` once per frame picks up a
 * recalibration; it is a 16-number compare when nothing changed.
 */
export class RigFrame {
  /** Rig world rotation (yaw only). */
  readonly quat = new Quaternion();
  private readonly inv = new Matrix4();
  private readonly seen = new Matrix4();

  constructor(readonly rig: StageRig) {
    this.seen.elements[0] = Number.NaN; // force the first sync
    this.sync();
  }

  sync(): void {
    const m = this.rig.root.matrixWorld;
    if (this.seen.equals(m)) return;
    this.seen.copy(m);
    this.inv.copy(m).invert();
    m.decompose(_p, this.quat, _s);
  }

  toWorld(p: V3 | Vector3, out: Vector3): Vector3 {
    const e = this.rig.root.matrixWorld.elements;
    if (p instanceof Vector3) return affine(e, p.x, p.y, p.z, out);
    return affine(e, p[0], p[1], p[2], out);
  }

  toLocal(p: Vector3, out: Vector3): Vector3 {
    return affine(this.inv.elements, p.x, p.y, p.z, out);
  }

  /** World direction → rig-local direction (the rig is rigid: rotation only). */
  dirToLocal(d: Vector3, out: Vector3): Vector3 {
    const e = this.inv.elements;
    const x = d.x;
    const y = d.y;
    const z = d.z;
    out.x = e[0] * x + e[4] * y + e[8] * z;
    out.y = e[1] * x + e[5] * y + e[9] * z;
    out.z = e[2] * x + e[6] * y + e[10] * z;
    return out;
  }
}

const frames = new WeakMap<StageRig, RigFrame>();

/** The shared RigFrame of a rig (created on first use). */
export function rigFrame(rig: StageRig): RigFrame {
  let f = frames.get(rig);
  if (!f) {
    f = new RigFrame(rig);
    frames.set(rig, f);
  }
  return f;
}
