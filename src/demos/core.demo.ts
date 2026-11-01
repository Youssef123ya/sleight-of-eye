// Gameplay core demo (G): the whole show on stub services (?demo=core). Drive it in IWER (tests/scenarios/
// core-*.mjs) or by hand: enter XR, look around, pinch, poke. window.__app is the DebugApi
// (debugState / skipTo / setSettings / fovReport) plus where(name) and an event log.
// URL options: &act=2&beat=1 jumps straight to a beat once calibrated; &easy=1, &assist=1, &compact=1 set settings.
import type { World } from '@iwsdk/core';
import { createGame } from '../game/main.js';

export default async function coreDemo(world: World): Promise<void> {
  const game = await createGame(world, { forceStubs: true });
  const q = new URLSearchParams(location.search);
  const patch: Record<string, boolean> = {};
  if (q.has('easy')) patch.easyAudience = q.get('easy') !== '0';
  if (q.has('assist')) patch.assist = q.get('assist') !== '0';
  if (q.has('compact')) patch.compactStage = q.get('compact') !== '0';
  if (Object.keys(patch).length) window.__app?.setSettings(patch);
  const act = Number(q.get('act'));
  if (act >= 1) {
    const beat = Number(q.get('beat') ?? 0) || 0;
    const jump = () => {
      if (game.session.calibrated) window.__app?.skipTo(act, beat);
      else setTimeout(jump, 100);
    };
    jump();
  }
}
