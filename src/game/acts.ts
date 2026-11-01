// The show as data (G): three acts and a bow, beat by beat (design spec §7). The trick runner (tricks.ts)
// interprets these; tweak lines, casts and gadgets here without touching the runner.
import type { GadgetId, Mood, PropId, SpectatorKind } from '../contracts.js';

export type BeatKind = 'intro' | 'demo' | 'show' | 'steal' | 'load' | 'lookBack' | 'reveal' | 'bow';

export interface CastMember {
  id: string;
  kind: SpectatorKind;
  seat: number; // index into cafe.seats
  scale?: number;
  seed?: number;
}

export interface Line {
  who: string; // spectator id, or '*kit' for any kit in the lineup
  text: string;
  mood?: Mood;
  delay?: number; // seconds after the trigger
  /** Spoken (animalese) only — no caption even when captions are on. */
  silent?: boolean;
}

export interface BeatDef {
  kind: BeatKind;
  name: string;
  /** show/steal/load: the prop in play; reveal: the prop that comes back. */
  prop?: PropId;
  /** load: where the palmed prop goes. */
  into?: PropId;
  /** reveal: poke target — 'volunteer' (the volunteer's ear) or a prop. */
  at?: 'volunteer' | PropId;
  /** reveal: what the poke shows. */
  result?: 'appear' | 'empty' | 'under' | 'rise';
  /** reveal: spectator that hops onto the mat first (its ear becomes the target). */
  volunteer?: string;
  /** Gadgets that can be fired by a look during this beat (one use per attempt). */
  gadgets?: GadgetId[];
  /** The gadget the ghost gaze trail suggests. */
  suggest?: GadgetId;
  /** Beat index a catch rewinds to (defaults to this beat). */
  checkpoint?: number;
  /** intro/demo: length in seconds (an intro may end earlier once its goal is met). */
  duration?: number;
  /** intro: minimum time and gaze travel (deg) before "heads follow" counts as understood. */
  minTime?: number;
  travelDeg?: number;
  /** intro: a prop that appears at its mark (Brock lends his watch). */
  appear?: PropId;
  /** demo: the spectator whose rule is being shown (its sight cone is drawn). */
  focus?: string;
  /** demo: ends early once the featured critic has been flustered. */
  untilFluster?: boolean;
  /** lookBack: who topples off their seat in surprise. */
  topple?: string;
  /** Lines at the beat start ('start'), on success ('success') or for special moments. */
  lines?: Line[];
  successLines?: Line[];
  /** Last beat of the act. */
  final?: boolean;
}

export interface ActDef {
  act: number;
  title: string;
  subtitle: string;
  cast: CastMember[];
  /** Props on the mat when the curtain rises. */
  props: PropId[];
  beats: BeatDef[];
}

export const ACTS: ActDef[] = [
  {
    act: 1,
    title: 'Act I',
    subtitle: 'The Vanishing Coin',
    cast: [
      { id: 'kit1', kind: 'fox', seat: 1, scale: 1.0, seed: 11 },
      { id: 'kit2', kind: 'fox', seat: 2, scale: 0.92, seed: 22 },
      { id: 'kit3', kind: 'fox', seat: 3, scale: 0.8, seed: 33 },
    ],
    props: ['coin'],
    beats: [
      {
        kind: 'intro',
        name: 'heads-follow',
        duration: 9,
        minTime: 2.5,
        travelDeg: 40,
        successLines: [{ who: 'kit2', text: 'Hee hee!', mood: 'happy', silent: true }],
      },
      {
        kind: 'show',
        name: 'coin-show',
        prop: 'coin',
        successLines: [{ who: 'kit1', text: 'Ooooh!', mood: 'curious' }],
      },
      {
        kind: 'steal',
        name: 'coin-steal',
        prop: 'coin',
        gadgets: ['musicBox'],
        suggest: 'musicBox',
      },
      {
        kind: 'lookBack',
        name: 'coin-gone',
        prop: 'coin',
        checkpoint: 2,
        topple: 'kit3',
        successLines: [{ who: 'kit1', text: "It's GONE!", mood: 'surprised', delay: 0.35 }],
      },
      {
        kind: 'reveal',
        name: 'ear-poof',
        prop: 'coin',
        at: 'volunteer',
        volunteer: 'kit2', // kit3 (the smallest) is still climbing back from its topple
        result: 'appear',
        final: true,
        lines: [{ who: 'kit2', text: 'Me? ME?', mood: 'happy', delay: 1.6 }], // as it lands on the mat
        successLines: [{ who: 'kit2', text: 'From my EAR?!', mood: 'surprised' }],
      },
    ],
  },
  {
    act: 2,
    title: 'Act II',
    subtitle: 'Cups & Ball',
    cast: [
      { id: 'kit1', kind: 'fox', seat: 0, scale: 1.0, seed: 11 },
      { id: 'kit2', kind: 'fox', seat: 1, scale: 0.92, seed: 22 },
      { id: 'magpie', kind: 'magpie', seat: 2, scale: 1.0, seed: 44 },
      { id: 'kit3', kind: 'fox', seat: 3, scale: 0.8, seed: 33 },
    ],
    props: ['ball', 'cupLeft', 'cupMid', 'cupRight'],
    beats: [
      {
        kind: 'demo',
        name: 'magpie-shiny',
        prop: 'ball',
        focus: 'magpie',
        duration: 8,
        lines: [{ who: 'magpie', text: 'Shiny...', mood: 'curious', delay: 1.0 }],
      },
      {
        kind: 'show',
        name: 'ball-show',
        prop: 'ball',
        successLines: [{ who: 'magpie', text: 'Mine! MINE!', mood: 'happy' }],
      },
      {
        kind: 'steal',
        name: 'ball-steal',
        prop: 'ball',
        gadgets: ['musicBox', 'candle'],
        suggest: 'candle',
      },
      {
        kind: 'load',
        name: 'ball-load',
        prop: 'ball',
        into: 'cupRight',
        gadgets: ['musicBox', 'candle'],
        checkpoint: 2,
      },
      {
        kind: 'lookBack',
        name: 'ball-gone',
        prop: 'ball',
        checkpoint: 2,
        successLines: [{ who: 'magpie', text: 'Where did it GO?', mood: 'surprised', delay: 0.3 }],
      },
      {
        kind: 'reveal',
        name: 'cup-empty',
        at: 'cupMid',
        result: 'empty',
        successLines: [{ who: 'kit2', text: 'Empty?!', mood: 'surprised', delay: 0.5 }],
      },
      {
        kind: 'reveal',
        name: 'cup-ball',
        prop: 'ball',
        at: 'cupRight',
        result: 'under',
        final: true,
        successLines: [{ who: 'magpie', text: 'SHINY! Again!', mood: 'happy', delay: 0.4 }],
      },
    ],
  },
  {
    act: 3,
    title: 'Act III',
    subtitle: "The Critic's Watch",
    cast: [
      { id: 'kit1', kind: 'fox', seat: 0, scale: 1.0, seed: 11 },
      { id: 'kit2', kind: 'fox', seat: 1, scale: 0.92, seed: 22 },
      { id: 'brock', kind: 'badger', seat: 2, scale: 1.0, seed: 55 },
      { id: 'magpie', kind: 'magpie', seat: 3, scale: 1.0, seed: 44 },
      { id: 'kit3', kind: 'fox', seat: 4, scale: 0.8, seed: 33 },
    ],
    props: ['cupcake'],
    beats: [
      {
        kind: 'demo',
        name: 'critic-hands',
        focus: 'brock',
        duration: 14,
        untilFluster: true,
        lines: [{ who: 'brock', text: 'Hands where I can see them.', mood: 'curious', delay: 0.8 }],
      },
      {
        kind: 'intro',
        name: 'lend-watch',
        appear: 'watch',
        duration: 3.6,
        lines: [{ who: 'brock', text: 'Make THIS disappear.', mood: 'proud', delay: 0.2 }],
      },
      {
        kind: 'show',
        name: 'watch-show',
        prop: 'watch',
        successLines: [{ who: 'brock', text: 'Hmph. Genuine gold.', mood: 'proud' }],
      },
      {
        kind: 'steal',
        name: 'watch-steal',
        prop: 'watch',
        gadgets: ['musicBox', 'candle', 'firework'],
        suggest: 'firework',
      },
      {
        kind: 'load',
        name: 'watch-load',
        prop: 'watch',
        into: 'cupcake',
        gadgets: ['musicBox', 'candle', 'firework'],
        checkpoint: 3,
      },
      {
        kind: 'lookBack',
        name: 'watch-gone',
        prop: 'watch',
        checkpoint: 3,
        topple: 'kit2',
        successLines: [{ who: 'brock', text: 'Preposterous!', mood: 'surprised', delay: 0.3 }],
      },
      {
        kind: 'reveal',
        name: 'watch-rise',
        prop: 'watch',
        at: 'cupcake',
        result: 'rise',
        final: true,
        successLines: [
          { who: 'brock', text: '...Bravo.', mood: 'flustered', delay: 1.2 },
          { who: 'kit1', text: 'ENCORE!', mood: 'happy', delay: 2.2 },
        ],
      },
    ],
  },
];

/** The bow is "act 4": the act-III cast lines up, the review arrives, a poster goes up. */
export const BOW_ACT: ActDef = {
  act: 4,
  title: 'Curtain Call',
  subtitle: 'Take a bow',
  cast: ACTS[2].cast,
  props: [],
  beats: [{ kind: 'bow', name: 'bow' }],
};

export const ALL_ACTS: ActDef[] = [...ACTS, BOW_ACT];

/** Lines Brock says when flustered (cycled). */
export const FLUSTER_LINES = ['W-what are you looking at?', 'Ahem. Notes. Notes!', 'Stop that this instant.'];

/** The catch shout. */
export const CATCH_LINE = 'I SAW THAT!';
