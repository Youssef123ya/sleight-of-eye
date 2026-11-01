// capture/audio-tap.js - inject BEFORE the app loads (Playwright: context.addInitScript({ path })).
// Remembers every AudioNode the page connects to a real-time AudioContext's speakers (ctx.destination):
// for Sleight of Eye that is the audio engine's master soft limiter (src/audio/core.ts: mix -> pause ->
// volume -> compressor -> limiter -> destination), plus three's AudioListener gain if IWSDK ever makes one.
// capture/av-recorder.js connects those same nodes into a MediaStreamAudioDestinationNode, so a recording
// carries exactly what the player hears, post-master, with no change to the game's own audio graph.
(() => {
  if (window.__audioTap) return;
  const proto = AudioNode.prototype;
  const connect = proto.connect;
  const taps = []; // { node, ctx, output, t }
  proto.connect = function (dest, output, input) {
    try {
      if (
        dest instanceof AudioDestinationNode &&
        typeof AudioContext !== 'undefined' &&
        this.context instanceof AudioContext && // never an OfflineAudioContext (the offline verifier)
        !taps.some((t) => t.node === this)
      ) {
        taps.push({ node: this, ctx: this.context, output: output ?? 0, t: performance.now() });
      }
    } catch {
      /* never break the game's audio graph */
    }
    return connect.apply(this, arguments);
  };
  window.__audioTap = {
    taps,
    /** The un-patched AudioNode.connect (the recorder's own wiring does not need to be watched). */
    connect: (node, ...args) => connect.apply(node, args),
  };
})();
