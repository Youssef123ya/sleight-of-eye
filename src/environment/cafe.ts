// The Cafe: owns the static set, props, gadgets, anchors, the shared glow/blob batches and the FX.
// Everything is parented under rig.root in rig-local (L) coordinates.
import { Group, MeshBasicMaterial, MeshMatcapMaterial, Object3D, Vector3, type Texture, type World } from '@iwsdk/core';
import type { Cafe, GadgetId, PropId } from '../contracts.js';
import { feltMaterial, makeMatcap, matcapMaterial, type MatcapSpec } from '../art/matcap.js';
import { L, type StageRig, type V3 } from '../layout.js';
import { FxImpl } from './fx.js';
import { Candle, Firework, MusicBox } from './gadgets.js';
import { BlobBatch, GlowBatch, MODE } from './glow.js';
import { buildProps, makePropMaterials, type PropImpl, type PropsResult } from './props.js';
import { buildSet, type LitMaterial, type SetResult } from './set.js';
import type { StaticGlow } from './set-common.js';
import { CELL, makeGlowAtlas } from './textures.js';
import { TAU, approach, clamp01, easeInOutCubic, rng } from './util.js';

type AnyGadget = MusicBox | Candle | Firework;

/** Polished copper for the cups: ruddy body, warm key light, a crisp hot specular. */
const COPPER_MATCAP: MatcapSpec = {
  base: 0x5a2410, key: 0xffb070, keyStrength: 1.05, rim: 0xff9a5a, rimStrength: 0.55, rimPower: 2.2, spec: 1.5, specSize: 0.22,
};

interface Mote {
  x: number;
  y: number;
  z: number;
  ax: number;
  ay: number;
  az: number;
  ph: number;
  rate: number;
  size: number;
  slot: number;
}

export class CafeImpl implements Cafe {
  readonly root = new Group();
  readonly props: Record<PropId, PropImpl>;
  readonly gadgets: Record<GadgetId, AnyGadget>;
  readonly seats: Object3D[] = [];
  readonly volunteerSpot = new Object3D();
  readonly posterWall = new Object3D();
  readonly plaqueAnchors: Object3D[] = [];
  readonly fx: FxImpl;

  private readonly world: World;
  private readonly rig: StageRig;
  private readonly glow: GlowBatch;
  private readonly blobs: BlobBatch;
  private readonly set: SetResult;
  private readonly propsRes: PropsResult;
  private readonly decals = new Group();
  private readonly fxGroup = new Group();
  private readonly lit: LitMaterial[];
  private readonly motes: Mote[] = [];
  private readonly cam = new Vector3();
  private readonly gadgetList: AnyGadget[];
  private readonly lampGlowList: StaticGlow[];
  private readonly atlas: Texture;
  private readonly ownedMaterials: Array<{ dispose(): void }>;
  private now = 0;
  private lastTime = Number.NaN;
  private lampTarget = 1;
  private lamp = 1;
  private lampApplied = -1;
  private compact = false;
  private compactT = 1;
  private readonly compactFrom: V3[] = [];
  private wasPresenting = false;
  private failed = false;

  constructor(world: World, rig: StageRig) {
    this.world = world;
    this.rig = rig;
    this.root.name = 'cafe';
    this.decals.name = 'env-decals';
    this.fxGroup.name = 'env-fx';
    rig.root.add(this.root, this.decals, this.fxGroup);

    const atlas = makeGlowAtlas();
    this.atlas = atlas;
    this.glow = new GlowBatch(atlas, 288);
    this.blobs = new BlobBatch(atlas, 96);
    this.decals.add(this.blobs.mesh, this.glow.mesh);
    this.fx = new FxImpl(world, rig, atlas, this.fxGroup);

    const aniso = Math.min(8, world.renderer.capabilities.getMaxAnisotropy?.() ?? 4);
    this.set = buildSet(this.glow, this.blobs, aniso);
    this.root.add(this.set.group);

    // --- anchors
    L.seats.forEach((p, i) => {
      const s = new Object3D();
      s.name = `seat-${i}`;
      s.position.set(p[0], p[1], p[2]);
      s.rotation.y = Math.atan2(-p[0], -p[2]);
      this.root.add(s);
      this.seats.push(s);
    });
    this.volunteerSpot.name = 'volunteerSpot';
    this.volunteerSpot.position.set(...L.volunteerSpot);
    this.volunteerSpot.rotation.y = Math.atan2(-L.volunteerSpot[0], -L.volunteerSpot[2]);
    this.posterWall.name = 'posterWall';
    this.posterWall.position.set(L.posterWall.centerX, L.posterWall.centerY, L.posterWall.z);
    this.root.add(this.volunteerSpot, this.posterWall);
    L.plaques.forEach((p, i) => {
      const a = new Object3D();
      a.name = `plaqueAnchor-${i}`;
      a.position.set(p[0], p[1], p[2]);
      const len = Math.hypot(p[0], p[1], p[2]) || 1;
      a.rotation.set(-Math.asin(-p[1] / len), Math.atan2(-p[0], -p[2]), 0, 'YXZ');
      this.root.add(a);
      this.plaqueAnchors.push(a);
    });

    // --- props
    const propsGroup = new Group();
    propsGroup.name = 'env-props';
    this.root.add(propsGroup);
    const metal = matcapMaterial('brass');
    const felt = feltMaterial();
    const copper = new MeshMatcapMaterial({ matcap: makeMatcap(COPPER_MATCAP), vertexColors: true });
    const pm = makePropMaterials(metal, felt, copper);
    this.propsRes = buildProps({ rig, glow: this.glow, blobs: this.blobs, fx: this.fx }, propsGroup, pm);
    this.props = this.propsRes.props;

    // --- gadgets
    const gadgetsGroup = new Group();
    gadgetsGroup.name = 'env-gadgets';
    this.root.add(gadgetsGroup);
    const genv = { rig, glow: this.glow, blobs: this.blobs, fx: this.fx };
    this.gadgets = {
      musicBox: new MusicBox(genv, gadgetsGroup),
      candle: new Candle(genv, gadgetsGroup),
      firework: new Firework(genv, gadgetsGroup),
    };
    this.gadgetList = [this.gadgets.musicBox, this.gadgets.candle, this.gadgets.firework];
    for (const g of this.gadgetList) this.compactFrom.push([g.root.position.x, g.root.position.y, g.root.position.z]);

    this.lit = [...this.set.lit, { mat: metal, floor: 0.55 }, { mat: felt, floor: 0.5 }, { mat: copper, floor: 0.55 }];
    this.lampGlowList = [this.set.lampGlows.pool, this.set.lampGlows.halo, this.set.lampGlows.core];
    this.ownedMaterials = [metal, felt, copper, pm.dial, pm.hand, (pm.dial as MeshBasicMaterial).map!];

    // --- dust motes drifting in the lamp light
    const r = rng(77);
    for (let i = 0; i < 22; i++) {
      const y = L.tableY + 0.06 + r() * 0.36;
      const coneR = 0.08 + (0.4 - y) * 0.42;
      const a = r() * TAU;
      const rr = Math.sqrt(r()) * coneR * 0.85;
      this.motes.push({
        x: L.lamp[0] + Math.cos(a) * rr,
        y,
        z: L.lamp[2] + Math.sin(a) * rr,
        ax: 0.01 + r() * 0.02,
        ay: 0.01 + r() * 0.02,
        az: 0.01 + r() * 0.02,
        ph: r() * TAU,
        rate: 0.15 + r() * 0.25,
        size: 0.0022 + r() * 0.0022,
        slot: this.glow.alloc(),
      });
    }
    this.update(0, 0);
  }

  setCompact(compact: boolean): void {
    if (compact === this.compact && this.compactT >= 1) return;
    this.compact = compact;
    this.compactT = 0;
    for (let i = 0; i < this.gadgetList.length; i++) {
      const p = this.gadgetList[i].root.position;
      this.compactFrom[i] = [p.x, p.y, p.z];
    }
  }

  setLamp(level: number): void {
    this.lampTarget = clamp01(Number.isFinite(level) ? level : 1);
  }

  update(dt: number, time: number): void {
    if (time === this.lastTime) return;
    this.lastTime = time;
    try {
      this.tick(Math.min(Math.max(dt, 0), 0.1), time);
    } catch (e) {
      if (!this.failed) console.error('[environment] cafe update failed', e);
      this.failed = true;
    }
  }

  private tick(dt: number, time: number): void {
    this.now += dt;
    const now = this.now;
    const xr = this.world.renderer.xr;
    const presenting = !!xr?.isPresenting;
    if (presenting && !this.wasPresenting) this.fx.warmUp(3);
    this.wasPresenting = presenting;

    this.world.camera.getWorldPosition(this.cam);
    this.rig.root.worldToLocal(this.cam);

    // compact-stage transition (gadgets glide in and up on their brass posts)
    if (this.compactT < 1) {
      this.compactT = Math.min(1, this.compactT + dt / 0.9);
      const e = easeInOutCubic(this.compactT);
      const target = this.compact ? L.gadgetsCompact : L.gadgets;
      const lift = Math.sin(this.compactT * Math.PI) * 0.012;
      for (let i = 0; i < this.gadgetList.length; i++) {
        const g = this.gadgetList[i];
        const f = this.compactFrom[i];
        const t = target[g.id];
        g.place(f[0] + (t[0] - f[0]) * e, f[1] + (t[1] - f[1]) * e + lift, f[2] + (t[2] - f[2]) * e);
      }
    }

    this.propsRes.update(dt, now);
    for (const g of this.gadgetList) g.update(dt, time);

    // lamp level
    this.lamp += (this.lampTarget - this.lamp) * approach(5, dt);
    if (Math.abs(this.lamp - this.lampApplied) > 0.002) {
      this.lampApplied = this.lamp;
      for (const { mat, floor } of this.lit) mat.color.setScalar(floor + (1 - floor) * this.lamp);
      this.set.beam.material.uniforms.uLevel.value = this.lamp;
      this.set.beam.visible = this.lamp > 0.02;
    }

    // static glows: lamp halo/pool follow the lamp; fairy lights & candles twinkle
    const glow = this.glow;
    const lampK = this.lamp;
    for (const s of this.lampGlowList) {
      const breathe = 1 + 0.015 * Math.sin(now * 1.3);
      glow.set(s.slot, s.x, s.y, s.z, s.size * breathe, s.size * breathe, s.r, s.g, s.b, s.a * lampK, s.cell, s.mode);
    }
    for (const s of this.set.glows) {
      if (!s.twinkle) continue;
      const tw = 1 - s.twinkle * (0.5 + 0.5 * Math.sin(now * s.rate * TAU + s.phase));
      const k = s.cell === CELL.flame ? 0.85 + 0.15 * Math.sin(now * 23 + s.phase) : 1;
      glow.set(s.slot, s.x, s.y, s.z, s.size * (s.cell === CELL.flame ? 0.55 : 1), s.size * k, s.r, s.g, s.b, s.a * tw, s.cell, s.mode);
    }
    for (const m of this.motes) {
      const t = now * m.rate + m.ph;
      const x = m.x + Math.sin(t * 1.3) * m.ax;
      const y = m.y + Math.sin(t * 0.9 + 1.7) * m.ay;
      const z = m.z + Math.cos(t * 1.1) * m.az;
      const sparkle = Math.max(0, Math.sin(now * (0.6 + m.rate * 2) + m.ph * 3));
      const a = (0.12 + 0.6 * sparkle * sparkle * sparkle) * lampK;
      glow.set(m.slot, x, y, z, m.size, m.size, 1, 0.82, 0.55, a, CELL.dot, MODE.billboard);
    }

    this.set.night.material.uniforms.uTime.value = now;
    this.fx.update(dt, time);
    this.glow.sync(this.cam);
    this.blobs.sync();
  }

  dispose(): void {
    this.propsRes.dispose();
    for (const g of this.gadgetList) {
      g.root.traverse((o) => {
        const m = o as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } };
        m.geometry?.dispose();
        m.material?.dispose();
      });
    }
    this.set.dispose();
    this.fx.dispose();
    this.glow.dispose();
    this.blobs.dispose();
    for (const m of this.ownedMaterials) m.dispose();
    this.atlas.dispose();
    this.root.removeFromParent();
    this.decals.removeFromParent();
    this.fxGroup.removeFromParent();
  }
}
