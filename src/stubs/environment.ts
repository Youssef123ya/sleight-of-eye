// Stub café (G): table, mat, riser, shelf, lamp, props, gadgets and a one-draw-call particle Fx, implementing
// the Cafe/Prop/Gadget/Fx contracts so the gameplay core runs before src/environment lands.
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  RingGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  Vector2,
  Vector3,
  type Object3D,
  type World,
} from '@iwsdk/core';
import { mergeParts, tint, type Part } from '../art/geometry.js';
import { feltMaterial, matcapMaterial } from '../art/matcap.js';
import { PAL } from '../art/palette.js';
import { CFG } from '../config.js';
import type {
  Cafe,
  EnvironmentFactory,
  Fx,
  FxKind,
  Gadget,
  GadgetId,
  Glint,
  Prop,
  PropAnimation,
  PropId,
} from '../contracts.js';
import { L, type StageRig, type V3 } from '../layout.js';
import { Tweens, glowSprite, glowTexture } from './common.js';

const GLINT_COLOR: Record<Exclude<Glint, 'none'>, number> = {
  gold: PAL.glintGold,
  blue: PAL.glintBlue,
  target: PAL.target,
};

// ------------------------------------------------------------------------------------------------ props
class StubProp implements Prop {
  readonly root = new Group();
  /** Inner node the stub animates (the game owns `root`'s position). */
  readonly body = new Group();
  readonly home: Vector3;
  private readonly glintSprite: Sprite;
  private readonly ring: Mesh | null;
  private glint: Glint = 'none';
  private readonly tweens = new Tweens();
  private time = 0;
  /** Cups/box: the part that lifts. */
  shell: Object3D | null = null;
  lid: Object3D | null = null;

  constructor(
    readonly id: PropId,
    readonly radius: number,
    readonly shiny: boolean,
    readonly cover: boolean,
    home: V3,
    glintSize: number,
    glintY: number,
  ) {
    this.root.name = id;
    this.home = new Vector3(home[0], home[1], home[2]);
    this.root.add(this.body);
    this.glintSprite = glowSprite(PAL.glintGold, glintSize, 0.9);
    this.glintSprite.position.y = glintY;
    this.glintSprite.visible = false;
    this.root.add(this.glintSprite);
    // a soft ring on the cloth marks a target
    const ringMat = new MeshBasicMaterial({ color: PAL.target, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false });
    this.ring = new Mesh(new RingGeometry(radius * 1.15, radius * 1.4, 40), ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.001;
    this.ring.visible = false;
    this.root.add(this.ring);
    this.reset();
  }

  setGlint(glint: Glint): void {
    this.glint = glint;
    this.glintSprite.visible = glint !== 'none';
    if (glint !== 'none') (this.glintSprite.material as SpriteMaterial).color.setHex(GLINT_COLOR[glint]);
    if (this.ring) this.ring.visible = glint === 'target';
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  animate(anim: PropAnimation): Promise<void> {
    const b = this.body;
    switch (anim) {
      case 'wobble':
        return this.tweens.run(0.7, (u) => {
          b.rotation.z = 0.35 * Math.sin(u * Math.PI * 4) * (1 - u);
        });
      case 'appear':
        b.scale.setScalar(0.01);
        return this.tweens.run(0.4, (u) => {
          const s = u < 0.7 ? (u / 0.7) * 1.2 : 1.2 - 0.2 * ((u - 0.7) / 0.3);
          b.scale.setScalar(Math.max(0.01, s));
        });
      case 'vanish':
        return this.tweens.run(0.25, (u) => b.scale.setScalar(Math.max(0.01, 1 - u)));
      case 'lift': {
        const part = this.lid ?? this.shell;
        if (!part) return Promise.resolve();
        if (this.lid) return this.tweens.run(0.5, (u) => (part.rotation.x = -1.9 * easeOut(u)));
        return this.tweens.run(0.45, (u) => {
          part.position.y = 0.06 * easeOut(u);
          part.rotation.x = 0.45 * easeOut(u);
        });
      }
      case 'lower': {
        const part = this.lid ?? this.shell;
        if (!part) return Promise.resolve();
        if (this.lid) return this.tweens.run(0.4, (u) => (part.rotation.x = -1.9 * (1 - u)));
        return this.tweens.run(0.35, (u) => {
          part.position.y = 0.06 * (1 - u * u);
          part.rotation.x = 0.45 * (1 - u);
        });
      }
      case 'rise':
        b.position.y = -0.03;
        return this.tweens.run(1.4, (u) => {
          b.position.y = -0.03 + 0.085 * easeOut(u);
          b.rotation.y = u * Math.PI * 2;
        });
    }
    return Promise.resolve();
  }

  reset(): void {
    this.tweens.clear();
    this.root.position.copy(this.home);
    this.root.rotation.set(0, 0, 0);
    this.root.visible = true;
    this.body.position.set(0, 0, 0);
    this.body.rotation.set(0, 0, 0);
    this.body.scale.setScalar(1);
    if (this.shell) {
      this.shell.position.set(0, 0, 0);
      this.shell.rotation.set(0, 0, 0);
    }
    if (this.lid) this.lid.rotation.set(0, 0, 0);
    this.setGlint('none');
  }

  update(dt: number): void {
    this.time += dt;
    this.tweens.update(dt);
    if (this.glint !== 'none') {
      const p = 0.75 + 0.25 * Math.sin(this.time * (this.glint === 'blue' ? 5 : 3.2));
      (this.glintSprite.material as SpriteMaterial).opacity = p;
      const s = this.radius * 2.6 * (0.9 + 0.15 * p);
      this.glintSprite.scale.setScalar(s);
    }
  }
}

function easeOut(u: number): number {
  const x = 1 - Math.min(1, Math.max(0, u));
  return 1 - x * x * x;
}

// ---------------------------------------------------------------------------------------------- gadgets
class StubGadget implements Gadget {
  readonly root = new Group();
  readonly focus = new Group();
  duration: number;
  onBurst: (() => void) | null = null;
  private active = false;
  private t = 0;
  private used = false;
  private available = false;
  private burst = false;
  private readonly ring: Mesh;
  private readonly ringMat: MeshBasicMaterial;
  private readonly ringTotal: number;
  private readonly halo: Sprite;
  private readonly mats: MeshBasicMaterial[] = [];
  private readonly tintables: Array<{ m: { color: Color }; base: Color }> = [];
  private time = 0;
  // per-kind parts
  lid: Object3D | null = null;
  dancer: Object3D | null = null;
  flame: Sprite | null = null;
  spark: Sprite | null = null;

  constructor(
    readonly id: GadgetId,
    readonly gazeRadius: number,
    duration: number,
    focusAt: V3,
    private readonly fx: StubFx,
    private readonly rig: StageRig,
  ) {
    this.root.name = id;
    this.focus.name = `${id}-focus`;
    this.focus.position.set(focusAt[0], focusAt[1], focusAt[2]);
    this.root.add(this.focus);
    this.duration = duration;
    // dwell ring around the focus, facing the eye
    const segs = 48;
    const ringGeo = new RingGeometry(gazeRadius * 0.82, gazeRadius, segs, 1);
    this.ringTotal = ringGeo.index ? ringGeo.index.count : segs * 6;
    ringGeo.setDrawRange(0, 0);
    this.ringMat = new MeshBasicMaterial({ color: PAL.lampWarm, transparent: true, opacity: 0.9, depthWrite: false, side: DoubleSide, toneMapped: false });
    this.ring = new Mesh(ringGeo, this.ringMat);
    this.ring.name = `${id}-dwell`;
    this.ring.renderOrder = 12;
    this.focus.add(this.ring);
    this.halo = glowSprite(PAL.lampAmber, gazeRadius * 2.6, 0.35);
    this.halo.visible = false;
    this.focus.add(this.halo);
  }

  /** Orient the dwell ring toward the eye (rig origin) once the gadget is placed. */
  faceEye(): void {
    this.root.updateWorldMatrix(true, true);
    const eye = this.rig.toWorld([0, 0, 0], new Vector3());
    this.ring.lookAt(eye);
  }

  tintable(m: { color: Color }): void {
    this.tintables.push({ m, base: m.color.clone() });
  }

  activate(): void {
    if (this.active) return;
    this.active = true;
    this.burst = false;
    this.t = 0;
  }

  isActive(): boolean {
    return this.active;
  }

  progress(): number {
    if (!this.active) return 0;
    if (this.id === 'firework' && !this.burst) return 1 - Math.min(1, this.t / CFG.fuseDuration);
    if (!Number.isFinite(this.duration)) return 1;
    const t = this.id === 'firework' ? this.t - CFG.fuseDuration : this.t;
    return Math.max(0, 1 - t / Math.max(1e-3, this.duration));
  }

  setDwell(p: number): void {
    const n = Math.floor(Math.max(0, Math.min(1, p)) * (this.ringTotal / 6)) * 6;
    this.ring.geometry.setDrawRange(0, n);
  }

  setUsed(used: boolean): void {
    this.used = used;
    for (const t of this.tintables) t.m.color.copy(t.base).multiplyScalar(used ? 0.45 : 1);
    this.refreshHalo();
  }

  setAvailable(available: boolean): void {
    this.available = available;
    this.refreshHalo();
  }

  reset(): void {
    this.active = false;
    this.burst = false;
    this.t = 0;
    if (this.lid) this.lid.rotation.x = 0;
    if (this.dancer) {
      this.dancer.position.y = 0;
      this.dancer.rotation.y = 0;
      this.dancer.visible = false;
    }
    if (this.flame) this.flame.scale.set(0.022, 0.034, 1);
    if (this.spark) this.spark.visible = false;
    if (this.id === 'firework') this.focus.position.set(0, 0.16, 0);
    this.setDwell(0);
  }

  private refreshHalo(): void {
    this.halo.visible = this.available && !this.used && !this.active;
  }

  update(dt: number): void {
    this.time += dt;
    if (this.halo.visible) (this.halo.material as SpriteMaterial).opacity = 0.22 + 0.12 * Math.sin(this.time * 3);
    if (!this.active) {
      if (this.flame) this.flame.scale.set(0.022 + 0.002 * Math.sin(this.time * 17), 0.034 + 0.004 * Math.sin(this.time * 11), 1);
      return;
    }
    this.t += dt;
    this.refreshHalo();
    const dur = Number.isFinite(this.duration) ? this.duration : Infinity;
    switch (this.id) {
      case 'musicBox': {
        if (this.lid) this.lid.rotation.x = -1.6 * Math.min(1, this.t / 0.4);
        if (this.dancer) {
          this.dancer.visible = true;
          this.dancer.position.y = 0.035 * Math.min(1, this.t / 0.5);
          this.dancer.rotation.y += dt * 5;
        }
        if (this.t >= dur) this.end();
        break;
      }
      case 'candle': {
        const p = this.progress();
        if (this.flame) {
          const s = 1 + 2.4 * p;
          this.flame.scale.set(0.022 * s * (1 + 0.08 * Math.sin(this.time * 23)), 0.034 * s * (1 + 0.1 * Math.sin(this.time * 13)), 1);
        }
        if (this.t >= dur) this.end();
        break;
      }
      case 'firework': {
        if (!this.burst) {
          if (this.spark) {
            this.spark.visible = true;
            const u = Math.min(1, this.t / CFG.fuseDuration);
            this.spark.position.set(0, 0.12 + 0.05 * u, 0);
            this.spark.scale.setScalar(0.02 + 0.008 * Math.sin(this.time * 40));
            this.focus.position.copy(this.spark.position);
          }
          if (this.t >= CFG.fuseDuration) {
            this.burst = true;
            if (this.spark) this.spark.visible = false;
            // the burst hangs above the stage
            const p = this.rig.toWorld(L.burst, new Vector3());
            this.root.worldToLocal(this.focus.position.copy(p));
            this.fx.burst('sparks', p, { count: 120, scale: 1.2 });
            try {
              this.onBurst?.();
            } catch (e) {
              console.warn('[stub firework] onBurst threw', e);
            }
          }
        } else if (this.t - CFG.fuseDuration >= dur) this.end();
        break;
      }
    }
  }

  private end(): void {
    this.active = false;
    if (this.lid) this.lid.rotation.x = 0;
    if (this.dancer) this.dancer.visible = false;
    if (this.spark) this.spark.visible = false;
    this.refreshHalo();
  }
}

// --------------------------------------------------------------------------------------------------- fx
interface FxStyle {
  colors: number[];
  count: number;
  speed: number;
  up: number;
  gravity: number;
  life: number;
  drag: number;
}
const FX: Record<FxKind, FxStyle> = {
  poof: { colors: [0xfff4dc, 0xffe2b0, 0xffffff], count: 28, speed: 0.18, up: 0.05, gravity: -0.05, life: 0.7, drag: 3.5 },
  confetti: { colors: [0xffcf5a, 0xe85a6a, 0x6fc8ff, 0x9dffb0, 0xffffff], count: 60, speed: 0.45, up: 0.55, gravity: 0.9, life: 1.8, drag: 1.4 },
  roses: { colors: [0xd2372f, 0xa8322d, 0xff7f8e], count: 16, speed: 0.25, up: 0.45, gravity: 0.6, life: 2.0, drag: 1.8 },
  sparks: { colors: [0xffd76a, 0xffb35c, 0x2aa3a0, 0xff7f8e, 0xffffff], count: 110, speed: 0.55, up: 0.05, gravity: 0.25, life: 1.6, drag: 1.6 },
  catchFlash: { colors: [0xff4a3d, 0xffb35c], count: 24, speed: 0.3, up: 0.05, gravity: 0, life: 0.45, drag: 5 },
  stars: { colors: [0xffd76a, 0xfff4dc], count: 10, speed: 0.12, up: 0.18, gravity: -0.02, life: 1.1, drag: 2 },
  tick: { colors: [0xffd76a, 0xffffff], count: 4, speed: 0.06, up: 0.04, gravity: 0, life: 0.45, drag: 3 },
};

class StubFx implements Fx {
  readonly points: Points;
  private readonly cap = 420;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly base: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private next = 0;
  private alive = 0;
  private readonly tmp = new Vector3();
  private readonly c = new Color();

  constructor(private readonly rig: StageRig) {
    const g = new BufferGeometry();
    this.pos = new Float32Array(this.cap * 3);
    this.col = new Float32Array(this.cap * 3);
    this.vel = new Float32Array(this.cap * 3);
    this.life = new Float32Array(this.cap);
    this.maxLife = new Float32Array(this.cap);
    this.base = new Float32Array(this.cap * 3);
    this.grav = new Float32Array(this.cap);
    this.drag = new Float32Array(this.cap);
    g.setAttribute('position', new BufferAttribute(this.pos, 3));
    g.setAttribute('color', new BufferAttribute(this.col, 3));
    const m = new PointsMaterial({
      size: 0.012,
      map: glowTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    this.points = new Points(g, m);
    this.points.name = 'fx';
    this.points.frustumCulled = false;
    this.points.renderOrder = 15;
    this.points.visible = false;
  }

  burst(kind: FxKind, at: Vector3, opts?: { scale?: number; count?: number }): void {
    const st = FX[kind] ?? FX.poof;
    const n = Math.min(this.cap, Math.max(1, Math.round(opts?.count ?? st.count)));
    const sc = opts?.scale ?? 1;
    this.rig.toLocal(at, this.tmp);
    for (let i = 0; i < n; i++) {
      const k = this.next;
      this.next = (this.next + 1) % this.cap;
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const sp = st.speed * sc * (0.45 + 0.55 * Math.random());
      this.pos[k * 3] = this.tmp.x;
      this.pos[k * 3 + 1] = this.tmp.y;
      this.pos[k * 3 + 2] = this.tmp.z;
      this.vel[k * 3] = r * Math.cos(a) * sp;
      this.vel[k * 3 + 1] = u * sp + st.up * sc * Math.random();
      this.vel[k * 3 + 2] = r * Math.sin(a) * sp;
      this.c.setHex(st.colors[(Math.random() * st.colors.length) | 0]);
      this.base[k * 3] = this.c.r;
      this.base[k * 3 + 1] = this.c.g;
      this.base[k * 3 + 2] = this.c.b;
      this.maxLife[k] = this.life[k] = st.life * (0.7 + 0.5 * Math.random());
      this.grav[k] = st.gravity;
      this.drag[k] = st.drag;
    }
    this.alive = this.cap;
    this.points.visible = true;
  }

  update(dt: number): void {
    if (!this.points.visible) return;
    let any = false;
    for (let k = 0; k < this.cap; k++) {
      if (this.life[k] <= 0) {
        this.col[k * 3] = this.col[k * 3 + 1] = this.col[k * 3 + 2] = 0;
        continue;
      }
      any = true;
      this.life[k] -= dt;
      const f = Math.exp(-this.drag[k] * dt);
      this.vel[k * 3] *= f;
      this.vel[k * 3 + 1] = this.vel[k * 3 + 1] * f - this.grav[k] * dt;
      this.vel[k * 3 + 2] *= f;
      this.pos[k * 3] += this.vel[k * 3] * dt;
      this.pos[k * 3 + 1] += this.vel[k * 3 + 1] * dt;
      this.pos[k * 3 + 2] += this.vel[k * 3 + 2] * dt;
      const fade = Math.max(0, this.life[k] / this.maxLife[k]);
      const a = fade * fade;
      this.col[k * 3] = this.base[k * 3] * a;
      this.col[k * 3 + 1] = this.base[k * 3 + 1] * a;
      this.col[k * 3 + 2] = this.base[k * 3 + 2] * a;
    }
    const g = this.points.geometry;
    (g.attributes.position as BufferAttribute).needsUpdate = true;
    (g.attributes.color as BufferAttribute).needsUpdate = true;
    if (!any) {
      this.alive = 0;
      this.points.visible = false;
    }
  }
}

// ---------------------------------------------------------------------------------------------- the café
class StubCafe implements Cafe {
  readonly root = new Group();
  readonly props = {} as Record<PropId, Prop>;
  readonly gadgets = {} as Record<GadgetId, Gadget>;
  readonly seats: Object3D[] = [];
  readonly volunteerSpot = new Group();
  readonly posterWall = new Group();
  readonly plaqueAnchors: Object3D[] = [];
  private readonly stubProps: StubProp[] = [];
  private readonly stubGadgets: StubGadget[] = [];
  private lampHalo: Sprite | null = null;
  private poolMat: MeshBasicMaterial | null = null;
  private lamp = 1;
  private time = 0;

  constructor(
    private readonly rig: StageRig,
    readonly fx: StubFx,
  ) {
    this.root.name = 'cafe';
    rig.root.add(this.root);
    this.root.add(fx.points);
    this.buildRoom();
    this.buildProps();
    this.buildGadgets();
    // anchors
    L.seats.forEach((s, i) => {
      const seat = new Group();
      seat.name = `seat-${i}`;
      seat.position.set(s[0], s[1], s[2]);
      this.root.add(seat);
      this.seats.push(seat);
    });
    this.volunteerSpot.name = 'volunteerSpot';
    this.volunteerSpot.position.set(...L.volunteerSpot);
    this.root.add(this.volunteerSpot);
    this.posterWall.name = 'posterWall';
    this.posterWall.position.set(0, L.posterWall.centerY, L.posterWall.z + 0.01);
    this.root.add(this.posterWall);
    L.plaques.forEach((p, i) => {
      const a = new Group();
      a.name = `plaqueAnchor-${i}`;
      a.position.set(p[0], p[1], p[2]);
      a.rotation.x = -0.95;
      this.root.add(a);
      this.plaqueAnchors.push(a);
    });
  }

  setCompact(compact: boolean): void {
    const src = compact ? L.gadgetsCompact : L.gadgets;
    for (const g of this.stubGadgets) {
      const p = src[g.id];
      g.root.position.set(p[0], p[1], p[2]);
      g.faceEye();
    }
  }

  setLamp(level: number): void {
    this.lamp = Math.max(0, Math.min(1, level));
  }

  update(dt: number, time: number): void {
    this.time += dt;
    for (const p of this.stubProps) p.update(dt);
    for (const g of this.stubGadgets) g.update(dt);
    const flicker = 0.96 + 0.04 * Math.sin(this.time * 7.3) * Math.sin(this.time * 2.1);
    if (this.lampHalo) (this.lampHalo.material as SpriteMaterial).opacity = 0.55 * this.lamp * flicker;
    if (this.poolMat) this.poolMat.opacity = 0.32 * this.lamp * flicker;
    void time;
  }

  // ------------------------------------------------------------------------------------------ build
  private add(o: Object3D, name?: string): Object3D {
    if (name) o.name = name;
    this.root.add(o);
    return o;
  }

  private buildRoom(): void {
    const ty = L.tableY;
    const felt = feltMaterial({ fuzz: 0.05 });
    const wood = matcapMaterial('wood');
    // checked tablecloth with a warm lamp falloff baked into the vertex colours
    const parts: Part[] = [];
    const nx = 12;
    const nz = 10;
    const w = L.table.width;
    const dpt = L.table.depth;
    const cw = w / nx;
    const cd = dpt / nz;
    const plane = new PlaneGeometry(cw, cd);
    plane.rotateX(-Math.PI / 2);
    const cream = new Color(PAL.clothCream);
    const red = new Color(PAL.clothRed);
    const tmp = new Color();
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const x = -w / 2 + cw * (i + 0.5);
        const z = L.table.centerZ - dpt / 2 + cd * (j + 0.5);
        const dx = x - 0;
        const dz = z - -0.5;
        const pool = 0.42 + 0.58 * Math.exp(-(dx * dx + dz * dz) / 0.16);
        tmp.copy((i + j) % 2 ? red : cream).multiplyScalar(pool);
        parts.push({ geometry: plane, color: tmp.getHex(), position: [x, ty - 0.0005, z] });
      }
    }
    // hem and skirt
    parts.push({ geometry: new BoxGeometry(w + 0.02, 0.09, 0.004), color: 0x6e1f1c, position: [0, ty - 0.045, L.table.centerZ + dpt / 2 + 0.002] });
    parts.push({ geometry: new BoxGeometry(0.004, 0.09, dpt), color: 0x6e1f1c, position: [-w / 2 - 0.008, ty - 0.045, L.table.centerZ] });
    parts.push({ geometry: new BoxGeometry(0.004, 0.09, dpt), color: 0x6e1f1c, position: [w / 2 + 0.008, ty - 0.045, L.table.centerZ] });
    this.add(new Mesh(mergeParts(parts), felt), 'table');

    // green velvet close-up mat with chalk marks
    const matParts: Part[] = [
      { geometry: new BoxGeometry(L.mat.size[0], 0.005, L.mat.size[1]), color: PAL.velvet, position: [L.mat.center[0], ty + 0.0025, L.mat.center[2]] },
      { geometry: new BoxGeometry(L.mat.size[0] + 0.012, 0.004, L.mat.size[1] + 0.012), color: PAL.velvetDeep, position: [L.mat.center[0], ty + 0.002, L.mat.center[2]] },
    ];
    const chalkRing = new RingGeometry(0.019, 0.022, 36);
    chalkRing.rotateX(-Math.PI / 2);
    for (const id of ['coin', 'cupLeft', 'cupMid', 'cupRight'] as PropId[]) {
      const m = L.propMarks[id];
      const s = id === 'coin' ? 1 : 1.45;
      matParts.push({ geometry: chalkRing, color: PAL.chalk, position: [m[0], ty + 0.0052, m[2]], scale: [s, 1, s] });
    }
    this.add(new Mesh(mergeParts(matParts), matcapMaterial('velvet')), 'mat');

    // riser with five stools, and the gadget shelf behind it
    const riser: Part[] = [
      { geometry: new BoxGeometry(L.riser.width, 0.04, L.riser.depth), color: PAL.wood, position: [0, ty + 0.02, L.riser.z] },
      { geometry: new BoxGeometry(L.riser.width + 0.01, 0.006, L.riser.depth + 0.01), color: PAL.woodDark, position: [0, ty + 0.041, L.riser.z] },
    ];
    for (const s of L.seats) riser.push({ geometry: new CylinderGeometry(0.02, 0.022, 0.006, 18), color: PAL.clothRed, position: [s[0], s[1] + 0.003, s[2]] });
    const shelfY = L.shelf.topY;
    riser.push({ geometry: new BoxGeometry(0.98, 0.012, 0.1), color: PAL.woodDark, position: [0, shelfY - 0.006, L.shelf.z] });
    for (const x of [-0.45, 0.45]) riser.push({ geometry: new BoxGeometry(0.02, shelfY - ty, 0.02), color: PAL.woodDark, position: [x, (shelfY + ty) / 2, L.shelf.z] });
    riser.push({ geometry: new CylinderGeometry(0.035, 0.04, L.gadgets.firework[1] - shelfY, 16), color: PAL.woodDark, position: [0, (L.gadgets.firework[1] + shelfY) / 2, L.gadgets.firework[2]] });
    this.add(new Mesh(mergeParts(riser), wood), 'riser');

    // back wall with the night window and a few stars
    const wall: Part[] = [
      { geometry: new PlaneGeometry(2.6, 1.6), color: PAL.wallDeep, position: [0, 0.1, L.posterWall.z - 0.02] },
      { geometry: new PlaneGeometry(L.window.size[0] + 0.06, L.window.size[1] + 0.06), color: PAL.woodDark, position: [L.window.center[0], L.window.center[1], L.window.center[2] - 0.004] },
      { geometry: new PlaneGeometry(L.window.size[0], L.window.size[1]), color: PAL.windowGlow, position: [...L.window.center] },
      { geometry: new PlaneGeometry(0.02, L.window.size[1]), color: PAL.woodDark, position: [L.window.center[0], L.window.center[1], L.window.center[2] + 0.002] },
      { geometry: new PlaneGeometry(L.window.size[0], 0.02), color: PAL.woodDark, position: [L.window.center[0], L.window.center[1], L.window.center[2] + 0.002] },
      { geometry: new PlaneGeometry(2.6, 0.05), color: PAL.wood, position: [0, -0.32, L.posterWall.z - 0.01] },
    ];
    for (let i = 0; i < 9; i++) {
      const sx = L.window.center[0] - 0.35 + ((i * 0.37) % 0.7);
      const sy = L.window.center[1] - 0.35 + ((i * 0.53) % 0.7);
      wall.push({ geometry: new CircleGeometry(0.004 + (i % 3) * 0.002, 6), color: 0xfff4dc, position: [sx, sy, L.window.center[2] + 0.003] });
    }
    wall.push({ geometry: new CircleGeometry(0.05, 24), color: 0xfff1c8, position: [L.window.center[0] + 0.2, L.window.center[1] + 0.22, L.window.center[2] + 0.003] });
    this.add(new Mesh(mergeParts(wall), new MeshBasicMaterial({ vertexColors: true, toneMapped: false })), 'backWall');

    // hanging lamp + halo + the warm pool on the cloth
    const lampParts: Part[] = [
      { geometry: new ConeGeometry(0.11, 0.075, 28, 1, true), color: PAL.brass, position: [L.lamp[0], L.lamp[1], L.lamp[2]] },
      { geometry: new CylinderGeometry(0.003, 0.003, 0.6, 6), color: PAL.woodDark, position: [L.lamp[0], L.lamp[1] + 0.33, L.lamp[2]] },
      { geometry: new SphereGeometry(0.028, 16, 12), color: PAL.lampWarm, position: [L.lamp[0], L.lamp[1] - 0.03, L.lamp[2]] },
    ];
    const lampMesh = new Mesh(mergeParts(lampParts), new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, toneMapped: false }));
    this.add(lampMesh, 'lamp');
    this.lampHalo = glowSprite(PAL.lampAmber, 0.38, 0.55);
    this.lampHalo.position.set(L.lamp[0], L.lamp[1] - 0.04, L.lamp[2]);
    this.add(this.lampHalo, 'lampHalo');
    this.poolMat = new MeshBasicMaterial({ map: glowTexture(), color: PAL.lampAmber, transparent: true, opacity: 0.32, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    const pool = new Mesh(new CircleGeometry(0.42, 40), this.poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, ty + 0.0062, -0.47);
    pool.renderOrder = 2;
    this.add(pool, 'lampPool');
  }

  private buildProps(): void {
    const brass = matcapMaterial('brass');
    const glossy = matcapMaterial('glossy');
    const felt = feltMaterial();
    const mk = (id: PropId, radius: number, shiny: boolean, cover: boolean, glint: [number, number]) => {
      const p = new StubProp(id, radius, shiny, cover, L.propMarks[id], glint[0], glint[1]);
      this.root.add(p.root);
      this.props[id] = p;
      this.stubProps.push(p);
      return p;
    };
    // coin
    const coin = mk('coin', 0.02, true, false, [0.05, 0.01]);
    const coinGeo = mergeParts([
      { geometry: new CylinderGeometry(0.0145, 0.0145, 0.0032, 32), color: PAL.gold, position: [0, 0.0016, 0] },
      { geometry: new TorusGeometry(0.0118, 0.0011, 6, 32), color: 0xb98a2c, position: [0, 0.0034, 0], rotation: [Math.PI / 2, 0, 0] },
    ]);
    coin.body.add(new Mesh(coinGeo, brass));
    // ball
    const ball = mk('ball', 0.02, true, false, [0.05, 0.016]);
    ball.body.add(new Mesh(tint(new SphereGeometry(0.0145, 22, 16), PAL.ballRed).translate(0, 0.0145, 0), glossy));
    // three copper cups (open at the bottom), each with a lifting shell
    const profile = [
      new Vector2(0.0255, 0),
      new Vector2(0.027, 0.003),
      new Vector2(0.0235, 0.012),
      new Vector2(0.0205, 0.048),
      new Vector2(0.0225, 0.052),
      new Vector2(0.0195, 0.056),
      new Vector2(0.0, 0.0565),
    ];
    const cupGeo = tint(new LatheGeometry(profile, 28), PAL.copper);
    for (const id of ['cupLeft', 'cupMid', 'cupRight'] as PropId[]) {
      const cup = mk(id, 0.034, false, true, [0.07, 0.03]);
      const shell = new Group();
      shell.add(new Mesh(cupGeo, brass));
      cup.body.add(shell);
      cup.shell = shell;
    }
    // the critic's pocket watch
    const watch = mk('watch', 0.024, true, false, [0.055, 0.008]);
    const watchGeo = mergeParts([
      { geometry: new CylinderGeometry(0.0175, 0.0175, 0.006, 32), color: PAL.gold, position: [0, 0.003, 0] },
      { geometry: new CylinderGeometry(0.0145, 0.0145, 0.0008, 32), color: 0xfbf6e8, position: [0, 0.0062, 0] },
      { geometry: new BoxGeometry(0.0012, 0.0006, 0.01), color: PAL.ink, position: [0, 0.0068, -0.004] },
      { geometry: new BoxGeometry(0.007, 0.0006, 0.0012), color: PAL.ink, position: [0.003, 0.0068, 0] },
      { geometry: new TorusGeometry(0.005, 0.0013, 6, 16), color: PAL.gold, position: [0, 0.003, -0.022], rotation: [0, 0, 0] },
      { geometry: new CylinderGeometry(0.0022, 0.0022, 0.004, 10), color: PAL.gold, position: [0, 0.003, -0.0185], rotation: [Math.PI / 2, 0, 0] },
    ]);
    watch.body.add(new Mesh(watchGeo, brass));
    // the cupcake box: base + hinged lid, a cupcake inside
    const box = mk('cupcake', 0.04, false, true, [0.08, 0.045]);
    const baseGeo = mergeParts([
      { geometry: new BoxGeometry(0.06, 0.004, 0.06), color: 0xf2c6d0, position: [0, 0.002, 0] },
      { geometry: new BoxGeometry(0.06, 0.04, 0.003), color: 0xf2c6d0, position: [0, 0.02, 0.0285] },
      { geometry: new BoxGeometry(0.06, 0.04, 0.003), color: 0xf2c6d0, position: [0, 0.02, -0.0285] },
      { geometry: new BoxGeometry(0.003, 0.04, 0.06), color: 0xe9b2bf, position: [0.0285, 0.02, 0] },
      { geometry: new BoxGeometry(0.003, 0.04, 0.06), color: 0xe9b2bf, position: [-0.0285, 0.02, 0] },
      { geometry: new CylinderGeometry(0.016, 0.012, 0.018, 18), color: 0xc98b54, position: [0, 0.013, 0] },
      { geometry: new SphereGeometry(0.018, 18, 12), color: 0xfff1f4, position: [0, 0.027, 0], scale: [1, 0.7, 1] },
      { geometry: new SphereGeometry(0.0055, 10, 8), color: PAL.ballRed, position: [0, 0.04, 0] },
    ]);
    box.body.add(new Mesh(baseGeo, felt));
    const lidPivot = new Group();
    lidPivot.position.set(0, 0.04, -0.03);
    const lidGeo = mergeParts([
      { geometry: new BoxGeometry(0.064, 0.004, 0.064), color: 0xf7d7de, position: [0, 0.002, 0.03] },
      { geometry: new BoxGeometry(0.066, 0.003, 0.012), color: PAL.clothRed, position: [0, 0.0045, 0.03] },
      { geometry: new BoxGeometry(0.012, 0.003, 0.066), color: PAL.clothRed, position: [0, 0.0045, 0.03] },
      { geometry: new TorusGeometry(0.008, 0.0025, 6, 14), color: PAL.clothRed, position: [0, 0.01, 0.03], rotation: [0, 0, 0] },
    ]);
    lidPivot.add(new Mesh(lidGeo, felt));
    box.body.add(lidPivot);
    box.lid = lidPivot;
  }

  private buildGadgets(): void {
    const wood = matcapMaterial('wood');
    const brass = matcapMaterial('brass');
    // music box
    const mb = new StubGadget('musicBox', 0.06, CFG.musicBoxDuration, [0, 0.07, 0], this.fx, this.rig);
    const mbBody = mergeParts([
      { geometry: new BoxGeometry(0.075, 0.04, 0.05), color: 0x7a3b2a, position: [0, 0.02, 0] },
      { geometry: new BoxGeometry(0.079, 0.006, 0.054), color: PAL.brass, position: [0, 0.003, 0] },
      { geometry: new CylinderGeometry(0.004, 0.004, 0.02, 8), color: PAL.brass, position: [0.042, 0.02, 0], rotation: [0, 0, Math.PI / 2] },
    ]);
    const mbMat = wood.clone();
    mb.root.add(new Mesh(mbBody, mbMat));
    mb.tintable(mbMat);
    const lid = new Group();
    lid.position.set(0, 0.04, -0.025);
    lid.add(new Mesh(tint(new BoxGeometry(0.077, 0.008, 0.052), 0x8e4a35).translate(0, 0.004, 0.026), mbMat));
    mb.root.add(lid);
    mb.lid = lid;
    const dancer = new Group();
    dancer.position.set(0, 0.04, 0);
    const dancerGeo = mergeParts([
      { geometry: new ConeGeometry(0.012, 0.022, 14), color: 0xff9eb8, position: [0, 0.012, 0] },
      { geometry: new SphereGeometry(0.0055, 10, 8), color: 0xf3e1c4, position: [0, 0.028, 0] },
      { geometry: new CylinderGeometry(0.001, 0.001, 0.012, 4), color: PAL.brass, position: [0, -0.004, 0] },
    ]);
    dancer.add(new Mesh(dancerGeo, brass));
    dancer.visible = false;
    mb.root.add(dancer);
    mb.dancer = dancer;
    // candle
    const cd = new StubGadget('candle', 0.06, CFG.candleDuration, [0, 0.085, 0], this.fx, this.rig);
    const cdMat = wood.clone();
    cd.root.add(
      new Mesh(
        mergeParts([
          { geometry: new CylinderGeometry(0.03, 0.034, 0.006, 22), color: PAL.brass, position: [0, 0.003, 0] },
          { geometry: new TorusGeometry(0.012, 0.0025, 6, 16), color: PAL.brass, position: [0.034, 0.012, 0], rotation: [0, Math.PI / 2, 0] },
          { geometry: new CylinderGeometry(0.0115, 0.0125, 0.065, 18), color: 0xf4eedc, position: [0, 0.038, 0] },
          { geometry: new CylinderGeometry(0.0008, 0.0008, 0.008, 4), color: 0x222222, position: [0, 0.074, 0] },
        ]),
        cdMat,
      ),
    );
    cd.tintable(cdMat);
    const flame = glowSprite(0xffc46a, 0.03, 1);
    flame.position.set(0, 0.084, 0);
    flame.scale.set(0.022, 0.034, 1);
    cd.root.add(flame);
    cd.flame = flame;
    // firework launcher on its taller stand
    const fw = new StubGadget('firework', 0.06, CFG.bangLookDuration, [0, 0.16, 0], this.fx, this.rig);
    const fwMat = wood.clone();
    fw.root.add(
      new Mesh(
        mergeParts([
          { geometry: new CylinderGeometry(0.014, 0.016, 0.1, 18), color: PAL.clothRed, position: [0, 0.05, 0] },
          { geometry: new CylinderGeometry(0.0165, 0.0165, 0.012, 18), color: PAL.gold, position: [0, 0.03, 0] },
          { geometry: new CylinderGeometry(0.0165, 0.0165, 0.012, 18), color: PAL.gold, position: [0, 0.075, 0] },
          { geometry: new ConeGeometry(0.017, 0.024, 18), color: PAL.gold, position: [0, 0.112, 0] },
          { geometry: new CylinderGeometry(0.0012, 0.0012, 0.05, 5), color: 0x2a2018, position: [0, 0.145, 0] },
        ]),
        fwMat,
      ),
    );
    fw.tintable(fwMat);
    const spark = glowSprite(0xffe08a, 0.02, 1);
    spark.visible = false;
    fw.root.add(spark);
    fw.spark = spark;
    for (const g of [mb, cd, fw]) {
      this.root.add(g.root);
      this.gadgets[g.id] = g;
      this.stubGadgets.push(g);
    }
    this.setCompact(false);
  }
}

export const stubEnvironmentFactory = {
  async build(_world: World, rig: StageRig): Promise<{ cafe: Cafe; fx: Fx }> {
    const fx = new StubFx(rig);
    const cafe = new StubCafe(rig, fx);
    return { cafe, fx };
  },
} satisfies EnvironmentFactory;
