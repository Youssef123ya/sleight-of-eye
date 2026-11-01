// The felt-puppet Spectator (implements contracts.Spectator).
//
// Hierarchy:  root (game-owned placement, named <id>)
//               ├ stage (instance scale) ── bones + 2 SkinnedMeshes (felt, gloss) sharing one skeleton
//               ├ glyph (Sprite, shared atlas)            <id>-glyph
//               └ cone  (flat fan on the cloth)           <id>-cone
// The root never moves: hops move the internal 'root' bone, so the game's seat parenting stays intact.
//
// Per-frame work allocates nothing (GC hitches on Quest). Every node below `root` has matrixAutoUpdate = false: the
// pose lives in plain-number TRS arrays and is composed into the bones' local matrices here (./xform.ts), so neither
// this code nor the renderer's scene-graph pass goes through three's Euler / Quaternion / Matrix4 helpers, which
// IWSDK's accessor-bound entity transforms leave megamorphic and allocating. World ↔ puppet conversions use a cached
// copy of the root's matrixWorld as the renderer left it (≤ 1 frame stale; refreshed at once when the root is
// re-parented, and exactly at event time) — never updateWorldMatrix / getWorldPosition / worldToLocal per frame.
// The matrices are authoritative: position / rotation / scale of the internal nodes keep their construction values.
import {
  Group,
  Matrix4,
  Mesh,
  Object3D,
  Skeleton,
  SkinnedMesh,
  Sprite,
  type Bone,
  type BufferGeometry,
  type Material,
  type ShaderMaterial,
  type SpriteMaterial,
  type Vector3,
} from '@iwsdk/core';
import { SPECTATOR_ACCENT } from '../art/palette.js';
import { CFG } from '../config.js';
import type { ReactionName, Spectator, SpectatorAnchor, SpectatorKind } from '../contracts.js';
import { L } from '../layout.js';
import { makeBoneInverses, makeBones } from './builder.js';
import type { Traits } from './designs/common.js';
import { acquireDesign, releaseDesign, type PuppetDesign } from './designs/index.js';
import { HAT } from './designs/rabbit.js';
import {
  CONE_ALARM,
  CONE_HALF,
  CONE_OPACITY,
  CONE_TIME,
  acquireShared,
  coneMaterial,
  coneState,
  glyphGeometry,
  glyphMaterial,
  releaseShared,
  setGlyphCell,
  type SharedResources,
} from './materials.js';
import { DEG, Rng, Spring, clamp, copy3, damp, easeInOut, easeOutBack, lerp, seg, set3, settleFields, smoothstep, wrapPi } from './math.js';
import { PK, addPose, makePose } from './pose.js';
import { HOP, LOOPING, REACTION_DURATION, STAGGERED, poseReaction, type ReactionCtx } from './reactions.js';
import {
  FrameCache,
  composeAt,
  identity,
  invertAffine,
  mulAffine,
  quatAxisAngle,
  quatEulerXYZ,
  quatEulerYXZ,
  quatFromUnitVectors,
  quatMul,
  quatSlerp,
  rotateByQuat,
  xformPoint,
} from './xform.js';

export type Mood = 'neutral' | 'eyeContact' | 'flustered' | 'suspicious';
type GlyphState = 'open' | 'closed' | 'hidden';

/** Animated bones in slot order: the TRS arrays, `slots` and `mats` are indexed by these. */
const BONE_NAMES = [
  'root', 'hat', 'body', 'chest', 'tail', 'head', 'earL', 'earR', 'mouth', 'jaw', 'cheekL', 'cheekR', 'nose',
  'armL', 'armR', 'handL', 'handR', 'eyeL', 'eyeR', 'lidL', 'lidR', 'lowL', 'lowR',
] as const;
const NB = BONE_NAMES.length;
const ROOT = 0;
const BODY = 2;
const CHEST = 3;
const TAIL = 4;
const HEAD = 5;
const EAR_L = 6;
const EAR_R = 7;
const MOUTH = 8;
const JAW = 9;
const CHEEK_L = 10;
const CHEEK_R = 11;
const NOSE = 12;
const ARM_L = 13;
const ARM_R = 14;
const HAND_L = 15;
const HAND_R = 16;
const EYE_L = 17;
const EYE_R = 18;
const LID_L = 19;
const LID_R = 20;
const LOW_L = 21;
const LOW_R = 22;
const ANCHORS: SpectatorAnchor[] = ['eyes', 'head', 'ear', 'hand', 'notebook', 'beak', 'hatTop'];

/** Seat feet stand this far above the cloth (the riser). */
const RISER_DROP = L.riser.topY - L.tableY;
/**
 * Rig-local height of the flat sight cones: 1.5 mm above the 6 mm velvet mat (over the bare cloth beyond the mat the
 * extra height is invisible), below every prop's body. Each cone holds this height wherever the game parents its
 * puppet (it measures against the StageRig above the root), so a lift applied by the game is a no-op.
 */
export const CONE_Y = L.mat.top + 0.0015;
/** The same height above the tabletop. */
export const CONE_LIFT = CONE_Y - L.tableY;
/** Cone origin when no StageRig is found above the root: from the riser's front edge (seated) / the hat brim. */
const CONE_SEATED_Y = CONE_Y - L.riser.topY;
const CONE_SEATED_Z = L.riser.z + L.riser.depth / 2 - L.seats[0][2];
const CONE_LEN = 0.34;
const CONE_ALPHA = 0.17;
const GLYPH_SIZE = 0.024;
const YAW_LIMIT = 110 * DEG;
const BODY_FREE = 70 * DEG;
const PITCH_MIN = -45 * DEG;
const PITCH_MAX = 50 * DEG;
const STEP_TIME = 0.14;
/** layout.ts names the StageRig root so; the cone height is measured in its frame. */
const RIG_NAME = 'StageRig';

const IDENTITY = new Matrix4();
// scratch (puppets update one at a time; the getters use their own)
const _p = new Float64Array(3);
const _g = new Float64Array(3);
const _q = new Float64Array(4);

/** One playing reaction (event-time allocation; per-frame code only reads and writes its settled fields). */
class Active {
  t = 0;
  delay = 0;
  I = 1;
  seed = 0;
  hasTarget = false;
  readonly target = new Float64Array(3); // world x y z
  readonly from = new Float64Array(3); // hop endpoints (stage space)
  readonly to = new Float64Array(3);
  fromYaw = 0;
  dirYaw = 0;
  arc = 0;
  prevMood: Mood | null = null;
  constructor(
    readonly name: ReactionName,
    readonly dur: number,
    readonly resolve: () => void,
  ) {
    settleFields(this);
  }
}

const isHop = (n: ReactionName) => n === 'hopToVolunteer' || n === 'hopBack';

function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** a[i*3 .. i*3+2] = x, y, z (TRS position / scale slots). */
function put3(a: Float64Array, i: number, x: number, y: number, z: number): void {
  const o = i * 3;
  a[o] = x;
  a[o + 1] = y;
  a[o + 2] = z;
}

/** v = (x, y, z) normalised like three's Vector3.normalize. */
function unit(v: Float64Array, x: number, y: number, z: number): void {
  const k = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
  v[0] = x * k;
  v[1] = y * k;
  v[2] = z * k;
}

function findRig(from: Object3D | null): Object3D | null {
  for (let o = from; o; o = o.parent) if (o.name === RIG_NAME) return o;
  return null;
}

export class PuppetSpectator implements Spectator {
  readonly id: string;
  readonly kind: SpectatorKind;
  readonly root: Group;
  readonly headRadius: number;

  private readonly d: PuppetDesign;
  /** Per-frame code reads these copies, never the design objects (their shapes differ per kind). */
  private readonly tr: Traits;
  private readonly lidClose: number;
  private readonly lidRise: number;
  private readonly glyphY: number;
  private readonly res: SharedResources;
  private readonly stage = new Group();
  private readonly bones: Bone[];
  private readonly slots: Bone[];
  /** slots[i].matrix.elements (written every step). */
  private readonly mats: number[][];
  private readonly skeleton: Skeleton;
  private readonly glyph: Sprite;
  private readonly glyphMat: SpriteMaterial;
  private readonly glyphGeo: BufferGeometry;
  private readonly cone: Mesh;
  private readonly coneMat: ShaderMaterial;
  private readonly coneU: Float32Array;
  private readonly coneY0: number;
  private readonly coneZ: number;
  private readonly anchors: Record<SpectatorAnchor, Object3D>;
  private readonly rng: Rng;
  private readonly scale: number;
  private readonly seed: number;
  private readonly tiltDir: number;

  // pose: TRS per slot, the composed local matrices, and the root → chest → head chain in puppet-root space
  private readonly tp = new Float64Array(NB * 3);
  private readonly tq = new Float64Array(NB * 4);
  private readonly ts = new Float64Array(NB * 3);
  private readonly lm = new Float64Array(NB * 16);
  private readonly mStage = new Float64Array(16);
  private readonly mRoot = new Float64Array(16);
  private readonly mChest = new Float64Array(16);
  private readonly iChest = new Float64Array(16);
  private readonly mHead = new Float64Array(16);
  private readonly iHead = new Float64Array(16);
  /** The root's matrixWorld as last rendered (+ inverse), and the stage rig's (cone height). */
  private readonly frame = new FrameCache();
  private readonly rigFrame = new FrameCache();
  private rigNode: Object3D | null = null;
  private parentSeen: Object3D | null = null;
  private parentChecked = false;
  /** The eyes anchor in head-bone space. */
  private readonly eyesAt = new Float64Array(3);
  private readonly eyesOnHead: boolean;

  // rest data
  private readonly chestRest = new Float64Array(3);
  private readonly tailRest = new Float64Array(3);
  private readonly handLRest = new Float64Array(3);
  private readonly handRRest = new Float64Array(3);
  private readonly noseRest = new Float64Array(3);
  private readonly armDirL = new Float64Array(3);
  private readonly armDirR = new Float64Array(3);
  private readonly eyeOff = new Float64Array(3);
  private readonly eyeCL = new Float64Array(3);
  private readonly eyeCR = new Float64Array(3);
  private readonly home = new Float64Array(3);
  private readonly hingeL = new Float64Array(3);
  private readonly hingeR = new Float64Array(3);
  private readonly faceL = new Float64Array(3);
  private readonly faceR = new Float64Array(3);

  // clocks & flags
  private time = 0;
  private frozen = false;
  private disposed = false;
  private warned = false;

  // look
  private readonly tgt = new Float64Array(3); // lookAt target (world)
  private hasTarget = false;
  private urgency = 0.5;
  private readonly lookR = new Float64Array(3); // this frame's look point (puppet-root space)
  private readonly idleLocal = Float64Array.of(0, -0.03, 0.26); // root space
  private idleTimer = 0;
  private readonly yawS = new Spring();
  private readonly pitchS = new Spring();
  private antT = 0;
  private antHold = 0;
  private antOff = 0;
  private antRef = 0;
  private antInit = false;
  private antDip = 0;
  private startle = 0;
  private birdHold = 0;
  private birdYaw = 0;
  private birdPitch = 0;
  private birdTilt = 0;
  private birdTiltCur = 0;

  // body shuffle & placement
  private bodyYaw = 0;
  private stepT = -1;
  private stepFrom = 0;
  private stepTo = 0;
  private stepSide = 1;
  private stepHop = 0;
  private stepRoll = 0;
  private readonly base = new Float64Array(3);
  private baseYaw = 0;
  private away = false;

  // eyes
  private eyeYL = 0;
  private eyePL = 0;
  private eyeYR = 0;
  private eyePR = 0;
  private blinkT = -1;
  private blinkNext = 2;
  private blinkAgain = false;

  // mood
  private mood: Mood = 'neutral';
  private mEye = 0;
  private mFlu = 0;
  private mSus = 0;

  // secondary motion & fidgets
  private readonly earSL = new Spring();
  private readonly earSR = new Spring();
  private readonly tailS = new Spring();
  private prevHeadY = 0;
  private prevVelY = 0;
  private hasPrevHead = false;
  private flickTimer = 3;
  private fidgetTimer = 6;
  private fidgetT = -1;

  // reactions
  private rx: Active | null = null;
  private rxW = 0;
  private fadeW = 0;
  private readonly P = makePose();
  private readonly RP = makePose();
  private readonly FP = makePose();
  private readonly aimL = Float64Array.of(0, -1, 0);
  private readonly aimR = Float64Array.of(0, -1, 0);
  private readonly fadeAimL = Float64Array.of(0, -1, 0);
  private readonly fadeAimR = Float64Array.of(0, -1, 0);
  private readonly ctx: ReactionCtx;

  // overlays
  private glyphState: GlyphState = 'hidden';
  private readonly glyphPop = new Spring();
  private glyphCell = 0;
  private glyphAnim = -1;
  private glyphFrom = 0;
  private glyphTo = 0;
  private coneOn = false;
  private alarmOn = false;
  private coneVis = 0;
  private alarm = 0;
  private halfAngle = CFG.sightHalfAngle * DEG;

  constructor(kind: SpectatorKind, opts: { id: string; seed?: number; accent?: number; scale?: number }) {
    this.id = opts.id;
    this.kind = kind;
    this.seed = (opts.seed ?? hashId(opts.id)) >>> 0;
    this.rng = new Rng(this.seed);
    this.d = acquireDesign(kind, this.seed % 3);
    this.tr = this.d.traits;
    this.lidClose = this.d.lidClose;
    this.lidRise = this.d.lidRise;
    this.glyphY = this.d.glyphY;
    this.res = acquireShared();
    this.scale = opts.scale && opts.scale > 0 ? opts.scale : 1;
    this.headRadius = this.d.headRadius * this.scale;
    this.tiltDir = this.rng.next() < 0.5 ? -1 : 1;
    const accent = opts.accent ?? SPECTATOR_ACCENT[kind];

    this.root = new Group();
    this.root.name = this.id;
    this.stage.name = `${this.id}-puppet`;
    this.stage.scale.setScalar(this.scale);
    this.stage.updateMatrix();
    this.stage.matrixAutoUpdate = false;
    this.root.add(this.stage);
    identity(this.mStage);
    this.mStage[0] = this.mStage[5] = this.mStage[10] = this.scale;

    // skeleton + the two skinned meshes; every bone's matrix is ours from here on
    this.bones = makeBones(this.d.defs);
    const byName = new Map<string, Bone>();
    for (const b of this.bones) {
      byName.set(b.name, b);
      b.name = `${this.id}.${b.name}`;
      if (!b.parent) this.stage.add(b);
      b.updateMatrix(); // rest pose (a bone outside BONE_NAMES would keep it)
      b.matrixAutoUpdate = false;
    }
    this.slots = BONE_NAMES.map((n) => {
      const b = byName.get(n);
      if (!b) throw new Error(`[spectators] design ${this.d.key} lacks bone "${n}"`);
      return b;
    });
    this.mats = this.slots.map((b) => b.matrix.elements);
    for (let i = 0; i < NB; i++) {
      const p = this.slots[i].position;
      put3(this.tp, i, p.x, p.y, p.z);
      put3(this.ts, i, 1, 1, 1);
      this.tq[i * 4 + 3] = 1;
    }
    this.skeleton = new Skeleton(this.bones, makeBoneInverses(this.d.defs));
    this.skinned(this.d.felt, this.res.felt, 'felt');
    this.skinned(this.d.gloss, this.res.gloss, 'gloss');

    // anchors (named "<id>-<anchor>"), fixed offsets on their bones
    const defPos = (n: string) => this.d.defs.find((x) => x.name === n)!.pos;
    const anchors = {} as Record<SpectatorAnchor, Object3D>;
    for (const name of ANCHORS) {
      const a = this.d.anchors[name];
      const o = new Object3D();
      o.name = `${this.id}-${name}`;
      const bp = defPos(a.bone);
      const p = name === 'eyes' ? [0, (this.d.eyeL[1] + this.d.eyeR[1]) / 2, (this.d.eyeL[2] + this.d.eyeR[2]) / 2] : a.p;
      o.position.set(p[0] - bp[0], p[1] - bp[1], p[2] - bp[2]);
      o.updateMatrix();
      o.matrixAutoUpdate = false;
      byName.get(a.bone)!.add(o);
      anchors[name] = o;
    }
    this.anchors = anchors;
    const ea = anchors.eyes.position;
    set3(this.eyesAt, ea.x, ea.y, ea.z);
    this.eyesOnHead = this.d.anchors.eyes.bone === 'head';

    // rest data
    const S = this.slots;
    set3(this.chestRest, S[CHEST].position.x, S[CHEST].position.y, S[CHEST].position.z);
    set3(this.tailRest, S[TAIL].position.x, S[TAIL].position.y, S[TAIL].position.z);
    set3(this.handLRest, S[HAND_L].position.x, S[HAND_L].position.y, S[HAND_L].position.z);
    set3(this.handRRest, S[HAND_R].position.x, S[HAND_R].position.y, S[HAND_R].position.z);
    set3(this.noseRest, S[NOSE].position.x, S[NOSE].position.y, S[NOSE].position.z);
    const hp = defPos('head');
    const eL = this.d.eyeL;
    const eR = this.d.eyeR;
    set3(this.eyeCL, eL[0] - hp[0], eL[1] - hp[1], eL[2] - hp[2]);
    set3(this.eyeCR, eR[0] - hp[0], eR[1] - hp[1], eR[2] - hp[2]);
    set3(this.eyeOff, 0, (eL[1] + eR[1]) / 2 - hp[1], (eL[2] + eR[2]) / 2 - hp[2]);
    const aL = defPos('armL');
    const hL = defPos('handL');
    const aR = defPos('armR');
    const hR = defPos('handR');
    unit(this.armDirL, hL[0] - aL[0], hL[1] - aL[1], hL[2] - aL[2]);
    unit(this.armDirR, hR[0] - aR[0], hR[1] - aR[1], hR[2] - aR[2]);
    set3(this.home, 0, this.d.restLift, 0);
    const ey = this.d.eyeYaw;
    set3(this.hingeL, Math.cos(ey), 0, -Math.sin(ey));
    set3(this.faceL, Math.sin(ey), 0, Math.cos(ey));
    set3(this.hingeR, Math.cos(ey), 0, Math.sin(ey));
    set3(this.faceR, -Math.sin(ey), 0, Math.cos(ey));
    copy3(this.base, this.home);

    // eye glyph (shared atlas; per-instance tint and UVs); its matrix is written by overlays()
    this.glyphGeo = glyphGeometry();
    this.glyphMat = glyphMaterial(this.res.atlas, accent);
    this.glyph = new Sprite(this.glyphMat);
    this.glyph.geometry = this.glyphGeo;
    this.glyph.name = `${this.id}-glyph`;
    this.glyph.renderOrder = 3;
    this.glyph.visible = false;
    this.glyph.matrixAutoUpdate = false;
    this.root.add(this.glyph);

    // sight cone on the cloth, from the riser's front edge (or the hat's brim); its matrix is written by overlays()
    this.coneMat = coneMaterial(accent);
    this.coneU = coneState(this.coneMat);
    this.cone = new Mesh(this.res.coneGeo, this.coneMat);
    this.cone.name = `${this.id}-cone`;
    this.cone.renderOrder = 1;
    this.cone.visible = false;
    this.cone.frustumCulled = false;
    if (this.d.traits.hat) {
      this.coneY0 = CONE_LIFT; // the hat stands on the cloth
      this.coneZ = HAT.brim * this.scale + 0.004;
    } else {
      this.coneY0 = CONE_SEATED_Y;
      this.coneZ = CONE_SEATED_Z;
    }
    this.cone.position.set(0, this.coneY0, this.coneZ);
    this.cone.scale.set(CONE_LEN, 1, CONE_LEN);
    this.cone.updateMatrix();
    this.cone.matrixAutoUpdate = false;
    this.root.add(this.cone);

    this.ctx = {
      kind,
      traits: this.d.traits,
      t: 0,
      dur: 1,
      I: 1,
      seed: 0,
      drop: 0,
      toeZ: this.d.toeZ,
      inHat: false,
      target: Float64Array.of(0, 0, 1),
      hasTarget: false,
      aimL: this.aimL,
      aimR: this.aimR,
    };
    settleFields(this.ctx);
    this.blinkNext = 0.8 + this.rng.next() * 3;
    this.flickTimer = 1.5 + this.rng.next() * 4;
    this.fidgetTimer = 4 + this.rng.next() * 6;
    this.pickIdleTarget();
    settleFields(this);
    this.frame.sync(this.root.matrixWorld.elements);
    this.composeRootChest();
    this.composeHead();
    this.step(1 / 60);
  }

  // ------------------------------------------------------------------------------------- contract API
  getEyeWorldPosition(out: Vector3): Vector3 {
    if (!this.eyesOnHead) {
      const e = this.anchors.eyes.matrixWorld.elements; // as last rendered
      out.x = e[12];
      out.y = e[13];
      out.z = e[14];
      return out;
    }
    this.frame.sync(this.root.matrixWorld.elements);
    const a = this.eyesAt;
    xformPoint(this.mHead, a[0], a[1], a[2], _g);
    xformPoint(this.frame.m, _g[0], _g[1], _g[2], _g);
    out.x = _g[0];
    out.y = _g[1];
    out.z = _g[2];
    return out;
  }

  getLookDirection(out: Vector3): Vector3 {
    this.frame.sync(this.root.matrixWorld.elements);
    const m = this.mHead;
    const w = this.frame.m;
    const cx = m[8];
    const cy = m[9];
    const cz = m[10];
    const x = w[0] * cx + w[4] * cy + w[8] * cz;
    const y = w[1] * cx + w[5] * cy + w[9] * cz;
    const z = w[2] * cx + w[6] * cy + w[10] * cz;
    const l = Math.sqrt(x * x + y * y + z * z);
    if (l > 1e-8) {
      const k = 1 / l;
      out.x = x * k;
      out.y = y * k;
      out.z = z * k;
    } else {
      out.x = 0;
      out.y = 0;
      out.z = 1;
    }
    return out;
  }

  getAnchor(name: SpectatorAnchor): Object3D {
    return this.anchors[name] ?? this.anchors.head;
  }

  lookAt(target: Vector3 | null, opts?: { urgency?: number }): void {
    if (target) {
      const t = this.tgt;
      t[0] = target.x;
      t[1] = target.y;
      t[2] = target.z;
      this.hasTarget = true;
    } else if (this.hasTarget) {
      this.hasTarget = false;
      this.idleTimer = 0;
    }
    this.urgency = clamp(opts?.urgency ?? 0.5, 0, 1);
  }

  react(name: ReactionName, opts: { intensity?: number; duration?: number; target?: Vector3 } = {}): Promise<void> {
    if (this.disposed || !(name in REACTION_DURATION)) return Promise.resolve();
    if (name === 'idle') {
      if (this.rx && !isHop(this.rx.name)) this.endReaction();
      return Promise.resolve();
    }
    if (this.rx) this.endReaction();
    const dur =
      LOOPING.has(name) && opts.duration !== undefined && opts.duration > 0 ? Math.max(0.3, opts.duration) : REACTION_DURATION[name];
    return new Promise<void>((resolve) => {
      const rx = new Active(name, dur, resolve);
      rx.delay = STAGGERED.has(name) ? this.rng.next() * 0.12 : 0;
      rx.I = clamp(opts.intensity ?? 1, 0, 2);
      rx.seed = this.rng.next();
      if (opts.target) {
        rx.hasTarget = true;
        set3(rx.target, opts.target.x, opts.target.y, opts.target.z);
      }
      if (isHop(name)) this.prepareHop(rx, opts.target);
      if (name === 'blushScribble') {
        rx.prevMood = this.mood;
        this.mood = 'flustered';
      }
      this.rx = rx;
      this.rxW = 0;
    });
  }

  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  setEyeGlyph(state: GlyphState): void {
    if (state === this.glyphState) return;
    const prev = this.glyphState;
    this.glyphState = state;
    if (state === 'hidden') return;
    const cell = state === 'open' ? 0 : 2;
    if (prev === 'hidden') {
      this.glyphAnim = -1;
      this.glyphCell = cell;
      setGlyphCell(this.glyphGeo, cell);
    } else {
      this.glyphFrom = this.glyphCell;
      this.glyphTo = cell;
      this.glyphAnim = 0;
      this.glyphPop.v += 3.5;
    }
  }

  setSightCone(visible: boolean, alarm = false): void {
    this.coneOn = visible;
    this.alarmOn = alarm;
  }

  setMood(mood: Mood): void {
    this.mood = mood;
  }

  /** Match the drawn cone to the active rule (Easy Audience halves it). */
  setSightHalfAngle(deg: number): void {
    this.halfAngle = clamp(deg, 2, 30) * DEG;
  }

  update(dt: number, _time: number): void {
    if (this.disposed) return;
    try {
      const h = Math.min(Math.max(dt, 0), 0.1);
      this.syncRoot();
      if (!this.frozen && h > 0) this.step(h);
      this.overlays(h);
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        console.error(`[spectators] ${this.id} update failed (logged once)`, e);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const rx = this.rx;
    this.rx = null;
    rx?.resolve();
    this.root.removeFromParent();
    this.glyphMat.dispose();
    this.glyphGeo.dispose();
    this.coneMat.dispose();
    this.skeleton.dispose();
    releaseShared();
    releaseDesign(this.d);
  }

  // ------------------------------------------------------------------------------------------ internals
  private skinned(geo: BufferGeometry, mat: Material, tag: string): SkinnedMesh {
    const m = new SkinnedMesh(geo, mat);
    m.name = `${this.id}-${tag}`;
    m.frustumCulled = false;
    m.matrixAutoUpdate = false; // identity under the stage
    this.stage.add(m);
    m.bind(this.skeleton, IDENTITY);
    return m;
  }

  /** Pick up the root's world matrix; when the game re-parents the root, refresh it now (event-time) and find the rig. */
  private syncRoot(): void {
    const parent = this.root.parent;
    if (!this.parentChecked || parent !== this.parentSeen) {
      this.parentChecked = true;
      this.parentSeen = parent;
      this.root.updateWorldMatrix(true, false);
      this.rigNode = findRig(parent);
    }
    this.frame.sync(this.root.matrixWorld.elements);
  }

  /** Root bone and chest in puppet-root space (+ the chest's inverse for look targets). */
  private composeRootChest(): void {
    const lm = this.lm;
    composeAt(lm, ROOT * 16, this.tp, this.tq, this.ts, ROOT);
    mulAffine(this.mStage, lm, ROOT * 16, this.mRoot);
    composeAt(lm, CHEST * 16, this.tp, this.tq, this.ts, CHEST);
    mulAffine(this.mRoot, lm, CHEST * 16, this.mChest);
    invertAffine(this.mChest, this.iChest);
  }

  private composeHead(): void {
    composeAt(this.lm, HEAD * 16, this.tp, this.tq, this.ts, HEAD);
    mulAffine(this.mChest, this.lm, HEAD * 16, this.mHead);
    invertAffine(this.mHead, this.iHead);
  }

  /** Compose the remaining slots and hand every local matrix to its bone (the renderer multiplies them down). */
  private publish(): void {
    const lm = this.lm;
    for (let i = 0; i < NB; i++) {
      const o = i * 16;
      if (i !== ROOT && i !== CHEST && i !== HEAD) composeAt(lm, o, this.tp, this.tq, this.ts, i);
      const te = this.mats[i];
      for (let k = 0; k < 16; k++) te[k] = lm[o + k];
    }
    this.stage.matrixWorldNeedsUpdate = true;
  }

  private step(dt: number): void {
    this.time += dt;
    const P = this.P;
    P.fill(0);

    // moods ease in and out
    const mk = 1 - Math.exp(-6 * dt);
    this.mEye += ((this.mood === 'eyeContact' ? 1 : 0) - this.mEye) * mk;
    this.mFlu += ((this.mood === 'flustered' ? 1 : 0) - this.mFlu) * mk;
    this.mSus += ((this.mood === 'suspicious' ? 1 : 0) - this.mSus) * mk;

    // reaction layer
    this.RP.fill(0);
    set3(this.aimL, 0, -1, 0);
    set3(this.aimR, 0, -1, 0);
    const rx = this.rx;
    if (rx) {
      if (rx.delay > 0) rx.delay -= dt;
      else {
        rx.t += dt;
        this.rxW = Math.min(1, this.rxW + dt / 0.09);
        this.fillReaction(rx);
        if (isHop(rx.name)) this.advanceHop(rx);
        if (rx.t >= rx.dur) this.endReaction();
      }
    }
    this.fadeW = Math.max(0, this.fadeW - dt / 0.28);

    this.idleLayer(dt);
    this.moodLayer();
    if (this.rx && this.rx.delay <= 0) addPose(P, this.RP, this.rxW);
    if (this.fadeW > 0) addPose(P, this.FP, easeInOut(this.fadeW));
    if (this.kind === 'badger') {
      const nb = clamp(P[PK.notebook], 0, 1.3);
      P[PK.armLSwing] += 62 * DEG * nb;
      P[PK.armLRaise] -= 12 * DEG * nb;
      P[PK.armRSwing] += 52 * DEG * nb;
    }

    // ---- mover: placement + reaction offsets + shuffle bounce, leaning about pivotZ (Euler YXZ)
    const tp = this.tp;
    const tq = this.tq;
    const b = this.base;
    let px = b[0] + P[PK.x];
    let py = b[1] + P[PK.y] + this.stepHop;
    let pz = b[2] + P[PK.z];
    const yaw = this.baseYaw + this.bodyYaw + P[PK.yaw];
    quatEulerYXZ(tq, ROOT * 4, P[PK.lean], yaw, P[PK.roll] + this.stepRoll);
    const piv = P[PK.pivotZ];
    if (piv !== 0) {
      rotateByQuat(tq, ROOT * 4, 0, 0, piv, _p);
      px += piv * Math.sin(yaw) - _p[0];
      py -= _p[1];
      pz += piv * Math.cos(yaw) - _p[2];
    }
    put3(tp, ROOT, px, py, pz);
    const s = clamp(1 + P[PK.squash], 0.55, 1.6);
    const sxz = 1 / Math.sqrt(s);
    put3(this.ts, BODY, sxz, s, sxz);
    const cr = this.chestRest;
    put3(tp, CHEST, cr[0], cr[1] * s, cr[2]);
    const tr = this.tailRest;
    put3(tp, TAIL, tr[0] * sxz, tr[1] * s, tr[2] * sxz);
    this.composeRootChest();

    this.solveLook(dt);
    this.poseFace(dt);
    this.poseLimbs(dt);
    this.publish();
  }

  private fillReaction(rx: Active): void {
    const c = this.ctx;
    c.t = rx.t;
    c.dur = rx.dur;
    c.I = rx.I;
    c.seed = rx.seed;
    c.inHat = this.tr.hat && !this.away;
    c.drop = this.away || this.tr.hat ? 0 : RISER_DROP / this.scale;
    c.hasTarget = rx.hasTarget && !isHop(rx.name);
    if (c.hasTarget) {
      // world → puppet root → chest (last frame's chest, as before)
      const w = rx.target;
      xformPoint(this.frame.inv, w[0], w[1], w[2], _p);
      xformPoint(this.iChest, _p[0], _p[1], _p[2], _p);
      const l2 = _p[0] * _p[0] + _p[1] * _p[1] + _p[2] * _p[2];
      if (l2 > 1e-10) {
        const k = 1 / Math.sqrt(l2);
        set3(c.target, _p[0] * k, _p[1] * k, _p[2] * k);
      }
    }
    poseReaction(rx.name, c, this.RP);
  }

  private prepareHop(rx: Active, target?: Vector3): void {
    // fold the shuffle yaw into the base yaw so the hop owns the facing
    const facing = this.baseYaw + this.bodyYaw;
    this.yawS.x -= this.bodyYaw;
    this.antRef -= this.bodyYaw;
    this.bodyYaw = 0;
    this.stepT = -1;
    this.baseYaw = facing;
    copy3(rx.from, this.base);
    rx.fromYaw = facing;
    // event-time: the exact root frame (the game may have re-seated the root this very frame)
    this.root.updateWorldMatrix(true, false);
    this.frame.sync(this.root.matrixWorld.elements);
    const sc = this.scale;
    const to = rx.to;
    if (rx.name === 'hopToVolunteer') {
      if (target) {
        xformPoint(this.frame.inv, target.x, target.y, target.z, to);
        set3(to, to[0] / sc, to[1] / sc, to[2] / sc); // stage space
      } else {
        set3(to, 0.06, (L.volunteerSpot[1] - L.riser.topY) / sc, 0.27 / sc);
      }
    } else {
      copy3(to, this.home);
    }
    rx.hasTarget = true;
    xformPoint(this.frame.m, to[0] * sc, to[1] * sc, to[2] * sc, rx.target);
    const dx = to[0] - rx.from[0];
    const dz = to[2] - rx.from[2];
    const dist = Math.sqrt(dx * dx + dz * dz);
    rx.dirYaw = dist > 0.01 ? Math.atan2(dx, dz) : facing;
    const lip = this.tr.hat ? HAT.height * 0.6 : 0;
    rx.arc = (0.04 + 0.14 * dist + Math.max(0, to[1] - rx.from[1]) + lip) * this.tr.hop;
  }

  private advanceHop(rx: Active): void {
    const D = rx.dur;
    const t = rx.t;
    const turnIn = easeInOut(seg(t, 0, HOP.turnEnd * D));
    const turnOut = easeInOut(seg(t, HOP.faceStart * D, HOP.faceEnd * D));
    const mid = rx.fromYaw + wrapPi(rx.dirYaw - rx.fromYaw);
    this.baseYaw = lerp(lerp(rx.fromYaw, mid, turnIn), 0, turnOut);
    const p = seg(t, HOP.takeoff * D, HOP.land * D);
    const b = this.base;
    const f = rx.from;
    const to = rx.to;
    b[0] = f[0] + (to[0] - f[0]) * p;
    b[1] = f[1] + (to[1] - f[1]) * p;
    b[2] = f[2] + (to[2] - f[2]) * p;
    b[1] += rx.arc * 4 * p * (1 - p);
  }

  private endReaction(): void {
    const rx = this.rx;
    if (!rx) return;
    this.rx = null;
    const w = rx.delay > 0 ? 0 : this.rxW;
    for (let i = 0; i < PK.COUNT; i++) this.FP[i] = this.RP[i] * w;
    copy3(this.fadeAimL, this.aimL);
    copy3(this.fadeAimR, this.aimR);
    this.fadeW = w > 0 ? 1 : 0;
    this.rxW = 0;
    if (isHop(rx.name)) {
      copy3(this.base, rx.to);
      this.baseYaw = 0;
      const h = this.home;
      const dx = rx.to[0] - h[0];
      const dy = rx.to[1] - h[1];
      const dz = rx.to[2] - h[2];
      this.away = dx * dx + dy * dy + dz * dz > 0.0004;
    }
    if (rx.prevMood !== null && this.mood === 'flustered') this.mood = rx.prevMood;
    rx.resolve();
  }

  private pickIdleTarget(): void {
    const r = this.rng;
    if (this.tr.hat) {
      if (r.next() < 0.35) set3(this.idleLocal, -0.2, 0.3, 0.45);
      else set3(this.idleLocal, -0.22 + (r.next() - 0.5) * 0.2, 0.004, 0.02 + r.next() * 0.12);
    } else if (r.next() < 0.28) {
      set3(this.idleLocal, (r.next() - 0.5) * 0.1, 0.26, 0.66);
    } else {
      set3(this.idleLocal, (r.next() - 0.5) * 0.24, -0.035, 0.18 + r.next() * 0.14);
    }
    this.idleTimer = 1.2 + r.next() * 2.6;
  }

  private idleLayer(dt: number): void {
    const P = this.P;
    const t = this.time;
    const tr = this.tr;
    const ph = (this.seed % 1000) * 0.0137;
    P[PK.squash] += 0.012 * Math.sin(t * 2.05 + ph) - 0.06 * this.antDip + 0.1 * this.startle;
    P[PK.roll] += 0.022 * Math.sin(t * 0.83 + ph * 2);
    P[PK.lean] += 0.012 * Math.sin(t * 0.61 + ph * 3) - tr.pompous;
    P[PK.tailWag] += 0.22 * Math.sin(t * 2.9 + ph);
    P[PK.nod] += 5 * DEG * this.antDip;
    P[PK.wide] += 0.8 * this.startle;
    P[PK.earPerk] += this.startle;
    P[PK.y] += 0.004 * this.startle;
    this.antDip = Math.max(0, this.antDip - dt / 0.22);
    this.startle = Math.max(0, this.startle - dt / 0.45);

    this.flickTimer -= dt;
    if (this.flickTimer <= 0) {
      this.flickTimer = 2.5 + this.rng.next() * 5;
      (this.rng.next() < 0.5 ? this.earSL : this.earSR).v += 7 + this.rng.next() * 5;
    }
    if (!this.hasTarget) {
      this.idleTimer -= dt;
      if (this.idleTimer <= 0) this.pickIdleTarget();
    }

    // character fidgets (only while no reaction owns the arms)
    this.fidgetTimer -= dt;
    if (this.fidgetTimer <= 0 && this.fidgetT < 0 && !this.rx) {
      this.fidgetT = 0;
      this.fidgetTimer = 6 + this.rng.next() * 7;
    }
    if (this.fidgetT >= 0) {
      this.fidgetT += dt;
      const f = this.fidgetT;
      if (this.kind === 'badger') {
        // taps his monocle with the pencil's end, harrumphs
        const w = clamp(Math.min(f / 0.3, (1.5 - f) / 0.35), 0, 1);
        if (this.RP[PK.aimR] <= 0) {
          set3(this.aimR, 0.32, 0.86, 0.38);
          P[PK.aimR] += easeInOut(w);
        }
        P[PK.handR] += Math.sin(f * 30) * 0.4 * w;
        P[PK.nod] -= 5 * DEG * w;
      } else if (this.kind === 'rabbit') {
        P[PK.ears] -= 0.25 * Math.sin(Math.min(1, f / 1.2) * Math.PI);
      } else if (this.kind === 'magpie') {
        P[PK.armLRaise] += 30 * DEG * Math.sin(Math.min(1, f / 0.5) * Math.PI) * (f < 0.5 ? 1 : 0);
        P[PK.armRRaise] += 30 * DEG * Math.sin(Math.min(1, f / 0.5) * Math.PI) * (f < 0.5 ? 1 : 0);
      } else {
        // fox: a contented wiggle of the tail and a little shuffle of the paws
        P[PK.tailWag] += Math.sin(f * 16) * 0.5 * Math.sin(Math.min(1, f / 0.9) * Math.PI);
      }
      if (f > 1.6) this.fidgetT = -1;
    }
  }

  private moodLayer(): void {
    const P = this.P;
    const t = this.time;
    const ec = this.mEye;
    const fl = this.mFlu;
    const su = this.mSus;
    if (ec > 0.002) {
      P[PK.lidLow] += 0.55 * ec;
      P[PK.lidClose] += 0.06 * ec;
      P[PK.tilt] += 12 * DEG * this.tiltDir * ec;
      P[PK.pupil] += 0.14 * ec;
      P[PK.blush] += 0.35 * ec;
      P[PK.earPerk] += 0.25 * ec;
      P[PK.tailWag] += Math.sin(t * 7.5) * 0.4 * ec;
      P[PK.mouth] += 0.12 * ec;
      P[PK.squash] += 0.015 * Math.sin(t * 7.5) * ec;
    }
    if (fl > 0.002) {
      P[PK.blush] += fl;
      P[PK.ears] += 0.9 * fl;
      P[PK.lidClose] += 0.22 * fl;
      P[PK.eyeAway] += 0.55 * fl;
      P[PK.nod] += 8 * DEG * fl;
      P[PK.squash] -= 0.03 * fl;
      P[PK.tilt] -= 7 * DEG * this.tiltDir * fl;
      P[PK.roll] += Math.sin(t * 31) * 0.006 * fl;
    }
    if (su > 0.002) {
      P[PK.lidClose] += 0.45 * su;
      P[PK.lidLow] += 0.25 * su;
      P[PK.lidTilt] += 13 * DEG * su;
      P[PK.nod] += 5 * DEG * su;
      P[PK.pupil] -= 0.14 * su;
      P[PK.lean] += 4 * DEG * su;
      P[PK.ears] += 0.35 * su;
    }
  }

  // ------------------------------------------------------------------------------------------- look
  private solveLook(dt: number): void {
    const P = this.P;
    const tr = this.tr;
    const rx = this.rx;

    // where to look (puppet-root space): reaction target > lookAt target > idle glance
    const lr = this.lookR;
    if (rx && rx.hasTarget && rx.delay <= 0 && (this.RP[PK.lookTarget] > 0 || (isHop(rx.name) && rx.t < HOP.land * rx.dur))) {
      xformPoint(this.frame.inv, rx.target[0], rx.target[1], rx.target[2], lr);
    } else if (this.hasTarget) {
      xformPoint(this.frame.inv, this.tgt[0], this.tgt[1], this.tgt[2], lr);
    } else {
      copy3(lr, this.idleLocal);
    }

    // head yaw/pitch in the chest frame, solved from the eye midpoint (two fixed-point passes)
    xformPoint(this.iChest, lr[0], lr[1], lr[2], _p);
    const vx = _p[0];
    const vy = _p[1];
    const vz = _p[2];
    const ho = HEAD * 3;
    const hx = this.tp[ho];
    const hy = this.tp[ho + 1];
    const hz = this.tp[ho + 2];
    const eo = this.eyeOff;
    let dx = vx - hx;
    let dy = vy - hy;
    let dz = vz - hz;
    let yaw = Math.atan2(dx, dz);
    let pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
    for (let i = 0; i < 2; i++) {
      const cp = Math.cos(-pitch);
      const sp = Math.sin(-pitch);
      const y1 = eo[1] * cp - eo[2] * sp;
      const z1 = eo[1] * sp + eo[2] * cp;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      dx = vx - (hx + eo[0] * cy + z1 * sy);
      dy = vy - (hy + y1);
      dz = vz - (hz - eo[0] * sy + z1 * cy);
      yaw = Math.atan2(dx, dz);
      pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
    }
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      yaw = 0;
      pitch = 0;
    }

    // total yaw in "shuffle space", unwrapped next to where the head points now
    let desired = this.bodyYaw + yaw;
    desired = this.yawS.x + wrapPi(desired - this.yawS.x);
    const desiredPitch = clamp(pitch, PITCH_MIN, PITCH_MAX);

    // body shuffles to keep the neck within ±70°; the hat keeps the rabbit from stepping
    const busy = rx !== null && rx.delay <= 0 && (rx.name === 'topple' || isHop(rx.name));
    if (busy) {
      this.bodyYaw = damp(this.bodyYaw, 0, 4, dt);
      this.stepT = -1;
      this.stepHop = 0;
      this.stepRoll = 0;
    } else {
      const bodyTarget = clamp(clamp(0, desired - BODY_FREE, desired + BODY_FREE), -165 * DEG, 165 * DEG);
      if (tr.hat && !this.away) {
        this.bodyYaw = damp(this.bodyYaw, bodyTarget, 5, dt);
        this.stepHop = 0;
        this.stepRoll = 0;
      } else this.shuffle(bodyTarget, dt);
    }

    // springs: CFG stiffness/damping scaled by urgency (ζ ≈ 0.6 → a little overshoot)
    const speed = (0.65 + 0.95 * this.urgency) * tr.stiff;
    let k = CFG.headTurnStiffness * speed * speed;
    let c = CFG.headTurnDamping * speed;
    let yawTarget = desired;
    let pitchTarget = desiredPitch;
    if (!this.antInit) {
      this.antRef = desired;
      this.antInit = true;
    }
    const delta = wrapPi(desired - this.antRef);
    if (tr.bird) {
      // hold, snap, hold: a magpie's head moves in chirpy saccades with a cocked tilt
      this.birdHold -= dt;
      if (this.birdHold <= 0 || Math.abs(wrapPi(desired - this.birdYaw)) > 18 * DEG || Math.abs(desiredPitch - this.birdPitch) > 12 * DEG) {
        this.birdYaw = desired;
        this.birdPitch = desiredPitch;
        this.birdHold = 0.22 + this.rng.next() * 0.55;
        this.birdTilt = (this.rng.next() - 0.5) * 0.7;
        this.tailS.v += 5;
        if (Math.abs(delta) > 60 * DEG && this.rng.next() < 0.5) this.blink();
      }
      yawTarget = this.yawS.x + wrapPi(this.birdYaw - this.yawS.x);
      pitchTarget = this.birdPitch;
      k *= 2.6;
      c = 2 * Math.sqrt(k) * 0.72;
      this.antRef = desired;
    } else if (this.antT <= 0 && Math.abs(delta) > 38 * DEG) {
      if (this.urgency >= 0.9) {
        this.startle = 1; // firework bang: no wind-up, just a jolt
        this.blink();
      } else {
        // anticipation: a small counter-turn and dip before the big spin
        this.antT = 0.11 / speed;
        this.antHold = this.yawS.x;
        this.antOff = -Math.sign(delta) * Math.min(13 * DEG, 0.16 * Math.abs(delta));
        this.antDip = 1;
        if (this.rng.next() < 0.65) this.blink();
      }
      this.antRef = desired;
    }
    if (!tr.bird) this.antRef += wrapPi(desired - this.antRef) * (1 - Math.exp(-2.5 * dt));
    if (this.antT > 0) {
      this.antT -= dt;
      yawTarget = this.antHold + this.antOff;
      pitchTarget = this.pitchS.x - 3 * DEG;
    }
    this.yawS.step(yawTarget, k, c, dt);
    this.pitchS.step(pitchTarget, k, c, dt);

    // apply (Euler YXZ): reaction override fades the look out; turn/nod/tilt stay additive
    const ov = clamp(P[PK.override], 0, 1);
    const rel = clamp(this.yawS.x - this.bodyYaw, -YAW_LIMIT, YAW_LIMIT);
    this.birdTiltCur = damp(this.birdTiltCur, tr.bird ? this.birdTilt : 0, 16, dt);
    const swing = clamp(-this.yawS.v * 0.018, -0.22, 0.22);
    quatEulerYXZ(
      this.tq,
      HEAD * 4,
      -this.pitchS.x * (1 - ov) + P[PK.nod],
      rel * (1 - ov) + P[PK.turn],
      (swing + this.birdTiltCur) * (1 - ov) + P[PK.tilt],
    );
    this.composeHead();
  }

  private shuffle(target: number, dt: number): void {
    const bird = this.tr.bird;
    if (this.stepT < 0) {
      const err = target - this.bodyYaw;
      if (Math.abs(err) <= 9 * DEG) {
        this.stepHop = 0;
        this.stepRoll = 0;
        return;
      }
      this.stepFrom = this.bodyYaw;
      this.stepTo = this.bodyYaw + clamp(err, -40 * DEG, 40 * DEG);
      this.stepT = 0;
      this.stepSide = -this.stepSide;
    }
    this.stepT = Math.min(1, this.stepT + dt / (STEP_TIME * (bird ? 0.8 : 1)));
    const s = this.stepT;
    this.bodyYaw = lerp(this.stepFrom, this.stepTo, easeInOut(s));
    const h = Math.sin(Math.PI * s);
    this.stepHop = (bird ? 0.0055 : 0.0032) * h;
    this.stepRoll = this.stepSide * 0.07 * h;
    if (this.stepT >= 1) this.stepT = -1;
  }

  private blink(): void {
    if (this.blinkT < 0) this.blinkT = 0;
  }

  private blinkAmount(dt: number): number {
    this.blinkNext -= dt;
    if (this.blinkNext <= 0) {
      this.blink();
      if (this.blinkAgain) {
        this.blinkAgain = false;
        this.blinkNext = 2 + this.rng.next() * 4;
      } else {
        this.blinkAgain = this.rng.next() < 0.18;
        this.blinkNext = this.blinkAgain ? 0.3 : 2 + this.rng.next() * 4;
      }
    }
    if (this.blinkT < 0) return 0;
    this.blinkT += dt;
    const T = this.blinkT;
    if (T >= 0.24) {
      this.blinkT = -1;
      return 0;
    }
    const a = T < 0.065 ? T / 0.065 : T < 0.1 ? 1 : 1 - (T - 0.1) / 0.14;
    return easeInOut(a);
  }

  // ------------------------------------------------------------------------------------------- face
  private poseFace(dt: number): void {
    const P = this.P;
    const t = this.time;
    const tq = this.tq;
    const ts = this.ts;

    // eyes lead the head: each pupil aims straight at the target (they converge on near targets)
    const lr = this.lookR;
    xformPoint(this.iHead, lr[0], lr[1], lr[2], _p);
    const cl = this.eyeCL;
    const cr = this.eyeCR;
    const lx = _p[0] - cl[0];
    const ly = _p[1] - cl[1];
    const lz = _p[2] - cl[2];
    const rX = _p[0] - cr[0];
    const rY = _p[1] - cr[1];
    const rZ = _p[2] - cr[2];
    let tyL = clamp(Math.atan2(lx, lz), -0.62, 0.62);
    let tpL = clamp(Math.atan2(ly, Math.sqrt(lx * lx + lz * lz)), -0.5, 0.5);
    let tyR = clamp(Math.atan2(rX, rZ), -0.62, 0.62);
    let tpR = clamp(Math.atan2(rY, Math.sqrt(rX * rX + rZ * rZ)), -0.5, 0.5);
    if (!Number.isFinite(tyL + tpL + tyR + tpR)) tyL = tpL = tyR = tpR = 0;
    const away = clamp(P[PK.eyeAway], 0, 1);
    if (away > 0) {
      tyL = lerp(tyL, this.tiltDir * 0.42, away);
      tyR = lerp(tyR, this.tiltDir * 0.42, away);
      tpL = lerp(tpL, -0.4, away);
      tpR = lerp(tpR, -0.4, away);
    }
    const dz = clamp(P[PK.dizzy], 0, 1);
    if (dz > 0) {
      const a = t * 11;
      tyL = lerp(tyL, Math.cos(a) * 0.45, dz);
      tpL = lerp(tpL, Math.sin(a) * 0.4, dz);
      tyR = lerp(tyR, Math.cos(-a + 1.3) * 0.45, dz);
      tpR = lerp(tpR, Math.sin(-a + 1.3) * 0.4, dz);
    }
    const er = dz > 0 ? 60 : 30;
    this.eyeYL = damp(this.eyeYL, tyL, er, dt);
    this.eyePL = damp(this.eyePL, tpL, er, dt);
    this.eyeYR = damp(this.eyeYR, tyR, er, dt);
    this.eyePR = damp(this.eyePR, tpR, er, dt);
    const ps = clamp(1 + P[PK.pupil] + 0.08 * P[PK.wide], 0.65, 1.45);
    quatEulerYXZ(tq, EYE_L * 4, -this.eyePL, this.eyeYL, 0);
    quatEulerYXZ(tq, EYE_R * 4, -this.eyePR, this.eyeYR, 0);
    put3(ts, EYE_L, ps, ps, 1);
    put3(ts, EYE_R, ps, ps, 1);

    // lids: blinks, moods, wide eyes; upper lids follow a downward gaze; brows via lid tilt
    const blink = this.blinkAmount(dt);
    const lookDown = clamp(-(this.eyePL + this.eyePR) * 0.1, 0, 0.1);
    const wide = clamp(P[PK.wide], 0, 1.2);
    const base = P[PK.lidClose] + lookDown - wide * 0.38;
    const squint = this.mSus * 0.14 * this.tiltDir;
    const cL = clamp(Math.max(blink, base + squint), -0.45, 1);
    const cR = clamp(Math.max(blink, base - squint), -0.45, 1);
    const tilt = clamp(P[PK.lidTilt], -0.6, 0.6);
    // hinge about each eye's own corner axis, brow tilt about its facing axis
    const hL = this.hingeL;
    const hR = this.hingeR;
    const fL = this.faceL;
    const fR = this.faceR;
    quatAxisAngle(tq, LID_L * 4, hL[0], hL[1], hL[2], cL * this.lidClose);
    quatAxisAngle(_q, 0, fL[0], fL[1], fL[2], tilt);
    quatMul(tq, LID_L * 4, _q[0], _q[1], _q[2], _q[3]);
    quatAxisAngle(tq, LID_R * 4, hR[0], hR[1], hR[2], cR * this.lidClose);
    quatAxisAngle(_q, 0, fR[0], fR[1], fR[2], -tilt);
    quatMul(tq, LID_R * 4, _q[0], _q[1], _q[2], _q[3]);
    const rise = clamp(P[PK.lidLow] + blink * 0.2 - wide * 0.3, -0.4, 1);
    quatAxisAngle(tq, LOW_L * 4, hL[0], hL[1], hL[2], -rise * this.lidRise);
    quatAxisAngle(tq, LOW_R * 4, hR[0], hR[1], hR[2], -rise * this.lidRise);

    // mouth "O", magpie beak, blush
    const mo = clamp(P[PK.mouth], 0, 1.3);
    const ms = mo < 0.02 ? 0.0001 : 0.3 + 0.7 * mo;
    put3(ts, MOUTH, ms, ms * (0.8 + 0.3 * mo), ms);
    const bk = clamp(Math.max(P[PK.beak], 0), 0, 1.2);
    quatEulerXYZ(tq, JAW * 4, bk * 0.5, 0, 0);
    const bl = clamp(P[PK.blush], 0, 1.2);
    const bs = bl < 0.02 ? 0.0001 : easeOutBack(Math.min(1, bl * 1.2), 2.2) * (0.85 + 0.15 * bl);
    put3(ts, CHEEK_L, bs, bs, bs);
    put3(ts, CHEEK_R, bs, bs, bs);

    // nose twitch (the rabbit's never stops for long)
    const nr = this.noseRest;
    if (this.kind === 'rabbit') {
      const tw = Math.max(0, Math.sin(t * 0.9 + this.seed)) ** 6;
      put3(this.tp, NOSE, nr[0], nr[1] + Math.sin(t * 46) * 0.00045 * tw, nr[2]);
      const ns = 1 + Math.sin(t * 46) * 0.06 * tw;
      put3(ts, NOSE, ns, ns, ns);
    } else {
      put3(this.tp, NOSE, nr[0], nr[1], nr[2]);
    }
  }

  // ------------------------------------------------------------------------------------------ limbs
  private poseLimbs(dt: number): void {
    const P = this.P;
    const tr = this.tr;
    const t = this.time;
    const tp = this.tp;
    const tq = this.tq;

    // head vertical acceleration (world) drives floppy ears and tail
    const m = this.mHead;
    const w = this.frame.m;
    const headY = w[1] * m[12] + w[5] * m[13] + w[9] * m[14] + w[13];
    let jig = 0;
    if (this.hasPrevHead) {
      const vy = (headY - this.prevHeadY) / dt;
      jig = clamp((vy - this.prevVelY) / dt, -40, 40);
      this.prevVelY = vy;
    } else this.hasPrevHead = true;
    this.prevHeadY = headY;

    const earT = clamp(P[PK.ears], -0.6, 1.4) - 0.35 * clamp(P[PK.earPerk], 0, 1.5);
    this.earSL.v += jig * 9 * tr.earFlop * dt;
    this.earSR.v += jig * 9 * tr.earFlop * dt;
    const kE = tr.earFlop > 1.5 ? 110 : 170;
    const cE = tr.earFlop > 1.5 ? 5 : 7.5;
    const eL = this.earSL.step(earT + P[PK.earL], kE, cE, dt);
    const eR = this.earSR.step(earT + P[PK.earR], kE, cE, dt);
    const sway = clamp(this.yawS.v * 0.03, -0.35, 0.35) * (tr.earFlop > 1.5 ? 1.6 : 1);
    const perk = clamp(P[PK.earPerk], 0, 1.5);
    quatEulerXYZ(tq, EAR_L * 4, -eL * 0.55 + perk * 0.22, 0, -eL * 0.85 + sway);
    quatEulerXYZ(tq, EAR_R * 4, -eR * 0.55 + perk * 0.22, 0, eR * 0.85 + sway);

    this.tailS.v += jig * 6 * tr.tailFlop * dt;
    const tl = this.tailS.step(clamp(P[PK.tailLift], -1, 1.5), 120, 6, dt);
    quatEulerXYZ(tq, TAIL * 4, -tl * 0.5, clamp(P[PK.tailWag], -1.6, 1.6) * 0.7, 0);

    // arms: euler offsets, blended toward an aim direction when a reaction points somewhere
    const aimLv = this.RP[PK.aimL] > 0 || this.fadeW <= 0 ? this.aimL : this.fadeAimL;
    const aimRv = this.RP[PK.aimR] > 0 || this.fadeW <= 0 ? this.aimR : this.fadeAimR;
    this.poseArm(ARM_L, 1, P[PK.armLSwing], P[PK.armLRaise], P[PK.armLTwist], clamp(P[PK.aimL], 0, 1), aimLv, this.armDirL);
    this.poseArm(ARM_R, -1, P[PK.armRSwing], P[PK.armRRaise], P[PK.armRTwist], clamp(P[PK.aimR], 0, 1), aimRv, this.armDirR);

    const reach = 1 + 0.34 * clamp(P[PK.reach], 0, 1);
    const hl = this.handLRest;
    const hr = this.handRRest;
    put3(tp, HAND_L, hl[0] * reach, hl[1] * reach, hl[2] * reach);
    let pencilX = hr[0] * reach;
    let pencilY = hr[1] * reach;
    let pencilRoll = 0;
    if (this.kind === 'badger') {
      // Brock's pencil hand scribbles
      const sc = clamp(P[PK.scribble], 0, 1);
      if (sc > 0) {
        const a = t * 27;
        pencilX += (0.0035 + Math.cos(a) * 0.0024) * sc;
        pencilY += Math.sin(a * 1.31) * 0.0017 * sc;
        pencilRoll = Math.sin(a) * 0.25 * sc;
      }
    }
    put3(tp, HAND_R, pencilX, pencilY, hr[2] * reach);
    quatEulerXYZ(tq, HAND_L * 4, P[PK.handL] * 0.6, 0, 0);
    quatEulerXYZ(tq, HAND_R * 4, P[PK.handR] * 0.6, 0, pencilRoll);
  }

  private poseArm(slot: number, side: number, swing: number, raise: number, twist: number, aimW: number, aim: Float64Array, rest: Float64Array): void {
    const tq = this.tq;
    const o = slot * 4;
    quatEulerXYZ(tq, o, -swing, twist * side, raise * side);
    if (aimW > 0.001) {
      let ax = aim[0];
      let ay = aim[1];
      let az = aim[2];
      if (ax * ax + ay * ay + az * az < 1e-8) {
        ax = 0;
        ay = -1;
        az = 0;
      }
      const k = 1 / (Math.sqrt(ax * ax + ay * ay + az * az) || 1);
      ax *= k;
      ay *= k;
      az *= k;
      quatFromUnitVectors(_q, 0, rest[0], rest[1], rest[2], ax, ay, az);
      quatSlerp(tq, o, _q[0], _q[1], _q[2], _q[3], aimW);
    }
  }

  // ---------------------------------------------------------------------------------------- overlays
  private overlays(dt: number): void {
    // eye glyph: pop spring + three-frame flip between open and closed
    const want = this.glyphState === 'hidden' ? 0 : 1;
    if (dt > 0) this.glyphPop.step(want, 300, 17, dt);
    const pop = Math.max(0, this.glyphPop.x);
    if (this.glyphAnim >= 0 && dt > 0) {
      this.glyphAnim = Math.min(1, this.glyphAnim + dt / 0.2);
      const k = this.glyphAnim;
      const cell = k < 0.34 ? this.glyphFrom : k < 0.67 ? 1 : this.glyphTo;
      if (cell !== this.glyphCell) {
        this.glyphCell = cell;
        setGlyphCell(this.glyphGeo, cell);
      }
      if (k >= 1) this.glyphAnim = -1;
    }
    const glyphOn = pop > 0.02;
    this.glyph.visible = glyphOn;
    if (glyphOn) {
      // above the head along world up (expressed in root space), bobbing gently
      const m = this.mHead;
      const fi = this.frame.inv;
      const up = this.glyphY * this.scale + 0.0025 * Math.sin(this.time * 2.4 + this.seed);
      const s = GLYPH_SIZE * pop;
      const te = this.glyph.matrix.elements;
      te[0] = s;
      te[1] = 0;
      te[2] = 0;
      te[3] = 0;
      te[4] = 0;
      te[5] = s;
      te[6] = 0;
      te[7] = 0;
      te[8] = 0;
      te[9] = 0;
      te[10] = s;
      te[11] = 0;
      te[12] = m[12] + fi[4] * up;
      te[13] = m[13] + fi[5] * up;
      te[14] = m[14] + fi[6] * up;
      te[15] = 1;
      this.glyph.matrixWorldNeedsUpdate = true;
    }

    // sight cone: follows the head's yaw, fades when facing away from the mat, pulses red on alarm
    if (dt > 0) {
      this.coneVis = damp(this.coneVis, this.coneOn && !this.away ? 1 : 0, 8, dt);
      this.alarm = damp(this.alarm, this.alarmOn ? 1 : 0, 10, dt);
    }
    if (this.coneVis < 0.01) {
      this.cone.visible = false;
      return;
    }
    const m = this.mHead; // head forward = its +Z column, already in root space
    let fx = m[8];
    let fy = m[9];
    let fz = m[10];
    const fk = 1 / (Math.sqrt(fx * fx + fy * fy + fz * fz) || 1);
    fx *= fk;
    fy *= fk;
    fz *= fk;
    const h = Math.sqrt(fx * fx + fz * fz);
    const fwd = h > 1e-4 ? fz / h : 0;
    const facing = smoothstep(-0.05, 0.45, fwd) * (1 - smoothstep(0.2, 0.6, fy));
    const a = CONE_ALPHA * this.coneVis * Math.max(facing, this.alarm);
    const u = this.coneU;
    u[CONE_OPACITY] = a;
    u[CONE_ALARM] = this.alarm;
    u[CONE_TIME] = this.time;
    u[CONE_HALF] = this.halfAngle;
    const on = a > 0.003;
    this.cone.visible = on;
    if (!on) return;
    // T(0, y, z) · Ry(yaw) · S(len, 1, len), at the rig-local cone height
    const yaw = Math.atan2(fx, fz);
    const c = Math.cos(yaw) * CONE_LEN;
    const s = Math.sin(yaw) * CONE_LEN;
    const te = this.cone.matrix.elements;
    te[0] = c;
    te[1] = 0;
    te[2] = -s;
    te[3] = 0;
    te[4] = 0;
    te[5] = 1;
    te[6] = 0;
    te[7] = 0;
    te[8] = s;
    te[9] = 0;
    te[10] = c;
    te[11] = 0;
    te[12] = 0;
    te[13] = this.coneHeight();
    te[14] = this.coneZ;
    te[15] = 1;
    this.cone.matrixWorldNeedsUpdate = true;
  }

  /**
   * Root-space y that puts the cone origin (0, y, coneZ) at rig-local height CONE_Y, wherever the root is parented
   * (seat on the riser, the rabbit's hat on the cloth, a hop): solves rigLocalY(rootWorld · p) = CONE_Y. Falls back
   * to the layout-derived offset when no StageRig is above the root.
   */
  private coneHeight(): number {
    const rig = this.rigNode;
    if (rig) {
      this.rigFrame.sync(rig.matrixWorld.elements);
      const ri = this.rigFrame.inv;
      const w = this.frame.m;
      const z = this.coneZ;
      const A = ri[1] * w[4] + ri[5] * w[5] + ri[9] * w[6];
      const B = ri[1] * (w[8] * z + w[12]) + ri[5] * (w[9] * z + w[13]) + ri[9] * (w[10] * z + w[14]) + ri[13];
      if (A > 0.3) return (CONE_Y - B) / A;
    }
    return this.coneY0;
  }
}
