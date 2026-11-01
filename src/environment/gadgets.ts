// Shelf gadgets that fire when the player looks at them: a wind-up music box with a spinning felt dancer,
// a brass candle that flares, and a little firework rocket with a sparkling fuse that bursts above the audience.
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
import { feltMaterial, matcapMaterial } from '../art/matcap.js';
import { PAL } from '../art/palette.js';
import { CFG } from '../config.js';
import { L, type StageRig } from '../layout.js';
import type { FxImpl } from './fx.js';
import { MODE, type BlobBatch, type GlowBatch } from './glow.js';
import { lightLevelAt } from './light.js';
import { CELL } from './textures.js';
import { TAU, approach, clamp01, easeInCubic, lathe, lin, noise1, roundedBox, smoothstep, starPlate } from './util.js';

export interface GadgetEnv {
  rig: StageRig;
  glow: GlowBatch;
  blobs: BlobBatch;
  fx: FxImpl;
}

const GOLD = lin(PAL.glintGold);
const v1 = new Vector3();
const v2 = new Vector3();
const q1 = new Quaternion();
const e1 = new Euler();
const UP = new Vector3(0, 1, 0);

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
  private dimNow = 1;
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

  /** Move to a rig-local base point, facing the player; re-samples the baked light level there. */
  place(x: number, y: number, z: number): void {
    this.root.position.set(x, y, z);
    this.root.rotation.set(0, Math.atan2(-x, -z), 0);
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
      for (const { m, base } of this.mats) m.color.copy(base).multiplyScalar(k);
      this.root.updateWorldMatrix(true, false);
      this.tick(d);
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
    out.set(x, y, z);
    this.root.localToWorld(out);
    return this.env.rig.root.worldToLocal(out);
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
    const h = Math.max(0, this.root.position.y - surfY);
    const fade = 1 - smoothstep(0, 0.12, h);
    const x = this.root.position.x;
    const z = this.root.position.z;
    const f = this.footprint;
    this.env.blobs.set(this.blobSlot, x, surfY + 0.0012, z, f * (1 + h * 3), f * 0.8 * (1 + h * 3), 0.55 * fade + 0.08, CELL.blobRound, this.root.rotation.y);
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

  constructor(env: GadgetEnv, parent: Object3D) {
    super('musicBox', env, parent, 0.05, CFG.musicBoxDuration, 0.034, 0.1);
    const wood = this.own(matcapMaterial('wood'));
    const brass = this.own(matcapMaterial('brass'));
    const felt = this.own(feltMaterial());
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
    this.root.add(mesh('musicBox-body', merge(body), wood));
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
    this.root.add(mesh('musicBox-trim', merge(trim), brass));
    // crank (spins while winding / playing)
    this.crank.position.set(W / 2 + 0.008, 0.02, 0);
    this.crank.add(
      mesh(
        'musicBox-crank',
        merge([
          { geometry: new BoxGeometry(0.0022, 0.016, 0.0032), color: PAL.brass, position: [0, 0.007, 0] },
          { geometry: new CylinderGeometry(0.0028, 0.0028, 0.008, 12), color: 0xe9c46a, position: [0.004, 0.0145, 0], rotation: [0, 0, Math.PI / 2] },
        ]),
        brass,
      ),
    );
    this.root.add(this.crank);
    // lid: hinged at the back top edge, inlaid star, mirror inside
    this.lid.position.set(0, rimTop, -D / 2 - 0.001);
    const LD = D + 0.002;
    this.lid.add(
      mesh(
        'musicBox-lid',
        merge([
          { geometry: roundedBox(W + 0.002, 0.011, LD, 0.0024), color: mahogany, position: [0, 0.0055, LD / 2] },
          { geometry: starPlate(0.0115, 0.005, 0.0006), color: 0xe8c07a, position: [0, 0.011, LD / 2] },
          { geometry: new BoxGeometry(W - 0.012, 0.0008, LD - 0.012), color: 0xc8d4e0, position: [0, -0.0004, LD / 2] },
          { geometry: new BoxGeometry(W + 0.0024, 0.0016, 0.004), color: 0xc8925a, position: [0, 0.0065, LD - 0.0005] },
        ]),
        wood,
      ),
    );
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
    this.dancer.add(mesh('musicBox-dancer', merge(dancerParts), felt));
    this.dancer.position.y = -0.002;
    this.root.add(this.dancer);
    this.focus.position.set(0, bodyTop + 0.03, 0);
    this.shine = [W / 2 + 0.012, 0.035, 0.002];
    this.glowSlot = env.glow.alloc();
    for (let i = 0; i < 8; i++) {
      this.noteSlots.push(env.glow.alloc());
      this.notes.push({ t0: -10, x: 0, z: 0, alive: false });
    }
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
    this.lid.rotation.x = -1.82 * Math.max(-0.02, lid);
    this.dancer.position.y = -0.002 + (MB.bodyTop + 0.0015 + 0.002) * clamp01(up) + 0.0012 * Math.sin(this.now * 6) * clamp01(up);
    if (up > 0.05) this.spin += dt * (5.5 + 2 * up);
    this.dancer.rotation.y = this.spin;
    this.dancer.rotation.z = 0.06 * Math.sin(this.now * 3.1) * clamp01(up);
    // crank: a quick wind on activation, then a slow turn while the tune plays
    const wind = this.active && t < 0.45 ? 22 : this.active ? 4.5 : 0;
    this.crankA += dt * wind;
    this.crank.rotation.x = this.crankA;
    if (this.closing && lid < 0.02 && up < 0.02) this.closing = false;
    // focus follows the dancer
    this.focus.position.set(0, MB.bodyTop + 0.012 + 0.02 * clamp01(up), 0);

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
    const brass = this.own(matcapMaterial('brass'));
    const wax = this.own(feltMaterial({ fuzz: 0.025 }));
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
    this.root.add(mesh('candle-holder', merge(holder), brass));
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
    this.root.add(mesh('candle-wax', merge(waxParts), wax));
    this.flameSlot = env.glow.alloc();
    this.coreSlot = env.glow.alloc();
    this.haloSlot = env.glow.alloc();
    this.emberSlot = env.glow.alloc();
    this.focus.position.set(0, Candle.WICK + 0.012, 0);
    this.shine = [-0.029, 0.007, 0.012];
    this.litS.set(1);
  }

  protected onActivate(): void {
    this.sparkAcc = 0;
    this.env.fx.sparkle(...this.flameTip(), 10, 1.2, 1, 0.85, 0.5);
  }
  protected onReset(): void {
    this.flareS.set(0);
  }

  private flameTip(): [number, number, number] {
    this.toRig(0, Candle.WICK + 0.02, 0, v2);
    return [v2.x, v2.y, v2.z];
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
    this.focus.position.set(0, Candle.WICK + 0.4 * h + 0.004, 0);
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

export class Firework extends GadgetBase {
  private readonly rocket = new Group();
  private readonly fuse: Mesh;
  private readonly fusePts: Vector3[] = [];
  private readonly fuseIndexPerSeg: number;
  private readonly fuseSegs = 64;
  private phase: FwPhase = 'idle';
  private phaseT = 0;
  private readonly sparkSlot: number;
  private readonly sparkHaloSlot: number;
  private readonly trailSlot: number;
  private emitAcc = 0;
  private readonly start = new Vector3(0, 0.016, 0);
  private readonly prev = new Vector3();
  private static readonly FLIGHT = 0.62;

  constructor(env: GadgetEnv, parent: Object3D) {
    super('firework', env, parent, 0.045, CFG.bangLookDuration, 0.045, 0.07);
    const brass = this.own(matcapMaterial('brass'));
    const glossy = this.own(matcapMaterial('glossy'));
    const twine = this.own(matcapMaterial('wood'));
    // brass tripod launcher
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
      q1.setFromUnitVectors(UP, v1.normalize());
      e1.setFromQuaternion(q1, 'XYZ');
      stand.push({ geometry: new CylinderGeometry(0.0016, 0.0016, len, 6), color: PAL.brass, position: [mx, 0.015, mz], rotation: [e1.x, e1.y, e1.z] });
      stand.push({ geometry: new SphereGeometry(0.0028, 8, 6), color: PAL.gold, position: [bx, 0.0016, bz] });
    }
    stand.push({ geometry: new TorusGeometry(0.0128, 0.0018, 6, 24), color: PAL.brass, position: [0, 0.03, 0], rotation: [Math.PI / 2, 0, 0] });
    stand.push({ geometry: new TorusGeometry(0.019, 0.0012, 6, 24), color: PAL.brass, position: [0, 0.011, 0], rotation: [Math.PI / 2, 0, 0] });
    this.root.add(mesh('firework-stand', merge(stand), brass));
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
    this.rocket.add(mesh('firework-rocket', merge(rk), glossy));
    this.rocket.position.copy(this.start);
    this.root.add(this.rocket);
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
    this.root.add(this.fuse);
    for (let i = 0; i <= 48; i++) this.fusePts.push(curve.getPointAt(i / 48));
    this.sparkSlot = env.glow.alloc();
    this.sparkHaloSlot = env.glow.alloc();
    this.trailSlot = env.glow.alloc();
    this.focus.position.set(0, 0.06, 0);
    this.shine = [0.002, 0.016 + 0.087, 0.002];
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
    this.rocket.position.copy(this.start);
    this.rocket.quaternion.identity();
    this.fuse.geometry.setDrawRange(0, Infinity);
    this.focus.position.set(0, 0.06, 0);
  }

  override progress(): number {
    if (!this.active) return 0;
    if (this.phase === 'fuse') return clamp01(1 - this.phaseT / CFG.fuseDuration);
    return 0;
  }

  /** Point along the unburnt fuse at fraction u (0 = rocket end, 1 = tip), gadget-local. */
  private fuseAt(u: number, out: Vector3): Vector3 {
    const f = clamp01(u) * (this.fusePts.length - 1);
    const i = Math.min(this.fusePts.length - 2, Math.floor(f));
    return out.copy(this.fusePts[i]).lerp(this.fusePts[i + 1], f - i);
  }

  protected tick(dt: number): void {
    const glow = this.env.glow;
    const fx = this.env.fx;
    this.phaseT += dt;
    if (this.phase === 'fuse') {
      const remain = clamp01(1 - this.phaseT / CFG.fuseDuration);
      this.fuse.geometry.setDrawRange(0, Math.max(0, Math.floor(remain * this.fuseSegs)) * this.fuseIndexPerSeg);
      this.fuseAt(remain, v1);
      this.focus.position.copy(v1);
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
        this.prev.copy(this.rocket.position);
        glow.hide(this.sparkSlot);
        glow.hide(this.sparkHaloSlot);
        fx.burstLocal('poof', v2.x, v2.y, v2.z, 0.6, 6);
      }
    } else if (this.phase === 'flight') {
      const u = clamp01(this.phaseT / Firework.FLIGHT);
      // burst point in gadget-local space
      v1.set(L.burst[0], L.burst[1], L.burst[2]);
      this.env.rig.root.localToWorld(v1);
      this.root.worldToLocal(v1);
      const e = easeInCubic(u) * 0.75 + u * 0.25;
      this.prev.copy(this.rocket.position);
      this.rocket.position.copy(this.start).lerp(v1, e);
      this.rocket.position.x += Math.sin(u * 19) * 0.006 * u;
      this.rocket.position.z += Math.cos(u * 15) * 0.004 * u;
      v2.copy(this.rocket.position).sub(this.prev);
      if (v2.lengthSq() > 1e-10) {
        v2.normalize();
        q1.setFromUnitVectors(UP, v2);
        this.rocket.quaternion.slerp(q1, Math.min(1, dt * 18));
      }
      this.focus.position.copy(this.rocket.position);
      this.toRig(this.rocket.position.x, this.rocket.position.y, this.rocket.position.z, v2);
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
        this.focus.position.copy(v1);
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
