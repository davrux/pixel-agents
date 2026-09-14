/**
 * The helmet grid in the settings panel.
 *
 * Sixty helmets is too many for a row of buttons, so each one is a small disc painted in CSS —
 * the same shell, trim and pattern the renderer draws, expressed as a background rather than as
 * pixels. A picture per helmet would be sixty images to keep in step with the table; a gradient
 * is the table read twice.
 *
 * The first swatch is the DEFAULT, which is not a colour at all but "take my own": it shows as a
 * dashed ring, because a swatch painted in some arbitrary colour would be a lie about what you
 * are choosing.
 */
import { HELMETS, type HelmetStyle } from '@pixel/shared/office/race/helmets.js';

/** The CSS that paints one helmet's pattern — the same five cases the renderer has. */
function background(h: HelmetStyle): string {
  const { shell, trim } = h;
  switch (h.pattern) {
    case 'stripe':
      return `linear-gradient(90deg, ${shell} 0 38%, ${trim} 38% 62%, ${shell} 62% 100%)`;
    case 'twin':
      return `linear-gradient(90deg, ${shell} 0 22%, ${trim} 22% 34%, ${shell} 34% 66%, ${trim} 66% 78%, ${shell} 78% 100%)`;
    case 'halves':
      return `linear-gradient(0deg, ${shell} 0 50%, ${trim} 50% 100%)`;
    case 'spots':
      return `radial-gradient(circle at 32% 32%, ${trim} 0 22%, transparent 22%),` +
        `radial-gradient(circle at 70% 66%, ${trim} 0 22%, transparent 22%), ${shell}`;
    default:
      return shell;
  }
}

const escape = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Every helmet as a swatch, the default first. */
export function helmetPickerHtml(): string {
  const mine =
    `<button class="lid own" data-helmet="" title="Your own colours" aria-label="Your own colours"></button>`;
  return (
    mine +
    HELMETS.map(
      (h) =>
        `<button class="lid" data-helmet="${escape(h.id)}" title="${escape(h.label)}" ` +
        `aria-label="${escape(h.label)}" style="background:${background(h)}"></button>`,
    ).join('')
  );
}
