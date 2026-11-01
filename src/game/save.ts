// Autosave (G): one small JSON blob in localStorage, written at every beat boundary. Every access is wrapped
// in try/catch (private windows, blocked storage, quota) and a broken blob is ignored.
import { CFG } from '../config.js';
import { DEFAULT_SETTINGS, type PosterData, type Settings } from '../contracts.js';

export interface SaveData {
  v: 1;
  act: number;
  beat: number;
  settings: Settings;
  stars: number[];
  posters: PosterData[];
  /** Shows finished in a row without a single catch. */
  streak: number;
  shows: number;
}

export function emptySave(): SaveData {
  return { v: 1, act: 1, beat: 0, settings: { ...DEFAULT_SETTINGS }, stars: [0, 0, 0], posters: [], streak: 0, shows: 0 };
}

export function loadSave(): SaveData | null {
  try {
    const raw = window.localStorage.getItem(CFG.autosaveKey);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SaveData>;
    if (!d || d.v !== 1) return null;
    const base = emptySave();
    return {
      v: 1,
      act: clampInt(d.act, 1, 4, 1),
      beat: clampInt(d.beat, 0, 20, 0),
      settings: { ...DEFAULT_SETTINGS, ...(typeof d.settings === 'object' && d.settings ? d.settings : {}) },
      stars: Array.isArray(d.stars) ? d.stars.slice(0, 3).map((s) => clampInt(s, 0, 3, 0)) : base.stars,
      posters: Array.isArray(d.posters) ? d.posters.slice(-8) : [],
      streak: clampInt(d.streak, 0, 9999, 0),
      shows: clampInt(d.shows, 0, 9999, 0),
    };
  } catch {
    return null;
  }
}

export function writeSave(data: SaveData): void {
  try {
    window.localStorage.setItem(CFG.autosaveKey, JSON.stringify(data));
  } catch {
    /* storage unavailable: the show still runs */
  }
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.max(lo, Math.min(hi, n));
}
