# Sleight of Eye

Close-up magic for a tiny felt audience that looks wherever you look.

[Play in Quest Browser](https://youssef123ya.github.io/sleight-of-eye/)

You are the magician at a midnight café. Lift a coin, guide the audience's attention with your gaze, and palm it while they look away. Three acts introduce fox kits, a magpie drawn to shiny things, and a critic who watches your hands. Getting caught rewinds the trick so you can try another plan.

## Playing

Enter with hand tracking enabled and sit comfortably. Pinch to lift or palm a prop, then poke the highlighted target to reveal it. Look at the music box, candle, or firework to distract the audience. The table plaques offer Retry, Easy Audience, Assist, Recenter, and Exit. Assist supports gaze and a pinch with either hand.

Quest uses head direction for gaze; an eye-gaze input source is used when the WebXR runtime provides one. The experience is built with Meta's Immersive Web SDK and runs from a URL.

## Development

Use the Node version in `.nvmrc`.

```sh
npm ci
npm run typecheck
npm run dev
```

For the existing automated emulator harness and footage capture, `npm run dev:local` serves HTTP on `127.0.0.1:8081`. Stop another runtime for this workspace first with `npm run dev:down`.

```sh
node tests/run-all.mjs
npm run build
```

The tests drive Meta's Immersive Web Emulator in installed Chrome. They cover all three acts, caught rewinds, pause/resume, audio lifecycle, autosave, Exit/re-entry, geometric field-of-view fit, and rendering budgets. Desktop emulator timings do not establish physical Quest performance; the glasses field-of-view checks establish layout fit, not hardware validation.

## Trailer tooling

`capture/film-takes.mjs` records real emulator gameplay and game audio with semantic edit marks. It requires the local development server and saves takes under ignored `captures/`. Capture utilities and the recording endpoint are development-only.

The café, puppets, effects, music, and foley are procedural. Third-party font, input-model, and library credits are in [CREDITS.md](CREDITS.md).
