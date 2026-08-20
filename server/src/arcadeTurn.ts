/**
 * ICE server config for arcade IPX multiplayer (js-dos / HumbleNet WebRTC).
 *
 * Players connect peer-to-peer (joiner → host); with everyone behind NAT and only
 * the server public, a TURN relay is required for the data path. Run coturn on the
 * public host and point these env vars at it:
 *
 *   ARCADE_TURN_URLS    comma-separated TURN URLs, e.g.
 *                       "turn:turn.example.com:3478,turns:turn.example.com:5349"
 *   ARCADE_TURN_SECRET  coturn `static-auth-secret` (use-auth-secret / TURN REST) —
 *                       the server mints short-lived credentials from it; the secret
 *                       itself never reaches the client.
 *   ARCADE_TURN_TTL     credential lifetime in seconds (default 43200 = 12h)
 *   ARCADE_STUN_URLS    optional comma-separated STUN URLs; if unset we derive a
 *                       stun: URL from each turn host (coturn answers STUN on the
 *                       same port).
 *
 * No public STUN server is named here. It used to append stun.l.google.com whenever
 * ARCADE_STUN_URLS was unset — including when a deployment HAD its own relay, which is
 * every real deployment. js-dos replaces its own ICE config with whatever list we hand it
 * (`s.iceServers = e`), so that entry was ours, and it was the only host in the list
 * needing DNS: a client that cannot resolve it logs `Failed to resolve address for
 * stun.l.google.com, errorcode: -105` while its own relay sits there working.
 *
 * With nothing configured this returns an EMPTY list, the client then passes no `net`
 * config at all, and js-dos falls back to its own default (five Google STUN servers).
 * Same outcome as before for a bare LAN test, but it is then js-dos' choice of third
 * party rather than a hardcoded one of ours.
 */
import { createHmac } from 'node:crypto';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const list = (v?: string): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Derive a stun: URL from a turn:/turns: URL (same host:port). */
function stunFromTurn(turnUrl: string): string | null {
  const m = /^turns?:(.+)$/.exec(turnUrl);
  return m ? `stun:${m[1]}` : null;
}

/**
 * Build the ICE server list for one match. TURN credentials are ephemeral: coturn's
 * REST scheme expects username = "<expiry-unix>" and credential = base64(HMAC-SHA1(
 * secret, username)); coturn accepts any user whose HMAC matches until expiry.
 */
export function arcadeIceServers(now: number = Date.now()): IceServer[] {
  const turnUrls = list(process.env.ARCADE_TURN_URLS);
  const stunUrls = list(process.env.ARCADE_STUN_URLS);
  const servers: IceServer[] = [];

  // STUN: explicit, else derived from the TURN hosts. Nothing else — see the header.
  const stun = new Set<string>(stunUrls);
  if (!stun.size) {
    for (const t of turnUrls) {
      const s = stunFromTurn(t);
      if (s) stun.add(s);
    }
  }
  if (stun.size) servers.push({ urls: [...stun] });

  // TURN: ephemeral credentials from the shared secret.
  const secret = process.env.ARCADE_TURN_SECRET?.trim();
  if (turnUrls.length && secret) {
    const ttl = Number(process.env.ARCADE_TURN_TTL) || 43200;
    const username = String(Math.floor(now / 1000) + ttl);
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    servers.push({ urls: turnUrls, username, credential });
  }
  return servers;
}

/** Whether a TURN relay is configured (for logging / diagnostics). */
export function arcadeTurnConfigured(): boolean {
  return list(process.env.ARCADE_TURN_URLS).length > 0 && !!process.env.ARCADE_TURN_SECRET?.trim();
}
