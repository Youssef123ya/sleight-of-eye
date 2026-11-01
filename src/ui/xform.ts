// Allocation-free transform writes for UI meshes animated every frame. Writing an Object3D's quaternion or
// rotation makes three re-sync the other one through shared (megamorphic, double-boxing) helpers; meshes driven
// here use `matrixAutoUpdate = false` and get their local matrix written directly as plain numbers.
// Helpers take their numbers in objects (vectors, a reusable PlanarPose) rather than as loose arguments: a double
// passed to a call V8 does not inline is boxed on every call.
import type { Matrix4, Object3D, Vector3 } from '@iwsdk/core';

/** Hand `obj`'s local matrix to these helpers (three stops recomposing it from position/quaternion/scale). */
export function manualMatrix<T extends Object3D>(obj: T): T {
  obj.matrixAutoUpdate = false;
  obj.matrix.identity();
  obj.matrixWorldNeedsUpdate = true;
  return obj;
}

/** T(x, y, z) · Rz(angle) · S(sx, sy, 1). Keep one per call site and overwrite its fields. */
export interface PlanarPose {
  angle: number;
  sx: number;
  sy: number;
  x: number;
  y: number;
  z: number;
}

export function planarPose(): PlanarPose {
  return { angle: 0.5, sx: 1.5, sy: 1.5, x: 0.5, y: 0.5, z: 0.5 }; // doubles from the start (field representation)
}

/**
 * Yaw-only rigid pose: T(pos) · Ry, where Ry maps local +Z onto the unit horizontal direction (face.x, 0, face.z).
 * Column-major, as three stores it.
 */
export function setYawPose(obj: Object3D, face: Vector3, pos: Vector3): void {
  const c = face.z;
  const s = face.x;
  const e = obj.matrix.elements;
  e[0] = c;
  e[1] = 0;
  e[2] = -s;
  e[3] = 0;
  e[4] = 0;
  e[5] = 1;
  e[6] = 0;
  e[7] = 0;
  e[8] = s;
  e[9] = 0;
  e[10] = c;
  e[11] = 0;
  e[12] = pos.x;
  e[13] = pos.y;
  e[14] = pos.z;
  e[15] = 1;
  obj.matrixWorldNeedsUpdate = true;
}

/** In-plane pose: T(x, y, z) · Rz(angle) · S(sx, sy, 1). */
export function setPlanarPose(obj: Object3D, p: PlanarPose): void {
  const a = p.angle;
  const c = a === 0 ? 1 : Math.cos(a);
  const s = a === 0 ? 0 : Math.sin(a);
  const e = obj.matrix.elements;
  e[0] = c * p.sx;
  e[1] = s * p.sx;
  e[2] = 0;
  e[3] = 0;
  e[4] = -s * p.sy;
  e[5] = c * p.sy;
  e[6] = 0;
  e[7] = 0;
  e[8] = 0;
  e[9] = 0;
  e[10] = 1;
  e[11] = 0;
  e[12] = p.x;
  e[13] = p.y;
  e[14] = p.z;
  e[15] = 1;
  obj.matrixWorldNeedsUpdate = true;
}

/**
 * Rotation (row-major 3×3 `r`) with the local X axis scaled by `mirror` (±1), translated so that the local point
 * `a` (already mirrored) lands on `p`: M = [R·S | p − R·a].
 */
export function setRotPose(obj: Object3D, r: Float64Array, mirror: number, a: Vector3, p: Vector3): void {
  const e = obj.matrix.elements;
  const ax = a.x;
  const ay = a.y;
  const az = a.z;
  e[0] = r[0] * mirror;
  e[1] = r[3] * mirror;
  e[2] = r[6] * mirror;
  e[3] = 0;
  e[4] = r[1];
  e[5] = r[4];
  e[6] = r[7];
  e[7] = 0;
  e[8] = r[2];
  e[9] = r[5];
  e[10] = r[8];
  e[11] = 0;
  e[12] = p.x - (r[0] * ax + r[1] * ay + r[2] * az);
  e[13] = p.y - (r[3] * ax + r[4] * ay + r[5] * az);
  e[14] = p.z - (r[6] * ax + r[7] * ay + r[8] * az);
  e[15] = 1;
  obj.matrixWorldNeedsUpdate = true;
}

/** Row-major 3×3 rotation from a three Matrix4 (event time). */
export function rot3From(m: Matrix4, out: Float64Array): Float64Array {
  const e = m.elements;
  out[0] = e[0];
  out[1] = e[4];
  out[2] = e[8];
  out[3] = e[1];
  out[4] = e[5];
  out[5] = e[9];
  out[6] = e[2];
  out[7] = e[6];
  out[8] = e[10];
  return out;
}
