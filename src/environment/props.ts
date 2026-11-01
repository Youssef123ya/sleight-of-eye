// Close-up props: coin, the shiny lacquered ball, three copper cups, Brock's pocket watch, the cupcake box.
// Each prop = root (the game writes its pose) → pivot (faces the player) → lifter (our animations) → meshes. Glints and
// contact shadows are slots in the shared GlowBatch / BlobBatch, updated from the prop's pose every frame.
// Per-frame safe: pivot, lifter, cupcake lid and second hand have matrixAutoUpdate off and get their matrices written
// with plain arithmetic (util.writeTRS); the decal position comes from the CURRENT local transforms (util.affineTo),
// never from getWorldPosition/worldToLocal, which recompose the IWSDK rig entity and allocate on every call.
import {
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
  type MeshMatcapMaterial,
} from '@iwsdk/core';
import type { Glint, Prop, PropAnimation, PropId } from '../contracts.js';
import { mergeParts, type Part } from '../art/geometry.js';
import type { MatcapSpec } from '../art/matcap.js';
import { PAL } from '../art/palette.js';
import { L, type StageRig } from '../layout.js';
import type { FxImpl } from './fx.js';
import { MODE, type BlobBatch, type GlowBatch } from './glow.js';
import { surfaceMaterial } from './surface.js';
import { CELL, makeDialTexture } from './textures.js';
import {
  TAU,
  affineTo,
  clamp01,
  easeInBack,
  easeInCubic,
  easeOutBack,
  easeOutCubic,
  ensureColor,
  freezeMatrix,
  lathe,
  lin,
  smoothstep,
  starPlate,
  writeRotX,
  writeRotY,
  writeTRS,
  type FrameClock,
} from './util.js';

/** All on the café's shared surface program (surface.ts). */
export interface PropMaterials {
  metal: MeshMatcapMaterial; // brass matcap, vertex coloured (coin, watch case)
  copper: MeshMatcapMaterial; // warm copper matcap (cups)
  felt: MeshMatcapMaterial; // felt matcap + fibre speckle (cupcake box)
  lacquer: MeshMatcapMaterial; // glossy red lacquer: the shiny ball the magpie stares at
  dial: MeshMatcapMaterial; // unlit dial texture
  hand: MeshMatcapMaterial; // unlit vertex colours (second hand)
}

/** Deep red lacquer with a hot white specular dot: the ball has to read as shiny (the magpie's rule). */
export const LACQUER_MATCAP: MatcapSpec = {
  base: 0xb0201a, key: 0xff7a60, keyStrength: 0.55, rim: 0xff6a50, rimStrength: 0.35, rimPower: 2.4, spec: 1.7, specSize: 0.14,
};

export interface PropEnv {
  rig: StageRig;
  glow: GlowBatch;
  blobs: BlobBatch;
  fx: FxImpl;
}

type Kind = 'coin' | 'ball' | 'cup' | 'watch' | 'cupcake';

const GOLD = lin(PAL.glintGold);
const BLUE = lin(PAL.glintBlue);
const TARGET = lin(PAL.target);
const MAT_HALF = [L.mat.size[0] / 2, L.mat.size[1] / 2] as const;
/** Contact shadows / target rings on the velvet sit just above its top; on the cloth just above the tabletop. */
const ON_MAT_Y = L.mat.top + 0.0003;
const ON_CLOTH_Y = L.tableY + 0.0012;

interface AnimState {
  kind: PropAnimation;
  t0: number;
  dur: number;
  from: number;
  resolve: (() => void) | null;
}

export class PropImpl implements Prop {
  readonly root = new Group();
  readonly pivot = new Group();
  /** Lifts / tilts / squashes inside the facing pivot (manual matrix). */
  private readonly lifter = new Group();
  readonly home: Vector3;
  lid: Object3D | null = null;
  secondHand: Object3D | null = null;
  frosting: Object3D | null = null;
  /** Watch only: how to find the cupcake when rising. */
  cupcake: PropImpl | null = null;

  private glint: Glint = 'none';
  private readonly glintSlots: number[] = [];
  private readonly blobSlot: number;
  private anim: AnimState | null = null;
  private lift = 0; // 0..1 (cups up+tilt, lid open, small props hover)
  private pop = 1; // appear/vanish scale
  private rise = 0; // watch
  private wob = -1; // wobble phase 0..1 (−1 = idle)
  private squash = 0;
  private now = 0;
  private readonly baseYaw: number;
  private pivotYaw = 0;
  private readonly lidPos = new Vector3();
  private handY = 0;
  private readonly origParent: Object3D | null = null;
  private readonly m = new Float64Array(12);
  private readonly tmp = new Vector3();
  private readonly lp = new Float64Array(8).fill(Number.NaN);
  private readonly blobApplied = new Float64Array(7).fill(Number.NaN);
  private lidApplied = Number.NaN;
  private handApplied = Number.NaN;
  private gx = 0;
  private gy = 0;
  private gz = 0;
  private gSurf = 0;
  private gTop = 0;

  constructor(
    readonly id: PropId,
    private readonly kind: Kind,
    readonly radius: number,
    readonly shiny: boolean,
    readonly cover: boolean,
    private readonly env: PropEnv,
    parent: Object3D,
    private readonly blobSize: [number, number, number],
  ) {
    const mk = L.propMarks[id];
    this.home = new Vector3(mk[0], mk[1], mk[2]);
    this.root.name = id;
    this.pivot.name = `${id}-pivot`;
    this.lifter.name = `${id}-lifter`;
    this.pivot.matrixAutoUpdate = false;
    this.lifter.matrixAutoUpdate = false;
    this.root.add(this.pivot);
    this.pivot.add(this.lifter);
    parent.add(this.root);
    this.origParent = parent;
    // face the player's eye (rig origin)
    this.baseYaw = Math.atan2(-mk[0], -mk[2]);
    for (let i = 0; i < 5; i++) this.glintSlots.push(env.glow.alloc());
    this.blobSlot = env.blobs.alloc();
    this.reset();
  }

  /** Content goes inside the lifter (so cup tilts, hovers and squashes apply). Add, then freezeMatrix() statics. */
  get content(): Group {
    return this.lifter;
  }

  /** Cupcake: the lid hinge (animated about X by the lift). */
  attachLid(lid: Object3D): void {
    this.lid = lid;
    this.lidPos.copy(lid.position);
    lid.matrixAutoUpdate = false;
    this.pose();
  }

  /** Watch: the ticking second hand (animated about Y). */
  attachSecondHand(hand: Object3D): void {
    this.secondHand = hand;
    this.handY = hand.position.y;
    hand.matrixAutoUpdate = false;
    this.handApplied = Number.NaN;
    this.updateSecondHand();
  }

  setGlint(glint: Glint): void {
    this.glint = glint;
    if (glint === 'none') for (const s of this.glintSlots) this.env.glow.hide(s);
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
    if (visible && this.pop <= 0.001 && !this.anim) this.pop = 1;
  }

  animate(anim: PropAnimation): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        this.finishAnim();
        let dur = 0.45;
        let from = 0;
        switch (anim) {
          case 'lift':
            dur = this.kind === 'cupcake' ? 0.55 : this.kind === 'cup' ? 0.5 : 0.4;
            from = this.lift;
            break;
          case 'lower':
            dur = this.kind === 'cupcake' ? 0.45 : 0.38;
            from = this.lift;
            break;
          case 'wobble':
            dur = 0.7;
            break;
          case 'appear':
            dur = 0.5;
            this.root.visible = true;
            this.pop = 0;
            break;
          case 'vanish':
            dur = 0.34;
            break;
          case 'rise':
            dur = 1.15;
            if (this.kind === 'watch') this.prepareRise();
            break;
        }
        this.anim = { kind: anim, t0: this.now, dur, from, resolve };
      } catch (e) {
        console.error('[environment] prop animate failed', e);
        resolve();
      }
    });
  }

  reset(): void {
    this.finishAnim();
    if (this.origParent && this.root.parent !== this.origParent) this.origParent.add(this.root);
    this.root.position.copy(this.home);
    this.root.quaternion.identity();
    this.root.scale.set(1, 1, 1);
    this.root.visible = true;
    this.setPivotYaw(this.baseYaw);
    this.lift = 0;
    this.pop = 1;
    this.rise = 0;
    this.wob = -1;
    this.squash = 0;
    this.setGlint('none');
    this.pose();
  }

  /** Lift state 0..1 (cups up / lid open). */
  get liftAmount(): number {
    return this.lift;
  }

  private setPivotYaw(yaw: number): void {
    this.pivotYaw = yaw;
    writeTRS(this.pivot, 0, 0, 0, 0, yaw, 0);
  }

  private finishAnim(): void {
    const a = this.anim;
    if (!a) return;
    this.anim = null;
    // jump to the end state of the cancelled animation
    if (a.kind === 'lift') this.lift = 1;
    else if (a.kind === 'lower') this.lift = 0;
    else if (a.kind === 'appear') this.pop = 1;
    else if (a.kind === 'vanish') {
      this.pop = 0;
      this.root.visible = false;
    } else if (a.kind === 'rise') this.rise = 1;
    this.wob = -1;
    this.squash = 0;
    a.resolve?.();
  }

  /** Watch: jump into the cupcake's frosting (opening the box if needed) before rising out of it. */
  private prepareRise(): void {
    const cc = this.cupcake;
    if (!cc?.frosting) return;
    if (cc.liftAmount < 0.9) void cc.animate('lift');
    const parent = this.root.parent;
    const p = this.tmp;
    if (parent && affineTo(cc.frosting, parent, this.m)) p.set(this.m[9], this.m[10], this.m[11]);
    else {
      // detached / foreign parent (never in the game): fall back to an exact world round trip (event time)
      cc.frosting.getWorldPosition(p);
      if (parent) parent.worldToLocal(p);
    }
    this.root.position.copy(p);
    this.root.quaternion.identity();
    this.root.visible = true;
    this.pop = 1;
    this.setPivotYaw(Math.atan2(-p.x, -p.z));
    this.lift = 0;
  }

  /** Per frame, driven by the café's clock (time arrives in fields, never as boxed call arguments). */
  step(clock: FrameClock): void {
    this.now = clock.now;
    if (this.anim) this.advance();
    this.pose();
    if (this.secondHand) this.updateSecondHand();
    this.updateDecals();
  }

  private advance(): void {
    const now = this.now;
    const a = this.anim;
    if (a) {
      const t = clamp01((now - a.t0) / a.dur);
      switch (a.kind) {
        case 'lift':
          this.lift = a.from + (1 - a.from) * (this.kind === 'cupcake' ? easeOutBack(t, 1.2) : easeOutBack(t, 1.5));
          break;
        case 'lower': {
          this.lift = a.from * (1 - easeInCubic(t));
          this.squash = t > 0.7 ? Math.sin(((t - 0.7) / 0.3) * Math.PI) * 0.07 : 0;
          break;
        }
        case 'wobble':
          this.wob = t;
          break;
        case 'appear':
          this.pop = easeOutBack(t, 2.6);
          this.squash = -Math.sin(t * Math.PI * 2.2) * (1 - t) * 0.22;
          break;
        case 'vanish':
          if (t < 0.35) {
            this.pop = 1;
            this.squash = -0.16 * Math.sin((t / 0.35) * Math.PI * 0.5);
          } else {
            const u = (t - 0.35) / 0.65;
            this.pop = Math.max(0, 1 - easeInBack(u, 2.2));
            this.squash = -0.16 * (1 - u);
          }
          break;
        case 'rise':
          this.rise = t;
          if (this.kind !== 'watch') this.lift = easeOutCubic(t) * 0.8;
          else this.pop = 0.4 + 0.6 * easeOutCubic(Math.min(1, t * 2.5));
          break;
      }
      if (t >= 1) {
        this.anim = null;
        if (a.kind === 'vanish') {
          this.pop = 0;
          this.root.visible = false;
        }
        if (a.kind === 'wobble') this.wob = -1;
        this.squash = 0;
        a.resolve?.();
      }
    }
  }

  /** Lifter (and cupcake lid) matrices from the animation state; skipped while nothing changes (idle props). */
  private pose(): void {
    const L1 = this.lift;
    let px = 0;
    let py = 0;
    let pz = 0;
    let rx = 0;
    let ry = 0;
    let rz = 0;
    switch (this.kind) {
      case 'cup':
        py = 0.062 * L1;
        pz = 0.012 * L1;
        rx = -0.72 * L1;
        break;
      case 'cupcake': {
        const lid = this.lid;
        const ax = -1.95 * L1;
        if (lid && ax !== this.lidApplied) {
          this.lidApplied = ax;
          writeRotX(lid, this.lidPos.x, this.lidPos.y, this.lidPos.z, ax);
        }
        break;
      }
      case 'coin':
        py = 0.04 * L1;
        rx = (Math.PI / 2) * Math.min(1, L1) * 0.92;
        break;
      case 'watch': {
        py = 0.035 * L1;
        rx = (Math.PI / 2) * Math.min(1, L1) * 0.85;
        if (this.rise > 0) {
          const r = this.rise;
          const up = easeOutBack(Math.min(1, r * 1.1), 1.8);
          py = -0.028 + 0.1 * up + (r >= 1 ? 0.004 * Math.sin(this.now * 2.2) : 0);
          pz = 0.004;
          rx = (Math.PI / 2) * easeOutCubic(Math.min(1, r * 1.4));
          ry = (1 - easeOutCubic(r)) * TAU * 1.25;
          rz = r >= 1 ? 0.07 * Math.sin(this.now * 1.6) : 0;
        }
        break;
      }
      case 'ball':
        py = 0.03 * L1;
        break;
    }
    if (this.wob >= 0) {
      const w = this.wob;
      const k = (1 - w) * (1 - w);
      rz += 0.24 * Math.sin(w * Math.PI * 5) * k;
      rx += 0.08 * Math.sin(w * Math.PI * 4 + 1) * k;
      py += 0.007 * Math.sin(w * Math.PI) * (1 - w);
    }
    const s = Math.max(0.0001, this.pop);
    const sy = s * (1 + this.squash);
    const sxz = s * (1 - this.squash * 0.5);
    const P = this.lp;
    if (px === P[0] && py === P[1] && pz === P[2] && rx === P[3] && ry === P[4] && rz === P[5] && sxz === P[6] && sy === P[7]) return;
    P[0] = px;
    P[1] = py;
    P[2] = pz;
    P[3] = rx;
    P[4] = ry;
    P[5] = rz;
    P[6] = sxz;
    P[7] = sy;
    writeTRS(this.lifter, px, py, pz, rx, ry, rz, sxz, sy, sxz, true);
  }

  private updateSecondHand(): void {
    const h = this.secondHand;
    if (!h) return;
    const now = this.now;
    const sec = Math.floor(now);
    const f = now - sec;
    const settle = f < 0.16 ? Math.sin((f / 0.16) * Math.PI) * 0.12 * (1 - f / 0.16) : 0;
    const a = -((sec % 60) + Math.min(1, f / 0.06) - 1 + settle) * (TAU / 60);
    if (a === this.handApplied) return; // the hand holds still ~3/4 of every second
    this.handApplied = a;
    writeRotY(h, 0, this.handY, 0, a);
  }

  private hideDecals(): void {
    const glow = this.env.glow;
    for (let i = 0; i < this.glintSlots.length; i++) glow.hide(this.glintSlots[i]);
    this.env.blobs.hide(this.blobSlot);
    this.blobApplied[0] = Number.NaN;
  }

  private updateDecals(): void {
    if (!this.root.visible || this.pop <= 0.02 || !this.isShown() || !affineTo(this.lifter, this.env.rig.root, this.m)) {
      this.hideDecals();
      return;
    }
    // rig-local origin of the prop body (the lifter), exact for this frame
    const ox = this.m[9];
    const oy = this.m[10];
    const oz = this.m[11];
    const r = this.radius;
    const bodyY = this.kind === 'cup' ? 0.026 : this.kind === 'cupcake' ? 0.03 : this.kind === 'ball' ? r : 0.004;
    const onMat = Math.abs(ox - L.mat.center[0]) < MAT_HALF[0] && Math.abs(oz - L.mat.center[2]) < MAT_HALF[1];
    const surf = onMat ? ON_MAT_Y : ON_CLOTH_Y;
    this.gx = ox;
    this.gy = oy + bodyY * this.pop;
    this.gz = oz;
    this.gSurf = surf;
    this.gTop = this.gy + Math.max(r, bodyY) * 0.9;

    // --- contact shadow on the mat / cloth (rewritten only when it changes)
    const hgt = Math.max(0, oy - surf);
    const fade = 1 - smoothstep(0.0, 0.16, hgt);
    if (fade > 0.01 && oy > surf - 0.03) {
      const grow = 1 + hgt * 4;
      const bs = this.blobSize;
      const sx = bs[0] * grow * this.pop;
      const sz = bs[1] * grow * this.pop;
      const op = 0.62 * fade;
      const B = this.blobApplied;
      if (ox !== B[0] || oz !== B[1] || surf !== B[2] || sx !== B[3] || sz !== B[4] || op !== B[5] || this.pivotYaw !== B[6]) {
        B[0] = ox;
        B[1] = oz;
        B[2] = surf;
        B[3] = sx;
        B[4] = sz;
        B[5] = op;
        B[6] = this.pivotYaw;
        this.env.blobs.set(this.blobSlot, ox, surf, oz, sx, sz, op, bs[2], this.pivotYaw);
      }
    } else {
      this.env.blobs.hide(this.blobSlot);
      this.blobApplied[0] = Number.NaN;
    }

    // --- glint
    const g = this.glint;
    if (g === 'none') {
      const glow = this.env.glow;
      const S = this.glintSlots;
      for (let i = 0; i < S.length; i++) glow.hide(S[i]);
    } else if (g === 'target') this.drawTarget();
    else this.drawGlint(g === 'gold');
  }

  /** Gold (lift) / blue (steal) glint around the prop body at (gx, gy, gz). */
  private drawGlint(gold: boolean): void {
    const glow = this.env.glow;
    const S = this.glintSlots;
    const now = this.now;
    const r = this.radius;
    const cx = this.gx;
    const cy = this.gy;
    const cz = this.gz;
    const k = Math.max(0.6, r / 0.0125) ** 0.75;
    const c = gold ? GOLD : BLUE;
    const pulse = gold ? 0.7 + 0.3 * Math.sin(now * 5.2) : 0.62 + 0.25 * Math.sin(now * 3.1);
    glow.set(S[0], cx, cy, cz, 0.06 * k, 0.06 * k, c.r, c.g, c.b, 0.62 * pulse, CELL.halo, MODE.pushed);
    if (gold) {
      const tw = now * 0.77 + (this.id.length % 7) * 0.13;
      const ph = tw - Math.floor(tw);
      const flash = Math.exp(-((ph - 0.5) ** 2) * 60);
      const sz = (0.035 + 0.035 * flash) * k;
      glow.set(S[1], cx + r * 0.5, this.gTop, cz + r * 0.3, sz, sz, 1, 0.92, 0.7, 0.75 + 0.25 * flash, CELL.star4, MODE.pushed, now * 0.6);
    } else {
      const sz = 0.05 * k * (0.95 + 0.08 * Math.sin(now * 4));
      glow.set(S[1], cx, cy, cz, sz, sz, c.r, c.g, c.b, 0.85, CELL.diamond, MODE.pushed, now * 0.9);
    }
    const rad = Math.max(r, 0.012) * 1.7;
    for (let i = 0; i < 3; i++) {
      const a = now * (gold ? 1.3 : -1.0) + (i * TAU) / 3;
      const tw2 = 0.5 + 0.5 * Math.sin(now * 6.3 + i * 2.1);
      const sz = (gold ? 0.012 : 0.014) * k * (0.5 + tw2);
      glow.set(S[2 + i], cx + Math.cos(a) * rad, cy + Math.sin(a * 2) * r * 0.4 + r * 0.2, cz + Math.sin(a) * rad, sz, sz, c.r, c.g, c.b, 0.9, gold ? CELL.glitter : CELL.star6, MODE.pushed, a);
    }
  }

  /** Load target: flat green ring on the mat/cloth + an outgoing ripple + soft wash, all at/above the surface top. */
  private drawTarget(): void {
    const glow = this.env.glow;
    const S = this.glintSlots;
    const now = this.now;
    const cx = this.gx;
    const cz = this.gz;
    const surf = this.gSurf;
    const base = Math.max(this.radius, 0.014) * 3.3;
    const breathe = 1 + 0.06 * Math.sin(now * 3.4);
    glow.set(S[0], cx, surf + 0.0012, cz, base * breathe, base * breathe, TARGET.r, TARGET.g, TARGET.b, 0.9, CELL.ring, MODE.flat);
    const rp = (now * 0.75) % 1;
    const rs = base * (1 + rp * 0.8);
    glow.set(S[1], cx, surf + 0.0011, cz, rs, rs, TARGET.r, TARGET.g, TARGET.b, 0.7 * (1 - rp), CELL.ring, MODE.flat);
    glow.set(S[2], cx, surf + 0.001, cz, base * 1.4, base * 1.4, TARGET.r * 0.6, TARGET.g * 0.6, TARGET.b * 0.6, 0.35, CELL.pool, MODE.flat);
    glow.hide(S[3]);
    glow.hide(S[4]);
  }

  private isShown(): boolean {
    let o: Object3D | null = this.root;
    while (o) {
      if (!o.visible) return false;
      o = o.parent;
    }
    return true;
  }
}

// ----------------------------------------------------------------------------------------------- builders

function mesh(name: string, geo: BufferGeometry, mat: Material): Mesh {
  const m = new Mesh(geo, mat);
  m.name = name;
  return m;
}

/** Add static meshes to a prop's lifter and stop recomposing their matrices every frame. */
function addStatic(parent: Object3D, ...objs: Object3D[]): void {
  for (const o of objs) {
    parent.add(o);
    freezeMatrix(o);
  }
}

function merge(parts: Part[]): BufferGeometry {
  const g = mergeParts(parts);
  for (const p of parts) p.geometry.dispose();
  return g;
}

function coinGeometry(): BufferGeometry {
  const R = 0.0125;
  const H = 0.0022;
  return merge([
    {
      geometry: lathe(
        [
          [0.0001, 0],
          [R - 0.0004, 0],
          [R, 0.0004],
          [R, H - 0.0004],
          [R - 0.0004, H],
          [R - 0.0017, H],
          [R - 0.0023, H - 0.0006],
          [0.0001, H - 0.0006],
        ],
        44,
      ),
      color: PAL.gold,
    },
    { geometry: starPlate(0.0062, 0.0027, 0.0005), color: 0xffe08a, position: [0, H - 0.0006, 0] },
    { geometry: new TorusGeometry(R - 0.0009, 0.00028, 4, 44), color: 0xffe9a8, position: [0, H - 0.0001, 0], rotation: [Math.PI / 2, 0, 0] },
  ]);
}

function cupGeometry(): BufferGeometry {
  const outer: Array<[number, number]> = [
    [0.0268, 0],
    [0.0288, 0],
    [0.0304, 0.0016],
    [0.0302, 0.0046],
    [0.0279, 0.0064],
    [0.0263, 0.012],
    [0.027, 0.0154],
    [0.0256, 0.0186],
    [0.0237, 0.0302],
    [0.0244, 0.0334],
    [0.0231, 0.0366],
    [0.0216, 0.0442],
    [0.022, 0.0468],
    [0.0206, 0.0498],
    [0.0168, 0.0508],
    [0.0148, 0.0488],
    [0.0076, 0.0474],
    [0.0001, 0.0472],
  ];
  const inner: Array<[number, number]> = [
    [0.0001, 0.0452],
    [0.012, 0.0446],
    [0.0196, 0.0418],
    [0.0226, 0.03],
    [0.0248, 0.012],
    [0.0262, 0.003],
    [0.0268, 0],
  ];
  return merge([
    { geometry: lathe(outer, 40), color: 0xffffff },
    { geometry: lathe(inner, 40), color: 0x4a3a34 },
  ]);
}

function watchParts(dialMat: Material, handMat: Material, metal: Material): { body: Mesh; dial: Mesh; hand: Group } {
  const R = 0.0156;
  const parts: Part[] = [
    {
      geometry: lathe(
        [
          [0.0001, 0],
          [0.009, 0.0005],
          [0.0138, 0.0018],
          [R, 0.0042],
          [0.0152, 0.0066],
          [0.0146, 0.0076],
          [0.0137, 0.0076],
          [0.0135, 0.0069],
          [0.0001, 0.0069],
        ],
        44,
      ),
      color: PAL.gold,
    },
    { geometry: new CylinderGeometry(0.0012, 0.0012, 0.004, 8), color: PAL.gold, position: [0, 0.0042, -R - 0.0015], rotation: [Math.PI / 2, 0, 0] },
    { geometry: new CylinderGeometry(0.0027, 0.0027, 0.0032, 14), color: 0xffd97a, position: [0, 0.0042, -R - 0.0042], rotation: [Math.PI / 2, 0, 0] },
    { geometry: new TorusGeometry(0.0052, 0.0011, 6, 20), color: PAL.gold, position: [0, 0.0042, -R - 0.0098], rotation: [Math.PI / 2, 0, 0] },
  ];
  // fob chain looping round the right side of the case in the dial plane, ending in a T-bar
  const n = 26;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = -Math.PI / 2 + 0.25 + t * 2.3; // from 12 o'clock round to ~4 o'clock
    const rad = 0.0215 + 0.009 * Math.sin(t * Math.PI) + 0.006 * t;
    const x = Math.cos(a) * rad + 0.002 * (1 - t);
    const z = Math.sin(a) * rad - 0.008 * (1 - t) * (1 - t);
    const tang = a + Math.PI / 2;
    parts.push({
      geometry: new TorusGeometry(0.0017, 0.00048, 5, 10),
      color: i % 2 ? 0xe9b84e : PAL.gold,
      position: [x, 0.0016, z],
      rotation: i % 2 ? [Math.PI / 2, 0, -tang] : [0, -tang, 0],
    });
  }
  {
    const a = -Math.PI / 2 + 0.25 + 2.3;
    const x = Math.cos(a) * 0.0275;
    const z = Math.sin(a) * 0.0275;
    parts.push({ geometry: new CylinderGeometry(0.0009, 0.0009, 0.011, 8), color: PAL.gold, position: [x, 0.0014, z], rotation: [Math.PI / 2, -a, 0] });
  }
  const body = mesh('watch-body', merge(parts), metal);
  const dialGeo = new CircleGeometry(0.0134, 40);
  dialGeo.rotateX(-Math.PI / 2);
  const dial = mesh('watch-dial', ensureColor(dialGeo), dialMat);
  dial.position.y = 0.00695;
  const hand = new Group();
  hand.name = 'watch-secondHand';
  hand.position.y = 0.0073;
  const handGeo = mergeParts([
    { geometry: new BoxGeometry(0.0006, 0.0002, 0.0118), color: 0xb0161c, position: [0, 0, -0.0042] },
    { geometry: new CylinderGeometry(0.0011, 0.0011, 0.0003, 12), color: 0x2a0a0a },
    { geometry: new CylinderGeometry(0.0013, 0.0013, 0.0002, 12), color: 0xb0161c, position: [0, 0, 0.0028] },
  ]);
  addStatic(hand, mesh('watch-hand', handGeo, handMat));
  return { body, dial, hand };
}

function cupcakeParts(felt: Material): { base: Mesh; lid: Group; frosting: Object3D } {
  const W = 0.06;
  const H = 0.036;
  const wall = 0.0022;
  const pink = 0xf2a2bf;
  const pinkIn = 0xf8d3df;
  const parts: Part[] = [
    { geometry: new BoxGeometry(W, 0.002, W), color: pink, position: [0, 0.001, 0] },
    { geometry: new BoxGeometry(W, H, wall), color: pink, position: [0, H / 2, W / 2 - wall / 2] },
    { geometry: new BoxGeometry(W, H, wall), color: pink, position: [0, H / 2, -W / 2 + wall / 2] },
    { geometry: new BoxGeometry(wall, H, W - 2 * wall), color: pink, position: [W / 2 - wall / 2, H / 2, 0] },
    { geometry: new BoxGeometry(wall, H, W - 2 * wall), color: pink, position: [-W / 2 + wall / 2, H / 2, 0] },
    { geometry: new BoxGeometry(W - 2 * wall - 0.0004, 0.0006, W - 2 * wall - 0.0004), color: pinkIn, position: [0, 0.0023, 0] },
  ];
  // cupcake: pleated paper cup, sponge, frosting swirl, cherry
  const cup = lathe(
    [
      [0.0001, 0.0021],
      [0.0165, 0.0021],
      [0.0215, 0.0235],
      [0.0001, 0.0235],
    ],
    48,
  );
  const cp = cup.attributes.position;
  for (let i = 0; i < cp.count; i++) {
    const x = cp.getX(i);
    const z = cp.getZ(i);
    const a = Math.atan2(z, x);
    const k = 1 + 0.045 * Math.sin(a * 16);
    cp.setX(i, x * k);
    cp.setZ(i, z * k);
  }
  cup.computeVertexNormals();
  parts.push({ geometry: cup, color: 0x8fd6c4 });
  parts.push({ geometry: new CylinderGeometry(0.0205, 0.0205, 0.004, 32), color: 0x8a5634, position: [0, 0.0245, 0] });
  const swirl: Array<[number, number, number]> = [
    [0.0168, 0.0064, 0.029],
    [0.0122, 0.0058, 0.0365],
    [0.0072, 0.005, 0.0425],
  ];
  for (const [r, tube, y] of swirl) parts.push({ geometry: new TorusGeometry(r, tube, 10, 28), color: 0xffb3cc, position: [0, y, 0], rotation: [Math.PI / 2, 0, 0] });
  parts.push({ geometry: new SphereGeometry(0.0062, 14, 10), color: 0xffc4d6, position: [0, 0.0455, 0] });
  parts.push({ geometry: new SphereGeometry(0.0052, 14, 10), color: 0xd0142c, position: [0, 0.0525, 0] });
  parts.push({ geometry: new CylinderGeometry(0.0004, 0.0004, 0.008, 5), color: 0x3c6a24, position: [0.0016, 0.0595, 0], rotation: [0, 0, -0.35] });
  const sprinkle = [0xffd25a, 0x6fc8ff, 0x8dff6a, 0xff8fb1, 0xb48cff];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * TAU * 2.3;
    const rr = 0.006 + (i % 4) * 0.0035;
    parts.push({
      geometry: new CylinderGeometry(0.0006, 0.0006, 0.0028, 4),
      color: sprinkle[i % sprinkle.length],
      position: [Math.cos(a) * rr, 0.034 + (0.016 - rr) * 0.6, Math.sin(a) * rr],
      rotation: [a, a * 1.7, 0.7],
    });
  }
  const base = mesh('cupcake-box', merge(parts), felt);
  // lid hinged at the back top edge
  const LW = W + 0.0036;
  const LH = 0.028;
  const lidParts: Part[] = [
    { geometry: new BoxGeometry(LW, 0.0022, LW), color: pink, position: [0, 0, LW / 2] },
    { geometry: new BoxGeometry(LW, LH, wall), color: pink, position: [0, -LH / 2, LW - wall / 2] },
    { geometry: new BoxGeometry(LW, LH, wall), color: pink, position: [0, -LH / 2, wall / 2] },
    { geometry: new BoxGeometry(wall, LH, LW), color: pink, position: [LW / 2 - wall / 2, -LH / 2, LW / 2] },
    { geometry: new BoxGeometry(wall, LH, LW), color: pink, position: [-LW / 2 + wall / 2, -LH / 2, LW / 2] },
    // ribbon cross + bow + round sticker
    { geometry: new BoxGeometry(0.0072, 0.0026, LW + 0.0006), color: 0xc8202e, position: [0, 0.0004, LW / 2] },
    { geometry: new BoxGeometry(LW + 0.0006, 0.0026, 0.0072), color: 0xc8202e, position: [0, 0.0004, LW / 2] },
    { geometry: new BoxGeometry(0.0074, LH, 0.0006), color: 0xc8202e, position: [0, -LH / 2, LW + 0.0002] },
    { geometry: new TorusGeometry(0.0062, 0.0021, 8, 18), color: 0xd62a38, position: [-0.0062, 0.0042, LW / 2], rotation: [0, 0, 0.5] },
    { geometry: new TorusGeometry(0.0062, 0.0021, 8, 18), color: 0xd62a38, position: [0.0062, 0.0042, LW / 2], rotation: [0, 0, -0.5] },
    { geometry: new SphereGeometry(0.0033, 10, 8), color: 0xb81828, position: [0, 0.0034, LW / 2] },
    { geometry: new CylinderGeometry(0.0085, 0.0085, 0.0004, 24), color: 0xfff3dc, position: [0.0175, 0.0013, LW / 2 + 0.0175] },
  ];
  const lidMesh = mesh('cupcake-lid', merge(lidParts), felt);
  const lid = new Group();
  lid.name = 'cupcake-lidHinge';
  lid.position.set(0, H + LH - 0.0058, -LW / 2);
  addStatic(lid, lidMesh);
  const frosting = new Object3D();
  frosting.name = 'cupcake-frosting';
  frosting.position.set(0, 0.047, 0);
  return { base, lid, frosting };
}

export interface PropsResult {
  props: Record<PropId, PropImpl>;
  step(clock: FrameClock): void;
  dispose(): void;
}

export function buildProps(env: PropEnv, parent: Object3D, mats: PropMaterials): PropsResult {
  const coin = new PropImpl('coin', 'coin', 0.0125, true, false, env, parent, [0.034, 0.034, CELL.blobRound]);
  addStatic(coin.content, mesh('coin-mesh', coinGeometry(), mats.metal));

  // the ball is SHINY (spec §7: the magpie stares at it): polished red lacquer, flagged shiny for the sparkle rule
  const ball = new PropImpl('ball', 'ball', 0.0095, true, false, env, parent, [0.03, 0.03, CELL.blobRound]);
  const ballGeo = new IcosahedronGeometry(0.0095, 3);
  const ballMesh = mesh('ball-mesh', mergeParts([{ geometry: ballGeo, color: 0xffffff }]), mats.lacquer);
  ballGeo.dispose();
  ballMesh.position.y = 0.0095;
  addStatic(ball.content, ballMesh);

  const cupGeo = cupGeometry();
  const cups = (['cupLeft', 'cupMid', 'cupRight'] as const).map((id) => {
    const p = new PropImpl(id, 'cup', 0.03, true, true, env, parent, [0.078, 0.078, CELL.blobRound]);
    addStatic(p.content, mesh(`${id}-mesh`, cupGeo, mats.copper));
    return p;
  });

  const watch = new PropImpl('watch', 'watch', 0.016, true, false, env, parent, [0.04, 0.04, CELL.blobRound]);
  const w = watchParts(mats.dial, mats.hand, mats.metal);
  addStatic(watch.content, w.body, w.dial);
  watch.content.add(w.hand);
  watch.attachSecondHand(w.hand);

  const cupcake = new PropImpl('cupcake', 'cupcake', 0.036, false, true, env, parent, [0.086, 0.086, CELL.blobRect]);
  const cc = cupcakeParts(mats.felt);
  addStatic(cupcake.content, cc.base, cc.frosting);
  cupcake.content.add(cc.lid);
  cupcake.attachLid(cc.lid);
  cupcake.frosting = cc.frosting;
  watch.cupcake = cupcake;

  const props: Record<PropId, PropImpl> = {
    coin,
    ball,
    cupLeft: cups[0],
    cupMid: cups[1],
    cupRight: cups[2],
    watch,
    cupcake,
  };
  const list = Object.values(props);
  return {
    props,
    step(clock) {
      for (let i = 0; i < list.length; i++) list[i].step(clock);
    },
    dispose() {
      const seen = new Set<BufferGeometry>();
      for (const p of list) {
        p.root.removeFromParent();
        p.root.traverse((o) => {
          const m = o as Mesh;
          if (m.isMesh && !seen.has(m.geometry)) {
            seen.add(m.geometry);
            m.geometry.dispose();
          }
        });
      }
    },
  };
}

/** Prop materials on the café's shared surface program (cafe.ts owns and disposes them). */
export function makePropMaterials(metal: MeshMatcapMaterial, felt: MeshMatcapMaterial, copper: MeshMatcapMaterial): PropMaterials {
  const dial = surfaceMaterial({ map: makeDialTexture(), name: 'env-watchDial' });
  const hand = surfaceMaterial({ name: 'env-watchHand' });
  const lacquer = surfaceMaterial({ matcap: LACQUER_MATCAP, name: 'env-ballLacquer' });
  return { metal, felt, copper, lacquer, dial, hand };
}
