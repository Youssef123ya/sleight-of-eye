// capture/director.js - dev-only "demo director" for IWSDK + IWER (tested with iwer 2.7.0,
// @iwsdk/core 1.1.0-rc.2, Chrome 156). No imports: it drives the emulated device that
// @iwsdk/vite-plugin-dev injects as window.IWER_DEVICE, so it never ships in a production build.
//
// Load it in the page (Vite serves files under the project root in dev):
//   const { DemoDirector } = await import('/capture/director.js');
//
// Coordinates are IWER global space = the app's local-floor origin: metres, +Y up, -Z forward,
// floor at y = 0 (true for IWSDK's default local-floor space without locomotion).

/* ------------------------------------------------------------------ math */
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const clamp01 = (t) => Math.min(1, Math.max(0, t));

export const EASE = {
  linear: (t) => t,
  smooth: (t) => t * t * (3 - 2 * t),
  sine: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),
  // same curve IWER uses for 'minimum-jerk' (10t^3 - 15t^4 + 6t^5)
  minJerk: (t) => t * t * t * (10 + t * (-15 + 6 * t)),
};

/** Quaternion [x,y,z,w] from an orthonormal basis given as columns x, y, z. */
function quatFromBasis(x, y, z) {
  const m00 = x[0], m01 = y[0], m02 = z[0];
  const m10 = x[1], m11 = y[1], m12 = z[1];
  const m20 = x[2], m21 = y[2], m22 = z[2];
  const tr = m00 + m11 + m22;
  let qx, qy, qz, qw;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    qw = 0.25 / s; qx = (m21 - m12) * s; qy = (m02 - m20) * s; qz = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
  }
  const l = Math.hypot(qx, qy, qz, qw);
  return [qx / l, qy / l, qz / l, qw / l];
}

/** Camera/headset rotation looking from `from` toward `to` (-Z forward), optional roll (deg). */
export function lookRotation(from, to, rollDeg = 0) {
  const f = norm(sub(to, from));
  const z = mul(f, -1);
  let up = [0, 1, 0];
  if (Math.abs(dot(up, z)) > 0.999) up = [0, 0, 1];
  let x = norm(cross(up, z));
  let y = cross(z, x);
  if (rollDeg) {
    const r = (rollDeg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    const nx = add(mul(x, c), mul(y, s));
    y = add(mul(y, c), mul(x, -s));
    x = nx;
  }
  return quatFromBasis(x, y, z);
}

/**
 * Wrist rotation from hand directions, as IWER's wristRotationFromDirections does
 * (iwer/src/device/XRHandInput.ts): fingers = wrist -Z, palm = wrist -Y; `thumb` may replace palm.
 */
export function wristRotation(fingers, palmOrThumb, handedness = 'right', useThumb = false) {
  const z = norm(mul(fingers, -1));
  let y;
  if (useThumb) {
    y = cross(palmOrThumb, fingers);
    if (handedness === 'right') y = mul(y, -1);
  } else {
    y = mul(palmOrThumb, -1);
  }
  y = norm(sub(y, mul(z, dot(y, z))));
  const x = cross(y, z);
  return quatFromBasis(x, y, z);
}

/** Uniform Catmull-Rom through points, clamped at both ends; u in [0,1] over the whole path. */
function catmullRom(points, u) {
  const n = points.length;
  if (n === 1) return points[0].slice();
  const seg = Math.min(n - 2, Math.floor(u * (n - 1)));
  const t = u * (n - 1) - seg;
  const p0 = points[Math.max(0, seg - 1)], p1 = points[seg];
  const p2 = points[seg + 1], p3 = points[Math.min(n - 1, seg + 2)];
  const t2 = t * t, t3 = t2 * t;
  return [0, 1, 2].map((i) =>
    0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
      (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3));
}

/**
 * A track is either an array of points (spread evenly over the shot) or
 * { points: [[x,y,z], ...], ease: 'smooth' | 'sine' | 'minJerk' | 'linear', from?: s, to?: s }.
 * Returns position at shot time t (seconds) for a shot of `duration` seconds.
 */
function sampleTrack(track, t, duration) {
  const spec = Array.isArray(track) ? { points: track } : track;
  const from = spec.from ?? 0;
  const to = spec.to ?? duration;
  const e = EASE[spec.ease ?? 'sine'];
  const u = e(clamp01((t - from) / Math.max(1e-6, to - from)));
  return catmullRom(spec.points, u);
}

/** Piecewise-linear scalar keys [{t, v}] (seconds), e.g. pinch ramps. */
function sampleKeys(keys, t) {
  if (!keys || keys.length === 0) return undefined;
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      return a.v + (b.v - a.v) * ((t - a.t) / Math.max(1e-6, b.t - a.t));
    }
  }
  return keys[keys.length - 1].v;
}

const NAMED_DIR = { up: [0, 1, 0], down: [0, -1, 0], forward: [0, 0, -1], back: [0, 0, 1], left: [-1, 0, 0], right: [1, 0, 0] };
const dir3 = (d) => (typeof d === 'string' ? NAMED_DIR[d] : d);

/* -------------------------------------------------------------- director */
export class DemoDirector {
  /**
   * Wait for IWER, accept the offered XR session, switch to hands, make the capture clean.
   * @param {object} o
   * @param {number} [o.fovyDeg=60]   vertical FOV of the emulated view (IWER default is 90)
   * @param {'hand'|'controller'} [o.inputMode='hand']
   * @param {boolean} [o.hideOverlays=true]  hide DevUI panels/gizmos + "Remote Control Active" pill
   * @param {boolean} [o.showRoom=true]       SEM room ("fake passthrough") visible, plane/box overlays off
   * @param {string}  [o.room]                SEM room id to load, e.g. 'kitchen'
   * @param {string}  [o.windowTitle]         set document.title (window title for screen capture)
   */
  static async attach(o = {}) {
    const dev = await waitFor(() => window.IWER_DEVICE, 30000, 'window.IWER_DEVICE');
    // Remote control hands the device back to DevUI ('manual') 30 s after its last command, and
    // DevUI then rewrites every pose each frame. A long take must not hit that mid-shot.
    dev.remote.RELEASE_TIMEOUT_MS = 24 * 3600 * 1000;
    if (o.room && dev.sem) await dev.sem.loadDefaultEnvironment(o.room);
    if (!dev.activeSession) {
      await waitFor(() => dev.sessionOffered || dev.activeSession, 60000, 'an offered XR session');
      if (!dev.activeSession) await dev.remote.dispatch('accept_session');
      await waitFor(() => dev.activeSession, 30000, 'XR session start');
    }
    const d = new DemoDirector(dev);
    await dev.remote.dispatch('set_input_mode', { mode: o.inputMode ?? 'hand' });
    dev.fovy = ((o.fovyDeg ?? 60) * Math.PI) / 180;
    d.clean(o.hideOverlays ?? true, o.showRoom ?? true);
    if (o.windowTitle) document.title = o.windowTitle; // stable title for ffmpeg gfxcapture
    d.#hold();
    return d;
  }

  constructor(dev) {
    this.dev = dev;
    this.session = dev.activeSession;
  }

  /** Hide emulator chrome so screen capture (pipeline 2) shows only the XR view. */
  clean(hideOverlays = true, showRoom = true) {
    const { devui, sem } = this.dev;
    if (devui) {
      devui.devUIContainer.style.display = hideOverlays ? 'none' : '';
      devui.devUICanvas.style.display = hideOverlays ? 'none' : '';
    }
    if (sem) {
      sem.meshesVisible = showRoom;   // the room itself
      sem.planesVisible = false;      // plane debug overlays
      sem.boundingBoxesVisible = false;
    }
    document.body.style.cursor = 'none';
  }

  /**
   * Keep the device under programmatic control. In 'manual' mode DevUI rewrites the headset and
   * hand poses every frame (InputLayer.syncDeviceTransforms), and remote control drops back to
   * manual 30 s after its last command (RemoteControlInterface.RELEASE_TIMEOUT_MS).
   */
  #hold() {
    const loop = () => {
      if (!this.dev.activeSession) return;
      if (this.dev.controlMode !== 'programmatic') this.dev.controlMode = 'programmatic';
      this.dev.activeSession.requestAnimationFrame(loop);
    };
    this.dev.controlMode = 'programmatic';
    this.dev.activeSession.requestAnimationFrame(loop);
  }

  /** Teleport the headset: position + look-at target (no animation). */
  place({ head, look, roll = 0 }) {
    this.dev.position.set(...head);
    this.dev.quaternion.set(...lookRotation(head, look, roll));
  }

  /**
   * Play one shot: head and both hands follow smooth splines at the same time; pinch/pose keys
   * are evaluated on the same clock. Resolves when the shot ends (XR-frame time, ~16.7 ms steps).
   *
   * shot = {
   *   duration: 6,
   *   head:  { pos: track, look: track, roll?: deg },
   *   right: { anchor: 'index-tip'|'grasp'|'wrist'|..., pos: track,
   *            fingers: 'forward'|[x,y,z], palm: 'down'|[x,y,z]   (or thumb: ...),
   *            poses: [{ t: 0, id: 'point', fade: 0.25 }], pinch: [{ t, v }] } | null (hidden),
   *   left:  same | null,
   *   onFrame?: (t) => void,
   * }
   */
  play(shot) {
    const dev = this.dev;
    const session = dev.activeSession;
    const sides = ['left', 'right'];
    for (const side of sides) {
      const h = shot[side];
      if (h === null) dev.hands[side].connected = false;
      else if (h) dev.hands[side].connected = true;
    }
    const fades = { left: null, right: null };
    const poseIdx = { left: 0, right: 0 };
    return new Promise((resolve) => {
      let start = null;
      const frame = (time) => {
        if (start === null) start = time;
        // poses written now are applied by IWER at the start of the next XR frame
        const t = Math.min(shot.duration, (time - start) / 1000 + 1 / 60);
        if (shot.head) {
          const p = sampleTrack(shot.head.pos, t, shot.duration);
          const l = shot.head.look ? sampleTrack(shot.head.look, t, shot.duration) : add(p, [0, 0, -1]);
          dev.position.set(p[0], p[1], p[2]);
          dev.quaternion.set(...lookRotation(p, l, shot.head.roll ?? 0));
        }
        for (const side of sides) {
          const h = shot[side];
          if (!h) continue;
          const hand = dev.hands[side];
          // timed pose changes (fade with IWER's own pose blending)
          const poses = h.poses ?? [];
          while (poseIdx[side] < poses.length && t >= poses[poseIdx[side]].t) {
            const k = poses[poseIdx[side]++];
            if (k.fade > 0 && hand.beginPoseTransition(k.id)) fades[side] = { t0: t, d: k.fade };
            else hand.poseId = k.id;
          }
          const f = fades[side];
          if (f) {
            const p = clamp01((t - f.t0) / f.d);
            hand.poseTransitionProgress = EASE.minJerk(p); // >= 1 ends the fade
            if (p >= 1) fades[side] = null;
          }
          const pinch = sampleKeys(h.pinch, t);
          if (pinch !== undefined) hand.updatePinchValue(clamp01(pinch));
          if (h.pos) {
            const target = sampleTrack(h.pos, t, shot.duration);
            const pin = { anchor: h.anchor ?? 'index-tip', target };
            if (h.fingers) {
              const fingers = norm(dir3(h.fingers));
              pin.wristRotation = h.thumb
                ? wristRotation(fingers, norm(dir3(h.thumb)), side, true)
                : wristRotation(fingers, norm(dir3(h.palm ?? 'down')), side, false);
            }
            hand.setPin(pin);
          }
        }
        shot.onFrame?.(t);
        if (t >= shot.duration) resolve();
        else session.requestAnimationFrame(frame);
      };
      session.requestAnimationFrame(frame);
    });
  }

  /** Hold the current pose for `seconds` (XR-frame time). */
  wait(seconds) {
    return this.play({ duration: seconds });
  }

  /**
   * IWER's own human-like hand sequence (press / grab / carry / release with head follow).
   * Targets are IWSDK scene object names (see `await director.targets()`).
   * Note: run_sequence drives the head too (gaze: 'follow'); don't run play() at the same time.
   */
  sequence(params) {
    return this.dev.remote.runSequence(params);
  }

  async targets() {
    return this.dev.remote.dispatch('list_targets');
  }

  /* ------------------------------------------------------------ recording */
  /**
   * Record the XR view with MediaRecorder. In AR the SEM room is a separate canvas behind the
   * app canvas, so both are composited into one 2D canvas once per XR frame, after the app has
   * rendered (this callback is queued after three.js' own XR rAF callback).
   * @param {object} o
   * @param {string} [o.name='take']            output file name (sink writes captures/<name>.<ext>)
   * @param {string} [o.mimeType]               default: H.264 in MP4 if supported, else VP9 WebM
   * @param {number} [o.bitrate=40e6]           videoBitsPerSecond
   * @param {string|null} [o.sink='/__capture'] dev-server upload endpoint; null => download link
   */
  async startRecording(o = {}) {
    const dev = this.dev;
    const app = dev.appCanvas;
    const sem = dev.sem && dev.sem.meshesVisible !== false ? dev.sem.environmentCanvas : null;
    const W = app.width, H = app.height;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d', { alpha: false, desynchronized: true });
    const stream = out.captureStream(0); // frames are pushed manually, one per XR frame
    const track = stream.getVideoTracks()[0];
    const mimeType = o.mimeType ?? [
      'video/mp4;codecs=avc1.640028',
      'video/webm;codecs=h264',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
    ].find((m) => MediaRecorder.isTypeSupported(m));
    const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
    const name = `${o.name ?? 'take'}.${ext}`;
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: o.bitrate ?? 40e6 });
    const sink = o.sink === undefined ? '/__capture' : o.sink;
    const chunks = [];
    let upload = Promise.resolve();
    let bytes = 0;
    let frames = 0;
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      bytes += e.data.size;
      if (sink) {
        const body = e.data;
        upload = upload.then(() =>
          fetch(`${sink}/append?name=${encodeURIComponent(name)}`, { method: 'POST', body }));
      } else chunks.push(e.data);
    };
    if (sink) await fetch(`${sink}/open?name=${encodeURIComponent(name)}`, { method: 'POST' });
    let running = true;
    const session = dev.activeSession;
    const draw = () => {
      if (!running) return;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      if (sem) ctx.drawImage(sem, 0, 0, W, H);
      ctx.drawImage(app, 0, 0, W, H);
      track.requestFrame();
      frames++;
      session.requestAnimationFrame(draw);
    };
    session.requestAnimationFrame(draw);
    rec.start(1000); // 1 s chunks keep memory flat and uploads small
    const t0 = performance.now();
    return {
      mimeType, name,
      stop: () => new Promise((resolve) => {
        rec.onstop = async () => {
          running = false;
          await upload;
          const seconds = (performance.now() - t0) / 1000;
          if (sink) {
            const r = await fetch(`${sink}/close?name=${encodeURIComponent(name)}`, { method: 'POST' });
            resolve({ name, mimeType, bytes, frames, seconds, fps: frames / seconds, saved: await r.text() });
          } else {
            const blob = new Blob(chunks, { type: mimeType });
            const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
            document.body.appendChild(a); a.click(); a.remove();
            resolve({ name, mimeType, bytes, frames, seconds, fps: frames / seconds });
          }
        };
        rec.stop();
      }),
    };
  }
}

function waitFor(fn, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const poll = () => {
      let v;
      try { v = fn(); } catch { v = undefined; }
      if (v) return resolve(v);
      if (performance.now() - t0 > timeoutMs) return reject(new Error(`Timed out waiting for ${what}`));
      setTimeout(poll, 50);
    };
    poll();
  });
}

if (typeof window !== "undefined") window.DemoDirector = DemoDirector;
