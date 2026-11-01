// Small math / easing / geometry helpers for the café module (no per-frame allocation in anything called per frame).
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ExtrudeGeometry,
  Float32BufferAttribute,
  LatheGeometry,
  Shape,
  Vector2,
  type Object3D,
  type Vector3,
} from '@iwsdk/core';
import type { RigFrame } from '../game/space.js';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
export const easeOutCubic = (t: number): number => 1 - (1 - t) * (1 - t) * (1 - t);
export const easeInCubic = (t: number): number => t * t * t;
export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeInOutSine = (t: number): number => 0.5 - 0.5 * Math.cos(Math.PI * t);
export function easeOutBack(t: number, s = 1.70158): number {
  const u = t - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
}
export function easeInBack(t: number, s = 1.70158): number {
  return (s + 1) * t * t * t - s * t * t;
}
/** Damped spring-ish settle: 0 → 1 with a few decaying wobbles. */
export function easeOutElastic(t: number, bounces = 3, decay = 5): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - Math.exp(-decay * t) * Math.cos(bounces * Math.PI * t);
}
/** Frame-rate independent exponential approach factor. */
export const approach = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

/** Deterministic PRNG (mulberry32) so set dressing is identical on every load. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap smooth 1D value noise in [-1, 1] (used for flame flicker; no allocation, no nested calls). */
export function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const s0 = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  const s1 = Math.sin((i + 1) * 127.1 + 311.7) * 43758.5453;
  return ((s0 - Math.floor(s0)) * 2 - 1) * (1 - u) + ((s1 - Math.floor(s1)) * 2 - 1) * u;
}

/**
 * The café's per-frame time, shared by reference with props, gadgets and FX. Inside the module, time travels in
 * these fields instead of call arguments: V8 boxes every double passed to (or returned from) a call it does not
 * inline, which is per-frame garbage.
 */
export class FrameClock {
  /** Clamped frame delta (s). */
  dt = 0;
  /** The loop's time stamp (identifies the frame; guards double updates). */
  time = Number.NaN;
  /** Café-local seconds since build. */
  now = 0;
}

// ------------------------------------------------------------------------------------- per-frame transforms
// Animated nodes of this module use matrixAutoUpdate = false and get their local matrix written here: setting
// .position/.rotation/.quaternion goes through three's change callbacks and shared helpers (Euler ↔ Quaternion sync,
// Matrix4.compose), which IWSDK's accessor-backed entity transforms make megamorphic — every double read or written
// there is boxed. Plain arithmetic on our own matrices allocates nothing. The renderer still derives matrixWorld.

/** Freeze a node's current position/rotation/scale into its matrix and stop recomposing it every frame. */
export function freezeMatrix(o: Object3D): void {
  o.updateMatrix();
  o.matrixAutoUpdate = false;
  o.matrixWorldNeedsUpdate = true;
}

/** o.matrix = T(p) · R(euler a, XYZ or YXZ order) · S(s). */
export function writeTRS(
  o: Object3D,
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  sx = 1,
  sy = 1,
  sz = 1,
  yxz = false,
): void {
  const e = o.matrix.elements;
  const a = Math.cos(ax);
  const b = Math.sin(ax);
  const c = Math.cos(ay);
  const d = Math.sin(ay);
  const f = Math.cos(az);
  const g = Math.sin(az);
  if (yxz) {
    const ce = c * f;
    const cf = c * g;
    const de = d * f;
    const df = d * g;
    e[0] = (ce + df * b) * sx;
    e[1] = a * g * sx;
    e[2] = (cf * b - de) * sx;
    e[4] = (de * b - cf) * sy;
    e[5] = a * f * sy;
    e[6] = (df + ce * b) * sy;
    e[8] = a * d * sz;
    e[9] = -b * sz;
    e[10] = a * c * sz;
  } else {
    const ae = a * f;
    const af = a * g;
    const be = b * f;
    const bf = b * g;
    e[0] = c * f * sx;
    e[1] = (af + be * d) * sx;
    e[2] = (bf - ae * d) * sx;
    e[4] = -c * g * sy;
    e[5] = (ae - bf * d) * sy;
    e[6] = (be + af * d) * sy;
    e[8] = d * sz;
    e[9] = -b * c * sz;
    e[10] = a * c * sz;
  }
  e[3] = 0;
  e[7] = 0;
  e[11] = 0;
  e[12] = px;
  e[13] = py;
  e[14] = pz;
  e[15] = 1;
  o.matrixWorldNeedsUpdate = true;
}

/** o.matrix = T(p) · R(unit quaternion q) (no scale). */
export function writeTQ(o: Object3D, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number): void {
  const e = o.matrix.elements;
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  e[0] = 1 - (yy + zz);
  e[1] = xy + wz;
  e[2] = xz - wy;
  e[3] = 0;
  e[4] = xy - wz;
  e[5] = 1 - (xx + zz);
  e[6] = yz + wx;
  e[7] = 0;
  e[8] = xz + wy;
  e[9] = yz - wx;
  e[10] = 1 - (xx + yy);
  e[11] = 0;
  e[12] = px;
  e[13] = py;
  e[14] = pz;
  e[15] = 1;
  o.matrixWorldNeedsUpdate = true;
}

/** o.matrix = T(p) · Rx(a) (hinged lids, cranks). */
export function writeRotX(o: Object3D, px: number, py: number, pz: number, a: number): void {
  const e = o.matrix.elements;
  const c = Math.cos(a);
  const s = Math.sin(a);
  e[0] = 1;
  e[1] = 0;
  e[2] = 0;
  e[4] = 0;
  e[5] = c;
  e[6] = s;
  e[8] = 0;
  e[9] = -s;
  e[10] = c;
  e[12] = px;
  e[13] = py;
  e[14] = pz;
  o.matrixWorldNeedsUpdate = true;
}

/** o.matrix = T(p) · Ry(a) (pivots, the watch's second hand). */
export function writeRotY(o: Object3D, px: number, py: number, pz: number, a: number): void {
  const e = o.matrix.elements;
  const c = Math.cos(a);
  const s = Math.sin(a);
  e[0] = c;
  e[1] = 0;
  e[2] = -s;
  e[4] = 0;
  e[5] = 1;
  e[6] = 0;
  e[8] = s;
  e[9] = 0;
  e[10] = c;
  e[12] = px;
  e[13] = py;
  e[14] = pz;
  o.matrixWorldNeedsUpdate = true;
}

/** Translation-only matrix write (empty anchors such as gadget focus points). */
export function writeT(o: Object3D, px: number, py: number, pz: number): void {
  const e = o.matrix.elements;
  e[12] = px;
  e[13] = py;
  e[14] = pz;
  o.matrixWorldNeedsUpdate = true;
}

// Affine 3×4 transforms as 12 plain doubles, column-major: basis X (0..2), Y (3..5), Z (6..8), translation (9..11).
const _la = new Float64Array(12);

/** Local transform of `o` (its own matrix when it is not auto-updated, else its current position/quaternion/scale). */
function localAffine(o: Object3D, out: Float64Array): void {
  if (!o.matrixAutoUpdate) {
    const e = o.matrix.elements;
    out[0] = e[0];
    out[1] = e[1];
    out[2] = e[2];
    out[3] = e[4];
    out[4] = e[5];
    out[5] = e[6];
    out[6] = e[8];
    out[7] = e[9];
    out[8] = e[10];
    out[9] = e[12];
    out[10] = e[13];
    out[11] = e[14];
    return;
  }
  const q = o.quaternion;
  const s = o.scale;
  const p = o.position;
  const x = q.x;
  const y = q.y;
  const z = q.z;
  const w = q.w;
  const sx = s.x;
  const sy = s.y;
  const sz = s.z;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = (xy - wz) * sy;
  out[4] = (1 - (xx + zz)) * sy;
  out[5] = (yz + wx) * sy;
  out[6] = (xz + wy) * sz;
  out[7] = (yz - wx) * sz;
  out[8] = (1 - (xx + yy)) * sz;
  out[9] = p.x;
  out[10] = p.y;
  out[11] = p.z;
}

/** out = a · b (affine; `out` may alias `b`). */
function mulAffine(a: Float64Array, b: Float64Array, out: Float64Array): void {
  const b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3], b4 = b[4], b5 = b[5];
  const b6 = b[6], b7 = b[7], b8 = b[8], b9 = b[9], b10 = b[10], b11 = b[11];
  out[0] = a[0] * b0 + a[3] * b1 + a[6] * b2;
  out[1] = a[1] * b0 + a[4] * b1 + a[7] * b2;
  out[2] = a[2] * b0 + a[5] * b1 + a[8] * b2;
  out[3] = a[0] * b3 + a[3] * b4 + a[6] * b5;
  out[4] = a[1] * b3 + a[4] * b4 + a[7] * b5;
  out[5] = a[2] * b3 + a[5] * b4 + a[8] * b5;
  out[6] = a[0] * b6 + a[3] * b7 + a[6] * b8;
  out[7] = a[1] * b6 + a[4] * b7 + a[7] * b8;
  out[8] = a[2] * b6 + a[5] * b7 + a[8] * b8;
  out[9] = a[0] * b9 + a[3] * b10 + a[6] * b11 + a[9];
  out[10] = a[1] * b9 + a[4] * b10 + a[7] * b11 + a[10];
  out[11] = a[2] * b9 + a[5] * b10 + a[8] * b11 + a[11];
}

/**
 * out = transform from `obj`'s local space into `ancestor`'s local space, from the CURRENT local transforms (exact
 * this frame, no matrixWorld recomposition, plain arithmetic: per-frame safe). The ancestor itself (e.g. the IWSDK
 * entity rig root) is never read. Returns false when `ancestor` is not above `obj`.
 */
export function affineTo(obj: Object3D, ancestor: Object3D, out: Float64Array): boolean {
  localAffine(obj, out);
  let o = obj.parent;
  let depth = 0;
  while (o && o !== ancestor) {
    if (++depth > 32) return false;
    localAffine(o, _la);
    mulAffine(_la, out, out);
    o = o.parent;
  }
  return o === ancestor;
}

/** out = m · (x, y, z). */
export function applyAffine(m: Float64Array, x: number, y: number, z: number, out: Vector3): Vector3 {
  out.x = m[0] * x + m[3] * y + m[6] * z + m[9];
  out.y = m[1] * x + m[4] * y + m[7] * z + m[10];
  out.z = m[2] * x + m[5] * y + m[8] * z + m[11];
  return out;
}

/** out = m⁻¹ · (x, y, z) for a rigid m (orthonormal basis, no scale). */
export function applyAffineInvRigid(m: Float64Array, x: number, y: number, z: number, out: Vector3): Vector3 {
  const dx = x - m[9];
  const dy = y - m[10];
  const dz = z - m[11];
  out.x = m[0] * dx + m[1] * dy + m[2] * dz;
  out.y = m[3] * dx + m[4] * dy + m[5] * dz;
  out.z = m[6] * dx + m[7] * dy + m[8] * dz;
  return out;
}

/**
 * Camera position in rig-local space, from the camera's current matrixWorld (written by the renderer / XR pose at the
 * end of the previous frame: ≤ 1 frame stale, invisible for billboards). Allocation-free.
 */
export function cameraInRig(camera: Object3D, frame: RigFrame, out: Vector3): Vector3 {
  const e = camera.matrixWorld.elements;
  out.x = e[12];
  out.y = e[13];
  out.z = e[14];
  return frame.toLocal(out, out);
}

/** Linear colour from an sRGB hex (three's ColorManagement converts). */
export function lin(hex: number): Color {
  return new Color(hex);
}

// --------------------------------------------------------------------------------------------- geometry

/** LatheGeometry from [radius, y] pairs (profile drawn bottom→top gives outward normals). */
export function lathe(profile: Array<[number, number]>, segments = 32, phiStart = 0, phiLength = TAU): BufferGeometry {
  return new LatheGeometry(profile.map(([r, y]) => new Vector2(Math.max(r, 0), y)), segments, phiStart, phiLength);
}

export function roundedRectShape(w: number, h: number, r: number): Shape {
  const s = new Shape();
  const x = -w / 2;
  const y = -h / 2;
  const rr = Math.min(r, w / 2, h / 2);
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rr);
  s.lineTo(x + w, y + h - rr);
  s.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  s.lineTo(x + rr, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - rr);
  s.lineTo(x, y + rr);
  s.quadraticCurveTo(x, y, x + rr, y);
  return s;
}

/** Box with rounded (bevelled) edges, centred at the origin: w along X, h along Y, d along Z. */
export function roundedBox(w: number, h: number, d: number, r = 0.003, seg = 2): BufferGeometry {
  const b = Math.max(0.0002, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
  const g = new ExtrudeGeometry(roundedRectShape(w - 2 * b, h - 2 * b, b * 0.6), {
    depth: Math.max(1e-4, d - 2 * b),
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: seg,
    curveSegments: 3,
  });
  g.translate(0, 0, -(d - 2 * b) / 2);
  return g;
}

/** A flat star (n points) extruded `depth` along +Y, lying in XZ, centred at the origin. */
export function starPlate(outer: number, inner: number, depth: number, points = 5): BufferGeometry {
  const s = new Shape();
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * TAU + Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Quad in the XY plane (facing +Z) with UVs mapped to an atlas rect [u0,v0,u1,v1]. */
export function atlasQuad(w: number, h: number, rect: readonly [number, number, number, number]): BufferGeometry {
  const g = new BufferGeometry();
  const [u0, v0, u1, v1] = rect;
  g.setAttribute('position', new Float32BufferAttribute([-w / 2, -h / 2, 0, w / 2, -h / 2, 0, w / 2, h / 2, 0, -w / 2, h / 2, 0], 3));
  g.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setAttribute('uv', new Float32BufferAttribute([u0, v0, u1, v0, u1, v1, u0, v1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** Set a constant UV on every vertex (so a textured material samples one flat texel). */
export function constUv<G extends BufferGeometry>(g: G, u: number, v: number): G {
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    arr[i * 2] = u;
    arr[i * 2 + 1] = v;
  }
  g.setAttribute('uv', new BufferAttribute(arr, 2));
  return g;
}

/** Add a white 3-component `color` attribute when a geometry has none (the shared surface program reads one). */
export function ensureColor<G extends BufferGeometry>(g: G): G {
  if (!g.attributes.color) g.setAttribute('color', new Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
  return g;
}

/** Scale UVs in place (for repeating textures). */
export function scaleUv<G extends BufferGeometry>(g: G, su: number, sv: number, ou = 0, ov = 0): G {
  const uv = g.attributes.uv;
  if (!uv) return g;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su + ou, uv.getY(i) * sv + ov);
  return g;
}

/**
 * Per-vertex colour pass over a merged, vertex-coloured geometry: `fn` receives the position, normal and
 * current colour (in `c`) and modifies `c` in place. Used to bake lamp/window light falloff into statics.
 */
export function bakeColors(
  g: BufferGeometry,
  fn: (px: number, py: number, pz: number, nx: number, ny: number, nz: number, c: Color) => void,
): BufferGeometry {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const col = g.attributes.color;
  if (!pos || !col) return g;
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    c.setRGB(col.getX(i), col.getY(i), col.getZ(i));
    fn(pos.getX(i), pos.getY(i), pos.getZ(i), nor ? nor.getX(i) : 0, nor ? nor.getY(i) : 1, nor ? nor.getZ(i) : 0, c);
    col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
  return g;
}

/** Dispose every geometry/material/texture under `root` that is not in `keep`. */
export function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const m = o as unknown as { geometry?: BufferGeometry; material?: { dispose(): void } | Array<{ dispose(): void }> };
    m.geometry?.dispose();
    if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose());
    else m.material?.dispose();
  });
}
