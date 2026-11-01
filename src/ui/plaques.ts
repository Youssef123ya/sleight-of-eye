// Poke plaques on the near table edge: brass rod frames around midnight-enamel faces (icon + label), tilted
// toward the player. ALL plaques share ONE merged mesh (faces + frames + easel legs) animated per slot with
// uniform arrays (pop-in scale, hover lift, press, lit crossfade) → 1 draw call, +1 additive hover halo.
// Each plaque is also a named Group 'plaque-<action>' (poke + gaze target) parented to its anchor.
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  CapsuleGeometry,
  Color,
  Euler,
  Group,
  Matrix4,
  Mesh,
  Object3D,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  type BufferGeometry,
} from '@iwsdk/core';
import type { GameEvents, GazeTargetRegistry, PlaqueAction, PokeRegistry, Side } from '../contracts.js';
import type { Emitter } from '../events.js';
import { mergeParts, type Part } from '../art/geometry.js';
import { makeMatcap, MATCAPS } from '../art/matcap.js';
import { L } from '../layout.js';
import { clamp01, damp, easeInBack, easeOutBack, Spring } from './anim.js';
import { createCanvasTexture, type CanvasTex } from './canvas.js';
import type { UICtx } from './context.js';
import { drawPlaqueFace, isToggle } from './plaqueArt.js';

const MAX = 6;
const DEG = Math.PI / 180;
const FACE_W = 0.068;
const FACE_H = 0.045;
const TILT_FROM_TABLE = 40 * DEG;
const POKE_RADIUS = 0.035;
// Faces are designed at 336×224 and drawn at ×1.333 (448×299 px on a 6.8 cm face ≈ 6600 px/m: ≥2× the Quest 3
// display density at the plaques' ~0.43 m viewing distance). 4 columns × 3 rows = 12 cells (6 slots × off/on).
const ATLAS_W = 2048;
const ATLAS_H = 1024;
const DESIGN_W = 336;
const DESIGN_H = 224;
const FACE_SCALE = 4 / 3;
const CELL_W = Math.round(DESIGN_W * FACE_SCALE);
const CELL_H = Math.round(DESIGN_H * FACE_SCALE);
const COL_STEP = 512;
const ROW_STEP = 340;

const VS = /* glsl */ `
#define MAX_SLOTS ${MAX}
attribute float aSlot;
attribute float aKind;
uniform mat4 uSlotMat[MAX_SLOTS];
uniform float uScale[MAX_SLOTS];
uniform float uHover[MAX_SLOTS];
uniform float uPress[MAX_SLOTS];
uniform float uLit[MAX_SLOTS];
uniform vec2 uCellOff[MAX_SLOTS];
uniform vec2 uCellOn[MAX_SLOTS];
uniform vec2 uCellSize;
varying vec2 vUvOff;
varying vec2 vUvOn;
varying vec2 vFace;
varying float vLit;
varying float vHover;
varying float vKind;
varying vec3 vNrm;
varying vec3 vView;
varying vec3 vCol;
void main() {
  int s = int(aSlot + 0.5);
  vec3 p = position;
  float hov = uHover[s];
  float prs = uPress[s];
  // face floats up on hover and sinks into the frame on press; the frame follows a little
  p.z += (aKind < 0.5) ? (0.0016 * hov - 0.004 * prs) : (0.0006 * hov - 0.0008 * prs);
  p *= uScale[s];
  mat4 sm = uSlotMat[s];
  vec4 mvPos = modelViewMatrix * (sm * vec4(p, 1.0));
  gl_Position = projectionMatrix * mvPos;
  vView = -mvPos.xyz;
  vNrm = normalize(normalMatrix * (mat3(sm) * normal));
  vec2 px = vec2(1.0 / ${ATLAS_W}.0, 1.0 / ${ATLAS_H}.0);
  vec2 inset = uv * (uCellSize - 4.0 * px) + 2.0 * px;
  vUvOff = uCellOff[s] + inset;
  vUvOn = uCellOn[s] + inset;
  vFace = uv;
  vLit = uLit[s];
  vHover = hov;
  vKind = aKind;
  vCol = color;
}`;

const FS = /* glsl */ `
uniform sampler2D uAtlas;
uniform sampler2D uBrass;
varying vec2 vUvOff;
varying vec2 vUvOn;
varying vec2 vFace;
varying float vLit;
varying float vHover;
varying float vKind;
varying vec3 vNrm;
varying vec3 vView;
varying vec3 vCol;
void main() {
  vec3 col;
  if (vKind < 0.5) {
    vec3 off = texture2D(uAtlas, vUvOff).rgb;
    vec3 on = texture2D(uAtlas, vUvOn).rgb;
    col = mix(off, on, vLit);
    vec2 e = min(vFace, 1.0 - vFace);
    float edge = 1.0 - smoothstep(0.0, 0.09, min(e.x * 1.5, e.y));
    col += vHover * (vec3(0.07, 0.055, 0.03) + edge * vec3(0.85, 0.58, 0.2) * 0.6);
  } else {
    vec3 n = normalize(vNrm);
    vec3 v = normalize(vView);
    vec3 x = normalize(vec3(v.z, 0.0, -v.x));
    vec3 y = cross(v, x);
    vec2 muv = vec2(dot(x, n), dot(y, n)) * 0.495 + 0.5;
    col = texture2D(uBrass, muv).rgb * vCol * (1.0 + 0.4 * vHover);
    #if defined( TONE_MAPPING )
      col = toneMapping(col);
    #endif
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const HALO_VS = /* glsl */ `
#define MAX_SLOTS ${MAX}
attribute float aSlot;
uniform mat4 uSlotMat[MAX_SLOTS];
uniform float uScale[MAX_SLOTS];
uniform float uGlow[MAX_SLOTS];
varying vec2 vUv;
varying float vGlow;
void main() {
  int s = int(aSlot + 0.5);
  vec4 mvPos = modelViewMatrix * (uSlotMat[s] * vec4(position * uScale[s], 1.0));
  gl_Position = projectionMatrix * mvPos;
  vUv = uv;
  vGlow = uGlow[s];
}`;
const HALO_FS = /* glsl */ `
uniform vec3 uColor;
uniform vec2 uHalf;
uniform vec2 uInner;
varying vec2 vUv;
varying float vGlow;
void main() {
  vec2 p = (vUv - 0.5) * 2.0 * uHalf;
  vec2 q = abs(p) - uInner;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  float g = exp(-max(d, 0.0) * 90.0);
  g *= 1.0 - smoothstep(0.75, 1.0, max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)) * 2.0);
  gl_FragColor = vec4(uColor, g * vGlow);
  #include <colorspace_fragment>
}`;

interface Slot {
  action: PlaqueAction;
  obj: Object3D;
  own: boolean;
  group: Group;
  /** rig-space lift so the frame never sinks into the tabletop (anchors that sit low) */
  lift: Vector3;
  hoverSide: Record<Side, boolean>;
  hover: number;
  press: Spring;
  pressHold: number;
  flash: number;
  lit: number;
  litTarget: number;
  appear: number;
  leaving: number;
  lastPoke: number;
  offs: Array<() => void>;
}

const _v = new Vector3();
const _v2 = new Vector3();
const _rootInv = new Matrix4();

export interface PlaqueDeps {
  pokes: PokeRegistry;
  gazeTargets: GazeTargetRegistry;
  events: Emitter<GameEvents>;
  anchors: Object3D[] | null;
}

export class Plaques {
  readonly group = new Group();
  private slots: Slot[] = [];
  private key = '';
  private readonly fallback: Object3D[] = [];
  private readonly atlas: CanvasTex;
  private readonly mat: ShaderMaterial;
  private readonly haloMat: ShaderMaterial;
  private mesh: Mesh | null = null;
  private halo: Mesh | null = null;
  private time = 0;
  private readonly toggles: Record<'easy' | 'assist', boolean> = { easy: false, assist: false };
  private readonly slotMats: Matrix4[] = [];
  private readonly scaleArr = new Array<number>(MAX).fill(0);

  constructor(
    private readonly ctx: UICtx,
    private readonly deps: PlaqueDeps,
  ) {
    this.group.name = 'ui-plaques';
    ctx.root.add(this.group);
    this.atlas = createCanvasTexture(ATLAS_W, ATLAS_H, ctx.anisotropy);
    for (let i = 0; i < MAX; i++) this.slotMats.push(new Matrix4());
    const zeros = () => new Array<number>(MAX).fill(0);
    const v2s = () => Array.from({ length: MAX }, () => new Vector2());
    this.mat = new ShaderMaterial({
      name: 'ui-plaques',
      uniforms: {
        uSlotMat: { value: this.slotMats },
        uScale: { value: this.scaleArr },
        uHover: { value: zeros() },
        uPress: { value: zeros() },
        uLit: { value: zeros() },
        uCellOff: { value: v2s() },
        uCellOn: { value: v2s() },
        uCellSize: { value: new Vector2(CELL_W / ATLAS_W, CELL_H / ATLAS_H) },
        uAtlas: { value: this.atlas.texture },
        uBrass: { value: makeMatcap(MATCAPS.brass) },
      },
      vertexShader: VS,
      fragmentShader: FS,
      vertexColors: true,
      toneMapped: true,
    });
    this.haloMat = new ShaderMaterial({
      name: 'ui-plaque-halo',
      uniforms: {
        uSlotMat: { value: this.slotMats },
        uScale: { value: this.scaleArr },
        uGlow: { value: zeros() },
        uColor: { value: new Color(0xffc56a) },
        uHalf: { value: new Vector2(0.075, 0.058) },
        uInner: { value: new Vector2(FACE_W / 2 + 0.004, FACE_H / 2 + 0.004) },
      },
      vertexShader: HALO_VS,
      fragmentShader: HALO_FS,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    // fallback anchors on the near table edge (used when there is no café)
    for (const p of L.plaques) this.fallback.push(this.makeAnchor(p[0], p[2], p[1]));
  }

  /** An anchor at the face centre: +Z = face normal (toward the eye, tilted up), +Y = up along the face. */
  private makeAnchor(x: number, z: number, baseY: number): Object3D {
    const o = new Object3D();
    o.name = 'ui-plaque-anchor';
    const lift = (FACE_H / 2 + 0.006) * Math.sin(TILT_FROM_TABLE) + 0.002;
    o.position.set(x, Math.max(baseY, L.tableY + lift), z);
    const yaw = Math.atan2(-x, -z);
    o.quaternion.setFromEuler(new Euler(-(90 * DEG - TILT_FROM_TABLE), yaw, 0, 'YXZ'));
    this.group.add(o);
    return o;
  }

  set(actions: PlaqueAction[], toggles: Partial<Record<'easy' | 'assist', boolean>>): void {
    if (toggles.easy !== undefined) this.toggles.easy = toggles.easy;
    if (toggles.assist !== undefined) this.toggles.assist = toggles.assist;
    const list = actions.slice(0, MAX);
    const key = list.join(',');
    if (key !== this.key) {
      this.key = key;
      this.rebuild(list);
    }
    for (const s of this.slots) s.litTarget = isToggle(s.action) && this.toggles[s.action] ? 1 : 0;
  }

  // -------------------------------------------------------------------------------------------- layout
  private pickSlots(n: number): Array<{ obj: Object3D; own: boolean }> {
    const anchors = (this.deps.anchors && this.deps.anchors.length ? this.deps.anchors : this.fallback).slice();
    const rigX = (o: Object3D) => this.ctx.rig.toLocal(o.getWorldPosition(_v), _v).x;
    anchors.sort((a, b) => rigX(a) - rigX(b));
    const m = anchors.length;
    const out: Array<{ obj: Object3D; own: boolean; x: number }> = [];
    if (n <= m) {
      const idx = n === 1 ? [m - 1] : Array.from({ length: n }, (_, k) => Math.round((k * (m - 1)) / (n - 1)));
      for (const i of idx) out.push({ obj: anchors[i], own: false, x: rigX(anchors[i]) });
    } else {
      for (const a of anchors) out.push({ obj: a, own: false, x: rigX(a) });
      // more actions than anchors: a second row tucked behind the outermost anchors, right side first
      const left = this.ctx.rig.toLocal(anchors[0].getWorldPosition(_v), new Vector3());
      const right = this.ctx.rig.toLocal(anchors[m - 1].getWorldPosition(_v), new Vector3());
      let nl = 0;
      let nr = 0;
      for (let k = 0; k < n - m; k++) {
        const goRight = k % 2 === 0;
        const base = goRight ? right : left;
        const step = goRight ? ++nr : ++nl;
        const x = base.x + (goRight ? 0.05 : -0.05) * step;
        const z = base.z - 0.085 * step;
        const o = this.makeAnchor(x, z, base.y);
        out.push({ obj: o, own: true, x: x + (goRight ? 0.001 : -0.001) });
      }
    }
    out.sort((a, b) => a.x - b.x);
    return out;
  }

  private rebuild(actions: PlaqueAction[]): void {
    // tear down
    for (const s of this.slots) {
      for (const off of s.offs) off();
      s.group.removeFromParent();
      if (s.own) s.obj.removeFromParent();
    }
    this.slots = [];
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (this.halo) {
      this.halo.removeFromParent();
      this.halo.geometry.dispose();
      this.halo = null;
    }
    if (!actions.length) return;
    this.group.updateWorldMatrix(true, true);
    const picks = this.pickSlots(actions.length);
    picks.forEach((p, i) => {
      p.obj.updateWorldMatrix(true, false);
      const g = new Group();
      g.name = `plaque-${actions[i]}`;
      p.obj.add(g);
      this.slots.push({
        action: actions[i],
        obj: p.obj,
        own: p.own,
        group: g,
        lift: new Vector3(),
        hoverSide: { left: false, right: false },
        hover: 0,
        press: new Spring(0, 900, 30),
        pressHold: 0,
        flash: 0,
        lit: 0,
        litTarget: 0,
        appear: -i * 0.07,
        leaving: -1,
        lastPoke: -10,
        offs: [],
      });
    });
    this.updateSlotMatrices();
    this.liftAboveTable();
    this.updateSlotMatrices();
    this.drawAtlas();
    this.buildMeshes();
    for (const s of this.slots) this.register(s);
  }

  /** Raise any slot whose lowest frame point would sit below the cloth (rig-space lift + matching poke group). */
  private liftAboveTable(): void {
    const corner = new Vector3();
    const inv = new Matrix4();
    this.slots.forEach((s, i) => {
      const m = this.slotMats[i];
      let minY = Infinity;
      for (const [x, y] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]) {
        corner.set((x * (FACE_W + 0.013)) / 2, (y * (FACE_H + 0.013)) / 2, -0.007).applyMatrix4(m);
        minY = Math.min(minY, corner.y);
      }
      const need = L.tableY + 0.0015 - minY;
      s.lift.set(0, Math.max(0, need), 0);
      // the named group lives in anchor space: express the same lift there
      inv.copy(m).invert();
      const local = s.lift.clone().transformDirection(inv).multiplyScalar(s.lift.length());
      s.group.position.copy(local);
    });
  }

  private drawAtlas(): void {
    const ctx = this.atlas.ctx;
    ctx.clearRect(0, 0, ATLAS_W, ATLAS_H);
    const off = this.mat.uniforms.uCellOff.value as Vector2[];
    const on = this.mat.uniforms.uCellOn.value as Vector2[];
    this.slots.forEach((s, i) => {
      for (const lit of [false, true]) {
        const cell = i * 2 + (lit ? 1 : 0);
        const x = (cell % 4) * COL_STEP + 32;
        const y = Math.floor(cell / 4) * ROW_STEP + 20;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(FACE_SCALE, FACE_SCALE);
        drawPlaqueFace(ctx, 0, 0, DESIGN_W, DESIGN_H, s.action, lit);
        ctx.restore();
        (lit ? on : off)[i].set(x / ATLAS_W, 1 - (y + CELL_H) / ATLAS_H);
      }
    });
    this.atlas.texture.needsUpdate = true;
  }

  private buildMeshes(): void {
    const parts: Part[] = [];
    const slotOf: number[] = [];
    const kindOf: number[] = [];
    const push = (p: Part, slot: number, kind: number) => {
      parts.push(p);
      slotOf.push(slot);
      kindOf.push(kind);
    };
    const rw = FACE_W + 0.0044;
    const rh = FACE_H + 0.0044;
    const rodR = 0.0032;
    const tableLocal = new Vector3();
    const inv = new Matrix4();
    this.slots.forEach((s, i) => {
      // depth layout (slot-local z): face +0.0004 (sinks to -0.0036 on press) | rods -0.0012 | plate -0.004..-0.007
      push({ geometry: new PlaneGeometry(FACE_W, FACE_H), color: 0xffffff, position: [0, 0, 0.0004] }, i, 0);
      push({ geometry: new BoxGeometry(FACE_W + 0.009, FACE_H + 0.009, 0.003), color: 0x6a4a22, position: [0, 0, -0.0055] }, i, 1);
      push({ geometry: new CapsuleGeometry(rodR, rw, 3, 10), color: 0xffffff, position: [0, rh / 2, -0.0012], rotation: [0, 0, Math.PI / 2] }, i, 1);
      push({ geometry: new CapsuleGeometry(rodR, rw, 3, 10), color: 0xffffff, position: [0, -rh / 2, -0.0012], rotation: [0, 0, Math.PI / 2] }, i, 1);
      push({ geometry: new CapsuleGeometry(rodR, rh, 3, 10), color: 0xffffff, position: [rw / 2, 0, -0.0012] }, i, 1);
      push({ geometry: new CapsuleGeometry(rodR, rh, 3, 10), color: 0xffffff, position: [-rw / 2, 0, -0.0012] }, i, 1);
      for (const [cx, cy] of [
        [rw / 2, rh / 2],
        [-rw / 2, rh / 2],
        [rw / 2, -rh / 2],
        [-rw / 2, -rh / 2],
      ]) {
        push({ geometry: new SphereGeometry(0.0043, 12, 8), color: 0xfff2d0, position: [cx, cy, -0.001] }, i, 1);
      }
      // easel leg: from the back of the plate straight down (rig vertical) to the tabletop
      const m = this.slotMats[i];
      inv.copy(m).invert();
      const start = new Vector3(0, 0.004, -0.0075);
      const startRig = start.clone().applyMatrix4(m);
      const drop = startRig.y - L.tableY;
      if (drop > 0.004) {
        tableLocal.set(startRig.x, L.tableY, startRig.z).applyMatrix4(inv);
        const dir = tableLocal.clone().sub(start);
        const len = dir.length();
        const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize());
        const e = new Euler().setFromQuaternion(q, 'XYZ');
        const mid = start.clone().addScaledVector(dir, 0.5);
        push({ geometry: new CapsuleGeometry(0.0022, len, 3, 8), color: 0xd9c08a, position: [mid.x, mid.y, mid.z], rotation: [e.x, e.y, e.z] }, i, 1);
      }
    });
    const geo = mergeParts(parts, { keepUv: true });
    this.addSlotAttributes(geo, parts, slotOf, kindOf);
    for (const p of parts) p.geometry.dispose();
    this.mesh = new Mesh(geo, this.mat);
    this.mesh.name = 'ui-plaques-mesh';
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    // hover halo: one quad per slot behind the plaque
    const hParts: Part[] = [];
    const hSlot: number[] = [];
    this.slots.forEach((_, i) => {
      hParts.push({ geometry: new PlaneGeometry(0.15, 0.116), color: 0xffffff, position: [0, 0, -0.0085] });
      hSlot.push(i);
    });
    const hGeo = mergeParts(hParts, { keepUv: true });
    this.addSlotAttributes(hGeo, hParts, hSlot, null);
    for (const p of hParts) p.geometry.dispose();
    this.halo = new Mesh(hGeo, this.haloMat);
    this.halo.name = 'ui-plaques-halo';
    this.halo.frustumCulled = false;
    this.halo.renderOrder = 3;
    this.halo.visible = false;
    this.group.add(this.halo);
  }

  private addSlotAttributes(geo: BufferGeometry, parts: Part[], slotOf: number[], kindOf: number[] | null): void {
    const n = geo.getAttribute('position').count;
    const aSlot = new Float32Array(n);
    const aKind = new Float32Array(n);
    let o = 0;
    parts.forEach((p, k) => {
      const c = p.geometry.index ? p.geometry.index.count : p.geometry.getAttribute('position').count;
      aSlot.fill(slotOf[k], o, o + c);
      if (kindOf) aKind.fill(kindOf[k], o, o + c);
      o += c;
    });
    geo.setAttribute('aSlot', new BufferAttribute(aSlot, 1));
    if (kindOf) geo.setAttribute('aKind', new BufferAttribute(aKind, 1));
  }

  // ---------------------------------------------------------------------------------- registration
  private register(s: Slot): void {
    const id = `plaque-${s.action}`;
    const getWorldPosition = (out: Vector3): Vector3 => {
      s.group.getWorldPosition(out);
      const e = s.group.matrixWorld.elements;
      _v2.set(e[8], e[9], e[10]).normalize();
      return out.addScaledVector(_v2, 0.008);
    };
    const enabled = () => this.group.visible && s.leaving < 0 && s.appear > 0.25;
    try {
      s.offs.push(
        this.deps.pokes.add({
          id,
          radius: POKE_RADIUS,
          getWorldPosition,
          enabled,
          onHover: (hovered: boolean, side: Side) => {
            s.hoverSide[side] = hovered;
          },
          onPoke: () => this.poke(s),
        }),
      );
    } catch (e) {
      console.warn('[ui] poke registration failed for', id, e);
    }
    try {
      s.offs.push(this.deps.gazeTargets.add({ id, radius: POKE_RADIUS, getWorldPosition, enabled }));
    } catch (e) {
      console.warn('[ui] gaze registration failed for', id, e);
    }
  }

  private poke(s: Slot): void {
    if (this.time - s.lastPoke < 0.4) return;
    s.lastPoke = this.time;
    s.pressHold = 0.11;
    s.flash = 1;
    this.deps.events.emit('plaque', { action: s.action });
  }

  /** Programmatic hover/press (demo + debug); the registry normally drives these. */
  simulate(action: PlaqueAction, what: 'hover' | 'unhover' | 'poke'): void {
    const s = this.slots.find((x) => x.action === action);
    if (!s) return;
    if (what === 'poke') this.poke(s);
    else s.hoverSide.right = what === 'hover';
  }

  // ------------------------------------------------------------------------------------------ frame
  private updateSlotMatrices(): void {
    this.group.updateWorldMatrix(true, false);
    _rootInv.copy(this.group.matrixWorld).invert();
    for (let i = 0; i < this.slots.length; i++) {
      const o = this.slots[i].obj;
      o.updateWorldMatrix(true, false);
      const m = this.slotMats[i].multiplyMatrices(_rootInv, o.matrixWorld);
      const lift = this.slots[i].lift;
      m.elements[12] += lift.x;
      m.elements[13] += lift.y;
      m.elements[14] += lift.z;
    }
  }

  update(dt: number): void {
    this.time += dt;
    if (!this.mesh || !this.slots.length) return;
    this.updateSlotMatrices();
    const u = this.mat.uniforms;
    const scale = u.uScale.value as number[];
    const hover = u.uHover.value as number[];
    const press = u.uPress.value as number[];
    const lit = u.uLit.value as number[];
    const glow = this.haloMat.uniforms.uGlow.value as number[];
    let anyGlow = false;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      s.appear += dt;
      const sc = s.leaving >= 0 ? 1 - easeInBack(clamp01(s.leaving / 0.25)) : s.appear <= 0 ? 0 : easeOutBack(clamp01(s.appear / 0.38), 2);
      const h = s.hoverSide.left || s.hoverSide.right ? 1 : 0;
      s.hover = damp(s.hover, h, 14, dt);
      if (s.pressHold > 0) s.pressHold -= dt;
      s.press.step(s.pressHold > 0 ? 1 : 0, dt);
      s.flash = Math.max(0, s.flash - dt * 2.6);
      s.lit = damp(s.lit, s.litTarget, 10, dt);
      scale[i] = Math.max(0, sc);
      hover[i] = s.hover;
      press[i] = Math.max(-0.4, Math.min(1, s.press.x));
      lit[i] = Math.min(1, Math.max(s.lit, s.flash * 0.9));
      glow[i] = Math.min(1, s.hover * 0.7 + s.lit * 0.22 + s.flash * 0.6) * scale[i];
      if (glow[i] > 0.01) anyGlow = true;
    }
    for (let i = this.slots.length; i < MAX; i++) {
      scale[i] = 0;
      glow[i] = 0;
    }
    if (this.halo) this.halo.visible = anyGlow;
  }

  dispose(): void {
    this.rebuild([]);
    this.key = '';
    this.group.removeFromParent();
    this.mat.dispose();
    this.haloMat.dispose();
    this.atlas.texture.dispose(); // the brass matcap is shared (art/matcap cache): not ours to dispose
  }
}
