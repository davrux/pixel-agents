# A deployment, end to end

pixel-agents and LiveKit on **one host**, behind one TLS front door. Everything
in this directory is a complete, runnable example: four containers, four config
files, and the procedure below.

This is not what [uponu.com](https://uponu.com) runs — that is two hosts, and
`../docker-compose.prod.yml` is the half of it that lives in git. The single host
is the shape worth learning from, because it makes the one thing explicit that
two hosts let you ignore: **LiveKit and the game server have to share port 443**,
and how they share it decides most of this file.

```
                    :80  redirect        :443
                      │                   │
                 ┌────┴───────────────────┴────┐
                 │   caddy  (livekit/caddyl4)  │   TLS by SNI
                 └──┬──────────┬───────────┬───┘
     pixels.…       │  livekit.…           │  livekit-turn.…
                    ▼          ▼           ▼
            127.0.0.1:6161   :7880       :5349
            pixel-agents     livekit ◄── redis :6379
                 │             │
              pixel-data    :7881 tcp, 50000-60000 udp, 3478 udp
              (SQLite)         (media, straight to the client)
```

## Why one Caddy, and why that image

A browser in a corporate network can often reach exactly one outbound port: 443.
LiveKit's TURN relay — the fallback for clients whose UDP is blocked — therefore
has to answer TLS on 443 too, and so do the game server and the LiveKit
websocket. Three services, one port.

`livekit/caddyl4` is Caddy with the **layer4** plugin, which reads the SNI out of
the TLS handshake and routes on the hostname before anything HTTP happens. That
is what lets TURN (not an HTTP protocol at all) and two web services share a
port. A plain `caddy:2` cannot do this, which is the only reason `caddy.yaml`
is YAML config instead of the two-line Caddyfile next door.

Two routes terminate TLS and offer **http/1.1 only**. That is deliberate: both
Colyseus and the LiveKit signalling are websockets, the upgrade is an HTTP/1.1
mechanism, and advertising h2 there breaks the connection. The TURN route sets no
ALPN policy at all, because what is inside that TLS is not HTTP.

## What you need first

- A host with a **public IPv4 address**, Docker and `docker compose` v2.
- **Three DNS names** pointing at it — A, and AAAA if the host has IPv6:

  | name | what it is |
  |---|---|
  | `pixels.example.com` | the game |
  | `livekit.example.com` | the LiveKit websocket |
  | `livekit-turn.example.com` | TURN over TLS |

  All three must resolve **before the first start**. Caddy asks Let's Encrypt
  for a certificate per name at startup, and a name that does not resolve fails
  the challenge. Five failed validations per hostname per hour is the limit you
  will hit while guessing, so get DNS right first.
- **Ports open** at the firewall:

  | port | proto | for |
  |---|---|---|
  | 443 | tcp | everything above, plus the ACME challenge |
  | 7881 | tcp | WebRTC over TCP, for clients with no usable UDP |
  | 3478 | udp | TURN |
  | 50000-60000 | udp | the media itself |
  | 80 | tcp | optional — only the http→https redirect |

  Open them for **IPv6 as well** if the host has an address. This is the trap
  that costs an afternoon: add an AAAA record, leave the v6 firewall shut, and
  every check looks green while half your clients cannot connect.

  Not open, on purpose: **5349**. Caddy terminates TLS for TURN and hands
  LiveKit plaintext on it, so it must stay on loopback. Same for **6161** and
  **6379**.

## Running it

```bash
cp .env.example .env
chmod 600 .env
$EDITOR .env                       # the two secrets, and the admin token
```

Then replace the three placeholder hostnames. They appear in two files and
nowhere else:

```bash
sed -i 's/pixels\.example\.com/pixels.yourdomain.tld/g;
        s/livekit\.example\.com/livekit.yourdomain.tld/g;
        s/livekit-turn\.example\.com/livekit-turn.yourdomain.tld/g' \
       caddy.yaml livekit.yaml
```

`LIVEKIT_URL` in `.env` has to match the LiveKit name you just set — it is the
address sent to the browser.

```bash
docker compose up -d
docker compose logs -f caddy       # watch the certificates arrive
```

Then open `https://pixels.yourdomain.tld/register`, and enter your
`PIXEL_ADMIN_TOKEN` along with the account you want. Presenting that token on
the register screen is what makes an account an admin — it is the only way to
create the first one.

**The world is empty until you push a map.** A bundled map only ever seeds a
zone that has none, so from a checkout:

```bash
scripts/push-zones.sh --server=pixels.yourdomain.tld:443
```

with `PIXEL_ADMIN_TOKEN` in the environment.

## The one key pair

`LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are used on **both** sides: the game
server signs a short-lived, room-scoped token with them for every participant,
and the LiveKit container verifies it. Two different pairs is the failure that
looks like a network problem — every call refused, nothing in any log saying
why.

So: generate once, put the same two values in `.env`, and do not regenerate them
on a whim. The secret never reaches a browser; only the URL does.

## What is deliberately missing

**coturn.** `../docker-compose.prod.yml` runs one for the arcade's IPX
multiplayer, and on a single host it would collide with LiveKit — both want
3478/udp, and both need host networking. Arcade multiplayer falls back to
STUN-only without it, which works for most players. If you need the relay, move
coturn to another port or a second host.

**A signalling broker for the arcade.** The relay above is only half of what a
peer-to-peer DOS game needs. The other half is how two players find each other
and exchange their SDP offers at all, and that is **not in this stack and not
ours**: `webrtcnet.wasm` inside the js-dos player opens a WebSocket to
`https://net.dos.zone`, a service run by the js-dos project, and only once that
has introduced the two peers does any ICE server get used. So a perfectly
healthy deployment can still have dead arcade multiplayer. Measured here on
2026-11-11: the host refused connections on both 80 and 443 from two independent
networks, and was back the same day — with nothing on our side having changed.

If you would rather not depend on it, the URL is overridable: `net.peerServer`
(`client/src/arcade/jsdos.ts`) is passed straight through to the WASM, and
js-dos publishes a self-hostable relay binary — see
<https://js-dos.com/networking.html>. One caveat before you do: that server
documents no authentication of its own, and its protocol can relay game data as
well as signalling, so it wants a gate in front of it rather than an open port.

**A static IP.** `livekit.yaml` discovers the host's public address over STUN at
startup, which is right for a host whose address can change. If yours is static,
pin it — the file says exactly how, and why half of that change is silently
useless on its own.

**Automated deploys.** This example is `docker compose up -d` by hand.
`../../.github/workflows/deploy.yml` is the pipeline version for the production
host: it builds the image, pushes it to ghcr.io and writes the `.env` from
GitHub secrets over SSH.

## Keeping it

The `pixel-agents_pixel-data` volume is the world — accounts, maps, avatars, zone
permissions, saved games. Back up **that**; everything else in this directory is
reproducible from git.

It is SQLite in WAL mode, so copying `pixel.db` on its own can lose whatever is
still in the write-ahead log. Stop the container and take the whole volume:

```bash
docker compose stop pixel-agents
docker run --rm -v pixel-agents_pixel-data:/data -v "$PWD:/out" alpine \
  tar czf /out/pixel-data-$(date +%F).tar.gz -C /data .
docker compose start pixel-agents
```

`pixel-agents_caddy-data` holds the ACME account and the issued certificates. Losing it is
survivable — Caddy simply asks again — but Let's Encrypt allows only 5
certificates per identical set of names per 7 days, so do not throw it away
casually.

## When it does not work

**The certificate never arrives.** Check DNS first (`dig +short pixels.…`), then
that 443 is reachable from outside. `docker compose logs caddy` names the
hostname it failed on.

**Video connects, then nothing.** Almost always the UDP range. Confirm
50000-60000/udp is open, on both address families, and watch for LiveKit logging
an external IP that is not this host's.

**Every call refused.** The key pair does not match. `docker compose config |
grep -E 'LIVEKIT_KEYS|LIVEKIT_API'` prints both sides as they are actually
passed, with the values resolved from `.env`.

**The game loads but the world is empty.** No map has been pushed yet. See above.
