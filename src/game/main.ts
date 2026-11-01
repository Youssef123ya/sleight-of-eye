// Gameplay core entry (G): builds every service (real module when its entry file exists, else a stub), wires
// the gameplay systems together and runs them from one per-frame tick.
import { signal, type World } from '@iwsdk/core';
import { onUpdate } from '../boot/loop.js';
import type {
  AudioEngine,
  Cafe,
  EnvironmentFactory,
  Fx,
  GameContext,
  GameEvents,
  Landing,
  Settings,
  SpectatorFactory,
  UI,
  UIFactory,
} from '../contracts.js';
import { DEFAULT_SETTINGS } from '../contracts.js';
import { Emitter } from '../events.js';
import { StageRig } from '../layout.js';
import { createStubAudio } from '../stubs/audio.js';
import { stubEnvironmentFactory } from '../stubs/environment.js';
import { stubLanding } from '../stubs/landing.js';
import { stubSpectatorFactory } from '../stubs/spectators.js';
import { stubUIFactory } from '../stubs/ui.js';
import { Attention } from './attention.js';
import { installDebugApi } from './debug.js';
import { GazeTracker } from './gaze.js';
import { HandTracker } from './hands.js';
import { Hints } from './hints.js';
import { PropController } from './props.js';
import { GazeTargetRegistryImpl, PokeRegistryImpl } from './registries.js';
import { emptySave, loadSave } from './save.js';
import { SeenTester } from './seen.js';
import type { RealServices } from './services.js';
import { SessionController } from './session.js';
import { rigFrame } from './space.js';
import { TrickRunner } from './tricks.js';

type DebugOverlayInstaller = (world: World, opts?: Record<string, unknown>) => unknown;

export interface StartOptions {
  /** Use the stubs for every service even when the real modules exist (graybox tests). */
  forceStubs?: boolean;
}

/** Everything startGame built, for demos and tests. */
export interface GameHandle {
  ctx: GameContext;
  runner: TrickRunner;
  session: SessionController;
  sources: Record<string, 'real' | 'stub'>;
  dispose(): void;
}

let current: GameHandle | null = null;

export async function startGame(world: World, opts: StartOptions = {}): Promise<void> {
  await createGame(world, opts);
}

export async function createGame(world: World, opts: StartOptions = {}): Promise<GameHandle> {
  if (current) return current;
  const force = !!opts.forceStubs;
  const sources: Record<string, 'real' | 'stub'> = {};

  // ---------------------------------------------------------------------------------------- services
  // Real module when its entry file exists (services.ts globs them), else the stub. The import is dynamic so
  // a stub-only run never loads (or hot-reloads with) the other modules.
  const real: RealServices = force ? {} : await import('./services.js').then((m) => m.loadRealServices()).catch((e) => {
    console.warn('[game] real modules unavailable; using stubs', e);
    return {};
  });
  const pick = <T>(name: string, value: T | undefined, fallback: T): T => {
    sources[name] = value ? 'real' : 'stub';
    return value ?? fallback;
  };
  const spectatorFactory = pick<SpectatorFactory>('spectatorFactory', real.spectatorFactory, stubSpectatorFactory);
  const environmentFactory = pick<EnvironmentFactory>('environmentFactory', real.environmentFactory, stubEnvironmentFactory);
  const audioCtor = pick<() => AudioEngine>('createAudioEngine', real.createAudioEngine, createStubAudio);
  const uiFactory = pick<UIFactory>('uiFactory', real.uiFactory, stubUIFactory);
  const landing = pick<Landing>('landing', real.landing, stubLanding);
  const debugOverlay: DebugOverlayInstaller | null = real.installDebugOverlay ?? null;
  sources.installDebugOverlay = debugOverlay ? 'real' : 'stub';

  // ------------------------------------------------------------------------------------------ the stage
  const saved = loadSave();
  const save = saved ?? emptySave();
  const rig = new StageRig(world);
  const events = new Emitter<GameEvents>();
  const settings = signal<Settings>({ ...DEFAULT_SETTINGS, ...save.settings });
  const pokes = new PokeRegistryImpl();
  const gazeTargets = new GazeTargetRegistryImpl();

  let audio: AudioEngine;
  try {
    audio = audioCtor();
  } catch (e) {
    console.warn('[game] audio engine failed to start; using the silent stub', e);
    audio = createStubAudio();
    sources.createAudioEngine = 'stub';
  }

  let cafe: Cafe;
  let fx: Fx;
  try {
    ({ cafe, fx } = await environmentFactory.build(world, rig));
  } catch (e) {
    if (environmentFactory === stubEnvironmentFactory) throw e;
    console.warn('[game] environment build failed; using the stub café', e);
    ({ cafe, fx } = await stubEnvironmentFactory.build(world, rig));
    sources.environmentFactory = 'stub';
  }

  let ui: UI;
  try {
    ui = await uiFactory.build(world, rig, { pokes, gazeTargets, events, cafe });
  } catch (e) {
    if (uiFactory === stubUIFactory) throw e;
    console.warn('[game] UI build failed; using the stub UI', e);
    ui = await stubUIFactory.build(world, rig, { pokes, gazeTargets, events, cafe });
    sources.uiFactory = 'stub';
  }

  const gaze = new GazeTracker(world, rig, gazeTargets, events);
  gaze.ui = ui;
  const handTracker = new HandTracker(world, pokes, events);

  const ctx: GameContext = {
    world,
    rig,
    events,
    settings,
    gaze,
    hands: handTracker.states,
    pokes,
    gazeTargets,
    cafe,
    fx,
    spectators: [],
    spectatorFactory,
    audio,
    ui,
  };

  // ---------------------------------------------------------------------------------------- gameplay
  const props = new PropController(world, rig, cafe, handTracker, events);
  const seen = new SeenTester(cafe, settings);
  const attention = new Attention(rig, cafe, gaze, handTracker, props, seen, audio, settings, ui);
  const hints = new Hints(ui, () => gaze.point);
  let session: SessionController | null = null;
  const runner = new TrickRunner({
    ctx,
    props,
    attention,
    seen,
    gaze,
    handTracker,
    hints,
    pokes,
    gazeTargets,
    onBeatBoundary: () => session?.autosave(),
  });
  session = new SessionController(ctx, runner, attention, gaze, props, handTracker, landing, save);
  const sess = session;

  // the 2D attract view: the opening act's audience on stage behind the landing page
  runner.skipToIdle();

  // ------------------------------------------------------------------------------------------ frame tick
  const reported = new Set<string>();
  const report = (name: string, e: unknown) => {
    if (reported.has(name)) return;
    reported.add(name);
    console.error(`[game] ${name} update threw (logged once):`, e);
  };
  const frame = rigFrame(rig);
  const tick = (dt: number, t: number) => {
    frame.sync(); // picks up a recalibration (rig-local ↔ world conversions read the cached rig matrix)
    try {
      handTracker.update(dt);
    } catch (e) {
      report('hands', e);
    }
    try {
      gaze.update(dt);
    } catch (e) {
      report('gaze', e);
    }
    try {
      sess.update(dt);
    } catch (e) {
      report('session', e);
    }
    const frozen = sess.paused || sess.holdIt;
    if (!frozen) {
      try {
        runner.update(dt);
      } catch (e) {
        report('tricks', e);
      }
      try {
        props.update(dt);
      } catch (e) {
        report('props', e);
      }
      try {
        cafe.update(dt, t);
      } catch (e) {
        report('cafe', e);
      }
    }
    try {
      attention.update(dt);
    } catch (e) {
      report('attention', e);
    }
    const specs = ctx.spectators;
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      if (!s.root.visible) continue;
      try {
        s.update(dt, t);
      } catch (e) {
        report(`spectator ${s.id}`, e);
      }
    }
    try {
      fx.update(dt, t);
    } catch (e) {
      report('fx', e);
    }
    try {
      ui.update(dt, t);
    } catch (e) {
      report('ui', e);
    }
    try {
      audio.setListener(world.camera);
    } catch (e) {
      report('audio', e);
    }
  };
  const offTick = onUpdate(world, tick);

  // ----------------------------------------------------------------------------------- debug + session
  installDebugApi({ ctx, runner, session: sess, attention, gaze, hands: handTracker, props, hints, sources });
  if (debugOverlay) {
    try {
      debugOverlay(world); // shows with ?debug=1; reads window.__app.debugState()
    } catch (e) {
      console.warn('[game] debug overlay failed', e);
    }
  }
  sess.start(await xrSupported());
  console.info('[game] started', JSON.stringify(sources));

  current = {
    ctx,
    runner,
    session: sess,
    sources,
    dispose() {
      offTick();
      sess.dispose();
      props.dispose();
      current = null;
    },
  };
  return current;
}

async function xrSupported(): Promise<boolean> {
  try {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) return false;
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500));
    return await Promise.race([xr.isSessionSupported('immersive-vr').catch(() => false), timeout]);
  } catch {
    return false;
  }
}
