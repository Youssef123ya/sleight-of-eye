// capture/virtual-time.js - inject BEFORE the app loads (Playwright: page.addInitScript({ path })).
// Makes page time advance exactly 1/FPS per animation frame, however long the frame really took,
// so app animation, IWER remote/sequence timing, ActionPlayer and the director all step in
// lock-step with the encoder: a slow or hitching frame no longer shows up as a jump in the video.
// Real timers (setTimeout/setInterval), audio and CSS animations are NOT virtualised.
(() => {
  const FPS = Number(new URLSearchParams(location.search).get('vtfps')) || 60;
  const STEP = 1000 / FPS;
  const realRAF = window.requestAnimationFrame.bind(window);
  const realNow = performance.now.bind(performance);
  let now = realNow();
  const dateOffset = Date.now() - now;
  let queue = new Map();
  let nextId = 1;
  let frames = 0;
  performance.now = () => now;
  Date.now = () => Math.floor(now + dateOffset);
  window.requestAnimationFrame = (cb) => { const id = nextId++; queue.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { queue.delete(id); };
  const tick = () => {
    // optional back-pressure: a recorder can close the gate while its encoder queue is long
    const gate = window.__virtualTime.gate;
    if (gate && !gate()) { realRAF(tick); return; }
    now += STEP;
    frames++;
    const cbs = queue;
    queue = new Map();
    for (const cb of cbs.values()) {
      try { cb(now); } catch (e) { console.error(e); }
    }
    realRAF(tick); // pace on the real display/headless clock (never faster than real time)
  };
  realRAF(tick);
  window.__virtualTime = { fps: FPS, step: STEP, gate: null, get now() { return now; }, get frames() { return frames; }, realNow };
})();
