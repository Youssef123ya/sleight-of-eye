// Particle FX: one instanced draw call per kind (poof, confetti, roses, sparks, catchFlash, stars, tick), all on the
// café's shared shader program (shader.ts). The CPU only writes a slot at emit time; motion (drag + gravity +
// flutter), size and fade run in the vertex shader. Meshes hide themselves when no particle is alive.
// Per-frame safe: one interleaved buffer per kind, uploads only the slots written this frame through two reusable
// update-range objects (no garbage), the clock is a Vector4 field write.
import {
  BufferGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
  Vector4,
  type Object3D,
  type Texture,
  type World,
} from '@iwsdk/core';
import type { Fx, FxKind } from '../contracts.js';
import type { StageRig } from '../layout.js';
import { PAL } from '../art/palette.js';
import { rigFrame, type RigFrame } from '../game/space.js';
import { AdditiveBlending, KIND, NormalBlending, doubleSided, envShaderMaterial } from './shader.js';
import { CELL } from './textures.js';
import { TAU, cameraInRig, lin, type FrameClock } from './util.js';

interface SysConf {
  name: string;
  max: number;
  life: number;
  gravity: [number, number, number];
  drag: number;
  size: [number, number];
  pop?: number;
  streak?: number;
  fadeIn?: number;
  fadeOut?: number;
  spin?: number;
  flutter?: number;
  additive?: boolean;
  shade?: boolean;
  tumble?: 'quad' | 'petal';
  renderOrder: number;
}

function petalGeometry(): BufferGeometry {
  // a cupped rose petal in XY (~1 unit tall), fan-triangulated around an inner point
  const outline: Array<[number, number]> = [
    [0, -0.5],
    [0.2, -0.36],
    [0.36, -0.12],
    [0.44, 0.12],
    [0.4, 0.32],
    [0.25, 0.46],
    [0.09, 0.5],
    [0, 0.44],
    [-0.09, 0.5],
    [-0.25, 0.46],
    [-0.4, 0.32],
    [-0.44, 0.12],
    [-0.36, -0.12],
    [-0.2, -0.36],
  ];
  const pos: number[] = [0, 0.04, -0.06];
  for (const [x, y] of outline) pos.push(x, y, -0.22 * (x / 0.44) ** 2 + 0.06 * y);
  const idx: number[] = [];
  for (let i = 0; i < outline.length; i++) idx.push(0, 1 + i, 1 + ((i + 1) % outline.length));
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// interleaved slot layout: iPos(3) origin · iVel(3) · iSeed(4) · iColor(4: rgb + birth) · iParam(4: cell, size, life, -)
const STRIDE = 18;
const O_VEL = 3;
const O_SEED = 6;
const O_COLOR = 10;
const O_PARAM = 14;
const noop = (): void => {};

class FxSystem {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly data: Float32Array;
  private readonly buffer: InstancedInterleavedBuffer;
  private readonly clock: Vector4;
  private readonly r0 = { start: 0, count: 0 };
  private readonly r1 = { start: 0, count: 0 };
  private cursor = 0;
  private deadline = -1;
  private dirtyFrom = -1; // first slot written since the last upload
  private dirtyCount = 0; // number of consecutive slots written (ring order)
  warm = 0;

  constructor(
    readonly conf: SysConf,
    atlas: Texture,
    exposure: number,
    /** FX clock cell shared with FxImpl ([0] = seconds). */
    private readonly time: Float64Array,
  ) {
    const max = conf.max;
    let base: BufferGeometry;
    if (conf.tumble === 'petal') {
      const p = petalGeometry();
      base = doubleSided(p);
      p.dispose();
    } else if (conf.tumble === 'quad') {
      const p = new PlaneGeometry(1, 0.62);
      base = doubleSided(p);
      p.dispose();
    } else base = new PlaneGeometry(1, 1);
    const geo = new InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('normal', base.getAttribute('normal'));
    if (base.getAttribute('uv')) geo.setAttribute('uv', base.getAttribute('uv'));
    this.data = new Float32Array(max * STRIDE);
    for (let i = 0; i < max; i++) {
      this.data[i * STRIDE + O_COLOR + 3] = -1e5; // birth: long dead
      this.data[i * STRIDE + O_PARAM + 2] = 1; // life scale
    }
    this.buffer = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(DynamicDrawUsage);
    // three clears updateRanges after every upload, and a cleared array re-grows its backing store on the next push:
    // keep our two reusable range objects in place instead (they are rewritten before each upload).
    this.buffer.clearUpdateRanges = noop;
    geo.setAttribute('iPos', new InterleavedBufferAttribute(this.buffer, 3, 0));
    geo.setAttribute('iVel', new InterleavedBufferAttribute(this.buffer, 3, O_VEL));
    geo.setAttribute('iSeed', new InterleavedBufferAttribute(this.buffer, 4, O_SEED));
    geo.setAttribute('iColor', new InterleavedBufferAttribute(this.buffer, 4, O_COLOR));
    geo.setAttribute('iParam', new InterleavedBufferAttribute(this.buffer, 4, O_PARAM));
    geo.instanceCount = max;
    this.clock = new Vector4();
    const mat = envShaderMaterial({
      name: `fx-${conf.name}`,
      kind: conf.tumble ? KIND.tumble : KIND.particle,
      uniforms: {
        uAtlas: { value: atlas },
        uClock: { value: this.clock },
        uLife: { value: conf.life },
        uGravity: { value: new Vector3(conf.gravity[0], conf.gravity[1], conf.gravity[2]) },
        uDrag: { value: conf.drag },
        uSize: { value: new Vector4(conf.size[0], conf.size[1], conf.pop ?? 0, conf.streak ?? 0) },
        uFade: { value: new Vector4(conf.fadeIn ?? 0.05, conf.fadeOut ?? 0.6, conf.spin ?? 0, conf.flutter ?? 0) },
        uShade: { value: conf.shade ? 1 : 0 },
        uExposure: { value: exposure },
      },
      blending: conf.tumble ? NormalBlending : conf.additive ? AdditiveBlending : NormalBlending,
      depthWrite: !!conf.tumble,
    });
    this.mesh = new Mesh(geo, mat);
    this.mesh.name = `fx-${conf.name}`;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = conf.renderOrder;
    this.mesh.matrixAutoUpdate = false;
    base.dispose();
  }

  emit(
    now: number,
    ox: number,
    oy: number,
    oz: number,
    vx: number,
    vy: number,
    vz: number,
    r: number,
    g: number,
    b: number,
    cell: number,
    sizeScale = 1,
    lifeScale = 1,
    delay = 0,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.conf.max;
    const d = this.data;
    const o = i * STRIDE;
    d[o] = ox;
    d[o + 1] = oy;
    d[o + 2] = oz;
    d[o + 3] = vx;
    d[o + 4] = vy;
    d[o + 5] = vz;
    d[o + 6] = Math.random();
    d[o + 7] = Math.random();
    d[o + 8] = Math.random();
    d[o + 9] = Math.random();
    d[o + 10] = r;
    d[o + 11] = g;
    d[o + 12] = b;
    d[o + 13] = now + delay;
    d[o + 14] = cell;
    d[o + 15] = sizeScale;
    d[o + 16] = lifeScale;
    const end = now + delay + this.conf.life * lifeScale + 0.05;
    if (end > this.deadline) this.deadline = end;
    if (this.dirtyFrom < 0) this.dirtyFrom = i;
    this.dirtyCount = Math.min(this.conf.max, this.dirtyCount + 1);
  }

  /**
   * Per-frame emitter: one particle from a staged record P = [ox, oy, oz, vx, vy, vz, r, g, b, cell, size, life],
   * born now (no double arguments to box).
   */
  emitStaged(P: Float64Array): void {
    const now = this.time[0];
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.conf.max;
    const d = this.data;
    const o = i * STRIDE;
    d[o] = P[0];
    d[o + 1] = P[1];
    d[o + 2] = P[2];
    d[o + 3] = P[3];
    d[o + 4] = P[4];
    d[o + 5] = P[5];
    d[o + 6] = Math.random();
    d[o + 7] = Math.random();
    d[o + 8] = Math.random();
    d[o + 9] = Math.random();
    d[o + 10] = P[6];
    d[o + 11] = P[7];
    d[o + 12] = P[8];
    d[o + 13] = now;
    d[o + 14] = P[9];
    d[o + 15] = P[10];
    d[o + 16] = P[11];
    const end = now + this.conf.life * P[11] + 0.05;
    if (end > this.deadline) this.deadline = end;
    if (this.dirtyFrom < 0) this.dirtyFrom = i;
    this.dirtyCount = Math.min(this.conf.max, this.dirtyCount + 1);
  }

  update(): void {
    const now = this.time[0];
    if (this.dirtyFrom >= 0) {
      // upload only the slots written since the last frame (one or two ranges because the ring wraps)
      const max = this.conf.max;
      const a0 = this.dirtyFrom;
      const n0 = Math.min(this.dirtyCount, max - a0);
      const n1 = this.dirtyCount - n0;
      const ur = this.buffer.updateRanges;
      this.r0.start = a0 * STRIDE;
      this.r0.count = n0 * STRIDE;
      ur[0] = this.r0;
      if (n1 > 0) {
        this.r1.start = 0;
        this.r1.count = n1 * STRIDE;
        ur[1] = this.r1;
        ur.length = 2;
      } else ur.length = 1;
      this.buffer.needsUpdate = true;
      this.dirtyFrom = -1;
      this.dirtyCount = 0;
    }
    const vis = now < this.deadline || this.warm > 0;
    if (this.warm > 0) this.warm--;
    if (vis) this.clock.x = now;
    this.mesh.visible = vis;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

// linear colours
const C = {
  gold: lin(PAL.gold),
  glintGold: lin(PAL.glintGold),
  warm: lin(PAL.lampWarm),
  alarm: lin(PAL.alarm),
  white: lin(0xffffff),
};
const CONFETTI = [0xffcf5a, 0xe2483f, 0x2aa3a0, 0xff8fb1, 0xf3e1c4, 0x5b7bff, 0xb48cff, 0x7fd36b].map(lin);
const PETALS = [0xc0182c, 0xd93a4a, 0xa3122a, 0xe8657a, 0xf08aa0].map(lin);
const BURST = [0xff5fa2, 0x48f0e0, 0xffd25a, 0xb57bff, 0x8dff6a, 0xff8a3d].map(lin);

/** Scratch random direction (no allocation). */
const dir = { x: 0, y: 0, z: 0 };
function randDir(upBias = 0): void {
  const u = Math.random() * 2 - 1;
  const th = Math.random() * TAU;
  const r = Math.sqrt(1 - u * u);
  dir.x = r * Math.cos(th);
  dir.y = u + upBias;
  dir.z = r * Math.sin(th);
  const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
  dir.x /= l;
  dir.y /= l;
  dir.z /= l;
}

export class FxImpl implements Fx {
  readonly group: Object3D;
  /**
   * Staged spark for per-frame emitters (gadgets): fill [ox, oy, oz, vx, vy, vz, r, g, b, cell, size, life], then
   * call emitSpark(). Same as spark() without 12 boxed double arguments per particle.
   */
  readonly sparkIn = new Float64Array(12);
  private readonly sys: Record<FxKind, FxSystem>;
  private readonly sysList: FxSystem[] = [];
  /** [0] = FX seconds, shared with every system. */
  private readonly time = new Float64Array(1);
  private now = 0;
  private lastTime = Number.NaN;
  private readonly tmp = new Vector3();
  private readonly cam = new Vector3();
  private readonly pulled = new Vector3();
  private readonly frame: RigFrame;
  private readonly world: World;

  constructor(world: World, rig: StageRig, atlas: Texture, parent: Object3D) {
    this.world = world;
    this.frame = rigFrame(rig);
    this.group = parent;
    const exposure = world.renderer.toneMappingExposure ?? 1;
    const confs: Record<FxKind, SysConf> = {
      poof: {
        name: 'poof', max: 96, life: 1.15, gravity: [0, 0.05, 0], drag: 3.2, size: [0.022, 0.075], pop: 9,
        fadeIn: 0.04, fadeOut: 0.3, spin: 1.2, flutter: 0.003, shade: true, renderOrder: 30,
      },
      confetti: {
        name: 'confetti', max: 320, life: 2.8, gravity: [0, -1.25, 0], drag: 2.3, size: [0.0095, 0.0095], spin: 9,
        flutter: 0.014, tumble: 'quad', renderOrder: 0,
      },
      roses: {
        name: 'roses', max: 192, life: 3.0, gravity: [0, -0.3, 0], drag: 2.6, size: [0.014, 0.014], spin: 3.2,
        flutter: 0.022, tumble: 'petal', renderOrder: 0,
      },
      sparks: {
        name: 'sparks', max: 768, life: 0.62, gravity: [0, -1.3, 0], drag: 1.6, size: [0.0052, 0.0016], streak: 0.03,
        fadeIn: 0.02, fadeOut: 0.5, additive: true, renderOrder: 32,
      },
      catchFlash: {
        name: 'catchFlash', max: 32, life: 0.55, gravity: [0, 0, 0], drag: 0.001, size: [0.04, 0.22], fadeIn: 0.02,
        fadeOut: 0.25, additive: true, renderOrder: 33,
      },
      stars: {
        name: 'stars', max: 128, life: 1.25, gravity: [0, -0.4, 0], drag: 2.6, size: [0.03, 0.014], pop: 7,
        fadeIn: 0.01, fadeOut: 0.72, spin: 4, shade: true, renderOrder: 31,
      },
      tick: {
        name: 'tick', max: 96, life: 0.36, gravity: [0, 0, 0], drag: 6.0, size: [0.0046, 0.0022], streak: 0.3,
        fadeIn: 0.02, fadeOut: 0.35, additive: true, renderOrder: 34,
      },
    };
    this.sys = {} as Record<FxKind, FxSystem>;
    for (const k of Object.keys(confs) as FxKind[]) {
      const s = new FxSystem(confs[k], atlas, exposure, this.time);
      this.sys[k] = s;
      this.sysList.push(s);
      parent.add(s.mesh);
    }
  }

  /** Make every FX mesh draw for a few frames so its shader program compiles now (call on XR session start). */
  warmUp(frames = 3): void {
    for (const s of this.sysList) s.warm = frames;
  }

  get clock(): number {
    return this.now;
  }

  burst(kind: FxKind, at: Vector3, opts?: { scale?: number; count?: number }): void {
    try {
      this.frame.sync();
      this.frame.toLocal(at, this.tmp);
      this.burstLocal(kind, this.tmp.x, this.tmp.y, this.tmp.z, opts?.scale ?? 1, opts?.count);
    } catch (e) {
      console.error('[fx] burst failed', e);
    }
  }

  /** Rig-local burst (used by gadgets and props). */
  burstLocal(kind: FxKind, x: number, y: number, z: number, scale = 1, count?: number): void {
    const s = Math.max(0.05, scale);
    const now = this.now;
    switch (kind) {
      case 'poof': {
        const n = count ?? 12;
        const sys = this.sys.poof;
        for (let i = 0; i < n; i++) {
          randDir(0.35);
          const sp = (0.1 + Math.random() * 0.14) * s;
          const tint = Math.random();
          sys.emit(now, x + dir.x * 0.01 * s, y + Math.abs(dir.y) * 0.008 * s, z + dir.z * 0.01 * s, dir.x * sp, dir.y * sp * 0.7 + 0.03, dir.z * sp,
            0.9 + 0.1 * tint, 0.86 + 0.08 * tint, 1.0, CELL.puff, s * (0.75 + Math.random() * 0.5), 0.75 + Math.random() * 0.5);
        }
        this.sparkle(x, y + 0.01 * s, z, Math.round(n * 1.4), s, C.glintGold.r, C.glintGold.g, C.glintGold.b);
        this.sys.sparks.emit(now, x, y + 0.012 * s, z, 0, 0, 0, 1, 0.9, 0.7, CELL.halo, 18 * s, 0.4);
        break;
      }
      case 'confetti': {
        const n = count ?? 48;
        const sys = this.sys.confetti;
        for (let i = 0; i < n; i++) {
          const th = Math.random() * TAU;
          const spread = Math.random() * 0.55;
          const sp = (0.75 + Math.random() * 0.6) * s;
          const c = CONFETTI[i % CONFETTI.length];
          sys.emit(now, x, y, z, Math.cos(th) * spread * sp, sp, Math.sin(th) * spread * sp, c.r, c.g, c.b, 0, s * (0.8 + Math.random() * 0.4), 0.8 + Math.random() * 0.4);
        }
        break;
      }
      case 'roses': {
        const n = count ?? 24;
        const sys = this.sys.roses;
        for (let i = 0; i < n; i++) {
          const th = Math.random() * TAU;
          const rr = Math.sqrt(Math.random()) * 0.11 * s;
          const c = PETALS[i % PETALS.length];
          sys.emit(now, x + Math.cos(th) * rr, y + (0.14 + Math.random() * 0.1) * s, z + Math.sin(th) * rr,
            (Math.random() - 0.5) * 0.12 * s, (0.05 + Math.random() * 0.15) * s, (Math.random() - 0.5) * 0.12 * s,
            c.r, c.g, c.b, 0, s * (0.75 + Math.random() * 0.5), 0.8 + Math.random() * 0.45, Math.random() * 0.35);
        }
        break;
      }
      case 'sparks': {
        const n = count ?? 24;
        for (let i = 0; i < n; i++) {
          randDir(0.45);
          const sp = (0.35 + Math.random() * 0.6) * s;
          const hot = Math.random();
          this.sys.sparks.emit(now, x, y, z, dir.x * sp, dir.y * sp, dir.z * sp, 1.0, 0.62 + 0.3 * hot, 0.22 + 0.4 * hot * hot, CELL.dot, s * (0.8 + Math.random() * 0.5), 0.6 + Math.random() * 0.8);
        }
        break;
      }
      case 'catchFlash': {
        const n = count ?? 3;
        this.towardViewer(x, y, z, 0.06 * s);
        x = this.pulled.x;
        y = this.pulled.y;
        z = this.pulled.z;
        for (let i = 0; i < n; i++) {
          this.sys.catchFlash.emit(now, x, y, z, 0, 0, 0, C.alarm.r * 1.4, C.alarm.g * 1.4, C.alarm.b * 1.4, CELL.ringSoft, s, 1, i * 0.08);
        }
        this.sys.catchFlash.emit(now, x, y, z, 0, 0, 0, 1.0, 0.25, 0.18, CELL.halo, s * 1.4, 0.5);
        this.radial(x, y, z, 10, 0.36 * s, s * 1.3, 1.0, 0.3, 0.22);
        break;
      }
      case 'stars': {
        const n = count ?? 9;
        for (let i = 0; i < n; i++) {
          randDir(0.9);
          const sp = (0.22 + Math.random() * 0.32) * s;
          const pale = Math.random() * 0.3;
          this.sys.stars.emit(now, x, y, z, dir.x * sp, dir.y * sp, dir.z * sp, 1.0, 0.58 + pale * 0.45, 0.06 + pale * 0.3, CELL.star5, s * (0.7 + Math.random() * 0.6), 0.8 + Math.random() * 0.4);
        }
        this.sparkle(x, y, z, 6, s, 1, 0.85, 0.45);
        break;
      }
      case 'tick': {
        this.radial(x, y, z, count ?? 6, 0.16 * s, s, 1.0, 0.94, 0.78);
        break;
      }
    }
  }

  /** Small twinkling sparkles (sparks system, short and slow). */
  sparkle(x: number, y: number, z: number, n: number, s: number, r: number, g: number, b: number): void {
    for (let i = 0; i < n; i++) {
      randDir(0.6);
      const sp = (0.08 + Math.random() * 0.2) * s;
      this.sys.sparks.emit(this.now, x + dir.x * 0.01 * s, y + dir.y * 0.01 * s, z + dir.z * 0.01 * s, dir.x * sp, dir.y * sp, dir.z * sp, r, g, b, CELL.glitter, 2.4 * s * (0.6 + Math.random() * 0.6), 1.1 + Math.random() * 0.6);
    }
  }

  /** Comic "tick" emanata: short streaks radiating in the plane facing the viewer. */
  private radial(x: number, y: number, z: number, n: number, speed: number, s: number, r: number, g: number, b: number): void {
    this.frame.sync();
    cameraInRig(this.world.camera, this.frame, this.cam);
    let fx = this.cam.x - x;
    let fy = this.cam.y - y;
    let fz = this.cam.z - z;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    // right = normalize(f × up), up' = right × f
    let rx = -fz;
    let rz = fx;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl;
    rz /= rl;
    const ux = -rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy;
    const off = Math.random() * TAU;
    for (let i = 0; i < n; i++) {
      const a = off + (i / n) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const dx = rx * ca + ux * sa;
      const dy = uy * sa;
      const dz = rz * ca + uz * sa;
      this.sys.tick.emit(this.now, x + dx * 0.012 * s, y + dy * 0.012 * s, z + dz * 0.012 * s, dx * speed, dy * speed, dz * speed, r, g, b, CELL.dot, s);
    }
  }

  /** Raw spark emitter: rig-local origin + velocity (event time; per-frame emitters use sparkIn + emitSpark). */
  spark(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, size = 1, life = 1, cell: number = CELL.dot): void {
    this.sys.sparks.emit(this.now, x, y, z, vx, vy, vz, r, g, b, cell, size, life);
  }

  /** Emit the spark staged in `sparkIn` (born now). */
  emitSpark(): void {
    this.time[0] = this.now;
    this.sys.sparks.emitStaged(this.sparkIn);
  }

  /** Big colourful firework burst at a rig-local point. */
  fireworkBurst(x: number, y: number, z: number, s = 1): void {
    const now = this.now;
    // peony shell: two speed bands so it reads as a sphere with depth
    for (let i = 0; i < 150; i++) {
      randDir(0.05);
      const band = i % 3 === 0 ? 0.42 : 0.68;
      const sp = (band + Math.random() * 0.12) * s;
      const c = BURST[i % BURST.length];
      this.sys.sparks.emit(now, x, y, z, dir.x * sp, dir.y * sp, dir.z * sp, c.r * 1.2, c.g * 1.2, c.b * 1.2, CELL.dot, 2.8 * s, 2.4 + Math.random() * 0.9);
    }
    // crackling white-gold glitter core
    for (let i = 0; i < 40; i++) {
      randDir(0.1);
      const sp = (0.12 + Math.random() * 0.28) * s;
      this.sys.sparks.emit(now, x, y, z, dir.x * sp, dir.y * sp, dir.z * sp, 1, 0.92, 0.7, CELL.glitter, 4.2 * s, 2.6 + Math.random());
    }
    this.sys.sparks.emit(now, x, y, z, 0, 0, 0, 1, 0.85, 0.6, CELL.halo, 80 * s, 0.4);
    this.sys.sparks.emit(now, x, y, z, 0, 0, 0, 1, 0.5, 0.75, CELL.ringSoft, 70 * s, 0.6);
    this.burstLocal('stars', x, y, z, 1.6 * s, 10);
  }

  /** A point moved `dist` toward the viewer (so flashes are not hidden inside the object they mark). */
  private towardViewer(x: number, y: number, z: number, dist: number): void {
    this.frame.sync();
    cameraInRig(this.world.camera, this.frame, this.cam);
    let dx = this.cam.x - x;
    let dy = this.cam.y - y;
    let dz = this.cam.z - z;
    const l = Math.hypot(dx, dy, dz) || 1;
    const k = Math.min(dist, l * 0.5) / l;
    dx *= k;
    dy *= k;
    dz *= k;
    this.pulled.x = x + dx;
    this.pulled.y = y + dy;
    this.pulled.z = z + dz;
  }

  update(dt: number, time: number): void {
    if (time === this.lastTime) return;
    this.lastTime = time;
    this.now += Math.min(Math.max(dt, 0), 0.1);
    this.updateSystems();
  }

  /** update() driven by the café's shared clock (no boxed arguments); a second call in the same frame is a no-op. */
  step(clock: FrameClock): void {
    if (clock.time === this.lastTime) return;
    this.lastTime = clock.time;
    this.now += clock.dt;
    this.updateSystems();
  }

  private updateSystems(): void {
    this.time[0] = this.now;
    for (let i = 0; i < this.sysList.length; i++) this.sysList[i].update();
  }

  dispose(): void {
    for (const s of this.sysList) {
      s.mesh.removeFromParent();
      s.dispose();
    }
  }
}
