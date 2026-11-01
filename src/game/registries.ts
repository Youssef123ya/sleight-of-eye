// Poke and gaze-target registries (G). Plain arrays iterated by index each frame: no allocation per frame.
import { CFG } from '../config.js';
import type { GazeTarget, GazeTargetRegistry, PokeRegistry, PokeTarget } from '../contracts.js';

function makeRemover<T>(list: T[], item: T): () => void {
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const i = list.indexOf(item);
    if (i >= 0) list.splice(i, 1);
  };
}

export class PokeRegistryImpl implements PokeRegistry {
  readonly targets: PokeTarget[] = [];

  add(target: PokeTarget): () => void {
    if (!target || typeof target.getWorldPosition !== 'function') {
      console.warn('[game] ignoring invalid poke target', target);
      return () => {};
    }
    this.targets.push(target);
    return makeRemover(this.targets, target);
  }

  /** Effective sphere radius (the registry enforces CFG.pokeRadiusMin). */
  static radiusOf(t: PokeTarget): number {
    return Math.max(CFG.pokeRadiusMin, t.radius || 0);
  }

  byId(id: string): PokeTarget | null {
    for (let i = 0; i < this.targets.length; i++) if (this.targets[i].id === id) return this.targets[i];
    return null;
  }
}

export class GazeTargetRegistryImpl implements GazeTargetRegistry {
  readonly targets: GazeTarget[] = [];

  add(target: GazeTarget): () => void {
    if (!target || typeof target.getWorldPosition !== 'function') {
      console.warn('[game] ignoring invalid gaze target', target);
      return () => {};
    }
    this.targets.push(target);
    return makeRemover(this.targets, target);
  }

  byId(id: string): GazeTarget | null {
    for (let i = 0; i < this.targets.length; i++) if (this.targets[i].id === id) return this.targets[i];
    return null;
  }
}
