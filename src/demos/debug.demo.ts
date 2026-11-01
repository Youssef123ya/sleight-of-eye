// QA demo (owned by Q). ?demo=debug
// The debug overlay forced on, over the QA fixture stage (every test-targetable name from the spec) and a mock
// window.__app playing a miniature Act 1, so the overlay's app-state lines, the FoV/perf tools and the IWER
// helpers (lookAt / pinchAt / pokeAt / waitForState) all have something real to work against.
// A slowly breathing ring of felt beads changes the draw-call and triangle counts so the numbers visibly update.
import { Group, IcosahedronGeometry, Mesh, type World } from '@iwsdk/core';
import { tint } from '../art/geometry.js';
import { feltMaterial } from '../art/matcap.js';
import { PAL } from '../art/palette.js';
import { onUpdate } from '../boot/loop.js';
import { buildFixture } from '../debug/fixture.js';
import { installMockApp } from '../debug/mock-app.js';
import { installDebugOverlay } from '../debug/overlay.js';
import { StageRig } from '../layout.js';

export default async function debugDemo(world: World): Promise<void> {
  const rig = new StageRig(world);
  const fixture = buildFixture(rig);
  installMockApp(world, rig, fixture);
  installDebugOverlay(world, { force: true });

  // Load generator: 12 felt beads circle above the audience; one by one they appear and vanish (draw calls 0..12).
  const beads = new Group();
  beads.name = 'qa-beads';
  rig.root.add(beads);
  const geo = tint(new IcosahedronGeometry(0.009, 2), 0xffffff);
  const colors = [PAL.foxOrange, PAL.magpieTeal, PAL.gold, PAL.blush, PAL.glintBlue, PAL.target];
  const mats = colors.map((c) => feltMaterial({ color: c, vertexColors: true }));
  const COUNT = 12;
  const meshes: Mesh[] = [];
  for (let i = 0; i < COUNT; i++) {
    const m = new Mesh(geo, mats[i % mats.length]);
    beads.add(m);
    meshes.push(m);
  }
  beads.position.set(0, -0.02, -0.76);
  onUpdate(world, (_dt, time) => {
    const shown = Math.round(((Math.sin(time * 0.6) + 1) / 2) * COUNT);
    for (let i = 0; i < COUNT; i++) {
      const m = meshes[i];
      const a = (i / COUNT) * Math.PI * 2 + time * 0.35;
      m.position.set(Math.cos(a) * 0.3, Math.sin(time * 1.3 + i) * 0.012, Math.sin(a) * 0.12);
      m.visible = i < shown;
    }
  });
}
