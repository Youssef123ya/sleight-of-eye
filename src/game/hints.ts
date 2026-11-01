// Onboarding hints (G): the ghost pinch/poke/gaze appears immediately the first time each verb is needed,
// then again after CFG.hintDelay of inactivity. The runner declares what it wants every frame; progress resets it.
import type { Object3D, Vector3 } from '@iwsdk/core';
import { CFG } from '../config.js';
import type { Hint, Side, UI } from '../contracts.js';

export type Verb = 'pinch' | 'poke' | 'gaze';

export class Hints {
  enabled = true;
  private readonly hinted = new Set<Verb>();
  private current: Hint | null = null;
  private verb: Verb | null = null;
  private target: Object3D | null = null;
  private side: Side = 'right';
  private idle = 0;
  /** Verb currently on screen (debug). */
  showing: Verb | null = null;

  constructor(
    private readonly ui: UI,
    private readonly gazeFrom: () => Vector3,
  ) {}

  /** What the player should do now; cheap when unchanged (call every frame). */
  want(verb: Verb | null, target: Object3D | null, side: Side = 'right'): void {
    if (verb === this.verb && target === this.target) return;
    this.stop();
    this.verb = verb;
    this.target = target;
    this.side = side;
    this.idle = 0;
    if (verb && target && this.enabled && !this.hinted.has(verb)) this.show();
  }

  /** The player did something meaningful: hide the hint and restart the inactivity timer. */
  progress(): void {
    this.idle = 0;
    this.stop();
  }

  clear(): void {
    this.stop();
    this.verb = null;
    this.target = null;
    this.idle = 0;
  }

  /** Forget which verbs were taught (a fresh show). */
  forget(): void {
    this.hinted.clear();
  }

  update(dt: number): void {
    if (!this.verb || !this.target || this.current || !this.enabled) return;
    this.idle += dt;
    if (this.idle >= CFG.hintDelay) this.show();
  }

  private show(): void {
    if (!this.verb || !this.target) return;
    try {
      if (this.verb === 'pinch') this.current = this.ui.hintPinch(this.target, this.side);
      else if (this.verb === 'poke') this.current = this.ui.hintPoke(this.target, this.side);
      else this.current = this.ui.hintGaze(this.gazeFrom, this.target);
      this.showing = this.verb;
      this.hinted.add(this.verb);
    } catch (e) {
      console.warn('[hints] UI hint failed', e);
      this.current = null;
    }
  }

  private stop(): void {
    if (this.current) {
      try {
        this.current.stop();
      } catch {
        /* cosmetic */
      }
    }
    this.current = null;
    this.showing = null;
  }
}
