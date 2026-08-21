/**
 * Renderer half of the Mumble hotkeys: turning a KeyboardEvent into the same
 * canonical accelerator string the desktop main process stores and registers
 * ("Ctrl+Shift+M" — see desktop/src/mumble/accelerator.ts, which re-validates
 * everything that crosses IPC; the two files keep the same grammar by hand,
 * since the workspaces deliberately share no imports).
 *
 * One function serves both jobs. The settings view *records* a combo by calling
 * it on a keydown, and MumbleVoice *matches* a keydown by calling it and
 * comparing strings — so a combo that cannot be produced here can never be
 * matched here either, and modifier order can never disagree with itself.
 *
 * The grammar refuses anything that would fire on plain typing: a key with no
 * modifier stronger than Shift is only accepted as an F-key.
 */

/** Canonical modifier order, matching the desktop-side sanitizer. */
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'] as const;

const NAMED_CODES = new Set(['Space', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete']);
const ARROWS = new Set(['Up', 'Down', 'Left', 'Right']);

/** The accelerator key name for a physical key, or null when the key is not in
 *  the grammar. Built from `code`, not `key`, so the combo names a position on
 *  the keyboard and Shift cannot turn "5" into "%". */
function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (NAMED_CODES.has(code)) return code;
  if (code.startsWith('Arrow') && ARROWS.has(code.slice(5))) return code.slice(5);
  return null;
}

/**
 * The canonical accelerator a keydown spells, or null when it spells none — a
 * lone modifier, a key outside the grammar, or a combo that would swallow
 * typing (no modifier beyond Shift and not an F-key).
 */
export function acceleratorFromEvent(e: KeyboardEvent): string | null {
  const key = keyFromCode(e.code);
  if (!key) return null;
  const held = {
    Ctrl: e.ctrlKey,
    Alt: e.altKey,
    Shift: e.shiftKey,
    Super: e.metaKey,
  };
  const isFKey = /^F\d+$/.test(key);
  if (!held.Ctrl && !held.Alt && !held.Super && !isFKey) return null;
  return [...MOD_ORDER.filter((m) => held[m]), key].join('+');
}

/** Whether a keydown belongs to something the user is typing into, where a
 *  hotkey must never steal the key. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
