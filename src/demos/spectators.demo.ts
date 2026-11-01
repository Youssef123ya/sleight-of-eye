// Spectators demo (?demo=spectators): the felt audience on a stand-in stage (demo-only props, not the café).
// A glowing target hops between the three gadgets, the mat and your face every ~2.5 s; every head follows.
// Reactions cycle across the audience; glyphs and sight cones show who is watching the mat.
//
// URL params:
//   &reaction=<name>   loop one reaction on everyone (hops: kit3 + rabbit only)
//   &pose=<seconds>    with &reaction: freeze everyone that many seconds into the first play (screenshots)
//   &freeze=1          park the target (at &target, default the mat)
//   &target=mat|musicBox|firework|candle|player|volunteer
//   &mood=neutral|eyeContact|flustered|suspicious     &glyph=open|closed|hidden     &cone=0|1|alarm
//   &solo=<id>         show only one spectator (close-ups): kit1 kit2 kit3 magpie brock rabbit
import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Mesh,
  MeshBasicMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  type World,
} from '@iwsdk/core';
import { matcapMaterial } from '../art/matcap.js';
import { PAL } from '../art/palette.js';
import { onUpdate } from '../boot/loop.js';
import type { ReactionName, Spectator, SpectatorKind } from '../contracts.js';
import { L, StageRig, type V3 } from '../layout.js';
import { spectatorFactory } from '../spectators/factory.js';

type Mood = 'neutral' | 'eyeContact' | 'flustered' | 'suspicious';
type Spot = 'mat' | 'musicBox' | 'firework' | 'candle' | 'player' | 'volunteer';

const REACTIONS: ReactionName[] = [
  'leanIn', 'gasp', 'topple', 'pointSqueak', 'clap', 'cheer', 'giggle', 'blushScribble', 'hopToVolunteer', 'hopBack', 'bow', 'idle',
];

interface Cue {
  who: string[];
  r: ReactionName;
  dur?: number;
  at?: Spot;
  alarm?: boolean;
}

const ALL = ['kit1', 'kit2', 'kit3', 'magpie', 'brock', 'rabbit'];
const SCRIPT: Cue[] = [
  { who: ['kit1', 'kit2', 'kit3'], r: 'leanIn' },
  { who: ['kit2'], r: 'topple' },
  { who: ['magpie'], r: 'pointSqueak', at: 'mat', alarm: true },
  { who: ['kit1', 'kit3', 'rabbit'], r: 'giggle' },
  { who: ['brock'], r: 'blushScribble', dur: 4.5 },
  { who: ['kit3'], r: 'hopToVolunteer', at: 'volunteer' },
  { who: ['kit1', 'kit2', 'magpie'], r: 'gasp' },
  { who: ['kit3'], r: 'hopBack' },
  { who: ALL, r: 'clap', dur: 2.2 },
  { who: ['kit1', 'kit2', 'kit3', 'magpie', 'rabbit'], r: 'cheer' },
  { who: ['brock', 'kit1', 'magpie'], r: 'bow' },
  { who: ['rabbit'], r: 'hopToVolunteer', at: 'volunteer' },
  { who: ['rabbit'], r: 'hopBack' },
];
const TARGET_CYCLE: Spot[] = ['mat', 'musicBox', 'mat', 'player', 'candle', 'mat', 'firework'];

export default function spectatorsDemo(world: World): void {
  const q = new URLSearchParams(location.search);
  const pinned = q.get('reaction') as ReactionName | null;
  const poseAt = q.has('pose') ? Number(q.get('pose')) : NaN;
  const pinnedSpot = q.get('target') as Spot | null;
  const freezeTarget = q.get('freeze') === '1' || !!pinnedSpot;
  const mood = q.get('mood') as Mood | null;
  const glyphParam = q.get('glyph') as 'open' | 'closed' | 'hidden' | null;
  const coneParam = q.get('cone');
  const solo = q.get('solo');
  if (pinned && !REACTIONS.includes(pinned)) console.warn(`[spectators demo] unknown reaction "${pinned}"`);

  const rig = new StageRig(world);
  const stage = buildStandInStage(rig);

  // ---- the audience
  const seating: Array<[string, SpectatorKind, number]> = [
    ['brock', 'badger', 1],
    ['kit1', 'fox', 1],
    ['kit2', 'fox', 0.86],
    ['kit3', 'fox', 1],
    ['magpie', 'magpie', 1],
  ];
  const specs = new Map<string, Spectator>();
  seating.forEach(([id, kind, scale], i) => {
    const s = spectatorFactory.create(kind, { id, seed: i + 1, scale });
    s.root.position.set(...L.seats[i]);
    rig.root.add(s.root);
    specs.set(id, s);
  });
  const rabbit = spectatorFactory.create('rabbit', { id: 'rabbit', seed: 7 });
  rabbit.root.position.set(0.22, L.tableY, -0.45);
  rig.root.add(rabbit.root);
  specs.set('rabbit', rabbit);
  if (solo) for (const [id, s] of specs) s.root.visible = id === solo;

  for (const s of specs.values()) {
    s.setSightCone(coneParam !== '0', coneParam === 'alarm');
    if (mood) s.setMood(mood);
  }

  // ---- the glowing target
  const spots = new Map<Spot, Vector3>();
  const rigPoint = (p: V3) => rig.toWorld(p, new Vector3());
  spots.set('mat', rigPoint([0, L.tableY + 0.012, -0.4]));
  spots.set('musicBox', rigPoint([L.gadgets.musicBox[0], L.gadgets.musicBox[1] + 0.07, L.gadgets.musicBox[2]]));
  spots.set('firework', rigPoint([L.gadgets.firework[0], L.gadgets.firework[1] + 0.08, L.gadgets.firework[2]]));
  spots.set('candle', rigPoint([L.gadgets.candle[0], L.gadgets.candle[1] + 0.075, L.gadgets.candle[2]]));
  spots.set('player', rigPoint([0, -0.02, -0.08]));
  spots.set('volunteer', rigPoint(L.volunteerSpot));
  const rabbitSpot = rigPoint([0.17, L.tableY + 0.004, -0.36]);

  const glow = makeGlow();
  rig.root.add(glow.object);
  const tgt = new Vector3().copy(spots.get(pinnedSpot ?? 'mat')!);
  const from = new Vector3().copy(tgt);
  const to = new Vector3().copy(tgt);
  let spot: Spot = pinnedSpot ?? 'mat';
  let cycle = 0;
  let moveT = 1;
  let nextMove = 2.5;
  // per-frame state, preallocated (the loop below must not allocate)
  const lagRate: Record<string, number> = { kit1: 7, kit2: 6, kit3: 6.5, magpie: 10, brock: 4.5, rabbit: 8 };
  const crowd = [...specs].map(([id, s]) => ({ id, s, lag: new Vector3().copy(tgt), rate: lagRate[id] ?? 6 }));
  const URGENT = { urgency: 0.95 };
  const CALM = { urgency: 0.55 };
  (window as unknown as { __spectatorsDemo?: unknown }).__spectatorsDemo = { specs, factory: spectatorFactory, rig };

  // ---- reaction scheduling
  let clock = 0;
  let nextCue = 1.2;
  let cueIndex = 0;
  let pinnedStart = -1;
  let frozenAll = false;
  let hopOut = false;

  const play = (id: string, r: ReactionName, dur?: number, at?: Spot) => {
    const s = specs.get(id);
    if (!s) return;
    let target: Vector3 | undefined;
    if (at === 'volunteer') target = id === 'rabbit' ? rabbitSpot : spots.get('volunteer');
    else if (at) target = spots.get(at);
    void s.react(r, { duration: dur, target });
  };

  const runPinned = (r: ReactionName) => {
    if (r === 'hopToVolunteer' || r === 'hopBack') {
      const next: ReactionName = hopOut ? 'hopBack' : 'hopToVolunteer';
      hopOut = !hopOut;
      play('kit3', next, undefined, 'volunteer');
      play('rabbit', next, undefined, 'volunteer');
      return;
    }
    for (const id of specs.keys()) {
      const at: Spot | undefined = r === 'pointSqueak' ? 'mat' : undefined;
      play(id, r, r === 'blushScribble' ? 3 : undefined, at);
      if (r === 'pointSqueak') specs.get(id)!.setSightCone(true, true);
    }
  };

  onUpdate(world, (dt) => {
    clock += dt;

    // target: hop between the spots with a quick eased glide
    if (!freezeTarget && !frozenAll) {
      nextMove -= dt;
      if (nextMove <= 0) {
        nextMove = 2.5;
        cycle = (cycle + 1) % TARGET_CYCLE.length;
        spot = TARGET_CYCLE[cycle];
        from.copy(tgt);
        to.copy(spots.get(spot)!);
        moveT = 0;
      }
    }
    if (moveT < 1) {
      moveT = Math.min(1, moveT + dt / 0.32);
      const e = moveT * moveT * (3 - 2 * moveT);
      tgt.lerpVectors(from, to, e);
    }
    glow.object.position.copy(tgt);
    rig.root.worldToLocal(glow.object.position);
    glow.pulse(clock, spot === 'player' ? 0.35 : 1);

    // every head follows (each with its own little lag); moods react to where the target is
    const onMat = spot === 'mat';
    for (let i = 0; i < crowd.length; i++) {
      const { id, s, lag, rate } = crowd[i];
      lag.lerp(tgt, 1 - Math.exp(-rate * dt));
      s.lookAt(lag, spot === 'firework' ? URGENT : CALM);
      if (!glyphParam) s.setEyeGlyph(onMat || spot === 'player' ? 'open' : 'closed');
      else s.setEyeGlyph(glyphParam);
      if (!mood && !frozenAll) {
        if (spot === 'player' && id.startsWith('kit')) s.setMood('eyeContact');
        else if (onMat && id === 'magpie') s.setMood('suspicious');
        else if (id !== 'brock') s.setMood('neutral');
      }
    }

    // reactions
    if (pinned && REACTIONS.includes(pinned)) {
      if (pinnedStart < 0 && clock > 0.8) {
        pinnedStart = clock;
        runPinned(pinned);
      } else if (pinnedStart >= 0 && !frozenAll) {
        if (Number.isFinite(poseAt) && clock - pinnedStart >= poseAt) {
          frozenAll = true;
          for (const s of specs.values()) s.setFrozen(true);
        } else if (!Number.isFinite(poseAt) && clock - pinnedStart > cueLength(pinned)) {
          pinnedStart = clock;
          runPinned(pinned);
        }
      }
    } else if (!frozenAll) {
      nextCue -= dt;
      if (nextCue <= 0) {
        const cue = SCRIPT[cueIndex % SCRIPT.length];
        cueIndex++;
        nextCue = cue.r === 'topple' ? 4.2 : cue.r === 'blushScribble' ? 5 : 2.9;
        for (const id of cue.who) play(id, cue.r, cue.dur, cue.at);
        if (cue.alarm) {
          for (const id of cue.who) {
            const s = specs.get(id)!;
            s.setSightCone(true, true);
            setTimeout(() => s.setSightCone(coneParam !== '0', false), 1800);
          }
        }
      }
    }

    for (let i = 0; i < crowd.length; i++) crowd[i].s.update(dt, clock);
    stage.update(clock, spot);
  });
}

function cueLength(r: ReactionName): number {
  return r === 'topple' ? 4.4 : r === 'blushScribble' ? 3.6 : r === 'hopToVolunteer' || r === 'hopBack' ? 2.2 : 2.6;
}

// -------------------------------------------------------------------------------- stand-in stage (demo only)
function buildStandInStage(rig: StageRig): { update(t: number, spot: Spot): void } {
  const add = (m: Mesh, p: V3) => {
    m.position.set(p[0], p[1], p[2]);
    rig.root.add(m);
    return m;
  };
  const wood = matcapMaterial('wood', { vertexColors: false, color: PAL.wood });
  const woodDark = matcapMaterial('wood', { vertexColors: false, color: PAL.woodDark });
  const brass = matcapMaterial('brass', { vertexColors: false });
  const felt = (color: number) => matcapMaterial('felt', { vertexColors: false, color });

  const cloth = matcapMaterial('felt', { vertexColors: false });
  cloth.map = gingham();
  add(new Mesh(new BoxGeometry(L.table.width, 0.03, L.table.depth), cloth), [0, L.tableY - 0.015, L.table.centerZ]);
  add(new Mesh(new BoxGeometry(L.mat.size[0], 0.003, L.mat.size[1]), matcapMaterial('velvet', { vertexColors: false, color: PAL.velvet })), [
    L.mat.center[0],
    L.tableY + 0.0015,
    L.mat.center[2],
  ]);
  add(new Mesh(new BoxGeometry(L.riser.width, L.riser.topY - L.tableY, L.riser.depth), wood), [0, (L.riser.topY + L.tableY) / 2, L.riser.z]);
  add(new Mesh(new BoxGeometry(0.95, L.shelf.topY - L.tableY, 0.1), woodDark), [0, (L.shelf.topY + L.tableY) / 2, L.shelf.z - 0.02]);

  // music box (brass), firework on a stand (red), candle (cream + flame)
  const mb = L.gadgets.musicBox;
  add(new Mesh(new BoxGeometry(0.07, 0.042, 0.05), brass), [mb[0], mb[1] + 0.021, mb[2]]);
  add(new Mesh(new BoxGeometry(0.072, 0.008, 0.052), felt(PAL.clothRed)), [mb[0], mb[1] + 0.046, mb[2]]);
  const fw = L.gadgets.firework;
  add(new Mesh(new CylinderGeometry(0.012, 0.016, fw[1] - L.shelf.topY, 12), woodDark), [fw[0], (fw[1] + L.shelf.topY) / 2, fw[2]]);
  add(new Mesh(new CylinderGeometry(0.011, 0.011, 0.055, 14), felt(PAL.ballRed)), [fw[0], fw[1] + 0.0275, fw[2]]);
  add(new Mesh(new CylinderGeometry(0.0005, 0.011, 0.02, 14), felt(PAL.gold)), [fw[0], fw[1] + 0.065, fw[2]]);
  const cd = L.gadgets.candle;
  add(new Mesh(new CylinderGeometry(0.02, 0.022, 0.008, 16), brass), [cd[0], cd[1] + 0.004, cd[2]]);
  add(new Mesh(new CylinderGeometry(0.01, 0.01, 0.05, 14), felt(PAL.chalk)), [cd[0], cd[1] + 0.033, cd[2]]);
  const flame = add(new Mesh(new SphereGeometry(0.006, 12, 10), new MeshBasicMaterial({ color: 0xffc35a, toneMapped: false })), [
    cd[0],
    cd[1] + 0.066,
    cd[2],
  ]);
  flame.scale.set(1, 1.6, 1);
  return {
    update(t: number, spot: Spot) {
      const f = spot === 'candle' ? 1.6 : 1;
      flame.scale.set(f, f * (1.6 + 0.15 * Math.sin(t * 17)), f);
    },
  };
}

function gingham(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f1e6cf';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = 'rgba(168,50,45,0.5)';
  g.fillRect(0, 0, 64, 128);
  g.fillRect(0, 0, 128, 64);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(9, 7);
  return t;
}

function makeGlow(): { object: Mesh; pulse(t: number, k: number): void } {
  const core = new Mesh(new SphereGeometry(0.0065, 16, 12), new MeshBasicMaterial({ color: PAL.glintGold, toneMapped: false }));
  core.name = 'demo-target';
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, 'rgba(255,255,255,0.4)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const halo = new Sprite(new SpriteMaterial({ map: tex, color: PAL.glintGold, blending: AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }));
  halo.scale.setScalar(0.05);
  core.add(halo);
  return {
    object: core,
    pulse(t: number, k: number) {
      halo.scale.setScalar((0.045 + 0.008 * Math.sin(t * 6)) * k);
      core.scale.setScalar(k < 1 ? 0.6 : 1);
    },
  };
}
