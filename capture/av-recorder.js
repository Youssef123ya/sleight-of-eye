// capture/av-recorder.js - REAL-TIME in-page recorder: the XR view and the game's own audio in one file.
//
// Video: once per XR frame, after three.js has rendered, the IWER app canvas is copied into a 2D canvas whose
// captureStream(0) track gets exactly one requestFrame() per XR frame (the director.js pattern).
// Audio: every node the page connected to the speakers (capture/audio-tap.js, injected before the app loads) is
// also connected into a MediaStreamAudioDestinationNode: the post-master mix the player hears.
// Both tracks go into ONE MediaRecorder, so they share one clock; chunks stream to the dev-server sink
// (capture/vite-capture-sink.ts) as captures/<name>.webm.
//
// Clapperboard: clap() mutes the game in the RECORDING only (never at the speakers), then on one XR frame draws
// white frames and starts a 1 kHz beep scheduled exactly like the game's own one-shots (currentTime + 12 ms).
// capture/trailer.mjs finds both in the file and uses them to trim video and audio separately, so the sync of the
// final clip is measured per take instead of assumed. Marks (mark(name)) log XR-frame times for trimming.
const LEAD = 0.012; // src/audio/core.ts LEAD: one-shots start this far after ctx.currentTime

export async function startAVRecording(dev, o = {}) {
  const sink = o.sink ?? '/__capture';
  const app = dev.appCanvas;
  const W = app.width;
  const H = app.height;
  const comp = document.createElement('canvas');
  comp.width = W;
  comp.height = H;
  const g = comp.getContext('2d', { alpha: false, desynchronized: true });
  const vstream = comp.captureStream(0); // one frame pushed per XR frame
  const vtrack = vstream.getVideoTracks()[0];

  // ---------------------------------------------------------------- audio: the game's master (what reaches the speakers)
  const tap = window.__audioTap;
  if (!tap) throw new Error('capture/audio-tap.js was not injected before the app loaded');
  const actx = tap.taps[0]?.ctx;
  if (!actx) throw new Error('the game never connected anything to the speakers (audio engine not unlocked?)');
  if (actx.state !== 'running') await Promise.race([actx.resume(), new Promise((r) => setTimeout(r, 1500))]);
  const dest = actx.createMediaStreamDestination();
  dest.channelCount = 2;
  dest.channelCountMode = 'explicit';
  dest.channelInterpretation = 'speakers';
  const game = actx.createGain(); // the game's mix in the recording (muted around claps)
  tap.connect(game, dest);
  const tapped = new Set();
  const tapNew = () => {
    for (const t of tap.taps) {
      if (t.ctx !== actx || tapped.has(t.node)) continue;
      tapped.add(t.node);
      tap.connect(t.node, game, t.output);
    }
  };
  tapNew();
  const beep = actx.createGain();
  beep.gain.value = 0;
  tap.connect(beep, dest);
  const osc = actx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 1000;
  tap.connect(osc, beep);
  osc.start();

  // ---------------------------------------------------------------- recorder
  const stream = new MediaStream([vtrack, ...dest.stream.getAudioTracks()]);
  const types = o.mimeType
    ? [o.mimeType]
    : ['video/webm;codecs=h264,opus', 'video/x-matroska;codecs=avc1,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'];
  const mimeType = types.find((m) => MediaRecorder.isTypeSupported(m));
  if (!mimeType) throw new Error(`no supported MediaRecorder type among ${types.join(', ')}`);
  const ext = mimeType.startsWith('video/x-matroska') ? 'mkv' : 'webm';
  const name = `${o.name ?? 'take'}.${ext}`;
  const rec = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: o.videoBitrate ?? 40e6,
    audioBitsPerSecond: o.audioBitrate ?? 320_000,
  });
  const q = (op) => `${sink}/${op}?name=${encodeURIComponent(name)}`;
  const post = async (op, body) => {
    const r = await fetch(q(op), { method: 'POST', body });
    if (!r.ok) throw new Error(`capture ${op} failed: HTTP ${r.status} ${r.statusText}`);
    return r;
  };
  const cleanup = () => {
    for (const node of [osc, beep, game]) {
      try {
        if (node === osc) osc.stop();
        node.disconnect();
      } catch {
        /* the page may be tearing down */
      }
    }
    for (const node of tapped) {
      try { node.disconnect(game); } catch { /* already disconnected */ }
    }
    for (const track of stream.getTracks()) track.stop();
  };
  try {
    await post('open');
  } catch (error) {
    cleanup();
    throw error;
  }
  let upload = Promise.resolve();
  let bytes = 0;
  let uploadErrors = 0;
  let uploadFailure = null;
  rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    bytes += e.data.size;
    const body = e.data;
    // Consume each rejection here: data events cannot await this chain. stop() reports the first failure after
    // flushing and closing the sink, so a corrupt take is never returned as a successful recording.
    upload = upload.then(() => post('append', body)).catch((error) => {
      uploadErrors++;
      uploadFailure ??= error;
    });
  };

  // ---------------------------------------------------------------- per-XR-frame compositor + timing log
  const session = dev.activeSession;
  const CAP = 60 * 600;
  const perf = new Float64Array(CAP);
  const audioT = new Float64Array(CAP);
  let frames = 0;
  let running = true;
  let flash = 0;
  let flashFrames = 0;
  const pendingMarks = [];
  const marks = [];
  let clapResolve = null;
  let pendingClap = 'clap';
  const draw = () => {
    if (!running) return;
    const now = performance.now();
    const at = actx.currentTime;
    if (frames < CAP) {
      perf[frames] = now;
      audioT[frames] = at;
    }
    if (flash > 0) {
      if (flash === flashFrames) {
        // first white frame: the beep starts the way the game starts a one-shot
        beep.gain.setValueAtTime(0.5, at + LEAD);
        beep.gain.setValueAtTime(0, at + LEAD + flashFrames / 60);
        marks.push({ name: pendingClap, frame: frames, perf: now, actx: at, beepAt: at + LEAD });
        clapResolve?.();
        clapResolve = null;
      }
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, W, H);
      flash--;
    } else {
      g.drawImage(app, 0, 0, W, H);
    }
    if (pendingMarks.length) {
      for (const m of pendingMarks) marks.push({ name: m, frame: frames, perf: now, actx: at });
      pendingMarks.length = 0;
    }
    vtrack.requestFrame();
    frames++;
    if ((frames & 31) === 0) tapNew(); // a speaker connection made after the start is picked up too
    session.requestAnimationFrame(draw);
  };
  session.requestAnimationFrame(draw);
  rec.start(1000);
  const t0 = performance.now();

  const xrFrames = (n) =>
    new Promise((resolve) => {
      let left = n;
      const tick = () => (--left <= 0 ? resolve() : session.requestAnimationFrame(tick));
      session.requestAnimationFrame(tick);
    });
  const ramp = (param, v, at, sec = 0.012) => {
    param.cancelScheduledValues(at);
    param.setValueAtTime(param.value, at);
    param.linearRampToValueAtTime(v, at + sec);
  };

  return {
    name,
    mimeType,
    /** Log the next XR frame drawn under `label` (trailer.mjs trims to marks). */
    mark(label) {
      pendingMarks.push(label);
    },
    /** Clapperboard: game muted in the recording ±0.25 s, `nFrames` white frames + a 1 kHz beep on the same frame. */
    async clap(label = 'clap', { nFrames = 4, quiet = 0.25 } = {}) {
      ramp(game.gain, 0, actx.currentTime);
      await xrFrames(Math.round(quiet * 60));
      pendingClap = label;
      flashFrames = nFrames;
      await new Promise((resolve) => {
        clapResolve = resolve;
        flash = nFrames;
      });
      await xrFrames(nFrames + Math.round(quiet * 60));
      ramp(game.gain, 1, actx.currentTime);
      await xrFrames(2);
    },
    /** Level of the recorded game mix right now (debug). */
    stats() {
      return { frames, seconds: (performance.now() - t0) / 1000, bytes, audioState: actx.state };
    },
    stop: () =>
      new Promise((resolve, reject) => {
        rec.onstop = async () => {
          running = false;
          try {
            await upload;
            const r = await post('close');
            if (uploadFailure) throw uploadFailure;
            const seconds = (performance.now() - t0) / 1000;
            // frame-interval stats (real-time capture: a hitch shows up as a long interval)
            const n = Math.min(frames, CAP);
            const iv = [];
            for (let i = 1; i < n; i++) iv.push(perf[i] - perf[i - 1]);
            iv.sort((a, b) => a - b);
            const pct = (p) => (iv.length ? iv[Math.min(iv.length - 1, Math.floor(iv.length * p))] : 0);
            resolve({
              name,
              mimeType,
              saved: await r.text(),
              bytes,
              uploadErrors,
              frames,
              seconds,
              startPerf: t0,
              firstFramePerf: frames ? perf[0] : null,
              firstFrameActx: frames ? audioT[0] : null,
              xrFps: frames / seconds,
              frameMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: iv.length ? iv[iv.length - 1] : 0 },
              longFrames: iv.filter((v) => v > 25).length,
              marks,
              audio: {
                state: actx.state,
                sampleRate: actx.sampleRate,
                baseLatency: actx.baseLatency,
                outputLatency: actx.outputLatency,
                taps: tapped.size,
              },
              canvas: [W, H],
            });
          } catch (error) {
            reject(error);
          } finally {
            cleanup();
          }
        };
        rec.stop();
      }),
  };
}
