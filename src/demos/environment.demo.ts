// Environment module demo: ?demo=environment
//   full café; the props of each act cycle on their marks (Act 1 coin → Act 2 cups & ball → Act 3 watch & cupcake),
//   glints cycle, each gadget's dwell ring fills then it fires (the others dim as unavailable/used), FX bursts, cups
//   lift, the watch rises from the cupcake, and the lamp dims for a "curtain" moment before the cycle repeats.
// Params: &compact=1 compact gadget layout · &props=all every prop at once (worst-case draw calls) · &lamp=0.3 dim
//         &t0=<s> fast-forward the 30 s timeline · &freeze=1 hold at t0 · &audience=0 hide the stand-in audience
//         &posters=0 hide the placeholder posters · &debug=1 log draw calls.
import {
  BoxGeometry,
  CanvasTexture,
  CapsuleGeometry,
  ConeGeometry,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  type Object3D,
  SRGBColorSpace,
  Vector3,
  type World,
} from '@iwsdk/core';
import type { FxKind, GadgetId, Glint, PropId } from '../contracts.js';
import { mergeParts } from '../art/geometry.js';
import { feltMaterial } from '../art/matcap.js';
import { PAL } from '../art/palette.js';
import { onUpdate } from '../boot/loop.js';
import { L, StageRig } from '../layout.js';
import { environmentFactory } from '../environment/factory.js';
import type { CafeImpl } from '../environment/cafe.js';
import { atlasQuad } from '../environment/util.js';

type Ev = { t: number; run: () => void };

export default async function environmentDemo(world: World): Promise<void> {
  const q = new URLSearchParams(location.search);
  const rig = new StageRig(world);
  const { cafe: cafeI, fx } = await environmentFactory.build(world, rig);
  const cafe = cafeI as CafeImpl;
  (window as unknown as { __env: unknown }).__env = { cafe, fx, rig };

  if (q.get('compact') === '1') cafe.setCompact(true);
  if (q.get('lamp')) cafe.setLamp(Number(q.get('lamp')));
  if (q.get('audience') !== '0') addStandInAudience(cafe);
  if (q.get('posters') !== '0') addPlaceholderPosters(cafe);

  const allProps = q.get('props') === 'all';
  const ACTS: PropId[][] = [['coin'], ['cupLeft', 'cupMid', 'cupRight', 'ball'], ['watch', 'cupcake']];
  const PERIOD = 30;
  const tmp = new Vector3();
  const at = (id: PropId, dy = 0.03) => {
    cafe.props[id].root.getWorldPosition(tmp);
    tmp.y += dy;
    return tmp;
  };
  const showAct = (i: number) => {
    for (const id of Object.keys(cafe.props) as PropId[]) {
      const p = cafe.props[id];
      p.reset();
      p.setVisible(allProps || ACTS[i].includes(id));
    }
  };
  const glint = (id: PropId, g: Glint) => () => cafe.props[id].setGlint(g);
  const anim = (id: PropId, a: Parameters<CafeImpl['props']['coin']['animate']>[0]) => () => void cafe.props[id].animate(a);
  const burst = (kind: FxKind, id: PropId, dy = 0.03, scale = 1) => () => fx.burst(kind, at(id, dy), { scale });
  const dwellRamp = (g: GadgetId, t0: number, t1: number): Ev[] => {
    const evs: Ev[] = [];
    for (let k = 0; k <= 12; k++) evs.push({ t: t0 + ((t1 - t0) * k) / 12, run: () => cafe.gadgets[g].setDwell(k / 12) });
    evs.push({ t: t1 + 0.01, run: () => (cafe.gadgets[g].setDwell(0), cafe.gadgets[g].activate()) });
    return evs;
  };

  const events: Ev[] = [
    // Act 1 — the vanishing coin
    { t: 0, run: () => (showAct(0), resetGadgets(), cafe.setLamp(1), avail(['musicBox'])) },
    { t: 0.3, run: glint('coin', 'gold') },
    { t: 2.4, run: anim('coin', 'lift') },
    { t: 3.4, run: anim('coin', 'lower') },
    { t: 4.0, run: glint('coin', 'blue') },
    ...dwellRamp('musicBox', 4.2, 5.0),
    { t: 6.2, run: anim('coin', 'vanish') },
    { t: 6.3, run: burst('sparks', 'coin', 0.01, 0.6) },
    { t: 8.0, run: () => (cafe.props.coin.setGlint('none'), void cafe.props.coin.animate('appear')) },
    { t: 8.0, run: burst('poof', 'coin', 0.02) },
    { t: 8.4, run: burst('stars', 'coin', 0.05) },
    { t: 8.6, run: () => cafe.gadgets.musicBox.setUsed(true) },
    { t: 9.0, run: anim('coin', 'wobble') },
    // Act 2 — cups & ball
    { t: 10, run: () => (showAct(1), avail(['candle'])) },
    { t: 10.2, run: glint('ball', 'gold') },
    ...dwellRamp('candle', 11.0, 11.8),
    { t: 12.2, run: glint('ball', 'blue') },
    { t: 13.0, run: () => (glint('ball', 'none')(), glint('cupRight', 'target')()) },
    { t: 13.6, run: anim('cupLeft', 'wobble') },
    { t: 13.8, run: anim('cupMid', 'wobble') },
    { t: 14.0, run: anim('cupRight', 'wobble') },
    { t: 14.6, run: () => (cafe.props.ball.root.position.copy(cafe.props.cupRight.home), glint('cupRight', 'none')()) },
    { t: 15.0, run: anim('cupMid', 'lift') },
    { t: 16.2, run: anim('cupMid', 'lower') },
    { t: 16.8, run: anim('cupRight', 'lift') },
    { t: 17.0, run: burst('poof', 'cupRight', 0.02, 0.8) },
    { t: 17.4, run: burst('confetti', 'cupMid', 0.04) },
    { t: 18.6, run: burst('catchFlash', 'cupLeft', 0.05) },
    { t: 19.2, run: anim('cupRight', 'lower') },
    // Act 3 — the critic's watch
    { t: 20, run: () => (showAct(2), cafe.gadgets.candle.setUsed(true), avail(['firework'])) },
    { t: 20.2, run: glint('watch', 'gold') },
    ...dwellRamp('firework', 20.6, 21.4),
    { t: 22.0, run: () => (glint('watch', 'blue')(), glint('cupcake', 'target')()) },
    { t: 25.2, run: () => (glint('watch', 'none')(), glint('cupcake', 'none')(), void cafe.props.watch.animate('vanish')) },
    { t: 26.0, run: anim('cupcake', 'lift') },
    { t: 26.6, run: anim('watch', 'rise') },
    { t: 27.2, run: burst('stars', 'cupcake', 0.12) },
    { t: 27.6, run: burst('roses', 'cupcake', 0.06) },
    { t: 27.9, run: burst('confetti', 'cupcake', 0.08) },
    ...[27.8, 28.8].map((t) => ({ t, run: () => fx.burst('tick', at('cupcake', 0.12), { scale: 0.8 }) })),
    // curtain moment: the lamp dims between cycles
    { t: 29.2, run: () => cafe.setLamp(0.25) },
  ];
  events.sort((a, b) => a.t - b.t);

  /** Only the listed gadgets are available this act (others dim; the candle goes out). */
  function avail(ids: GadgetId[]) {
    for (const id of Object.keys(cafe.gadgets) as GadgetId[]) cafe.gadgets[id].setAvailable(ids.includes(id));
  }

  function resetGadgets() {
    for (const g of Object.values(cafe.gadgets)) {
      g.reset();
      g.setAvailable(true);
    }
  }

  let t = 0;
  let cursor = 0;
  let cycleStart = 0;
  const advance = (dt: number) => {
    t += dt;
    if (t - cycleStart >= PERIOD) {
      cycleStart += PERIOD;
      cursor = 0;
    }
    const local = t - cycleStart;
    while (cursor < events.length && events[cursor].t <= local) {
      try {
        events[cursor].run();
      } catch (e) {
        console.error('[environment demo] event failed', e);
      }
      cursor++;
    }
  };

  // fast-forward to t0 (no rendering needed: everything is driven by update)
  const t0 = Math.max(0, Number(q.get('t0') ?? 0));
  const freeze = q.get('freeze') === '1';
  let fakeTime = 0;
  const STEP = 1 / 60;
  advance(0);
  for (let s = 0; s < t0; s += STEP) {
    advance(STEP);
    fakeTime += STEP;
    cafe.update(STEP, fakeTime);
    fx.update(STEP, fakeTime);
  }

  let last = 0;
  onUpdate(world, (dt, time) => {
    const d = freeze ? 0 : dt;
    advance(d);
    cafe.update(d, time + fakeTime);
    fx.update(d, time + fakeTime);
    if (q.get('debug') === '1' && time - last > 1) {
      last = time;
      const info = world.renderer.info.render;
      console.warn(`[environment demo] t=${t.toFixed(1)} renderer calls=${info.calls} tris=${info.triangles} | env draws=${countDraws(cafe.root, rig.root)}`);
    }
  });
}

/** Visible environment meshes under the rig (each = one draw call per view; instanced batches count once). */
function countDraws(cafeRoot: Object3D, rigRoot: Object3D): string {
  let env = 0;
  let demo = 0;
  const walk = (o: Object3D) => {
    if (!o.visible) return;
    const m = o as Mesh;
    if (m.isMesh) {
      if (o.name.startsWith('demo-')) demo++;
      else env++;
    }
    for (const c of o.children) walk(c);
  };
  for (const c of rigRoot.children) if (c === cafeRoot || c.name.startsWith('env-')) walk(c);
  return `${env} (+${demo} demo placeholders)`;
}

/** Demo-only felt stand-ins on the seats (the real audience comes from the spectators module). */
function addStandInAudience(cafe: CafeImpl): void {
  const cols = [PAL.foxOrange, PAL.foxOrange, PAL.magpieBlack, PAL.foxOrange, PAL.badgerGrey];
  const parts = cafe.seats.flatMap((seat, i) => {
    const p = seat.position;
    const s = i === 2 ? 1.0 : 0.92;
    const c = cols[i];
    return [
      { geometry: new CapsuleGeometry(0.02 * s, 0.03 * s, 6, 14), color: c, position: [p.x, p.y + 0.036 * s, p.z] as [number, number, number] },
      { geometry: new SphereGeometry(0.027 * s, 20, 14), color: c, position: [p.x, p.y + 0.092 * s, p.z] as [number, number, number] },
      { geometry: new SphereGeometry(0.009 * s, 12, 8), color: 0xffffff, position: [p.x - 0.01 * s, p.y + 0.096 * s, p.z + 0.022 * s] as [number, number, number] },
      { geometry: new SphereGeometry(0.009 * s, 12, 8), color: 0xffffff, position: [p.x + 0.01 * s, p.y + 0.096 * s, p.z + 0.022 * s] as [number, number, number] },
      { geometry: new SphereGeometry(0.0045 * s, 10, 8), color: 0x111111, position: [p.x - 0.01 * s, p.y + 0.096 * s, p.z + 0.029 * s] as [number, number, number] },
      { geometry: new SphereGeometry(0.0045 * s, 10, 8), color: 0x111111, position: [p.x + 0.01 * s, p.y + 0.096 * s, p.z + 0.029 * s] as [number, number, number] },
      { geometry: new ConeGeometry(0.01 * s, 0.024 * s, 10), color: c, position: [p.x - 0.016 * s, p.y + 0.122 * s, p.z] as [number, number, number], rotation: [0, 0, 0.35] as [number, number, number] },
      { geometry: new ConeGeometry(0.01 * s, 0.024 * s, 10), color: c, position: [p.x + 0.016 * s, p.y + 0.122 * s, p.z] as [number, number, number], rotation: [0, 0, -0.35] as [number, number, number] },
    ];
  });
  const m = new Mesh(mergeParts(parts), feltMaterial());
  m.name = 'demo-standInAudience';
  cafe.root.add(m);
}

/** Demo-only poster placeholders on the café's poster wall (the UI module owns real posters). */
function addPlaceholderPosters(cafe: CafeImpl): void {
  const c = document.createElement('canvas');
  c.width = 768;
  c.height = 512;
  const g = c.getContext('2d')!;
  const posters: Array<[string, string, string]> = [
    ['#efe1c2', '#9b1d24', 'The Vanishing Coin'],
    ['#e6dcc6', '#1f4d6e', 'Cups & Ball'],
    ['#f0dcc0', '#6a2a14', "The Critic's Watch"],
  ];
  posters.forEach(([bg, fg, title], i) => {
    const x = i * 256;
    g.fillStyle = bg;
    g.fillRect(x, 0, 256, 512);
    g.strokeStyle = fg;
    g.lineWidth = 8;
    g.strokeRect(x + 12, 12, 232, 488);
    g.lineWidth = 2;
    g.strokeRect(x + 24, 24, 208, 464);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.font = 'bold 34px Georgia, serif';
    g.fillText('SLEIGHT', x + 128, 78);
    g.fillText('OF EYE', x + 128, 116);
    g.beginPath();
    g.arc(x + 128, 250, 74, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = bg;
    g.font = 'bold 64px Georgia, serif';
    g.fillText(['✦', '◉', '◷'][i], x + 128, 272);
    g.fillStyle = fg;
    g.font = 'italic bold 25px Georgia, serif';
    g.fillText(title, x + 128, 380);
    g.font = '30px Georgia, serif';
    g.fillText('★ ★ ★', x + 128, 440);
  });
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const w = 0.24;
  const h = 0.36;
  const parts = [-0.33, 0, 0.33].flatMap((x, i) => [
    { geometry: atlasQuad(w, h, [i / 3, 0, (i + 1) / 3, 1]), color: 0xffffff, position: [x, 0, 0.0065] as [number, number, number] },
  ]);
  const mesh = new Mesh(mergeParts(parts, { keepUv: true }), new MeshBasicMaterial({ map: tex, vertexColors: true }));
  mesh.name = 'demo-placeholderPosters';
  const frames = new Mesh(
    mergeParts([-0.33, 0, 0.33].map((x) => ({ geometry: new BoxGeometry(w + 0.024, h + 0.024, 0.008), color: 0x3a2416, position: [x, 0, 0] as [number, number, number] }))),
    new MeshBasicMaterial({ vertexColors: true }),
  );
  frames.name = 'demo-posterFrames';
  cafe.posterWall.add(frames, mesh);
  void L;
}
