// Session (G): landing page ↔ immersive, 72 Hz + foveation, calibration on the first stable XR frames and on
// "Recenter", pause/resume on visibility (curtain closed, audience frozen, audio paused), "Hold it!" while the
// palming hand is untracked, plaques, settings, autosave per beat and the poster wall.
import { Vector3, VisibilityState } from '@iwsdk/core';
import type { GameContext, Landing, PlaqueAction, PosterData, Settings } from '../contracts.js';
import type { Attention } from './attention.js';
import type { GazeTracker } from './gaze.js';
import type { HandTracker } from './hands.js';
import type { PropController } from './props.js';
import { writeSave, type SaveData } from './save.js';
import { rigFrame, worldPos } from './space.js';
import type { TrickRunner } from './tricks.js';

const ALL_PLAQUES: PlaqueAction[] = ['retry', 'easy', 'assist', 'recenter', 'exit'];
const BOW_PLAQUES: PlaqueAction[] = ['retry', 'exit'];

export class SessionController {
  paused = false;
  holdIt = false;
  immersive = false;
  calibrated = false;
  calibrations = 0;
  visibility = 'non-immersive';

  private wantCalibrate = false;
  private xrFrames = 0;
  private stable = 0;
  private readonly lastHead = new Vector3();
  private readonly tmp = new Vector3();
  private readonly unsub: Array<() => void> = [];
  private beatKind = '';
  private frozenApplied = false;

  constructor(
    private readonly ctx: GameContext,
    private readonly runner: TrickRunner,
    private readonly attention: Attention,
    private readonly gaze: GazeTracker,
    private readonly props: PropController,
    private readonly hands: HandTracker,
    private readonly landing: Landing | null,
    readonly save: SaveData,
  ) {}

  start(xrSupported: boolean): void {
    const { world, events, settings, audio, ui } = this.ctx;
    try {
      this.landing?.mount({
        onEnter: () => {
          try {
            void audio.unlock().catch(() => {});
          } catch {
            /* audio is optional */
          }
          world.launchXR();
        },
        settings,
        xrSupported,
      });
    } catch (e) {
      console.warn('[session] landing mount failed', e);
    }
    this.unsub.push(events.on('plaque', ({ action }) => this.onPlaque(action)));
    this.unsub.push(
      events.on('beat:start', ({ kind }) => {
        this.beatKind = kind;
        this.refreshPlaques();
        if (kind === 'bow') this.onBow();
      }),
    );
    this.unsub.push(settings.subscribe((s) => this.applySettings(s)));
    this.unsub.push(world.visibilityState.subscribe((s) => this.onVisibility(s)));
    try {
      ui.posters(this.save.posters.slice());
    } catch {
      /* cosmetic */
    }
    this.refreshPlaques();
  }

  dispose(): void {
    for (const off of this.unsub) off();
    this.unsub.length = 0;
  }

  /** Per frame (before the trick runner). */
  update(dt: number): void {
    if (this.immersive && this.wantCalibrate) {
      this.xrFrames++;
      worldPos(this.ctx.world.player.head, this.tmp);
      const moved = this.tmp.distanceTo(this.lastHead);
      this.lastHead.copy(this.tmp);
      const valid = this.tmp.lengthSq() > 1e-6;
      this.stable = valid && moved < 0.004 ? this.stable + dt : 0;
      if ((this.xrFrames >= 6 && this.stable >= 0.25) || this.xrFrames > 150) this.calibrate();
    }
    // "Hold it!": the hand holding a palmed prop lost tracking
    const holder = this.props.palmHolder();
    const lost =
      this.immersive && this.runner.started && !!holder && holder !== 'rabbit' && !this.hands.states[holder].tracked;
    if (lost !== this.holdIt) {
      this.holdIt = lost;
      try {
        this.ctx.ui.banner(lost ? 'Hold it!' : null);
      } catch {
        /* cosmetic */
      }
      this.applyRunState();
    }
  }

  /** Stage rig ← current head pose (yaw only). */
  calibrate(): void {
    const { world, rig } = this.ctx;
    const head = this.immersive ? world.player.head : world.camera;
    try {
      rig.calibrateFromHead(head);
      rigFrame(rig).sync();
    } catch (e) {
      console.warn('[session] calibration failed', e);
      return;
    }
    this.calibrated = true;
    this.calibrations++;
    this.wantCalibrate = false;
    this.attention.resetHistory();
    this.gaze.resetFilter();
    // every session starts from the attract view: the show resumes at the autosaved checkpoint (a save at the bow
    // means tonight's show starts again)
    if (!this.runner.started) this.runner.begin(this.save.act, this.save.beat, this.save.stars);
    this.applyRunState();
  }

  setSettings(patch: Partial<Settings>): void {
    this.ctx.settings.value = { ...this.ctx.settings.peek(), ...patch };
  }

  /** Autosave (beat boundaries; a finished act saves the start of the next one). */
  autosave(): void {
    const r = this.runner;
    const def = r.def;
    const actDone = r.phase === 'done' && r.act >= 1 && r.act <= 3;
    this.save.act = actDone ? r.act + 1 : r.act || 1;
    this.save.beat = actDone || !def ? 0 : r.checkpointOf(def);
    this.save.settings = { ...this.ctx.settings.peek() };
    this.save.stars = r.stars.slice();
    writeSave(this.save);
  }

  // ------------------------------------------------------------------------------------------ internals
  private onVisibility(s: VisibilityState): void {
    const { events } = this.ctx;
    this.visibility = s;
    switch (s) {
      case VisibilityState.Visible:
        if (!this.immersive) this.enterImmersive();
        if (this.paused) this.resume();
        events.emit('session:visibility', { state: 'visible' });
        break;
      case VisibilityState.VisibleBlurred:
        if (!this.immersive) this.enterImmersive();
        this.pause();
        events.emit('session:visibility', { state: 'blurred' });
        break;
      case VisibilityState.Hidden:
        this.pause();
        events.emit('session:visibility', { state: 'hidden' });
        break;
      default:
        this.exitImmersive();
        events.emit('session:visibility', { state: 'non-immersive' });
        break;
    }
  }

  private enterImmersive(): void {
    const { world, audio } = this.ctx;
    this.immersive = true;
    this.wantCalibrate = true;
    this.calibrated = false;
    this.xrFrames = 0;
    this.stable = 0;
    this.lastHead.set(0, 0, 0);
    try {
      this.landing?.setVisible(false);
    } catch {
      /* cosmetic */
    }
    try {
      const session = world.session as (XRSession & { updateTargetFrameRate?: (r: number) => Promise<void> }) | undefined;
      void session?.updateTargetFrameRate?.(72)?.catch?.(() => {});
    } catch {
      /* optional API */
    }
    try {
      world.renderer.xr.setFoveation(1);
    } catch {
      /* optional */
    }
    try {
      void audio.unlock().catch(() => {});
      audio.setPaused(false);
      audio.music.start();
    } catch {
      /* audio is optional */
    }
    this.applyRunState();
  }

  private exitImmersive(): void {
    this.immersive = false;
    this.wantCalibrate = false;
    this.holdIt = false;
    this.paused = false;
    // the calm 2D attract view behind the landing page (after Exit, or leaving from a pause): Act I's kits idling
    // on an open stage, the coin on its mark, nothing left over from the beat; the show resumes from the autosave
    if (this.runner.started || !this.runner.attracting) this.runner.attract();
    this.beatKind = '';
    this.refreshPlaques();
    try {
      void Promise.resolve(this.ctx.ui.curtain('open')).catch(() => {});
    } catch {
      /* cosmetic */
    }
    try {
      this.ctx.ui.banner(null);
    } catch {
      /* cosmetic */
    }
    try {
      this.landing?.setVisible(true);
    } catch {
      /* cosmetic */
    }
    try {
      this.ctx.audio.setPaused(true);
    } catch {
      /* optional */
    }
    this.applyRunState();
  }

  private pause(): void {
    if (this.paused) return;
    this.paused = true;
    try {
      void this.ctx.ui.curtain('closed');
    } catch {
      /* cosmetic */
    }
    try {
      this.ctx.audio.setPaused(true);
    } catch {
      /* optional */
    }
    this.applyRunState();
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    try {
      void this.ctx.ui.curtain('open');
    } catch {
      /* cosmetic */
    }
    try {
      this.ctx.audio.setPaused(false);
    } catch {
      /* optional */
    }
    this.applyRunState();
  }

  /** Runner + audience freeze state from (immersive, calibrated, paused, holdIt). */
  private applyRunState(): void {
    const freeze = this.paused || this.holdIt;
    this.runner.running = this.runner.started && this.immersive && this.calibrated && !freeze;
    this.attention.frozen = freeze;
    if (freeze !== this.frozenApplied) {
      this.frozenApplied = freeze;
      for (const s of this.ctx.spectators) {
        try {
          s.setFrozen(freeze);
        } catch {
          /* cosmetic */
        }
      }
      // the gadgets stand still: so does the music box's tune (it picks up again with the show)
      try {
        this.runner.setHeld(freeze);
      } catch (e) {
        console.warn('[session] music box hold failed', e);
      }
    }
  }

  private onPlaque(action: PlaqueAction): void {
    const s = this.ctx.settings.peek();
    try {
      this.ctx.audio.sfx('uiPress');
    } catch {
      /* optional */
    }
    switch (action) {
      case 'retry':
        this.runner.retry();
        break;
      case 'easy':
        this.setSettings({ easyAudience: !s.easyAudience });
        break;
      case 'assist':
        this.setSettings({ assist: !s.assist });
        break;
      case 'recenter':
        if (this.immersive) this.calibrate();
        break;
      case 'exit':
        this.exit();
        break;
    }
  }

  /**
   * Exit plaque: the curtain falls, then the session ends (back to the landing page). The XR session is never
   * ended from inside the frame that handled the poke, and a slow curtain cannot keep the player in XR.
   */
  private exit(): void {
    if (this.exiting || !this.immersive) return;
    this.exiting = true;
    let done = false;
    const leave = () => {
      if (done) return;
      done = true;
      this.exiting = false;
      try {
        if (this.ctx.world.session) this.ctx.world.exitXR();
      } catch (e) {
        console.warn('[session] exitXR failed', e);
      }
    };
    try {
      this.ctx.audio.sfx('curtain');
      void this.ctx.ui.curtain('closed').then(leave, leave);
    } catch {
      /* cosmetic */
    }
    setTimeout(leave, 1600);
  }
  private exiting = false;

  private applySettings(s: Settings): void {
    try {
      this.ctx.cafe.setCompact(s.compactStage);
    } catch {
      /* cosmetic */
    }
    this.runner.setAssist(s.assist);
    this.refreshPlaques();
    this.save.settings = { ...s };
    writeSave(this.save);
  }

  private refreshPlaques(): void {
    const s = this.ctx.settings.peek();
    try {
      this.ctx.ui.setPlaques(this.beatKind === 'bow' ? BOW_PLAQUES : ALL_PLAQUES, { easy: s.easyAudience, assist: s.assist });
    } catch (e) {
      console.warn('[session] setPlaques failed', e);
    }
  }

  private onBow(): void {
    const r = this.runner;
    const total = r.stars[0] + r.stars[1] + r.stars[2];
    const d = new Date();
    const poster: PosterData = {
      title: total >= 9 ? 'A Flawless Night' : total >= 6 ? 'Sleight of Eye — Held Over!' : 'Sleight of Eye — Live!',
      date: d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
      stars: total,
    };
    this.save.posters = [...this.save.posters, poster].slice(-8);
    this.save.shows += 1;
    this.save.streak = r.caughtTotal === 0 ? this.save.streak + 1 : 0;
    try {
      this.ctx.ui.posters(this.save.posters.slice());
    } catch {
      /* cosmetic */
    }
    this.autosave();
  }
}
