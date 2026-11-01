// Audio module demo (owned by A).  http://127.0.0.1:<port>/?demo=audio
//
//   click / Enter      unlock audio + a guided tour of EVERY sound, each played from its place on the stage
//                      (pucks pulse, the board shows what is playing, console.log per step). Entering XR also
//                      starts it.
//   &autoplay=1        start the tour without a gesture (headless QA; a browser may keep audio suspended). At the
//                      end ONE console.warn line "[audio-tour] {json}" reports the master-meter peak of every step.
//   &fast=1 / &fast=2  shorter tour (0.45x / 0.25x pacing, QA)
//   &render=1          OFFLINE VERIFICATION: every sound + music excerpts are rendered through an
//                      OfflineAudioContext running the same synth graph (src/audio/offline.ts) and measured.
//                      Results: DOM <pre id="audio-report">, document.title, the in-world report board, and ONE
//                      console.warn line "[audio-report] {json}" — tests/shot.mjs prints console warnings in its
//                      JSON output, so `node tests/shot.mjs --url=...?demo=audio&render=1 --wait=20000` captures
//                      both the numbers and a screenshot of the report.
//   &ui=0              hide the DOM panel (clean screenshots)
import {
  BoxGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type World,
} from '@iwsdk/core';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mergeParts } from '../art/geometry.js';
import { feltMaterial, matcapMaterial } from '../art/matcap.js';
import { PAL } from '../art/palette.js';
import { audioDebug, createAudioEngine, type AudioMeter } from '../audio/engine.js';
import { renderAudioReport, type AudioReportEntry } from '../audio/offline.js';
import { onUpdate } from '../boot/loop.js';
import type { CrowdKind, Mood, SfxName, SpectatorKind } from '../contracts.js';
import { L, StageRig, type V3 } from '../layout.js';

// ------------------------------------------------------------------------------------------- stations

interface Station {
  id: string;
  label: string;
  pos: V3; // rig-local
  color: number;
  r: number;
}

const Y_MAT = L.tableY + 0.017;
const Y_SEAT = L.tableY + 0.085;
const STATIONS: Station[] = [
  // sleight foley on the close-up mat
  { id: 'tink', label: 'tink', pos: [-0.12, Y_MAT, -0.46], color: PAL.gold, r: 0.011 },
  { id: 'fwip', label: 'fwip', pos: [-0.04, Y_MAT, -0.46], color: PAL.gold, r: 0.011 },
  { id: 'shh', label: 'shh', pos: [0.04, Y_MAT, -0.46], color: PAL.gold, r: 0.011 },
  { id: 'poof', label: 'poof', pos: [0.12, Y_MAT, -0.46], color: PAL.gold, r: 0.011 },
  { id: 'cupLift', label: 'cupLift', pos: [-0.12, Y_MAT, -0.36], color: PAL.copper, r: 0.011 },
  { id: 'cupThunk', label: 'cupThunk', pos: [-0.04, Y_MAT, -0.36], color: PAL.copper, r: 0.011 },
  { id: 'tick', label: 'tick', pos: [0.04, Y_MAT, -0.36], color: PAL.brass, r: 0.011 },
  { id: 'hop', label: 'hop', pos: [0.12, Y_MAT, -0.36], color: PAL.foxCream, r: 0.011 },
  // plaques
  { id: 'uiHover', label: 'uiHover', pos: [-0.16, L.tableY + 0.012, -0.26], color: PAL.chalk, r: 0.009 },
  { id: 'uiPress', label: 'uiPress', pos: [0.16, L.tableY + 0.012, -0.26], color: PAL.chalk, r: 0.009 },
  // the audience on the riser (voices)
  { id: 'kit1', label: 'fox', pos: [-0.18, Y_SEAT, -0.66], color: PAL.foxOrange, r: 0.016 },
  { id: 'kit2', label: 'fox', pos: [-0.09, Y_SEAT, -0.66], color: PAL.foxOrange, r: 0.016 },
  { id: 'magpie', label: 'magpie', pos: [0, Y_SEAT, -0.66], color: PAL.magpieTeal, r: 0.016 },
  { id: 'brock', label: 'Sir Brock', pos: [0.09, Y_SEAT, -0.66], color: PAL.badgerGrey, r: 0.016 },
  { id: 'rabbit', label: 'rabbit', pos: [0.18, Y_SEAT, -0.66], color: PAL.rabbitWhite, r: 0.016 },
  { id: 'scribble', label: 'scribble', pos: [0.135, L.tableY + 0.048, -0.61], color: PAL.notebookRed, r: 0.008 },
  { id: 'crowd', label: 'crowd', pos: [0, L.tableY + 0.142, -0.72], color: PAL.blush, r: 0.013 },
  // gadgets on the shelf
  { id: 'musicBox', label: 'music box', pos: [L.gadgets.musicBox[0], L.gadgets.musicBox[1] + 0.035, L.gadgets.musicBox[2]], color: PAL.brass, r: 0.016 },
  { id: 'fuse', label: 'fuse', pos: [L.gadgets.firework[0], L.gadgets.firework[1] + 0.03, L.gadgets.firework[2]], color: PAL.ballRed, r: 0.014 },
  { id: 'candle', label: 'flare', pos: [L.gadgets.candle[0], L.gadgets.candle[1] + 0.035, L.gadgets.candle[2]], color: PAL.lampAmber, r: 0.016 },
  { id: 'bang', label: 'bang', pos: [L.burst[0], L.burst[1] - 0.02, L.burst[2]], color: PAL.alarm, r: 0.018 },
  // non-spatial (2D) cues + music, on the back wall
  { id: 'pad', label: 'tension pad', pos: [-0.44, -0.09, -1.15], color: PAL.windowGlow, r: 0.018 },
  { id: 'catch', label: 'catch', pos: [-0.335, -0.09, -1.15], color: PAL.alarm, r: 0.014 },
  { id: 'rewind', label: 'rewind', pos: [-0.24, -0.09, -1.15], color: PAL.glintBlue, r: 0.014 },
  { id: 'star', label: 'star', pos: [-0.145, -0.09, -1.15], color: PAL.gold, r: 0.014 },
  { id: 'curtain', label: 'curtain', pos: [0.145, -0.09, -1.15], color: PAL.clothRed, r: 0.014 },
  { id: 'pageFlip', label: 'pageFlip', pos: [0.26, -0.09, -1.15], color: PAL.chalk, r: 0.014 },
  { id: 'music', label: 'café trio', pos: [0.38, -0.09, -1.15], color: PAL.velvet, r: 0.018 },
];
const STATION_INDEX = new Map(STATIONS.map((s, i) => [s.id, i]));

// --------------------------------------------------------------------------------------------- canvas

function drawPill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, stroke: string): void {
  const r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

/** One atlas for every label → one merged geometry → ONE draw call. */
function buildLabels(stations: Station[]): Mesh {
  const cellW = 256;
  const cellH = 56;
  const cols = 4;
  const rows = Math.ceil(stations.length / cols);
  const canvas = document.createElement('canvas');
  canvas.width = cols * cellW;
  canvas.height = 512;
  while (canvas.height < rows * cellH) canvas.height *= 2;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '600 30px system-ui, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const parts: BufferGeometry[] = [];
  const m = new Matrix4();
  const q = new Quaternion();
  const p = new Vector3();
  const one = new Vector3(1, 1, 1);
  const origin = new Vector3();
  const up = new Vector3(0, 1, 0);
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    const cx = (i % cols) * cellW + cellW / 2;
    const cy = Math.floor(i / cols) * cellH + cellH / 2;
    const tw = Math.min(cellW - 8, ctx.measureText(s.label).width + 30);
    drawPill(ctx, cx - tw / 2, cy - (cellH - 10) / 2, tw, cellH - 10, 'rgba(28,20,40,0.82)', hex(s.color));
    ctx.fillStyle = hex(PAL.text);
    ctx.fillText(s.label, cx, cy + 1);
    // constant apparent size: ~1.3° tall wherever the label sits
    const dist = Math.hypot(s.pos[0], s.pos[1], s.pos[2]);
    const h = 0.0115 * Math.max(1, dist / 0.55);
    const w = (h * tw) / (cellH - 10);
    const g = new PlaneGeometry(w, h);
    const u0 = (cx - tw / 2) / canvas.width;
    const u1 = (cx + tw / 2) / canvas.width;
    const v1 = 1 - (cy - (cellH - 10) / 2) / canvas.height;
    const v0 = 1 - (cy + (cellH - 10) / 2) / canvas.height;
    const uv = g.attributes.uv;
    uv.setXY(0, u0, v1);
    uv.setXY(1, u1, v1);
    uv.setXY(2, u0, v0);
    uv.setXY(3, u1, v0);
    p.set(s.pos[0], s.pos[1] + s.r + h * 0.5 + 0.006, s.pos[2]);
    m.lookAt(origin, p, up); // +Z toward the eye at the rig origin
    q.setFromRotationMatrix(m);
    g.applyMatrix4(m.compose(p, q, one));
    parts.push(g);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  const merged = mergeGeometries(parts, false)!;
  for (const g of parts) g.dispose();
  const mesh = new Mesh(merged, new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  mesh.name = 'audio-demo-labels';
  mesh.renderOrder = 2;
  return mesh;
}

/** A canvas-textured board (one draw call); call `draw` to repaint (never per frame). */
function board(w: number, h: number, px: number, py: number, name: string) {
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = py;
  const ctx = canvas.getContext('2d')!;
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
  mesh.name = name;
  return {
    mesh,
    ctx,
    canvas,
    commit: () => {
      tex.needsUpdate = true;
    },
  };
}

function faceEye(mesh: Mesh, pos: V3): void {
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.lookAt(0, 0, 0); // rig-local eye
}

// ------------------------------------------------------------------------------------------------ demo

export default async function audioDemo(world: World): Promise<void> {
  const params = new URLSearchParams(location.search);
  const wantRender = params.get('render') === '1';
  // tour pacing: 1 = normal; &fast=1 → 0.45x; &fast=2 → 0.25x (QA: sounds overlap)
  const pace = params.get('fast') === '2' ? 0.25 : params.get('fast') === '1' ? 0.45 : 1;
  const rig = new StageRig(world);
  const root = rig.root;

  // ---- stage: table, riser, shelf (one wood mesh) + the velvet mat
  const stage = new Mesh(
    mergeParts([
      { geometry: new BoxGeometry(L.table.width, 0.03, L.table.depth), color: PAL.clothCream, position: [0, L.tableY - 0.015, L.table.centerZ] },
      { geometry: new BoxGeometry(L.riser.width, 0.04, L.riser.depth), color: 0xa0683e, position: [0, L.tableY + 0.02, L.riser.z] },
      { geometry: new BoxGeometry(0.92, 0.12, 0.1), color: 0x8a5634, position: [0, L.tableY + 0.06, L.shelf.z] },
      { geometry: new BoxGeometry(0.14, 0.05, 0.1), color: 0x8a5634, position: [0, L.tableY + 0.145, -0.92] },
      { geometry: new BoxGeometry(0.36, 0.006, 0.022), color: PAL.ink, position: [0, L.tableY + 0.003, -0.555] },
      { geometry: new BoxGeometry(1.5, 0.5, 0.02), color: 0x6a3f2a, position: [0, -0.02, -1.2] },
    ]),
    matcapMaterial('wood'),
  );
  stage.name = 'audio-demo-stage';
  root.add(stage);
  const mat = new Mesh(mergeParts([{ geometry: new BoxGeometry(L.mat.size[0], 0.006, L.mat.size[1]), color: PAL.velvet, position: [...L.mat.center] }]), feltMaterial({ fuzz: 0.1 }));
  mat.name = 'mat';
  root.add(mat);

  // ---- sound pucks (one instanced draw) + labels (one draw)
  const N = STATIONS.length;
  const pucks = new InstancedMesh(new SphereGeometry(1, 20, 14), matcapMaterial('glossy', { vertexColors: false }), N);
  pucks.name = 'audio-demo-pucks';
  pucks.instanceMatrix.setUsage(DynamicDrawUsage);
  const baseColor: Color[] = [];
  const m4 = new Matrix4();
  const qI = new Quaternion();
  const v3 = new Vector3();
  const s3 = new Vector3();
  const c3 = new Color();
  const white = new Color(0xffffff);
  for (let i = 0; i < N; i++) {
    const s = STATIONS[i];
    baseColor.push(new Color(s.color));
    pucks.setMatrixAt(i, m4.compose(v3.set(...s.pos), qI, s3.setScalar(s.r)));
    pucks.setColorAt(i, baseColor[i]);
  }
  root.add(pucks);
  root.add(buildLabels(STATIONS));

  // ---- boards: now playing (top centre) and the offline report (left)
  const now = board(0.56, 0.07, 1024, 128, 'audio-demo-now');
  faceEye(now.mesh, [0, 0.02, -1.13]);
  root.add(now.mesh);
  const rep = board(0.3, 0.3, 1024, 1024, 'audio-demo-report');
  faceEye(rep.mesh, [-0.585, -0.02, -0.9]);
  root.add(rep.mesh);

  // ---- live VU meter on the table between the mat and the riser (master level + peak hold)
  const VU_X0 = -0.17;
  const VU_W = 0.34;
  const VU_Z = -0.555;
  const meterMat = new MeshBasicMaterial({ color: PAL.gold, toneMapped: false });
  const vu = new Mesh(new BoxGeometry(1, 1, 1), meterMat);
  vu.name = 'audio-demo-vu';
  vu.scale.set(0.0001, 0.007, 0.014);
  vu.position.set(VU_X0, L.tableY + 0.008, VU_Z);
  root.add(vu);
  const vuPeak = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: PAL.alarm, toneMapped: false }));
  vuPeak.name = 'audio-demo-vu-peak';
  vuPeak.scale.set(0.003, 0.009, 0.018);
  vuPeak.position.set(VU_X0, L.tableY + 0.009, VU_Z);
  root.add(vuPeak);

  // ---- engine
  const audio = createAudioEngine();
  const dbg = audioDebug(audio)!;
  const meter: AudioMeter = { peak: 0, rms: 0 };
  const pulse = new Float32Array(N);
  const sustain = new Uint8Array(N);
  let peakHold = 0;
  let stepPeak = 0;
  const wv = new Vector3();
  const at = (id: string): Vector3 => {
    const s = STATIONS[STATION_INDEX.get(id) ?? 0];
    return rig.toWorld(s.pos, wv);
  };
  const flash = (id: string): void => {
    const i = STATION_INDEX.get(id);
    if (i !== undefined) pulse[i] = 1;
  };
  const setSustain = (id: string, on: boolean): void => {
    const i = STATION_INDEX.get(id);
    if (i !== undefined) sustain[i] = on ? 1 : 0;
  };

  onUpdate(world, (dt) => {
    const head = world.renderer.xr.isPresenting ? world.player.head : world.camera;
    audio.setListener(head);
    // pucks: pulse on play, glow while a long sound is running (allocation-free)
    let dirty = false;
    const k = Math.exp(-dt * 3.5);
    for (let i = 0; i < N; i++) {
      const target = sustain[i] ? 0.55 : 0;
      const p = pulse[i];
      if (p < 0.001 && target === 0) continue;
      pulse[i] = Math.max(target, p * k);
      const s = STATIONS[i];
      const sc = s.r * (1 + 0.8 * pulse[i]);
      pucks.setMatrixAt(i, m4.compose(v3.set(s.pos[0], s.pos[1], s.pos[2]), qI, s3.setScalar(sc)));
      pucks.setColorAt(i, c3.copy(baseColor[i]).lerp(white, 0.55 * pulse[i]));
      if (pulse[i] < 0.001) pulse[i] = 0;
      dirty = true;
    }
    if (dirty) {
      pucks.instanceMatrix.needsUpdate = true;
      if (pucks.instanceColor) pucks.instanceColor.needsUpdate = true;
    }
    // meter
    dbg.meter(meter);
    const lvl = Math.min(1, meter.peak);
    stepPeak = Math.max(stepPeak, meter.peak);
    peakHold = Math.max(lvl, peakHold - dt * 0.35);
    vu.scale.x = Math.max(0.0001, VU_W * lvl);
    vu.position.x = VU_X0 + vu.scale.x / 2;
    vuPeak.position.x = VU_X0 + VU_W * peakHold;
  });

  // ---- DOM panel
  const showUi = params.get('ui') !== '0';
  const panel = document.createElement('div');
  panel.id = 'audio-ui';
  panel.style.cssText =
    'position:fixed;right:8px;top:8px;width:452px;max-height:calc(100vh - 16px);overflow:hidden;z-index:2147483647;' +
    'font:10px/1.2 ui-monospace,Consolas,Menlo,monospace;color:#fff4dc;background:rgba(18,13,28,.88);' +
    'border:1px solid #c99a3c;border-radius:10px;padding:10px 12px;box-sizing:border-box;' +
    (showUi ? '' : 'display:none;');
  const button = document.createElement('button');
  button.textContent = '▶ Play the sound tour (click or Enter)';
  button.style.cssText =
    'font:600 13px system-ui,sans-serif;color:#241a12;background:#ffcf5a;border:0;border-radius:8px;padding:8px 12px;cursor:pointer;width:100%';
  const status = document.createElement('div');
  status.id = 'audio-status';
  status.style.cssText = 'margin:8px 0 6px;color:#ffd9a0;white-space:pre-wrap';
  const pre = document.createElement('pre');
  pre.id = 'audio-report';
  pre.style.cssText = 'margin:0;white-space:pre;font:inherit;color:#f4eedc';
  panel.append(button, status, pre);
  document.body.appendChild(panel);

  const drawNow = (title: string, sub: string): void => {
    const c = now.ctx;
    c.clearRect(0, 0, 1024, 128);
    drawPill(c, 4, 4, 1016, 120, 'rgba(24,17,36,0.9)', hex(PAL.brass));
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = hex(PAL.gold);
    c.font = '700 46px system-ui, "Segoe UI", sans-serif';
    c.fillText(title, 512, 52);
    c.fillStyle = hex(PAL.lampWarm);
    c.font = '500 26px system-ui, "Segoe UI", sans-serif';
    c.fillText(sub, 512, 96);
    now.commit();
  };
  drawNow('♪ Sound check', wantRender ? 'rendering the offline report…' : 'click or press Enter to play the tour');

  const setStatus = (): void => {
    status.textContent = `audio: ${dbg.state} · voices ${dbg.voices} · panners ${dbg.panners}` + (stepLabel ? `\n▶ ${stepLabel}` : '');
  };
  let stepLabel = '';
  setInterval(setStatus, 250);

  // ---- the tour
  interface Step {
    st: string;
    label: string;
    secs: number;
    run: () => void;
  }
  const sfx = (name: SfxName, st: string = name, secs = 1.1): Step => ({ st, label: `sfx ${name}`, secs, run: () => audio.sfx(name, { at: st === 'catch' || st === 'rewind' || st === 'star' || st === 'curtain' || st === 'pageFlip' ? undefined : at(st) }) });
  const line = (st: string, voice: SpectatorKind, mood: Mood | undefined, text: string): Step => ({
    st,
    label: `say ${voice}/${mood ?? 'neutral'}: "${text}"`,
    secs: Math.max(1.6, text.length * 0.045 + 0.9),
    run: () => audio.say(text, { at: at(st), voice, mood }),
  });
  const crowd = (kind: CrowdKind, I: number, secs: number): Step => ({ st: 'crowd', label: `crowd ${kind} @${I}`, secs, run: () => audio.crowd(kind, I, at('crowd')) });
  const steps: Step[] = [
    sfx('tink'),
    sfx('fwip'),
    sfx('shh'),
    sfx('cupLift'),
    sfx('cupThunk'),
    sfx('poof', 'poof', 1.4),
    sfx('tick'),
    sfx('hop'),
    sfx('scribble', 'scribble', 1.4),
    {
      st: 'uiHover',
      label: 'sfx uiHover ×3 (rate-limited)',
      secs: 0.9,
      run: () => {
        audio.sfx('uiHover', { at: at('uiHover') });
        setTimeout(() => audio.sfx('uiHover', { at: at('uiHover'), pitch: 1.12 }), 120);
        setTimeout(() => audio.sfx('uiHover', { at: at('uiHover'), pitch: 1.26 }), 240);
      },
    },
    sfx('uiPress'),
    sfx('musicBoxWind', 'musicBox', 1),
    {
      st: 'musicBox',
      label: 'musicBox (5 s) — the trio would duck',
      secs: 5.8,
      run: () => {
        setSustain('musicBox', true);
        audio.musicBox(at('musicBox'), 5);
        setTimeout(() => setSustain('musicBox', false), 5200);
      },
    },
    sfx('flare', 'candle', 2.1),
    {
      st: 'fuse',
      label: 'loop fuse 2.5 s → bang',
      secs: 5.4,
      run: () => {
        setSustain('fuse', true);
        const h = audio.loop('fuse', at('fuse'));
        setTimeout(() => {
          h.stop();
          setSustain('fuse', false);
          audio.sfx('bang', { at: at('bang') });
          flash('bang');
        }, 2500);
      },
    },
    {
      st: 'tick',
      label: 'loop tick (the watch rises, ticking)',
      secs: 2.7,
      run: () => {
        setSustain('tick', true);
        const h = audio.loop('tick', at('tick'));
        setTimeout(() => {
          h.stop();
          setSustain('tick', false);
        }, 2200);
      },
    },
    sfx('catch', 'catch', 1.5),
    sfx('rewind', 'rewind', 1.2),
    sfx('star', 'star', 1.6),
    sfx('curtain', 'curtain', 2.2),
    sfx('pageFlip', 'pageFlip', 1.1),
    {
      st: 'music',
      label: 'music.start() — calm café trio',
      secs: 7,
      run: () => {
        setSustain('music', true);
        audio.music.setMood('calm');
        audio.music.start();
      },
    },
    line('kit1', 'fox', 'accusing', 'I SAW THAT!'),
    line('magpie', 'magpie', 'surprised', 'Ooh! Shiny!'),
    line('brock', 'badger', 'proud', 'Make THIS disappear.'),
    line('rabbit', 'rabbit', 'happy', 'Ta-da! Again, again!'),
    line('brock', 'badger', 'flustered', 'Hmph. Most irregular...'),
    line('kit2', 'fox', 'curious', 'Where did it go?'),
    crowd('ooh', 0.6, 2.4),
    crowd('gasp', 0.8, 2),
    crowd('giggle', 0.7, 2.2),
    crowd('applause', 0.5, 3.6),
    crowd('ovation', 1, 5.6),
    ...([1, 3, 5] as const).map(
      (w): Step => ({ st: 'pad', label: `setTension(${w}, 5)`, secs: 2.4, run: () => (setSustain('pad', true), audio.setTension(w, 5)) }),
    ),
    { st: 'pad', label: 'setTension(0, 5) — all clear (exact silence)', secs: 2.6, run: () => (setSustain('pad', false), audio.setTension(0, 5)) },
    { st: 'music', label: "music.setMood('tense')", secs: 8, run: () => audio.music.setMood('tense') },
    { st: 'music', label: "music.setMood('triumph') — resolving cadence", secs: 9, run: () => audio.music.setMood('triumph') },
    { st: 'music', label: 'setPaused(true) for 1.5 s, then resume', secs: 3.2, run: () => (audio.setPaused(true), setTimeout(() => audio.setPaused(false), 1500 * pace)) },
    { st: 'music', label: 'setMasterVolume(0.4) → 1', secs: 2.6, run: () => (audio.setMasterVolume(0.4), setTimeout(() => audio.setMasterVolume(1), 1300 * pace)) },
    { st: 'music', label: "music.setMood('calm') — tour done, music stays on", secs: 1, run: () => audio.music.setMood('calm') },
  ];

  let touring = false;
  const tour = async (): Promise<void> => {
    if (touring) return;
    touring = true;
    button.disabled = true;
    button.textContent = 'Tour playing…';
    await audio.unlock();
    const results: Array<{ label: string; peak: number }> = [];
    console.log(`[audio-tour] start: ${steps.length} steps, AudioContext ${dbg.state}`);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      stepLabel = `${i + 1}/${steps.length} ${s.label}`;
      console.log(`[audio-tour] ${stepLabel}`);
      drawNow(s.label.replace(/^sfx /, ''), `step ${i + 1} of ${steps.length} · from: ${STATIONS[STATION_INDEX.get(s.st) ?? 0].label}`);
      flash(s.st);
      stepPeak = 0;
      try {
        s.run();
      } catch (e) {
        console.error('[audio-tour] step threw', e);
      }
      await new Promise((r) => setTimeout(r, s.secs * pace * 1000));
      results.push({ label: s.label, peak: Math.round(stepPeak * 1000) / 1000 });
    }
    stepLabel = 'tour complete';
    drawNow('♪ Tour complete', 'the café trio keeps playing · click to replay');
    setSustain('music', true);
    const st = dbg.stats;
    const silent = results.filter((r) => r.peak <= 0).map((r) => r.label);
    const summary = { context: dbg.state, steps: results.length, silentSteps: silent.length, maxPeak: Math.max(...results.map((r) => r.peak)), stats: st, results };
    console.log('[audio-tour] done', summary);
    // a warning so headless runs (tests/shot.mjs) capture the live-path result
    console.warn(`[audio-tour] ${JSON.stringify({ context: summary.context, steps: summary.steps, silentSteps: silent, maxPeak: summary.maxPeak, stats: st })}`);
    touring = false;
    button.disabled = false;
    button.textContent = '▶ Replay the sound tour';
  };
  button.addEventListener('click', () => void tour());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void tour();
  });
  world.renderer.xr.addEventListener('sessionstart', () => {
    if (!wantRender) void tour();
  });
  if (params.get('autoplay') === '1' && !wantRender) void tour();

  // ---- offline verification
  if (wantRender) void runReport(pre, rep, drawNow);
}

function fmt(v: number, d = 3): string {
  return v.toFixed(d);
}

async function runReport(
  pre: HTMLPreElement,
  rep: { ctx: CanvasRenderingContext2D; commit: () => void },
  drawNow: (title: string, sub: string) => void,
): Promise<void> {
  const t0 = performance.now();
  const rows: string[] = [];
  const head = REPORT_HEAD;
  pre.textContent = 'rendering…';
  const entries = await renderAudioReport((e, i, n) => {
    rows.push(row(e));
    pre.textContent = `OFFLINE RENDER  ${i + 1}/${n}\n${head}\n${rows.join('\n')}`;
    document.title = `audio report ${i + 1}/${n}`;
  });
  const ms = Math.round(performance.now() - t0);
  const pass = entries.filter((e) => e.ok).length;
  const avg = (prefix: string): number => {
    const xs = entries.filter((e) => e.name.startsWith(prefix)).map((e) => e.loud);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  };
  const balance = {
    music: avg('music:calm 6s'),
    voices: avg('say:'),
    foley: (avg('sfx:tink') + avg('sfx:fwip') + avg('sfx:shh') + avg('sfx:poof') + avg('sfx:cupThunk')) / 5,
    crowd: avg('crowd:'),
    ui: avg('sfx:uiHover'),
    pad: avg('pad:'),
  };
  const maxPeak = Math.max(...entries.map((e) => e.peak));
  const ok = pass === entries.length && !entries.some((e) => e.nan) && maxPeak < 0.99;
  const balanceLine = Object.entries(balance)
    .map(([k, v]) => `${k} ${v.toFixed(1)}`)
    .join(' · ');
  pre.textContent =
    `OFFLINE RENDER REPORT  ${pass}/${entries.length} ok · max peak ${fmt(maxPeak)} · ${ms} ms\n` +
    `${head}\n${rows.join('\n')}\n` +
    `loudest-50ms dBFS: ${balanceLine}`;
  document.title = `${ok ? 'AUDIO OK' : 'AUDIO FAIL'} ${pass}/${entries.length} max ${fmt(maxPeak)}`;
  drawReportBoard(rep, entries, pass, maxPeak, balance);
  drawNow(ok ? '✔ Offline audio report: all clear' : '✖ Offline audio report: issues', `${pass}/${entries.length} renders ok · max peak ${fmt(maxPeak)} · ${ms} ms`);
  const compact = entries.map((e) => ({
    name: e.name,
    peak: +fmt(e.peak, 4),
    rms: +e.rms.toExponential(3),
    nan: e.nan,
    raw: +fmt(e.raw, 3),
    loud: +e.loud.toFixed(1),
    dur: +e.dur.toFixed(2),
    act: +e.act.toFixed(2),
    hf: +e.hf.toFixed(1),
    tail: +e.tail.toExponential(2),
    ok: e.ok,
    ...(e.note ? { note: e.note } : {}),
  }));
  console.warn(`[audio-report] ${JSON.stringify({ ok, pass, total: entries.length, maxPeak: +fmt(maxPeak, 4), ms, balance, entries: compact })}`);
}

const REPORT_HEAD = 'name                                peak  rms    loud  raw  ok';

function row(e: AudioReportEntry): string {
  const name = e.name.length > 34 ? `${e.name.slice(0, 33)}…` : e.name.padEnd(34);
  return `${name}  ${fmt(e.peak, 2)}  ${fmt(e.rms, 4)} ${e.loud.toFixed(1).padStart(5)}  ${fmt(e.raw, 2)} ${e.ok ? '✓' : '✗ ' + (e.note ?? '')}`;
}

function drawReportBoard(
  rep: { ctx: CanvasRenderingContext2D; commit: () => void },
  entries: AudioReportEntry[],
  pass: number,
  maxPeak: number,
  balance: Record<string, number>,
): void {
  const c = rep.ctx;
  c.clearRect(0, 0, 1024, 1024);
  c.fillStyle = 'rgba(20,15,30,0.92)';
  c.fillRect(0, 0, 1024, 1024);
  c.strokeStyle = hex(PAL.brass);
  c.lineWidth = 8;
  c.strokeRect(4, 4, 1016, 1016);
  c.fillStyle = hex(PAL.gold);
  c.font = '700 54px system-ui, sans-serif';
  c.textAlign = 'left';
  c.textBaseline = 'alphabetic';
  c.fillText(`Audio check ${pass}/${entries.length}`, 40, 84);
  c.font = '500 30px system-ui, sans-serif';
  c.fillStyle = hex(PAL.lampWarm);
  c.fillText(`max peak ${maxPeak.toFixed(3)} (limit 0.99) · no NaN`, 40, 128);
  // balance bars: loudest 50 ms window, dBFS (-60 … 0)
  const keys = Object.keys(balance);
  for (let i = 0; i < keys.length; i++) {
    const y = 180 + i * 46;
    const v = balance[keys[i]];
    c.fillStyle = hex(PAL.text);
    c.font = '500 28px system-ui, sans-serif';
    c.fillText(keys[i], 40, y + 26);
    c.fillStyle = 'rgba(255,255,255,0.08)';
    c.fillRect(200, y + 4, 640, 28);
    c.fillStyle = hex(PAL.velvet);
    c.fillRect(200, y + 4, Math.max(0, Math.min(640, ((v + 60) / 60) * 640)), 28);
    c.fillStyle = hex(PAL.text);
    c.fillText(`${v.toFixed(1)} dB`, 860, y + 26);
  }
  // one tick per render: green ok / red fail, height = peak
  const y0 = 500;
  c.fillStyle = hex(PAL.lampWarm);
  c.font = '500 26px system-ui, sans-serif';
  c.fillText('every render (bar = peak, line = 0.99)', 40, y0 - 14);
  const bw = 940 / entries.length;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const h = Math.min(1, e.peak) * 440;
    c.fillStyle = e.ok ? '#6fd08c' : hex(PAL.alarm);
    c.fillRect(40 + i * bw + 1, y0 + 460 - h, Math.max(2, bw - 3), h);
  }
  c.strokeStyle = hex(PAL.alarm);
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(36, y0 + 460 - 0.99 * 440);
  c.lineTo(988, y0 + 460 - 0.99 * 440);
  c.stroke();
  rep.commit();
}
