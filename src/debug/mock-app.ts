// Mock DebugApi (owned by Q) for ?demo=debug: a miniature Act 1 ("Vanishing Coin") played on the QA fixture with
// the spec's verbs (head gaze + dwell, pinch-lift, pinch-palm with a sight-cone catch, look back, poke-reveal).
// It exists so tests/lib/iwer.mjs (lookAt, pinchAt, pokeAt, waitForState) and the act scenarios can be proven
// end-to-end before the real game is integrated. It never installs over a real `window.__app`.
// A catch behaves like the game's (src/game/tricks.ts caught()): phase 'caught' + the catcher's `alarm` for
// CFG.catchCaptionTime + half the rewind smear (pinches ignored), then the beat rewinds (phase 'active', alarm null).
//
// Hands are read straight from WebXR (fillPoses on thumb/index tips + select events), gaze is the head ray.
// Per-frame code allocates nothing: class fields (V8 keeps doubles in place), indexed loops, scratch vectors, and
// world positions read from matrixWorld (refreshed by the renderer) instead of getWorldPosition(), which would
// re-walk every ECS-synced parent each call.
import { Matrix4, Vector3, VisibilityState, type Object3D, type World } from '@iwsdk/core';
import type { DebugApi, PropId, Settings, Side } from '../contracts.js';
import { DEFAULT_SETTINGS } from '../contracts.js';
import { CFG } from '../config.js';
import { onUpdate } from '../boot/loop.js';
import { L, type StageRig } from '../layout.js';
import type { Fixture, FixtureSpectator } from './fixture.js';

const BEATS = ['intro', 'show', 'steal', 'lookBack', 'reveal', 'bow'] as const;
type BeatKind = (typeof BEATS)[number];
const DEG = Math.PI / 180;
const SIDES: readonly Side[] = ['right', 'left'];
const GADGET_IDS = ['musicBox', 'candle', 'firework'] as const;
type FillPoses = (spaces: XRSpace[], base: XRSpace, out: Float32Array) => boolean;

class HandTrack {
  tracked = false;
  pinching = false;
  pinchEdge = false;
  readonly pinch = new Vector3();
  readonly index = new Vector3();
  spaces: XRSpace[] | null = null;
  source: XRInputSource | null = null;
}

export interface MockApp {
  api: DebugApi;
  dispose(): void;
}

/** World position from the last rendered matrixWorld (no parent-chain update, no allocation). */
const worldPos = (o: Object3D, out: Vector3): Vector3 => out.setFromMatrixPosition(o.matrixWorld);

class MockAct1 {
  // state
  act = 1;
  beat = 0;
  beatTime = 0;
  caught = 0;
  palmed: PropId | null = null;
  loaded: string | null = null;
  revealed = 0;
  coinState: 'home' | 'lifted' | 'palmed' | 'revealed' = 'home';
  coinSide: Side = 'right';
  gazeTarget: string | null = null;
  dwell = 0;
  watchers: number;
  calibrated = false;
  paused = false;
  musicBoxLeft = 0; // seconds of music left (Infinity with Easy Audience)
  musicBoxUsed = false;
  lookBackHeld = 0;
  kitLookInit = false;
  xrFrames = 0; // calibration waits for a still head, like the game (session.ts): >= 6 XR frames and 0.25 s
  stillFor = 0;
  readonly lastHead = new Vector3();
  readonly stars = [0, 0, 0];
  settings: Settings = { ...DEFAULT_SETTINGS };
  lastCatchBy: string | null = null;
  phase: 'active' | 'caught' = 'active';
  alarm: string | null = null; // the catcher while its cone flashes
  caughtLeft = 0; // seconds of the 'caught' hold left before the rewind
  firstWatcher: string | null = null; // a kit whose sight cone holds the mat this frame (the would-be catcher)
  boundSession: XRSession | null = null;

  // scene
  readonly kits: FixtureSpectator[];
  readonly volunteer: FixtureSpectator;
  readonly coinHome = new Vector3();
  readonly volunteerHome = new Vector3();
  readonly hands = { left: new HandTrack(), right: new HandTrack() };
  readonly poses = new Float32Array(32);

  // scratch
  readonly eye = new Vector3();
  readonly dir = new Vector3();
  readonly tmp = new Vector3();
  readonly tmp2 = new Vector3();
  readonly gazePoint = new Vector3();
  readonly kitLook = new Vector3(); // lagged point the kits follow (world)
  readonly coinWorld = new Vector3();
  readonly matWorld = new Vector3(); // the coin's home mark: what "watching the mat" means
  readonly lookTarget = new Vector3();
  readonly rigInv = new Matrix4();

  constructor(
    private readonly world: World,
    private readonly rig: StageRig,
    private readonly fx: Fixture,
  ) {
    this.kits = fx.spectators.filter((s) => s.id.startsWith('kit'));
    this.volunteer = this.kits.find((k) => k.id === 'kit2') ?? this.kits[0];
    this.coinHome.copy(fx.props.coin.position);
    this.volunteerHome.copy(this.volunteer.root.position);
    this.watchers = this.kits.length;
  }

  kind(): BeatKind {
    return BEATS[Math.min(this.beat, BEATS.length - 1)];
  }

  // ------------------------------------------------------------------------------------------- beats
  resetBeatProps(): void {
    const coin = this.fx.props.coin;
    coin.position.copy(this.coinHome);
    coin.scale.setScalar(1);
    coin.visible = true;
    this.coinState = 'home';
    this.musicBoxLeft = 0;
    this.musicBoxUsed = false;
    this.lookBackHeld = 0;
    this.beatTime = 0;
    this.volunteer.root.position.copy(this.volunteerHome);
    const k = this.kind();
    if (k === 'steal' || k === 'show' || k === 'intro') this.palmed = null;
    if (k === 'reveal' || k === 'lookBack') {
      this.palmed = 'coin';
      this.coinState = 'palmed';
      coin.visible = false;
    }
    if (k === 'reveal') this.toVolunteerSpot();
  }

  toVolunteerSpot(): void {
    this.volunteer.root.position.set(L.volunteerSpot[0], L.volunteerSpot[1], L.volunteerSpot[2]);
  }

  advance(): void {
    this.beat = Math.min(this.beat + 1, BEATS.length - 1);
    this.beatTime = 0;
    if (this.kind() === 'reveal') this.toVolunteerSpot();
  }

  // ------------------------------------------------------------------------------------------- input
  onSelect = (e: Event): void => {
    const side = (e as XRInputSourceEvent).inputSource?.handedness;
    if (side !== 'left' && side !== 'right') return;
    const h = this.hands[side];
    if (e.type === 'selectstart') {
      h.pinching = true;
      h.pinchEdge = true;
    } else if (e.type === 'selectend') h.pinching = false;
  };

  bindSession(session: XRSession): void {
    if (this.boundSession === session) return;
    this.unbindSession();
    this.boundSession = session;
    session.addEventListener('selectstart', this.onSelect);
    session.addEventListener('selectend', this.onSelect);
  }

  unbindSession(): void {
    if (!this.boundSession) return;
    this.boundSession.removeEventListener('selectstart', this.onSelect);
    this.boundSession.removeEventListener('selectend', this.onSelect);
    this.boundSession = null;
  }

  onFrame = (frame: XRFrame): void => {
    try {
      this.bindSession(frame.session);
      const ref = this.world.xrReferenceSpace;
      if (!ref) return;
      this.hands.left.tracked = false;
      this.hands.right.tracked = false;
      const fill = (frame as XRFrame & { fillPoses?: FillPoses }).fillPoses;
      const srcs = frame.session.inputSources;
      const player = this.world.player.matrixWorld;
      for (let i = 0; i < srcs.length; i++) {
        const src = srcs[i];
        const side = src.handedness;
        if (!src.hand || (side !== 'left' && side !== 'right')) continue;
        const h = this.hands[side];
        if (h.source !== src) {
          h.source = src;
          const thumb = src.hand.get('thumb-tip');
          const index = src.hand.get('index-finger-tip');
          h.spaces = thumb && index ? [thumb, index] : null;
        }
        if (!h.spaces || !fill || !fill.call(frame, h.spaces, ref, this.poses)) continue;
        const P = this.poses;
        h.index.set(P[28], P[29], P[30]).applyMatrix4(player);
        h.pinch.set((P[12] + P[28]) / 2, (P[13] + P[29]) / 2, (P[14] + P[30]) / 2).applyMatrix4(player);
        h.tracked = true;
      }
    } catch {
      /* a missing joint or space must never break the frame */
    }
  };

  // ------------------------------------------------------------------------------------------- gaze
  consider(id: string, p: Vector3, radius: number, best: { ang: number }): boolean {
    const t = this.tmp.copy(p).sub(this.eye);
    const d = t.length();
    if (d < 1e-3) return false;
    const ang = Math.acos(Math.max(-1, Math.min(1, t.dot(this.dir) / d)));
    if (ang < Math.atan2(radius, d) + CFG.gazeSlackDeg * DEG && ang < best.ang) {
      best.ang = ang;
      this.gazePoint.copy(p);
      return true;
    }
    return false;
  }
  readonly best = { ang: Infinity };

  updateGaze(dt: number): void {
    const e = this.world.camera.matrixWorld.elements;
    this.eye.set(e[12], e[13], e[14]);
    this.dir.set(-e[8], -e[9], -e[10]).normalize();
    const best = this.best;
    best.ang = Infinity;
    let hit: string | null = null;
    for (let i = 0; i < GADGET_IDS.length; i++) {
      const id = GADGET_IDS[i];
      if (this.consider(id, worldPos(this.fx.gadgets[id].focus, this.tmp2), 0.05, best)) hit = id;
    }
    const specs = this.fx.spectators;
    for (let i = 0; i < specs.length; i++) {
      const head = specs[i].anchors.head;
      if (head && this.consider(specs[i].id, worldPos(head, this.tmp2), 0.03, best)) hit = specs[i].id;
    }
    if (hit === null) {
      // ray onto the tabletop plane, else a far point
      const tableY = this.rig.root.matrixWorld.elements[13] + L.tableY;
      const t = this.dir.y < -1e-3 ? Math.min((tableY - this.eye.y) / this.dir.y, 3) : 3;
      this.gazePoint.copy(this.dir).multiplyScalar(t).add(this.eye);
    }
    if (hit === this.gazeTarget) this.dwell += dt;
    else {
      this.gazeTarget = hit;
      this.dwell = 0;
    }
    if (this.gazeTarget === 'musicBox' && this.dwell >= CFG.gadgetDwell && !this.musicBoxUsed && this.musicBoxLeft <= 0) {
      this.musicBoxLeft = this.settings.easyAudience ? Infinity : CFG.musicBoxDuration;
      this.musicBoxUsed = true;
    }
  }

  // ------------------------------------------------------------------------------------------- audience
  updateAudience(dt: number, time: number): void {
    if (this.musicBoxLeft > 0) {
      worldPos(this.fx.gadgets.musicBox.focus, this.lookTarget);
      this.musicBoxLeft -= dt;
    } else this.lookTarget.copy(this.gazePoint);
    if (!this.kitLookInit) {
      this.kitLook.copy(this.lookTarget);
      this.kitLookInit = true;
    }
    this.kitLook.lerp(this.lookTarget, 1 - Math.exp(-dt / CFG.followLag));
    this.rig.toWorld(this.coinHome, this.matWorld);
    this.rigInv.copy(this.rig.root.matrixWorld).invert();
    const half = (this.settings.easyAudience ? CFG.sightHalfAngleEasy : CFG.sightHalfAngle) * DEG;
    let w = 0;
    let first: string | null = null;
    for (let i = 0; i < this.kits.length; i++) {
      const k = this.kits[i];
      this.turnToward(k, this.kitLook, dt);
      const eyes = k.anchors.eyes ?? k.anchors.head;
      if (!eyes) continue;
      worldPos(eyes, this.tmp);
      this.tmp2.copy(this.kitLook).sub(this.tmp).normalize();
      this.tmp.subVectors(this.matWorld, this.tmp).normalize();
      if (Math.acos(Math.max(-1, Math.min(1, this.tmp.dot(this.tmp2)))) < half) {
        w++;
        if (first === null) first = k.id;
      }
    }
    this.watchers = w;
    this.firstWatcher = first;
    // music box dancer sways while it plays
    this.fx.gadgets.musicBox.root.rotation.y = this.musicBoxLeft > 0 ? Math.sin(time * 6) * 0.25 : 0;
  }

  turnToward(k: FixtureSpectator, worldPoint: Vector3, dt: number): void {
    const from = worldPos(k.root, this.tmp).applyMatrix4(this.rigInv);
    const to = this.tmp2.copy(worldPoint).applyMatrix4(this.rigInv);
    const yaw = Math.atan2(to.x - from.x, to.z - from.z);
    const cur = k.turn.rotation.y;
    let d = yaw - cur;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    k.turn.rotation.y = cur + d * (1 - Math.exp(-dt * 9));
  }

  // ------------------------------------------------------------------------------------------- beats
  pinchNear(p: Vector3, radius: number): Side | null {
    for (let i = 0; i < SIDES.length; i++) {
      const h = this.hands[SIDES[i]];
      if (h.pinchEdge && h.tracked && h.pinch.distanceTo(p) <= radius) return SIDES[i];
    }
    return null;
  }

  updateBeat(dt: number): void {
    const coin = this.fx.props.coin;
    if (this.phase === 'caught') {
      // "I SAW THAT!" holds the beat (pinches ignored), then the rewind restores the checkpoint
      this.caughtLeft -= dt;
      if (this.caughtLeft <= 0) {
        this.caughtLeft = 0;
        this.phase = 'active';
        this.alarm = null;
        this.resetBeatProps();
      }
      this.hands.left.pinchEdge = false;
      this.hands.right.pinchEdge = false;
      return;
    }
    this.beatTime += dt;
    worldPos(coin, this.coinWorld);
    switch (this.kind()) {
      case 'intro':
        if (this.beatTime > 2.5) this.advance();
        break;
      case 'show':
        if (this.coinState === 'home') {
          const side = this.pinchNear(this.coinWorld, CFG.pinchMagnet);
          if (side) {
            this.coinState = 'lifted';
            this.coinSide = side;
          }
        } else if (this.coinState === 'lifted') {
          const h = this.hands[this.coinSide];
          if (h.pinching && h.tracked) {
            this.rig.toLocal(h.pinch, this.tmp);
            coin.position.copy(this.tmp);
          } else {
            coin.position.copy(this.coinHome);
            this.coinState = 'home';
            this.advance();
          }
        }
        break;
      case 'steal':
        if (this.coinState === 'home') {
          const side = this.pinchNear(this.coinWorld, CFG.pinchMagnet);
          if (side) {
            if (this.watchers > 0) {
              this.caught++;
              this.lastCatchBy = this.firstWatcher ?? this.kits[0]?.id ?? 'kit';
              this.alarm = this.lastCatchBy;
              this.phase = 'caught';
              this.caughtLeft = CFG.catchCaptionTime + CFG.rewindTime * 0.5;
              console.info(`[mock] ${this.lastCatchBy}: "I SAW THAT!" (watchers ${this.watchers}) — rewinding the beat`);
            } else {
              this.coinState = 'palmed';
              this.coinSide = side;
              this.palmed = 'coin';
              coin.scale.setScalar(0.55);
              this.advance();
            }
          }
        }
        break;
      case 'lookBack':
        if (this.watchers === this.kits.length) this.lookBackHeld += dt;
        if (this.lookBackHeld > 0.6) this.advance();
        break;
      case 'reveal': {
        const ear = this.volunteer.anchors.ear;
        if (!ear) break;
        const earWorld = worldPos(ear, this.tmp2);
        for (let i = 0; i < SIDES.length; i++) {
          const h = this.hands[SIDES[i]];
          if (h.tracked && h.index.distanceTo(earWorld) <= CFG.pokeRadiusMin) {
            this.revealed++;
            this.palmed = null;
            this.coinState = 'revealed';
            coin.visible = true;
            coin.scale.setScalar(1);
            this.rig.toLocal(earWorld, this.tmp);
            coin.position.copy(this.tmp);
            this.stars[0] = this.caught === 0 ? 2 : 1;
            this.advance();
            break;
          }
        }
        break;
      }
      case 'bow':
        break;
    }
    // a palmed coin rides in the fist, small (player-only cue)
    if (this.coinState === 'palmed') {
      const h = this.hands[this.coinSide];
      if (h.tracked) {
        this.rig.toLocal(h.pinch, this.tmp);
        coin.position.copy(this.tmp);
      }
      coin.visible = true;
    }
    this.hands.left.pinchEdge = false;
    this.hands.right.pinchEdge = false;
  }

  /** Calibrate the stage on the first STILL head pose (a harness may still be moving the head as XR starts). */
  updateCalibration(dt: number): void {
    if (this.calibrated || !this.world.renderer.xr.isPresenting) return;
    this.xrFrames++;
    const e = this.world.camera.matrixWorld.elements;
    this.tmp.set(e[12], e[13], e[14]);
    const moved = this.tmp.distanceTo(this.lastHead);
    this.lastHead.copy(this.tmp);
    this.stillFor = moved < 0.004 ? this.stillFor + dt : 0;
    if ((this.xrFrames >= 6 && this.stillFor >= 0.25) || this.xrFrames > 150) {
      this.rig.calibrateFromHead(this.world.camera);
      this.calibrated = true;
    }
  }

  tick = (dt: number, time: number): void => {
    this.updateCalibration(dt);
    if (this.paused) return;
    this.updateGaze(dt);
    this.updateAudience(dt, time);
    this.updateBeat(dt);
  };

  // ------------------------------------------------------------------------------------------- DebugApi
  fovReport(): Array<{ id: string; yaw: number; pitch: number; distance: number }> {
    const cam = this.world.camera;
    const eye = cam.getWorldPosition(new Vector3());
    const dir = cam.getWorldDirection(new Vector3());
    const right = new Vector3().crossVectors(dir, new Vector3(0, 1, 0)).normalize();
    const up = new Vector3().crossVectors(right, dir).normalize();
    const out: Array<{ id: string; yaw: number; pitch: number; distance: number }> = [];
    for (const [id, o] of this.fx.named) {
      if (id.startsWith('seat-') || id === 'volunteerSpot') continue;
      if (id.includes('-') && !id.endsWith('-focus') && !id.endsWith('-head') && !id.startsWith('plaque-')) continue;
      const p = o.getWorldPosition(new Vector3()).sub(eye);
      const z = p.dot(dir);
      out.push({ id, yaw: Math.atan2(p.dot(right), z) / DEG, pitch: Math.atan2(p.dot(up), z) / DEG, distance: p.length() });
    }
    return out;
  }

  debugState(): Record<string, unknown> {
    return {
      act: this.act,
      beat: this.beat,
      beatKind: this.kind(),
      phase: this.phase,
      caught: this.caught,
      alarm: this.alarm,
      palmed: this.palmed,
      loaded: this.loaded,
      gazeTarget: this.gazeTarget,
      watchers: this.watchers,
      calibrated: this.calibrated,
      paused: this.paused,
      stars: [...this.stars],
      mock: true,
      musicBox: this.musicBoxLeft > 0 ? 'playing' : this.musicBoxUsed ? 'used' : 'ready',
      revealed: this.revealed,
      lastCatchBy: this.lastCatchBy,
    };
  }

  skipTo(a: number, b = 0): void {
    this.act = Math.max(1, Math.min(3, Math.round(a)));
    this.beat = Math.max(0, Math.min(BEATS.length - 1, Math.round(b)));
    this.loaded = null;
    this.phase = 'active';
    this.alarm = null;
    this.caughtLeft = 0;
    this.resetBeatProps();
  }
}

export function installMockApp(world: World, rig: StageRig, fx: Fixture): MockApp | null {
  if (window.__app) return null; // never shadow the real game
  const m = new MockAct1(world, rig, fx);
  const stopFrame = world.onXRFrame(m.onFrame);
  const stopUpdate = onUpdate(world, m.tick);
  const unsubVisibility = world.visibilityState.subscribe((v) => {
    m.paused = v === VisibilityState.Hidden || v === VisibilityState.VisibleBlurred;
  });
  const api: DebugApi = {
    debugState: () => m.debugState(),
    skipTo: (a: number, b?: number) => m.skipTo(a, b),
    setSettings: (patch: Partial<Settings>) => {
      m.settings = { ...m.settings, ...patch };
    },
    fovReport: () => m.fovReport(),
  };
  window.__app = api;
  return {
    api,
    dispose() {
      stopUpdate();
      stopFrame();
      unsubVisibility();
      m.unbindSession();
      if (window.__app === api) delete window.__app;
    },
  };
}
