// UI module demo: every in-XR UI element over a stand-in café table, plus the 2D landing page.  ?demo=ui
//   &show=cycle (default: a 26 s loop through spotlight, captions, hints, plaque hover/press, banner, curtain,
//          title card, rewind smear, review) | all (everything that can share the stage at once) | captions |
//          hints | plaques | banner | curtain | review | posters | none (plaques + posters + spotlight only)
//   &landing=1        mount + show the landing page overlay (add &xr=0 for the "open in Quest" notice); XR-only UI
//                     (plaques, hints, banner, spotlight, captions, title card, rewind) hides in 2D as in the game
//                     (&hide2d=1 forces that alone)
//   &hands=1          poke plaques with real (emulated) fingertips
//   &baseline=1       stand-in scene only (no UI) — for draw-call accounting
// window.__uiDemo.trigger('title' | 'curtain-close' | 'curtain-open' | 'rewind' | 'review' | 'banner' |
//   'banner-off' | 'captions' | 'hints' | 'hints-off' | 'poke-easy' | 'hover-assist') drives timed screenshots.
import {
  BoxGeometry,
  CanvasTexture,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  RepeatWrapping,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  signal,
  type World,
} from '@iwsdk/core';
import { mergeParts, tint, type Part } from '../art/geometry.js';
import { feltMaterial, matcapMaterial } from '../art/matcap.js';
import { PAL } from '../art/palette.js';
import { onUpdate } from '../boot/loop.js';
import {
  DEFAULT_SETTINGS,
  type GameEvents,
  type GazeTarget,
  type GazeTargetRegistry,
  type Hint,
  type PlaqueAction,
  type PokeRegistry,
  type PokeTarget,
  type Settings,
  type Side,
} from '../contracts.js';
import { Emitter } from '../events.js';
import { L, StageRig } from '../layout.js';
import { GameUI, uiFactory } from '../ui/factory.js';
import { landing } from '../ui/landing.js';

// ------------------------------------------------------------------------------------ stub registries
const SIDES: readonly Side[] = ['left', 'right'];

interface PokeState {
  t: PokeTarget;
  hover: Record<Side, boolean>;
  inside: Record<Side, boolean>;
}

class DemoPokes implements PokeRegistry {
  readonly targets: PokeState[] = [];
  private readonly tip = new Vector3();
  private readonly pos = new Vector3();

  add(t: PokeTarget): () => void {
    const st: PokeState = { t, hover: { left: false, right: false }, inside: { left: false, right: false } };
    this.targets.push(st);
    return () => {
      const i = this.targets.indexOf(st);
      if (i >= 0) this.targets.splice(i, 1);
    };
  }

  /** Fingertip proximity (only with &hands=1): hover inside radius + 2 cm, poke on entering the radius. */
  update(world: World): void {
    for (let s = 0; s < SIDES.length; s++) {
      const side = SIDES[s];
      const space = world.player?.indexTipSpaces?.[side];
      if (!space) continue;
      space.getWorldPosition(this.tip);
      for (let i = 0; i < this.targets.length; i++) {
        const st = this.targets[i];
        if (!st.t.enabled()) continue;
        const d = this.tip.distanceTo(st.t.getWorldPosition(this.pos));
        const hov = d < st.t.radius + 0.02;
        if (hov !== st.hover[side]) {
          st.hover[side] = hov;
          st.t.onHover?.(hov, side);
        }
        if (!st.inside[side] && d < st.t.radius) {
          st.inside[side] = true;
          st.t.onPoke(side);
        } else if (st.inside[side] && d > st.t.radius + 0.012) st.inside[side] = false;
      }
    }
  }
}

class DemoGaze implements GazeTargetRegistry {
  readonly targets: GazeTarget[] = [];
  add(t: GazeTarget): () => void {
    this.targets.push(t);
    return () => {
      const i = this.targets.indexOf(t);
      if (i >= 0) this.targets.splice(i, 1);
    };
  }
}

// ---------------------------------------------------------------------------------- stand-in café set
function gingham(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#efe2c8';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = 'rgba(168,50,45,0.5)';
  for (let i = 0; i < 8; i += 2) {
    g.fillRect(i * 32, 0, 32, 256);
    g.fillRect(0, i * 32, 256, 32);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(7, 5.5);
  t.anisotropy = 8;
  return t;
}

interface DemoSet {
  anchors: Record<string, Object3D>;
  props: Record<string, Object3D>;
  focus: Record<string, Object3D>;
}

function buildSet(rig: StageRig): DemoSet {
  const root = new Group();
  root.name = 'ui-demo-set';
  rig.root.add(root);
  const y = L.tableY;
  // table + cloth
  const clothMat = matcapMaterial('wood', { vertexColors: false });
  clothMat.map = gingham();
  const table = new Mesh(new BoxGeometry(L.table.width, 0.03, L.table.depth), clothMat);
  table.position.set(0, y - 0.015, L.table.centerZ);
  root.add(table);
  // mat with a brass edge (one mesh)
  const [mx, my, mz] = L.mat.center;
  const mat = new Mesh(
    mergeParts([
      { geometry: new BoxGeometry(L.mat.size[0] + 0.012, 0.004, L.mat.size[1] + 0.012), color: PAL.brass, position: [mx, y + 0.001, mz] },
      { geometry: new BoxGeometry(L.mat.size[0], 0.006, L.mat.size[1]), color: PAL.velvet, position: [mx, my - 0.001, mz] },
    ]),
    matcapMaterial('velvet'),
  );
  mat.name = 'mat';
  root.add(mat);
  // riser + shelf + poster wall (wood)
  const woodParts: Part[] = [
    { geometry: new BoxGeometry(L.riser.width + 0.04, 0.04, L.riser.depth), color: PAL.woodDark, position: [0, y + 0.02, L.riser.z] },
    { geometry: new BoxGeometry(0.98, 0.12, 0.1), color: PAL.wood, position: [0, y + 0.06, L.shelf.z - 0.01] },
    { geometry: new BoxGeometry(2.6, 1.6, 0.04), color: 0x2a1c30, position: [0, L.posterWall.centerY, L.posterWall.z - 0.03] },
    { geometry: new BoxGeometry(2.6, 0.05, 0.06), color: PAL.woodDark, position: [0, L.posterWall.centerY - 0.5, L.posterWall.z - 0.01] },
  ];
  root.add(new Mesh(mergeParts(woodParts), matcapMaterial('wood')));

  // the audience: five felt puppets in one mesh + glossy button eyes in another
  const felt: Part[] = [];
  const eyes: Part[] = [];
  const anchors: Record<string, Object3D> = {};
  const cast: Array<{ id: string; body: number; belly: number; head: number; ear: number; kind: 'fox' | 'magpie' | 'badger' }> = [
    { id: 'kit1', body: PAL.foxOrange, belly: PAL.foxCream, head: PAL.foxOrange, ear: PAL.foxDark, kind: 'fox' },
    { id: 'kit2', body: PAL.foxOrange, belly: PAL.foxCream, head: PAL.foxOrange, ear: PAL.foxDark, kind: 'fox' },
    { id: 'magpie', body: PAL.magpieBlack, belly: PAL.magpieWhite, head: PAL.magpieBlack, ear: PAL.magpieTeal, kind: 'magpie' },
    { id: 'kit3', body: PAL.foxOrange, belly: PAL.foxCream, head: PAL.foxOrange, ear: PAL.foxDark, kind: 'fox' },
    { id: 'brock', body: PAL.badgerGrey, belly: PAL.badgerWhite, head: PAL.badgerGrey, ear: PAL.badgerBlack, kind: 'badger' },
  ];
  cast.forEach((c, i) => {
    const [sx, sy, sz] = L.seats[i];
    const s = c.kind === 'badger' ? 1.15 : c.id === 'kit2' ? 0.85 : 1;
    const hy = sy + 0.095 * s;
    felt.push({ geometry: new CapsuleGeometry(0.024 * s, 0.03 * s, 6, 16), color: c.body, position: [sx, sy + 0.04 * s, sz] });
    felt.push({ geometry: new SphereGeometry(0.018 * s, 16, 12), color: c.belly, position: [sx, sy + 0.04 * s, sz + 0.012 * s], scale: [1, 1.2, 0.8] });
    felt.push({ geometry: new SphereGeometry(0.031 * s, 24, 16), color: c.head, position: [sx, hy, sz] });
    if (c.kind === 'fox') {
      felt.push({ geometry: new SphereGeometry(0.016 * s, 16, 10), color: c.belly, position: [sx, hy - 0.01 * s, sz + 0.024 * s], scale: [1.2, 0.8, 1] });
      for (const e of [-1, 1]) felt.push({ geometry: new ConeGeometry(0.012 * s, 0.03 * s, 12), color: c.ear, position: [sx + e * 0.018 * s, hy + 0.032 * s, sz], rotation: [0, 0, -e * 0.35] });
    } else if (c.kind === 'magpie') {
      felt.push({ geometry: new ConeGeometry(0.007, 0.024, 10), color: 0x2b2b30, position: [sx, hy - 0.004, sz + 0.036], rotation: [Math.PI / 2, 0, 0] });
      felt.push({ geometry: new SphereGeometry(0.014, 12, 8), color: PAL.magpieTeal, position: [sx + 0.022, sy + 0.05, sz], scale: [0.5, 1.4, 1] });
    } else {
      felt.push({ geometry: new SphereGeometry(0.012, 12, 8), color: PAL.badgerWhite, position: [sx, hy + 0.012, sz + 0.022], scale: [0.8, 1.8, 0.6] });
      felt.push({ geometry: new BoxGeometry(0.026, 0.034, 0.006), color: PAL.notebookRed, position: [sx - 0.026, sy + 0.045, sz + 0.02], rotation: [0, 0.4, 0] });
    }
    for (const e of [-1, 1]) {
      eyes.push({ geometry: new SphereGeometry(0.0085 * s, 14, 10), color: 0x15110e, position: [sx + e * 0.012 * s, hy + 0.004 * s, sz + 0.026 * s] });
    }
    const g = new Group();
    g.name = c.id;
    g.position.set(sx, sy, sz);
    root.add(g);
    for (const [name, p] of [
      ['head', [0, hy - sy, 0]],
      ['hatTop', [0, hy - sy + 0.04 * s, 0]],
      ['ear', [0.018 * s, hy - sy + 0.035 * s, 0]],
      ['eyes', [0, hy - sy + 0.004 * s, 0.026 * s]],
    ] as Array<[string, [number, number, number]]>) {
      const a = new Object3D();
      a.name = `${c.id}-${name}`;
      a.position.set(...p);
      g.add(a);
      anchors[`${c.id}-${name}`] = a;
    }
    const seat = new Object3D();
    seat.name = `seat-${i}`;
    seat.position.set(sx, sy, sz);
    root.add(seat);
  });
  root.add(new Mesh(mergeParts(felt), feltMaterial()));
  root.add(new Mesh(mergeParts(eyes), matcapMaterial('glossy')));

  // props + gadgets (brass/copper/cream, one mesh) + candle flame
  const props: Record<string, Object3D> = {};
  const focus: Record<string, Object3D> = {};
  const metal: Part[] = [];
  const mark = (name: string, p: readonly [number, number, number], into: Record<string, Object3D>, dy = 0) => {
    const o = new Object3D();
    o.name = name;
    o.position.set(p[0], p[1] + dy, p[2]);
    root.add(o);
    into[name] = o;
    return o;
  };
  const coin = L.propMarks.coin;
  metal.push({ geometry: new CylinderGeometry(0.014, 0.014, 0.003, 28), color: PAL.gold, position: [coin[0], coin[1] + 0.0015, coin[2]] });
  mark('coin', coin, props, 0.003);
  for (const id of ['cupLeft', 'cupRight'] as const) {
    const p = L.propMarks[id];
    metal.push({ geometry: new CylinderGeometry(0.019, 0.026, 0.05, 24), color: PAL.copper, position: [p[0], p[1] + 0.025, p[2]] });
    metal.push({ geometry: new CylinderGeometry(0.01, 0.019, 0.006, 20), color: PAL.copper, position: [p[0], p[1] + 0.053, p[2]] });
    mark(id, p, props, 0.03);
  }
  const ck = L.propMarks.cupcake;
  metal.push({ geometry: new BoxGeometry(0.05, 0.035, 0.05), color: 0xf1c6d4, position: [ck[0], ck[1] + 0.0175, ck[2]] });
  metal.push({ geometry: new SphereGeometry(0.02, 16, 10), color: 0xfff4f0, position: [ck[0], ck[1] + 0.04, ck[2]], scale: [1.1, 0.7, 1.1] });
  mark('cupcake', ck, props, 0.03);
  const mb = L.gadgets.musicBox;
  metal.push({ geometry: new BoxGeometry(0.08, 0.045, 0.06), color: PAL.brass, position: [mb[0], mb[1] + 0.0225, mb[2]] });
  metal.push({ geometry: new BoxGeometry(0.082, 0.008, 0.062), color: PAL.copper, position: [mb[0], mb[1] + 0.049, mb[2]] });
  metal.push({ geometry: new ConeGeometry(0.012, 0.03, 12), color: 0xff9fb6, position: [mb[0], mb[1] + 0.068, mb[2]] });
  mark('musicBox', mb, props);
  mark('musicBox-focus', mb, focus, 0.07);
  const cd = L.gadgets.candle;
  metal.push({ geometry: new CylinderGeometry(0.03, 0.034, 0.008, 20), color: PAL.brass, position: [cd[0], cd[1] + 0.004, cd[2]] });
  metal.push({ geometry: new CylinderGeometry(0.012, 0.012, 0.07, 16), color: PAL.chalk, position: [cd[0], cd[1] + 0.043, cd[2]] });
  mark('candle', cd, props);
  mark('candle-focus', cd, focus, 0.095);
  const fw = L.gadgets.firework;
  metal.push({ geometry: new CylinderGeometry(0.004, 0.004, 0.09, 8), color: PAL.woodDark, position: [fw[0], fw[1] - 0.02, fw[2]] });
  metal.push({ geometry: new CylinderGeometry(0.014, 0.014, 0.06, 16), color: PAL.clothRed, position: [fw[0], fw[1] + 0.05, fw[2]] });
  metal.push({ geometry: new ConeGeometry(0.016, 0.03, 16), color: PAL.gold, position: [fw[0], fw[1] + 0.095, fw[2]] });
  mark('firework', fw, props);
  mark('firework-focus', fw, focus, 0.1);
  root.add(new Mesh(mergeParts(metal), matcapMaterial('brass')));
  const flame = new Mesh(tint(new SphereGeometry(0.009, 12, 10), 0xffc061), new MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
  flame.scale.set(1, 1.8, 1);
  flame.position.set(cd[0], cd[1] + 0.09, cd[2]);
  root.add(flame);
  const spot = new Object3D();
  spot.name = 'volunteerSpot';
  spot.position.set(...L.volunteerSpot);
  root.add(spot);
  return { anchors, props, focus };
}

// ---------------------------------------------------------------------------------------------- demo
export default async function uiDemo(world: World): Promise<void> {
  const params = new URLSearchParams(location.search);
  const show = params.get('show') ?? 'cycle';
  const rig = new StageRig(world);
  const set = buildSet(rig);

  const settings = signal<Settings>({ ...DEFAULT_SETTINGS });
  if (params.get('landing') === '1') {
    landing.mount({
      onEnter: () => console.info('[ui.demo] Enter the café clicked (the game would launch XR here)'),
      settings,
      xrSupported: params.get('xr') !== '0',
    });
    landing.setVisible(true);
    settings.subscribe((s) => console.info('[ui.demo] settings', JSON.stringify(s)));
  }
  if (params.get('baseline') === '1') return;

  const events = new Emitter<GameEvents>();
  const pokes = new DemoPokes();
  const gazeTargets = new DemoGaze();
  const ui = (await uiFactory.build(world, rig, { pokes, gazeTargets, events, cafe: null })) as GameUI;
  // the game hides XR-only UI (plaques, hints, banner, spotlight, captions, title card, rewind) behind the 2D landing
  // page; the demo shows it in a plain browser too, unless it previews the landing page (&landing=1) — or &hide2d=1
  // forces the game behaviour
  ui.autoHide2D = params.get('landing') === '1' || params.get('hide2d') === '1';

  const actions: PlaqueAction[] = ['retry', 'easy', 'assist', 'recenter', 'exit'];
  const toggles = { easy: false, assist: false };
  events.on('plaque', ({ action }) => {
    console.info('[ui.demo] plaque', action);
    if (action === 'easy' || action === 'assist') {
      toggles[action] = !toggles[action];
      ui.setPlaques(actions, toggles);
    }
  });

  // spotlight path + gaze source
  const spotWorld = new Vector3();
  const spotLocal = new Vector3();
  let spotOn = true;
  const gazePoint = () => spotWorld;
  const posters = [
    { title: 'The Vanishing Coin', date: '29 Oct 2026', stars: 3 },
    { title: 'Cups & Ball', date: '30 Oct 2026', stars: 2 },
    { title: "The Critic's Watch", date: '31 Oct 2026', stars: 3 },
  ];
  const review = {
    headline: 'Magician fools entire felt audience',
    stars: [3, 2, 3],
    quote: 'I watched his hands the whole time. I have no idea how he did it.',
  };

  let hints: Hint[] = [];
  const startHints = () => {
    hints.forEach((h) => h.stop());
    hints = [
      ui.hintPinch(set.props.coin, 'right'),
      ui.hintPoke(set.props.cupLeft, 'left'),
      ui.hintGaze(gazePoint, set.focus['musicBox-focus']),
    ];
  };
  const stopHints = () => {
    hints.forEach((h) => h.stop());
    hints = [];
  };
  const captionsAll = (seconds: number) => {
    ui.caption('Ooh!', set.anchors['kit1-head'], { seconds });
    ui.caption('I SAW THAT!', set.anchors['magpie-head'], { seconds, style: 'shout' });
    ui.caption('Make THIS disappear.', set.anchors['brock-head'], { seconds, style: 'whisper' });
  };

  const api = {
    ui,
    set,
    trigger(what: string) {
      switch (what) {
        case 'title':
          return ui.titleCard('The Vanishing Coin', 'Act I');
        case 'curtain-close':
          return ui.curtain('closed');
        case 'curtain-open':
          return ui.curtain('open');
        case 'rewind':
          return ui.rewindSmear();
        case 'review':
          return ui.review(review);
        case 'banner':
          return ui.banner('Hold it!');
        case 'banner-off':
          return ui.banner(null);
        case 'captions':
          return captionsAll(30);
        case 'hints':
          return startHints();
        case 'hints-off':
          return stopHints();
        case 'poke-easy':
          return ui.simulatePlaque('easy', 'poke');
        case 'hover-assist':
          return ui.simulatePlaque('assist', 'hover');
      }
    },
  };
  (window as unknown as { __uiDemo: typeof api }).__uiDemo = api;

  // ---- initial state per mode
  ui.setPlaques(actions, toggles);
  ui.posters(posters);
  if (show === 'all' || show === 'captions') captionsAll(1e4);
  if (show === 'all' || show === 'hints') startHints();
  if (show === 'all' || show === 'plaques') {
    toggles.easy = true;
    ui.setPlaques(actions, toggles);
    ui.simulatePlaque('assist', 'hover');
  }
  if (show === 'all' || show === 'banner') ui.banner('Hold it!');
  if (show === 'curtain') void ui.curtain('closed');
  if (show === 'review') {
    spotOn = false;
    ui.review(review);
  }
  if (show === 'posters') ui.posters([...posters, { title: 'Tonight’s Audience', date: '1 Nov 2026', stars: 2 }]);

  // ---- the cycling timeline (default)
  const CYCLE = 26;
  let clock = 0;
  let lastPhase = -1;
  const cues: Array<[number, () => void]> = [
    [0.2, () => ui.caption('Ooh!', set.anchors['kit1-head'], { seconds: 2.2 })],
    [0.6, startHints],
    [2.2, () => ui.caption('I SAW THAT!', set.anchors['magpie-head'], { style: 'shout', seconds: 1.8 })],
    [3.8, () => ui.caption('Make THIS disappear.', set.anchors['brock-head'], { style: 'whisper', seconds: 3 })],
    [4.5, () => ui.simulatePlaque('easy', 'hover')],
    [5.3, () => ui.simulatePlaque('easy', 'poke')],
    [6.0, () => ui.simulatePlaque('easy', 'unhover')],
    [7.0, () => ui.caption('Gasp!', set.anchors['kit3-head'], { seconds: 1.5 })],
    [9.0, stopHints],
    [9.2, () => ui.banner('Hold it!')],
    [11.5, () => ui.banner(null)],
    [12.0, () => void ui.curtain('closed')],
    [13.3, () => void ui.titleCard('Cups & Ball', 'Act II')],
    [16.6, () => void ui.curtain('open')],
    [18.2, () => void ui.rewindSmear()],
    [19.0, () => {
      spotOn = false;
      ui.review(review);
    }],
    [25.0, () => {
      ui.hideReview();
      spotOn = true;
      toggles.easy = false;
      ui.setPlaques(actions, toggles);
    }],
  ];

  onUpdate(world, (dt, time) => {
    // the "gaze" wanders over the mat in a lazy figure eight
    spotLocal.set(0.11 * Math.sin(time * 0.55), L.tableY, L.mat.center[2] + 0.06 * Math.sin(time * 1.1));
    rig.toWorld(spotLocal, spotWorld);
    ui.spotlight(spotOn ? spotWorld : null, 1);
    if (params.get('hands') === '1') pokes.update(world);
    if (show === 'cycle') {
      clock += dt;
      const t = clock % CYCLE;
      if (t < lastPhase) lastPhase = -1;
      for (let i = 0; i < cues.length; i++) if (cues[i][0] > lastPhase && cues[i][0] <= t) cues[i][1]();
      lastPhase = t;
    }
    ui.update(dt, time);
  });
}
