// UI type: font stacks shared by the 2D landing page (CSS vars + @font-face in index.html) and every canvas texture
// in XR. Playfair Display and Nunito are self-hosted OFL variable fonts in public/fonts/ (licences alongside);
// the system stacks behind them are only fallbacks if a file fails to load.

/** Elegant display serif: titles, mastheads, posters, title cards. */
export const FONT_DISPLAY =
  '"Playfair Display", "Didot", "Bodoni 72", "Bodoni MT", "Palatino Linotype", Palatino, "Book Antiqua", "Noto Serif", Georgia, serif';
/** Friendly rounded sans: captions, plaque labels, small print. */
export const FONT_BODY =
  '"Nunito", "Avenir Next", Avenir, "Segoe UI", Roboto, "Trebuchet MS", "Helvetica Neue", Arial, sans-serif';

interface SelfHostedFont {
  family: string;
  /** File name inside public/fonts/. */
  file: string;
  descriptors?: FontFaceDescriptors;
}

/** Self-hosted fonts (google/fonts, SIL OFL 1.1), loaded with FontFace before any canvas text is drawn. */
const SELF_HOSTED: SelfHostedFont[] = [
  { family: 'Playfair Display', file: 'PlayfairDisplay-Variable.ttf', descriptors: { weight: '400 900' } },
  { family: 'Playfair Display', file: 'PlayfairDisplay-Italic-Variable.ttf', descriptors: { weight: '400 900', style: 'italic' } },
  { family: 'Nunito', file: 'Nunito-Variable.ttf', descriptors: { weight: '200 1000' } },
];

let ready: Promise<void> | null = null;

/** Resolve once every face used by canvas text is loaded (system fonts resolve immediately). Never rejects. */
export function ensureFonts(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    if (typeof document === 'undefined' || !document.fonts) return;
    try {
      for (const f of SELF_HOSTED) {
        const face = new FontFace(f.family, `url(${import.meta.env.BASE_URL}fonts/${encodeURI(f.file)})`, f.descriptors);
        document.fonts.add(await face.load());
      }
      await Promise.all([
        document.fonts.load(`700 64px ${FONT_DISPLAY}`),
        document.fonts.load(`italic 400 64px ${FONT_DISPLAY}`),
        document.fonts.load(`900 64px ${FONT_DISPLAY}`),
        document.fonts.load(`600 64px ${FONT_BODY}`),
        document.fonts.load(`800 64px ${FONT_BODY}`),
        document.fonts.load(`900 64px ${FONT_BODY}`),
        document.fonts.load(`italic 600 64px ${FONT_BODY}`),
      ]);
      await document.fonts.ready;
    } catch (e) {
      console.warn('[ui] font loading failed; using fallback faces', e);
    }
  })();
  return ready;
}
