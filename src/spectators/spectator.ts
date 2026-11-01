// The felt-puppet Spectator (implements contracts.Spectator).
//
// Hierarchy:  root (game-owned placement, named <id>)
//               ├ stage (instance scale) ── bones + 2 SkinnedMeshes (felt, gloss) sharing one skeleton
//               ├ glyph (Sprite, shared atlas)            <id>-glyph
//               └ cone  (flat fan on the cloth)           <id>-cone
// The root never moves: hops move the internal 'root' bone, so the game's seat parenting stays intact.
import {
  Group,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Sprite,
  Vector3,
  type Bone,
  type BufferGeometry,
  type Material,
  type ShaderMaterial,
  type SpriteMaterial,
} from '@iwsdk/core';
import { SPECTATOR_ACCENT } from '../art/palette.js';
import { CFG } from '../config.js';
import type { ReactionName, Spectator, SpectatorAnchor, SpectatorKind } from '../contracts.js';
import { L } from '../layout.js';
import { makeBoneInverses, makeBones } from './builder.js';
import { acquireDesign, releaseDesign, type PuppetDesign } from './designs/index.js';
import { HAT } from './designs/rabbit.js';
import {
  acquireShared,
  coneMaterial,
  glyphGeometry,
  glyphMaterial,
  releaseShared,
  setGlyphCell,
  type SharedResources,
} from './materials.js';
import { DEG, Spring, clamp, damp, easeInOut, easeOutBack, lerp, makeRng, seg, smoothstep, wrapPi } from './math.js';
import { PK, addPose, makePose } from './pose.js';
import { HOP, LOOPING, REACTION_DURATION, STAGGERED, poseReaction, type ReactionCtx } from './reactions.js';

export type Mood = 'neutral' | 'eyeContact' | 'flustered' | 'suspicious';
type GlyphState = 'open' | 'closed' | 'hidden';

const BONE_NAMES = [
  'root', 'hat', 'body', 'chest', 'tail', 'head', 'earL', 'earR', 'mouth', 'jaw', 'cheekL', 'cheekR', 'nose',
  'armL', 'armR', 'handL', 'handR', 'eyeL', 'eyeR', 'lidL', 'lidR', 'lowL', 'lowR',
] as const;
type BoneName = (typeof BONE_NAMES)[number];
const ANCHORS: SpectatorAnchor[] = ['eyes', 'head', 'ear', 'hand', 'notebook', 'beak', 'hatTop'];

/** Seat feet stand this far above the cloth (the riser). */
const RISER_DROP = L.riser.topY - L.tableY;
/** Cone height above the tabletop: over the mat (+3 mm), under the props (+6 mm). */
export const CONE_LIFT = 0.0045;
const CONE_SEATED = new Vector3(0, L.tableY + CONE_LIFT - L.riser.topY, L.riser.z + L.riser.depth / 2 - L.seats[0][2]);
const CONE_LEN = 0.34;
const CONE_ALPHA = 0.17;
const GLYPH_SIZE = 0.024;
const YAW_LIMIT = 110 * DEG;
const BODY_FREE = 70 * DEG;
const PITCH_MIN = -45 * DEG;
const PITCH_MAX = 50 * DEG;
const STEP_TIME = 0.14;

const IDENTITY = new Matrix4();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _q1 = new Quaternion();
const _q2 = new Quaternion();
const _m1 = new Matrix4();

interface Active {
  name: ReactionName;
  t: number;
  dur: number;
  delay: number;
  I: number;
  seed: number;
  hasTarget: boolean;
  target: Vector3; // world
  resolve: () => void;
  from: Vector3; // hop endpoints (stage space)
  to: Vector3;
  fromYaw: number;
  dirYaw: number;
  arc: number;
  prevMood: Mood | null;
}

const isHop = (n: ReactionName) => n === 'hopToVolunteer' || n === 'hopBack';

function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class PuppetSpectator implements Spectator {
  readonly id: string;
  readonly kind: SpectatorKind;
  readonly root: Group;
  readonly headRadius: number;

  private readonly d: PuppetDesign;
  private readonly res: SharedResources;
  private readonly stage = new Group();
  private readonly bones: Bone[];
  private readonly B: Record<BoneName, Bone>;
  private readonly skeleton: Skeleton;
  private readonly glyph: Sprite;
  private readonly glyphMat: SpriteMaterial;
  private readonly glyphGeo: BufferGeometry;
  private readonly cone: Mesh;
  private readonly coneMat: ShaderMaterial;
  private readonly anchors: Record<SpectatorAnchor, Object3D>;
  private readonly rng: () => number;
  private readonly scale: number;
  private readonly seed: number;
  private readonly tiltDir: number;

  // rest data
  private readonly chestRest = new Vector3();
  private readonly tailRest = new Vector3();
  private readonly handLRest = new Vector3();
  private readonly handRRest = new Vector3();
  private readonly noseRest = new Vector3();
  private readonly armDirL = new Vector3();
  private readonly armDirR = new Vector3();
  private readonly eyeOff = new Vector3();
  private readonly eyeCL = new Vector3();
  private readonly eyeCR = new Vector3();
  private readonly home = new Vector3();
  private readonly hingeL = new Vector3();
  private readonly hingeR = new Vector3();
  private readonly faceL = new Vector3();
  private readonly faceR = new Vector3();

  // clocks & flags
  private time = 0;
  private frozen = false;
  private disposed = false;
  private warned = false;

  // look
  private readonly target = new Vector3();
  private hasTarget = false;
  private urgency = 0.5;
  private readonly lookWorld = new Vector3();
  private readonly idleLocal = new Vector3(0, -0.03, 0.26);
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
  private readonly base = new Vector3();
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
  private readonly aimL = new Vector3(0, -1, 0);
  private readonly aimR = new Vector3(0, -1, 0);
  private readonly fadeAimL = new Vector3(0, -1, 0);
  private readonly fadeAimR = new Vector3(0, -1, 0);
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
    this.rng = makeRng(this.seed);
    this.d = acquireDesign(kind, this.seed % 3);
    this.res = acquireShared();
    this.scale = opts.scale && opts.scale > 0 ? opts.scale : 1;
    this.headRadius = this.d.headRadius * this.scale;
    this.tiltDir = this.rng() < 0.5 ? -1 : 1;
    const accent = opts.accent ?? SPECTATOR_ACCENT[kind];

    this.root = new Group();
    this.root.name = this.id;
    this.stage.name = `${this.id}-puppet`;
    this.stage.scale.setScalar(this.scale);
    this.root.add(this.stage);

    // skeleton + the two skinned meshes
    this.bones = makeBones(this.d.defs);
    const byName = new Map<string, Bone>();
    for (const b of this.bones) {
      byName.set(b.name, b);
      b.name = `${this.id}.${b.name}`;
      if (!b.parent) this.stage.add(b);
    }
    const B = {} as Record<BoneName, Bone>;
    for (const n of BONE_NAMES) {
      const b = byName.get(n);
      if (!b) throw new Error(`[spectators] design ${this.d.key} lacks bone "${n}"`);
      B[n] = b;
    }
    this.B = B;
    this.skeleton = new Skeleton(this.bones, makeBoneInverses(this.d.defs));
    this.skinned(this.d.felt, this.res.felt, 'felt');
    this.skinned(this.d.gloss, this.res.gloss, 'gloss');
    B.root.rotation.order = 'YXZ';
    B.head.rotation.order = 'YXZ';
    B.eyeL.rotation.order = 'YXZ';
    B.eyeR.rotation.order = 'YXZ';

    // anchors (named "<id>-<anchor>")
    const defPos = (n: string) => this.d.defs.find((x) => x.name === n)!.pos;
    const anchors = {} as Record<SpectatorAnchor, Object3D>;
    for (const name of ANCHORS) {
      const a = this.d.anchors[name];
      const o = new Object3D();
      o.name = `${this.id}-${name}`;
      const bp = defPos(a.bone);
      const p = name === 'eyes' ? [0, (this.d.eyeL[1] + this.d.eyeR[1]) / 2, (this.d.eyeL[2] + this.d.eyeR[2]) / 2] : a.p;
      o.position.set(p[0] - bp[0], p[1] - bp[1], p[2] - bp[2]);
      byName.get(a.bone)!.add(o);
      anchors[name] = o;
    }
    this.anchors = anchors;

    // rest data
    this.chestRest.copy(B.chest.position);
    this.tailRest.copy(B.tail.position);
    this.handLRest.copy(B.handL.position);
    this.handRRest.copy(B.handR.position);
    this.noseRest.copy(B.nose.position);
    const hp = defPos('head');
    const eL = this.d.eyeL;
    const eR = this.d.eyeR;
    this.eyeCL.set(eL[0] - hp[0], eL[1] - hp[1], eL[2] - hp[2]);
    this.eyeCR.set(eR[0] - hp[0], eR[1] - hp[1], eR[2] - hp[2]);
    this.eyeOff.set(0, (eL[1] + eR[1]) / 2 - hp[1], (eL[2] + eR[2]) / 2 - hp[2]);
    const aL = defPos('armL');
    const hL = defPos('handL');
    const aR = defPos('armR');
    const hR = defPos('handR');
    this.armDirL.set(hL[0] - aL[0], hL[1] - aL[1], hL[2] - aL[2]).normalize();
    this.armDirR.set(hR[0] - aR[0], hR[1] - aR[1], hR[2] - aR[2]).normalize();
    this.home.set(0, this.d.restLift, 0);
    const ey = this.d.eyeYaw;
    this.hingeL.set(Math.cos(ey), 0, -Math.sin(ey));
    this.faceL.set(Math.sin(ey), 0, Math.cos(ey));
    this.hingeR.set(Math.cos(ey), 0, Math.sin(ey));
    this.faceR.set(-Math.sin(ey), 0, Math.cos(ey));
    this.base.copy(this.home);

    // eye glyph (shared atlas; per-instance tint and UVs)
    this.glyphGeo = glyphGeometry();
    this.glyphMat = glyphMaterial(this.res.atlas, accent);
    this.glyph = new Sprite(this.glyphMat);
    this.glyph.geometry = this.glyphGeo;
    this.glyph.name = `${this.id}-glyph`;
    this.glyph.renderOrder = 3;
    this.glyph.visible = false;
    this.root.add(this.glyph);

    // sight cone on the cloth, from the riser's front edge (or the hat's brim)
    this.coneMat = coneMaterial(accent);
    this.cone = new Mesh(this.res.coneGeo, this.coneMat);
    this.cone.name = `${this.id}-cone`;
    this.cone.renderOrder = 1;
    this.cone.visible = false;
    this.cone.frustumCulled = false;
    if (this.d.traits.hat) this.cone.position.set(0, CONE_LIFT, HAT.brim * this.scale + 0.004);
    else this.cone.position.copy(CONE_SEATED);
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
      target: new Vector3(0, 0, 1),
      hasTarget: false,
      aimL: this.aimL,
      aimR: this.aimR,
    };
    this.blinkNext = 0.8 + this.rng() * 3;
    this.flickTimer = 1.5 + this.rng() * 4;
    this.fidgetTimer = 4 + this.rng() * 6;
    this.pickIdleTarget();
    this.step(1 / 60);
  }

  // ------------------------------------------------------------------------------------- contract API
  getEyeWorldPosition(out: Vector3): Vector3 {
    return this.anchors.eyes.getWorldPosition(out);
  }

  getLookDirection(out: Vector3): Vector3 {
    out.setFromMatrixColumn(this.B.head.matrixWorld, 2);
    const l = out.length();
    return l > 1e-8 ? out.multiplyScalar(1 / l) : out.set(0, 0, 1);
  }

  getAnchor(name: SpectatorAnchor): Object3D {
    return this.anchors[name] ?? this.anchors.head;
  }

  lookAt(target: Vector3 | null, opts?: { urgency?: number }): void {
    if (target) {
      this.target.copy(target);
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
      const rx: Active = {
        name,
        t: 0,
        dur,
        delay: STAGGERED.has(name) ? this.rng() * 0.12 : 0,
        I: clamp(opts.intensity ?? 1, 0, 2),
        seed: this.rng(),
        hasTarget: false,
        target: new Vector3(),
        resolve,
        from: new Vector3(),
        to: new Vector3(),
        fromYaw: 0,
        dirYaw: 0,
        arc: 0,
        prevMood: null,
      };
      if (opts.target) {
        rx.hasTarget = true;
        rx.target.copy(opts.target);
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

  /** Not in the contract: match the drawn cone to the active rule (Easy Audience halves it). */
  setSightHalfAngle(deg: number): void {
    this.halfAngle = clamp(deg, 2, 30) * DEG;
  }

  update(dt: number, _time: number): void {
    if (this.disposed) return;
    try {
      const h = Math.min(Math.max(dt, 0), 0.1);
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
    this.stage.add(m);
    m.bind(this.skeleton, IDENTITY);
    return m;
  }

  private step(dt: number): void {
    this.time += dt;
    const P = this.P;
    const B = this.B;
    P.fill(0);

    // moods ease in and out
    const mk = 1 - Math.exp(-6 * dt);
    this.mEye += ((this.mood === 'eyeContact' ? 1 : 0) - this.mEye) * mk;
    this.mFlu += ((this.mood === 'flustered' ? 1 : 0) - this.mFlu) * mk;
    this.mSus += ((this.mood === 'suspicious' ? 1 : 0) - this.mSus) * mk;

    // reaction layer
    this.RP.fill(0);
    this.aimL.set(0, -1, 0);
    this.aimR.set(0, -1, 0);
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

    // ---- mover: placement + reaction offsets + shuffle bounce, leaning about pivotZ
    const root = B.root;
    root.position.set(this.base.x + P[PK.x], this.base.y + P[PK.y] + this.stepHop, this.base.z + P[PK.z]);
    root.rotation.set(P[PK.lean], this.baseYaw + this.bodyYaw + P[PK.yaw], P[PK.roll] + this.stepRoll);
    const pz = P[PK.pivotZ];
    if (pz !== 0) {
      _v1.set(0, 0, pz).applyQuaternion(root.quaternion);
      const yaw = root.rotation.y;
      root.position.x += pz * Math.sin(yaw) - _v1.x;
      root.position.y -= _v1.y;
      root.position.z += pz * Math.cos(yaw) - _v1.z;
    }
    const s = clamp(1 + P[PK.squash], 0.55, 1.6);
    const sxz = 1 / Math.sqrt(s);
    B.body.scale.set(sxz, s, sxz);
    B.chest.position.set(this.chestRest.x, this.chestRest.y * s, this.chestRest.z);
    B.tail.position.set(this.tailRest.x * sxz, this.tailRest.y * s, this.tailRest.z * sxz);

    this.solveLook(dt);
    this.poseFace(dt);
    this.poseLimbs(dt);
  }

  private fillReaction(rx: Active): void {
    const c = this.ctx;
    c.t = rx.t;
    c.dur = rx.dur;
    c.I = rx.I;
    c.seed = rx.seed;
    c.inHat = this.d.traits.hat && !this.away;
    c.drop = this.away || this.d.traits.hat ? 0 : RISER_DROP / this.scale;
    c.hasTarget = rx.hasTarget && !isHop(rx.name);
    if (c.hasTarget) {
      _v1.copy(rx.target);
      this.B.chest.worldToLocal(_v1);
      if (_v1.lengthSq() > 1e-10) c.target.copy(_v1).normalize();
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
    rx.from.copy(this.base);
    rx.fromYaw = facing;
    this.stage.updateWorldMatrix(true, false);
    if (rx.name === 'hopToVolunteer') {
      if (target) {
        rx.to.copy(target);
        this.stage.worldToLocal(rx.to);
      } else {
        rx.to.set(0.06, (L.volunteerSpot[1] - L.riser.topY) / this.scale, 0.27 / this.scale);
      }
    } else {
      rx.to.copy(this.home);
    }
    rx.hasTarget = true;
    rx.target.copy(rx.to);
    this.stage.localToWorld(rx.target);
    const dx = rx.to.x - rx.from.x;
    const dz = rx.to.z - rx.from.z;
    const dist = Math.hypot(dx, dz);
    rx.dirYaw = dist > 0.01 ? Math.atan2(dx, dz) : facing;
    const lip = this.d.traits.hat ? HAT.height * 0.6 : 0;
    rx.arc = (0.04 + 0.14 * dist + Math.max(0, rx.to.y - rx.from.y) + lip) * this.d.traits.hop;
  }

  private advanceHop(rx: Active): void {
    const D = rx.dur;
    const t = rx.t;
    const turnIn = easeInOut(seg(t, 0, HOP.turnEnd * D));
    const turnOut = easeInOut(seg(t, HOP.faceStart * D, HOP.faceEnd * D));
    const mid = rx.fromYaw + wrapPi(rx.dirYaw - rx.fromYaw);
    this.baseYaw = lerp(lerp(rx.fromYaw, mid, turnIn), 0, turnOut);
    const p = seg(t, HOP.takeoff * D, HOP.land * D);
    this.base.lerpVectors(rx.from, rx.to, p);
    this.base.y += rx.arc * 4 * p * (1 - p);
  }

  private endReaction(): void {
    const rx = this.rx;
    if (!rx) return;
    this.rx = null;
    const w = rx.delay > 0 ? 0 : this.rxW;
    for (let i = 0; i < PK.COUNT; i++) this.FP[i] = this.RP[i] * w;
    this.fadeAimL.copy(this.aimL);
    this.fadeAimR.copy(this.aimR);
    this.fadeW = w > 0 ? 1 : 0;
    this.rxW = 0;
    if (isHop(rx.name)) {
      this.base.copy(rx.to);
      this.baseYaw = 0;
      this.away = rx.to.distanceToSquared(this.home) > 0.0004;
    }
    if (rx.prevMood !== null && this.mood === 'flustered') this.mood = rx.prevMood;
    rx.resolve();
  }

  private pickIdleTarget(): void {
    const r = this.rng;
    if (this.d.traits.hat) {
      if (r() < 0.35) this.idleLocal.set(-0.2, 0.3, 0.45);
      else this.idleLocal.set(-0.22 + (r() - 0.5) * 0.2, 0.004, 0.02 + r() * 0.12);
    } else if (r() < 0.28) {
      this.idleLocal.set((r() - 0.5) * 0.1, 0.26, 0.66);
    } else {
      this.idleLocal.set((r() - 0.5) * 0.24, -0.035, 0.18 + r() * 0.14);
    }
    this.idleTimer = 1.2 + r() * 2.6;
  }

  private idleLayer(dt: number): void {
    const P = this.P;
    const t = this.time;
    const tr = this.d.traits;
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
      this.flickTimer = 2.5 + this.rng() * 5;
      (this.rng() < 0.5 ? this.earSL : this.earSR).v += 7 + this.rng() * 5;
    }
    if (!this.hasTarget) {
      this.idleTimer -= dt;
      if (this.idleTimer <= 0) this.pickIdleTarget();
    }

    // character fidgets (only while no reaction owns the arms)
    this.fidgetTimer -= dt;
    if (this.fidgetTimer <= 0 && this.fidgetT < 0 && !this.rx) {
      this.fidgetT = 0;
      this.fidgetTimer = 6 + this.rng() * 7;
    }
    if (this.fidgetT >= 0) {
      this.fidgetT += dt;
      const f = this.fidgetT;
      if (this.kind === 'badger') {
        // taps his monocle with the pencil's end, harrumphs
        const w = clamp(Math.min(f / 0.3, (1.5 - f) / 0.35), 0, 1);
        if (this.RP[PK.aimR] <= 0) {
          this.aimR.set(0.32, 0.86, 0.38);
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
    const B = this.B;
    const tr = this.d.traits;
    const rx = this.rx;

    // where to look: reaction target > lookAt target > idle glance
    if (rx && rx.hasTarget && rx.delay <= 0 && (this.RP[PK.lookTarget] > 0 || (isHop(rx.name) && rx.t < HOP.land * rx.dur))) {
      this.lookWorld.copy(rx.target);
    } else if (this.hasTarget) {
      this.lookWorld.copy(this.target);
    } else {
      this.lookWorld.copy(this.idleLocal);
      this.root.localToWorld(this.lookWorld);
    }

    // head yaw/pitch in the chest frame, solved from the eye midpoint (two fixed-point passes)
    B.chest.updateWorldMatrix(true, false);
    _v1.copy(this.lookWorld);
    B.chest.worldToLocal(_v1);
    const hp = B.head.position;
    const eo = this.eyeOff;
    let dx = _v1.x - hp.x;
    let dy = _v1.y - hp.y;
    let dz = _v1.z - hp.z;
    let yaw = Math.atan2(dx, dz);
    let pitch = Math.atan2(dy, Math.hypot(dx, dz));
    for (let i = 0; i < 2; i++) {
      const cp = Math.cos(-pitch);
      const sp = Math.sin(-pitch);
      const y1 = eo.y * cp - eo.z * sp;
      const z1 = eo.y * sp + eo.z * cp;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      dx = _v1.x - (hp.x + eo.x * cy + z1 * sy);
      dy = _v1.y - (hp.y + y1);
      dz = _v1.z - (hp.z - eo.x * sy + z1 * cy);
      yaw = Math.atan2(dx, dz);
      pitch = Math.atan2(dy, Math.hypot(dx, dz));
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
        this.birdHold = 0.22 + this.rng() * 0.55;
        this.birdTilt = (this.rng() - 0.5) * 0.7;
        this.tailS.v += 5;
        if (Math.abs(delta) > 60 * DEG && this.rng() < 0.5) this.blink();
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
        if (this.rng() < 0.65) this.blink();
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

    // apply: reaction override fades the look out; turn/nod/tilt stay additive
    const ov = clamp(P[PK.override], 0, 1);
    const rel = clamp(this.yawS.x - this.bodyYaw, -YAW_LIMIT, YAW_LIMIT);
    this.birdTiltCur = damp(this.birdTiltCur, tr.bird ? this.birdTilt : 0, 16, dt);
    const swing = clamp(-this.yawS.v * 0.018, -0.22, 0.22);
    B.head.rotation.set(
      -this.pitchS.x * (1 - ov) + P[PK.nod],
      rel * (1 - ov) + P[PK.turn],
      (swing + this.birdTiltCur) * (1 - ov) + P[PK.tilt],
    );
  }

  private shuffle(target: number, dt: number): void {
    const bird = this.d.traits.bird;
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
        this.blinkNext = 2 + this.rng() * 4;
      } else {
        this.blinkAgain = this.rng() < 0.18;
        this.blinkNext = this.blinkAgain ? 0.3 : 2 + this.rng() * 4;
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
    const B = this.B;
    const d = this.d;
    const t = this.time;

    // eyes lead the head: each pupil aims straight at the target (they converge on near targets)
    B.head.updateWorldMatrix(false, false);
    _v2.copy(this.lookWorld);
    B.head.worldToLocal(_v2);
    const cl = this.eyeCL;
    const cr = this.eyeCR;
    let tyL = clamp(Math.atan2(_v2.x - cl.x, _v2.z - cl.z), -0.62, 0.62);
    let tpL = clamp(Math.atan2(_v2.y - cl.y, Math.hypot(_v2.x - cl.x, _v2.z - cl.z)), -0.5, 0.5);
    let tyR = clamp(Math.atan2(_v2.x - cr.x, _v2.z - cr.z), -0.62, 0.62);
    let tpR = clamp(Math.atan2(_v2.y - cr.y, Math.hypot(_v2.x - cr.x, _v2.z - cr.z)), -0.5, 0.5);
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
    B.eyeL.rotation.set(-this.eyePL, this.eyeYL, 0);
    B.eyeR.rotation.set(-this.eyePR, this.eyeYR, 0);
    B.eyeL.scale.set(ps, ps, 1);
    B.eyeR.scale.set(ps, ps, 1);

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
    B.lidL.quaternion.setFromAxisAngle(this.hingeL, cL * d.lidClose).multiply(_q2.setFromAxisAngle(this.faceL, tilt));
    B.lidR.quaternion.setFromAxisAngle(this.hingeR, cR * d.lidClose).multiply(_q2.setFromAxisAngle(this.faceR, -tilt));
    const rise = clamp(P[PK.lidLow] + blink * 0.2 - wide * 0.3, -0.4, 1);
    B.lowL.quaternion.setFromAxisAngle(this.hingeL, -rise * d.lidRise);
    B.lowR.quaternion.setFromAxisAngle(this.hingeR, -rise * d.lidRise);

    // mouth "O", magpie beak, blush
    const mo = clamp(P[PK.mouth], 0, 1.3);
    const ms = mo < 0.02 ? 0.0001 : 0.3 + 0.7 * mo;
    B.mouth.scale.set(ms, ms * (0.8 + 0.3 * mo), ms);
    const bk = clamp(Math.max(P[PK.beak], 0), 0, 1.2);
    B.jaw.rotation.set(bk * 0.5, 0, 0);
    const bl = clamp(P[PK.blush], 0, 1.2);
    const bs = bl < 0.02 ? 0.0001 : easeOutBack(Math.min(1, bl * 1.2), 2.2) * (0.85 + 0.15 * bl);
    B.cheekL.scale.setScalar(bs);
    B.cheekR.scale.setScalar(bs);

    // nose twitch (the rabbit's never stops for long)
    B.nose.position.copy(this.noseRest);
    if (this.kind === 'rabbit') {
      const tw = Math.max(0, Math.sin(t * 0.9 + this.seed)) ** 6;
      B.nose.position.y += Math.sin(t * 46) * 0.00045 * tw;
      B.nose.scale.setScalar(1 + Math.sin(t * 46) * 0.06 * tw);
    }
  }

  // ------------------------------------------------------------------------------------------ limbs
  private poseLimbs(dt: number): void {
    const P = this.P;
    const B = this.B;
    const tr = this.d.traits;
    const t = this.time;

    // head vertical acceleration drives floppy ears and tail
    _v3.setFromMatrixPosition(B.head.matrixWorld);
    let jig = 0;
    if (this.hasPrevHead) {
      const vy = (_v3.y - this.prevHeadY) / dt;
      jig = clamp((vy - this.prevVelY) / dt, -40, 40);
      this.prevVelY = vy;
    } else this.hasPrevHead = true;
    this.prevHeadY = _v3.y;

    const earT = clamp(P[PK.ears], -0.6, 1.4) - 0.35 * clamp(P[PK.earPerk], 0, 1.5);
    this.earSL.v += jig * 9 * tr.earFlop * dt;
    this.earSR.v += jig * 9 * tr.earFlop * dt;
    const kE = tr.earFlop > 1.5 ? 110 : 170;
    const cE = tr.earFlop > 1.5 ? 5 : 7.5;
    const eL = this.earSL.step(earT + P[PK.earL], kE, cE, dt);
    const eR = this.earSR.step(earT + P[PK.earR], kE, cE, dt);
    const sway = clamp(this.yawS.v * 0.03, -0.35, 0.35) * (tr.earFlop > 1.5 ? 1.6 : 1);
    const perk = clamp(P[PK.earPerk], 0, 1.5);
    B.earL.rotation.set(-eL * 0.55 + perk * 0.22, 0, -eL * 0.85 + sway);
    B.earR.rotation.set(-eR * 0.55 + perk * 0.22, 0, eR * 0.85 + sway);

    this.tailS.v += jig * 6 * tr.tailFlop * dt;
    const tl = this.tailS.step(clamp(P[PK.tailLift], -1, 1.5), 120, 6, dt);
    B.tail.rotation.set(-tl * 0.5, clamp(P[PK.tailWag], -1.6, 1.6) * 0.7, 0);

    // arms: euler offsets, blended toward an aim direction when a reaction points somewhere
    const aimLv = this.RP[PK.aimL] > 0 || this.fadeW <= 0 ? this.aimL : this.fadeAimL;
    const aimRv = this.RP[PK.aimR] > 0 || this.fadeW <= 0 ? this.aimR : this.fadeAimR;
    this.poseArm(B.armL, 1, P[PK.armLSwing], P[PK.armLRaise], P[PK.armLTwist], clamp(P[PK.aimL], 0, 1), aimLv, this.armDirL);
    this.poseArm(B.armR, -1, P[PK.armRSwing], P[PK.armRRaise], P[PK.armRTwist], clamp(P[PK.aimR], 0, 1), aimRv, this.armDirR);

    const reach = 1 + 0.34 * clamp(P[PK.reach], 0, 1);
    B.handL.position.copy(this.handLRest).multiplyScalar(reach);
    B.handR.position.copy(this.handRRest).multiplyScalar(reach);
    B.handL.rotation.set(P[PK.handL] * 0.6, 0, 0);
    B.handR.rotation.set(P[PK.handR] * 0.6, 0, 0);
    if (this.kind === 'badger') {
      const sc = clamp(P[PK.scribble], 0, 1);
      if (sc > 0) {
        const w = t * 27;
        B.handR.position.x += (0.0035 + Math.cos(w) * 0.0024) * sc;
        B.handR.position.y += Math.sin(w * 1.31) * 0.0017 * sc;
        B.handR.rotation.z += Math.sin(w) * 0.25 * sc;
      }
    }
  }

  private poseArm(bone: Bone, side: number, swing: number, raise: number, twist: number, aimW: number, aim: Vector3, rest: Vector3): void {
    bone.rotation.set(-swing, twist * side, raise * side);
    if (aimW > 0.001) {
      _v4.copy(aim);
      if (_v4.lengthSq() < 1e-8) _v4.set(0, -1, 0);
      _v4.normalize();
      _q1.setFromUnitVectors(rest, _v4);
      bone.quaternion.slerp(_q1, aimW);
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
    this.glyph.visible = pop > 0.02;
    if (this.glyph.visible) {
      _v3.setFromMatrixPosition(this.B.head.matrixWorld);
      _v3.y += this.d.glyphY * this.scale + 0.0025 * Math.sin(this.time * 2.4 + this.seed);
      this.root.updateWorldMatrix(true, false);
      this.root.worldToLocal(_v3);
      this.glyph.position.copy(_v3);
      this.glyph.scale.setScalar(GLYPH_SIZE * pop);
    }

    // sight cone: follows the head's yaw, fades when facing away from the mat, pulses red on alarm
    const u = this.coneMat.uniforms;
    if (dt > 0) {
      this.coneVis = damp(this.coneVis, this.coneOn && !this.away ? 1 : 0, 8, dt);
      this.alarm = damp(this.alarm, this.alarmOn ? 1 : 0, 10, dt);
    }
    u.uTime.value = this.time;
    if (this.coneVis < 0.01) {
      this.cone.visible = false;
      return;
    }
    _v1.setFromMatrixColumn(this.B.head.matrixWorld, 2);
    _m1.copy(this.root.matrixWorld).invert();
    _v1.transformDirection(_m1);
    const h = Math.hypot(_v1.x, _v1.z);
    const fwd = h > 1e-4 ? _v1.z / h : 0;
    this.cone.rotation.set(0, Math.atan2(_v1.x, _v1.z), 0);
    this.cone.scale.set(CONE_LEN, 1, CONE_LEN);
    const facing = smoothstep(-0.05, 0.45, fwd) * (1 - smoothstep(0.2, 0.6, _v1.y));
    const a = CONE_ALPHA * this.coneVis * Math.max(facing, this.alarm);
    u.uOpacity.value = a;
    u.uAlarm.value = this.alarm;
    u.uHalf.value = this.halfAngle;
    this.cone.visible = a > 0.003;
  }
}
