/**
 * Helmets: what a driver looks like FROM ABOVE.
 *
 * A kart is drawn as a true overhead view and a character is a 16×32 sprite that faces the
 * camera, which is the mixture most top-down games live with — until you sit one in the other and
 * see a standing person from the front inside a kart seen from above. The way out is not to redraw
 * every character from above (skins are drawn by whoever owns them, including in the editor) nor
 * to give up the kart's free rotation. It is that a helmet IS the top of a head: a disc with a
 * visor, correct from above by construction and the same for every skin ever drawn.
 *
 * The set is a GRID rather than a hand-written list — every shell colour in every pattern — so a
 * large choice costs two short tables instead of fifty entries somebody has to keep consistent.
 * Adding a colour adds a row of helmets; adding a pattern adds a column.
 *
 * Ids are `<shell>-<pattern>` and therefore stable: a stored preference keeps meaning what it
 * meant, and neither table may be reordered so much as renamed. The empty id is not "no helmet" —
 * it means TAKE IT FROM MY OWN HEAD, which is what somebody who never opens the menu gets: the
 * colours read off their own sheet, so a full grid is still twelve people you can tell apart.
 */

/** One helmet's colours, as the renderer needs them. */
export interface HelmetStyle {
  id: string;
  label: string;
  /** The shell. */
  shell: string;
  /** The stripe, spots or second half — whatever the pattern paints. */
  trim: string;
  pattern: HelmetPattern;
}

export type HelmetPattern = 'plain' | 'stripe' | 'twin' | 'halves' | 'spots';

/**
 * The shells. House palette first, because those are the colours the rest of the UI uses and a
 * helmet beside a red kart should be able to be the same red.
 *
 * APPEND ONLY: an id is built from the name below it.
 */
const SHELLS: readonly { id: string; label: string; shell: string; trim: string }[] = [
  { id: 'cherry', label: 'Cherry', shell: '#c51a1b', trim: '#f1efec' },
  { id: 'midnight', label: 'Midnight', shell: '#26386f', trim: '#e7da00' },
  { id: 'sun', label: 'Sun', shell: '#e7da00', trim: '#141312' },
  { id: 'moss', label: 'Moss', shell: '#5aa348', trim: '#f1efec' },
  { id: 'amber', label: 'Amber', shell: '#d47a1e', trim: '#141312' },
  { id: 'plum', label: 'Plum', shell: '#8a4cc0', trim: '#f1efec' },
  { id: 'lagoon', label: 'Lagoon', shell: '#2fb3c0', trim: '#141312' },
  { id: 'blossom', label: 'Blossom', shell: '#d6629e', trim: '#f1efec' },
  { id: 'chalk', label: 'Chalk', shell: '#f1efec', trim: '#c51a1b' },
  { id: 'soot', label: 'Soot', shell: '#242220', trim: '#e7da00' },
  { id: 'rust', label: 'Rust', shell: '#7c2634', trim: '#d47a1e' },
  { id: 'mint', label: 'Mint', shell: '#7fbf6a', trim: '#26386f' },
];

/** The patterns. APPEND ONLY, same reason. */
const PATTERNS: readonly { id: HelmetPattern; label: string }[] = [
  { id: 'plain', label: 'plain' },
  { id: 'stripe', label: 'stripe' },
  { id: 'twin', label: 'twin stripe' },
  { id: 'halves', label: 'halves' },
  { id: 'spots', label: 'spots' },
];

/** Every shell in every pattern — twelve times five, in a fixed order. */
export const HELMETS: readonly HelmetStyle[] = SHELLS.flatMap((shell) =>
  PATTERNS.map((pattern) => ({
    id: `${shell.id}-${pattern.id}`,
    label: `${shell.label} ${pattern.label}`,
    shell: shell.shell,
    trim: shell.trim,
    pattern: pattern.id,
  })),
);

/** "Use the colours of my own head" — what a driver who never chose one gets. */
export const DEFAULT_HELMET = '';

/** Is this an id this build knows? The empty string counts: it is the derived default. */
export function isHelmetId(value: unknown): value is string {
  return value === DEFAULT_HELMET || (typeof value === 'string' && HELMETS.some((h) => h.id === value));
}

/** The style for an id, or null for "derive it from the driver's own sheet". */
export function helmetStyle(id: string | null | undefined): HelmetStyle | null {
  if (!id) return null;
  return HELMETS.find((h) => h.id === id) ?? null;
}
