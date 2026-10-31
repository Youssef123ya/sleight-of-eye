// Lead's foundation smoke test: stage rig + felt/brass matcaps + merged parts at the layout marks. ?demo=smoke
import { BoxGeometry, CapsuleGeometry, ConeGeometry, Mesh, SphereGeometry, type World } from '@iwsdk/core';
import { mergeParts, tint } from '../art/geometry.js';
import { feltMaterial, matcapMaterial } from '../art/matcap.js';
import { PAL } from '../art/palette.js';
import { L, StageRig } from '../layout.js';

export default function smokeDemo(world: World) {
  const rig = new StageRig(world);
  const felt = feltMaterial();
  const table = new Mesh(tint(new BoxGeometry(L.table.width, 0.03, L.table.depth), PAL.clothCream), matcapMaterial('wood'));
  table.position.set(0, L.tableY - 0.015, L.table.centerZ);
  rig.root.add(table);
  for (const [i, seat] of L.seats.entries()) {
    // a merged multi-part puppet stand-in: body capsule + head sphere + ears = one draw call
    const kit = new Mesh(
      mergeParts([
        { geometry: new CapsuleGeometry(0.022, 0.03, 6, 16), color: i % 2 ? PAL.foxOrange : PAL.magpieTeal, position: [0, 0.035, 0] },
        { geometry: new SphereGeometry(0.03, 24, 16), color: PAL.foxCream, position: [0, 0.09, 0] },
        { geometry: new ConeGeometry(0.012, 0.025, 12), color: PAL.foxDark, position: [-0.017, 0.123, 0], rotation: [0, 0, 0.35] },
        { geometry: new ConeGeometry(0.012, 0.025, 12), color: PAL.foxDark, position: [0.017, 0.123, 0], rotation: [0, 0, -0.35] },
      ]),
      felt,
    );
    kit.position.set(seat[0], seat[1], seat[2]);
    rig.root.add(kit);
  }
  const coin = new Mesh(tint(new BoxGeometry(0.03, 0.004, 0.03), PAL.gold), matcapMaterial('brass'));
  coin.position.set(...L.propMarks.coin);
  rig.root.add(coin);
}
