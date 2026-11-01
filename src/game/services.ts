// Real-module discovery (G). Kept apart from main.ts and imported only when stubs are not forced, so the
// stub-only demo (?demo=core) never pulls other modules into its import graph (no HMR reloads from their edits).
import type { World } from '@iwsdk/core';
import type { AudioEngine, EnvironmentFactory, Landing, SpectatorFactory, UIFactory } from '../contracts.js';

type Loader = () => Promise<Record<string, unknown>>;

// Real modules are picked up when their entry files exist (Vite resolves these globs at dev/build time).
const SPECTATOR_MODS = import.meta.glob('../spectators/factory.ts') as Record<string, Loader>;
const ENVIRONMENT_MODS = import.meta.glob('../environment/factory.ts') as Record<string, Loader>;
const AUDIO_MODS = import.meta.glob('../audio/engine.ts') as Record<string, Loader>;
const UI_MODS = import.meta.glob('../ui/factory.ts') as Record<string, Loader>;
const LANDING_MODS = import.meta.glob('../ui/landing.ts') as Record<string, Loader>;
const DEBUG_MODS = import.meta.glob('../debug/overlay.ts') as Record<string, Loader>;

export type DebugOverlayInstaller = (world: World, opts?: Record<string, unknown>) => unknown;

export interface RealServices {
  spectatorFactory?: SpectatorFactory;
  environmentFactory?: EnvironmentFactory;
  createAudioEngine?: () => AudioEngine;
  uiFactory?: UIFactory;
  landing?: Landing;
  installDebugOverlay?: DebugOverlayInstaller;
}

async function load<T>(mods: Record<string, Loader>, key: string, exportName: string): Promise<T | undefined> {
  const loader = mods[key];
  if (!loader) return undefined;
  try {
    const m = await loader();
    const v = m[exportName] as T | undefined;
    if (!v) console.warn(`[game] ${key} has no export "${exportName}"; using the stub`);
    return v;
  } catch (e) {
    console.warn(`[game] ${key} failed to load; using the stub`, e);
    return undefined;
  }
}

/** Whatever real modules exist (each missing/broken one is left undefined → the caller uses its stub). */
export async function loadRealServices(): Promise<RealServices> {
  const [spectatorFactory, environmentFactory, createAudioEngine, uiFactory, landing, installDebugOverlay] = await Promise.all([
    load<SpectatorFactory>(SPECTATOR_MODS, '../spectators/factory.ts', 'spectatorFactory'),
    load<EnvironmentFactory>(ENVIRONMENT_MODS, '../environment/factory.ts', 'environmentFactory'),
    load<() => AudioEngine>(AUDIO_MODS, '../audio/engine.ts', 'createAudioEngine'),
    load<UIFactory>(UI_MODS, '../ui/factory.ts', 'uiFactory'),
    load<Landing>(LANDING_MODS, '../ui/landing.ts', 'landing'),
    load<DebugOverlayInstaller>(DEBUG_MODS, '../debug/overlay.ts', 'installDebugOverlay'),
  ]);
  return { spectatorFactory, environmentFactory, createAudioEngine, uiFactory, landing, installDebugOverlay };
}
