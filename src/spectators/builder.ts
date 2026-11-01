// Skinned felt-puppet builder. Author primitives in PUPPET space (metres, origin at the feet, +Y up, +Z faces the
// player), bind each primitive rigidly to one bone, and merge everything into ONE indexed geometry per material
// slot ('felt' | 'gloss'). A whole puppet is then two SkinnedMeshes = two draw calls, yet every ear, eyelid,
// pupil, arm and tail can still move on its own. Bones have identity rotation in the bind pose.
import {
  Bone,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Matrix4,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';

export type Slot = 'felt' | 'gloss';
export type V3 = [number, number, number];

export interface BoneDef {
  name: string;
  parent: number; // -1 = root-level bone (added to the puppet's stage group)
  pos: V3; // bind position in puppet space
}

export interface PartXf {
  p?: V3;
  r?: V3; // XYZ euler, radians
  s?: number | V3;
  /** Vertex-colour brightness multiplier for this part (e.g. eye whites under the darker gloss matcap). */
  gain?: number;
}

interface Part {
  slot: Slot;
  bone: number;
  geo: BufferGeometry;
  color: number;
  gain: number;
  m: Matrix4;
}

const _e = new Euler();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();
const _a = new Vector3();
const _b = new Vector3();

export class PuppetBuilder {
  readonly bones: BoneDef[] = [];
  private readonly index = new Map<string, number>();
  private readonly parts: Part[] = [];
  /** Global vertex-colour gain (matcap + ACES darken felt slightly). */
  gain = 1;
  /** Extra gain for light felt colours, scaled by luminance (creams and whites read beige otherwise). */
  lightLift = 0;

  bone(name: string, parent: string | null, pos: V3): this {
    if (this.index.has(name)) throw new Error(`[spectators] duplicate bone "${name}"`);
    const pi = parent === null ? -1 : this.boneIndex(parent);
    this.index.set(name, this.bones.length);
    this.bones.push({ name, parent: pi, pos: [pos[0], pos[1], pos[2]] });
    return this;
  }

  boneIndex(name: string): number {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`[spectators] unknown bone "${name}"`);
    return i;
  }

  bonePos(name: string): V3 {
    return this.bones[this.boneIndex(name)].pos;
  }

  /** Add a primitive bound to `bone`. The geometry is consumed (disposed) by `build()`. */
  add(slot: Slot, bone: string, geo: BufferGeometry, color: number, xf: PartXf = {}): this {
    const m = new Matrix4();
    const p = xf.p ?? [0, 0, 0];
    const r = xf.r ?? [0, 0, 0];
    _p.set(p[0], p[1], p[2]);
    _q.setFromEuler(_e.set(r[0], r[1], r[2], 'XYZ'));
    const s = xf.s ?? 1;
    if (typeof s === 'number') _s.setScalar(s);
    else _s.set(s[0], s[1], s[2]);
    m.compose(_p, _q, _s);
    this.parts.push({ slot, bone: this.boneIndex(bone), geo, color, gain: xf.gain ?? 1, m });
    return this;
  }

  felt(bone: string, geo: BufferGeometry, color: number, xf?: PartXf): this {
    return this.add('felt', bone, geo, color, xf);
  }

  gloss(bone: string, geo: BufferGeometry, color: number, xf?: PartXf): this {
    return this.add('gloss', bone, geo, color, xf);
  }

  build(): { felt: BufferGeometry; gloss: BufferGeometry } {
    const out = { felt: this.merge('felt'), gloss: this.merge('gloss') };
    const seen = new Set<BufferGeometry>();
    for (const p of this.parts) {
      if (seen.has(p.geo)) continue;
      seen.add(p.geo);
      p.geo.dispose();
    }
    this.parts.length = 0;
    return out;
  }

  private merge(slot: Slot): BufferGeometry {
    const list: { g: BufferGeometry; bone: number; color: number; gain: number }[] = [];
    let nv = 0;
    let ni = 0;
    for (const p of this.parts) {
      if (p.slot !== slot) continue;
      const g = p.geo.clone();
      g.applyMatrix4(p.m);
      if (!g.attributes.normal) g.computeVertexNormals();
      const count = g.attributes.position.count;
      nv += count;
      ni += g.index ? g.index.count : count;
      list.push({ g, bone: p.bone, color: p.color, gain: p.gain });
    }
    const pos = new Float32Array(nv * 3);
    const nor = new Float32Array(nv * 3);
    const col = new Float32Array(nv * 3);
    const skinIndex = new Uint16Array(nv * 4);
    const skinWeight = new Float32Array(nv * 4);
    const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    let vo = 0;
    let io = 0;
    for (const { g, bone, color, gain } of list) {
      const P = g.attributes.position;
      const N = g.attributes.normal;
      const count = P.count;
      _c.setHex(color);
      const lum = 0.2126 * _c.r + 0.7152 * _c.g + 0.0722 * _c.b;
      const k = slot === 'felt' ? this.gain * gain * (1 + this.lightLift * lum) : gain;
      for (let i = 0; i < count; i++) {
        const v = vo + i;
        pos[v * 3] = P.getX(i);
        pos[v * 3 + 1] = P.getY(i);
        pos[v * 3 + 2] = P.getZ(i);
        nor[v * 3] = N.getX(i);
        nor[v * 3 + 1] = N.getY(i);
        nor[v * 3 + 2] = N.getZ(i);
        col[v * 3] = _c.r * k;
        col[v * 3 + 1] = _c.g * k;
        col[v * 3 + 2] = _c.b * k;
        skinIndex[v * 4] = bone;
        skinWeight[v * 4] = 1;
      }
      if (g.index) {
        const I = g.index;
        for (let i = 0; i < I.count; i++) idx[io++] = I.getX(i) + vo;
      } else {
        for (let i = 0; i < count; i++) idx[io++] = vo + i;
      }
      vo += count;
      g.dispose();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('normal', new BufferAttribute(nor, 3));
    geo.setAttribute('color', new BufferAttribute(col, 3));
    geo.setAttribute('skinIndex', new BufferAttribute(skinIndex, 4));
    geo.setAttribute('skinWeight', new BufferAttribute(skinWeight, 4));
    geo.setIndex(new BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

/** Fresh bone hierarchy for one instance (bind pose: identity rotations, puppet-space positions). */
export function makeBones(defs: BoneDef[]): Bone[] {
  const bones = defs.map((d) => {
    const b = new Bone();
    b.name = d.name;
    return b;
  });
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    if (d.parent >= 0) {
      const p = defs[d.parent].pos;
      bones[i].position.set(d.pos[0] - p[0], d.pos[1] - p[1], d.pos[2] - p[2]);
      bones[d.parent].add(bones[i]);
    } else {
      bones[i].position.set(d.pos[0], d.pos[1], d.pos[2]);
    }
  }
  return bones;
}

export function makeBoneInverses(defs: BoneDef[]): Matrix4[] {
  return defs.map((d) => new Matrix4().makeTranslation(-d.pos[0], -d.pos[1], -d.pos[2]));
}

// ------------------------------------------------------------------------------------------ primitives
export const prim = {
  sphere: (w = 16, h = 12) => new SphereGeometry(1, w, h),
  /** Front-facing partial sphere shell (unit radius) around +Y: eyelids, pupils, caps. */
  shell: (thetaStart: number, thetaLength: number, w = 18, h = 6, phiPad = 0.45) =>
    new SphereGeometry(1, w, h, -phiPad, Math.PI + 2 * phiPad, thetaStart, thetaLength),
  /** Full-turn cap around +Y (theta 0..thetaLength). */
  cap: (thetaLength: number, w = 18, h = 5) => new SphereGeometry(1, w, h, 0, Math.PI * 2, 0, thetaLength),
  capsule: (r: number, len: number, cap = 5, rad = 12) => new CapsuleGeometry(r, len, cap, rad),
  cone: (r: number, h: number, seg = 14) => new ConeGeometry(r, h, seg, 1),
  cyl: (rt: number, rb: number, h: number, seg = 18, open = false) => new CylinderGeometry(rt, rb, h, seg, 1, open),
  torus: (R: number, r: number, rs = 8, ts = 28, arc = Math.PI * 2) => new TorusGeometry(R, r, rs, ts, arc),
  box: (w: number, h: number, d: number) => new BoxGeometry(w, h, d),
};

/** Turn a closed primitive inside out (inner walls of the top hat). */
export function flipInside<G extends BufferGeometry>(g: G): G {
  const idx = g.index;
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, a);
    }
  }
  const n = g.attributes.normal;
  if (n) for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return g;
}

// ------------------------------------------------------------------------------------------ vector helpers
export function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
export function add(a: V3, b: V3, s = 1): V3 {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}
export function mirror(v: V3): V3 {
  return [-v[0], v[1], v[2]];
}
/** Point on an axis-aligned ellipsoid surface along `dir` from its centre, pushed inwards by `inset`. */
export function onEllipsoid(c: V3, r: V3, dir: V3, inset = 0): V3 {
  const d = norm(dir);
  const t = 1 / Math.sqrt((d[0] / r[0]) ** 2 + (d[1] / r[1]) ** 2 + (d[2] / r[2]) ** 2) - inset;
  return [c[0] + d[0] * t, c[1] + d[1] * t, c[2] + d[2] * t];
}
/** XYZ euler that turns a +Y-up primitive to point along `dir` (with an optional twist around it). */
export function alignY(dir: V3, twist = 0): V3 {
  _a.set(0, 1, 0);
  _b.set(dir[0], dir[1], dir[2]).normalize();
  _q.setFromUnitVectors(_a, _b);
  if (twist) _q.multiply(new Quaternion().setFromAxisAngle(_a, twist));
  _e.setFromQuaternion(_q, 'XYZ');
  return [_e.x, _e.y, _e.z];
}
/** `p + R(euler) * off`: place a sub-part in another part's local frame (notebook pages, pencil tips). */
export function offset(p: V3, r: V3, off: V3): V3 {
  _q.setFromEuler(_e.set(r[0], r[1], r[2], 'XYZ'));
  _a.set(off[0], off[1], off[2]).applyQuaternion(_q);
  return [p[0] + _a.x, p[1] + _a.y, p[2] + _a.z];
}
/** XYZ euler of Ry(yaw)·Rx(pitch): tilt about X first, then turn about Y (eyelids facing an eye's direction). */
export function yawPitch(yaw: number, pitch: number): V3 {
  _q.setFromAxisAngle(_a.set(0, 1, 0), yaw);
  _q.multiply(new Quaternion().setFromAxisAngle(_b.set(1, 0, 0), pitch));
  _e.setFromQuaternion(_q, 'XYZ');
  return [_e.x, _e.y, _e.z];
}
/** XYZ euler that turns a +Z-facing primitive (pupil caps, discs) to face `dir`. */
export function alignZ(dir: V3): V3 {
  _a.set(0, 0, 1);
  _b.set(dir[0], dir[1], dir[2]).normalize();
  _q.setFromUnitVectors(_a, _b);
  _e.setFromQuaternion(_q, 'XYZ');
  return [_e.x, _e.y, _e.z];
}
