/**
 * Validation for the two Mumble hotkey accelerators ("Ctrl+Shift+M").
 *
 * Kept free of Electron imports so it can be unit-tested with `node --test`
 * like the protocol modules. The renderer records combos in the same canonical
 * form (client/src/voice/hotkeys.ts builds them from KeyboardEvents); this side
 * re-validates because the string crosses IPC from the less-trusted renderer
 * and ends up in `globalShortcut.register`, which throws on garbage.
 *
 * The grammar is deliberately a subset of what Electron accepts: modifiers from
 * a fixed set, one key from a fixed set, and — unless the key is an F-key — at
 * least one modifier stronger than Shift, so a hotkey can never swallow plain
 * typing once it is grabbed system-wide.
 */

/** Modifier canonical order, so "Shift+Ctrl+M" and "Ctrl+Shift+M" are one string. */
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'] as const;
const MODS: ReadonlySet<string> = new Set(MOD_ORDER);

const KEY_RE = /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete)$/;

/** Longest legal value: four modifiers, a '+' each, and an 8-char key name. */
const MAX_LENGTH = 40;

/**
 * A stored or incoming hotkey, normalised to canonical modifier order — or ''
 * when it is not a string, not in the grammar, or would fire on plain typing.
 * '' means "no hotkey", which is also the default.
 */
export function sanitizeHotkey(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw || raw.length > MAX_LENGTH) return '';
  const parts = raw.split('+');
  const key = parts[parts.length - 1] ?? '';
  if (!KEY_RE.test(key)) return '';
  const mods = new Set<string>();
  for (const mod of parts.slice(0, -1)) {
    if (!MODS.has(mod) || mods.has(mod)) return '';
    mods.add(mod);
  }
  const isFKey = /^F\d+$/.test(key);
  const hasRealModifier = [...mods].some((m) => m !== 'Shift');
  if (!hasRealModifier && !isFKey) return '';
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}
