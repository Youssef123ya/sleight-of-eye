// Synthesized sleight foley + UI + stage sounds (owned by A). Every SfxName is a small node recipe built on
// an Ev (one pooled voice). Recipes return the time their last envelope reaches exactly zero.
// Character notes: one sonic family (warm, felt-and-brass, F major for anything pitched); short; never harsh
// (the 2–5 kHz "ouch" band is only touched by very short transients).
import type { SfxName } from '../contracts.js';
import type { Ev } from './core.js';
import { envAD, envAHD, envSwell, glide, midiHz, MIN_RAMP, path, PopWriter, rnd } from './dsp.js';

export interface SfxSpec {
  /** Voice-steal priority (0 = hover … 3 = key moment). */
  prio: number;
  /** Reverb send (pre-panner). */
  send: number;
  /** Output trim, balanced against the offline report. */
  trim: number;
  play: (ev: Ev) => number;
}

/** One decaying sine partial (bells, tines, rings). Returns its end time. */
function partial(ev: Ev, f: number, amp: number, tau: number, t: number, wave: OscillatorType = 'sine', attack = MIN_RAMP): number {
  const g = ev.gain(0, ev.out);
  const end = envAD(g.gain, t, amp, attack, tau);
  ev.osc(wave, ev.safe(f), t, end + 0.01, g);
  return end;
}

// --------------------------------------------------------------------------------------- sleight foley

/** Proximity cue as fingers close on a prop: a tiny glassy ting. */
function tink(ev: Ev): number {
  const t = ev.t;
  const f = ev.hz(2637 * (1 + (ev.rng() - 0.5) * 0.04));
  return Math.max(partial(ev, f, 0.5, 0.085, t), partial(ev, f * 2.71, 0.18, 0.04, t), partial(ev, f * 5.13, 0.07, 0.02, t));
}

/** Palm: a quick rising cloth whoosh with a hint of cartoon zip. */
function fwip(ev: Ev): number {
  const t = ev.t;
  const g = ev.gain(0, ev.out);
  const bp = ev.filter('bandpass', 700, 1.3, g);
  path(bp.frequency, t, [ev.hz(650), ev.hz(4000), ev.hz(2500)], [0.085, 0.07]);
  const end = envAHD(g.gain, t, 1, 0.014, 0.03, 0.03, t + 0.22);
  ev.noise('white', t, end + 0.01, bp);
  const g2 = ev.gain(0, ev.out);
  const lp = ev.filter('lowpass', 900, 0.7, g2);
  const e2 = envAHD(g2.gain, t, 0.45, 0.012, 0.02, 0.03, t + 0.2);
  ev.noise('pink', t, e2 + 0.01, lp);
  const g3 = ev.gain(0, ev.out);
  const e3 = envAD(g3.gain, t + 0.005, 0.07, 0.01, 0.025, t + 0.14);
  const o = ev.osc('triangle', ev.hz(520), t + 0.005, e3 + 0.01, g3);
  glide(o.frequency, t + 0.005, ev.hz(520), ev.hz(1500), 0.08);
  return Math.max(end, e2, e3);
}

/** Load: a secretive "shhk" and a muffled tuk as the prop settles under the cup. */
function shh(ev: Ev): number {
  const t = ev.t;
  const g = ev.gain(0, ev.out);
  const hp = ev.filter('highpass', 1800, 0.7, g);
  const bp = ev.filter('bandpass', ev.hz(3800), 1.1, hp);
  const end = envAHD(g.gain, t, 1, 0.035, 0.07, 0.05, t + 0.36);
  ev.noise('white', t, end + 0.01, bp);
  const tk = t + 0.17;
  const g2 = ev.gain(0, ev.out);
  const e2 = envAD(g2.gain, tk, 0.35, 0.006, 0.035);
  const o = ev.osc('sine', ev.hz(170), tk, e2 + 0.01, g2);
  glide(o.frequency, tk, ev.hz(170), ev.hz(105), 0.06);
  const g3 = ev.gain(0, ev.out);
  const lp = ev.filter('lowpass', 1300, 0.7, g3);
  const e3 = envAD(g3.gain, tk, 0.5, 0.005, 0.012, tk + 0.09);
  ev.noise('white', tk, e3 + 0.01, lp);
  return Math.max(end, e2, e3);
}

/** Reveal: a soft smoke puff, a whump and a rising pentatonic sparkle. */
function poof(ev: Ev): number {
  const t = ev.t;
  const g = ev.gain(0, ev.out);
  const lp = ev.filter('lowpass', 4500, 0.9, g);
  glide(lp.frequency, t, ev.hz(5200), ev.hz(380), 0.38);
  const end = envAHD(g.gain, t, 1, 0.008, 0.02, 0.11, t + 0.75);
  ev.noise('pink', t, end + 0.01, lp);
  const g2 = ev.gain(0, ev.out);
  const e2 = envAD(g2.gain, t, 0.55, 0.006, 0.07);
  const o = ev.osc('sine', ev.hz(125), t, e2 + 0.01, g2);
  glide(o.frequency, t, ev.hz(125), ev.hz(52), 0.18);
  const notes = [1760, 2093, 2349, 2794, 3520]; // A6 C7 D7 F7 A7 — F major pentatonic
  let e3 = t;
  for (let i = 0; i < notes.length; i++) {
    const tn = t + 0.04 + i * 0.045 + ev.rng() * 0.01;
    e3 = Math.max(e3, partial(ev, ev.hz(notes[i]), 0.11 * (1 - i * 0.08), 0.12, tn));
  }
  return Math.max(end, e2, e3);
}

/** A copper cup set down on velvet: muffled knock + short hollow ring (modal partials). */
function cupThunk(ev: Ev): number {
  const t = ev.t;
  const g = ev.gain(0, ev.out);
  const e1 = envAD(g.gain, t, 0.6, 0.005, 0.045);
  const o = ev.osc('sine', ev.hz(230), t, e1 + 0.01, g);
  glide(o.frequency, t, ev.hz(230), ev.hz(150), 0.05);
  const e2 = Math.max(
    partial(ev, ev.hz(720), 0.2, 0.07, t),
    partial(ev, ev.hz(1930), 0.08, 0.035, t),
    partial(ev, ev.hz(2650), 0.035, 0.02, t),
  );
  const g3 = ev.gain(0, ev.out);
  const lp = ev.filter('lowpass', 2200, 0.7, g3);
  const e3 = envAD(g3.gain, t, 0.55, 0.005, 0.01, t + 0.07);
  ev.noise('white', t, e3 + 0.01, lp);
  return Math.max(e1, e2, e3);
}

/** Lifting a cup: a little suction pop, air rushing in, a faint copper ring. */
function cupLift(ev: Ev): number {
  const t = ev.t;
  const gp = ev.gain(0, ev.out);
  const ep = envAD(gp.gain, t, 0.16, 0.006, 0.03);
  const op = ev.osc('sine', ev.hz(360), t, ep + 0.01, gp);
  glide(op.frequency, t, ev.hz(360), ev.hz(640), 0.05);
  const g = ev.gain(0, ev.out);
  const lp = ev.filter('lowpass', 300, 0.8, g);
  glide(lp.frequency, t, 300, ev.hz(1900), 0.26);
  const end = envAHD(g.gain, t, 0.8, 0.09, 0.08, 0.07, t + 0.55);
  ev.noise('pink', t, end + 0.01, lp);
  const e3 = Math.max(partial(ev, ev.hz(880), 0.06, 0.22, t + 0.03), partial(ev, ev.hz(2387), 0.025, 0.09, t + 0.03));
  return Math.max(end, ep, e3);
}

// ---------------------------------------------------------------------------------------------- gadgets

/** Candle flare: the flame leaps (rising band whoosh + fwoomph) and crackles. */
function flare(ev: Ev): number {
  const t = ev.t;
  const r = ev.rng;
  const g = ev.gain(0, ev.out);
  const bp = ev.filter('bandpass', 400, 0.8, g);
  path(bp.frequency, t, [ev.hz(380), ev.hz(2300), ev.hz(900)], [0.28, 0.9]);
  const end = envSwell(g.gain, t, 1, 0.07, t + 0.35, 0.32, t + 1.9);
  ev.noise('pink', t, end + 0.01, bp);
  const g2 = ev.gain(0, ev.out);
  const lp = ev.filter('lowpass', 260, 0.7, g2);
  const e2 = envAHD(g2.gain, t, 1.4, 0.03, 0.05, 0.15, t + 0.95);
  ev.noise('white', t, e2 + 0.01, lp);
  const gc = ev.gain(0, ev.out);
  const hp = ev.filter('highpass', 2400, 0.7, gc);
  const pw = new PopWriter(gc.gain, MIN_RAMP, 0.006);
  for (let tc = t + 0.08; tc < t + 1.45; tc += rnd(r, 0.03, 0.14)) pw.pop(tc, rnd(r, 0.15, 0.55) * (1 - (tc - t) / 1.6));
  const e3 = pw.close();
  ev.noise('white', t, e3 + 0.01, hp);
  return Math.max(end, e2, e3);
}

/** One burst of fuse sizzle (the looping version is engine.loop('fuse')). */
function fuse(ev: Ev): number {
  const t = ev.t;
  const g = ev.gain(0, ev.out);
  const end = envSwell(g.gain, t, 0.7, 0.02, t + 1.0, 0.08, t + 1.5);
  ev.buffer(ev.res.fuse, t, end + 0.01, g, true, ev.pitch);
  return end;
}

/** Firework: crack, warm boom, chest thump, then falling sparks. Big but rounded. */
function bang(ev: Ev): number {
  const t = ev.t;
  const r = ev.rng;
  const g = ev.gain(0, ev.out);
  const lp = ev.filter('lowpass', 2400, 0.7, g);
  glide(lp.frequency, t, ev.hz(2600), ev.hz(150), 0.3);
  const end = envAHD(g.gain, t, 1.4, 0.006, 0.015, 0.24, t + 1.7);
  ev.noise('white', t, end + 0.01, lp);
  const g2 = ev.gain(0, ev.out);
  const e2 = envAD(g2.gain, t, 0.75, 0.006, 0.17, t + 1.25);
  const o1 = ev.osc('sine', ev.hz(98), t, e2 + 0.01, g2);
  glide(o1.frequency, t, ev.hz(98), ev.hz(40), 0.38);
  const g2b = ev.gain(0, ev.out);
  const e2b = envAD(g2b.gain, t, 0.3, 0.006, 0.09, t + 0.75);
  const o2 = ev.osc('triangle', ev.hz(196), t, e2b + 0.01, g2b);
  glide(o2.frequency, t, ev.hz(196), ev.hz(80), 0.3);
  const g3 = ev.gain(0, ev.out);
  const bp = ev.filter('bandpass', ev.hz(2800), 0.8, g3);
  const e3 = envAD(g3.gain, t, 0.9, 0.005, 0.018, t + 0.16);
  ev.noise('white', t, e3 + 0.01, bp);
  const gc = ev.gain(0, ev.out);
  const hp = ev.filter('highpass', 3200, 0.7, gc);
  const pw = new PopWriter(gc.gain, MIN_RAMP, 0.005);
  for (let tc = t + 0.22; tc < t + 2.3; ) {
    const u = (tc - t) / 2.3;
    pw.pop(tc, rnd(r, 0.2, 0.7) * (1 - u) * (1 - u), rnd(r, 0.003, 0.008));
    tc += rnd(r, 0.025, 0.12) * (1 + u * 1.5);
  }
  const e4 = pw.close();
  ev.noise('white', t + 0.2, e4 + 0.01, hp);
  const gf = ev.gain(0, ev.out);
  const bpf = ev.filter('bandpass', ev.hz(6500), 1.5, gf);
  const e5 = envSwell(gf.gain, t + 0.25, 0.25, 0.12, t + 0.6, 0.45, t + 2.6);
  ev.noise('white', t + 0.25, e5 + 0.01, bpf);
  return Math.max(end, e2, e2b, e3, e4, e5);
}

/** Winding the music box: a ratchet of tiny clicks with a spring ping that tightens. */
function musicBoxWind(ev: Ev): number {
  const t = ev.t;
  const r = ev.rng;
  const gc = ev.gain(0, ev.out);
  const bp = ev.filter('bandpass', ev.hz(3600), 3.5, gc);
  const clicks = new PopWriter(gc.gain, MIN_RAMP, 0.007);
  const gp = ev.gain(0, ev.out);
  const pings = new PopWriter(gp.gain, MIN_RAMP, 0.03);
  const times: number[] = [];
  let tc = t;
  for (let i = 0; i < 9; i++) {
    times.push(tc);
    clicks.pop(tc, rnd(r, 0.7, 1));
    pings.pop(tc, 0.12);
    tc += 0.075 - i * 0.003 + rnd(r, -0.006, 0.006);
  }
  const e1 = clicks.close();
  const e2 = pings.close();
  ev.noise('white', t, e1 + 0.01, bp);
  const o = ev.osc('sine', ev.hz(2400), t, e2 + 0.01, gp);
  for (let i = 0; i < times.length; i++) o.frequency.setValueAtTime(ev.hz(2400 * (1 + i * 0.012)), times[i]);
  return Math.max(e1, e2);
}

// --------------------------------------------------------------------------------------------------- UI

function uiHover(ev: Ev): number {
  const t = ev.t;
  return Math.max(partial(ev, ev.hz(1568), 0.12, 0.016, t), partial(ev, ev.hz(3136), 0.025, 0.008, t));
}

function uiPress(ev: Ev): number {
  const t = ev.t;
  const g = ev.gain(0, ev.out);
  const e1 = envAD(g.gain, t, 0.3, 0.005, 0.04);
  const o = ev.osc('sine', ev.hz(840), t, e1 + 0.01, g);
  glide(o.frequency, t, ev.hz(840), ev.hz(520), 0.05);
  const g2 = ev.gain(0, ev.out);
  const bp = ev.filter('bandpass', ev.hz(1800), 1.2, g2);
  const e2 = envAD(g2.gain, t, 0.17, 0.006, 0.012, t + 0.08); // a soft felt "tock", not a click
  ev.noise('white', t, e2 + 0.01, bp);
  const e3 = partial(ev, ev.hz(262), 0.12, 0.04, t, 'triangle');
  return Math.max(e1, e2, e3);
}

// ------------------------------------------------------------------------------------------ stage beats

/** Caught! A playful record scratch, then a muted "wah-wah". */
function catchSting(ev: Ev): number {
  const t = ev.t;
  const g = ev.gain(0, ev.out);
  const bp = ev.filter('bandpass', 1000, 2.2, g);
  path(bp.frequency, t, [ev.hz(700), ev.hz(2600), ev.hz(600), ev.hz(2100), ev.hz(500)], [0.09, 0.11, 0.07, 0.1]);
  const end = envAHD(g.gain, t, 0.9, 0.008, 0.33, 0.03, t + 0.52);
  const saw = ev.osc('sawtooth', ev.hz(170), t, end + 0.01, bp);
  path(saw.frequency, t, [ev.hz(170), ev.hz(820), ev.hz(140), ev.hz(640), ev.hz(120)], [0.09, 0.11, 0.07, 0.1]);
  ev.noise('white', t, end + 0.01, ev.gain(0.6, bp));
  let last = end;
  const notes: ReadonlyArray<readonly [number, number, number, number]> = [
    [0.44, midiHz(70), midiHz(70), 0.13], // Bb4
    [0.6, midiHz(67), midiHz(66), 0.34], // G4 bending flat
  ];
  for (const [dt, f0, f1, len] of notes) {
    const tn = t + dt;
    const gn = ev.gain(0, ev.out);
    const lpn = ev.filter('lowpass', 600, 4, gn);
    path(lpn.frequency, tn, [ev.hz(500), ev.hz(1700), ev.hz(650)], [len * 0.35, len * 0.6]);
    const en = envAHD(gn.gain, tn, 0.3, 0.01, len * 0.55, len * 0.18, tn + len + 0.12);
    const on = ev.osc(ev.res.pulse, ev.hz(f0), tn, en + 0.01, lpn);
    glide(on.frequency, tn + len * 0.3, ev.hz(f0), ev.hz(f1), len * 0.6);
    last = Math.max(last, en);
  }
  return last;
}

/** Rewind: tape spooling backwards — a warbling chipmunk sweep down against a rising whoosh. */
function rewind(ev: Ev): number {
  const t = ev.t;
  const d = 0.68;
  const g = ev.gain(0, ev.out);
  const bp = ev.filter('bandpass', 1500, 1.4, g);
  glide(bp.frequency, t, ev.hz(2800), ev.hz(700), d);
  const end = envSwell(g.gain, t, 0.55, 0.16, t + d - 0.06, 0.03, t + d + 0.12);
  const o = ev.osc('sawtooth', ev.hz(1300), t, end + 0.01, bp);
  glide(o.frequency, t, ev.hz(1300), ev.hz(250), d);
  ev.osc('sine', 21, t, end + 0.01, ev.gain(260, o.detune));
  const g2 = ev.gain(0, ev.out);
  const bp2 = ev.filter('bandpass', 700, 0.9, g2);
  glide(bp2.frequency, t, ev.hz(600), ev.hz(3600), d);
  const e2 = envSwell(g2.gain, t, 0.6, 0.22, t + d - 0.05, 0.03, t + d + 0.12);
  ev.noise('pink', t, e2 + 0.01, bp2);
  return Math.max(end, e2);
}

/** A star earned: glockenspiel arpeggio up the F major triad over a soft warm bed. */
function star(ev: Ev): number {
  const t = ev.t;
  const notes = [1397, 1760, 2093, 2794]; // F6 A6 C7 F7
  let end = t;
  for (let i = 0; i < notes.length; i++) {
    const tn = t + i * 0.075;
    const last = i === notes.length - 1;
    const f = ev.hz(notes[i]);
    end = Math.max(end, partial(ev, f, last ? 0.22 : 0.16, last ? 0.5 : 0.3, tn), partial(ev, f * 2.76, 0.035, 0.05, tn));
  }
  for (const m of [77, 81, 84]) end = Math.max(end, partial(ev, ev.hz(midiHz(m)), 0.04, 0.45, t + 0.01, 'triangle', 0.03));
  const gs = ev.gain(0, ev.out);
  const bps = ev.filter('bandpass', ev.hz(7500), 2.5, gs);
  const es = envSwell(gs.gain, t + 0.05, 0.2, 0.1, t + 0.4, 0.3);
  ev.noise('white', t + 0.05, es + 0.01, bps);
  return Math.max(end, es);
}

/** Velvet curtain sweeping across, a few fabric flaps, the hem landing. */
function curtain(ev: Ev): number {
  const t = ev.t;
  const r = ev.rng;
  const g = ev.gain(0, ev.out);
  const lp = ev.filter('lowpass', 1100, 0.6, g);
  const bp = ev.filter('bandpass', 300, 0.7, lp);
  path(bp.frequency, t, [ev.hz(260), ev.hz(750), ev.hz(380)], [0.6, 0.8]);
  const end = envSwell(g.gain, t, 1, 0.14, t + 1.0, 0.28, t + 2.1);
  ev.noise('pink', t, end + 0.01, bp);
  const gf = ev.gain(0, ev.out);
  const bpf = ev.filter('bandpass', ev.hz(1500), 1.2, gf);
  const pw = new PopWriter(gf.gain, 0.012, 0.035);
  for (let tf = t + 0.1; tf < t + 1.25; tf += rnd(r, 0.12, 0.24)) pw.pop(tf, rnd(r, 0.15, 0.35));
  const e2 = pw.close();
  ev.noise('white', t, e2 + 0.01, bpf);
  const tt = t + 1.15;
  const gt = ev.gain(0, ev.out);
  const e3 = envAD(gt.gain, tt, 0.3, 0.008, 0.08);
  const o = ev.osc('sine', ev.hz(95), tt, e3 + 0.01, gt);
  glide(o.frequency, tt, ev.hz(95), ev.hz(58), 0.12);
  return Math.max(end, e2, e3);
}

/** The newspaper review: a page flip with a crinkle and a soft snap. */
function pageFlip(ev: Ev): number {
  const t = ev.t;
  const r = ev.rng;
  const g = ev.gain(0, ev.out);
  const bp = ev.filter('bandpass', 1500, 0.8, g);
  glide(bp.frequency, t, ev.hz(1400), ev.hz(4600), 0.18);
  const end = envAHD(g.gain, t, 0.9, 0.02, 0.06, 0.05, t + 0.36);
  ev.noise('white', t, end + 0.01, bp);
  const gc = ev.gain(0, ev.out);
  const hp = ev.filter('highpass', 3000, 0.7, gc);
  const pw = new PopWriter(gc.gain, MIN_RAMP, 0.006);
  let tc = t + 0.01;
  for (let i = 0; i < 7; i++) {
    pw.pop(tc, rnd(r, 0.2, 0.5));
    tc += rnd(r, 0.015, 0.03);
  }
  const e2 = pw.close();
  ev.noise('white', t, e2 + 0.01, hp);
  const ts = t + 0.17;
  const gs = ev.gain(0, ev.out);
  const bps = ev.filter('bandpass', ev.hz(2500), 2, gs);
  const e3 = envAD(gs.gain, ts, 0.6, 0.005, 0.015, ts + 0.12);
  ev.noise('white', ts, e3 + 0.01, bps);
  return Math.max(end, e2, e3);
}

/** Sir Brock scribbling: pencil strokes whose resonance zig-zags. */
function scribble(ev: Ev): number {
  const t = ev.t;
  const r = ev.rng;
  const g = ev.gain(0, ev.out);
  const hp = ev.filter('highpass', 1500, 0.7, g);
  const bp = ev.filter('bandpass', 3000, 4, hp);
  const pw = new PopWriter(g.gain, 0.012, 0.04);
  let ts = t;
  for (let i = 0; i < 7; i++) {
    const len = rnd(r, 0.07, 0.14);
    pw.pop(ts, rnd(r, 0.5, 0.9), len * 0.45);
    bp.frequency.setValueAtTime(ev.hz(rnd(r, 2600, 3300)), ts);
    bp.frequency.linearRampToValueAtTime(ev.hz(rnd(r, 3600, 4400)), ts + len);
    ts += len + rnd(r, 0.03, 0.07);
  }
  const end = pw.close();
  ev.noise('white', t, end + 0.01, bp);
  return end;
}

/** A felt puppet hops: soft upward "bwip" + a little puff of felt. */
function hop(ev: Ev): number {
  const t = ev.t;
  const g = ev.gain(0, ev.out);
  const e1 = envAHD(g.gain, t, 0.3, 0.006, 0.05, 0.04, t + 0.3);
  const o = ev.osc('sine', ev.hz(230), t, e1 + 0.01, g);
  glide(o.frequency, t, ev.hz(230), ev.hz(720), 0.1);
  const g2 = ev.gain(0, ev.out);
  const e2 = envAHD(g2.gain, t, 0.08, 0.006, 0.04, 0.03, t + 0.25);
  const o2 = ev.osc('triangle', ev.hz(460), t, e2 + 0.01, g2);
  glide(o2.frequency, t, ev.hz(460), ev.hz(1440), 0.1);
  const g3 = ev.gain(0, ev.out);
  const lp = ev.filter('lowpass', 1200, 0.7, g3);
  const e3 = envAD(g3.gain, t, 0.35, 0.006, 0.02, t + 0.12);
  ev.noise('pink', t, e3 + 0.01, lp);
  return Math.max(e1, e2, e3);
}

/** One pocket-watch tick (the looping version is engine.loop('tick')). */
function tick(ev: Ev): number {
  const t = ev.t;
  const g = ev.gain(0, ev.out);
  const bp = ev.filter('bandpass', ev.hz(4200), 5, g);
  const e1 = envAD(g.gain, t, 1.2, 0.005, 0.006, t + 0.06);
  ev.noise('white', t, e1 + 0.01, bp);
  return Math.max(e1, partial(ev, ev.hz(3150), 0.07, 0.02, t), partial(ev, ev.hz(1650), 0.04, 0.012, t));
}

/**
 * Trims are calibrated against the offline report (src/audio/offline.ts, loudest-50 ms window at the final
 * output, from each sound's stage position). Targets: UI hover ≈ -34 dBFS, quiet foley (tink, tick, scribble)
 * -30…-22, sleight foley -17…-15, reveals/stings -13…-12, the firework ≈ -11 — voices sit at ≈ -15 and the
 * café trio ≈ -26, so music always stays under foley and speech.
 */
export const SFX: Record<SfxName, SfxSpec> = {
  tink: { prio: 1, send: 0.12, trim: 0.95, play: tink },
  fwip: { prio: 2, send: 0.1, trim: 2.35, play: fwip },
  shh: { prio: 2, send: 0.14, trim: 0.81, play: shh },
  poof: { prio: 3, send: 0.35, trim: 1.41, play: poof },
  cupThunk: { prio: 2, send: 0.15, trim: 1.2, play: cupThunk },
  cupLift: { prio: 2, send: 0.18, trim: 1.1, play: cupLift },
  flare: { prio: 2, send: 0.25, trim: 2.3, play: flare },
  fuse: { prio: 2, send: 0.12, trim: 2, play: fuse },
  bang: { prio: 3, send: 0.45, trim: 1.65, play: bang },
  musicBoxWind: { prio: 2, send: 0.12, trim: 2.7, play: musicBoxWind },
  uiHover: { prio: 0, send: 0.04, trim: 1.8, play: uiHover },
  uiPress: { prio: 1, send: 0.08, trim: 1.25, play: uiPress },
  catch: { prio: 3, send: 0.15, trim: 1.2, play: catchSting },
  rewind: { prio: 3, send: 0.1, trim: 1.33, play: rewind },
  star: { prio: 3, send: 0.3, trim: 1.17, play: star },
  curtain: { prio: 2, send: 0.25, trim: 0.72, play: curtain },
  pageFlip: { prio: 1, send: 0.1, trim: 0.8, play: pageFlip },
  scribble: { prio: 1, send: 0.08, trim: 1.68, play: scribble },
  hop: { prio: 1, send: 0.08, trim: 1.13, play: hop },
  tick: { prio: 1, send: 0.06, trim: 3.4, play: tick },
};

export const SFX_NAMES = Object.keys(SFX) as SfxName[];
