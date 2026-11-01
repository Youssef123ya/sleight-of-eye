// The tiny felt audience as a crowd (owned by A): oohs, gasps, giggles, applause and a standing ovation.
// Small creatures → high voices and soft felt paws. Applause is N "clappers", each one resonant band-pass fed
// by a shared noise hub and played as a single automated pop train (3 nodes per clapper, not 3 per clap).
import type { CrowdKind } from '../contracts.js';
import type { Ev } from './core.js';
import { envAHD, envAD, envSwell, glide, MIN_RAMP, path, PopWriter, rnd, semis } from './dsp.js';

const KIT_FMT = 1.3; // small vocal tracts

/** "Ooooh": a vowel swell from several voices that opens from "oo" to "oh". */
function ooh(ev: Ev, I: number): number {
  const t = ev.t;
  const r = ev.rng;
  const n = 3 + Math.round(3 * I);
  const sum = ev.gain(1, ev.out);
  const f1 = ev.filter('bandpass', 330 * KIT_FMT, 3.5, ev.gain(2.2, sum));
  const f2 = ev.filter('bandpass', 860 * KIT_FMT, 5, ev.gain(1.3, sum));
  const body = ev.filter('lowpass', 900, 0.7, ev.gain(0.35, sum));
  path(f1.frequency, t, [330 * KIT_FMT, 470 * KIT_FMT, 400 * KIT_FMT], [0.45, 0.8]);
  path(f2.frequency, t, [860 * KIT_FMT, 920 * KIT_FMT, 840 * KIT_FMT], [0.45, 0.8]);
  const vib = ev.gain(16, null); // shared vibrato depth (cents)
  const amp = (0.29 * (0.65 + 0.35 * I)) / Math.sqrt(n);
  let end = t;
  for (let i = 0; i < n; i++) {
    const ts = t + (i === 0 ? 0 : rnd(r, 0.02, 0.16));
    const f0 = ev.hz(rnd(r, 330, 540));
    const vg = ev.gain(0, f1);
    vg.connect(f2);
    vg.connect(body);
    const e = envSwell(vg.gain, ts, amp, 0.11, ts + rnd(r, 0.7, 0.85), 0.2);
    const o = ev.osc('sawtooth', f0, ts, e + 0.01, vg);
    path(o.frequency, ts, [f0 * 0.95, f0 * 1.07, f0 * 0.88], [0.42, 0.85]);
    vib.connect(o.detune);
    end = Math.max(end, e);
  }
  ev.osc('sine', 5.2, t, end + 0.01, vib);
  return end;
}

/** Sharp inhales: rising breath formants with a tiny voiced catch, staggered across the seats. */
function gasp(ev: Ev, I: number): number {
  const t = ev.t;
  const r = ev.rng;
  const n = 2 + Math.round(3 * I);
  let end = t;
  for (let i = 0; i < n; i++) {
    const ts = t + (i === 0 ? 0 : rnd(r, 0.03, 0.22));
    const amp = (i === 0 ? 1 : rnd(r, 0.55, 0.9)) * (0.6 + 0.4 * I) * 2.45;
    const g = ev.gain(0, ev.out);
    const bp = ev.filter('bandpass', 900, 1.8, g);
    glide(bp.frequency, ts, ev.hz(rnd(r, 800, 1000)), ev.hz(rnd(r, 2100, 2600)), 0.16);
    const e = envAHD(g.gain, ts, amp, 0.025, 0.06, 0.045, ts + 0.42);
    ev.noise('white', ts, e + 0.01, bp);
    const tv = ts + 0.03;
    const vg = ev.gain(0, ev.out);
    const vf = ev.filter('bandpass', ev.hz(1400), 2.5, vg);
    const e2 = envAD(vg.gain, tv, amp * 0.3, 0.01, 0.035, tv + 0.25);
    const fv = ev.hz(rnd(r, 620, 880));
    const o = ev.osc('triangle', fv, tv, e2 + 0.01, vf);
    glide(o.frequency, tv, fv, fv * 1.3, 0.08);
    end = Math.max(end, e, e2);
  }
  return end;
}

/** "Hee-hee-hee": staccato voiced blips falling in pitch, with breathy onsets. */
function giggle(ev: Ev, I: number): number {
  const t = ev.t;
  const r = ev.rng;
  const n = 1 + Math.round(2 * I);
  let end = t;
  for (let j = 0; j < n; j++) {
    const ts = t + (j === 0 ? 0 : rnd(r, 0.08, 0.3));
    const f0 = ev.hz(rnd(r, 470, 720));
    const env = ev.gain(0, ev.out);
    const lp = ev.filter('lowpass', 6500, 0.6, env);
    const fa = ev.filter('bandpass', 380 * 1.35, 4, ev.gain(2.2, lp));
    const fb = ev.filter('bandpass', 2250 * 1.35, 6, ev.gain(1.6, lp));
    const body = ev.filter('lowpass', f0 * 2, 0.7, ev.gain(0.3, lp));
    const nEnv = ev.gain(0, lp);
    const nb = ev.filter('bandpass', 2400, 1.2, nEnv);
    const blips = 5 + Math.floor(r() * 3);
    const period = rnd(r, 0.085, 0.105);
    const times: number[] = [];
    for (let k = 0; k < blips; k++) times.push(ts + k * period * (1 + k * 0.04));
    const stop = times[blips - 1] + 0.22;
    const o = ev.osc(ev.res.pulse, f0, ts, stop, fa);
    o.connect(fb);
    o.connect(body);
    ev.noise('white', ts, stop, nb);
    const voiced = new PopWriter(env.gain, MIN_RAMP, 0.022);
    const breath = new PopWriter(nEnv.gain, MIN_RAMP, 0.018);
    const lvl = 0.54 * (0.7 + 0.3 * I);
    for (let k = 0; k < blips; k++) {
      const tk = times[k];
      const f = f0 * semis(3 - k * 0.9 + rnd(r, -0.4, 0.4));
      o.frequency.setValueAtTime(f * semis(-1.5), tk);
      o.frequency.exponentialRampToValueAtTime(f, tk + 0.02);
      voiced.pop(tk, lvl * (1 - k * 0.07));
      breath.pop(tk, lvl * 0.3);
    }
    end = Math.max(end, voiced.close(), breath.close(), stop);
  }
  return end;
}

/**
 * Applause: `n` felt-pawed clappers. Each claps at its own 3.6–5.4 Hz with jitter; the crowd swells in,
 * sustains, then thins out (clappers drop out, the rest slow down and soften).
 */
function applause(ev: Ev, I: number, dur: number, clappers?: number): number {
  const t = ev.t;
  const r = ev.rng;
  const n = clappers ?? 3 + Math.round(9 * I);
  const hubW = ev.gain(1, null);
  const hubP = ev.gain(1.6, null);
  // louder per clap AND more clappers with intensity: a polite patter at 0.3, a roar at 1
  const level = 1.85 * (0.55 + 0.45 * I);
  let end = t;
  for (let c = 0; c < n; c++) {
    const g = ev.gain(0, ev.out);
    const bp = ev.filter('bandpass', ev.hz(rnd(r, 800, 2200)), rnd(r, 1.1, 2), g);
    (c % 2 ? hubP : hubW).connect(bp);
    const pw = new PopWriter(g.gain, MIN_RAMP, rnd(r, 0.012, 0.02));
    const rate = rnd(r, 3.6, 5.4);
    const stopAt = t + dur * rnd(r, 0.62, 1);
    for (let tc = t + rnd(r, 0, 0.28); tc < stopAt; ) {
      const u = (tc - t) / dur;
      const swell = Math.min(1, u / 0.12 + 0.25);
      const fade = u > 0.55 ? Math.pow(Math.max(0, 1 - (u - 0.55) / 0.45), 1.3) : 1;
      pw.pop(tc, level * swell * fade * rnd(r, 0.7, 1));
      tc += (1 / rate) * rnd(r, 0.88, 1.12) * (u > 0.6 ? 1 + (u - 0.6) * 0.9 : 1);
    }
    end = Math.max(end, pw.close());
  }
  ev.noise('white', t, end + 0.01, hubW);
  ev.noise('pink', t, end + 0.01, hubP);
  return end;
}

/** A small "yay!" or "woo!" from one spectator. */
function cheer(ev: Ev, tc: number, kind: 'yay' | 'woo', I: number): number {
  const r = ev.rng;
  const f0 = ev.hz(rnd(r, 420, 640));
  const env = ev.gain(0, ev.out);
  const lp = ev.filter('lowpass', 5500, 0.6, env);
  const fa = ev.filter('bandpass', 700 * KIT_FMT, 4, ev.gain(2.2, lp));
  const fb = ev.filter('bandpass', 1500 * KIT_FMT, 6, ev.gain(1.5, lp));
  const body = ev.filter('lowpass', f0 * 2.2, 0.7, ev.gain(0.3, lp));
  const dur = rnd(r, 0.38, 0.5);
  const e = envSwell(env.gain, tc, 0.3 * (0.7 + 0.3 * I), 0.025, tc + dur, 0.07);
  const o = ev.osc('sawtooth', f0, tc, e + 0.01, fa);
  o.connect(fb);
  o.connect(body);
  if (kind === 'yay') {
    path(fa.frequency, tc, [700 * KIT_FMT, 760 * KIT_FMT, 420 * KIT_FMT], [0.08, dur]);
    path(fb.frequency, tc, [1500 * KIT_FMT, 1800 * KIT_FMT, 2300 * KIT_FMT], [0.08, dur]);
    path(o.frequency, tc, [f0, f0 * semis(4), f0 * semis(2)], [0.12, dur]);
  } else {
    path(fa.frequency, tc, [330 * KIT_FMT, 420 * KIT_FMT], [dur]);
    path(fb.frequency, tc, [800 * KIT_FMT, 1000 * KIT_FMT], [dur]);
    path(o.frequency, tc, [f0 * semis(-2), f0 * semis(5), f0 * semis(3)], [0.18, dur]);
  }
  return e;
}

/** A soft "fwee-whoo" whistle. */
function whistle(ev: Ev, tw: number, I: number): number {
  const g = ev.gain(0, ev.out);
  const e = envSwell(g.gain, tw, 0.05 * (0.7 + 0.3 * I), 0.02, tw + 0.62, 0.05);
  const o = ev.osc('sine', ev.hz(1700), tw, e + 0.01, g);
  path(o.frequency, tw, [ev.hz(1650), ev.hz(2900), ev.hz(2950), ev.hz(1750)], [0.18, 0.12, 0.3]);
  return e;
}

/** Standing ovation: dense applause + cheers + whistles. */
function ovation(ev: Ev, I: number): number {
  const t = ev.t;
  const r = ev.rng;
  let end = applause(ev, Math.max(0.85, I), 4.6, 12);
  const cheers = 3 + Math.round(2 * I);
  for (let i = 0; i < cheers; i++) end = Math.max(end, cheer(ev, t + 0.1 + rnd(r, 0, 2.4), r() < 0.5 ? 'yay' : 'woo', I));
  const whistles = I > 0.6 ? 2 : 1;
  for (let i = 0; i < whistles; i++) end = Math.max(end, whistle(ev, t + rnd(r, 0.3, 2.2), I));
  return end;
}

export function crowdSound(ev: Ev, kind: CrowdKind, I: number): number {
  switch (kind) {
    case 'ooh':
      return ooh(ev, I);
    case 'gasp':
      return gasp(ev, I);
    case 'giggle':
      return giggle(ev, I);
    case 'applause':
      return applause(ev, I, 1.6 + 2.6 * I);
    case 'ovation':
      return ovation(ev, I);
    default:
      return ev.t;
  }
}

export const CROWD_PRIORITY: Record<CrowdKind, number> = { ooh: 2, gasp: 2, giggle: 2, applause: 3, ovation: 3 };
