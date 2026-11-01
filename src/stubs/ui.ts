// Stub UI (G): gaze spotlight, captions, ghost hints, plaques (poke + gaze targets), curtain, title card,
// rewind smear, review, posters and banner — implementing the UI contract until src/ui lands.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  RingGeometry,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type Object3D,
  type World,
} from '@iwsdk/core';
import { PAL } from '../art/palette.js';
import { CFG } from '../config.js';
import type {
  Cafe,
  GameEvents,
  GazeTargetRegistry,
  Hint,
  PlaqueAction,
  PokeRegistry,
  PosterData,
  ReviewData,
  Side,
  UI,
  UIFactory,
} from '../contracts.js';
import type { Emitter } from '../events.js';
import { L, type StageRig } from '../layout.js';
import { Label, Tweens, glowTexture, hex, roundRect } from './common.js';

const ORIGIN: [number, number, number] = [0, 0, 0];
const PLAQUE_SLOTS: Record<PlaqueAction, [number, number, number]> = {
  retry: [-0.25, L.tableY + 0.012, -0.2],
  easy: [-0.15, L.tableY + 0.012, -0.19],
  assist: [0.15, L.tableY + 0.012, -0.19],
  recenter: [0.25, L.tableY + 0.012, -0.2],
  exit: [0.345, L.tableY + 0.012, -0.215],
};
const PLAQUE_TEXT: Record<PlaqueAction, [string, string]> = {
  retry: ['↺', 'Retry'],
  easy: ['☺', 'Easy'],
  assist: ['✋', 'Assist'],
  recenter: ['◎', 'Recenter'],
  exit: ['⏏', 'Exit'],
};

interface CaptionSlot {
  label: Label;
  at: Object3D | null;
  until: number;
  born: number;
}

interface Plaque {
  action: PlaqueAction;
  mesh: Mesh;
  canvas: HTMLCanvasElement;
  tex: CanvasTexture;
  lit: boolean | null;
  hover: boolean;
  press: number;
}

class StubUI implements UI {
  readonly root = new Group();
  private readonly tweens = new Tweens();
  private time = 0;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  // spotlight
  private readonly spot: Mesh;
  private readonly spotMat: MeshBasicMaterial;
  private readonly spotTarget = new Vector3();
  private spotOn = false;
  private spotStrength = 0;
  private spotLevel = 0;
  // captions / banner / title
  private readonly captions: CaptionSlot[] = [];
  private readonly bannerText: Label;
  private readonly title: Label;
  private readonly subtitle: Label;
  // curtain + smear
  private readonly curtainMesh: Mesh;
  private curtainY = 1.25;
  private readonly smear: Mesh;
  private readonly smearMat: MeshBasicMaterial;
  // hints
  private readonly ghost = new Group();
  private readonly ghostThumb: Mesh;
  private readonly ghostIndex: Mesh;
  private readonly ghostRing: Mesh;
  private readonly ghostMat: MeshBasicMaterial;
  private ghostMode: 'pinch' | 'poke' | null = null;
  private ghostTarget: Object3D | null = null;
  private ghostT = 0;
  private readonly trail: Points;
  private readonly trailPos: Float32Array;
  private trailFrom: (() => Vector3) | null = null;
  private trailTo: Object3D | null = null;
  private hintToken = 0;
  // plaques, review, posters
  private readonly plaques = new Map<PlaqueAction, Plaque>();
  private readonly plaqueList: Plaque[] = [];
  private review_: Mesh | null = null;
  private posterMesh: Mesh | null = null;

  constructor(
    private readonly world: World,
    private readonly rig: StageRig,
    private readonly deps: { pokes: PokeRegistry; gazeTargets: GazeTargetRegistry; events: Emitter<GameEvents>; cafe: Cafe | null },
  ) {
    this.root.name = 'ui';
    rig.root.add(this.root);

    // soft warm spotlight decal on the cloth
    this.spotMat = new MeshBasicMaterial({
      map: glowTexture(),
      color: PAL.lampWarm,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.spot = new Mesh(new CircleGeometry(0.06, 32), this.spotMat);
    this.spot.name = 'gaze-spotlight';
    this.spot.rotation.x = -Math.PI / 2;
    this.spot.renderOrder = 3;
    this.spot.visible = false;
    this.root.add(this.spot);

    for (let i = 0; i < 4; i++) {
      const label = new Label(512, 128, 0.17);
      label.sprite.name = `caption-${i}`;
      this.root.add(label.sprite);
      this.captions.push({ label, at: null, until: 0, born: 0 });
    }
    this.bannerText = new Label(640, 128, 0.24);
    this.bannerText.sprite.name = 'banner';
    this.bannerText.sprite.position.set(0, -0.12, -0.5);
    this.root.add(this.bannerText.sprite);
    this.title = new Label(1024, 160, 0.5);
    this.title.sprite.name = 'title-card';
    this.title.sprite.position.set(0, -0.02, -0.56);
    this.root.add(this.title.sprite);
    this.subtitle = new Label(1024, 128, 0.34);
    this.subtitle.sprite.name = 'title-sub';
    this.subtitle.sprite.position.set(0, -0.085, -0.56);
    this.root.add(this.subtitle.sprite);

    // theatre curtain between the mat and the audience
    const cg = new PlaneGeometry(1.5, 1.0, 36, 1);
    const colors = new Float32Array(cg.attributes.position.count * 3);
    const c = new Color();
    const pos = cg.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const fold = 0.62 + 0.38 * Math.abs(Math.sin(x * 26));
      c.setHex(0xa8322d).multiplyScalar(fold);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
      pos.setZ(i, 0.012 * Math.sin(x * 26));
    }
    cg.setAttribute('color', new BufferAttribute(colors, 3));
    this.curtainMesh = new Mesh(cg, new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, toneMapped: false }));
    this.curtainMesh.name = 'curtain';
    this.curtainMesh.position.set(0, this.curtainY, -0.55);
    this.curtainMesh.visible = false;
    this.root.add(this.curtainMesh);

    this.smearMat = new MeshBasicMaterial({ color: 0x8fb4ff, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, depthTest: false, toneMapped: false });
    this.smear = new Mesh(new PlaneGeometry(1.4, 0.8), this.smearMat);
    this.smear.name = 'rewind-smear';
    this.smear.position.set(0, -0.05, -0.42);
    this.smear.visible = false;
    this.smear.renderOrder = 60;
    this.root.add(this.smear);

    // ghost hand: thumb + index tips and a target ring
    this.ghostMat = new MeshBasicMaterial({ color: 0xfff4dc, transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false });
    this.ghostThumb = new Mesh(new SphereGeometry(0.008, 12, 10), this.ghostMat);
    this.ghostIndex = new Mesh(new SphereGeometry(0.008, 12, 10), this.ghostMat);
    this.ghostRing = new Mesh(new RingGeometry(0.022, 0.026, 32), this.ghostMat);
    this.ghost.add(this.ghostThumb, this.ghostIndex, this.ghostRing);
    this.ghost.name = 'ghost-hand';
    this.ghost.visible = false;
    this.ghost.renderOrder = 40;
    this.root.add(this.ghost);

    // gaze trail
    const tg = new BufferGeometry();
    this.trailPos = new Float32Array(14 * 3);
    tg.setAttribute('position', new BufferAttribute(this.trailPos, 3));
    this.trail = new Points(
      tg,
      new PointsMaterial({ size: 0.016, map: glowTexture(), color: PAL.lampWarm, transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false }),
    );
    this.trail.name = 'gaze-trail';
    this.trail.frustumCulled = false;
    this.trail.visible = false;
    this.root.add(this.trail);
  }

  // ---------------------------------------------------------------------------------------- contract
  spotlight(point: Vector3 | null, strength = 1): void {
    if (point) {
      this.rig.toLocal(point, this.spotTarget);
      this.spotOn = true;
      this.spotStrength = strength;
    } else this.spotOn = false;
  }

  caption(text: string, at: Object3D, opts?: { seconds?: number; style?: 'speech' | 'shout' | 'whisper' }): void {
    // reuse the slot already attached to this object, else the oldest
    let slot = this.captions.find((c) => c.at === at && c.until > this.time);
    if (!slot) slot = this.captions.reduce((a, b) => (a.until < b.until ? a : b));
    const style = opts?.style ?? 'speech';
    slot.label.draw(text, style);
    slot.label.sprite.scale.set(style === 'shout' ? 0.2 : 0.17, (style === 'shout' ? 0.2 : 0.17) / 4, 1);
    slot.at = at;
    slot.born = this.time;
    slot.until = this.time + (opts?.seconds ?? 2.2);
    slot.label.sprite.visible = true;
    console.debug(`[caption] ${text}`);
  }

  hintPinch(target: Object3D, side: Side = 'right'): Hint {
    return this.startGhost('pinch', target, side);
  }

  hintPoke(target: Object3D, side: Side = 'right'): Hint {
    return this.startGhost('poke', target, side);
  }

  hintGaze(from: () => Vector3, to: Object3D): Hint {
    const token = ++this.hintToken;
    this.trailFrom = from;
    this.trailTo = to;
    this.trail.visible = true;
    return {
      stop: () => {
        if (this.trailTo === to && token === this.hintToken) {
          this.trailFrom = null;
          this.trailTo = null;
          this.trail.visible = false;
        }
      },
    };
  }

  clearHints(): void {
    this.ghostMode = null;
    this.ghostTarget = null;
    this.ghost.visible = false;
    this.trailFrom = null;
    this.trailTo = null;
    this.trail.visible = false;
  }

  setPlaques(actions: PlaqueAction[], toggles: Partial<Record<'easy' | 'assist', boolean>>): void {
    for (const a of actions) {
      if (this.plaques.has(a)) continue;
      const p = this.makePlaque(a);
      this.plaques.set(a, p);
      this.plaqueList.push(p);
    }
    for (const [a, p] of this.plaques) {
      p.mesh.visible = actions.includes(a);
      const lit = a === 'easy' ? !!toggles.easy : a === 'assist' ? !!toggles.assist : false;
      if (p.lit !== lit) {
        p.lit = lit;
        this.drawPlaque(p);
      }
    }
  }

  private curtainToken = 0;

  curtain(state: 'open' | 'closed'): Promise<void> {
    const from = this.curtainY;
    const to = state === 'closed' ? L.tableY + 0.5 : 1.25;
    const token = ++this.curtainToken; // a newer call supersedes this one
    this.curtainMesh.visible = true;
    return this.tweens.run(0.9, (u) => {
      if (token !== this.curtainToken) return;
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      this.curtainY = from + (to - from) * e;
      this.curtainMesh.position.y = this.curtainY;
      if (u >= 1 && state === 'open') this.curtainMesh.visible = false;
    });
  }

  titleCard(title: string, subtitle?: string): Promise<void> {
    this.title.draw(title, 'title');
    this.subtitle.draw(subtitle ?? '', 'plain');
    this.title.sprite.visible = true;
    this.subtitle.sprite.visible = !!subtitle;
    return this.tweens.run(2.2, (u) => {
      const a = u < 0.15 ? u / 0.15 : u > 0.85 ? (1 - u) / 0.15 : 1;
      this.title.material.opacity = a;
      this.subtitle.material.opacity = a;
      if (u >= 1) this.title.sprite.visible = this.subtitle.sprite.visible = false;
    });
  }

  rewindSmear(): Promise<void> {
    this.smear.visible = true;
    return this.tweens.run(CFG.rewindTime, (u) => {
      this.smearMat.opacity = 0.55 * Math.sin(Math.PI * u);
      this.smear.scale.set(1 + 0.25 * Math.sin(Math.PI * u), 1, 1);
      this.smear.position.x = -0.08 * Math.sin(Math.PI * 2 * u);
      if (u >= 1) this.smear.visible = false;
    });
  }

  review(data: ReviewData | null): void {
    if (!data) {
      if (this.review_) this.review_.visible = false;
      return;
    }
    const W = 512;
    const H = 640;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    g.fillStyle = '#f3ead2';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#241a12';
    g.textAlign = 'center';
    g.font = '700 40px Georgia, serif';
    g.fillText('The Midnight Gazette', W / 2, 60);
    g.fillRect(30, 76, W - 60, 4);
    g.font = '900 38px Georgia, serif';
    wrap(g, data.headline, W / 2, 140, W - 60, 44);
    const names = ['The Vanishing Coin', 'Cups & Ball', "The Critic's Watch"];
    g.font = '600 26px Georgia, serif';
    data.stars.forEach((s, i) => {
      const y = 300 + i * 56;
      g.textAlign = 'left';
      g.fillText(names[i] ?? `Act ${i + 1}`, 40, y);
      g.textAlign = 'right';
      g.fillStyle = '#c99a3c';
      g.fillText('★'.repeat(s) + '☆'.repeat(Math.max(0, 3 - s)), W - 40, y);
      g.fillStyle = '#241a12';
    });
    g.textAlign = 'center';
    g.font = 'italic 26px Georgia, serif';
    wrap(g, `“${data.quote}” — Sir Brock`, W / 2, 500, W - 70, 32);
    const tex = new CanvasTexture(c);
    tex.colorSpace = SRGBColorSpace;
    if (!this.review_) {
      this.review_ = new Mesh(new PlaneGeometry(0.2, 0.25), new MeshBasicMaterial({ map: tex, toneMapped: false }));
      this.review_.name = 'review';
      // propped up on the near edge of the mat, below the bowing audience
      this.review_.position.set(0, L.tableY + 0.07, -0.3);
      this.review_.rotation.x = -0.85;
      this.review_.scale.setScalar(0.85);
      this.root.add(this.review_);
    } else {
      const m = this.review_.material as MeshBasicMaterial;
      m.map?.dispose();
      m.map = tex;
      m.needsUpdate = true;
    }
    this.review_.visible = true;
    this.review_.scale.setScalar(0.01);
    const r = this.review_;
    this.tweens.add(0.6, (u) => r.scale.setScalar(0.85 * Math.max(0.01, u < 0.8 ? (u / 0.8) * 1.08 : 1.08 - 0.08 * ((u - 0.8) / 0.2))));
  }

  posters(list: PosterData[]): void {
    const wall = this.deps.cafe?.posterWall;
    if (!wall) return;
    const shown = list.slice(-4);
    const W = 1024;
    const H = 400;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    shown.forEach((p, i) => {
      const x = 20 + i * 250;
      g.fillStyle = i % 2 ? '#2a2342' : '#3b1f2b';
      roundRect(g, x, 20, 230, 360, 10);
      g.fill();
      g.lineWidth = 6;
      g.strokeStyle = '#c99a3c';
      g.stroke();
      g.fillStyle = '#ffcf5a';
      g.textAlign = 'center';
      g.font = '700 30px Georgia, serif';
      wrap(g, p.title, x + 115, 90, 200, 34);
      g.font = '600 46px Georgia, serif';
      g.fillText('★'.repeat(Math.max(0, Math.min(9, p.stars))), x + 115, 270, 210);
      g.fillStyle = '#f4eedc';
      g.font = '24px Georgia, serif';
      g.fillText(p.date, x + 115, 340);
    });
    const tex = new CanvasTexture(c);
    tex.colorSpace = SRGBColorSpace;
    if (!this.posterMesh) {
      this.posterMesh = new Mesh(new PlaneGeometry(1.0, 0.39), new MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
      this.posterMesh.name = 'posters';
      this.posterMesh.position.set(-0.3, 0, 0.005);
      wall.add(this.posterMesh);
    } else {
      const m = this.posterMesh.material as MeshBasicMaterial;
      m.map?.dispose();
      m.map = tex;
      m.needsUpdate = true;
    }
    this.posterMesh.visible = shown.length > 0;
  }

  banner(text: string | null): void {
    if (text) this.bannerText.draw(text, 'banner');
    this.bannerText.sprite.visible = !!text;
  }

  update(dt: number): void {
    this.time += dt;
    this.tweens.update(dt);
    // spotlight
    this.spotLevel += ((this.spotOn ? this.spotStrength : 0) - this.spotLevel) * Math.min(1, dt * 10);
    if (this.spotOn) {
      const p = this.spot.position;
      if (!this.spot.visible) p.set(this.spotTarget.x, L.tableY + 0.0068, this.spotTarget.z);
      p.x += (this.spotTarget.x - p.x) * Math.min(1, dt * 18);
      p.z += (this.spotTarget.z - p.z) * Math.min(1, dt * 18);
      p.y = L.tableY + 0.0068;
    }
    this.spotMat.opacity = 0.55 * this.spotLevel;
    this.spot.visible = this.spotLevel > 0.02;
    // captions follow their speaker and fade
    for (const c of this.captions) {
      if (!c.label.sprite.visible) continue;
      if (this.time >= c.until + 0.25 || !c.at) {
        c.label.sprite.visible = false;
        c.at = null;
        continue;
      }
      c.at.getWorldPosition(this.tmp);
      this.rig.toLocal(this.tmp, this.tmp2);
      const age = this.time - c.born;
      c.label.sprite.position.set(this.tmp2.x, this.tmp2.y + 0.07 + 0.01 * Math.min(1, age * 4), this.tmp2.z);
      const fade = this.time > c.until ? 1 - (this.time - c.until) / 0.25 : Math.min(1, age * 6);
      c.label.material.opacity = Math.max(0, fade);
    }
    // ghost hand
    if (this.ghostMode && this.ghostTarget) {
      this.ghostT += dt;
      this.ghostTarget.getWorldPosition(this.tmp);
      this.rig.toLocal(this.tmp, this.tmp2);
      const cyc = (this.ghostT % 1.6) / 1.6;
      const a = cyc < 0.15 ? cyc / 0.15 : cyc > 0.85 ? (1 - cyc) / 0.15 : 1;
      this.ghostMat.opacity = 0.8 * a;
      this.ghost.position.copy(this.tmp2);
      this.ghostRing.lookAt(this.rig.toWorld(ORIGIN, this.tmp));
      if (this.ghostMode === 'pinch') {
        const close = Math.min(1, Math.max(0, (cyc - 0.25) / 0.35));
        const gap = 0.022 * (1 - close) + 0.003;
        const hover = 0.04 * (1 - Math.min(1, cyc / 0.3)) + 0.012;
        this.ghostIndex.position.set(gap * 0.5, hover + gap * 0.7, 0.01);
        this.ghostThumb.position.set(-gap * 0.5, hover, 0.012);
        this.ghostThumb.visible = true;
      } else {
        const push = cyc < 0.5 ? cyc / 0.5 : 1 - (cyc - 0.5) / 0.5;
        this.ghostIndex.position.set(0, 0.012, 0.06 * (1 - push));
        this.ghostThumb.visible = false;
      }
      this.ghostRing.scale.setScalar(1 + 0.15 * Math.sin(this.ghostT * 6));
    }
    // gaze trail drifts from the gaze point to the target
    if (this.trailFrom && this.trailTo && this.trail.visible) {
      const from = this.rig.toLocal(this.trailFrom(), this.tmp2);
      const fx = from.x;
      const fy = from.y;
      const fz = from.z;
      this.trailTo.getWorldPosition(this.tmp);
      this.rig.toLocal(this.tmp, this.tmp);
      const n = this.trailPos.length / 3;
      for (let i = 0; i < n; i++) {
        const u = ((i / n + this.time * 0.45) % 1 + 1) % 1;
        const arc = Math.sin(Math.PI * u) * 0.05;
        this.trailPos[i * 3] = fx + (this.tmp.x - fx) * u;
        this.trailPos[i * 3 + 1] = fy + (this.tmp.y - fy) * u + arc;
        this.trailPos[i * 3 + 2] = fz + (this.tmp.z - fz) * u;
      }
      (this.trail.geometry.attributes.position as BufferAttribute).needsUpdate = true;
    }
    // plaques: hover lift + press dip
    for (let i = 0; i < this.plaqueList.length; i++) {
      const p = this.plaqueList[i];
      if (!p.mesh.visible) continue;
      p.press = Math.max(0, p.press - dt * 3);
      const s = (p.hover ? 1.08 : 1) * (1 - 0.12 * Math.sin(Math.PI * p.press));
      p.mesh.scale.setScalar(s);
    }
  }

  // ---------------------------------------------------------------------------------------- internals
  private startGhost(mode: 'pinch' | 'poke', target: Object3D, _side: Side): Hint {
    this.ghostMode = mode;
    this.ghostTarget = target;
    this.ghostT = 0;
    this.ghost.visible = true;
    return {
      stop: () => {
        if (this.ghostTarget === target && this.ghostMode === mode) {
          this.ghostMode = null;
          this.ghostTarget = null;
          this.ghost.visible = false;
        }
      },
    };
  }

  private makePlaque(action: PlaqueAction): Plaque {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 160;
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    const mesh = new Mesh(new PlaneGeometry(0.068, 0.0425), new MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
    mesh.name = `plaque-${action}`;
    const slot = PLAQUE_SLOTS[action];
    mesh.position.set(slot[0], slot[1] + 0.012, slot[2]);
    mesh.rotation.x = -0.95;
    mesh.rotation.y = -slot[0] * 0.9;
    mesh.rotation.order = 'YXZ';
    this.root.add(mesh);
    const p: Plaque = { action, mesh, canvas, tex, lit: null, hover: false, press: 0 };
    this.drawPlaque(p);
    const pos = (out: Vector3) => mesh.getWorldPosition(out);
    this.deps.pokes.add({
      id: `plaque-${action}`,
      radius: 0.035,
      getWorldPosition: pos,
      enabled: () => mesh.visible,
      onHover: (h) => {
        p.hover = h;
      },
      onPoke: () => {
        p.press = 1;
        this.deps.events.emit('plaque', { action });
      },
    });
    this.deps.gazeTargets.add({ id: `plaque-${action}`, radius: 0.03, getWorldPosition: pos, enabled: () => mesh.visible });
    return p;
  }

  private drawPlaque(p: Plaque): void {
    const g = p.canvas.getContext('2d')!;
    const W = p.canvas.width;
    const H = p.canvas.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = p.lit ? '#5a3a14' : '#3e2615';
    roundRect(g, 6, 6, W - 12, H - 12, 22);
    g.fill();
    g.lineWidth = 8;
    g.strokeStyle = p.lit ? hex(PAL.glintGold) : hex(PAL.brass);
    g.stroke();
    const [icon, text] = PLAQUE_TEXT[p.action];
    g.fillStyle = p.lit ? '#ffe9a8' : '#f4eedc';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 54px "Segoe UI Symbol", "Apple Symbols", sans-serif';
    g.fillText(icon, W / 2, H * 0.38);
    g.font = '700 36px Georgia, serif';
    g.fillText(p.lit ? `${text} ✓` : text, W / 2, H * 0.74);
    p.tex.needsUpdate = true;
  }
}

function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number): void {
  const words = text.split(' ');
  let line = '';
  let yy = y;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > maxW && line) {
      g.fillText(line, x, yy);
      line = w;
      yy += lh;
    } else line = test;
  }
  if (line) g.fillText(line, x, yy);
}

export const stubUIFactory: UIFactory = {
  async build(world, rig, deps) {
    return new StubUI(world, rig, deps);
  },
};
