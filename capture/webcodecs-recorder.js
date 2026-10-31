// capture/webcodecs-recorder.js - frame-exact alternative to MediaRecorder.
// Every XR frame becomes exactly one H.264 frame with timestamp = index / fps, so the output is
// constant-frame-rate by construction (no encoder warm-up drops, no VFR jitter).
// Output: captures/<name>.h264 (Annex B, BT.709 limited range, no timestamps/colour tags).
// Turn it into an editable MP4 with the ffmpeg command in capture/record.mjs (setparams + setpts).
export async function startWebCodecsRecording(dev, o = {}) {
  const fps = o.fps ?? 60;
  const sink = o.sink ?? '/__capture';
  const app = dev.appCanvas;
  const sem = dev.sem && dev.sem.meshesVisible !== false ? dev.sem.environmentCanvas : null;
  const W = app.width, H = app.height;
  const out = new OffscreenCanvas(W, H);
  const ctx = out.getContext('2d', { alpha: false });
  const name = `${o.name ?? 'take'}.h264`;
  const q = `${sink}/append?name=${encodeURIComponent(name)}`;
  await fetch(`${sink}/open?name=${encodeURIComponent(name)}`, { method: 'POST' });

  let config;
  // H.264 High profile: level 4.2 (…2A) fits 1080p60, level 5.2 (…34) fits 2160p60
  const codecs = W * H > 1920 * 1088 ? ['avc1.640034', 'avc1.640033'] : ['avc1.64002A', 'avc1.640028', 'avc1.4D002A'];
  for (const codec of o.codec ? [o.codec] : codecs) {
    const c = {
      codec, width: W, height: H, framerate: fps,
      bitrate: o.bitrate ?? 40e6, bitrateMode: 'variable',
      hardwareAcceleration: o.hardware ?? 'no-preference',
      latencyMode: 'quality',
      avc: { format: 'annexb' },
    };
    if ((await VideoEncoder.isConfigSupported(c)).supported) { config = c; break; }
  }
  if (!config) throw new Error('No supported H.264 VideoEncoder config');

  let pending = [], bytes = 0, upload = Promise.resolve(), error = null;
  const flushUpload = () => {
    if (!pending.length) return;
    const body = new Blob(pending);
    pending = [];
    upload = upload.then(() => fetch(q, { method: 'POST', body }));
  };
  const enc = new VideoEncoder({
    output: (chunk) => {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      bytes += buf.byteLength;
      pending.push(buf);
      if (pending.length >= fps / 2) flushUpload();
    },
    error: (e) => { error = e; },
  });
  enc.configure(config);

  let frames = 0, running = true, maxQueue = 0;
  // Under capture/virtual-time.js, hold page time while the encoder catches up (bounded memory).
  if (window.__virtualTime) window.__virtualTime.gate = () => enc.encodeQueueSize <= (o.maxQueue ?? 4);
  const session = dev.activeSession;
  const t0 = performance.now();
  const draw = () => {
    if (!running) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (sem) ctx.drawImage(sem, 0, 0, W, H);
    ctx.drawImage(app, 0, 0, W, H);
    const vf = new VideoFrame(out, { timestamp: Math.round((frames * 1e6) / fps), duration: Math.round(1e6 / fps) });
    enc.encode(vf, { keyFrame: frames % (fps * 2) === 0 }); // a keyframe every 2 s helps the editor scrub
    vf.close();
    frames++;
    maxQueue = Math.max(maxQueue, enc.encodeQueueSize);
    session.requestAnimationFrame(draw);
  };
  session.requestAnimationFrame(draw);

  return {
    config,
    stop: async () => {
      running = false;
      if (window.__virtualTime) window.__virtualTime.gate = null;
      await enc.flush();
      enc.close();
      flushUpload();
      await upload;
      const r = await fetch(`${sink}/close?name=${encodeURIComponent(name)}`, { method: 'POST' });
      const seconds = (performance.now() - t0) / 1000;
      return { name, codec: config.codec, frames, seconds, xrFps: frames / seconds, bytes, maxQueue, error: error && String(error), saved: await r.text() };
    },
  };
}
