// Browser-side gameplay takes. Dev-only: genuine hand/gaze input, debug jumps only before the clapperboard.
// Matches the tested gestures in tests/scenarios/core-act*.mjs. No virtual clock: game audio stays in sync.
import { startAVRecording } from './av-recorder.js';

export const SHOTS = ['s01-cold-open', 's02-wide', 's04-act1', 's05-act2', 's06-catch', 's07-act3', 's08-bow', 's09-hands', 's10-glasses'];
const HEAD = [0, 1.2, 0];
const MAT = [0, 0.9, -0.45];
const add = (a, b) => a.map((v, i) => v + b[i]);
let d, rec, currentLook = MAT, stopWatch = null;
const state = () => window.__app.debugState();
const where = (name) => {
  const p = window.__app.where(name);
  if (!p) throw new Error(`capture target missing: ${name}`);
  return p;
};
const mark = (name) => rec?.mark(name);
const wait = (s) => d.wait(s);
async function until(pred, label, timeout = 10000) {
  const start = performance.now();
  while (!pred(state())) {
    if (performance.now() - start > timeout) throw new Error(`${label}: ${JSON.stringify(state())}`);
    await new Promise((r) => setTimeout(r, 60));
  }
  return state();
}
async function look(to, seconds = 0.5) {
  if (typeof to === 'string') to = where(to);
  await d.play({duration: seconds, head: {pos: [HEAD, HEAD], look: {points: [currentLook, to], ease: 'minJerk'}}});
  currentLook = to;
}
async function reach(from, to, seconds = 0.6, value = 0, side = 'right') {
  await d.play({duration: seconds, [side]: {anchor: 'grasp', fingers: 'forward', palm: 'down',
    pos: {points: [from, to], ease: 'minJerk'}, pinch: [{t: 0, v: value}]}});
}
async function pinch(value, side = 'right', seconds = 0.3) {
  await d.play({duration: seconds, [side]: {pinch: [{t: 0, v: 1 - value}, {t: seconds * 0.6, v: value}, {t: seconds, v: value}]}});
}
async function poke(target, side = 'right') {
  if (typeof target === 'string') {
    // The volunteer's ear keeps moving with its springy head. IWER's named-target press tracks that
    // anchor during approach; a once-sampled world point can miss it after a different gaze history.
    const result = await d.sequence({device: `hand-${side}`, gaze: 'fixed', body: 'fixed', idleHand: 'keep',
      steps: [{target, press: {depth: 0.012, hold: 0.06}}]});
    if (!result.completed) throw new Error(`poke ${target}: ${result.error ?? 'incomplete sequence'}`);
    return;
  }
  const p = typeof target === 'string' ? where(target) : target;
  const from = add(p, [0.01, 0.035, 0.12]);
  await d.play({duration: 1.1, [side]: {anchor: 'index-tip', fingers: 'forward', palm: 'down',
    poses: [{t: 0, id: 'point'}], pos: {points: [from, p, p, from], ease: 'linear'}, pinch: [{t: 0, v: 0}]}});
}
async function lift(prop, side = 'right') {
  const p = add(where(prop), [0, 0.012, 0]);
  mark('lift:start'); await look(p);
  await reach(add(p, [0.05, 0.12, 0.14]), p, 0.8, 0, side);
  await pinch(1, side); await reach(p, add(p, [0, 0.07, 0.03]), 0.7, 1, side);
  await wait(0.45); mark('lift:held'); await pinch(0, side);
  await until(s => s.beatKind === 'steal', 'lift → steal', 7000);
  await reach(add(p, [0, 0.07, 0.03]), add(p, [0.07, 0.1, 0.14]), 0.3, 0, side);
}
async function palm(prop, gadget, {load = null, side = 'right'} = {}) {
  const grab = add(where(prop), [0, 0.012, 0]);
  mark(`misdirect:${gadget}`); await look(`${gadget}-focus`);
  await until(s => s.gadgets[gadget].active, `${gadget} activates`, 5000);
  if (gadget === 'firework') {
    // The demo's six-second blush has expired by the time the watch is shown. Re-establish eye contact
    // while the fuse burns, just as tests/lib/acts.mjs does, then work during the actual bang window.
    await look('brock-eyes', 0.4);
    await until(s => s.spectators.find(x => x.id === 'brock')?.flustered, 'steal: Brock flusters again', 3000);
    mark('brock:steal-blush');
    await until(s => s.bangActive, 'firework burst', 6500);
    mark('firework:bang');
    const rig = where('StageRig');
    await look(add(rig, [0, 0.12, -0.95]), 0.25);
    await wait(0.65);
  } else await wait(gadget === 'musicBox' ? 1.3 : 0.9);
  mark('palm:start'); await reach(add(grab, [0.07, 0.1, 0.14]), grab, 0.5, 0, side);
  await pinch(1, side);
  await until(s => s.palmed === prop && s.beatKind !== 'steal', `${prop} palmed`, 2500);
  mark('palm:success'); await pinch(0, side, 0.2);
  let from = grab;
  if (load) {
    const to = add(where(load), [0, 0.06, 0]);
    await reach(from, to, 0.45, 0, side); mark('load:start'); await pinch(1, side);
    await until(s => s.beatKind === 'lookBack', 'prop loaded', 2500);
    mark('load:success'); await pinch(0, side, 0.2); from = to;
  }
  await reach(from, add(from, [0.08, 0.06, 0.16]), 0.4, 0, side);
  mark('lookback:start'); await look(add(where(prop), [0, 0.003, 0]));
  await until(s => s.beatKind === 'reveal' && s.phase === 'ready', 'reveal ready', 8500);
  mark('reveal:ready');
}
async function revealAll(act, side = 'right') {
  for (let i = 0; i < 3; i++) {
    const s = await until(s => s.act !== act || s.phase === 'done' || s.phase === 'ready', 'next reveal', 9000);
    if (s.act !== act || s.phase === 'done') break;
    const target = s.revealTarget;
    if (!target) throw new Error('ready reveal has no target');
    // Keep the gaze on the mat while an ear is poked, so the volunteer and coin stay in frame.
    if (!target.includes('-ear')) await look(target, 0.3);
    const p = where(target);
    mark(`reveal:poke:${target}`);
    await poke(target.includes('-ear') ? target : add(p, [0, 0.055, 0]), side);
    await until(n => n.phase !== 'ready' || n.beat !== s.beat, 'poke registered', 3000);
    mark(`reveal:success:${target}`); await wait(1.1);
  }
  await wait(1.3);
}

/** Prepare all jumps/settings while the recorder is OFF. */
export async function prepare(name) {
  if (!SHOTS.includes(name)) throw new Error(`unknown take ${name}`);
  d = window.__director;
  if (!d || !window.__app) throw new Error('call tests/lib/iwer.enterXR first');
  d.clean(true, false);
  window.__app.setSettings({assist: name === 's09-hands', easyAudience: false, captions: true});
  const starts = {'s01-cold-open': [1,2], 's02-wide': [1,0], 's04-act1': [1,1], 's05-act2': [2,2],
    's06-catch': [2,2], 's07-act3': [3,0], 's08-bow': [3,6], 's09-hands': [1,1], 's10-glasses': [1,2]};
  window.__app.skipTo(...starts[name]);
  currentLook = MAT;
  d.place({head: HEAD, look: MAT});
  await reach([0.22,0.78,-0.05], [0.22,0.78,-0.05], 0.1);
  await reach([-0.22,0.78,-0.05], [-0.22,0.78,-0.05], 0.1, 0, 'left');
  await until(s => s.calibrated && (name === 's08-bow' ? s.beatKind === 'reveal' && s.phase === 'ready' : s.phase === 'active'), 'take prepared', 10000);
  await wait(1);
  return state();
}

export async function start(name, options = {}) {
  rec = await startAVRecording(d.dev, {name, ...options});
  // Chrome's first hardware H.264 encoder startup can omit ~0.8 s of video while audio is already rolling.
  // Prime it before the sync clap; all of this is outside the edit's `in` mark.
  await wait(1.2);
  await rec.clap();
  mark('in');
  const startAt = performance.now();
  let oldBeat = '';
  let nextSample = 0;
  const watch = (time) => {
    if (!stopWatch) return;
    if (time >= nextSample) {
      nextSample = time + 100;
      const s = state();
      const key = `${s.act}:${s.beat}:${s.beatKind}:${s.phase}`;
      if (key !== oldBeat) { mark(`beat:${key}`); oldBeat = key; }
    }
    d.dev.activeSession?.requestAnimationFrame(watch);
  };
  stopWatch = () => {}; d.dev.activeSession.requestAnimationFrame(watch);
  return {name, startAt};
}

export async function perform(name) {
  if (name === 's02-wide') {
    mark('gaze:left'); await look([-0.28,0.905,-0.48],0.8); await wait(1.3);
    mark('gaze:right'); await look([0.28,0.905,-0.48],1.2); await wait(1.3);
    mark('gaze:audience'); await look('kit2-eyes',0.7); await wait(1.3);
    await look(MAT,0.7); await wait(1.6);
  } else if (name === 's01-cold-open' || name === 's04-act1') {
    if (name === 's04-act1') await lift('coin');
    await palm('coin', 'musicBox'); await revealAll(1);
  } else if (name === 's05-act2') {
    mark('magpie:shiny'); await look([-0.28,0.92,-0.5]); await wait(1.8);
    await palm('ball','candle',{load:'cupRight'}); await revealAll(2);
  } else if (name === 's06-catch') {
    const p = add(where('ball'),[0,0.015,0]);
    await look('musicBox-focus'); await until(s=>s.gadgets.musicBox.active,'box activates'); await wait(1.4);
    mark('caught:attempt'); await reach(add(p,[0.05,0.12,0.14]),p); await pinch(1);
    await until(s=>s.phase==='caught','magpie catches',3000); mark('caught:shout');
    await look(MAT,0.3); await pinch(0, 'right',0.2);
    await until(s=>s.phase==='active'&&s.beatKind==='steal','catch rewinds',6500);
    mark('caught:rewound'); await reach(p,add(p,[0.08,0.1,0.14]),0.4); await wait(1.8);
  } else if (name === 's07-act3') {
    const hand=[0.2,0.98,-0.32];
    await reach([0.25,0.95,-0.2],hand); await look([-0.28,0.92,-0.5]); await wait(1.1);
    mark('brock:handwatch'); await look('brock-eyes');
    await until(s=>s.spectators.find(x=>x.id==='brock')?.flustered,'Brock flusters',4000);
    mark('brock:blush'); await wait(0.6);
    await until(s=>s.beatKind==='show','watch lent',10000); await lift('watch');
    await palm('watch','firework',{load:'cupcake'}); await revealAll(3);
  } else if (name === 's08-bow') {
    // Complete the actual last reveal and enter the curtain call naturally. Preparing directly at bow would
    // spend its 0.3 s bow animation and 1.2 s newspaper delay before the clapperboard had even finished.
    await revealAll(3);
    await until(s=>s.act===4&&s.beatKind==='bow'&&s.phase==='active','curtain call',16000);
    mark('bow:start');
    await until(s=>s.reviewShown,'review appears',5000); mark('bow:review'); await wait(4);
    await look([0.1,0.88,-0.42],1.1); await wait(2.3); await look(MAT,1); await wait(1.3);
  } else if (name === 's09-hands') {
    // One left-hand pinch in free space, far from the coin: the assist rabbit performs the lift.
    mark('assist:left-pinch'); await reach([-0.22,0.82,-0.12],[-0.22,0.92,-0.22],0.6,0,'left');
    await pinch(1,'left'); await wait(0.7); await pinch(0,'left');
    await until(s=>s.beatKind==='steal','assist lift advances',7000);
    await look('musicBox-focus'); await until(s=>s.gadgets.musicBox.active,'assist box'); await wait(1.5);
    mark('assist:palm'); await pinch(1,'left'); await pinch(0,'left');
    await until(s=>s.beatKind==='lookBack','assist palms coin',3000);
    await look(MAT); await until(s=>s.beatKind==='reveal'&&s.phase==='ready','assist reveal ready',8500);
    const target=state().revealTarget; await look(target);
    await until(s=>s.gazeTarget===target,'assist gaze on reveal',2500); mark('assist:reveal');
    await pinch(1,'left'); await pinch(0,'left');
    await until(s=>s.phase==='resolving'||s.phase==='done','assist reveal succeeds',3000); await wait(3);
  } else if (name === 's10-glasses') {
    // An illustrative narrower rendering, NOT a claim of physical glasses testing. Metadata states this.
    const prior = d.dev.fovy; d.dev.fovy=50*Math.PI/180;
    try { await wait(2); await look('musicBox-focus',0.7); await wait(2); await look(MAT,0.7); await wait(2); }
    finally { d.dev.fovy=prior; }
  }
  mark('out'); await wait(0.45);
  return {state:state(), glassesIllustration:name==='s10-glasses'};
}

export async function stop() {
  stopWatch = null;
  const active = rec; rec=null;
  return active ? active.stop() : null;
}
