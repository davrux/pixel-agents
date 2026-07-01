#!/usr/bin/env bash
# mmo-readiness — audit the architecture contract from AGENTS.md.
# Static checks always run (fast, no network). Build/typecheck run unless --static.
# Exit non-zero if any HARD check fails. MANUAL items are printed for human review.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

STATIC_ONLY=0
[[ "${1:-}" == "--static" ]] && STATIC_ONLY=1

fail=0
pass()  { printf '  \033[32m✓ PASS\033[0m  %s\n' "$1"; }
bad()   { printf '  \033[31m✗ FAIL\033[0m  %s\n' "$1"; fail=1; }
warn()  { printf '  \033[33m! WARN\033[0m  %s\n' "$1"; }
man()   { printf '  \033[36m? CHECK\033[0m %s\n' "$1"; }
head()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

# 1 — Behaviour tree / server-only deps must not reach the client bundle ------
head "1. Server-only code stays off the client"
if [[ -d client/dist ]]; then
  if grep -rqiE "mistreevous|BehaviourTree|MistreeVous" client/dist; then
    bad "behaviour-tree code found in client/dist (NPC brain must be server-only)"
  else
    pass "no behaviour-tree code in client/dist"
  fi
else
  warn "client/dist not built — run 'pnpm build' to verify the shipped bundle"
fi
if grep -rqiE "mistreevous|from ['\"].*server" client/src 2>/dev/null; then
  bad "client/src imports a behaviour tree or the server package"
else
  pass "client/src imports no behaviour tree / server package"
fi

# 2 — Client renders, never simulates ----------------------------------------
# Importing OfficeState as a layout/tile container (renderer + editor authoring
# path) is fine; what's forbidden is the client DRIVING the simulation tick.
head "2. Client does not simulate"
if grep -rqnE "\b(os|officeState|state|sim)\.update\s*\(" client/src 2>/dev/null; then
  bad "client/src calls the OfficeState simulation tick (.update(dt) is server-only)"
else
  pass "no simulation-tick call in client/src (layout-only OfficeState use is fine)"
fi
if grep -rqnE "function .*(findPath|aStar|astar)\b|class .*AStar" client/src 2>/dev/null; then
  warn "client/src looks like it defines pathfinding — movement must be server-resolved"
else
  pass "no client-side pathfinding definition"
fi

# 3 — No second game / physics / render engine -------------------------------
head "3. One engine only (Colyseus + Phaser)"
BANNED="matter-js|planck|box2d|box2d-wasm|p2|cannon|cannon-es|ammo|rapier|babylonjs|@babylonjs|playcanvas|three|pixi\.js|excalibur|melonjs|kaboom|kaplay"
hits=$(grep -rEn "\"($BANNED)\"" --include=package.json . 2>/dev/null | grep -v node_modules)
if [[ -n "$hits" ]]; then
  bad "a second game/physics/render engine is declared:"; echo "$hits" | sed 's/^/        /'
else
  pass "no banned game/physics/render engine in any package.json"
fi

# 4 — Every client message has a server-side handler (validation is manual) ---
head "4. Server authority over client input"
handlers=$(grep -rhoE "onMessage\(\s*['\"][^'\"]+['\"]" server/src 2>/dev/null | sed -E "s/.*['\"]([^'\"]+)['\"]/\1/" | sort -u)
if [[ -n "$handlers" ]]; then
  pass "onMessage handlers found ($(echo "$handlers" | wc -l | tr -d ' ') types)"
  man "confirm each validates identity/length/format/bounds before mutating state:"
  echo "$handlers" | sed 's/^/        - /'
else
  warn "no onMessage handlers found — expected at least player/character handlers"
fi

# 5 — Unified entity model & zone/portal conventions -------------------------
head "5. Entity / zone / portal model reused (not forked)"
if grep -qE "extends EntitySync" shared/src/schema/officeSync.ts 2>/dev/null; then
  pass "synced entities extend EntitySync"
else
  bad "no schema extends EntitySync — new entities must reuse the base transform"
fi
extra_rooms=$(grep -rlE "extends Room\b" server/src 2>/dev/null | grep -viE "SimRoom" )
if [[ -n "$extra_rooms" ]]; then
  warn "extra Room subclass(es) — zones should be instances of the one room, matchmade by zone:"; echo "$extra_rooms" | sed 's/^/        /'
else
  pass "single room type (zones via filterBy)"
fi
man "new travel = placed 'portal' furniture + a ZONES entry, not a hard-coded jump"
man "no module-global mutable game state outside a room (keep rooms shared-nothing)"
man "client works in BOTH Chrome and Firefox (esp. media: setSinkId on elements, not AudioContext; no single-browser-only API without graceful fallback)"

# 5b — Security / authorization (AGENTS.md rule #9) --------------------------
head "5b. Security & authorization"
if [[ -f server/src/permissions.ts ]] && grep -rq "\.may(" server/src/rooms 2>/dev/null; then
  pass "central permission policy present (permissions.ts + may() in rooms)"
else
  warn "permissions.ts / may() not found — admin & world actions must be gated centrally"
fi
# Heuristic: settings/prefs writes should be per-user, not a global setSetting from a handler.
if grep -rnE "onMessage\([^)]*set(Sound|AlwaysShowLabels|AlertVolume)" server/src 2>/dev/null | grep -q "_c"; then
  bad "viewer-settings handlers ignore the client — personal prefs must be keyed by the authed userId, not global"
fi
man "every state-mutating onMessage authorizes: personal data keyed by authOf(client).userId (never a client-supplied id/name); shared/admin actions via may(client, capability)"
man "secrets stay server-side: LiveKit key/secret, admin token, password hashes never sent to the client; a user only ever gets its OWN agent token"
man "a new message/command decides its capability/ownership in the same change and defaults to deny; client-side hiding is UX only"

# 6 — Build & typecheck ------------------------------------------------------
if [[ $STATIC_ONLY -eq 0 ]]; then
  head "6. Typecheck + build"
  for pkg in shared server client; do
    if [[ -x $pkg/node_modules/.bin/tsc ]]; then
      if (cd $pkg && ./node_modules/.bin/tsc --noEmit) >/tmp/mmo-tsc.$pkg 2>&1; then
        pass "tsc --noEmit clean ($pkg)"
      else
        bad "tsc failed ($pkg) — see /tmp/mmo-tsc.$pkg"
      fi
    else
      warn "$pkg/node_modules/.bin/tsc missing — run pnpm install"
    fi
  done
  if [[ -x client/node_modules/.bin/vite ]]; then
    if (cd client && ./node_modules/.bin/vite build) >/tmp/mmo-vite 2>&1; then
      pass "client vite build succeeded"
    else
      bad "client vite build failed — see /tmp/mmo-vite"
    fi
  else
    warn "client vite missing — run pnpm install"
  fi
else
  head "6. Typecheck + build"; warn "skipped (--static)"
fi

printf '\n\033[1mResult:\033[0m '
if [[ $fail -eq 0 ]]; then printf '\033[32mno hard failures\033[0m. Resolve any ? CHECK / ! WARN items by hand.\n'; else printf '\033[31mhard failures present — fix before shipping.\033[0m\n'; fi
exit $fail
