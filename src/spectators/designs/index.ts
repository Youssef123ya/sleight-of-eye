// Design cache: every instance of the same kind/variant shares one pair of skinned geometries.
import type { SpectatorKind } from '../../contracts.js';
import { buildBadger } from './badger.js';
import type { PuppetDesign } from './common.js';
import { buildFox } from './fox.js';
import { buildMagpie } from './magpie.js';
import { buildRabbit } from './rabbit.js';

const cache = new Map<string, { design: PuppetDesign; refs: number }>();

function keyOf(kind: SpectatorKind, variant: number): string {
  return kind === 'fox' ? `fox:${((variant % 3) + 3) % 3}` : kind;
}

export function acquireDesign(kind: SpectatorKind, variant: number): PuppetDesign {
  const key = keyOf(kind, variant);
  let hit = cache.get(key);
  if (!hit) {
    const design =
      kind === 'fox' ? buildFox(variant) : kind === 'magpie' ? buildMagpie() : kind === 'badger' ? buildBadger() : buildRabbit();
    hit = { design, refs: 0 };
    cache.set(key, hit);
  }
  hit.refs++;
  return hit.design;
}

export function releaseDesign(design: PuppetDesign): void {
  const hit = cache.get(design.key);
  if (!hit || hit.design !== design) return;
  if (--hit.refs > 0) return;
  design.felt.dispose();
  design.gloss.dispose();
  cache.delete(design.key);
}

export type { PuppetDesign } from './common.js';
