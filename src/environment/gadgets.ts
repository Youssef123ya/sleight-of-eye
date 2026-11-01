// Shelf gadgets that fire when the player looks at them: a wind-up music box with a spinning felt dancer,
// a brass candle that flares, and a little firework rocket with a sparkling fuse that bursts above the audience.
// Per-frame safe: each update computes the gadget→rig transform once from the current local transforms
// (util.affineTo, no matrixWorld recomposition of the IWSDK rig entity); animated parts (lid, crank, dancer, rocket,
// focus) have matrixAutoUpdate off and get their matrices written with plain arithmetic.
import {
  BoxGeometry,
  CatmullRomCurve3,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  Group,
  Mesh,
  Object3D,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  type BufferGeometry,
  type Color,
  type MeshMatcapMaterial,
} from '@iwsdk/core';
import type { Gadget, GadgetId } from '../contracts.js';
import { mergeParts, type Part } from '../art/geometry.js';
import { PAL } from '../art/palette.js';
import { CFG } from '../config.js';
import { L, type StageRig } from '../layout.js';
import type { FxImpl } from './fx.js';
import { MODE, type BlobBatch, type GlowBatch } from './glow.js';
import { lightLevelAt } from './light.js';
import { surfaceMaterial } from './surface.js';
import { CELL } from './textures.js';
import {
  TAU,
  affineTo,
  applyAffine,
  applyAffineInvRigid,
  approach,
  clamp01,
  easeInCubic,
  freezeMatrix,
  lathe,
  lin,
  noise1,
  roundedBox,
  smoothstep,
  starPlate,
  writeT,
  writeTQ,
  writeTRS,
} from './util.js';

export interface GadgetEnv {
  rig: StageRig;
  glow: GlowBatch;
  blobs: BlobBatch;
  fx: FxImpl;
}

const GOLD = lin(PAL.glintGold);
const v1 = new Vector3();
const v2 = new Vector3();

/** Underdamped spring (gives a little overshoot for free). */
class Spring {
  v = 0;
  x = 0;
  step(target: number, dt: number, k = 140, c = 13): number {
    const a = k * (target - this.x) - c * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
  set(x: number): void {
    this.x = x;
    this.v = 0;
  }
}

function merge(parts: Part[]): BufferGeometry {
  const g = mergeParts(parts);
  for (const p of parts) p.geometry.dispose();
  return g;
}

function mesh(name: string, geo: BufferGeometry, mat: MeshMatcapMaterial): Mesh {
  const m = new Mesh(geo, mat);
  m.name = name;
  return m;
}

/** Brass rod under every gadget: hidden in the shelf normally, it shows when the compact layout lifts them. */
function postPart(): Part {
  return { geometry: new CylinderGeometry(0.0042, 0.0042, 0.13, 10), color: PAL.brass, position: [0, -0.065, 0] };
}

abstract class GadgetBase implements Gadget {
  readonly root = new Group();
  readonly focus = new Object3D();
  duration: number;
  onBurst: (() => void) | null = null;
  protected active = false;
  protected t = 0;
  protected used = false;
  protected available = true;
  protected dwell = 0;
  protected now = 0;
  protected readonly mats: Array<{ m: MeshMatcapMaterial; base: Color }> = [];
  /** Gadget-local → rig-local transform, refreshed at the start of every update. */
  protected readonly rigM = new Float64Array(12);
  private rigOk = false;
  private yaw = 0;
  private dimNow = 1;
  private dimApplied = -1;
  private lightLevel = 1;
  private lastTime = Number.NaN;
  private failed = false;
  private readonly ringSlot: number;
  private readonly ringHaloSlot: number;
  private readonly blobSlot: number;
  private readonly postBlobSlot: number;
  private readonly twinkleSlot: number;
  private twinkleT = 1 + Math.random() * 2;
  private dwellFlash = 0;
  /** Gadget-local point where an idle "look at me" twinkle appears (a brass highlight). */
  protected shine: [number, number, number] = [0, 0.04, 0];

  constructor(
    readonly id: GadgetId,
    protected readonly env: GadgetEnv,
    parent: Object3D,
    readonly gazeRadius: number,
    duration: number,
    private readonly ringY: number,
    private readonly footprint: number,
  ) {
    this.duration = duration;
    this.root.name = id;
    this.focus.name = `${id}-focus`;
    this.focus.matrixAutoUpdate = false;
    this.root.add(this.focus);
    parent.add(this.root);
    this.ringSlot = env.glow.alloc();
    this.ringHaloSlot = env.glow.alloc();
    this.blobSlot = env.blobs.alloc();
    this.postBlobSlot = env.blobs.alloc();
    this.twinkleSlot = env.glow.alloc();
    const p = L.gadgets[id];
    this.place(p[0], p[1], p[2]);
  }

  protected own<M extends MeshMatcapMaterial>(m: M): M {
    this.mats.push({ m, base: m.color.clone() });
    return m;
  }

  /** Static parts: add to the gadget and stop recomposing their matrices every frame. */
  protected addStatic(...objs: Object3D[]): void {
    for (const o of objs) {
      this.root.add(o);
      freezeMatrix(o);
    }
  }

  /** Move to a rig-local base point, facing the player; re-samples the baked light level there. */
  place(x: number, y: number, z: number): void {
    const p = this.root.position;
    p.x = x;
    p.y = y;
    p.z = z;
    this.yaw = Math.atan2(-x, -z);
    this.root.rotation.y = this.yaw;
    const raw = lightLevelAt(x, y + 0.04, z);
    this.lightLevel = Math.min(1.05, Math.max(0.8, 0.62 + raw * 0.45));
  }

  activate(): void {
    if (this.active || this.used || !this.available) return;
    this.active = true;
    this.t = 0;
    this.dwell = 0;
    this.dwellFlash = 1;
    try {
      this.rigOk = affineTo(this.root, this.env.rig.root, this.rigM); // may run between frames
      this.onActivate();
    } catch (e) {
      console.error(`[environment] ${this.id} activate failed`, e);
    }
  }
  isActive(): boolean {
    return this.active;
  }
  progress(): number {
    if (!this.active) return 0;
    if (!Number.isFinite(this.duration)) return 1;
    return clamp01(1 - this.t / Math.max(0.001, this.duration));
  }
  setDwell(p: number): void {
    this.dwell = clamp01(Number.isFinite(p) ? p : 0);
  }
  setUsed(used: boolean): void {
    this.used = used;
  }
  setAvailable(available: boolean): void {
    this.available = available;
  }
  reset(): void {
    this.active = false;
    this.t = 0;
    this.used = false;
    this.dwell = 0;
    this.dwellFlash = 0;
    try {
      this.onReset();
    } catch (e) {
      console.error(`[environment] ${this.id} reset failed`, e);
    }
  }

  update(dt: number, time: number): void {
    if (time === this.lastTime) return;
    this.lastTime = time;
    try {
      const d = Math.min(Math.max(dt, 0), 0.1);
      this.now += d;
      if (this.active) this.t += d;
      const target = (this.used ? 0.5 : 1) * (this.available ? 1 : 0.42);
      this.dimNow += (target - this.dimNow) * approach(6, d);
      const k = this.dimNow * this.lightLevel;
      if (Math.abs(k - this.dimApplied) > 1e-4) {
        this.dimApplied = k;
        const mats = this.mats;
        for (let i = 0; i < mats.length; i++) {
          const c = mats[i].m.color;
          const b = mats[i].base;
          c.r = b.r * k;
          c.g = b.g * k;
          c.b = b.b * k;
        }
      }
      this.rigOk = affineTo(this.root, this.env.rig.root, this.rigM);
      this.tick(d);
      if (!this.rigOk) return;
      this.drawDwell(d);
      this.drawBlob();
      this.drawTwinkle(d);
    } catch (e) {
      if (!this.failed) console.error(`[environment] ${this.id} update failed`, e);
      this.failed = true;
    }
  }

  /** Gadget-local point → rig-local (writes `out`). */
  protected toRig(x: number, y: number, z: number, out: Vector3): Vector3 {
    return applyAffine(this.rigM, x, y, z, out);
  }

  protected get dimFactor(): number {
    return this.dimNow;
  }

  private drawDwell(dt: number): void {
    const glow = this.env.glow;
    this.dwellFlash = Math.max(0, this.dwellFlash - dt * 2.5);
    const p = this.dwell;
    if (p <= 0.001 && this.dwellFlash <= 0) {
      glow.hide(this.ringSlot);
      glow.hide(this.ringHaloSlot);
      return;
    }
    this.toRig(0, this.ringY, 0, v1);
    const size = (this.gazeRadius + 0.016) * 2;
    if (this.dwellFlash > 0) {
      const f = this.dwellFlash;
      const s = size * (1 + (1 - f) * 0.5);
      glow.set(this.ringSlot, v1.x, v1.y, v1.z, s, s, 1, 0.9, 0.6, f, CELL.ring, MODE.pushed);
      glow.set(this.ringHaloSlot, v1.x, v1.y, v1.z, size * 1.2, size * 1.2, GOLD.r, GOLD.g, GOLD.b, 0.5 * f, CELL.halo, MODE.pushed);
      return;
    }
    const breathe = 1 + 0.03 * Math.sin(this.now * 9);
    glow.set(this.ringSlot, v1.x, v1.y, v1.z, size * breathe, size * breathe, GOLD.r, GOLD.g, GOLD.b, 0.55 + 0.45 * p, CELL.ring, MODE.pushed, 0, Math.max(0.002, p));
    glow.set(this.ringHaloSlot, v1.x, v1.y, v1.z, size * 0.9, size * 0.9, GOLD.r, GOLD.g, GOLD.b, 0.22 * p, CELL.halo, MODE.pushed);
  }

  /** Available, idle gadgets glint now and then (a quiet invitation to look). */
  private drawTwinkle(dt: number): void {
    const glow = this.env.glow;
    if (!this.available || this.used || this.active || this.dwell > 0) {
      glow.hide(this.twinkleSlot);
      return;
    }
    this.twinkleT -= dt;
    if (this.twinkleT < -0.5) this.twinkleT = 2.6 + Math.random() * 2.8;
    if (this.twinkleT >= 0) {
      glow.hide(this.twinkleSlot);
      return;
    }
    const u = -this.twinkleT / 0.5;
    const a = Math.sin(u * Math.PI);
    this.toRig(this.shine[0], this.shine[1], this.shine[2], v1);
    const s = 0.03 * a;
    glow.set(this.twinkleSlot, v1.x, v1.y, v1.z, s, s, 1, 0.9, 0.62, a, CELL.star4, MODE.pushed, u * 1.2);
  }

  private drawBlob(): void {
    const surfY = this.id === 'firework' ? L.gadgets.firework[1] : L.shelf.topY;
    const m = this.rigM;
    const x = m[9];
    const z = m[11];
    const h = Math.max(0, m[10] - surfY);
    const fade = 1 - smoothstep(0, 0.12, h);
    const f = this.footprint;
    this.env.blobs.set(this.blobSlot, x, surfY + 0.0012, z, f * (1 + h * 3), f * 0.8 * (1 + h * 3), 0.55 * fade + 0.08, CELL.blobRound, this.yaw);
    if (h > 0.01) this.env.blobs.set(this.postBlobSlot, x, surfY + 0.0013, z, 0.022, 0.022, 0.45, CELL.blobRound);
    else this.env.blobs.hide(this.postBlobSlot);
  }

  protected abstract onActivate(): void;
  protected abstract onReset(): void;
  protected abstract tick(dt: number): void;
}

// ------------------------------------------------------------------------------------------- music box

const MB = { W: 0.078, D: 0.056, bodyTop: 0.034, rimTop: 0.037 };

export class MusicBox extends GadgetBase {
  private readonly lid = new Group();
  private readonly crank = new Group();
  private readonly dancer = new Group();
  private readonly lidS = new Spring();
  private readonly dancerS = new Spring();
  private spin = 0;
  private crankA = 0;
  private closing = false;
  private readonly glowSlot: number;
  private readonly noteSlots: number[] = [];
  private readonly notes: Array<{ t0: number; x: number; z: number; alive: boolean }> = [];
  private noteClock = 0;
  private noteCursor = 0;
  private static readonly LID = [0, MB.rimTop, -MB.D / 2 - 0.001] as const;
  private static readonly CRANK = [MB.W / 2 + 0.008, 0.02, 0] as const;

  constructor(env: GadgetEnv, parent: Object3D) {
    super('musicBox', env, parent, 0.05, CFG.musicBoxDuration, 0.034, 0.1);
    const wood = this.own(surfaceMaterial({ matcap: 'wood', name: 'env-musicBox-wood' }));
    const brass = this.own(surfaceMaterial({ matcap: 'brass', name: 'env-musicBox-brass' }));
    const felt = this.own(surfaceMaterial({ matcap: 'felt', fuzz: 0.07, name: 'env-musicBox-felt' }));
    const { W, D, bodyTop, rimTop } = MB;
    const mahogany = 0x7a3a1c;
    const body: Part[] = [
      { geometry: roundedBox(W, bodyTop - 0.004, D, 0.0022), color: mahogany, position: [0, 0.004 + (bodyTop - 0.004) / 2, 0] },
      { geometry: new BoxGeometry(W + 0.0008, 0.0035, D + 0.0008), color: 0xc8925a, position: [0, 0.024, 0] },
      { geometry: new BoxGeometry(W, rimTop - bodyTop, 0.003), color: 0x6a3018, position: [0, (bodyTop + rimTop) / 2, D / 2 - 0.0015] },
      { geometry: new BoxGeometry(W, rimTop - bodyTop, 0.003), color: 0x6a3018, position: [0, (bodyTop + rimTop) / 2, -D / 2 + 0.0015] },
      { geometry: new BoxGeometry(0.003, rimTop - bodyTop, D - 0.006), color: 0x6a3018, position: [W / 2 - 0.0015, (bodyTop + rimTop) / 2, 0] },
      { geometry: new BoxGeometry(0.003, rimTop - bodyTop, D - 0.006), color: 0x6a3018, position: [-W / 2 + 0.0015, (bodyTop + rimTop) / 2, 0] },
      { geometry: new BoxGeometry(W - 0.006, 0.001, D - 0.006), color: 0x8a1424, position: [0, bodyTop + 0.0005, 0] },
    ];
    const trim: Part[] = [postPart()];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) trim.push({ geometry: new SphereGeometry(0.0046, 10, 8), color: PAL.brass, position: [sx * (W / 2 - 0.006), 0.0042, sz * (D / 2 - 0.006)] });
    trim.push({ geometry: roundedBox(0.013, 0.017, 0.0012, 0.0005), color: PAL.gold, position: [0, 0.018, D / 2 + 0.0006] });
    trim.push({ geometry: new BoxGeometry(0.0022, 0.005, 0.0006), color: 0x1a1008, position: [0, 0.017, D / 2 + 0.0013] });
    trim.push({ geometry: new CylinderGeometry(0.0013, 0.0013, 0.0006, 10), color: 0x1a1008, position: [0, 0.0198, D / 2 + 0.0013], rotation: [Math.PI / 2, 0, 0] });
    for (const sx of [-1, 1]) {
      trim.push({ geometry: new BoxGeometry(0.007, 0.028, 0.001), color: PAL.brass, position: [sx * (W / 2 - 0.0035), 0.019, D / 2 + 0.0005] });
      trim.push({ geometry: new CylinderGeometry(0.0014, 0.0014, 0.012, 8), color: PAL.brass, position: [sx * 0.026, rimTop, -D / 2 - 0.0008], rotation: [0, 0, Math.PI / 2] });
    }
    trim.push({ geometry: new CylinderGeometry(0.0018, 0.0018, 0.008, 8), color: PAL.brass, position: [W / 2 + 0.004, 0.02, 0], rotation: [0, 0, Math.PI / 2] });
    trim.push({ geometry: new CylinderGeometry(0.011, 0.011, 0.0015, 24), color: PAL.brass, position: [0, bodyTop + 0.0012, 0] });
    this.addStatic(mesh('musicBox-body', merge(body), wood), mesh('musicBox-trim', merge(trim), brass));
    // crank (spins while winding / playing)
    const crankMesh = mesh(
      'musicBox-crank',
      merge([
        { geometry: new BoxGeometry(0.0022, 0.016, 0.0032), color: PAL.brass, position: [0, 0.007, 0] },
        { geometry: new CylinderGeometry(0.0028, 0.0028, 0.008, 12), color: 0xe9c46a, position: [0.004, 0.0145, 0], rotation: [0, 0, Math.PI / 2] },
      ]),
      brass,
    );
    this.crank.add(crankMesh);
    freezeMatrix(crankMesh);
    this.crank.matrixAutoUpdate = false;
    this.root.add(this.crank);
    // lid: hinged at the back top edge, inlaid star, mirror inside
    const LD = D + 0.002;
    const lidMesh = mesh(
      'musicBox-lid',
      merge([
        { geometry: roundedBox(W + 0.002, 0.011, LD, 0.0024), color: mahogany, position: [0, 0.0055, LD / 2] },
        { geometry: starPlate(0.0115, 0.005, 0.0006), color: 0xe8c07a, position: [0, 0.011, LD / 2] },
        { geometry: new BoxGeometry(W - 0.012, 0.0008, LD - 0.012), color: 0xc8d4e0, position: [0, -0.0004, LD / 2] },
        { geometry: new BoxGeometry(W + 0.0024, 0.0016, 0.004), color: 0xc8925a, position: [0, 0.0065, LD - 0.0005] },
      ]),
      wood,
    );
    this.lid.add(lidMesh);
    freezeMatrix(lidMesh);
    this.lid.matrixAutoUpdate = false;
    this.root.add(this.lid);
    // tiny felt ballerina on a brass pin
    const dancerParts: Part[] = [
      { geometry: new CylinderGeometry(0.0011, 0.0011, 0.014, 6), color: PAL.gold, position: [0, -0.007, 0] },
      { geometry: new ConeGeometry(0.0021, 0.013, 8), color: 0xf6c7d0, position: [0, 0.0065, 0], rotation: [Math.PI, 0, 0] },
      {
        geometry: lathe([[0.0001, 0.0118], [0.0125, 0.011], [0.0142, 0.0126], [0.0118, 0.0146], [0.0045, 0.0157], [0.0001, 0.016]], 24),
        color: 0xff9fc3,
      },
      { geometry: new CylinderGeometry(0.0028, 0.0034, 0.0095, 10), color: 0xff7aa8, position: [0, 0.0205, 0] },
      { geometry: new SphereGeometry(0.0043, 14, 10), color: 0xf3d2bb, position: [0, 0.0293, 0] },
      { geometry: new SphereGeometry(0.0023, 10, 8), color: 0x5a3a26, position: [0, 0.033, -0.0016] },
      { geometry: new TorusGeometry(0.0072, 0.001, 6, 16, Math.PI), color: 0xf3d2bb, position: [0, 0.0258, 0] },
    ];
    const tutu = dancerParts[2].geometry;
    const tp = tutu.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      const a = Math.atan2(tp.getZ(i), tp.getX(i));
      tp.setY(i, tp.getY(i) + 0.0011 * Math.sin(a * 9) * (Math.hypot(tp.getX(i), tp.getZ(i)) / 0.014));
    }
    tutu.computeVertexNormals();
    const dancerMesh = mesh('musicBox-dancer', merge(dancerParts), felt);
    this.dancer.add(dancerMesh);
    freezeMatrix(dancerMesh);
    this.dancer.matrixAutoUpdate = false;
    this.root.add(this.dancer);
    this.shine = [W / 2 + 0.012, 0.035, 0.002];
    this.glowSlot = env.glow.alloc();
    for (let i = 0; i < 8; i++) {
      this.noteSlots.push(env.glow.alloc());
      this.notes.push({ t0: -10, x: 0, z: 0, alive: false });
    }
    this.pose(0, 0);
  }

  protected onActivate(): void {
    this.closing = false;
    this.noteClock = 0.25;
  }

  protected onReset(): void {
    this.lidS.set(0);
    this.dancerS.set(0);
    this.closing = false;
    for (const n of this.notes) n.alive = false;
  }

  /** Lid / dancer / crank / focus matrices for a lid opening and a dancer height (0..1). */
  private pose(lid: number, up: number): void {
    const L0 = MusicBox.LID;
    writeTRS(this.lid, L0[0], L0[1], L0[2], -1.82 * Math.max(-0.02, lid), 0, 0);
    const u = clamp01(up);
    const dy = -0.002 + (MB.bodyTop + 0.0015 + 0.002) * u + 0.0012 * Math.sin(this.now * 6) * u;
    writeTRS(this.dancer, 0, dy, 0, 0, this.spin, 0.06 * Math.sin(this.now * 3.1) * u);
    const C0 = MusicBox.CRANK;
    writeTRS(this.crank, C0[0], C0[1], C0[2], this.crankA, 0, 0);
    // focus follows the dancer
    writeT(this.focus, 0, MB.bodyTop + 0.012 + 0.02 * u, 0);
  }

  protected tick(dt: number): void {
    const t = this.t;
    if (this.active && Number.isFinite(this.duration) && t >= this.duration) {
      this.active = false;
      this.closing = true;
    }
    const lidOpen = this.active && t > 0.22;
    const dancerUp = this.active && t > 0.45;
    const lid = this.lidS.step(lidOpen ? 1 : this.dancerS.x > 0.25 ? 1 : 0, dt, lidOpen ? 160 : 90, lidOpen ? 11 : 14);
    const up = this.dancerS.step(dancerUp ? 1 : 0, dt, 170, 12);
    if (up > 0.05) this.spin += dt * (5.5 + 2 * up);
    // crank: a quick wind on activation, then a slow turn while the tune plays
    const wind = this.active && t < 0.45 ? 22 : this.active ? 4.5 : 0;
    this.crankA += dt * wind;
    if (this.closing && lid < 0.02 && up < 0.02) this.closing = false;
    this.pose(lid, up);

    // warm glow from inside the open box
    const glow = this.env.glow;
    const g = clamp01(lid) * this.dimFactor;
    if (g > 0.02) {
      this.toRig(0, MB.bodyTop + 0.012, 0.004, v1);
      glow.set(this.glowSlot, v1.x, v1.y, v1.z, 0.11, 0.11, 1, 0.7, 0.4, 0.5 * g, CELL.halo, MODE.pushed);
    } else glow.hide(this.glowSlot);
    // music notes drift up while it plays
    if (dancerUp) {
      this.noteClock -= dt;
      if (this.noteClock <= 0) {
        this.noteClock = 0.38 + Math.random() * 0.2;
        const n = this.notes[this.noteCursor];
        this.noteCursor = (this.noteCursor + 1) % this.notes.length;
        n.t0 = this.now;
        n.x = (Math.random() - 0.5) * 0.05;
        n.z = (Math.random() - 0.5) * 0.02;
        n.alive = true;
      }
    }
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i];
      const age = this.now - n.t0;
      if (!n.alive || age > 1.7) {
        n.alive = false;
        glow.hide(this.noteSlots[i]);
        continue;
      }
      const u = age / 1.7;
      this.toRig(n.x + 0.012 * Math.sin(age * 4 + i), MB.bodyTop + 0.03 + u * 0.1, n.z, v1);
      const a = Math.min(1, age * 5) * (1 - u * u);
      const s = 0.02 * (0.7 + 0.3 * Math.min(1, age * 4));
      glow.set(this.noteSlots[i], v1.x, v1.y, v1.z, s, s, 1, 0.84, 0.5, a * 0.95, CELL.note, MODE.pushed, 0.25 * Math.sin(age * 5 + i));
    }
  }
}

// ----------------------------------------------------------------------------------------------- candle

export class Candle extends GadgetBase {
  private readonly flareS = new Spring();
  private readonly litS = new Spring();
  private readonly flameSlot: number;
  private readonly coreSlot: number;
  private readonly haloSlot: number;
  private readonly emberSlot: number;
  private sparkAcc = 0;
  private static readonly WICK = 0.0715;

  constructor(env: GadgetEnv, parent: Object3D) {
    super('candle', env, parent, 0.045, CFG.candleDuration, 0.04, 0.085);
    const brass = this.own(surfaceMaterial({ matcap: 'brass', name: 'env-candle-brass' }));
    const wax = this.own(surfaceMaterial({ matcap: 'felt', fuzz: 0.025, name: 'env-candle-wax' }));
    const holder: Part[] = [
      postPart(),
      {
        geometry: lathe(
          [
            [0.0001, 0],
            [0.029, 0],
            [0.032, 0.003],
            [0.0326, 0.0064],
            [0.0306, 0.0068],
            [0.027, 0.0046],
            [0.0126, 0.0046],
            [0.0126, 0.0175],
            [0.0136, 0.019],
            [0.0104, 0.0196],
            [0.0001, 0.0196],
          ],
          36,
        ),
        color: PAL.brass,
      },
      { geometry: new TorusGeometry(0.0085, 0.0021, 8, 20), color: PAL.brass, position: [0.036, 0.009, 0] },
      { geometry: new CylinderGeometry(0.0055, 0.0055, 0.0016, 14), color: PAL.gold, position: [0.037, 0.0185, 0] },
    ];
    const waxParts: Part[] = [
      {
        geometry: lathe(
          [
            [0.0001, 0.019],
            [0.0095, 0.019],
            [0.0095, 0.0655],
            [0.0089, 0.0682],
            [0.0062, 0.0668],
            [0.0001, 0.0664],
          ],
          28,
        ),
        color: 0xf6ecd6,
      },
      { geometry: new CylinderGeometry(0.0007, 0.0006, 0.0065, 6), color: 0x2a2018, position: [0, 0.0685, 0], rotation: [0, 0, 0.12] },
    ];
    const drips: Array<[number, number]> = [
      [0.4, 0.016],
      [1.9, 0.024],
      [3.3, 0.011],
      [4.6, 0.019],
      [5.6, 0.008],
    ];
    for (const [a, len] of drips) {
      const x = Math.cos(a) * 0.0093;
      const z = Math.sin(a) * 0.0093;
      waxParts.push({ geometry: new CylinderGeometry(0.0016, 0.0016, len, 8), color: 0xf8f0dc, position: [x, 0.066 - len / 2, z] });
      waxParts.push({ geometry: new SphereGeometry(0.0021, 8, 6), color: 0xf8f0dc, position: [x, 0.066 - len, z] });
    }
    this.addStatic(mesh('candle-holder', merge(holder), brass), mesh('candle-wax', merge(waxParts), wax));
    this.flameSlot = env.glow.alloc();
    this.coreSlot = env.glow.alloc();
    this.haloSlot = env.glow.alloc();
    this.emberSlot = env.glow.alloc();
    writeT(this.focus, 0, Candle.WICK + 0.012, 0);
    this.shine = [-0.029, 0.007, 0.012];
    this.litS.set(1);
  }

  protected onActivate(): void {
    this.sparkAcc = 0;
    this.toRig(0, Candle.WICK + 0.02, 0, v2);
    this.env.fx.sparkle(v2.x, v2.y, v2.z, 10, 1.2, 1, 0.85, 0.5);
  }
  protected onReset(): void {
    this.flareS.set(0);
  }

  protected tick(dt: number): void {
    if (this.active && Number.isFinite(this.duration) && this.t >= this.duration) this.active = false;
    const prog = this.active ? this.progress() : 0;
    const flare = this.flareS.step(this.active ? 1 : 0, dt, 110, 9);
    const lit = this.litS.step(this.active || (this.available && !this.used) ? 1 : 0, dt, 60, 14);
    const glow = this.env.glow;
    const n = this.now;
    const flick = 1 + 0.1 * noise1(n * 9) + 0.05 * noise1(n * 23 + 4);
    const f = Math.max(0, flare) * (0.35 + 0.65 * prog);
    const h = (0.022 + 0.05 * f) * flick * clamp01(lit);
    const w = (0.0105 + 0.012 * f) * (1 + 0.06 * noise1(n * 13));
    const sway = 0.08 * noise1(n * 2.3) + 0.05 * f * Math.sin(n * 17);
    const cy = Candle.WICK + 0.175 * h + 0.0012;
    writeT(this.focus, 0, Candle.WICK + 0.4 * h + 0.004, 0);
    if (lit > 0.02) {
      this.toRig(0, cy, 0, v1);
      const hot = 0.35 + 0.65 * f;
      glow.set(this.flameSlot, v1.x, v1.y, v1.z, w, h, 1, 0.55 + 0.15 * hot, 0.18 + 0.12 * hot, 0.95 * clamp01(lit), CELL.flame, MODE.upright, sway);
      glow.set(this.coreSlot, v1.x, v1.y - h * 0.05, v1.z, w * 0.5, h * 0.55, 1, 0.92, 0.7, 0.8 * clamp01(lit), CELL.flame, MODE.upright, sway * 0.6);
      const hs = (0.075 + 0.17 * f) * (0.95 + 0.08 * flick);
      glow.set(this.haloSlot, v1.x, v1.y, v1.z, hs, hs, 1, 0.58, 0.24, (0.42 + 0.3 * f) * clamp01(lit), CELL.halo, MODE.pushed);
    } else {
      glow.hide(this.flameSlot);
      glow.hide(this.coreSlot);
      glow.hide(this.haloSlot);
    }
    // a faint ember on the wick of a spent candle
    if (this.used && !this.active && lit < 0.5) {
      this.toRig(0, Candle.WICK + 0.004, 0, v1);
      glow.set(this.emberSlot, v1.x, v1.y, v1.z, 0.008, 0.008, 1, 0.3, 0.1, 0.6 + 0.3 * Math.sin(n * 3), CELL.dot, MODE.pushed);
    } else glow.hide(this.emberSlot);
    // sparks shower while flaring
    if (this.active) {
      this.sparkAcc += dt * (18 + 30 * f);
      const fx = this.env.fx;
      while (this.sparkAcc >= 1) {
        this.sparkAcc -= 1;
        this.toRig((Math.random() - 0.5) * 0.006, Candle.WICK + h * 0.7, (Math.random() - 0.5) * 0.006, v1);
        const a = Math.random() * TAU;
        const sp = 0.08 + Math.random() * 0.22;
        fx.spark(v1.x, v1.y, v1.z, Math.cos(a) * sp * 0.6, 0.25 + Math.random() * 0.45, Math.sin(a) * sp * 0.6, 1, 0.7 + Math.random() * 0.25, 0.3, 0.8, 0.8);
      }
    }
  }
}

// --------------------------------------------------------------------------------------------- firework

type FwPhase = 'idle' | 'fuse' | 'flight' | 'after' | 'spent';

/** Rocket rest pose (gadget-local). */
const ROCKET_START = [0, 0.016, 0] as const;
const FUSE_SAMPLES = 48;

export class Firework extends GadgetBase {
  private readonly rocket = new Group();
  private readonly fuse: Mesh;
  /** Fuse centreline samples (gadget-local), flat xyz triples: 0 = rocket end, last = tip. */
  private readonly fusePts = new Float64Array((FUSE_SAMPLES + 1) * 3);
  private readonly fuseIndexPerSeg: number;
  private readonly fuseSegs = 64;
  private phase: FwPhase = 'idle';
  private phaseT = 0;
  private readonly sparkSlot: number;
  private readonly sparkHaloSlot: number;
  private readonly trailSlot: number;
  private emitAcc = 0;
  // rocket pose (gadget-local position + orientation quaternion), written straight into its matrix
  private rpx: number = ROCKET_START[0];
  private rpy: number = ROCKET_START[1];
  private rpz: number = ROCKET_START[2];
  private rqx = 0;
  private rqy = 0;
  private rqz = 0;
  private rqw = 1;
  private static readonly FLIGHT = 0.62;

  constructor(env: GadgetEnv, parent: Object3D) {
    super('firework', env, parent, 0.045, CFG.bangLookDuration, 0.045, 0.07);
    const brass = this.own(surfaceMaterial({ matcap: 'brass', name: 'env-firework-brass' }));
    const glossy = this.own(surfaceMaterial({ matcap: 'glossy', name: 'env-firework-glossy' }));
    const twine = this.own(surfaceMaterial({ matcap: 'wood', name: 'env-firework-twine' }));
    // brass tripod launcher
    const up = new Vector3(0, 1, 0);
    const q = new Quaternion();
    const eu = new Euler();
    const stand: Part[] = [postPart()];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.5;
      const bx = Math.cos(a) * 0.024;
      const bz = Math.sin(a) * 0.024;
      const tx = Math.cos(a) * 0.012;
      const tz = Math.sin(a) * 0.012;
      const mx = (bx + tx) / 2;
      const mz = (bz + tz) / 2;
      v1.set(tx - bx, 0.03, tz - bz);
      const len = v1.length();
      q.setFromUnitVectors(up, v1.normalize());
      eu.setFromQuaternion(q, 'XYZ');
      stand.push({ geometry: new CylinderGeometry(0.0016, 0.0016, len, 6), color: PAL.brass, position: [mx, 0.015, mz], rotation: [eu.x, eu.y, eu.z] });
      stand.push({ geometry: new SphereGeometry(0.0028, 8, 6), color: PAL.gold, position: [bx, 0.0016, bz] });
    }
    stand.push({ geometry: new TorusGeometry(0.0128, 0.0018, 6, 24), color: PAL.brass, position: [0, 0.03, 0], rotation: [Math.PI / 2, 0, 0] });
    stand.push({ geometry: new TorusGeometry(0.019, 0.0012, 6, 24), color: PAL.brass, position: [0, 0.011, 0], rotation: [Math.PI / 2, 0, 0] });
    this.addStatic(mesh('firework-stand', merge(stand), brass));
    // rocket: striped body, gold nose, red fins, nozzle
    const rk: Part[] = [];
    const bands = 8;
    for (let i = 0; i < bands; i++) {
      rk.push({ geometry: new CylinderGeometry(0.0098, 0.0098, 0.007, 24, 1, true), color: i % 2 ? 0xf3e6c8 : 0xd6322e, position: [0, 0.0075 + i * 0.007, 0] });
    }
    rk.push({ geometry: new CylinderGeometry(0.0101, 0.0101, 0.003, 24), color: PAL.gold, position: [0, 0.061, 0] });
    rk.push({ geometry: new ConeGeometry(0.0103, 0.024, 24), color: PAL.gold, position: [0, 0.0745, 0] });
    rk.push({ geometry: new SphereGeometry(0.0022, 8, 6), color: 0xffe9a8, position: [0, 0.0868, 0] });
    rk.push({ geometry: new CylinderGeometry(0.0062, 0.0075, 0.005, 16), color: 0x2a2a30, position: [0, 0.0018, 0] });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU;
      rk.push({ geometry: new BoxGeometry(0.0016, 0.016, 0.009), color: 0xb8222a, position: [Math.cos(a) * 0.0128, 0.011, Math.sin(a) * 0.0128], rotation: [0, -a, 0] });
    }
    rk.push({ geometry: starPlate(0.0052, 0.0022, 0.0008), color: 0xffd25a, position: [0, 0.034, 0.0099], rotation: [Math.PI / 2, 0, 0] });
    const rocketMesh = mesh('firework-rocket', merge(rk), glossy);
    this.rocket.add(rocketMesh);
    freezeMatrix(rocketMesh);
    this.rocket.matrixAutoUpdate = false;
    this.root.add(this.rocket);
    this.writeRocket();
    // fuse: twine curling off the stand onto the pedestal (burns from the tip)
    const pts = [
      new Vector3(0.002, 0.019, 0.003),
      new Vector3(0.009, 0.014, 0.009),
      new Vector3(0.017, 0.007, 0.016),
      new Vector3(0.024, 0.0025, 0.023),
      new Vector3(0.033, 0.0016, 0.027),
      new Vector3(0.039, 0.0016, 0.019),
      new Vector3(0.034, 0.0016, 0.012),
    ];
    const curve = new CatmullRomCurve3(pts);
    const radial = 5;
    const fuseGeo = new TubeGeometry(curve, this.fuseSegs, 0.0011, radial, false);
    const colors = new Float32Array(fuseGeo.attributes.position.count * 3);
    for (let i = 0; i < fuseGeo.attributes.position.count; i++) {
      const seg = Math.floor(i / (radial + 1)) / this.fuseSegs;
      const tip = smoothstep(0.88, 0.98, seg);
      colors[i * 3] = 0.45 + 0.4 * tip;
      colors[i * 3 + 1] = 0.3 + 0.42 * tip;
      colors[i * 3 + 2] = 0.18 + 0.35 * tip;
    }
    fuseGeo.setAttribute('color', new Float32BufferAttribute(colors, 3));
    this.fuseIndexPerSeg = radial * 6;
    this.fuse = mesh('firework-fuse', fuseGeo, twine);
    this.addStatic(this.fuse);
    for (let i = 0; i <= FUSE_SAMPLES; i++) {
      curve.getPointAt(i / FUSE_SAMPLES, v1);
      this.fusePts[i * 3] = v1.x;
      this.fusePts[i * 3 + 1] = v1.y;
      this.fusePts[i * 3 + 2] = v1.z;
    }
    this.sparkSlot = env.glow.alloc();
    this.sparkHaloSlot = env.glow.alloc();
    this.trailSlot = env.glow.alloc();
    writeT(this.focus, 0, 0.06, 0);
    this.shine = [0.002, 0.016 + 0.087, 0.002];
  }

  private writeRocket(): void {
    writeTQ(this.rocket, this.rpx, this.rpy, this.rpz, this.rqx, this.rqy, this.rqz, this.rqw);
  }

  protected onActivate(): void {
    this.phase = 'fuse';
    this.phaseT = 0;
    this.emitAcc = 0;
  }

  protected onReset(): void {
    this.phase = 'idle';
    this.phaseT = 0;
    this.rocket.visible = true;
    this.rpx = ROCKET_START[0];
    this.rpy = ROCKET_START[1];
    this.rpz = ROCKET_START[2];
    this.rqx = 0;
    this.rqy = 0;
    this.rqz = 0;
    this.rqw = 1;
    this.writeRocket();
    this.fuse.geometry.setDrawRange(0, Infinity);
    writeT(this.focus, 0, 0.06, 0);
  }

  override progress(): number {
    if (!this.active) return 0;
    if (this.phase === 'fuse') return clamp01(1 - this.phaseT / CFG.fuseDuration);
    return 0;
  }

  /** Point along the unburnt fuse at fraction u (0 = rocket end, 1 = tip), gadget-local. */
  private fuseAt(u: number, out: Vector3): Vector3 {
    const f = clamp01(u) * FUSE_SAMPLES;
    const i = Math.min(FUSE_SAMPLES - 1, Math.floor(f));
    const k = f - i;
    const P = this.fusePts;
    const a = i * 3;
    out.x = P[a] + (P[a + 3] - P[a]) * k;
    out.y = P[a + 1] + (P[a + 4] - P[a + 1]) * k;
    out.z = P[a + 2] + (P[a + 5] - P[a + 2]) * k;
    return out;
  }

  protected tick(dt: number): void {
    const glow = this.env.glow;
    const fx = this.env.fx;
    this.phaseT += dt;
    if (this.phase === 'fuse') {
      const remain = clamp01(1 - this.phaseT / CFG.fuseDuration);
      this.fuse.geometry.setDrawRange(0, Math.max(0, Math.floor(remain * this.fuseSegs)) * this.fuseIndexPerSeg);
      this.fuseAt(remain, v1);
      writeT(this.focus, v1.x, v1.y, v1.z);
      this.toRig(v1.x, v1.y, v1.z, v2);
      const fl = 0.75 + 0.25 * Math.sin(this.now * 41) * Math.sin(this.now * 17);
      glow.set(this.sparkSlot, v2.x, v2.y, v2.z, 0.03 * fl, 0.03 * fl, 1, 0.85, 0.5, 1, CELL.star4, MODE.pushed, this.now * 9);
      glow.set(this.sparkHaloSlot, v2.x, v2.y, v2.z, 0.07, 0.07, 1, 0.55, 0.2, 0.55 * fl, CELL.halo, MODE.pushed);
      this.emitAcc += dt * 70;
      while (this.emitAcc >= 1) {
        this.emitAcc -= 1;
        const a = Math.random() * TAU;
        const sp = 0.1 + Math.random() * 0.25;
        fx.spark(v2.x, v2.y, v2.z, Math.cos(a) * sp, 0.15 + Math.random() * 0.35, Math.sin(a) * sp, 1, 0.75 + Math.random() * 0.2, 0.35, 0.55, 0.45);
      }
      if (remain <= 0) {
        this.phase = 'flight';
        this.phaseT = 0;
        glow.hide(this.sparkSlot);
        glow.hide(this.sparkHaloSlot);
        fx.burstLocal('poof', v2.x, v2.y, v2.z, 0.6, 6);
      }
    } else if (this.phase === 'flight') {
      const u = clamp01(this.phaseT / Firework.FLIGHT);
      // burst point in gadget-local space (the gadget is rigid: inverse = transposed rotation)
      applyAffineInvRigid(this.rigM, L.burst[0], L.burst[1], L.burst[2], v1);
      const e = easeInCubic(u) * 0.75 + u * 0.25;
      const ppx = this.rpx;
      const ppy = this.rpy;
      const ppz = this.rpz;
      this.rpx = ROCKET_START[0] + (v1.x - ROCKET_START[0]) * e + Math.sin(u * 19) * 0.006 * u;
      this.rpy = ROCKET_START[1] + (v1.y - ROCKET_START[1]) * e;
      this.rpz = ROCKET_START[2] + (v1.z - ROCKET_START[2]) * e + Math.cos(u * 15) * 0.004 * u;
      // nose follows the motion: shortest rotation +Y → direction, eased toward it
      let dx = this.rpx - ppx;
      let dy = this.rpy - ppy;
      let dz = this.rpz - ppz;
      const dl = Math.hypot(dx, dy, dz);
      if (dl > 1e-5) {
        dx /= dl;
        dy /= dl;
        dz /= dl;
        let tx = dz;
        let ty = 0;
        let tz = -dx;
        let tw = 1 + dy;
        if (tw < 1e-8) {
          tx = 0;
          ty = 0;
          tz = 1;
          tw = 0;
        }
        let tl = Math.hypot(tx, ty, tz, tw);
        tx /= tl;
        ty /= tl;
        tz /= tl;
        tw /= tl;
        if (tx * this.rqx + ty * this.rqy + tz * this.rqz + tw * this.rqw < 0) {
          tx = -tx;
          ty = -ty;
          tz = -tz;
          tw = -tw;
        }
        const k = Math.min(1, dt * 18);
        let qx = this.rqx + (tx - this.rqx) * k;
        let qy = this.rqy + (ty - this.rqy) * k;
        let qz = this.rqz + (tz - this.rqz) * k;
        let qw = this.rqw + (tw - this.rqw) * k;
        tl = Math.hypot(qx, qy, qz, qw) || 1;
        qx /= tl;
        qy /= tl;
        qz /= tl;
        qw /= tl;
        this.rqx = qx;
        this.rqy = qy;
        this.rqz = qz;
        this.rqw = qw;
      }
      this.writeRocket();
      writeT(this.focus, this.rpx, this.rpy, this.rpz);
      this.toRig(this.rpx, this.rpy, this.rpz, v2);
      glow.set(this.trailSlot, v2.x, v2.y, v2.z, 0.06, 0.06, 1, 0.6, 0.25, 0.8, CELL.halo, MODE.pushed);
      this.emitAcc += dt * 160;
      while (this.emitAcc >= 1) {
        this.emitAcc -= 1;
        fx.spark(v2.x + (Math.random() - 0.5) * 0.008, v2.y - 0.01, v2.z + (Math.random() - 0.5) * 0.008, (Math.random() - 0.5) * 0.2, -0.25 - Math.random() * 0.3, (Math.random() - 0.5) * 0.2, 1, 0.65 + Math.random() * 0.3, 0.3, 0.9, 0.55);
      }
      if (u >= 1) {
        this.phase = 'after';
        this.phaseT = 0;
        this.rocket.visible = false;
        glow.hide(this.trailSlot);
        writeT(this.focus, v1.x, v1.y, v1.z);
        fx.fireworkBurst(L.burst[0], L.burst[1], L.burst[2], 1);
        try {
          this.onBurst?.();
        } catch (err) {
          console.error('[environment] onBurst listener threw', err);
        }
      }
    } else if (this.phase === 'after') {
      // gentle glitter rain keeps eyes up for `duration`
      this.emitAcc += dt * 16;
      while (this.emitAcc >= 1) {
        this.emitAcc -= 1;
        const a = Math.random() * TAU;
        const r = Math.sqrt(Math.random()) * 0.2;
        fx.spark(L.burst[0] + Math.cos(a) * r, L.burst[1] + (Math.random() - 0.3) * 0.12, L.burst[2] + Math.sin(a) * r * 0.5, 0, -0.04, 0, 1, 0.85, 0.5, 2.6, 2.2, CELL.glitter);
      }
      if (Number.isFinite(this.duration) && this.phaseT >= this.duration) {
        this.phase = 'spent';
        this.active = false;
      }
    } else {
      glow.hide(this.sparkSlot);
      glow.hide(this.sparkHaloSlot);
      glow.hide(this.trailSlot);
    }
  }
}
