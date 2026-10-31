// Boot (owned by the lead): self-hosted input profiles, World.create, then either a module demo
// (?demo=<name> → src/demos/<name>.demo.ts) or the full game (src/game/main.ts → startGame).
import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { installProfileRedirect } from './boot/profiles.js';

installProfileRedirect();

type DemoModule = { default: (world: World) => Promise<void> | void };
type GameModule = { startGame: (world: World) => Promise<void> };

const demos = import.meta.glob<DemoModule>('./demos/*.demo.ts');
const games = import.meta.glob<GameModule>('./game/main.ts');

World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions).then(async (world) => {
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo) {
    const load = demos[`./demos/${demo}.demo.ts`];
    if (!load) {
      console.error(`[boot] unknown demo "${demo}". Available: ${Object.keys(demos).join(', ')}`);
      return;
    }
    await (await load()).default(world);
    return;
  }
  const loadGame = games['./game/main.ts'];
  if (!loadGame) {
    console.warn('[boot] src/game/main.ts is not written yet');
    return;
  }
  await (await loadGame()).startGame(world);
});
