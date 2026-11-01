// Ghost glove hint: a translucent white magician's glove (capsule fingers, puffy palm, flared cuff, stitched
// back) that mimes a pinch or a poke at a target in a loop. ONE merged geometry with two morph targets
// (0 = pinch closed, 1 = pointing) → one draw call per glove, fully animated without bones.
import {
  AdditiveBlending,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Matrix4,
  Mesh,
  MeshMatcapMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  type Object3D,
} from '@iwsdk/core';
import type { Hint, Side } from '../contracts.js';
import { mergeParts, type Part } from '../art/geometry.js';
import { makeMatcap } from '../art/matcap.js';
import { clamp01, easeInCubic, easeInOutSine, easeOutCubic, lerp, smoothstep } from './anim.js';
import type { UICtx } from './context.js';
import { manualMatrix, rot3From, setRotPose } from './xform.js';

type V = [number, number, number];
type FingerName = 'index' | 'middle' | 'ring' | 'pinky';
const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------------- rig (right hand)
// Local frame: origin at the wrist, fingers along -Z, palm facing -Y, thumb on the -X side.
interface FingerDef {
  base: V;
  l1: number;
  l2: number;
  r: number;
  splay: number;
}
const FINGERS: Record<FingerName, FingerDef> = {
  index: { base: [-0.026, 0.002, -0.086], l1: 0.039, l2: 0.034, r: 0.0114, splay: 7 },
  middle: { base: [-0.0085, 0.003, -0.091], l1: 0.042, l2: 0.037, r: 0.0118, splay: 1 },
  ring: { base: [0.009, 0.002, -0.088], l1: 0.04, l2: 0.034, r: 0.0112, splay: -5 },
  pinky: { base: [0.0255, 0.0, -0.08], l1: 0.031, l2: 0.027, r: 0.0102, splay: -12 },
};
const THUMB = { base: [-0.036, -0.012, -0.048] as V, l1: 0.045, l2: 0.038, r: 0.0124 };

interface Pose {
  curls: Record<FingerName, [number, number]>;
  thumbTip: V | 'pinch';
  thumbPole: V;
}
const POSE_OPEN: Pose = {
  curls: { index: [16, 20], middle: [40, 52], ring: [46, 58], pinky: [50, 62] },
  thumbTip: [-0.042, -0.06, -0.104],
  thumbPole: [-1, -0.2, 0.3],
};
const POSE_PINCH: Pose = {
  curls: { index: [30, 40], middle: [58, 74], ring: [64, 80], pinky: [66, 82] },
  thumbTip: 'pinch',
  thumbPole: [-1, -0.2, 0.3],
};
const POSE_POINT: Pose = {
  curls: { index: [2, 3], middle: [75, 115], ring: [78, 115], pinky: [80, 112] },
  thumbTip: [-0.016, -0.048, -0.09],
  thumbPole: [-1, -0.4, 0],
};

const vadd = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vsub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vmul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const vdot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vlen = (a: V): number => Math.hypot(a[0], a[1], a[2]);
const vnorm = (a: V): V => vmul(a, 1 / (vlen(a) || 1));

function fingerDir(curl: number, splay: number): V {
  const c = curl * DEG;
  const s = splay * DEG;
  return [-Math.cos(c) * Math.sin(s), -Math.sin(c), -Math.cos(c) * Math.cos(s)];
}

function fingerJoints(f: FingerDef, curl: [number, number]): { j1: V; tip: V; d2: V } {
  const d1 = fingerDir(curl[0], f.splay);
  const j1 = vadd(f.base, vmul(d1, f.l1));
  const d2 = fingerDir(curl[0] + curl[1], f.splay);
  return { j1, tip: vadd(j1, vmul(d2, f.l2)), d2 };
}

/** Two-bone IK: elbow position for base→target with bone lengths a, b bending toward `pole`. */
function ik2(base: V, target: V, a: number, b: number, pole: V): { knee: V; tip: V } {
  const dv = vsub(target, base);
  const d = Math.min(Math.max(vlen(dv), Math.abs(a - b) + 1e-4), a + b - 1e-4);
  const u = vnorm(dv);
  const x = (a * a - b * b + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, a * a - x * x));
  const p = vnorm(vsub(pole, vmul(u, vdot(pole, u))));
  const knee = vadd(vadd(base, vmul(u, x)), vmul(p, h));
  const tip = vadd(knee, vmul(vnorm(vsub(target, knee)), b));
  return { knee, tip };
}

const UP = new Vector3(0, 1, 0);
function capsule(a: V, b: V, r: number, color: number): Part {
  const dir = new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = Math.max(1e-4, dir.length());
  const q = new Quaternion().setFromUnitVectors(UP, dir.normalize());
  const e = new Euler().setFromQuaternion(q, 'XYZ');
  return {
    geometry: new CapsuleGeometry(r, len, 5, 12),
    color,
    position: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
    rotation: [e.x, e.y, e.z],
  };
}

const WHITE = 0xffffff;
const SEAM = 0xa7adbf;

interface PoseBuild {
  parts: Part[];
  indexTip: V;
  thumbTip: V;
  indexBase: V;
}

function buildPose(pose: Pose): PoseBuild {
  const parts: Part[] = [];
  // palm, thenar pad, knuckle ridge
  parts.push({ geometry: new SphereGeometry(1, 28, 18), color: WHITE, position: [0, 0, -0.047], scale: [0.041, 0.0162, 0.049] });
  parts.push({ geometry: new SphereGeometry(1, 16, 12), color: WHITE, position: [-0.026, -0.004, -0.04], scale: [0.019, 0.0145, 0.03] });
  parts.push({ geometry: new SphereGeometry(1, 20, 10), color: WHITE, position: [0, 0.001, -0.084], scale: [0.039, 0.0125, 0.014] });
  // wrist + a short flared cuff (closed: an open tube or a thin torus reads as a glowing hoop in ghost style)
  parts.push({
    geometry: new CapsuleGeometry(0.028, 0.012, 6, 20),
    color: WHITE,
    position: [0, 0, 0.004],
    rotation: [Math.PI / 2, 0, 0],
    scale: [1, 1, 0.62],
  });
  parts.push({
    geometry: new CylinderGeometry(0.039, 0.032, 0.022, 28, 1, false),
    color: 0xf3f4fa,
    position: [0, 0, 0.02],
    rotation: [Math.PI / 2, 0, 0],
    scale: [1, 1, 0.62],
  });
  // the three classic stitched seams on the back of the glove
  for (const x of [-0.0135, 0, 0.0135]) parts.push(capsule([x, 0.0142, -0.03], [x * 1.15, 0.0136, -0.068], 0.0017, SEAM));
  // fingers
  let indexTip: V = [0, 0, 0];
  for (const name of ['index', 'middle', 'ring', 'pinky'] as FingerName[]) {
    const f = FINGERS[name];
    const { j1, tip, d2 } = fingerJoints(f, pose.curls[name]);
    parts.push(capsule(f.base, j1, f.r, WHITE));
    parts.push(capsule(j1, tip, f.r * 0.96, WHITE));
    if (name === 'index') indexTip = vadd(tip, vmul(d2, f.r * 0.96));
  }
  // thumb (2-bone IK toward its target; in the pinch pose the pads meet behind the index tip)
  const idx = fingerJoints(FINGERS.index, pose.curls.index);
  const target: V = pose.thumbTip === 'pinch' ? vadd(idx.tip, [-0.004, -0.004, 0.018]) : pose.thumbTip;
  const { knee, tip } = ik2(THUMB.base, target, THUMB.l1, THUMB.l2, pose.thumbPole);
  parts.push(capsule(THUMB.base, knee, THUMB.r, WHITE));
  parts.push(capsule(knee, tip, THUMB.r * 0.95, WHITE));
  return { parts, indexTip, thumbTip: tip, indexBase: FINGERS.index.base };
}

export interface GloveShared {
  geometry: BufferGeometry;
  /** Pinch point (thumb/index pad midpoint) of the closed pinch pose, glove-local. */
  pinchPoint: Vector3;
  /** Index fingertip (surface) in the pointing pose, glove-local. */
  pokeTip: Vector3;
  /** Unit index direction in the pointing pose, glove-local. */
  pokeDir: Vector3;
  matcap: ReturnType<typeof makeMatcap>;
}

export function buildGloveShared(): GloveShared {
  const open = buildPose(POSE_OPEN);
  const pinch = buildPose(POSE_PINCH);
  const point = buildPose(POSE_POINT);
  const geometry = mergeParts(open.parts);
  const gPinch = mergeParts(pinch.parts);
  const gPoint = mergeParts(point.parts);
  geometry.morphAttributes.position = [gPinch.getAttribute('position'), gPoint.getAttribute('position')];
  geometry.morphAttributes.normal = [gPinch.getAttribute('normal'), gPoint.getAttribute('normal')];
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) geometry.boundingSphere.radius += 0.06; // morphs reach a little further
  for (const p of [...open.parts, ...pinch.parts, ...point.parts]) p.geometry.dispose();
  const pp = vmul(vadd(pinch.indexTip, pinch.thumbTip), 0.5);
  const idxDir = vnorm(vsub(point.indexTip, point.indexBase));
  return {
    geometry,
    pinchPoint: new Vector3(pp[0], pp[1], pp[2]),
    pokeTip: new Vector3(point.indexTip[0], point.indexTip[1], point.indexTip[2]),
    pokeDir: new Vector3(idxDir[0], idxDir[1], idxDir[2]),
    matcap: makeMatcap({
      base: 0xd5dbe8,
      key: 0xffffff,
      keyStrength: 0.4,
      rim: 0xffffff,
      rimStrength: 0.75,
      rimPower: 1.8,
      spec: 0.55,
      specSize: 0.35,
    }),
  };
}

function ghostMaterial(shared: GloveShared): MeshMatcapMaterial {
  const m = new MeshMatcapMaterial({
    matcap: shared.matcap,
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: false,
  });
  m.name = 'ui-ghost-glove';
  // rim-weighted alpha: milky body, bright readable silhouette
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `float ghostRim = 1.0 - abs(dot(normal, viewDir));
       diffuseColor.a *= mix(0.5, 1.0, pow(ghostRim, 1.25));
       #include <opaque_fragment>`,
    );
  };
  m.customProgramCacheKey = () => 'ui-ghost-glove-v1';
  return m;
}

// ------------------------------------------------------------------------------------------ ripple fx
// uR = (eased time 0..1, size m): per-frame scalars in one vector (no boxed uniform writes)
const RIPPLE_VS = /* glsl */ `
uniform vec2 uR;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uR.y;
  gl_Position = projectionMatrix * mv;
}`;
const RIPPLE_FS = /* glsl */ `
uniform vec2 uR;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float uT = uR.x;
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float rad = mix(0.12, 0.9, uT);
  float ring = exp(-pow((r - rad) / (0.08 + 0.05 * uT), 2.0));
  float core = exp(-r * r * 30.0) * (1.0 - uT) * 0.8;
  float rays = pow(max(0.0, 1.0 - abs(p.x) * 7.0), 2.0) * pow(max(0.0, 1.0 - abs(p.y)), 2.0)
             + pow(max(0.0, 1.0 - abs(p.y) * 7.0), 2.0) * pow(max(0.0, 1.0 - abs(p.x)), 2.0);
  float a = (ring * (1.0 - uT) + core + rays * (1.0 - uT) * 0.6) * (1.0 - smoothstep(0.92, 1.0, r));
  gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.45 * core), a);
  #include <colorspace_fragment>
}`;

class Ripple {
  readonly mesh: Mesh;
  private readonly mat: ShaderMaterial;
  private readonly r = new Vector2(1, 0.03);
  private t = 1;
  constructor(parent: Object3D, geo: PlaneGeometry) {
    this.mat = new ShaderMaterial({
      name: 'ui-hint-ripple',
      uniforms: { uR: { value: this.r }, uColor: { value: new Color(0xffe2a0) } },
      vertexShader: RIPPLE_VS,
      fragmentShader: RIPPLE_FS,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    this.mesh = new Mesh(geo, this.mat);
    this.mesh.name = 'ui-hint-ripple';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 41;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }
  fire(at: Vector3): void {
    this.mesh.position.copy(at);
    this.t = 0;
    this.mesh.visible = true;
  }
  update(dt: number, alpha: number): void {
    if (this.t >= 1) {
      this.mesh.visible = false;
      return;
    }
    this.t = Math.min(1, this.t + dt / 0.5);
    this.r.x = easeOutCubic(this.t);
    this.r.y = 0.03 * alpha;
  }
  dispose(): void {
    this.mesh.removeFromParent();
    this.mat.dispose();
  }
}

// ------------------------------------------------------------------------------------------ the hint
export interface ManagedHint extends Hint {
  readonly dead: boolean;
  update(dt: number, time: number): void;
  dispose(): void;
}

/**
 * Asked every frame with the hint's rig-local target: true while something the player should read first (a
 * caption bubble near it, from the eye's point of view) would sit under the ghost glove.
 */
export type HintBusy = (targetLocal: Vector3) => boolean;

const PINCH_PERIOD = 2.8;
const POKE_PERIOD = 2.4;
const STOP_FADE = 0.25;
const HOLD_FADE = 0.2; // the glove bows out this fast when a caption pops up near its target
const SETTLE = 0.3; // a new glove waits this long before its first mime (a caption cued with it wins)

const _a = new Vector3();

export class GloveHint implements ManagedHint {
  dead = false;
  private readonly mesh: Mesh;
  private readonly mat: MeshMatcapMaterial;
  private readonly ripple: Ripple;
  private readonly sideSign: number;
  /** Current glove orientation, row-major 3×3 (the mesh matrix is written directly: no quaternion syncs). */
  private readonly rot = new Float64Array(9);
  /** Poke only: constant correction turning the (mirrored) index direction onto local −Z. */
  private readonly rc = new Float64Array(9);
  private readonly target = new Vector3();
  private readonly dir = new Vector3();
  private readonly localAnchor = new Vector3(); // pinch point / fingertip in mirrored glove space
  private t = 0;
  private stopping = -1;
  private fired = false;
  /** 1 = free to mime, 0 = parked behind a caption (the mime restarts from its approach when released) */
  private holdK = 0;
  private settle = SETTLE;

  constructor(
    private readonly ctx: UICtx,
    shared: GloveShared,
    private readonly kind: 'pinch' | 'poke',
    private readonly targetObj: Object3D,
    side: Side,
    rippleGeo: PlaneGeometry,
    private readonly busy: HintBusy | null = null,
  ) {
    this.sideSign = side === 'left' ? -1 : 1;
    this.mat = ghostMaterial(shared);
    this.mesh = new Mesh(shared.geometry, this.mat);
    this.mesh.name = `ui-hint-${kind}-${side}`;
    this.mesh.renderOrder = 40;
    // the local matrix is written every frame (placeAt): rotation, the left-hand mirror on X (three flips the
    // winding for a negative determinant) and the translation that puts the pinch point / fingertip on target
    manualMatrix(this.mesh);
    this.mesh.morphTargetInfluences = [0, kind === 'poke' ? 1 : 0];
    this.mesh.visible = false;
    ctx.root.add(this.mesh);
    this.ripple = new Ripple(ctx.root, rippleGeo);
    const anchor = kind === 'pinch' ? shared.pinchPoint : shared.pokeTip;
    this.localAnchor.set(anchor.x * this.sideSign, anchor.y, anchor.z);
    const m = new Matrix4();
    if (kind === 'pinch') {
      // reach in from the player's side: fingers forward + down, thumb side tipped up a little
      const q = new Quaternion().setFromEuler(new Euler(-30 * DEG, 18 * DEG * this.sideSign, -62 * DEG * this.sideSign, 'YXZ'));
      rot3From(m.makeRotationFromQuaternion(q), this.rot);
    } else {
      // the index does not lie exactly on local −Z (splay/curl): this turns it onto −Z
      const pd = shared.pokeDir;
      const q = new Quaternion().setFromUnitVectors(new Vector3(pd.x * this.sideSign, pd.y, pd.z).normalize(), new Vector3(0, 0, -1));
      rot3From(m.makeRotationFromQuaternion(q), this.rc);
      rot3From(m.identity(), this.rot);
    }
    this.t = 0;
  }

  stop(): void {
    if (this.stopping < 0) this.stopping = 0;
  }

  update(dt: number): void {
    if (this.dead) return;
    let fade = 1;
    if (this.stopping >= 0) {
      this.stopping += dt;
      fade = 1 - clamp01(this.stopping / STOP_FADE);
      if (fade <= 0) {
        this.dead = true;
        this.mesh.visible = false;
        this.ripple.mesh.visible = false;
        return;
      }
    }
    // the target's world matrix as the renderer left it (≤ 1 frame stale): no recomposition, no allocation
    this.ctx.frame.objectLocal(this.targetObj, this.target);
    if (!Number.isFinite(this.target.x + this.target.y + this.target.z)) return;
    // a caption near the target is read first: bow out, then mime from the start once it has gone
    // (a stopping hint keeps its level: the stop fade takes it from there)
    if (this.stopping < 0) {
      if (this.settle > 0) this.settle -= dt;
      const held = this.settle > 0 || (this.busy !== null && this.busy(this.target));
      this.holdK = held ? Math.max(0, this.holdK - dt / HOLD_FADE) : Math.min(1, this.holdK + dt / HOLD_FADE);
    }
    if (this.holdK <= 0) {
      this.t = 0;
      this.fired = false;
      this.mesh.visible = false;
      this.ripple.update(dt, 1);
      return;
    }
    this.t += dt;
    const alpha = this.kind === 'pinch' ? this.updatePinch() : this.updatePoke();
    const a = alpha * fade * this.holdK;
    this.mat.opacity = 0.72 * a;
    this.mesh.visible = a > 0.01;
    this.ripple.update(dt, 1);
  }

  /** Rig-local target of the mime (debug / tests). */
  get targetLocal(): Vector3 {
    return this.target;
  }

  /** 0 = parked behind a caption, 1 = miming freely (debug / tests). */
  get holdLevel(): number {
    return this.holdK;
  }

  /** Place the glove so its local anchor lands on rig-local point `p` (writes the mesh matrix: allocation-free). */
  private placeAt(p: Vector3): void {
    setRotPose(this.mesh, this.rot, this.sideSign, this.localAnchor, p);
  }

  private updatePinch(): number {
    const u = (this.t % PINCH_PERIOD) / PINCH_PERIOD;
    const s = this.sideSign;
    const T = this.target;
    // A: approach start (up, toward the player, to the hand's side); B: hover; C: contact; D: lifted
    let close = 0;
    let alpha = 1;
    // offsets from the target (written into _a below: plain field writes, no calls with double arguments)
    let ox = 0;
    let oy = 0;
    let oz = 0;
    if (u < 0.12) {
      ox = 0.05 * s;
      oy = 0.075;
      oz = 0.09;
      alpha = smoothstep(0, 0.12, u);
    } else if (u < 0.42) {
      const k = easeInOutSine((u - 0.12) / 0.3);
      ox = lerp(0.05 * s, 0, k);
      oy = lerp(0.075, 0.012, k);
      oz = lerp(0.09, 0, k);
    } else if (u < 0.56) {
      const k = easeInOutSine((u - 0.42) / 0.14);
      close = k;
      oy = lerp(0.012, 0, k);
    } else if (u < 0.72) {
      const k = easeInOutSine((u - 0.56) / 0.16);
      close = 1;
      oy = 0.014 * k;
    } else if (u < 0.86) {
      close = 1;
      oy = 0.014;
    } else {
      const k = easeInOutSine((u - 0.86) / 0.14);
      close = 1 - k;
      ox = 0.03 * s * k;
      oy = 0.014 + 0.05 * k;
      oz = 0.07 * k;
      alpha = 1 - k;
    }
    _a.x = T.x + ox;
    _a.y = T.y + oy;
    _a.z = T.z + oz;
    if (u >= 0.56 && !this.fired) {
      this.fired = true;
      this.ripple.fire(T);
    } else if (u < 0.56) this.fired = false;
    this.mesh.morphTargetInfluences![0] = close;
    this.placeAt(_a);
    return alpha;
  }

  private updatePoke(): number {
    const u = (this.t % POKE_PERIOD) / POKE_PERIOD;
    const T = this.target;
    // poke direction: from a resting hand position on the player's side toward the target
    const d = this.dir;
    let dx = T.x - 0.13 * this.sideSign;
    let dy = T.y + 0.2;
    let dz = T.z + 0.08;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-3) {
      dx = 0;
      dy = 0;
      dz = -1;
    } else {
      dx /= len;
      dy /= len;
      dz /= len;
    }
    d.x = dx;
    d.y = dy;
    d.z = dz;
    this.orientAlong();
    let dist: number;
    let alpha = 1;
    if (u < 0.12) {
      dist = -0.11;
      alpha = smoothstep(0, 0.12, u);
    } else if (u < 0.46) dist = lerp(-0.11, -0.016, easeOutCubic((u - 0.12) / 0.34));
    else if (u < 0.52) dist = lerp(-0.016, 0.008, easeInCubic((u - 0.46) / 0.06));
    else if (u < 0.62) dist = lerp(0.008, -0.02, easeOutCubic((u - 0.52) / 0.1));
    else if (u < 0.8) dist = -0.02;
    else {
      const k = easeInOutSine((u - 0.8) / 0.2);
      dist = lerp(-0.02, -0.1, k);
      alpha = 1 - k;
    }
    if (u >= 0.5 && !this.fired) {
      this.fired = true;
      this.ripple.fire(T);
    } else if (u < 0.5) this.fired = false;
    _a.x = T.x + d.x * dist;
    _a.y = T.y + d.y * dist;
    _a.z = T.z + d.z * dist;
    this.placeAt(_a);
    return alpha;
  }

  /**
   * Orientation whose (mirrored) index direction points along the unit `dir`, palm facing down:
   * rot = basis(x, y, z) · rc with z = −dir, x = up × z, y = z × x. Plain arithmetic (per frame).
   */
  private orientAlong(): void {
    const d = this.dir;
    const zx = -d.x;
    const zy = -d.y;
    const zz = -d.z;
    // x = (0, 1, 0) × z
    let xx = zz;
    let xz = -zx;
    const xl = Math.sqrt(xx * xx + xz * xz);
    if (xl < 1e-3) {
      xx = 1;
      xz = 0;
    } else {
      xx /= xl;
      xz /= xl;
    }
    // y = z × x  (x has no y component)
    const yx = zy * xz;
    const yy = zz * xx - zx * xz;
    const yz = -zy * xx;
    const c = this.rc;
    const r = this.rot;
    // basis matrix B = [x y z] (columns), row-major rows: (xx, yx, zx), (0, yy, zy), (xz, yz, zz)
    r[0] = xx * c[0] + yx * c[3] + zx * c[6];
    r[1] = xx * c[1] + yx * c[4] + zx * c[7];
    r[2] = xx * c[2] + yx * c[5] + zx * c[8];
    r[3] = yy * c[3] + zy * c[6];
    r[4] = yy * c[4] + zy * c[7];
    r[5] = yy * c[5] + zy * c[8];
    r[6] = xz * c[0] + yz * c[3] + zz * c[6];
    r[7] = xz * c[1] + yz * c[4] + zz * c[7];
    r[8] = xz * c[2] + yz * c[5] + zz * c[8];
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mat.dispose();
    this.ripple.dispose();
  }
}
