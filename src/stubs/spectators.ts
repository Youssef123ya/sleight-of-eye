// Stub spectators (G): merged felt puppets (body + springy head, 2–3 draw calls each) implementing the full
// Spectator contract so the game runs before the real module (src/spectators) lands.
import {
  CanvasTexture,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  Vector3,
  BoxGeometry,
  type BufferGeometry,
  type Material,
  type Object3D,
} from '@iwsdk/core';
import { mergeParts, type Part } from '../art/geometry.js';
import { feltMaterial } from '../art/matcap.js';
import { PAL, SPECTATOR_ACCENT } from '../art/palette.js';
import { CFG } from '../config.js';
import type {
  ReactionName,
  Spectator,
  SpectatorAnchor,
  SpectatorFactory,
  SpectatorKind,
} from '../contracts.js';

type V3 = [number, number, number];

interface Blueprint {
  headRadius: number;
  neckY: number; // head centre height above the feet
  body: Part[];
  head: Part[];
  eyes: V3; // head-local eye midpoint
  anchors: Partial<Record<SpectatorAnchor, { on: 'body' | 'head'; at: V3 }>>;
}

const sphere = (r: number, w = 18, h = 14) => new SphereGeometry(r, w, h);

function eyePair(x: number, y: number, z: number, r: number): Part[] {
  const parts: Part[] = [];
  for (const s of [-1, 1]) {
    parts.push({ geometry: sphere(r, 16, 12), color: 0xfbf7ee, position: [s * x, y, z] });
    parts.push({ geometry: sphere(r * 0.62, 14, 10), color: 0x15110f, position: [s * x, y, z + r * 0.62] });
    parts.push({ geometry: sphere(r * 0.2, 8, 6), color: 0xffffff, position: [s * x - r * 0.2, y + r * 0.28, z + r * 1.08] });
  }
  return parts;
}

function fox(): Blueprint {
  const O = PAL.foxOrange;
  const C = PAL.foxCream;
  const D = PAL.foxDark;
  return {
    headRadius: 0.033,
    neckY: 0.098,
    body: [
      { geometry: new CapsuleGeometry(0.025, 0.03, 6, 14), color: O, position: [0, 0.045, 0] },
      { geometry: sphere(0.019), color: C, position: [0, 0.044, 0.014], scale: [1, 1.25, 0.65] },
      { geometry: sphere(0.011, 10, 8), color: D, position: [-0.012, 0.008, 0.012] },
      { geometry: sphere(0.011, 10, 8), color: D, position: [0.012, 0.008, 0.012] },
      { geometry: new CapsuleGeometry(0.007, 0.02, 4, 8), color: O, position: [-0.027, 0.05, 0.006], rotation: [0.3, 0, 0.35] },
      { geometry: new CapsuleGeometry(0.007, 0.02, 4, 8), color: O, position: [0.027, 0.05, 0.006], rotation: [0.3, 0, -0.35] },
      { geometry: new ConeGeometry(0.016, 0.062, 12), color: O, position: [0.012, 0.045, -0.04], rotation: [-2.1, 0, -0.5] },
      { geometry: sphere(0.01, 10, 8), color: C, position: [0.022, 0.07, -0.062] },
    ],
    head: [
      { geometry: sphere(0.033, 22, 16), color: O, scale: [1.06, 0.94, 1] },
      { geometry: sphere(0.017, 16, 12), color: C, position: [0, -0.011, 0.024], scale: [1, 0.72, 1.15] },
      { geometry: sphere(0.0055, 8, 6), color: D, position: [0, -0.007, 0.043] },
      { geometry: new ConeGeometry(0.013, 0.032, 10), color: O, position: [-0.021, 0.032, -0.002], rotation: [0, 0, 0.38] },
      { geometry: new ConeGeometry(0.013, 0.032, 10), color: O, position: [0.021, 0.032, -0.002], rotation: [0, 0, -0.38] },
      { geometry: new ConeGeometry(0.0075, 0.016, 8), color: D, position: [-0.026, 0.044, 0.0], rotation: [0, 0, 0.38] },
      { geometry: new ConeGeometry(0.0075, 0.016, 8), color: D, position: [0.026, 0.044, 0.0], rotation: [0, 0, -0.38] },
      ...eyePair(0.0135, 0.007, 0.024, 0.0095),
    ],
    eyes: [0, 0.007, 0.03],
    anchors: {
      ear: { on: 'head', at: [0.022, 0.03, 0] },
      hand: { on: 'body', at: [0.03, 0.05, 0.012] },
      notebook: { on: 'body', at: [0, 0.05, 0.035] },
      beak: { on: 'head', at: [0, -0.006, 0.044] },
      hatTop: { on: 'head', at: [0, 0.05, 0] },
    },
  };
}

function magpie(): Blueprint {
  const B = PAL.magpieBlack;
  const W = PAL.magpieWhite;
  const T = PAL.magpieTeal;
  return {
    headRadius: 0.027,
    neckY: 0.1,
    body: [
      { geometry: sphere(0.027), color: B, position: [0, 0.052, -0.004], scale: [1, 1.3, 1.1] },
      { geometry: sphere(0.019), color: W, position: [0, 0.048, 0.012], scale: [1, 1.3, 0.7] },
      { geometry: sphere(0.016), color: T, position: [-0.024, 0.056, -0.006], scale: [0.45, 1.25, 1.2] },
      { geometry: sphere(0.016), color: T, position: [0.024, 0.056, -0.006], scale: [0.45, 1.25, 1.2] },
      { geometry: new BoxGeometry(0.018, 0.006, 0.07), color: T, position: [0, 0.03, -0.05], rotation: [0.6, 0, 0] },
      { geometry: new CylinderGeometry(0.0025, 0.0025, 0.022, 6), color: 0x3a3a40, position: [-0.008, 0.011, 0.004] },
      { geometry: new CylinderGeometry(0.0025, 0.0025, 0.022, 6), color: 0x3a3a40, position: [0.008, 0.011, 0.004] },
    ],
    head: [
      { geometry: sphere(0.026, 20, 14), color: B },
      { geometry: new ConeGeometry(0.0075, 0.032, 10), color: 0x4a4a52, position: [0, -0.004, 0.036], rotation: [Math.PI / 2, 0, 0] },
      { geometry: sphere(0.01, 10, 8), color: W, position: [-0.017, -0.01, 0.006], scale: [0.6, 1, 1] },
      { geometry: sphere(0.01, 10, 8), color: W, position: [0.017, -0.01, 0.006], scale: [0.6, 1, 1] },
      ...eyePair(0.0125, 0.006, 0.017, 0.0085),
    ],
    eyes: [0, 0.006, 0.022],
    anchors: {
      ear: { on: 'head', at: [0.02, 0.016, 0] },
      hand: { on: 'body', at: [0.026, 0.055, 0.008] },
      notebook: { on: 'body', at: [0, 0.05, 0.035] },
      beak: { on: 'head', at: [0, -0.004, 0.05] },
      hatTop: { on: 'head', at: [0, 0.04, 0] },
    },
  };
}

function badger(): Blueprint {
  const G = PAL.badgerGrey;
  const W = PAL.badgerWhite;
  const K = PAL.badgerBlack;
  return {
    headRadius: 0.036,
    neckY: 0.118,
    body: [
      { geometry: new CapsuleGeometry(0.033, 0.042, 6, 16), color: G, position: [0, 0.056, 0] },
      { geometry: sphere(0.022), color: W, position: [0, 0.062, 0.018], scale: [1, 1.35, 0.6] },
      { geometry: new ConeGeometry(0.008, 0.014, 8), color: PAL.clothRed, position: [-0.007, 0.088, 0.03], rotation: [0, 0, Math.PI / 2] },
      { geometry: new ConeGeometry(0.008, 0.014, 8), color: PAL.clothRed, position: [0.007, 0.088, 0.03], rotation: [0, 0, -Math.PI / 2] },
      { geometry: new BoxGeometry(0.036, 0.046, 0.007), color: PAL.notebookRed, position: [0.004, 0.058, 0.04], rotation: [-0.35, 0.1, 0] },
      { geometry: new BoxGeometry(0.03, 0.04, 0.002), color: PAL.chalk, position: [0.004, 0.059, 0.0445], rotation: [-0.35, 0.1, 0] },
      { geometry: new CapsuleGeometry(0.008, 0.022, 4, 8), color: G, position: [-0.03, 0.06, 0.02], rotation: [1.0, 0, 0.5] },
      { geometry: new CapsuleGeometry(0.008, 0.022, 4, 8), color: G, position: [0.03, 0.06, 0.02], rotation: [1.0, 0, -0.5] },
      { geometry: sphere(0.012, 10, 8), color: K, position: [-0.014, 0.008, 0.012] },
      { geometry: sphere(0.012, 10, 8), color: K, position: [0.014, 0.008, 0.012] },
    ],
    head: [
      { geometry: sphere(0.035, 22, 16), color: W, scale: [1.05, 0.95, 1.05] },
      { geometry: sphere(0.012, 12, 10), color: K, position: [-0.014, 0.006, 0.008], scale: [0.85, 1.6, 2.5] },
      { geometry: sphere(0.012, 12, 10), color: K, position: [0.014, 0.006, 0.008], scale: [0.85, 1.6, 2.5] },
      { geometry: sphere(0.02, 14, 10), color: G, position: [0, -0.008, -0.012], scale: [1.6, 1.1, 1.2] },
      { geometry: sphere(0.015, 14, 10), color: W, position: [0, -0.01, 0.028], scale: [1, 0.85, 1.2] },
      { geometry: sphere(0.006, 8, 6), color: K, position: [0, -0.006, 0.046] },
      { geometry: sphere(0.009, 10, 8), color: K, position: [-0.027, 0.026, -0.006], scale: [1, 1, 0.5] },
      { geometry: sphere(0.009, 10, 8), color: K, position: [0.027, 0.026, -0.006], scale: [1, 1, 0.5] },
      { geometry: new TorusGeometry(0.0115, 0.0018, 6, 20), color: PAL.gold, position: [0.0145, 0.007, 0.036] },
      ...eyePair(0.0145, 0.007, 0.027, 0.0085),
    ],
    eyes: [0, 0.007, 0.032],
    anchors: {
      ear: { on: 'head', at: [0.027, 0.028, 0] },
      hand: { on: 'body', at: [0.03, 0.06, 0.03] },
      notebook: { on: 'body', at: [0.004, 0.058, 0.045] },
      beak: { on: 'head', at: [0, -0.006, 0.048] },
      hatTop: { on: 'head', at: [0, 0.05, 0] },
    },
  };
}

function rabbit(): Blueprint {
  const W = PAL.rabbitWhite;
  const H = PAL.hatBlack;
  return {
    headRadius: 0.025,
    neckY: 0.078,
    body: [
      { geometry: new CylinderGeometry(0.03, 0.026, 0.05, 20, 1, true), color: H, position: [0, 0.025, 0] },
      { geometry: new CylinderGeometry(0.026, 0.026, 0.004, 20), color: H, position: [0, 0.002, 0] },
      { geometry: new CylinderGeometry(0.044, 0.044, 0.004, 24), color: H, position: [0, 0.05, 0] },
      { geometry: new CylinderGeometry(0.0305, 0.0305, 0.008, 20, 1, true), color: PAL.clothRed, position: [0, 0.042, 0] },
      { geometry: sphere(0.022), color: W, position: [0, 0.055, 0], scale: [1, 0.8, 1] },
      { geometry: sphere(0.007, 8, 6), color: W, position: [-0.017, 0.058, 0.016] },
      { geometry: sphere(0.007, 8, 6), color: W, position: [0.017, 0.058, 0.016] },
    ],
    head: [
      { geometry: sphere(0.024, 20, 14), color: W },
      { geometry: new CapsuleGeometry(0.0065, 0.04, 4, 10), color: W, position: [-0.01, 0.042, -0.004], rotation: [0, 0, 0.18] },
      { geometry: new CapsuleGeometry(0.0065, 0.04, 4, 10), color: W, position: [0.01, 0.042, -0.004], rotation: [0, 0, -0.18] },
      { geometry: new CapsuleGeometry(0.0032, 0.03, 4, 8), color: 0xf3a6b5, position: [-0.01, 0.043, -0.0005], rotation: [0, 0, 0.18] },
      { geometry: new CapsuleGeometry(0.0032, 0.03, 4, 8), color: 0xf3a6b5, position: [0.01, 0.043, -0.0005], rotation: [0, 0, -0.18] },
      { geometry: sphere(0.004, 8, 6), color: 0xf3a6b5, position: [0, -0.004, 0.024] },
      ...eyePair(0.011, 0.005, 0.017, 0.0075),
    ],
    eyes: [0, 0.005, 0.022],
    anchors: {
      ear: { on: 'head', at: [0.01, 0.06, 0] },
      hand: { on: 'body', at: [0.018, 0.06, 0.02] },
      notebook: { on: 'body', at: [0, 0.06, 0.03] },
      beak: { on: 'head', at: [0, -0.004, 0.026] },
      hatTop: { on: 'body', at: [0, 0.052, 0] },
    },
  };
}

const BLUEPRINTS: Record<SpectatorKind, () => Blueprint> = { fox, magpie, badger, rabbit };

// shared resources (built lazily, once)
let feltShared: Material | null = null;
const geoCache = new Map<SpectatorKind, { body: BufferGeometry; head: BufferGeometry; blush: BufferGeometry }>();
let glyphOpen: SpriteMaterial | null = null;
let glyphClosed: SpriteMaterial | null = null;

function felt(): Material {
  if (!feltShared) feltShared = feltMaterial();
  return feltShared;
}

function geometriesFor(kind: SpectatorKind, bp: Blueprint) {
  let g = geoCache.get(kind);
  if (!g) {
    const r = bp.headRadius;
    g = {
      body: mergeParts(bp.body),
      head: mergeParts(bp.head),
      blush: mergeParts([
        { geometry: sphere(r * 0.24, 10, 8), color: PAL.blush, position: [-r * 0.62, -r * 0.18, r * 0.72], scale: [1, 0.6, 0.35] },
        { geometry: sphere(r * 0.24, 10, 8), color: PAL.blush, position: [r * 0.62, -r * 0.18, r * 0.72], scale: [1, 0.6, 0.35] },
      ]),
    };
    geoCache.set(kind, g);
  }
  return g;
}

function glyphTexture(open: boolean): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d')!;
  g.translate(48, 50);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  // badge
  g.fillStyle = open ? 'rgba(255,244,220,0.95)' : 'rgba(36,26,18,0.75)';
  g.beginPath();
  g.arc(0, 0, 40, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = open ? '#241a12' : 'rgba(255,244,220,0.8)';
  g.stroke();
  if (open) {
    // almond eye with a big pupil
    g.beginPath();
    g.moveTo(-28, 0);
    g.quadraticCurveTo(0, -26, 28, 0);
    g.quadraticCurveTo(0, 26, -28, 0);
    g.fillStyle = '#ffffff';
    g.fill();
    g.lineWidth = 5;
    g.strokeStyle = '#241a12';
    g.stroke();
    g.beginPath();
    g.arc(0, 0, 11, 0, Math.PI * 2);
    g.fillStyle = '#241a12';
    g.fill();
    g.beginPath();
    g.arc(-4, -4, 3.5, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
  } else {
    // closed: a sleepy curve with lashes
    g.strokeStyle = 'rgba(255,244,220,0.9)';
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(-26, -4);
    g.quadraticCurveTo(0, 18, 26, -4);
    g.stroke();
    g.lineWidth = 4;
    for (const x of [-16, 0, 16]) {
      g.beginPath();
      g.moveTo(x, x === 0 ? 8 : 5);
      g.lineTo(x * 1.25, 18);
      g.stroke();
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function glyphMaterial(open: boolean): SpriteMaterial {
  if (open && glyphOpen) return glyphOpen;
  if (!open && glyphClosed) return glyphClosed;
  const m = new SpriteMaterial({ map: glyphTexture(open), transparent: true, depthWrite: false, toneMapped: false });
  if (open) glyphOpen = m;
  else glyphClosed = m;
  return m;
}

interface Reaction {
  name: ReactionName;
  t: number;
  d: number;
  resolve: () => void;
  from: Vector3;
  to: Vector3;
  hop: boolean;
}

const TMP = new Vector3();
const TMP_Q = new Quaternion();

function wrapPi(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

class StubSpectator implements Spectator {
  readonly root = new Group();
  readonly headRadius: number;
  private readonly body = new Group();
  private readonly neck = new Group();
  private readonly head = new Group();
  private readonly blush: Mesh;
  private readonly glyph: Sprite;
  private readonly cone: Mesh;
  private readonly coneMat: MeshBasicMaterial;
  private readonly anchors = new Map<SpectatorAnchor, Object3D>();
  private readonly eyes: Object3D;
  private readonly target = new Vector3();
  private hasTarget = false;
  private urgency = 0.5;
  private frozen = false;
  private yaw = 0;
  private yawV = 0;
  private pitch = 0;
  private pitchV = 0;
  private bodyYaw = 0;
  private bodyYawV = 0;
  private roll = 0;
  private reaction: Reaction | null = null;
  private mood: 'neutral' | 'eyeContact' | 'flustered' | 'suspicious' = 'neutral';
  private time = 0;
  private readonly seed: number;
  private readonly scale: number;
  private readonly accent: number;
  private readonly eyeY: number;
  private glyphState: 'open' | 'closed' | 'hidden' = 'hidden';

  constructor(
    readonly kind: SpectatorKind,
    readonly id: string,
    opts: { seed?: number; accent?: number; scale?: number },
  ) {
    const bp = BLUEPRINTS[kind]();
    const geo = geometriesFor(kind, bp);
    this.scale = opts.scale ?? 1;
    this.seed = opts.seed ?? 1;
    this.accent = opts.accent ?? SPECTATOR_ACCENT[kind];
    this.headRadius = bp.headRadius * this.scale;
    this.root.name = id;
    this.root.add(this.body);
    this.body.scale.setScalar(this.scale);
    const bodyMesh = new Mesh(geo.body, felt());
    bodyMesh.name = `${id}-body`;
    this.body.add(bodyMesh);
    this.neck.position.set(0, bp.neckY, 0);
    this.body.add(this.neck);
    this.neck.add(this.head);
    this.head.rotation.order = 'YXZ';
    const headMesh = new Mesh(geo.head, felt());
    headMesh.name = `${id}-headMesh`;
    this.head.add(headMesh);
    this.blush = new Mesh(geo.blush, felt());
    this.blush.visible = false;
    this.head.add(this.blush);
    this.eyeY = bp.neckY + bp.eyes[1];

    // anchors
    const mk = (name: SpectatorAnchor, parent: Object3D, at: V3) => {
      const o = new Group();
      o.name = `${id}-${name}`;
      o.position.set(at[0], at[1], at[2]);
      parent.add(o);
      this.anchors.set(name, o);
      return o;
    };
    this.eyes = mk('eyes', this.head, bp.eyes);
    mk('head', this.head, [0, 0, 0]);
    for (const [name, a] of Object.entries(bp.anchors) as Array<[SpectatorAnchor, { on: 'body' | 'head'; at: V3 }]>) {
      mk(name, a.on === 'head' ? this.head : this.body, a.at);
    }

    // eye glyph (shape-coded: open almond eye vs closed lashes)
    this.glyph = new Sprite(glyphMaterial(true));
    this.glyph.name = `${id}-glyph`;
    this.glyph.scale.setScalar(0.026);
    this.glyph.position.set(0, bp.neckY + bp.headRadius + 0.03, 0);
    this.glyph.visible = false;
    this.glyph.renderOrder = 30;
    this.body.add(this.glyph);

    // sight cone (apex at the eyes, opening along the head's +Z)
    const len = 0.42;
    const half = (CFG.sightHalfAngle * Math.PI) / 180;
    const coneGeo = new ConeGeometry(Math.tan(half) * len, len, 28, 1, true);
    coneGeo.rotateX(-Math.PI / 2);
    coneGeo.translate(0, 0, len / 2);
    this.coneMat = new MeshBasicMaterial({
      color: this.accent,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
    this.cone = new Mesh(coneGeo, this.coneMat);
    this.cone.name = `${id}-cone`;
    this.cone.visible = false;
    this.cone.renderOrder = 5;
    this.cone.scale.setScalar(1 / this.scale);
    this.eyes.add(this.cone);
  }

  getEyeWorldPosition(out: Vector3): Vector3 {
    return this.eyes.getWorldPosition(out);
  }

  getLookDirection(out: Vector3): Vector3 {
    this.head.getWorldQuaternion(TMP_Q);
    return out.set(0, 0, 1).applyQuaternion(TMP_Q).normalize();
  }

  getAnchor(name: SpectatorAnchor): Object3D {
    return this.anchors.get(name) ?? this.head;
  }

  lookAt(target: Vector3 | null, opts?: { urgency?: number }): void {
    if (target) {
      this.target.copy(target);
      this.hasTarget = true;
    } else this.hasTarget = false;
    this.urgency = opts?.urgency ?? 0.5;
  }

  react(name: ReactionName, opts?: { intensity?: number; duration?: number; target?: Vector3 }): Promise<void> {
    if (this.reaction) {
      const r = this.reaction;
      this.reaction = null;
      r.resolve();
    }
    if (name === 'idle') {
      this.resetPose();
      return Promise.resolve();
    }
    const durations: Partial<Record<ReactionName, number>> = {
      leanIn: 0.9,
      gasp: 0.7,
      topple: 1.8,
      pointSqueak: 1.1,
      clap: 1.2,
      cheer: 1.3,
      giggle: 0.9,
      blushScribble: CFG.flusterDuration,
      hopToVolunteer: 1.0,
      hopBack: 1.0,
      bow: 1.4,
    };
    let d = opts?.duration ?? durations[name] ?? 1;
    if (!Number.isFinite(d)) d = 1e9;
    return new Promise((resolve) => {
      const r: Reaction = { name, t: 0, d, resolve, from: new Vector3(), to: new Vector3(), hop: false };
      if (name === 'hopToVolunteer' || name === 'hopBack') {
        r.hop = true;
        r.from.copy(this.root.position);
        if (opts?.target && this.root.parent) {
          this.root.parent.updateWorldMatrix(true, false);
          r.to.copy(opts.target);
          this.root.parent.worldToLocal(r.to);
        } else r.to.set(0, 0, 0);
      }
      if (name === 'blushScribble') this.blush.visible = true;
      this.reaction = r;
    });
  }

  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  setEyeGlyph(state: 'open' | 'closed' | 'hidden'): void {
    if (state === this.glyphState) return;
    this.glyphState = state;
    this.glyph.visible = state !== 'hidden';
    if (state !== 'hidden') this.glyph.material = glyphMaterial(state === 'open');
  }

  setSightCone(visible: boolean, alarm = false): void {
    this.cone.visible = visible;
    this.coneMat.color.setHex(alarm ? PAL.alarm : this.accent);
    this.coneMat.opacity = alarm ? 0.32 : 0.12;
  }

  setMood(mood: 'neutral' | 'eyeContact' | 'flustered' | 'suspicious'): void {
    this.mood = mood;
    this.blush.visible = mood === 'flustered' || mood === 'eyeContact' || this.reaction?.name === 'blushScribble';
  }

  update(dt: number): void {
    if (this.frozen) return;
    this.time += dt;
    const t = this.time;
    // ---- where to look (root-local yaw/pitch of the target from the eyes)
    let goalYaw: number;
    let goalPitch: number;
    if (this.hasTarget) {
      this.root.updateWorldMatrix(true, false);
      TMP.copy(this.target);
      this.root.worldToLocal(TMP);
      const dx = TMP.x;
      const dy = TMP.y - this.eyeY * this.scale;
      const dz = TMP.z;
      goalYaw = Math.atan2(dx, dz);
      goalPitch = Math.atan2(-dy, Math.hypot(dx, dz));
    } else {
      goalYaw = 0.35 * Math.sin(t * 0.37 + this.seed);
      goalPitch = 0.45 + 0.1 * Math.sin(t * 0.53 + this.seed * 2.1);
    }
    const total = this.bodyYaw + this.yaw;
    const desired = total + wrapPi(goalYaw - total);
    const maxHead = 1.0;
    let bodyGoal = this.bodyYaw;
    if (desired - this.bodyYaw > maxHead) bodyGoal = desired - maxHead * 0.6;
    else if (desired - this.bodyYaw < -maxHead) bodyGoal = desired + maxHead * 0.6;
    else if (Math.abs(desired) < 0.7) bodyGoal = 0;
    const headGoal = Math.max(-1.3, Math.min(1.3, desired - bodyGoal));
    const s = 0.55 + 0.9 * this.urgency;
    const k = CFG.headTurnStiffness * s * s;
    const c = CFG.headTurnDamping * s;
    this.yawV += (k * (headGoal - this.yaw) - c * this.yawV) * dt;
    this.yaw += this.yawV * dt;
    this.pitchV += (k * (Math.max(-0.7, Math.min(0.9, goalPitch)) - this.pitch) - c * this.pitchV) * dt;
    this.pitch += this.pitchV * dt;
    const kb = 55 * s;
    const cb = 11 * Math.sqrt(s);
    this.bodyYawV += (kb * (bodyGoal - this.bodyYaw) - cb * this.bodyYawV) * dt;
    this.bodyYaw += this.bodyYawV * dt;

    // ---- reactions
    let lift = 0;
    let lean = 0;
    let roll = 0;
    let squash = 1;
    let headTilt = this.mood === 'eyeContact' ? 0.18 * Math.sin(t * 2.0) : 0;
    const r = this.reaction;
    if (r) {
      r.t += dt;
      const u = Math.min(1, r.t / r.d);
      const bump = Math.sin(Math.PI * u);
      switch (r.name) {
        case 'leanIn':
          lean = 0.32 * bump;
          break;
        case 'gasp':
          lift = 0.012 * Math.sin(Math.PI * Math.min(1, u * 2));
          squash = 1 + 0.12 * bump;
          lean = -0.15 * bump;
          break;
        case 'topple': {
          const tip = u < 0.3 ? u / 0.3 : u < 0.55 ? 1 : 1 - (u - 0.55) / 0.45;
          roll = 1.35 * Math.sin((Math.PI / 2) * Math.max(0, tip));
          lift = 0.004 * bump;
          break;
        }
        case 'pointSqueak':
          lift = 0.02 * Math.abs(Math.sin(Math.PI * u * 2));
          lean = 0.28 * bump;
          headTilt = 0.25 * bump;
          break;
        case 'clap':
          lift = 0.008 * Math.abs(Math.sin(Math.PI * u * 4));
          break;
        case 'cheer':
          lift = 0.028 * Math.abs(Math.sin(Math.PI * u * 2));
          squash = 1 + 0.08 * Math.sin(Math.PI * u * 4);
          break;
        case 'giggle':
          roll = 0.12 * Math.sin(t * 38) * bump;
          squash = 1 + 0.04 * Math.sin(t * 30);
          break;
        case 'blushScribble':
          lean = 0.12;
          roll = 0.025 * Math.sin(t * 24);
          break;
        case 'bow':
          lean = 0.7 * bump;
          break;
        default:
          break;
      }
      if (r.hop) {
        const e = u * u * (3 - 2 * u);
        this.root.position.lerpVectors(r.from, r.to, e);
        lift = 0.045 * Math.sin(Math.PI * u);
        squash = u < 0.12 ? 1 - 0.15 * (u / 0.12) : 1 + 0.08 * Math.sin(Math.PI * u);
      }
      if (u >= 1) {
        this.reaction = null;
        if (r.name === 'blushScribble') this.blush.visible = this.mood === 'flustered' || this.mood === 'eyeContact';
        r.resolve();
      }
    }
    this.roll += (roll - this.roll) * Math.min(1, dt * 18);
    this.body.position.y = lift;
    this.body.rotation.set(lean, this.bodyYaw, this.roll, 'YXZ');
    this.body.scale.set(this.scale / Math.sqrt(squash), this.scale * squash, this.scale / Math.sqrt(squash));
    this.head.rotation.set(this.pitch - lean * 0.6, this.yaw, headTilt, 'YXZ');
    if (this.glyph.visible) this.glyph.position.y = this.neck.position.y + this.headRadius / this.scale + 0.03 + 0.003 * Math.sin(t * 3 + this.seed);
  }

  private resetPose(): void {
    this.blush.visible = this.mood === 'flustered' || this.mood === 'eyeContact';
  }

  dispose(): void {
    this.root.removeFromParent();
    this.coneMat.dispose();
    this.cone.geometry.dispose();
  }
}

export const stubSpectatorFactory: SpectatorFactory = {
  create(kind, opts) {
    return new StubSpectator(kind, opts.id, opts);
  },
};
