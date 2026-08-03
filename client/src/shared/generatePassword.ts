/** A random password avoiding visually ambiguous characters (0/O/1/l/I) — used
 *  by every "generate" button (zone/monitor passwords in both the admin site
 *  and Pixels' in-game meeting-room create dialog). */
export function generatePassword(length = 12): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}
