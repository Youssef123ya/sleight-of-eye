// Props (G): lift (follows the pinch point, glides home on release), palm (hidden + logically in the hand —
// sticky across pinch release and tracking loss — with a tiny player-only gold glint at the palm), load
// (placed under/inside the target, hidden), reveal placements and checkpoints for rewinds.
import {
  AdditiveBlending,
  CanvasTexture,
  Matrix4,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector3,
  type World,
} from '@iwsdk/core';
import { PAL } from '../art/palette.js';
import type { Cafe, GameEvents, Glint, Prop, PropId, Side } from '../contracts.js';
import type { Emitter } from '../events.js';
import type { StageRig } from '../layout.js';
import type { HandTracker } from './hands.js';
import { clamp01, copyV, easeInOutSine, easeOutCubic, lerpV, setV } from './math.js';
import { rigFrame, setWorldPos, worldPos, type RigFrame } from './space.js';

export type PropMode = 'home' | 'lifted' | 'gliding' | 'palmed' | 'loaded' | 'shown' | 'auto' | 'hidden';
export type Holder = Side | 'rabbit';

export const PROP_IDS: readonly PropId[] = ['coin', 'ball', 'cupLeft', 'cupMid', 'cupRight', 'watch', 'cupcake'];

interface PropRuntime {
  readonly prop: Prop;
  mode: PropMode;
  holder: Holder | null;
  into: PropId | null;
  t: number;
  liftTime: number;
  glint: Glint;
  readonly from: Vector3;
  readonly offset: Vector3;
  readonly target: Vector3;
}

export interface PropSnapshot {
  modes: Record<string, { mode: PropMode; holder: Holder | null; into: PropId | null; visible: boolean }>;
}

const GLIDE_TIME = 0.45;
const AUTO_LIFT_TIME = 1.5;

export class PropController {
  readonly rt = {} as Record<PropId, PropRuntime>;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly m4 = new Matrix4();
  private readonly frame: RigFrame;
  private readonly glint: Sprite;
  private readonly glintMat: SpriteMaterial;
  private readonly glintTex: CanvasTexture;
  private time = 0;

  constructor(
    private readonly world: World,
    private readonly rig: StageRig,
    private readonly cafe: Cafe,
    private readonly hands: HandTracker,
    private readonly events: Emitter<GameEvents>,
  ) {
    this.frame = rigFrame(rig);
    for (const id of PROP_IDS) {
      const prop = cafe.props[id];
      if (!prop) continue;
      if (prop.root && !prop.root.name) prop.root.name = id;
      this.rt[id] = {
        prop,
        mode: 'home',
        holder: null,
        into: null,
        t: 0,
        liftTime: 0,
        glint: 'none',
        from: new Vector3(),
        offset: new Vector3(),
        target: new Vector3(),
      };
    }
    // player-only gold glint in the fist while a prop is palmed
    this.glintTex = makeGlowTexture();
    this.glintMat = new SpriteMaterial({
      map: this.glintTex,
      color: PAL.glintGold,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.glint = new Sprite(this.glintMat);
    this.glint.name = 'palm-glint';
    this.glint.scale.setScalar(0.022);
    this.glint.visible = false;
    this.glint.renderOrder = 20;
    rig.root.add(this.glint);
  }

  has(id: PropId): boolean {
    return !!this.rt[id];
  }

  prop(id: PropId): Prop | null {
    return this.rt[id]?.prop ?? null;
  }

  mode(id: PropId): PropMode {
    return this.rt[id]?.mode ?? 'hidden';
  }

  /** World position of the prop (its root origin). */
  worldPos(id: PropId, out: Vector3): Vector3 {
    const r = this.rt[id];
    if (!r) return out.set(0, 0, 0);
    return worldPos(r.prop.root, out);
  }

  /** World position of a prop's home mark. */
  homeWorld(id: PropId, out: Vector3): Vector3 {
    const r = this.rt[id];
    if (!r) return out.set(0, 0, 0);
    return this.frame.toWorld(r.prop.home, out);
  }

  /** Point used for grabbing/seen tests: a little above the root origin (props stand on their origin). */
  centerWorld(id: PropId, out: Vector3): Vector3 {
    this.worldPos(id, out);
    const r = this.rt[id];
    if (r) out.y += Math.min(0.03, (r.prop.radius || 0.02) * 0.5);
    return out;
  }

  setGlint(id: PropId, glint: Glint): void {
    const r = this.rt[id];
    if (!r || r.glint === glint) return;
    r.glint = glint;
    try {
      r.prop.setGlint(glint);
    } catch (e) {
      console.warn('[props] setGlint failed', e);
    }
  }

  clearGlints(): void {
    for (const id of PROP_IDS) this.setGlint(id, 'none');
  }

  /** Act setup: reset every prop to its mark; only `visible` ones are shown. */
  setActProps(visible: readonly PropId[]): void {
    for (const id of PROP_IDS) {
      const r = this.rt[id];
      if (!r) continue;
      this.resetOne(r);
      const show = visible.indexOf(id) >= 0;
      this.setVisible(r, show);
      r.mode = show ? 'home' : 'hidden';
    }
    this.glint.visible = false;
  }

  /** Start lifting (show beat). */
  lift(id: PropId, side: Side): boolean {
    const r = this.rt[id];
    if (!r || (r.mode !== 'home' && r.mode !== 'gliding')) return false;
    const hand = this.hands.states[side];
    r.mode = 'lifted';
    r.holder = side;
    r.liftTime = 0;
    this.worldPos(id, this.tmp);
    r.offset.copy(this.tmp).sub(hand.pinchPoint);
    this.events.emit('prop:lifted', { prop: id, side });
    return true;
  }

  /** Release a lifted prop: it glides home. */
  release(id: PropId): void {
    const r = this.rt[id];
    if (!r || r.mode !== 'lifted') return;
    this.startGlide(r);
  }

  /** Lift held this long (s), or -1 when not lifted. */
  liftTime(id: PropId): number {
    const r = this.rt[id];
    return r && r.mode === 'lifted' ? r.liftTime : -1;
  }

  /** Assist: the prop floats up, shows itself and settles back home on its own. */
  autoLift(id: PropId): void {
    const r = this.rt[id];
    if (!r || r.mode !== 'home') return;
    r.mode = 'auto';
    r.t = 0;
    this.homeWorld(id, r.from);
    this.events.emit('prop:lifted', { prop: id, side: 'right' });
  }

  palm(id: PropId, holder: Holder): void {
    const r = this.rt[id];
    if (!r) return;
    r.mode = 'palmed';
    r.holder = holder;
    r.into = null;
    this.setVisible(r, false);
    this.setGlint(id, 'none');
    this.events.emit('prop:palmed', { prop: id, side: holder === 'rabbit' ? 'right' : holder });
  }

  /** Move the palm (sticky) to another holder, e.g. the other hand pinching at the load target. */
  transferPalm(id: PropId, holder: Holder): void {
    const r = this.rt[id];
    if (r && r.mode === 'palmed') r.holder = holder;
  }

  load(id: PropId, into: PropId): void {
    const r = this.rt[id];
    if (!r) return;
    r.mode = 'loaded';
    r.holder = null;
    r.into = into;
    this.placeInside(id, into);
    this.setVisible(r, false);
    this.events.emit('prop:loaded', { prop: id, into });
  }

  /** Reveal: make a loaded prop visible where it was loaded (under the cup / inside the box). */
  revealLoaded(id: PropId): void {
    const r = this.rt[id];
    if (!r) return;
    if (r.into) this.placeInside(id, r.into);
    r.mode = 'shown';
    r.into = null;
    this.setVisible(r, true);
  }

  /** Reveal: pop the prop into existence at a world point, then glide it home after `holdSeconds`. */
  appearAt(id: PropId, at: Vector3, holdSeconds = 0.8): void {
    const r = this.rt[id];
    if (!r) return;
    r.holder = null;
    r.into = null;
    this.setWorld(r, at);
    this.setVisible(r, true);
    r.mode = 'shown';
    r.t = -holdSeconds; // negative = wait before gliding home
    try {
      void r.prop.animate('appear').catch(() => {});
    } catch {
      /* cosmetic */
    }
  }

  /** Snap a prop home and show it (e.g. Brock lends his watch). */
  showHome(id: PropId): void {
    const r = this.rt[id];
    if (!r) return;
    this.resetOne(r);
    this.setVisible(r, true);
    r.mode = 'home';
  }

  hide(id: PropId): void {
    const r = this.rt[id];
    if (!r) return;
    this.setVisible(r, false);
    r.mode = 'hidden';
  }

  /** Who holds the palmed prop (allocation-free; per-frame safe), or null. */
  palmHolder(): Holder | null {
    for (let i = 0; i < PROP_IDS.length; i++) {
      const r = this.rt[PROP_IDS[i]];
      if (r && r.mode === 'palmed' && r.holder) return r.holder;
    }
    return null;
  }

  /** The palmed prop and who holds it (allocates: events/debug only). */
  palmed(): { id: PropId; holder: Holder } | null {
    for (const id of PROP_IDS) {
      const r = this.rt[id];
      if (r && r.mode === 'palmed' && r.holder) return { id, holder: r.holder };
    }
    return null;
  }

  loaded(): { id: PropId; into: PropId } | null {
    for (const id of PROP_IDS) {
      const r = this.rt[id];
      if (r && r.mode === 'loaded' && r.into) return { id, into: r.into };
    }
    return null;
  }

  lifted(): { id: PropId; side: Side } | null {
    for (const id of PROP_IDS) {
      const r = this.rt[id];
      if (r && r.mode === 'lifted' && r.holder && r.holder !== 'rabbit') return { id, side: r.holder };
    }
    return null;
  }

  isBusy(id: PropId): boolean {
    const m = this.mode(id);
    return m === 'lifted' || m === 'gliding' || m === 'auto';
  }

  checkpoint(): PropSnapshot {
    const modes: PropSnapshot['modes'] = {};
    for (const id of PROP_IDS) {
      const r = this.rt[id];
      if (!r) continue;
      let mode = r.mode;
      if (mode === 'lifted' || mode === 'gliding' || mode === 'auto') mode = 'home';
      modes[id] = { mode, holder: r.holder, into: r.into, visible: r.prop.root.visible || mode === 'palmed' || mode === 'loaded' };
    }
    return { modes };
  }

  restore(snap: PropSnapshot): void {
    for (const id of PROP_IDS) {
      const r = this.rt[id];
      const s = snap.modes[id];
      if (!r || !s) continue;
      this.resetOne(r);
      r.mode = s.mode;
      r.holder = s.holder;
      r.into = s.into;
      if (s.mode === 'palmed') this.setVisible(r, false);
      else if (s.mode === 'loaded' && s.into) {
        this.placeInside(id, s.into);
        this.setVisible(r, false);
      } else if (s.mode === 'hidden') this.setVisible(r, false);
      else this.setVisible(r, s.visible);
    }
  }

  update(dt: number): void {
    this.time += dt;
    let palmHolder: Holder | null = null;
    for (let i = 0; i < PROP_IDS.length; i++) {
      const id = PROP_IDS[i];
      const r = this.rt[id];
      if (!r) continue;
      switch (r.mode) {
        case 'lifted': {
          const side = r.holder as Side;
          const hand = this.hands.states[side];
          if (!hand.tracked) {
            this.startGlide(r);
            break;
          }
          r.liftTime += dt;
          // ease the grab offset to zero so the prop settles between the fingertips
          const k = Math.exp(-14 * dt);
          const o = setV(r.offset, r.offset.x * k, r.offset.y * k, r.offset.z * k);
          const pp = hand.pinchPoint;
          setV(r.target, pp.x + o.x, pp.y + o.y, pp.z + o.z);
          this.worldPos(id, this.tmp);
          lerpV(this.tmp, this.tmp, r.target, 1 - Math.exp(-30 * dt));
          this.setWorld(r, this.tmp);
          break;
        }
        case 'gliding': {
          r.t += dt;
          const u = clamp01(r.t / GLIDE_TIME);
          this.homeWorld(id, this.tmp2);
          lerpV(this.tmp, r.from, this.tmp2, easeOutCubic(u));
          this.tmp.y += Math.sin(Math.PI * u) * 0.025;
          this.setWorld(r, this.tmp);
          if (u >= 1) {
            r.mode = 'home';
            r.holder = null;
            this.events.emit('prop:returned', { prop: id });
          }
          break;
        }
        case 'auto': {
          r.t += dt;
          const u = clamp01(r.t / AUTO_LIFT_TIME);
          const h = Math.sin(Math.PI * easeInOutSine(u)) * 0.07;
          copyV(this.tmp, r.from);
          this.tmp.y += h;
          this.setWorld(r, this.tmp);
          if (u >= 1) {
            r.mode = 'home';
            r.holder = null;
            this.events.emit('prop:returned', { prop: id });
          }
          break;
        }
        case 'shown': {
          if (r.t < 0) {
            r.t += dt;
            if (r.t >= 0) {
              // time to glide home from where it appeared (only props that appeared at a point)
              this.worldPos(id, r.from);
              r.mode = 'gliding';
              r.t = 0;
            }
          }
          break;
        }
        case 'palmed':
          if (!palmHolder && r.holder) palmHolder = r.holder;
          break;
        default:
          break;
      }
    }
    // glint in the fist (player-only cue)
    if (palmHolder && palmHolder !== 'rabbit' && this.hands.states[palmHolder].tracked) {
      const hand = this.hands.states[palmHolder];
      this.frame.toLocal(hand.palm, this.glint.position);
      this.glint.visible = true;
      const pulse = 0.75 + 0.25 * Math.sin(this.time * 6.0);
      this.glintMat.opacity = pulse;
      this.glint.scale.setScalar(0.018 + 0.004 * pulse);
    } else {
      this.glint.visible = false;
    }
  }

  dispose(): void {
    this.glint.removeFromParent();
    this.glintMat.dispose();
    this.glintTex.dispose();
  }

  // ------------------------------------------------------------------------------------------- internals
  private startGlide(r: PropRuntime): void {
    worldPos(r.prop.root, r.from);
    r.mode = 'gliding';
    r.t = 0;
  }

  private resetOne(r: PropRuntime): void {
    try {
      r.prop.reset();
    } catch (e) {
      console.warn('[props] reset failed', e);
    }
    r.glint = 'none';
    r.mode = 'home';
    r.holder = null;
    r.into = null;
    r.t = 0;
    r.liftTime = 0;
    // make sure the root sits on its mark even if reset() only touched visuals
    this.homeWorld(r.prop.id, this.tmp);
    this.setWorld(r, this.tmp);
  }

  private setVisible(r: PropRuntime, v: boolean): void {
    try {
      r.prop.setVisible(v);
    } catch {
      r.prop.root.visible = v;
    }
  }

  /** Write a world position into the prop root (whatever its parent is). */
  private setWorld(r: PropRuntime, world: Vector3): void {
    setWorldPos(r.prop.root, world, this.m4);
  }

  private placeInside(id: PropId, into: PropId): void {
    const r = this.rt[id];
    const host = this.rt[into];
    if (!r || !host) return;
    this.frame.toWorld(host.prop.home, this.tmp);
    if (into === 'cupcake') this.tmp.y += 0.02; // inside the box; under a cup it stands on the mat
    this.setWorld(r, this.tmp);
  }
}

/** Soft round glow (shared by the palm glint). */
export function makeGlowTexture(size = 64): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.22, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
