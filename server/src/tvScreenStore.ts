/**
 * What each television shows, per zone — see Action `tvScreen` and `shared/office/tvScreen.ts`.
 *
 * One row per zone × television, keyed by the piece's anchor tile (`"col,row"`, `tvScreenKey`)
 * rather than its placement uid, because every map import mints new uids and a pushed map would
 * otherwise blank every screen in the zone. The picture is the PNG this server re-encoded
 * (`screenFromPng`), stored as a BLOB like `assets.png`, plus the two numbers a renderer needs to
 * slice it and a delay per frame.
 *
 * `hash` is the content hash, and it is what makes the serving URL a capability: the GET route
 * answers only for the CURRENT hash, so a URL is only known to someone who was in the zone while
 * that picture was synced — a private zone's television cannot be read by guessing a tile.
 *
 * No `user_id`: a picture belongs to the zone it hangs in, not to whoever put it there, and it
 * stays when that account goes (the change is logged with the account that made it). No foreign
 * key to `zones`, following `pet_scores` — `ZoneStore.delete` clears it.
 */
import { createHash } from 'node:crypto';

import { db } from './db.js';

export interface TvScreen {
  key: string;
  png: Buffer;
  frameW: number;
  frameH: number;
  delays: number[];
  hash: string;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS tv_screens (
    zone_id TEXT NOT NULL,
    screen TEXT NOT NULL,
    png BLOB NOT NULL,
    frame_w INTEGER NOT NULL,
    frame_h INTEGER NOT NULL,
    delays TEXT NOT NULL,
    hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (zone_id, screen)
  )
`);

type Row = { screen: string; png: Uint8Array; frame_w: number; frame_h: number; delays: string; hash: string };

function fromRow(r: Row): TvScreen | null {
  let delays: unknown;
  try {
    delays = JSON.parse(r.delays);
  } catch {
    return null;
  }
  if (!Array.isArray(delays) || !delays.every((d) => Number.isInteger(d) && d >= 0 && d <= 65535)) return null;
  return {
    key: r.screen,
    png: Buffer.from(r.png),
    frameW: r.frame_w,
    frameH: r.frame_h,
    delays: delays as number[],
    hash: r.hash,
  };
}

export const tvScreenStore = {
  /** Store a picture and return it with its hash. The hash covers the delays and frame size too,
   *  since the same pixels played at another speed are a different thing to fetch. */
  set(zoneId: string, key: string, png: Buffer, frameW: number, frameH: number, delays: number[]): TvScreen {
    const hash = createHash('sha256')
      .update(png)
      .update(`|${frameW}x${frameH}|${delays.join(',')}`)
      .digest('hex')
      .slice(0, 24);
    db.prepare(
      `INSERT INTO tv_screens (zone_id, screen, png, frame_w, frame_h, delays, hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (zone_id, screen) DO UPDATE SET png = excluded.png, frame_w = excluded.frame_w,
         frame_h = excluded.frame_h, delays = excluded.delays, hash = excluded.hash, updated_at = excluded.updated_at`,
    ).run(zoneId, key, png, frameW, frameH, JSON.stringify(delays), hash, Date.now());
    return { key, png, frameW, frameH, delays, hash };
  },

  get(zoneId: string, key: string): TvScreen | null {
    const r = db
      .prepare('SELECT screen, png, frame_w, frame_h, delays, hash FROM tv_screens WHERE zone_id = ? AND screen = ?')
      .get(zoneId, key) as Row | undefined;
    return r ? fromRow(r) : null;
  },

  /** Every picture in a zone, without the bytes — what a room syncs. */
  list(zoneId: string): Array<Omit<TvScreen, 'png'>> {
    const rows = db
      .prepare('SELECT screen, frame_w, frame_h, delays, hash FROM tv_screens WHERE zone_id = ?')
      .all(zoneId) as Array<Omit<Row, 'png'>>;
    const out: Array<Omit<TvScreen, 'png'>> = [];
    for (const r of rows) {
      const s = fromRow({ ...r, png: new Uint8Array(0) });
      if (s) out.push({ key: s.key, frameW: s.frameW, frameH: s.frameH, delays: s.delays, hash: s.hash });
    }
    return out;
  },

  clear(zoneId: string, key: string): boolean {
    return db.prepare('DELETE FROM tv_screens WHERE zone_id = ? AND screen = ?').run(zoneId, key).changes > 0;
  },

  /** Everything this zone has stored, dropped with the zone (see ZoneStore.delete). */
  clearZone(zoneId: string): void {
    db.prepare('DELETE FROM tv_screens WHERE zone_id = ?').run(zoneId);
  },
};
