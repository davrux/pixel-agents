/**
 * Password hashing: the round trip, and the one input here that is READ rather than received.
 *
 * The scheme is self-describing (`scrypt$N$r$p$salt$hash`) so the cost can be migrated later,
 * which means `verifyHash` takes its parameters from the stored string and scrypt's memory is
 * ≈ 128·N·r. Nothing but `hashPassword` writes those strings, so this was never an open hole —
 * but "bound anything you verify" applies to a value read from a database too: a restored,
 * hand-edited or corrupted row could otherwise make one login attempt ask for gigabytes, and
 * the process would die on someone else's typo.
 *
 * Shared by every credential in the system — accounts, zone passwords, monitor passwords — so
 * these properties hold for all three.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { scryptSync } from 'node:crypto';

import { hashPassword, verifyHash } from './pwhash.js';

test('a hash verifies its own password and nothing else', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.equal(verifyHash(stored, 'correct horse battery staple'), true);
  assert.equal(verifyHash(stored, 'correct horse battery stapl'), false);
  assert.equal(verifyHash(stored, ''), false);
  assert.equal(verifyHash(null, 'anything'), false);
  assert.equal(verifyHash(undefined, 'anything'), false);
  // Same password, different salt: two hashes must not be equal.
  assert.notEqual(hashPassword('same'), hashPassword('same'));
});

test('the stored cost is bounded — a tampered row cannot ask for gigabytes', () => {
  const real = hashPassword('pw');
  const [, , r, p, salt, hash] = real.split('$');
  // N = 2^28 with r = 8 would be ~275 GB of scrypt memory. It must be refused by the parser,
  // not handed to scryptSync — so this returns quickly and false rather than dying.
  const started = Date.now();
  assert.equal(verifyHash(`scrypt$268435456$${r}$${p}$${salt}$${hash}`, 'pw'), false);
  assert.ok(Date.now() - started < 1000, 'an absurd N must be refused, not attempted');
  // Same for the other two multipliers, and for values that are not numbers at all.
  assert.equal(verifyHash(`scrypt$16384$4096$${p}$${salt}$${hash}`, 'pw'), false, 'r counts towards the same ceiling');
  assert.equal(verifyHash(`scrypt$16384$${r}$9999$${salt}$${hash}`, 'pw'), false, 'p must be bounded');
  // scrypt needs a power of two, so a value that is merely small is not automatically fine.
  assert.equal(verifyHash(`scrypt$16385$${r}$${p}$${salt}$${hash}`, 'pw'), false, 'N must be a power of two');
  for (const bogus of ['abc', '0', '-1', '1e9', '16384.5', '']) {
    assert.equal(verifyHash(`scrypt$${bogus}$${r}$${p}$${salt}$${hash}`, 'pw'), false, `N=${bogus} must be refused`);
  }
});

test('a cost inside the bounds still verifies — the cap leaves room to migrate', () => {
  // The point of the self-describing format: a future, more expensive scheme must keep working.
  // 2× today's N, written the way hashPassword would.
  // 4× today's N. It needs an explicit maxmem even to CREATE — 128·65536·8 is 67 MB and the
  // node default is 32 — which is exactly why the ceiling here is a memory number and is passed
  // to scrypt, rather than a cap on N that would have promised a migration it cannot run.
  const salt = 'AAAAAAAAAAAAAAAAAAAAAA==';
  const cost = { N: 65536, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
  const hash = scryptSync('pw', Buffer.from(salt, 'base64'), 32, cost);
  assert.equal(verifyHash(`scrypt$65536$8$1$${salt}$${hash.toString('base64')}`, 'pw'), true);
});

test('a malformed string is refused rather than throwing', () => {
  for (const bad of ['', 'nonsense', 'scrypt$1$2$3', 'bcrypt$16384$8$1$c2FsdA==$aGFzaA==', '$$$$$']) {
    assert.doesNotThrow(() => verifyHash(bad, 'pw'));
    assert.equal(verifyHash(bad, 'pw'), false, `"${bad}" must not pass`);
  }
});
