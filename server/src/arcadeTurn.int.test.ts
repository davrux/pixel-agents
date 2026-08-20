/**
 * What the arcade hands a client as its ICE configuration.
 *
 * Two things worth pinning, and one of them was a real bug. js-dos does not merge: it sets
 * `s.iceServers = <our list>` and drops its own, so this list is the whole answer. It used
 * to append `stun:stun.l.google.com:19302` whenever ARCADE_STUN_URLS was unset — which is
 * every deployment that configures a TURN relay and no explicit STUN, i.e. the normal one.
 * The result was a client reaching out to a third party it had no need for, and the only
 * entry in the list that needed DNS at all: `Failed to resolve address for
 * stun.l.google.com, errorcode: -105`, logged next to a perfectly good relay of our own.
 *
 * The other is the credential scheme: coturn's REST secret must stay on the server, and
 * what travels is an expiry plus its HMAC. A test that only checked "username is set" would
 * pass on a leaked secret, so this recomputes the HMAC and asserts the secret is absent.
 */
import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { arcadeIceServers, arcadeTurnConfigured } from './arcadeTurn.js';

/** Run `fn` with exactly these ARCADE_* vars set, restoring the environment after. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const keys = ['ARCADE_TURN_URLS', 'ARCADE_TURN_SECRET', 'ARCADE_TURN_TTL', 'ARCADE_STUN_URLS'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
    fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const flatUrls = (servers: ReturnType<typeof arcadeIceServers>): string[] =>
  servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));

test('a deployment with its own relay names no third party', () => {
  withEnv({ ARCADE_TURN_URLS: 'turn:relay.example:3478', ARCADE_TURN_SECRET: 's3cret' }, () => {
    const urls = flatUrls(arcadeIceServers());
    assert.deepEqual(urls.sort(), ['stun:relay.example:3478', 'turn:relay.example:3478']);
    // The regression, stated as the property rather than as the one hostname: nothing in
    // the list may point anywhere but at the relay this deployment configured.
    for (const u of urls) {
      assert.ok(u.includes('relay.example'), `${u} points somewhere we were not asked to point`);
    }
  });
});

test('explicit STUN wins, and is not mixed with a derived one', () => {
  withEnv(
    {
      ARCADE_TURN_URLS: 'turn:relay.example:3478',
      ARCADE_TURN_SECRET: 's3cret',
      ARCADE_STUN_URLS: 'stun:stun.example:3478,stun:stun2.example:3478',
    },
    () => {
      const urls = flatUrls(arcadeIceServers());
      assert.ok(urls.includes('stun:stun.example:3478'));
      assert.ok(urls.includes('stun:stun2.example:3478'));
      assert.equal(urls.includes('stun:relay.example:3478'), false, 'an explicit list is the whole answer');
    },
  );
});

test('with nothing configured the list is empty, so js-dos decides for itself', () => {
  withEnv({}, () => {
    assert.deepEqual(arcadeIceServers(), [], 'we name no server we were not given');
    assert.equal(arcadeTurnConfigured(), false);
  });
  // Half-configured counts as not configured: a TURN URL without its secret cannot be used,
  // and minting a credential from an empty secret would hand out one that never validates.
  withEnv({ ARCADE_TURN_URLS: 'turn:relay.example:3478' }, () => {
    assert.equal(arcadeTurnConfigured(), false);
    assert.deepEqual(flatUrls(arcadeIceServers()), ['stun:relay.example:3478'], 'STUN still derives; TURN does not');
  });
});

test('TURN credentials are an expiry plus its HMAC — the secret stays here', () => {
  const now = 1_700_000_000_000;
  withEnv({ ARCADE_TURN_URLS: 'turn:relay.example:3478', ARCADE_TURN_SECRET: 's3cret', ARCADE_TURN_TTL: '600' }, () => {
    const servers = arcadeIceServers(now);
    const turn = servers.find((s) => flatUrls([s]).some((u) => u.startsWith('turn')));
    assert.ok(turn, 'no TURN entry');
    assert.equal(turn.username, String(Math.floor(now / 1000) + 600), 'username is the expiry coturn checks');
    assert.equal(
      turn.credential,
      createHmac('sha1', 's3cret').update(turn.username!).digest('base64'),
      'credential must be the HMAC coturn will recompute',
    );
    assert.equal(JSON.stringify(servers).includes('s3cret'), false, 'the shared secret must never travel');
    assert.equal(arcadeTurnConfigured(), true);
  });
});
