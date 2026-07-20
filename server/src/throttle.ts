/**
 * Generic sliding-window failure throttle for online password/secret guessing.
 * Used to bound brute-force + scrypt CPU-DoS on the zone/monitor password checks
 * (the client is untrusted — see AGENTS.md #9). Same shape as the login throttle in
 * auth.ts, but keyed by an arbitrary string (e.g. `zone:<id>:<userId>`), so an
 * attacker gets a short cooldown after too many wrong attempts and can't hammer the
 * check. In-memory, per-process; bounded to avoid unbounded growth.
 */
const MAX_FAILS = 10;
const WINDOW_MS = 60_000;
const fails = new Map<string, { count: number; until: number }>();

/** True when `key` has hit the failure limit and is still cooling down. */
export function isThrottled(key: string): boolean {
  const e = fails.get(key);
  if (!e) return false;
  if (Date.now() > e.until) {
    fails.delete(key);
    return false;
  }
  return e.count >= MAX_FAILS;
}

/** Record one failed attempt for `key` (sliding window). */
export function noteFail(key: string): void {
  const now = Date.now();
  if (fails.size > 10_000) fails.clear(); // bound memory
  const e = fails.get(key);
  if (!e || now > e.until) fails.set(key, { count: 1, until: now + WINDOW_MS });
  else {
    e.count += 1;
    e.until = now + WINDOW_MS; // sustained attempts stay cooled down
  }
}

/** Clear the counter for `key` (call on a successful attempt). */
export function clearFails(key: string): void {
  fails.delete(key);
}
