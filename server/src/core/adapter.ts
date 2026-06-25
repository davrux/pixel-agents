/**
 * Pluggable persistence backend for agent state and user settings.
 *
 * The standalone server uses FileStateAdapter, which persists settings and
 * agent/seat state under the data dir (default ~/.pixel-agents, overridable via
 * PIXEL_STREAM_DATA_DIR) as plain JSON. The interface exists so future hosts can
 * swap in alternate backends without touching the rest of the code.
 *
 * Layout persistence is NOT part of this interface -- named layouts are stored
 * separately in a SQLite database (server/src/layoutStore.ts).
 */

import type { PersistedAgent } from './schemas.js';

export interface StateAdapter {
  // ── Per-adapter persisted state (agents + seats) ────────────────────

  loadAgents(): PersistedAgent[];
  saveAgents(agents: PersistedAgent[]): void;

  loadSeats(): Record<string, { palette?: number; hueShift?: number; seatId?: string }>;
  saveSeats(seats: Record<string, { palette?: number; hueShift?: number; seatId?: string }>): void;

  // ── User-level settings (shared file, namespaced per adapter) ─────

  getSetting<T>(key: string, defaultValue: T): T;
  setSetting<T>(key: string, value: T): void;
}
