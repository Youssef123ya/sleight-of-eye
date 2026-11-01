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
} from '@iwsdk/core';

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

/** Cheap smooth 1D value noise in [-1, 1] (used for flame flicker; no allocation). */
export function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number) => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
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
