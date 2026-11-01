// The 2D landing page controller (markup + styles live in index.html). Wires "Enter the café" to onEnter
// inside the click handler (keeps the user activation XR + audio need), binds the house-rule switches to the
// settings signal, shows the "open this in the Quest browser" notice, and makes the three felt kits' eyes
// follow your pointer — they look where you look, before you even put the headset on.
import type { Signal } from '@iwsdk/core';
import type { Landing, Settings } from '../contracts.js';
import { ensureFonts } from './fonts.js';

type ToggleKey = 'easyAudience' | 'assist' | 'compactStage' | 'captions';
const TOGGLES: ToggleKey[] = ['easyAudience', 'assist', 'compactStage', 'captions'];

interface Eye {
  white: SVGGraphicsElement;
  pupil: SVGGElement;
  x: number;
  y: number;
  /** last values written to the DOM (skip redundant style writes) */
  wx: number;
  wy: number;
}

class LandingPage implements Landing {
  private cleanup: Array<() => void> = [];
  private root: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private label: HTMLElement | null = null;
  private supported = true;
  private busyTimer = 0;
  private visible = true;
  private raf = 0;
  private eyes: Eye[] = [];
  private lookX = 0;
  private lookY = 0;
  private lastPointer = -1e9;
  private focusEl: Element | null = null;
  private last = 0;
  private reduced = false;

  mount(opts: { onEnter: () => void; settings: Signal<Settings>; xrSupported: boolean }): void {
    this.unmount();
    const root = document.getElementById('landing');
    const button = document.getElementById('enter-btn') as HTMLButtonElement | null;
    if (!root || !button) {
      console.warn('[landing] #landing / #enter-btn missing from index.html; nothing to mount');
      return;
    }
    void ensureFonts();
    this.root = root;
    this.button = button;
    this.label = document.getElementById('enter-label');
    this.supported = opts.xrSupported;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const on = <K extends keyof HTMLElementEventMap>(el: EventTarget, type: K | string, fn: (e: Event) => void, o?: AddEventListenerOptions) => {
      el.addEventListener(type, fn, o);
      this.cleanup.push(() => el.removeEventListener(type, fn, o));
    };

    // ---- enter
    on(button, 'click', () => {
      if (button.disabled || !this.supported || button.getAttribute('aria-busy') === 'true') return;
      // onEnter runs synchronously inside the click: requestSession + AudioContext.resume need the activation
      try {
        opts.onEnter();
      } catch (e) {
        console.error('[landing] onEnter failed', e);
        return;
      }
      this.setBusy(true);
    });
    on(button, 'pointerenter', () => root.classList.add('is-eager'));
    on(button, 'pointerleave', () => root.classList.remove('is-eager'));
    on(button, 'focus', () => root.classList.add('is-eager'));
    on(button, 'blur', () => root.classList.remove('is-eager'));
    const notice = document.getElementById('xr-unsupported');
    if (this.supported) {
      button.disabled = false;
      button.classList.remove('is-unsupported');
      button.setAttribute('aria-describedby', 'enter-facts');
      if (notice) notice.hidden = true;
      this.setLabel('Enter the café', false);
    } else {
      button.disabled = true;
      button.classList.add('is-unsupported');
      button.setAttribute('aria-describedby', 'enter-facts xr-unsupported');
      if (notice) notice.hidden = false;
      this.setLabel('VR headset needed', false);
    }

    // ---- house rules ↔ settings signal
    const switches = Array.from(root.querySelectorAll<HTMLButtonElement>('.opt[data-setting]'));
    for (const sw of switches) {
      const key = sw.dataset.setting as ToggleKey;
      if (!TOGGLES.includes(key)) continue;
      on(sw, 'click', () => {
        const cur = opts.settings.peek();
        opts.settings.value = { ...cur, [key]: !cur[key] };
      });
    }
    this.cleanup.push(
      opts.settings.subscribe((s) => {
        for (const sw of switches) {
          const key = sw.dataset.setting as ToggleKey;
          if (TOGGLES.includes(key)) sw.setAttribute('aria-checked', String(!!s[key]));
        }
      }),
    );
    // honour the OS-level reduced-motion preference once (calmer confetti in XR)
    if (this.reduced && !opts.settings.peek().reducedMotion) {
      opts.settings.value = { ...opts.settings.peek(), reducedMotion: true };
    }

    // ---- the kits watch you
    this.eyes = Array.from(root.querySelectorAll<SVGGElement>('.kit .eye')).flatMap((g) => {
      const white = g.querySelector<SVGGraphicsElement>('circle');
      const pupil = g.querySelector<SVGGElement>('.pupil');
      return white && pupil ? [{ white, pupil, x: 0, y: 0, wx: 1e9, wy: 1e9 }] : [];
    });
    on(window, 'pointermove', (e) => {
      const p = e as PointerEvent;
      this.lookX = p.clientX;
      this.lookY = p.clientY;
      this.lastPointer = performance.now();
    }, { passive: true });
    on(window, 'pointerdown', (e) => {
      const p = e as PointerEvent;
      this.lookX = p.clientX;
      this.lookY = p.clientY;
      this.lastPointer = performance.now();
    }, { passive: true });
    on(root, 'focusin', (e) => {
      this.focusEl = e.target as Element;
      this.lastPointer = -1e9; // keyboard user: look at what has focus
    });
    this.startEyes();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    const root = this.root ?? document.getElementById('landing');
    if (!root) return;
    root.classList.toggle('is-hidden', !visible);
    if (visible) {
      root.classList.add('force-show');
      root.removeAttribute('aria-hidden');
      this.setBusy(false);
      this.startEyes();
    } else {
      root.setAttribute('aria-hidden', 'true');
      this.stopEyes();
      this.setBusy(false);
    }
  }

  // ------------------------------------------------------------------------------------------ helpers
  private setLabel(text: string, dots: boolean): void {
    if (!this.label) return;
    this.label.textContent = text;
    this.label.classList.toggle('dots', dots);
  }

  private setBusy(busy: boolean): void {
    if (!this.button) return;
    clearTimeout(this.busyTimer);
    if (busy) {
      this.button.setAttribute('aria-busy', 'true');
      this.setLabel('Raising the curtain', true);
      // if the session never starts (prompt dismissed, device asleep), offer the button again
      this.busyTimer = window.setTimeout(() => this.setBusy(false), 6000);
    } else {
      this.button.removeAttribute('aria-busy');
      if (this.supported) this.setLabel('Enter the café', false);
    }
  }

  private startEyes(): void {
    if (this.raf || !this.visible || !this.eyes.length) return;
    this.last = performance.now();
    const tick = (now: number) => {
      this.raf = 0;
      if (!this.visible) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.updateEyes(dt, now);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopEyes(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private updateEyes(dt: number, now: number): void {
    let tx = this.lookX;
    let ty = this.lookY;
    if (now - this.lastPointer > 3500) {
      // idle: they watch whatever has focus, else the Enter button
      const el = this.focusEl && document.contains(this.focusEl) ? this.focusEl : this.button;
      if (el) {
        const r = el.getBoundingClientRect();
        tx = r.left + r.width / 2;
        ty = r.top + r.height / 2;
      }
    }
    const k = this.reduced ? 1 : 1 - Math.exp(-dt * 9); // a beat behind you, like in the show
    for (const eye of this.eyes) {
      const r = eye.white.getBoundingClientRect();
      if (!r.width) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = tx - cx;
      const dy = ty - cy;
      const d = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, d / 160) * 3.6; // SVG user units
      eye.x += ((dx / d) * reach - eye.x) * k;
      eye.y += ((dy / d) * reach - eye.y) * k;
      if (Math.abs(eye.x - eye.wx) < 0.02 && Math.abs(eye.y - eye.wy) < 0.02) continue;
      eye.wx = eye.x;
      eye.wy = eye.y;
      eye.pupil.style.transform = `translate(${eye.x.toFixed(2)}px, ${eye.y.toFixed(2)}px)`;
    }
  }

  private unmount(): void {
    for (const off of this.cleanup.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.stopEyes();
    clearTimeout(this.busyTimer);
  }
}

export const landing: Landing = new LandingPage();
