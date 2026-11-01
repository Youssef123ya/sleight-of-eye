// Animalese (owned by A): one formant-filtered pulse per letter, 45 ms each, so a line lasts ≈ length × 45 ms.
// A whole utterance is ONE oscillator + one noise source through a small formant bank whose filters, pitch and
// envelope are automated per letter — about 15 nodes regardless of length. Lines are deterministic (seeded by
// the text), so a spectator says the same line the same way every time, like a real voice.
import type { Mood, SpectatorKind } from '../contracts.js';
import type { Ev } from './core.js';
import { clamp, hashString, MIN_RAMP, mulberry32, PopWriter, rnd, semis, TargetChain } from './dsp.js';

export const LETTER_STEP = 0.045;
const VOICE_ATTACK_MIN = 0.006;

interface VoiceProfile {
  /** Base pitch (Hz): body size. */
  f0: number;
  /** Formant scale: small vocal tract → brighter vowels. */
  fmt: number;
  src: 'saw' | 'pulse' | 'reed';
  /** Output low-pass: overall brightness. */
  lp: number;
  /** Per-letter upward flick in semitones (the magpie's chirp). */
  chirp: number;
  /** 0..1 pull of every vowel toward "o" (Sir Brock's plummy voice). */
  round: number;
  level: number;
  /** Envelope attack time constant. */
  attack: number;
  /** Inter-letter floor (0..1 of the letter level): legato vs. staccato. */
  legato: number;
}

const PROFILES: Record<SpectatorKind, VoiceProfile> = {
  fox: { f0: 520, fmt: 1.3, src: 'saw', lp: 6200, chirp: 0, round: 0, level: 1.1, attack: 0.006, legato: 0.14 },
  magpie: { f0: 780, fmt: 1.48, src: 'pulse', lp: 8000, chirp: 4.5, round: 0, level: 0.85, attack: 0.006, legato: 0.06 },
  badger: { f0: 138, fmt: 0.9, src: 'saw', lp: 2300, chirp: 0, round: 0.45, level: 1.3, attack: 0.008, legato: 0.24 },
  rabbit: { f0: 350, fmt: 1.16, src: 'reed', lp: 5200, chirp: 0, round: 0.1, level: 0.4, attack: 0.006, legato: 0.12 },
};

type Vowel = 'a' | 'e' | 'i' | 'o' | 'u' | 'x';
/** F1, F2 for a reference (adult) vocal tract; 'x' = schwa. */
const FORMANTS: Record<Vowel, readonly [number, number]> = {
  a: [730, 1090],
  e: [530, 1840],
  i: [300, 2250],
  o: [570, 840],
  u: [320, 870],
  x: [500, 1500],
};

type Cls = 'vowel' | 'plosive' | 'fricative' | 'nasal' | 'liquid';
interface Letter {
  cls: Cls;
  vowel: Vowel | null;
  /** Consonant noise band centre (Hz). */
  noiseHz: number;
}

const LETTERS: Record<string, Letter> = {};
const def = (chars: string, cls: Cls, vowel: Vowel | null, noiseHz = 0): void => {
  for (const c of chars) LETTERS[c] = { cls, vowel, noiseHz };
};
def('a', 'vowel', 'a');
def('e', 'vowel', 'e');
def('iy', 'vowel', 'i');
def('o', 'vowel', 'o');
def('u', 'vowel', 'u');
def('pb', 'plosive', null, 1100);
def('td', 'plosive', null, 4200);
def('kgcq', 'plosive', null, 2300);
def('szx', 'fricative', null, 6200);
def('fv', 'fricative', null, 4800);
def('h', 'fricative', null, 1800);
def('j', 'fricative', null, 3200);
def('mn', 'nasal', null);
def('lr', 'liquid', null);
def('w', 'liquid', 'u');
const OTHER: Letter = { cls: 'vowel', vowel: 'x', noiseHz: 0 };

const CLASS_LEVEL: Record<Cls, number> = { vowel: 1, liquid: 0.85, nasal: 0.72, plosive: 0.8, fricative: 0.38 };

/** Per-mood level, calibrated so every line lands near -15 dBFS short-term at the listener. */
const MOOD_LEVEL: Record<Mood | 'neutral', number> = {
  neutral: 1.3,
  happy: 0.88,
  surprised: 1.2,
  accusing: 1.15,
  curious: 0.8,
  flustered: 1,
  proud: 1.05,
};

function isLetter(c: string): boolean {
  return c.toLowerCase() !== c.toUpperCase();
}

/** The vowel colour a consonant takes from the next vowel in its word (coarticulation). */
function nextVowel(s: string, i: number): Vowel | null {
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j].toLowerCase();
    if (!isLetter(c)) return null;
    const l = LETTERS[c];
    if (l && l.cls === 'vowel' && l.vowel) return l.vowel;
  }
  return null;
}

/** Pitch contour in semitones for letter k of n (u = 0..1 through the line). */
function contour(mood: Mood | undefined, u: number, k: number): number {
  switch (mood) {
    case 'happy':
      return 1 + (k % 2 === 0 ? 2.2 : -0.8) + u; // bouncy
    case 'surprised':
      return -2 + 8 * u; // rising
    case 'accusing':
      return 2 - 3 * u; // stabbing down
    case 'flustered':
      return 1.5 * Math.sin(k * 1.7); // wobbly
    case 'curious':
      return -0.5 + 4.5 * u * u; // question lift at the end
    case 'proud':
      return -1 - 2.5 * u; // confident fall
    default:
      return -1.5 * u; // gentle declination
  }
}

/**
 * Speak `text` on the event. Returns the end time. Duration ≈ text.length × 45 ms (+ short punctuation pauses).
 */
export function speak(ev: Ev, text: string, kind: SpectatorKind, mood: Mood | undefined): number {
  const prof = PROFILES[kind] ?? PROFILES.fox;
  const s = text.slice(0, 160);
  const n = s.length;
  const t0 = ev.t;
  if (n === 0) return t0;
  const r = mulberry32(hashString(s) ^ hashString(kind));

  // ---- pass 1: timing (so every source stops exactly when the line ends)
  const times = new Float64Array(n);
  let letters = 0;
  let tt = t0;
  for (let i = 0; i < n; i++) {
    const ch = s[i];
    times[i] = tt;
    if (isLetter(ch)) {
      letters++;
      tt += LETTER_STEP + (mood === 'flustered' ? rnd(r, -0.008, 0.014) : 0);
    } else {
      tt += ch === ',' ? LETTER_STEP * 1.6 : '.!?'.includes(ch) ? LETTER_STEP * 1.3 : LETTER_STEP;
    }
  }
  const tLast = tt;
  const end = tLast + 0.16; // room for the last consonant click to close and the envelope to reach zero

  // ---- graph: source → [F1, F2, F3, body] → low-pass → envelope → out; noise → band → noise env → low-pass
  const env = ev.gain(0, ev.out);
  const lp = ev.filter('lowpass', prof.lp, 0.6, env);
  const f1 = ev.filter('bandpass', 500 * prof.fmt, 4.5, ev.gain(2.4, lp));
  const f2 = ev.filter('bandpass', 1500 * prof.fmt, 6, ev.gain(1.8, lp));
  const f3 = ev.filter('bandpass', 2900 * prof.fmt, 3, ev.gain(0.45, lp));
  const body = ev.filter('lowpass', prof.f0 * 2.2, 0.7, ev.gain(0.3, lp));
  const wave = prof.src === 'saw' ? 'sawtooth' : prof.src === 'pulse' ? ev.res.pulse : ev.res.reed;
  const osc = ev.osc(wave, ev.hz(prof.f0), t0, end + 0.01, f1);
  osc.connect(f2);
  osc.connect(f3);
  osc.connect(body);
  const nEnv = ev.gain(0, lp);
  const nbp = ev.filter('bandpass', 3000, 1.6, nEnv);
  ev.noise('white', t0, end + 0.01, nbp);
  const clicks = new PopWriter(nEnv.gain, MIN_RAMP, 0.01);
  const amp = new TargetChain(env.gain, t0, 0); // letter envelope (setTarget chain, closed on an exact zero)
  if (mood === 'flustered') ev.osc('sine', rnd(r, 7.5, 9.5), t0, end + 0.01, ev.gain(55, osc.detune));

  // ---- pass 2: per-letter automation
  const level = 0.5 * prof.level * (MOOD_LEVEL[mood ?? 'neutral'] ?? MOOD_LEVEL.neutral); // unknown mood → neutral
  const blipLen = LETTER_STEP * (mood === 'accusing' ? 0.5 : 0.68);
  const floor = mood === 'accusing' ? 0 : mood === 'happy' ? 0.05 : prof.legato;
  let k = 0;
  let lastF = ev.hz(prof.f0);
  for (let i = 0; i < n; i++) {
    const ch = s[i];
    const ti = times[i];
    if (!isLetter(ch)) {
      amp.to(0, ti, 0.01);
      continue;
    }
    const lower = ch.toLowerCase();
    const info = LETTERS[lower] ?? OTHER;
    const u = letters > 1 ? k / (letters - 1) : 0;
    const shout = ch !== lower; // capitals are shouted ("I SAW THAT!")
    const nextCh = s[i + 1] ?? '';
    const accent = nextCh === '!' ? 1.2 : 1;
    let st = ((lower.charCodeAt(0) * 7) % 5 - 2) * 0.6 + contour(mood, u, k) + (shout ? 2 : 0);
    if (mood === 'flustered') st += rnd(r, -1.5, 1.5);
    if (mood === 'surprised' && (nextCh === '!' || nextCh === '?' || i === n - 1)) st += 3;
    if (mood === 'curious' && nextCh === '?') st += 2;
    const f = ev.hz(prof.f0 * semis(st));
    const fp = osc.frequency;
    // pitch motion inside the letter (every path starts with setValue, so ramps are well defined)
    if (prof.chirp > 0) {
      fp.setValueAtTime(f * semis(-prof.chirp), ti);
      fp.exponentialRampToValueAtTime(f * semis(0.6), ti + 0.02);
      if (mood === 'accusing') fp.exponentialRampToValueAtTime(f * semis(-2.5), ti + LETTER_STEP * 0.85);
    } else if (mood === 'accusing') {
      fp.setValueAtTime(f * semis(2.5), ti);
      fp.exponentialRampToValueAtTime(f * semis(-2.5), ti + LETTER_STEP * 0.8);
    } else if (mood === 'surprised' || mood === 'happy') {
      fp.setValueAtTime(lastF, ti);
      fp.exponentialRampToValueAtTime(f, ti + 0.012);
      fp.exponentialRampToValueAtTime(f * semis(mood === 'surprised' ? 1.5 : 1.2), ti + LETTER_STEP * 0.8);
    } else {
      fp.setTargetAtTime(f, ti, mood === 'flustered' ? 0.006 : 0.01);
    }
    lastF = f;
    // vowel colour (consonants borrow the coming vowel)
    const v: Vowel = info.vowel ?? nextVowel(s, i) ?? 'x';
    const fm = FORMANTS[v];
    const F1 = fm[0] + (FORMANTS.o[0] - fm[0]) * prof.round;
    const F2 = fm[1] + (FORMANTS.o[1] - fm[1]) * prof.round;
    f1.frequency.setTargetAtTime(ev.safe(F1 * prof.fmt), ti, 0.008);
    f2.frequency.setTargetAtTime(ev.safe(F2 * prof.fmt), ti, 0.008);
    // envelope: one blip per letter
    const lvl = level * CLASS_LEVEL[info.cls] * (shout ? 1.2 : 1) * accent;
    // exponential attack: tau 6 ms keeps the steepest slope gentler than a 5 ms linear ramp even though a short blip
    // never quite reaches its target
    amp.to(lvl, ti, Math.max(VOICE_ATTACK_MIN, prof.attack));
    amp.to(lvl * floor, ti + blipLen, 0.008);
    // consonant noise
    if (info.cls === 'plosive' || info.cls === 'fricative') {
      nbp.frequency.setValueAtTime(ev.safe(info.noiseHz * Math.sqrt(prof.fmt)), ti);
      clicks.pop(ti, info.cls === 'plosive' ? 0.5 : 0.42 * clamp(prof.lp / 6000, 0.4, 1), info.cls === 'plosive' ? 0.008 : 0.022);
    }
    k++;
  }
  amp.to(0, tLast, 0.012);
  amp.close(end, 0.012); // continue the decay analytically, then a 12 ms linear glide to exactly zero (no step)
  clicks.close();
  return end;
}
