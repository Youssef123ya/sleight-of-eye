// QA fixture stage (owned by Q): a small stand-in of the café stage that carries every name the tests target
// (props, gadgets + '<id>-focus', spectators + '<id>-<anchor>', 'plaque-<action>', 'seat-0..4', 'mat',
// 'volunteerSpot', 'burst'), placed with layout.ts. It lets tests/fov.mjs, tests/perf.mjs and the IWER helpers be
// proven before the real game exists. Visual parts are merged per object (one draw call each); anchors are empty.
import {
  BoxGeometry,
  CanvasTexture,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  AdditiveBlending,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  type BufferGeometry,
  type Material,
} from '@iwsdk/core';
import { mergeParts, type Part } from '../art/geometry.js';
import { feltMaterial, matcapMaterial } from '../art/matcap.js';
import { PAL } from '../art/palette.js';
import type { GadgetId, PlaqueAction, PropId, SpectatorAnchor } from '../contracts.js';
import { L, type StageRig, type V3 } from '../layout.js';

export interface FixtureSpectator {
  id: string;
  root: Object3D;
  /** Pivot that turns toward what the puppet watches (rig-local yaw). */
  turn: Object3D;
  anchors: Partial<Record<SpectatorAnchor, Object3D>>;
}

export interface Fixture {
  root: Group;
  props: Record<PropId, Mesh>;
  gadgets: Record<GadgetId, { root: Mesh; focus: Object3D }>;
  spectators: FixtureSpectator[];
  plaques: Record<string, Object3D>;
  seats: Object3D[];
  mat: Mesh;
  volunteerSpot: Object3D;
  burst: Object3D;
  lampPool: Mesh;
  /** Named objects tests target, by name. */
  named: Map<string, Object3D>;
  dispose(): void;
}

const at = (o: Object3D, p: V3, dy = 0): Object3D => {
  o.position.set(p[0], p[1] + dy, p[2]);
  return o;
};

/** Build the fixture under `rig.root`. Every geometry/material created here is released by `dispose()`. */
export function buildFixture(rig: StageRig): Fixture {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const keep = <G extends BufferGeometry>(g: G) => (geometries.push(g), g);
  const felt = feltMaterial();
  const brass = matcapMaterial('brass');
  const wood = matcapMaterial('wood');
  const velvet = matcapMaterial('velvet');
  const glossy = matcapMaterial('glossy');
  materials.push(felt, brass, wood, velvet, glossy);
  const merged = (parts: Part[]) => keep(mergeParts(parts));

  const root = new Group();
  root.name = 'qa-fixture';
  rig.root.add(root);
  const named = new Map<string, Object3D>();
  const name = <O extends Object3D>(o: O, n: string): O => {
    o.name = n;
    named.set(n, o);
    return o;
  };
  const Y = L.tableY;

  // ---------------------------------------------------------------- table, mat, riser, shelf (4 draws)
  const table = new Mesh(
    merged([
      { geometry: new BoxGeometry(L.table.width, 0.03, L.table.depth), color: PAL.clothCream },
      // red hem along the near and far edges
      { geometry: new BoxGeometry(L.table.width + 0.004, 0.032, 0.03), color: PAL.clothRed, position: [0, 0, L.table.depth / 2 - 0.015] },
      { geometry: new BoxGeometry(L.table.width + 0.004, 0.032, 0.03), color: PAL.clothRed, position: [0, 0, -L.table.depth / 2 + 0.015] },
    ]),
    felt,
  );
  table.position.set(0, Y - 0.015, L.table.centerZ);
  root.add(table);

  const mat = name(
    new Mesh(
      merged([
        { geometry: new BoxGeometry(L.mat.size[0], 0.004, L.mat.size[1]), color: PAL.velvet },
        { geometry: new BoxGeometry(L.mat.size[0] + 0.012, 0.003, L.mat.size[1] + 0.012), color: PAL.brass, position: [0, -0.001, 0] },
      ]),
      velvet,
    ),
    'mat',
  );
  at(mat, L.mat.center, -0.001);
  root.add(mat);

  const riser = new Mesh(
    merged([
      { geometry: new BoxGeometry(L.riser.width, 0.04, L.riser.depth), color: 0x9a6438 },
      { geometry: new BoxGeometry(L.riser.width + 0.01, 0.006, L.riser.depth + 0.01), color: PAL.brass, position: [0, 0.021, 0] },
    ]),
    wood,
  );
  riser.position.set(0, Y + 0.02, L.riser.z);
  root.add(riser);

  const shelf = new Mesh(
    merged([
      { geometry: new BoxGeometry(0.98, 0.12, 0.12), color: 0x8a5632 },
      { geometry: new BoxGeometry(0.99, 0.008, 0.125), color: PAL.brass, position: [0, 0.062, 0] },
    ]),
    wood,
  );
  shelf.position.set(0, Y + 0.06, L.shelf.z);
  root.add(shelf);

  // ---------------------------------------------------------------- warm lamp pool (1 additive draw)
  const poolTex = radialTexture(PAL.lampWarm);
  const poolMat = new MeshBasicMaterial({
    map: poolTex,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    opacity: 0.3,
    toneMapped: false,
  });
  materials.push(poolMat);
  const lampPool = new Mesh(keep(new PlaneGeometry(0.9, 0.9)), poolMat);
  lampPool.rotation.x = -Math.PI / 2;
  lampPool.position.set(0, Y + 0.0015, -0.48);
  lampPool.renderOrder = 1;
  root.add(lampPool);

  // ---------------------------------------------------------------- props (7 named meshes)
  const propGeo: Record<PropId, BufferGeometry> = {
    coin: merged([
      { geometry: new CylinderGeometry(0.014, 0.014, 0.003, 28), color: PAL.gold },
      { geometry: new TorusGeometry(0.0115, 0.0012, 6, 28), color: PAL.brass, position: [0, 0.0016, 0], rotation: [Math.PI / 2, 0, 0] },
    ]),
    ball: merged([{ geometry: new SphereGeometry(0.012, 20, 14), color: PAL.ballRed, position: [0, 0.012, 0] }]),
    cupLeft: cupGeometry(merged),
    cupMid: cupGeometry(merged),
    cupRight: cupGeometry(merged),
    watch: merged([
      { geometry: new CylinderGeometry(0.016, 0.016, 0.006, 28), color: PAL.gold, position: [0, 0.003, 0] },
      { geometry: new CylinderGeometry(0.013, 0.013, 0.0012, 28), color: PAL.chalk, position: [0, 0.0062, 0] },
      { geometry: new TorusGeometry(0.004, 0.0015, 6, 14), color: PAL.brass, position: [0, 0.003, -0.019], rotation: [0, Math.PI / 2, 0] },
    ]),
    cupcake: merged([
      { geometry: new CylinderGeometry(0.026, 0.02, 0.026, 16), color: PAL.clothRed, position: [0, 0.013, 0] },
      { geometry: new SphereGeometry(0.027, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), color: PAL.chalk, position: [0, 0.026, 0], scale: [1, 0.8, 1] },
      { geometry: new SphereGeometry(0.007, 12, 8), color: PAL.ballRed, position: [0, 0.05, 0] },
    ]),
  };
  const propMat: Record<PropId, Material> = {
    coin: brass, ball: glossy, cupLeft: brass, cupMid: brass, cupRight: brass, watch: brass, cupcake: felt,
  };
  // Overlapping marks (and the cupcake sits on the volunteer spot): only the coin and the side cups are shown; the
  // rest keep their names and marks for the FoV checks.
  const shown: Record<PropId, boolean> = {
    coin: true, ball: false, cupLeft: true, cupMid: false, cupRight: true, watch: false, cupcake: false,
  };
  const props = {} as Record<PropId, Mesh>;
  for (const id of Object.keys(propGeo) as PropId[]) {
    const m = name(new Mesh(propGeo[id], propMat[id]), id);
    at(m, L.propMarks[id]);
    m.visible = shown[id];
    root.add(m);
    props[id] = m;
  }

  // ---------------------------------------------------------------- gadgets (3 named meshes + focus anchors)
  const gadgetParts: Record<GadgetId, { parts: Part[]; focusY: number }> = {
    musicBox: {
      parts: [
        { geometry: new BoxGeometry(0.085, 0.045, 0.06), color: PAL.wood, position: [0, 0.0225, 0] },
        { geometry: new BoxGeometry(0.089, 0.008, 0.064), color: PAL.brass, position: [0, 0.049, 0] },
        { geometry: new CylinderGeometry(0.004, 0.004, 0.03, 8), color: PAL.brass, position: [0, 0.066, 0] },
        { geometry: new ConeGeometry(0.012, 0.03, 12), color: PAL.blush, position: [0, 0.092, 0] },
        { geometry: new SphereGeometry(0.006, 10, 8), color: PAL.foxCream, position: [0, 0.112, 0] },
      ],
      focusY: 0.09,
    },
    firework: {
      parts: [
        { geometry: new CylinderGeometry(0.03, 0.036, 0.02, 16), color: PAL.woodDark, position: [0, 0.01, 0] },
        { geometry: new CylinderGeometry(0.012, 0.012, 0.08, 14), color: PAL.clothRed, position: [0, 0.06, 0] },
        { geometry: new ConeGeometry(0.016, 0.03, 14), color: PAL.gold, position: [0, 0.115, 0] },
        { geometry: new CylinderGeometry(0.0015, 0.0015, 0.02, 6), color: PAL.chalk, position: [0.012, 0.03, 0.012], rotation: [0.6, 0, -0.5] },
      ],
      focusY: 0.12,
    },
    candle: {
      parts: [
        { geometry: new CylinderGeometry(0.03, 0.034, 0.008, 16), color: PAL.brass, position: [0, 0.004, 0] },
        { geometry: new CylinderGeometry(0.016, 0.017, 0.075, 14), color: PAL.chalk, position: [0, 0.045, 0] },
        { geometry: new ConeGeometry(0.008, 0.026, 10), color: PAL.lampAmber, position: [0, 0.097, 0] },
        { geometry: new SphereGeometry(0.0065, 10, 8), color: PAL.gold, position: [0, 0.089, 0] },
      ],
      focusY: 0.095,
    },
  };
  const gadgets = {} as Fixture['gadgets'];
  for (const id of Object.keys(gadgetParts) as GadgetId[]) {
    const g = name(new Mesh(merged(gadgetParts[id].parts), id === 'candle' ? felt : wood), id);
    at(g, L.gadgets[id]);
    const focus = name(new Object3D(), `${id}-focus`);
    focus.position.set(0, gadgetParts[id].focusY, 0);
    g.add(focus);
    root.add(g);
    gadgets[id] = { root: g, focus };
  }

  // ---------------------------------------------------------------- seats, spectators (5 named meshes)
  const seats: Object3D[] = L.seats.map((p, i) => {
    const s = name(new Object3D(), `seat-${i}`);
    at(s, p);
    root.add(s);
    return s;
  });
  const cast: Array<{ id: string; kind: 'fox' | 'magpie' | 'badger'; seat: number; scale: number }> = [
    { id: 'magpie', kind: 'magpie', seat: 0, scale: 0.95 },
    { id: 'kit1', kind: 'fox', seat: 1, scale: 1 },
    { id: 'kit2', kind: 'fox', seat: 2, scale: 0.86 },
    { id: 'kit3', kind: 'fox', seat: 3, scale: 1.04 },
    { id: 'brock', kind: 'badger', seat: 4, scale: 1.12 },
  ];
  const spectators: FixtureSpectator[] = cast.map(({ id, kind, seat, scale }) => {
    const r = name(new Group(), id);
    at(r, L.seats[seat]);
    const turn = new Group();
    turn.scale.setScalar(scale);
    r.add(turn);
    const body = new Mesh(merged(puppetParts(kind)), felt);
    body.name = `${id}-body`;
    turn.add(body);
    const anchors: FixtureSpectator['anchors'] = {};
    const anchor = (a: SpectatorAnchor, x: number, y: number, z: number) => {
      const o = name(new Object3D(), `${id}-${a}`);
      o.position.set(x, y, z);
      turn.add(o);
      anchors[a] = o;
    };
    anchor('head', 0, 0.09, 0);
    anchor('eyes', 0, 0.094, 0.026);
    if (kind === 'fox') anchor('ear', 0.019, 0.128, 0);
    if (kind === 'magpie') anchor('beak', 0, 0.088, 0.04);
    if (kind === 'badger') {
      anchor('notebook', -0.03, 0.045, 0.022);
      anchor('hand', 0.028, 0.045, 0.02);
    }
    root.add(r);
    return { id, root: r, turn, anchors };
  });

  // ---------------------------------------------------------------- plaques (1 merged mesh + anchors)
  const plaqueActions: PlaqueAction[] = ['retry', 'easy', 'assist', 'exit'];
  const plaqueColors = [PAL.chalk, PAL.glintBlue, PAL.target, PAL.clothRed];
  const plaqueTilt = -0.6;
  const plaqueMesh = new Mesh(
    merged(
      L.plaques.flatMap((p, i) => [
        { geometry: new BoxGeometry(0.07, 0.006, 0.045), color: PAL.brass, position: [p[0], p[1], p[2]] as [number, number, number], rotation: [plaqueTilt, 0, 0] as [number, number, number] },
        { geometry: new BoxGeometry(0.058, 0.004, 0.034), color: plaqueColors[i], position: [p[0], p[1] + 0.003, p[2]] as [number, number, number], rotation: [plaqueTilt, 0, 0] as [number, number, number] },
      ]),
    ),
    felt,
  );
  root.add(plaqueMesh);
  const plaques: Record<string, Object3D> = {};
  L.plaques.forEach((p, i) => {
    const o = name(new Object3D(), `plaque-${plaqueActions[i]}`);
    at(o, p, 0.004);
    root.add(o);
    plaques[plaqueActions[i]] = o;
  });

  const volunteerSpot = name(new Object3D(), 'volunteerSpot');
  at(volunteerSpot, L.volunteerSpot);
  root.add(volunteerSpot);
  const burst = name(new Object3D(), 'burst');
  at(burst, L.burst);
  root.add(burst);

  root.updateMatrixWorld(true);
  return {
    root, props, gadgets, spectators, plaques, seats, mat, volunteerSpot, burst, lampPool, named,
    dispose() {
      root.removeFromParent();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      poolTex.dispose();
    },
  };
}

function cupGeometry(merged: (parts: Part[]) => BufferGeometry): BufferGeometry {
  return merged([
    { geometry: new CylinderGeometry(0.021, 0.029, 0.052, 22, 1, true), color: PAL.copper, position: [0, 0.026, 0] },
    { geometry: new CylinderGeometry(0.021, 0.021, 0.004, 22), color: PAL.copper, position: [0, 0.052, 0] },
    { geometry: new TorusGeometry(0.029, 0.0022, 6, 22), color: PAL.brass, position: [0, 0.002, 0], rotation: [Math.PI / 2, 0, 0] },
    { geometry: new SphereGeometry(0.005, 10, 8), color: PAL.brass, position: [0, 0.056, 0] },
  ]);
}

/** Felt puppet parts (feet at the origin, facing +Z = the player). */
function puppetParts(kind: 'fox' | 'magpie' | 'badger'): Part[] {
  const eye = (x: number): Part[] => [
    { geometry: new SphereGeometry(0.0085, 14, 10), color: PAL.ink, position: [x, 0.096, 0.024] },
    { geometry: new SphereGeometry(0.0026, 8, 6), color: 0xffffff, position: [x - 0.003, 0.1, 0.0318] },
  ];
  if (kind === 'magpie') {
    return [
      { geometry: new CapsuleGeometry(0.022, 0.028, 6, 14), color: PAL.magpieBlack, position: [0, 0.036, 0] },
      { geometry: new SphereGeometry(0.018, 14, 10), color: PAL.magpieWhite, position: [0, 0.034, 0.012], scale: [1, 1.2, 0.6] },
      { geometry: new SphereGeometry(0.027, 20, 14), color: PAL.magpieBlack, position: [0, 0.09, 0] },
      { geometry: new ConeGeometry(0.008, 0.026, 10), color: PAL.gold, position: [0, 0.088, 0.034], rotation: [Math.PI / 2, 0, 0] },
      { geometry: new ConeGeometry(0.014, 0.045, 10), color: PAL.magpieTeal, position: [0, 0.03, -0.03], rotation: [-1.1, 0, 0] },
      ...eye(-0.012),
      ...eye(0.012),
    ];
  }
  if (kind === 'badger') {
    return [
      { geometry: new CapsuleGeometry(0.026, 0.032, 6, 14), color: PAL.badgerGrey, position: [0, 0.04, 0] },
      { geometry: new SphereGeometry(0.03, 20, 14), color: PAL.badgerWhite, position: [0, 0.092, 0] },
      { geometry: new SphereGeometry(0.0305, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2.4), color: PAL.badgerBlack, position: [-0.012, 0.092, 0], scale: [0.45, 1, 1] },
      { geometry: new SphereGeometry(0.0305, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2.4), color: PAL.badgerBlack, position: [0.012, 0.092, 0], scale: [0.45, 1, 1] },
      { geometry: new SphereGeometry(0.009, 10, 8), color: PAL.badgerBlack, position: [0, 0.083, 0.03] },
      { geometry: new BoxGeometry(0.03, 0.038, 0.006), color: PAL.notebookRed, position: [-0.03, 0.045, 0.022], rotation: [0.2, 0.3, 0] },
      { geometry: new TorusGeometry(0.008, 0.0012, 6, 16), color: PAL.gold, position: [0.012, 0.097, 0.031] },
      ...eye(-0.012),
      ...eye(0.012),
    ];
  }
  return [
    { geometry: new CapsuleGeometry(0.022, 0.03, 6, 14), color: PAL.foxOrange, position: [0, 0.035, 0] },
    { geometry: new SphereGeometry(0.016, 14, 10), color: PAL.foxCream, position: [0, 0.034, 0.012], scale: [1, 1.2, 0.6] },
    { geometry: new SphereGeometry(0.029, 22, 16), color: PAL.foxOrange, position: [0, 0.09, 0] },
    { geometry: new SphereGeometry(0.013, 12, 8), color: PAL.foxCream, position: [0, 0.082, 0.024], scale: [1.1, 0.8, 1] },
    { geometry: new SphereGeometry(0.004, 8, 6), color: PAL.ink, position: [0, 0.084, 0.037] },
    { geometry: new ConeGeometry(0.012, 0.026, 12), color: PAL.foxOrange, position: [-0.019, 0.122, 0], rotation: [0, 0, 0.35] },
    { geometry: new ConeGeometry(0.012, 0.026, 12), color: PAL.foxOrange, position: [0.019, 0.122, 0], rotation: [0, 0, -0.35] },
    { geometry: new ConeGeometry(0.006, 0.012, 10), color: PAL.foxDark, position: [-0.022, 0.133, 0], rotation: [0, 0, 0.35] },
    { geometry: new ConeGeometry(0.006, 0.012, 10), color: PAL.foxDark, position: [0.022, 0.133, 0], rotation: [0, 0, -0.35] },
    { geometry: new ConeGeometry(0.012, 0.04, 10), color: PAL.foxOrange, position: [0, 0.022, -0.03], rotation: [-1.2, 0, 0] },
    ...eye(-0.011),
    ...eye(0.011),
  ];
}

/** Soft radial glow (white-hot centre → transparent edge), used additively. */
function radialTexture(color: number): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const r = (color >> 16) & 255;
  const gg = (color >> 8) & 255;
  const b = color & 255;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, `rgba(${r},${gg},${b},0.9)`);
  grad.addColorStop(0.45, `rgba(${r},${gg},${b},0.35)`);
  grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
