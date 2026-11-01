// UI factory: builds every in-XR UI element under rig.root and returns the UI contract implementation.
// Each element lives in its own file; this one wires them together and drives them from ui.update().
// XR-only elements (plaques, hints, the "Hold it!" banner, the gaze spotlight, plus the gameplay overlays: captions,
// title cards, the rewind smear) live under their own root, hidden in the 2D view behind the landing page so it shows
// a calm café; they pop back when the immersive session is visible. The diegetic set pieces (curtain, newspaper,
// posters) stay in both views.
import { Group, Mesh, PlaneGeometry, Vector3, VisibilityState, type Object3D, type World } from '@iwsdk/core';
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
import type { StageRig } from '../layout.js';
import { Captions } from './captions.js';
import type { UICtx } from './context.js';
import { Curtain } from './curtain.js';
import { UIFrame } from './frame.js';
import { ensureFonts } from './fonts.js';
import { disposeTrailGeometry, GazeTrailHint } from './gazeTrail.js';
import { buildGloveShared, GloveHint, type GloveShared, type HintBusy, type ManagedHint } from './glove.js';
import { Plaques } from './plaques.js';
import { Posters } from './posters.js';
import { Review } from './review.js';
import { RewindSmear } from './rewind.js';
import { Banner, TitleCard } from './signs.js';
import { Spotlight } from './spotlight.js';

type Deps = { pokes: PokeRegistry; gazeTargets: GazeTargetRegistry; events: Emitter<GameEvents>; cafe: Cafe | null };

/** The UI implementation (contract `UI` plus a few extras the demo/debug tools use). */
export class GameUI implements UI {
  readonly root = new Group();
  /** Parent of the XR-only elements (plaques, hints, banner, spotlight, captions, title card, rewind): hidden in 2D. */
  readonly xrRoot = new Group();
  /**
   * Hide the XR-only elements while the page is non-immersive (the landing page's café backdrop). The module demo
   * turns this off so the elements can be inspected in a plain browser.
   */
  autoHide2D = true;
  private readonly ctx: UICtx;
  private readonly xrCtx: UICtx;
  private readonly eye = new Vector3(0, 0, 0);
  private readonly spot: Spotlight;
  private readonly captions: Captions;
  private readonly plaques: Plaques;
  private readonly curtainFx: Curtain;
  private readonly title: TitleCard;
  private readonly rewind: RewindSmear;
  private readonly paper: Review;
  private readonly posterWall: Posters;
  private readonly bannerSign: Banner;
  private readonly glove: GloveShared;
  private readonly rippleGeo = new PlaneGeometry(2, 2);
  private readonly hints: ManagedHint[] = [];
  private readonly failed = new Set<string>();
  private readonly tickers: Array<{ name: string; fn: (dt: number, time: number) => void }>;
  // XR shader warm-up (programs compiled in 2D are not reused under multiview)
  private wasPresenting = false;
  private warmUndo: Array<() => void> | null = null;
  private warmHints: ManagedHint[] = [];
  /** XR-only elements currently shown (null until the first update decides). */
  private xrShown: boolean | null = null;
  /**
   * world.visibilityState, cached by a subscription: this preact build's `peek()` wraps the read in
   * `untracked(() => …)`, which allocates a closure on every call.
   */
  private visState: VisibilityState = VisibilityState.NonImmersive;
  private readonly offVisibility: () => void;
  /** Bound once: ghost gloves bow out while a caption is up near their target. */
  private readonly captionBusy: HintBusy;

  constructor(
    private readonly world: World,
    rig: StageRig,
    deps: Deps,
  ) {
    this.root.name = 'ui-root';
    rig.root.add(this.root);
    this.xrRoot.name = 'ui-xr-only';
    this.root.add(this.xrRoot);
    let aniso = 4;
    try {
      aniso = Math.min(8, world.renderer.capabilities.getMaxAnisotropy() || 4);
    } catch {
      /* keep the default */
    }
    const frame = new UIFrame(rig);
    let off: () => void = () => {};
    try {
      off = world.visibilityState.subscribe((v) => {
        this.visState = v;
      });
    } catch {
      /* no signal: stays non-immersive (2D) */
    }
    this.offVisibility = off;
    this.ctx = { world, rig, frame, root: this.root, eye: this.eye, anisotropy: aniso };
    this.xrCtx = { world, rig, frame, root: this.xrRoot, eye: this.eye, anisotropy: aniso };
    this.spot = new Spotlight(this.xrCtx);
    this.captions = new Captions(this.xrCtx);
    this.captionBusy = (p) => this.captions.blocks(p);
    this.plaques = new Plaques(this.xrCtx, {
      pokes: deps.pokes,
      gazeTargets: deps.gazeTargets,
      events: deps.events,
      anchors: deps.cafe?.plaqueAnchors ?? null,
    });
    this.curtainFx = new Curtain(this.ctx, deps.cafe);
    this.title = new TitleCard(this.xrCtx);
    this.rewind = new RewindSmear(this.xrCtx);
    this.paper = new Review(this.ctx);
    this.posterWall = new Posters(this.ctx, deps.cafe?.posterWall ?? null);
    this.bannerSign = new Banner(this.xrCtx);
    this.glove = buildGloveShared();
    // per-frame updaters, bound once (no closures allocated per frame)
    this.tickers = [
      { name: 'spotlight', fn: (dt, t) => this.spot.update(dt, t) },
      { name: 'captions', fn: (dt, t) => this.captions.update(dt, t) },
      { name: 'plaques', fn: (dt) => this.plaques.update(dt) },
      { name: 'curtain', fn: (dt) => this.curtainFx.update(dt) },
      { name: 'title', fn: (dt) => this.title.update(dt) },
      { name: 'rewind', fn: (dt) => this.rewind.update(dt) },
      { name: 'review', fn: (dt) => this.paper.update(dt) },
      { name: 'posters', fn: (dt) => this.posterWall.update(dt) },
      { name: 'banner', fn: (dt) => this.bannerSign.update(dt) },
    ];
  }

  // ------------------------------------------------------------------------------------- UI contract
  spotlight(point: Vector3 | null, strength = 1): void {
    this.spot.set(point, strength);
  }

  caption(text: string, at: Object3D, opts?: { seconds?: number; style?: 'speech' | 'shout' | 'whisper' }): void {
    if (!text || !at) return;
    this.captions.show(text, at, opts);
  }

  hintPinch(target: Object3D, side: Side = 'right'): Hint {
    return this.addHint(new GloveHint(this.xrCtx, this.glove, 'pinch', target, side, this.rippleGeo, this.captionBusy));
  }

  hintPoke(target: Object3D, side: Side = 'right'): Hint {
    return this.addHint(new GloveHint(this.xrCtx, this.glove, 'poke', target, side, this.rippleGeo, this.captionBusy));
  }

  hintGaze(from: () => Vector3, to: Object3D): Hint {
    return this.addHint(new GazeTrailHint(this.xrCtx, from, to));
  }

  clearHints(): void {
    for (let i = 0; i < this.hints.length; i++) this.hints[i].stop();
  }

  setPlaques(actions: PlaqueAction[], toggles: Partial<Record<'easy' | 'assist', boolean>>): void {
    this.plaques.set(actions, toggles);
  }

  curtain(state: 'open' | 'closed'): Promise<void> {
    return this.curtainFx.go(state);
  }

  titleCard(title: string, subtitle?: string): Promise<void> {
    return this.title.show(title, subtitle);
  }

  rewindSmear(): Promise<void> {
    return this.rewind.play();
  }

  /** Shows the newspaper; `null` (not yet in the contract) clears it for the next show. */
  review(data: ReviewData | null): void {
    if (!data) this.paper.hide();
    else this.paper.show(data);
  }

  posters(list: PosterData[]): void {
    this.posterWall.set(list);
  }

  banner(text: string | null): void {
    this.bannerSign.set(text);
  }

  update(dt: number, time: number): void {
    if (this.warmUndo) this.endWarmup();
    const frame = this.ctx.frame;
    frame.sync(); // picks up a recalibration (a 16-number compare otherwise)
    let immersive = false;
    try {
      const world = this.world;
      immersive = !!world.session && this.visState !== VisibilityState.NonImmersive;
      // eye position in rig space (billboards, poke directions, the spotlight's line of sight). The head's world
      // matrix is read as it is: getWorldPosition() would recompose the player/camera entities and allocate.
      const head = immersive ? world.player.head : world.camera;
      frame.objectLocal(head, this.eye);
      if (!Number.isFinite(this.eye.x + this.eye.y + this.eye.z)) this.eye.set(0, 0, 0);
    } catch {
      this.eye.set(0, 0, 0);
    }
    this.applyXrVisibility(immersive || !this.autoHide2D);
    for (let i = 0; i < this.tickers.length; i++) {
      const tk = this.tickers[i];
      try {
        tk.fn(dt, time);
      } catch (e) {
        this.fail(tk.name, e);
      }
    }
    for (let i = this.hints.length - 1; i >= 0; i--) {
      const h = this.hints[i];
      try {
        h.update(dt, time);
      } catch (e) {
        this.fail('hint', e);
        h.stop();
      }
      if (h.dead) {
        h.dispose();
        this.hints.splice(i, 1);
      }
    }
    let presenting = false;
    try {
      presenting = this.world.renderer.xr.isPresenting;
    } catch {
      presenting = false;
    }
    if (presenting && !this.wasPresenting) this.beginWarmup();
    this.wasPresenting = presenting;
  }

  /**
   * On the first XR frame, draw every hidden UI mesh once at a microscopic scale so its multiview shader
   * compiles (and its textures upload) now, behind the session fade — not as a hitch the first time the
   * curtain drops or a hint appears. Undone on the next update.
   */
  private beginWarmup(): void {
    try {
      // hint materials are created per hint; keep one hidden instance of each alive for the session so
      // their programs stay referenced (three frees a program when its last material is disposed)
      if (!this.warmHints.length) {
        const dummy = new Group();
        dummy.name = 'ui-warmup-anchor';
        this.xrRoot.add(dummy);
        this.warmHints = [
          new GloveHint(this.xrCtx, this.glove, 'pinch', dummy, 'right', this.rippleGeo),
          new GazeTrailHint(this.xrCtx, () => this.eye, dummy),
        ];
      }
      const undo: Array<() => void> = [];
      const hidden: Mesh[] = [];
      const visibleInTree = (o: Object3D, top: Object3D): boolean => {
        for (let p: Object3D | null = o; p; p = p.parent) {
          if (!p.visible) return false;
          if (p === top) return true;
        }
        return true;
      };
      for (const top of [this.root, this.posterWall.group]) {
        top.traverse((o) => {
          if (o instanceof Mesh && !visibleInTree(o, top)) hidden.push(o);
        });
      }
      for (const m of hidden) {
        if (m.matrixAutoUpdate) {
          const sx = m.scale.x;
          const sy = m.scale.y;
          const sz = m.scale.z;
          m.scale.set(sx * 1e-5, sy * 1e-5, sz * 1e-5);
          undo.push(() => m.scale.set(sx, sy, sz));
        } else {
          // directly-driven matrix (xform.ts): shrink the matrix itself, then restore it
          const saved = m.matrix.clone();
          m.matrix.scale(new Vector3(1e-5, 1e-5, 1e-5));
          m.matrixWorldNeedsUpdate = true;
          undo.push(() => {
            m.matrix.copy(saved);
            m.matrixWorldNeedsUpdate = true;
          });
        }
        for (let p: Object3D | null = m; p && p !== this.root.parent; p = p.parent) {
          if (!p.visible) {
            const o = p;
            o.visible = true;
            undo.push(() => (o.visible = false));
          }
        }
      }
      this.warmUndo = undo;
    } catch (e) {
      this.fail('warmup', e);
    }
  }

  private endWarmup(): void {
    const undo = this.warmUndo ?? [];
    this.warmUndo = null;
    for (let i = undo.length - 1; i >= 0; i--) {
      try {
        undo[i]();
      } catch {
        /* keep restoring */
      }
    }
  }

  /**
   * Show/hide the XR-only root. Coming back into view (the session became visible) the plaques re-read their
   * anchors and pop in again, and the spotlight fades in at the new gaze point instead of sliding from the 2D one.
   */
  private applyXrVisibility(show: boolean): void {
    if (show === this.xrShown) return;
    const first = this.xrShown === null;
    this.xrShown = show;
    this.xrRoot.visible = show;
    if (!show || first) return;
    try {
      this.plaques.refresh();
      this.plaques.replayIntro();
    } catch (e) {
      this.fail('plaques-show', e);
    }
    this.spot.reset();
  }

  // ------------------------------------------------------------------------------------------ extras
  /** Hide the review newspaper (e.g. when a new show starts). */
  hideReview(): void {
    this.paper.hide();
  }

  /** Drive a plaque's hover/press without a hand (demo + debug tooling). */
  simulatePlaque(action: PlaqueAction, what: 'hover' | 'unhover' | 'poke'): void {
    this.plaques.simulate(action, what);
  }

  get curtainClosed(): boolean {
    return this.curtainFx.isClosed;
  }

  dispose(): void {
    this.offVisibility();
    for (const h of this.hints) h.dispose();
    this.hints.length = 0;
    for (const h of this.warmHints) h.dispose();
    this.warmHints = [];
    this.spot.dispose();
    this.captions.dispose();
    this.plaques.dispose();
    this.curtainFx.dispose();
    this.title.dispose();
    this.rewind.dispose();
    this.paper.dispose();
    this.posterWall.dispose();
    this.bannerSign.dispose();
    this.glove.geometry.dispose();
    this.rippleGeo.dispose();
    disposeTrailGeometry();
    this.root.removeFromParent();
  }

  private addHint(h: ManagedHint): Hint {
    this.hints.push(h);
    return { stop: () => h.stop() };
  }

  private fail(name: string, e: unknown): void {
    if (this.failed.has(name)) return;
    this.failed.add(name);
    console.error(`[ui] ${name} update failed (logged once):`, e);
  }
}

export const uiFactory: UIFactory = {
  async build(world, rig, deps) {
    await ensureFonts();
    return new GameUI(world, rig, deps);
  },
};
