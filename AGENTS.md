# AGENTS.md — working agreements

Rules for anyone extending **pixel-agents**, human or AI. Read this before
changing code. [README.md](README.md) says what the project is and how to build a
world with it; [docs/design.md](docs/design.md) explains why the system is shaped
this way. This file is the short, binding version: **what you must and must not
do.**

The golden rule: **build on the existing stack — Colyseus + Phaser — don't
introduce a parallel engine.**

> 🤖 Essentially all of this code was written by AI agents working mostly
> autonomously. The invariants below are therefore not style preferences: they are
> the contract that keeps independent extensions composable. A change that breaks
> one is a regression even if it works. When in doubt, run the `mmo-readiness`
> skill — it checks the contract for you.

Direction: this is the seed of a small **MMO-style** world — many participants,
players and NPCs beside the agents, interaction between them. Design so that
survives: authoritative server state plus client interpolation, never client-side
truth. When you add something, ask "does this still hold with N players moving and
interacting?"

### Pawns and controllers — the words, and how to add one

The vocabulary is load-bearing, so it is fixed here, and it is Unreal's because the split is the
same one: **a PAWN is a body, a CONTROLLER decides where it goes.**

**Pawn** = the body. `PawnSync` (id, transform, facing, coarse state) is the base; `CharacterSync`
and `PetSync` extend it the way `ACharacter` and a vehicle both extend `APawn`. `FurnitureSync`
deliberately does not — furniture is not possessable. Everything about HOW a pawn looks and what it
can physically do belongs on this side: frame size, which sheet, which poses exist, where its frames
advance. In Unreal the mesh and the Animation Blueprint hang off the Pawn for exactly this reason,
and a spider, a tank and a soldier share a controller interface while sharing no animation at all.

**Controller** = what drives it, as a `ControllerKind` on the pawn:

| | Decision comes from | Body |
|---|---|---|
| `HUMAN` | a viewer's input, live | `CharacterSync` (16×32; walk 0-2, typing 3-4, reading 5-6) |
| `AGENT` | an external process, mirrored through the ingest feed | the same |
| `PET` | the world itself (`engine/pets.ts` + the mistreevous brain) | `PetSync` (16×16; walk 0-2, sit 3-4, idle 5, talk 6-7) |
| `NONE` = 0 | nobody — the deny-by-default zero | — |

Four things follow, and each one is the reason this is an enum on the pawn and not a boolean:

- **`AGENT` reports, it does not decide.** `applyEvent` turns an `AgentEvent` into world mutations;
  there is no behaviour tree behind it and there should not be. Unreal has no word for this — its
  net roles describe who has authority, and an agent's authority is outside the game entirely.
  `isSubagent` and `isTeamLead` are ROLES within this controller, not controllers of their own.
- **`PET` is the one that matches `AAIController`** — `server/src/pet/petBrain.ts` is literally a
  behaviour tree plus blackboard, with the shared engine as the actuator. That half was built
  before it had the name.
- **A command is a property of the controller.** The ten `…Player` methods go through
  `humanPawn(id)`, which returns the pawn only if a HUMAN drives it. It used to be ten copies of
  `if (!ch.isPlayer) return`, which is where the eleventh forgets and a `playerMove` moves an agent.
- **Nothing runs on an unclaimed pawn.** `NONE` is the schema's zero so a pawn nobody claimed is
  inert rather than privileged; the update loop holds it still and says so once, instead of
  defaulting it into the agent FSM. `pawnController.int.test.ts` pins all of this.

**"NPC" is the umbrella and both existing controllers are already under it** — an agent and a pet
are both characters no player controls, which is what the word has meant since tabletop. What does
NOT exist yet is the fourth cell of that table: a humanoid whose behaviour the world invents (what
games plainly call an NPC, with `vendor`/`crowd`/`mob` as the role names below it). It is a new
`ControllerKind` value and a driver, and nothing else — the pose path resolves from a **spec**, not
from what drives the pawn, and `createCharacter(id, skin, null, null)` already builds a pawn with no
agent behind it. Until 2026-08-27 the code called every pet an NPC (250 identifiers, a database
column, three names on the wire), which is why that word is now used only in this sense.

**Adding a CONTROLLER** (a new way for something to be driven) — this is the cheap direction, and
it is cheap on purpose:

1. A value in `ControllerKind` (`shared/office/types.ts`). **Never 0** — that stays `NONE`, so a
   pawn nobody claimed is inert rather than privileged.
2. Something that drives it. Two shapes, and which one you are in decides everything else: a
   controller that drives a **character** pawn gets a case in the dispatch in `officeState.update`;
   one that brings its **own pawn kind** does not, and is stated where that pawn is synced (`PET`
   is this shape — a pet is pet-driven by being in `os.pets`, so the engine never asks).
   `pawnController.int.test.ts` fails until one of the two exists.
3. Something that SETS it, on every path that spawns such a pawn (`addAgent`/`addPlayer` are the
   two today). A pawn must never reach the world still reading `NONE`.
4. If it accepts commands, an accessor like `humanPawn(id)` that returns the pawn only for that
   controller — **never** a per-method `if`. Ten copies of one rule is where the eleventh forgets.
5. If it DECIDES rather than reports, its brain is server-only. `server/src/pet/petBrain.ts` is the
   pattern (behaviour tree + blackboard, engine as the actuator), and `mmo-readiness` fails a
   behaviour tree that reaches `client/dist`.
6. **No `PROTOCOL_VERSION` bump.** It is a new value in a `uint8` that already ships. That is the
   whole reason the driver is an enum on the pawn instead of a boolean per kind.

**Adding a PAWN KIND** (a new body) is the expensive direction, and it is a wire change:

1. A schema class extending `PawnSync` in `officeSync.ts` — `mmo-readiness` checks that inheritance,
   because a body that redeclares the transform is a body the rest of the code cannot treat
   uniformly.
2. Its own art, poses and cadences (`poseCadence.ts`, `poseFrames.ts`). The body owns how it looks
   and what it can physically do; the controller never learns about it.
3. A collection on `RoomState` and a sync loop that sets `controller` on every pawn it writes.
4. **`PROTOCOL_VERSION` bumps.** A new synced collection changes what a client decodes.

**What must never happen**, each one a mistake this codebase has already made:

- **A boolean that means "which driver".** `isPlayer` could express two and no more, which is why
  the third driver had to be its own collection and the fourth had nowhere to go. If you find
  yourself adding `isSomething: boolean` to a pawn to say who moves it, it is a `ControllerKind`.
- **A controller test inside a command.** Use the accessor; the guard belongs in one place.
- **Reading the driver from a client payload.** The controller is server state, resolved from the
  session like everything else in § Security. A client may not say what drives a pawn.
- **`NONE` as a real driver, or as a spawn's default.** It exists so that "nobody claimed this"
  cannot be mistaken for "the usual one".
- **Roles turned into controllers.** `isSubagent` and `isTeamLead` are roles WITHIN the agent
  controller. A role is what a pawn is doing; a controller is who decides. Inflating one into the
  other is how you get eight kinds and no dispatch.

**An appliance decides what happens there, and who may.** `APPLIANCES` (`office/types.ts`) is the
one table: per `ApplianceKind` it gives the POSE adopted there and whether a character and a pet may
use it.

| kind | pose | character | pet |
|---|---|---|---|
| `coffee` | `coffee` | yes | no |
| `drink` | `drink` | yes | yes |
| `pet_feed` | `feed` | no | yes |

A tile declares its kind through `actionPose` (default `coffee` — and `buildPoints` defaults it
again, because an action may arrive as `{ kind: 'appliance' }` with no pose at all and storing
`undefined` would leave that appliance usable by nobody). **Where a map has none of its kind, a
pawn simply never goes** — the absence is the answer, not a special case. `pet_feed` is named for
whom it feeds rather than for the action, deliberately: drinking is not a pet thing, anyone may use
a fountain, and a bowl is the only one of the three that is species-specific.

Occupancy stays **per stand tile**: `buildPoints` derives one point per adjacent walkable tile, so
several pawns use one appliance at once, each holding its own tile. There is no per-appliance
exclusivity and none is wanted — two dogs at one bowl is fine.

That replaced a lookup filtering by nothing at all: both sides walked every entry in `points`,
which holds seats as well as appliance tiles, so an agent on a coffee break could stand on a free
desk chair and a "drinking" pet could claim the coffee machine and block an agent out of it.
`appliances.int.test.ts` pins the matrix and the negative that matters — a placed coffee machine
never makes a pet thirsty.

**A pose borrows art from another pose rather than requiring its own** (`POSE_FALLBACK` +
`poseChain`, `sprites/poseFrames.ts`). `feed → drink → coffee → idle → the stand column`: a pose can
be added to the engine without touching a single sheet, and a sheet that later gains coffee frames
lends them to drink and feed for free. Three rules keep it honest:

- **All three resolvers walk the same chain** — the column (`poseFrame`), the playback length
  (`posePlaybackLength`) and the reference pixel path (`spriteForPose`). They were three hand-mirrored
  `if` chains and the third had already drifted (it never learned about `sit`). A resolver walking a
  different chain than the length came from puts the frame counter and the drawn column out of step,
  which shows up as an animation playing the wrong pictures with nothing to point at.
- **Only the ART is borrowed.** The cadence stays the pose's own (`poseCadence.ts`), because the
  action decides the tempo — a drink at the coffee cadence would be indistinguishable from a coffee
  break, which is the opposite of what the borrow is for.
- **`sit` is not in the table.** It is a transform (the stand column drawn lower, `synthSit`), not
  another track, and it resolves BEFORE the chain — otherwise a sheet with an idle track would hand
  a seated character its standing frames.

The chain is linked rather than spelled out per pose, so changing what `drink` borrows does not
require remembering that `feed` borrows through it; `poseChain` carries a visited set and
`poseFrames.int.test.ts` walks the table to prove it is acyclic. Until frames exist, a **marker**
carries the state: ☕ at a coffee machine, 💧 at a fountain, both on the same sip loop.

Two art gaps live on the pawn side and are documented placeholders, not bugs: a character's
`coffee` is declared in `DEFAULT_CHARACTER_SPEC` with no frames drawn (the ☕ head marker is what
you actually see — `markerSpecs`), and a pet's `drink` has none either. Both fall back to the stand
frame, on the fly, per frame.

**Who hunts whom is a SPECIES fact in one table; fleeing is that table read backwards.** `CHASES`
(`office/types.ts`) gives, per `PetKind`, the kinds it hunts — today a RING, `dog: ['cat']`,
`cat: ['bird']`, `bird: ['dog']` — and `fleesFrom(kind)` derives the other half: every kind that
hunts this one *and* that this one does not hunt back. Four rules, and each is a mistake the
previous shape allowed:

- **Nothing outside that table names a species.** It used to be four words in two engine methods
  (`pet.kind === DOG` beside `nearestLivingPetOfKind(pet, CAT)`, and the mirror for fleeing) plus
  the same two species a third and fourth time in the editor's labels. The third kind therefore had
  no relation at all — not as a decision, but because it appeared in none of those lines. A new
  pairing is now one word, a new species is one row, and the editor writes its own labels from it
  (`Chase cats` for a dog) instead of restating the relation where nobody would think to look.
- **The ring is the shape, and it is a fairness decision.** The table was a CHAIN
  (dog → cat → bird, nothing hunting the dog), so the two ends were lopsided by species: the dog
  was only ever a hunter, the bird only ever prey, and since `PET_HUNTER_WIN_CHANCE` favours the
  hunter, each end's win rate was fixed for the life of the world. Closing it — `bird: ['dog']`,
  one word, which is the strongest evidence there is that the relation really does live in data —
  makes every kind hunt one and be hunted by one. Measured over 40 runs of 20 simulated minutes
  with two of each kind: the bird went from **15 % of all fight roles at a 38 % win rate to 34 % at
  51 %**, and the cat from being in **every single fight** (50 % of roles, since it was the only
  link both hunted and hunting) to a third of them. Two consequences to expect rather than debug: a
  ring is three ONE-SIDED pairings, so `fleesFrom` still gives everyone exactly one thing to run
  from and a pair always has precisely one hunter; and where all three meet, running beats hunting
  (the brain's order, and `reactionOpportunity`'s), so the trio scatters and the fights happen when
  a PAIR meets, which is most of the time.
- **Flight is never stored.** "A cat flees a dog" is "a dog chases a cat" from the other end, and
  a world where only one of the two is written down can be configured into a state that does not
  exist. The subtraction is what makes a MUTUAL pairing come out right: if cats ever chase dogs
  back, both sides chase and neither flees, so the two meet instead of one shoving the other into
  a corner forever — which is where a scuffle (a comic cloud between them) would go.
- **A `PetBehaviors` switch is a permission, not the relation.** `chase` and `flee` say whether
  THIS animal may act on its species' relation, so they name no quarry and a flag with nothing to
  apply to is simply inert (empty a row and that kind's `chase` stays on and hunts nobody). Emma
  may be a peaceful dog; no dog hunts birds.

The switches say what they mean, which cost a `PROTOCOL_VERSION` bump to 12: `chaseCats`/`fleeDogs`
are `chase`/`flee`, and `drink` is **`feedDrink`** — a pet has never been able to use a coffee
machine, so a switch named for coffee described nothing that exists. `resolvePetConfig` reads either
spelling, so a stored animal keeps its settings; the bump is for the WRITE direction, because an
older build's editor would read the new names as absent, show every switch off and write the old
ones back on the next save. `petChase.int.test.ts` pins the table, the derivation (including the
mutual case and the ring, against hypothetical tables, so the properties hold before anyone edits
`CHASES`) and that the engine reads nothing else; `petScuffle.int.test.ts` walks all three pairings
through the catch, including the one that closed the ring.

**A chase ENDS in a cloud, and geometry is what catches.** A hunter that corners its quarry puts
both animals in `PetState.SCUFFLE` for `PET_SCUFFLE_DURATION_SEC`; the client draws one comic puff
between them and hides both. Before this a chase had no ending at all — `navigateReaction` pathed
once to the tile the quarry stood on, the hunter walked there, found nobody and idled for up to
eight seconds, so it lost by construction. Five rules, and each is a decision rather than a detail:

- **One speed for every pet, and it stays that way.** A hunter re-aims every
  `PET_REACTION_REPATH_SEC` (`pet.reaction` outlives the single path it used to walk) — and the
  quarry re-picks its escape on the SAME cadence, deliberately, because reacting twice as often is
  a speed advantage wearing a different hat. So a catch means walls, furniture or a dead end. A dog
  that outruns a cat would be zoologically false and would take the tension out of the chase.
- **A walking pet looks up; a sitting one is left alone.** Noticing used to happen only at a pet's
  own decision points, and those are 1.5-8 s apart (a sit is 8-25 s) — so a dog crossing paths with
  a cat walked straight past it, and at 2.5 tiles per second the cat was out of the five-tile radius
  before the next look. The `WANDER` state therefore asks `noticeReaction` on the re-aim cadence and
  takes up a chase or an escape at once. BOTH roles get it, for the same reason both re-aim on one
  cadence. A sitting animal deliberately does not: a dog that shoots out of a nap because a cat
  passed three tiles away is a different world, and that exception was asked for by name.
  `chaseQuarryFor` / `hunterNear` are the two questions, in one place each, because the affordance
  handed to the brain and the walking interrupt both ask them — two copies is two places to forget
  the cooldown.
- **Pursuit earns it.** The catch needs `pet.reaction === 'chase'`; a dog wandering past a sitting
  cat starts nothing, or the world would be wall-to-wall clouds.
- **A cloud is a PAIR, and the server says who is in it.** Both animals point at each other through
  `PetSync.scufflePartnerId` (synced — `PROTOCOL_VERSION` 13). The client could have guessed the
  pairing from adjacency; that guess draws two clouds on one spot the moment three animals line up,
  and the pairing is a decision, not presentation. `beginScuffle` sets both sides in one call so a
  half-formed pair cannot exist, `resolveScuffles` ends a cloud whose partner despawned (one animal
  left in one is invisible, since the renderer needs both ends to place a picture), and a third
  animal cannot join.
- **The cooldown is checked twice, and that is not belt and braces.** `PET_SCUFFLE_COOLDOWN_SEC`
  gates the affordance (so the brain is not even offered a chase) AND the catch itself — the
  affordance only advises, so anything else that makes a pet chase would otherwise re-catch the same
  quarry on the tick after a cloud cleared, which is the endless loop of clouds the cooldown exists
  to prevent. Only chasing is gated: the quarry may run at once, and that asymmetry is how it gets
  away.
- **The cloud is art, not a pawn.** `office/effects.ts` names the sheet (`SCUFFLE_SHEET`), the
  server serves it as a third kind on the art route (`/art/effect/<id>`, ids resolved against
  `EFFECT_SHEETS` and never used as a path) and the client fetches it in the loading phase — no
  message, since the id is a constant of the build. It is drawn from the same runtime atlas as
  every other sheet, its frame phase is client-side (presentation timing, invariant 2) and its
  cadence still lives in `PET_POSE_FRAME_MS` because there is one table for that. `petPose` returns
  `idle` for a scuffling pet, so a client whose cloud art failed to load shows two animals standing
  rather than nothing at all.

**The cloud has a winner, and it is not always the same animal.** `PET_HUNTER_WIN_CHANCE` is 0.6 —
not even odds, because a bird that sends the cat packing is funny exactly to the degree that it is
rare, and not certainty either, because then the cloud would have no suspense and the outcome would
not be worth showing. The roll happens ONCE for the pair, in `beginScuffle`, and is stored on both
sides as `scuffleWon`: each animal ticks its own timer, so rolling at the end would let both of them
believe they won. Nothing about the outcome is synced until the cloud clears, so it stays open while
it lasts.

Then a beat of `PET_AFTERMATH_DURATION_SEC` in two new states, `WIN` and `LOSE` (two more values in
a synced string, so still no schema change): the winner bobs on the **talk** frames, which read as
barking, the loser sits, which reads as cowering — no new art for either. The client puts 🏆 and 💫
over their heads for that beat (`drawPetBadge`), and then **the loser walks away**. Three details
that are decisions rather than mechanics:

- **The badge is the instant read; the retreat is the story.** An emoji alone is a scoreboard that
  vanishes; an animal leaving is something a viewer notices from across the room, and it still says
  who lost a second later.
- **The retreat runs from the ANIMAL that won, not from what the species flees** (`fleeFrom` /
  `pathAwayFrom`, one implementation shared with the `flee` reaction). `fleesFrom('cat')` is
  `['dog']`, so a cat that lost to a bird would otherwise find nobody to run from and simply stand
  there beside its victor. Losing is about who beat you.
- **It is a one-shot path, not a `reaction`.** A reaction re-aims every half second at what the
  species flees, which for that same cat is nothing at all. Where the species relation DOES apply,
  the walking interrupt picks the retreat up one tick later and turns it into a real flight — which
  is why `petScuffle.int.test.ts` asserts the DISTANCE grows rather than which mechanism moved it.

The pet kind `duck` is `bird` since 2026-09-07: it was a species, and as a CATEGORY it takes an owl
or a magpie without a fourth enum value. The two animals are still ducks (Rudi is a mallard drake,
`assets/pets/README.md`) — what moved are their slot ids, `bird_0`/`bird_1`, because an id is
`${kind}_${index}` by construction. That is a wire rename (`petSpritesLoaded`'s `ducks` field) and
therefore `PROTOCOL_VERSION` 14, plus a boot migration for the ids in stored art rows and in a
zone's pet selection (`schema/renameDuckToBird.ts` — user data cannot be renamed by editing code).
It resolves the zone COLUMN from the schema, because it runs before `ZoneStore` renames `npc` to
`pets` and a boot task may never keep the server from starting.

**A fight is exclusive, and having fought makes an animal unavailable for 90 seconds.** Two holes
made scuffles look endless, and the report that found them was "fights that go on forever, somebody
keeps joining":

- **The BEAT was not protected.** The catch check skipped a quarry in `SCUFFLE`, but during the
  1.2-second aftermath the state is `WIN`/`LOSE` — so a second hunter could take the loser while its
  badge was still up. Visible in the numbers as clouds every 1-2 seconds against a cloud-plus-beat
  of 2.7. `catchable()` is now the one question (in a cloud, in the beat, or cooling down) and both
  the affordance and the catch ask it.
- **The cooldown gated the wrong role.** It stopped a pet from CHASING, and a cat hunts no dogs — so
  the quarry had no protection at all, and with two hunters one was always free. Measured: **101
  clouds in three minutes**, partners alternating. It is an immunity for both roles now, at
  `PET_SCUFFLE_COOLDOWN_SEC` = 90 s, and the same measurement gives **2**.

A protected quarry is invisible to the hunter's INTENT and not merely to the catch, because a dog
running after a cat it cannot possibly catch is a chase with no ending. Fleeing is deliberately not
gated: being unavailable for a brawl is not the same as feeling safe.

**That applies to a chase already running, too, and until 2026-09-09 it did not.** There are two
ways to reach a quarry — `chaseQuarryFor`, which filters through `catchable` and feeds the
affordance and the walking interrupt, and `navigatePetReaction`, which is what the re-aim calls
every `PET_REACTION_REPATH_SEC` — and the second asked `nearestLivingPetOfKinds` directly. So the
rule above held for STARTING a chase and not for continuing one: a hunter kept being handed a route
to an animal that had just fought, twice a second, for as long as it stayed in range. Both halves
ask the intent's own questions now (`chaseQuarryFor` / `hunterNear`), which is one scan fewer each,
and a chase ENDS the moment its quarry becomes protected rather than trailing it out of the radius.
Measured over 20 simulated minutes with two of each kind, that costs no fights: 28-41 chases and
17-20 clouds, against 32-43 and 14-18 before, i.e. inside the run-to-run spread.

**A fleeing animal remembers its heading and refuses to reverse.** Every re-aim used to recompute
the best escape from scratch twice a second, and in a confined space the best answer alternates as
the hunter moves — measured in an 8×8 room: **21 reversals out of 21 samples, every run**, which is
the "both of them running up and down" that was reported. `pet.fleeHeading` is tried first while it
still increases the distance, and its exact opposite is refused (in the dash AND as the flood
fill's first step), which makes the ping-pong impossible rather than unlikely: the same measurement
gives a median of 3. It has a second effect worth keeping — a genuinely cornered animal runs out of
directions, stops fleeing and gets caught, so the chase RESOLVES instead of looping.

**The scuffle board is an Action, and a whiteboard is only a board where a mapper says so.**
`{ kind: 'petScores' }` on a PLACEMENT (`effectiveAction` prefers the instance over the tile), so
one whiteboard in a zone becomes the leaderboard and every other whiteboard stays a whiteboard —
there is deliberately no default on the tile. Walking up fires it like any other kiosk
(`isClickAction` excludes only `appliance` and `talkingObject`, so a new kind needs nothing there),
and the answer goes to that ONE client, because a board is read by whoever stands in front of it.
Three decisions inside it:

- **The tally is per pet SLOT** (`dog_0`), not per instance: an instance lives ten minutes, a slot
  has a name. Slots are resolved to names for DISPLAY only (`petDisplayName`, which reads the merged
  bundle so a renamed pet keeps its name) — a name is presentation, an id is identity.
- **Per zone**, because a board hangs in a room and a zone chooses which animals live in it. Kept in
  its own table (`pet_scores`, one row per zone × pet) rather than a blob in `settings`, which is
  the shape that cost 5.3 ms per write at ten thousand entries. No foreign key to `zones`, following
  `zone_admins`/`zone_acl`: `ZoneStore.delete` clears it, and the cascade rule is about ACCOUNT data.
- **The result is reported once**, on the winner's `SCUFFLE → WIN` transition, and drained by the
  room (`takeScuffleResults`) — the engine writes to no database, and reading it per pet would count
  every fight twice.

**A flight answers itself; only a cornered animal asks the pathfinder.** `pathAwayFrom` (shared by
the `flee` reaction and the loser's retreat) used to filter all 2634 walkable tiles of a real map,
sort them by distance from the hunter and ask A* whether the best eight were reachable — 172 µs per
call, 428 µs when cornered, and a theoretical worst case of eight unbounded searches. It now has two
answers: a **dash** straight away while `canStep` allows it (1.4 µs), and, when that first step is
blocked, one **flood fill bounded by the flee range in STEPS**, which gives reachability and the
route together (21.7 µs). Measured over uponu: 172 → 4.5 µs on the mixed case, and the unbounded
worst case is gone by construction.

Three things about it are load-bearing rather than incidental:

- **`canStep` is the arbiter, not `isWalkable`.** A wall is an EDGE between tiles, not a blocked
  tile, so a dash checked only for walkability would walk through one. `canStep` is the predicate
  `bfsPath` itself uses, which is what makes hand-rolled movement as legal as the pathfinder's —
  and `DIRS_4` is exported from `tileMap.ts` for the same reason, so a second direction table
  cannot quietly grow a diagonal.
- **Only a step along an axis that DETERMINES the Chebyshev distance increases it.** A pet directly
  east of its hunter gets no farther by walking north, so the dash considers the axes whose delta
  equals the current distance — one normally, both when the two stand diagonally or share a tile.
- **A short hop beats an optimal route.** Where the straight line is blocked after two steps, the
  dash takes those two steps instead of routing seven tiles around; the reaction re-aims half a
  second later from wherever it got to, which is what that cadence is for.
  `petFleePath.int.test.ts` sweeps every position on a map with a wall and pillars and pins the
  contract the pathfinder used to give for free — 4-connected, `canStep`-legal, strictly farther,
  within range — and it asserts that BOTH branches answered, decided the way the code decides it
  rather than guessed from the shape of a path.

**A chase is bounded too, and until 2026-09-09 only the flight was.** `findPath` took no step
limit, so what bounded a search was the reachable walkable component — the whole map. The chase
half asked that unbounded question every `PET_REACTION_REPATH_SEC` per hunter, and a quarry five
tiles away BEHIND A WALL is the case it cost the most: **1202 µs on uponu, now 68 µs**, because a
search that cannot reach its target exhausts everything it can reach before saying no. The open
floor case, where the bound never bites, is 7.2 → 7.1 µs. Four things make it a decision rather
than a cap:

- **`PET_CHASE_RANGE_TILES` is 15 = 3 × the shoo radius, and 10 would be a regression.** The
  quarry is within Chebyshev 5, and on a 4-connected grid a diagonal Chebyshev 5 is **ten steps** —
  so ten is the open-floor worst case, not slack, and "twice the radius" would silently refuse
  every diagonal chase that has to round a desk. It is written as a multiple so a changed radius
  carries the bound with it, and `petChase.int.test.ts` fails if it ever drops to twice.
- **It is a behaviour improvement, not only a saving.** 15 steps is about six seconds of walking,
  i.e. twelve re-aims, and the quarry is elsewhere long before — AGENTS.md already says a dog that
  cannot possibly catch a cat should not be chasing it, and this applies that to geometry instead
  of to the scuffle cooldown. What is refused is a WALL between them; a doorway or a sofa is still
  walked round. And it costs the world nothing measurable: 20 simulated minutes on uponu with two
  of each kind gave **32-43 chases and 14-18 clouds over four bounded runs, against 41 and 17
  unbounded** — inside the run-to-run spread, so what the bound removes is the hopeless walks and
  not the fights.
- **Both branches of `findPath` honour it, and the Dijkstra one counts STEPS, not cost.**
  `AVOID_TILE_COST` is 8, so an 11-step route across one avoided tile costs 18 — a cap read off
  the cost would refuse a path well inside the step bound while claiming to be a step bound. A
  parameter only one branch respects is a parameter that lies. What the bounded Dijkstra gives up
  is completeness (a node settled by a cheap long route can hide an expensive short one), which is
  written down where it lives rather than papered over; today's only bounded caller passes no
  `avoidTiles`.
- **The affordance stays pathfinding-free.** `canChase` says a quarry EXISTS, not that it can be
  reached; a search in there would become one per tick.

**A pet's target search picks first and paths once.** `findFreePetTarget` ran a full BFS per
CANDIDATE and only then picked at random — one per free seat, per perchable table, per bowl, per
unclaimed agent. That is O(candidates × area), the only term quadratic in map area, and it is the
one place where the cost was already absurd rather than theoretical: measured on uponu, a `'sit'`
decision offers **101 candidates and cost 38.3 ms of pathing, now 0.29 ms**; `'talk'` with 300
agents cost **149.8 ms, now 0.38 ms**. Against a 20 Hz tick budget of 50 ms and a whole tick that
measures 0.066 ms, one animal looking for a chair spent most of a tick doing it, and in a crowd it
spent three ticks' worth in a single call. Four rules hold the new shape:

- **`pickReachable` probes at most `PET_TARGET_PATH_TRIES` = 3, uniformly.** A partial
  Fisher-Yates, so nothing is probed twice and nothing is preferred. Sorting by distance and taking
  the nearest is cheaper still and piles every animal onto the same chair, then serializes them
  through one claim — `petTargetSearch.int.test.ts` pins the distribution for that reason.
- **`null` is "cannot get there", `[]` is "already standing on it".** `findPath` answers `[]` to
  both, and the old code disambiguated at four separate sites. Collapse the two and a pet
  intermittently refuses the desk it is lying on.
- **One claim, after the pick, and none on failure.** The claim used to be made once the candidate
  list was complete; making it after the pick is a new chance to leave a seat marked as taken by an
  animal that never went, so that is a test of its own.
- **Three tries is a fact about maps, not a hunch.** A map's walkable floor is one component in
  practice — uponu measures 2651 walkable tiles in two components, of 2648 and 3 — so the first
  probe answers. What it trades away is stated: the pick is uniform over candidates with retry
  rather than over REACHABLE candidates, so a genuinely islanded map can give up, which the FSM
  has always handled with a random wander and a 1.5-8 s re-decide. If islands ever make it
  visible, the fix is one component flood fill per decision — one search whatever the candidate
  count, the same insight `pathAwayFrom` is built on — and not a search per candidate again.

The sheet is drawn by `scripts/draw-scuffle-cloud.sh` (deterministic — a seeded LCG, so `--check`
means something) and committed. It is ordinary art: redraw the PNG by hand and nothing downstream
knows or cares. What the script learned the hard way, in case the next effect needs it: seven
overlapping circles give a potato and a potato reads as smoke, so the silhouette is a polar star
with rounded valleys; and a mark in a single dark colour is invisible on a dark floor, so the paw
and tail that poke out get the cloud's own light-fill-plus-dark-edge, and they start INSIDE the
silhouette or they read as debris flying past.

## Architecture invariants

1. **The server simulates.** Movement, seating, stations, the FSM, poses — all of
   it runs in `shared/src/office` on the server's tick loop (`SimRoom` →
   `OfficeState.update`). Every viewer sees one identical world.
2. **The client renders and forwards input; it may present.** It draws synced
   `@pixel/shared/schema` state and interpolates. It must not run the FSM, pick
   behaviour or resolve positions. If the client needs a *decision*, sync it —
   don't recompute it from partial data. The one exception is **presentation
   timing** (animation frame phase within a synced pose, the Matrix sweep):
   cosmetic, wasteful to sync, never gameplay. Sync state and intent, not frames.
   If a frame ever drives gameplay, its timing moves back to the server.
3. **Deterministic and grid-based.** Tile-based A* (`layout/tileMap.ts`). No
   physics engine — it would cost determinism and headless execution.
4. **One occupancy model.** Every place a character can be is an
   `InteractionPoint` (`posture`, one `occupantId`) in `OfficeState.points` —
   chairs and appliance stand tiles alike. Claims go through `claimPoint` and are
   **symmetric**: agents and players exclude each other, whoever got there first.
   A character holds at most `homePointId` (its reservation) and `atPointId`
   (where it is). Approach tiles are derived (`computeApproachTiles`), never a
   hardcoded list per type.
5. **Animation is pose-driven.** `CharacterPose` is computed server-side and
   synced; the renderer resolves frames through `spriteForPose()` alone. A new
   animation = a new pose + one branch there + the frames. Never branch on
   `state` or tool names in the renderer.
6. **One port for everything.** Browser, Colyseus and the agent feed share one
   HTTP server. Mount on it (`attachFeedServer`); don't add listeners.
7. **Never trust the client.** Every `onMessage` handler and every `/feed` payload
   is untrusted input. Client-side checks are UX only; the authoritative gate is
   server-side. Validate identity, length, format and bounds before persisting or
   mutating, and reject silently. A new message ships with its server-side
   validator in the same change.
8. **Reuse the pawn, zone and portal model.** Synced pawns extend `PawnSync`, and
   what drives one is a `ControllerKind` ON the pawn — a player's avatar is a
   character pawn with `controller = HUMAN`, never a boolean of its own (see
   "Pawns and controllers" above for the vocabulary and the procedure for adding
   either half). A zone is an instance of the one room type
   (`filterBy(['zone'])`) — never a room class per zone. Travel is placed
   furniture with a `portal` action — never a hard-coded coordinate jump.
9. **Support Chrome *and* Firefox.** Every feature works in both current
   Chrome/Chromium (the Electron shell counts as Chrome) and Firefox. This bites
   hardest in media: use `HTMLMediaElement.setSinkId` (both), not
   `AudioContext.setSinkId` (Chrome only). If an API exists in only one, gate it
   and keep the other browser working.
10. **Every client change must also work in Electron.** The same bundle runs
    served-by-the-server and from a local `app://` origin talking to a *remote*
    server. So: no relative URLs to the server (`fetch('/api/…')` hits `app://`) —
    go through `net/room.ts`'s helpers; don't derive the server from
    `window.location`; auth is a cookie in the browser and a bearer token on the
    desktop; `window.location.reload()` is silently dropped — use `reloadApp()`;
    desktop-only capabilities go through the typed preload bridge with a browser
    fallback. **A wire-format change bumps `PROTOCOL_VERSION`** (`shared/protocol.ts`)
    in the same commit — adding, removing or reordering a synced schema field, or
    changing what a message means. The desktop app ships its own bundle and only
    updates when the user triggers it (`desktop/src/updater.ts`; never at all on
    macOS, which refuses unsigned updates), so without the bump an older build
    decodes the new state into nonsense silently; with it, the client offers the
    update instead (`client/src/ui/versionGate.ts`). Gate on that number, never on the build version:
    `git describe` changes with every commit and would cry wolf in development.
    **The app's name and its `userData` directory are set explicitly and
    separately** (`desktop/src/appPaths.ts`, `userDataDir.ts`), before
    `requestSingleInstanceLock()` — which keys the lock off `userData`. Both
    defaults were wrong: `app.getName()` fell through to the package name
    `@pixel/desktop`, so the slash became a path separator and per-user state
    landed in a nested `~/.config/@pixel/desktop/`, while the tray item's D-Bus
    `Id` went out as `@pixel/desktop_status_icon_1`. The directory name is a
    constant and deliberately NOT derived from the display name: `userData` holds
    the bearer token and the trusted-cert store, so a path that follows the app's
    name logs every user out the day somebody renames the app. Rename freely;
    leave `DATA_DIR` alone. The one-time move of the old directory is tested
    (`userDataDir.test.ts`) because its one unacceptable outcome is pointing at an
    empty directory while the real state sits next door.
    **A tray icon is never a way back that can be relied on.** `new Tray()`
    succeeds on Linux with nothing to draw it, so it reports an availability it
    cannot know; `probeTrayHost()` asks the session bus and is the most that can
    be established, and even a host that accepts the item may discard it (vanilla
    GNOME draws no tray at all, and with the appindicator extension Chromium
    answering `Get` on `IconName` with an error makes the extension drop the
    item). So close-to-tray stays opt-in from the tray menu, off by default, and
    forced off whenever the bus says outright that nothing is listening — and a
    second launch stays a way back to a hidden window.

## Security

Security is a first-class requirement, not a later pass.

- **Assume the client is fully compromised.** Every access-control decision —
  identity, `isAdmin`, `allowPixels`, zone assignment, spectator status,
  capabilities — is resolved **server-side from the account/session**, never from
  a value the client sent. A client flag may at most affect a self-only,
  privilege-free presentation choice. If client input can influence an
  authorization outcome, it is a bug.
- **Personal data is keyed by the authenticated `userId`** (from `onAuth`), never
  by an id or name in the payload. A user reads and mutates only their own avatar,
  preferences, viewer settings, password and agent token.
- **Shared and admin actions go through `permissions.ts`** — `may(client,
  capability, zoneId?)`. Gallery/asset edits, zone create/delete, user management
  and granting zone-admins need global admin; a zone's map, arrival point and pets
  need that zone's admin. Slash commands are gated by their registry group
  (`mayRunCommand`). **Default to deny.**
- **The GET gate is an allow-list, and world data is not on it.** `isPublicGet`
  (`auth.ts`) names what an anonymous caller may fetch: the login page and `/login`,
  the register page and `/register` (an account is what a caller comes there to get, and
  the POST still demands the admin token), `/health`, `/matchmake` (the room authorizes
  itself in `onAuth`), and the client BUILD's own directories — which carry no world data and, by contract, no secret. It
  used to be the other way round: anything under `/assets/` or ending in an asset
  EXTENSION was public "because the desktop app fetches them cross-origin, cookie-less".
  Measured 2026-08-20, that published the whole world's art — every tileset sheet,
  `sets.json`, and every picture a pushed map wrote to disk, which is not necessarily in
  git either. The desktop half had expired too: it sends a bearer through `serverFetch`,
  which the gate accepts, and only three client fetches were still using a bare `fetch`
  (they now go through it — a cross-origin request from `app://` carries no cookie, so
  that helper is the only thing identifying the caller). `/assets/tiled/**` and
  `/arcade/content/**` are refused ABOVE the build prefixes, because they share a mount
  point with them. The guest meeting page stays reachable: `/meet/:slug` and its `/info`
  are registered before the gate, on purpose.
  The build stays public deliberately, and two facts settle it rather than taste. The
  **public guest page shares its chunks with the app** — `/meet/<slug>` pulls `bridge`,
  `ConferenceUI`, `livekit-client` and `preload-helper` out of `/assets/`, and they are
  content-hashed and partly loaded by dynamic import, so gating that prefix either breaks
  guest links or needs the guest page split into its own bundle (duplicating ~550 KB of
  LiveKit). And the same bundle is downloadable from a **public GitHub release** as the
  desktop AppImage, so a gate on the server would protect nothing that is not already
  published. What it must therefore keep being true is the contract the gate leans on: no
  secret in `client/src`, which `mmo-readiness` fails on.
- **No credentialed cross-origin surface.** `desktopCors` echoes the request Origin for
  the three paths the desktop needs and deliberately sends no
  `Access-Control-Allow-Credentials` — but Colyseus ships that header in its matchmaker
  defaults and applies them to every response, so the contract was false in practice
  until `index.ts` deleted it. Origin-echo plus credentials is exactly what lets any
  website read a cookie-authenticated response; it was harmless only because those three
  paths answer nothing sensitive, and it was a trap primed for the day a data route
  joined them. Both this and the allow-list are checked by `mmo-readiness`, with a
  planted hole per rule.
- **Secrets stay on the server**: LiveKit key/secret, the admin token and scrypt
  hashes never reach a client. A viewer gets only its own agent token and
  short-lived, room-scoped LiveKit JWTs whose identity is its own avatar. Bound
  the length of anything you verify, so verification can't become a CPU DoS.
- **Serve over TLS in production.** The session cookie and the desktop bearer
  token are capabilities; media needs a secure context anyway. Plain HTTP is for
  development only.
- **A value from outside may not reach a typed synced field without being coerced, and the tick
  survives it either way.** `@colyseus/schema` throws on a TYPE mismatch **at assignment** — a
  string into a `uint32`, a number into a `string` — while an out-of-range number, a `NaN` or a
  non-boolean boolean pass quietly. So type is what must be guaranteed and range is what must be
  clamped. That assignment happens in `SimRoom.syncCharacters`, inside the simulation timer, and it
  used to be unguarded: an agent transcript that quoted its token count (`"99999"`, which a tool
  that stringifies numbers writes without malice) put a string into `CharacterSync.inputTokens`,
  the throw escaped the timer, and **Node exited — every zone in the process, from one line of one
  account's feed.** Reproduced end to end 2026-09-07.
  Three layers now, and the reason there are three is that each catches what the others cannot: the
  boundary coerces (`agentCount` in `protocol.ts`, the contract for what a count IS), the engine's
  public setter clamps so no other caller can poison the state (`setAgentTokens`), and `tick()`
  catches, logs once and keeps the world running — because a simulation that cannot express one
  field must not stop a world, and the next such field is not yet written.
  `feedTokenCounts.int.test.ts` pins all of it, including the schema's own behaviour, and it fails
  four of five ways without the fix. When you add a synced field fed from anything a user or an
  agent wrote, coerce it where it enters.
- **This section is verified, not trusted.** `mmo-readiness`'s security check
  (`.claude/skills/mmo-readiness/security.mjs`) fails a route that neither
  authorizes itself nor stands on an allow-list with a written reason, a message
  handler that keys off a payload id, a message type nobody sends (dead surface —
  that is how `meetingRoomJoin` kept granting call membership from any distance
  long after anything sent it), a voice token minted for a non-member, an
  unattributed or unbounded chat line, and a secret in anything sent to a client.
  Its own rules are self-tested (`check.sh --selftest`) because a grep that stops
  matching keeps printing PASS. So: **a change that adds a surface adds its gate
  and, if the surface is new in kind, its rule plus that rule's self-test case** —
  and an allow-list entry always carries the reason it is safe.

## Memory

A world that runs for weeks and a tab that stays open all day fail differently
from a crash: they get slow, days later, with nothing to bisect. So memory is a
contract too, and it is **verified, not trusted** — `mmo-readiness`'s memory check
(`.claude/skills/mmo-readiness/leaks.mjs`) asks the same question the security
check asks: is the release present in the code that acquires?

- **Anything keyed by something that comes and goes is deleted when it goes.** A
  `Map` on a room keyed by `sessionId`, `userId` or an entity id must have a
  delete on the path where that thing disappears — `onLeave`, the removal event,
  the layout rebuild. `savedSpots` is why this is written down: a write-dedup entry
  per user, with no delete site anywhere, so a room kept one per visitor it ever
  had. Rebuilding a collection wholesale counts (`this.points =
  layoutToSitPoints(…)` is bounded by the layout); a `WeakMap` counts by
  construction.
- **The same rule in the database is a foreign key, not a list of DELETEs.** Rows
  that belong to an account (`server/src/schema/tables.ts`) declare
  `ON DELETE CASCADE`, so `DELETE FROM users` takes the sessions, preferences,
  stored positions, arcade saves, zone grants and meeting rooms with it. It was a
  hand-maintained list at each call site before, and the two call sites had already
  drifted: `/delete` forgot the user's meeting rooms where `DELETE
  /admin/users/:id` removed them. Measured on this repo's dev world 2026-08-27, 22
  rows belonged to accounts that no longer existed. `node:sqlite` enforces foreign
  keys by default, so nothing has to be switched on — but no table had declared one,
  so there was nothing to enforce. Two exceptions, each written down where it lives:
  a private avatar is one row of the shared `assets` table keyed
  (type, name) and a constraint cannot be conditional on another column (hence the
  orphan-avatar task at boot), and `zones.owner_id` must SET NULL rather than
  cascade — deleting an owner may not delete everyone else's world.
  **A new table with a `user_id` needs no thought and gets none**:
  `userDataCascade.int.test.ts` fails until it either cascades or is named there with
  the reason it must not. That check lives in the suite rather than in
  `mmo-readiness` deliberately — it reads the live schema through
  `PRAGMA foreign_key_list`, which is the truth, where a grep over DDL strings would
  only see one of the two places a table can be created.
  What a cascade does NOT cover is a per-user blob INSIDE a row: five of those lived
  in `settings` (keyed by user id inside one JSON object per kind) with no delete site
  at all, and they are tables now for that reason as much as for speed —
  `playerPos` cost 0.016 ms per write at thirteen entries and **5.3 ms at ten
  thousand**, on the thread the simulation ticks on, because every checkpoint parsed
  and rewrote the whole object. One row by primary key is 0.004 ms at any size.
- **A subscription on a process-wide emitter is a reference to everything behind
  it.** `controlBus.on` and `director.on` in a room need their `off` in
  `onDispose`, or the emitter retains the room, its state, its clients and its
  layout for the life of the server. This is the largest single leak this codebase
  can have, and the check asks the general question — is the emitter imported? — so
  a third bus is covered the day it appears.
- **A timer either gets cleared or gets `unref()`.** Beyond memory: a referenced
  interval turns "the server is idle" into "the server will not exit".
- **A blob URL is revoked, a per-entity texture is removed, a synced entry is
  deleted.** GPU memory is not collected for you, and a `MapSchema` entry nobody
  deletes is worse than a leak — it grows the state EVERY client decodes, forever.
- **Growth on purpose states its bound.** The runtime atlas, the warn-once sets and
  the per-preset caches all grow; each is named in `leaks.mjs`'s allow-list with the
  bound that makes it safe (keyed by content, by the tileset table, by an enum), so
  "this one is fine" is a decision somebody wrote down. The rules are self-tested
  like the security ones, and two of the planted leaks are the real regressions this
  check was written after. So: **a change that adds a place where state accumulates
  adds its release and, if the surface is new in kind, its rule plus that rule's
  self-test case.**
- **Measure with `heapUsed` after a forced GC, not RSS.** V8 does not hand memory
  back, so RSS climbs on a process that retains nothing: 1.4 MB per join/leave cycle
  here, while the live heap was flat. Start an isolated instance
  (`PIXEL_STREAM_DATA_DIR` at a scratch dir) with `--inspect`, drive it with a
  headless Colyseus client, and read `process.memoryUsage().heapUsed` after
  `HeapProfiler.collectGarbage`. Measured 2026-08-20: 36 join/leave cycles 64.3 →
  64.6 MB; 150 visits by 30 accounts through a room an anchor client kept alive 73.5
  → 73.6 MB, no object class growing. The static rules stay necessary anyway — a
  per-user Map entry is ~100 bytes, so 10 000 visitors is 1 MB nobody would spot on
  a graph.

## Conventions

### Code

- **`noUnusedLocals` is on, and it is a dead-code check, not a style rule.** An
  unused import is how dead code hides: a function loses its last caller, the import
  naming it stays, and every later "is this still used?" search finds the import and
  answers yes. Set 2026-08-27; the first run found 54 places, among them a whole
  unused table (`zone_meta` plus the two private methods that were its only callers),
  a write-only copy of the furniture catalog kept "for the editors" after the
  furniture editor was gone, and a documented pet-spawn rule that existed only as two
  constants and a comment. It also caught me deleting a field that was in use.
  `noUnusedParameters` is deliberately NOT on: a callback that ignores an early
  argument still has to name it, and `_`-prefixing every one of those is noise.
- **Never put a raw control character in a source file — write the escape.** A NUL
  used as a cache-key separator (`` `${a}\0${b}` ``) is a good idiom, but written as
  an actual 0x00 byte it makes GNU grep treat the whole file as binary, and every
  grep-based check then walks past it in silence — `mmo-readiness`'s security and
  memory rules included, since they are greps. Two client files had this (measured
  2026-08-27: `MatrixUI.ts` and `timeline.ts`, two bytes each) and searching them for
  a symbol they contained returned nothing at all, which is exactly the failure mode
  a check cannot report. `\0` in the source is the same character to the engine and
  visible to everything else.
- **Decorator gotcha:** `@colyseus/schema` needs `experimentalDecorators` +
  `useDefineForClassFields: false`, and `tsconfig` maps `@pixel/shared/office/*`
  to source so tsx applies decorators correctly. Don't "fix" these into a bundle.
- **Sprites are data:** `SpriteData = string[][]` of hex colours (`''` =
  transparent). Character sheets default to 16×32, 4 direction rows (down, up,
  right, left), 7 frames/row,
  but frame size is per-character (≤64×64) and per-pose frame counts are
  **track-driven** via `CharacterSpec` (`sprites/characterSpec.ts`). Adding a pose
  means a new `CharacterPose` + a `spriteForPose` branch + a track name + **its cadence
  in `office/poseCadence.ts`**.
  A track says how many frames a pose has and in what order; it does NOT say how fast, and
  that last part had three answers that disagreed — the engine's constants (pets, advanced
  server-side in `advancePetFrame`), a copy in `OfficeScene` whose own comment admitted it
  was "mirroring the engine's constants" (characters, advanced client-side, because frame
  phase is presentation timing — invariant 2), and a third hand-written table in the
  character editor. The editor's walk was 150 ms against the game's 75, so every author
  judged their walk cycle at **half speed** for as long as that table existed. One derived
  table now, per kind, since a pet walks at 120 ms and a human at 75.
  Two rules keep it honest. `poseFrameMs()` returns **0** for a pose the world holds still
  (a character's idle is the neutral standing frame; the engine has no sleep state at all),
  and only an editor may use `previewFrameMs()` — which differs from the world in exactly two
  named ways: a fallback cadence so authored frames for a static pose can be seen cycling, and
  `PREVIEW_SLOWDOWN` on a MOVING pose, because the editor shows a still, magnified sprite and a
  walk cycle that reads fine on a character crossing tiles reads frantic standing still (asked
  for from use, twice, in both directions). Both are factors or fallbacks ON the world's number,
  never a second table — a renderer must use `poseFrameMs` and nothing else. And
  `poseCadence.int.test.ts` reads `engine/pets.ts` for its `advancePetFrame` call sites, so
  a new pet state with a cadence and no table entry fails a test instead of quietly
  previewing at the fallback.
- **Measuring performance:** judge by **frame/CPU time**, not proxies like
  triangle count (greedy meshing once measured *slower* despite −20 % tris). The
  client has a perf overlay — **F8** or `?perf=1` — showing fps, frame time,
  character count and `tex/p/f` (live textures / atlas pages / packed frames), and sleeps its render
  loop when nothing moves.
  On the server, drive `OfficeState.update` over a real layout and take the MINIMUM of several
  interleaved runs — the mean is dominated by GC and the OS, and a first attempt at the numbers
  below had more noise than signal (a turned map came out *faster* than an upright one).
  Measured 2026-08-20 on uponu (158 placements): **0.062 ms/tick** as authored, 0.073 with
  every piece quarter-turned, 0.097 with every piece at a free angle — so turning a whole map
  costs about a thirtieth of a millisecond, and rotation is not a performance question.
  What WAS one, found by asking: `getCatalogEntry` was a linear `find` over all 1773 assets and
  is called from per-tick loops, at **24.2 µs per call**. It is a Map now (61 ns), which took
  that tick from 2.056 ms to 0.062 — **33× faster than before any of the turning work**. The
  lesson generalises: before believing a new feature is slow, measure what was already there.
  **A client's message RATE is not the patch rate, and reading it as one costs an afternoon.**
  `broadcastPatch` runs on `patchRate` (20 Hz) and `applyPatches` sends nothing when a window held
  no change, so what arrives at a viewer is the world's CHANGE rate. Measured with V8 precise
  coverage (`Profiler.startPreciseCoverage({callCount: true})` over the inspector, which needs no
  edit to the tree): `broadcastPatch`, `applyPatches`, `SimRoom.tick` and `tickOnce` ran 398-399
  times in 20 s — **19.9/s, in every configuration, old and new, at 2.7-8.4 % of one core**. The
  loop has never missed its beat. Beware the same tool's small numbers: an inlined hot function
  (`OfficeState.update`) is undercounted, reporting 7.6/s where it demonstrably runs at 20.
  What made a falling message rate look like a slowdown was the furniture payload: before protocol
  15, 101 agents gave 13.4 msgs/s at 4 611 B and 301 agents 8.5 msgs/s at 7 216 B — **60.33 versus
  60.25 KB/s**, the same bytes regrouped into fewer, fatter messages (five viewers: 5.4/s at
  10 889 B, 57.95 KB/s). Judge the wire by **KB/s**, never by messages per second. After the change
  the rate rises with activity, which is the direction that means something: 2.5/s at 101 agents
  (0.04 KB/s) and 10.5/s at 301 (0.11 KB/s).
- **What a MOVING world costs is measured, and `scripts/wire-load.sh` re-measures it.** N headless
  viewers join and walk; the number that extrapolates is **154-156 bytes per second per moving
  entity per viewer** (~8 bytes per entity per patch window), and it is linear — 10 walkers gave
  155 B/s, 30 gave 154, 12 gave 156. So the wire cost is
  `moving entities × viewers × 155 B/s`:

  | moving | per viewer | 10 viewers | 100 viewers |
  |---|---|---|---|
  | 30 | 4.6 KB/s | 0.4 Mbit/s | 3.7 Mbit/s |
  | 100 | 15 KB/s | 1.2 | 12 |
  | 300 | 46 KB/s | 3.7 | 37 |
  | 1000 | 154 KB/s | 12 | 123 |

  Two estimates in a row were wrong by more than 2× before this was measured, which is why the
  script exists rather than a paragraph of arithmetic. Server CPU rose 6.2 % → 12.3 % of one core
  from 10 to 30 walkers (each walker is also a viewer), and the encode is **shared**: one pass for
  all viewers, then a send per socket.
- **What is derived from the layout is built WITH the layout, and asking it per question was the
  engine's last real hot spot.** Three answers about the map were recomputed on demand:
  `occupiedSurfaceTiles` walked all 164 placements TWICE per pet decision (once for the
  affordance, once for the target search), `seatFacesFurniture` re-found its placement with a
  linear `find` inside a loop over placements — so `isFurnitureFreeForPet` cost 1.1 µs with one
  agent and **102 µs with 300**, times 21 perches — and `findFreeSpawnTile` rebuilt the footprint
  set of every placement and then filtered all 2651 walkable tiles, on every join. Measured on
  uponu at 300 agents:

  | | before | after |
  |---|---:|---:|
  | a pet's `'sit'` decision, end to end | 2.01 ms | **0.21 ms** |
  | its candidate enumeration | 1.62 ms | 0.02 ms |
  | `computePetAffordances` | 0.46 ms | 0.02 ms |
  | `findFreeSpawnTile` (per join) | 0.20 ms | 0.01 ms |
  | `layoutLoaded` packed (per join) | 0.41 ms | once per map |

  Four rules keep that honest, and each is a way a cached map goes wrong:
  - **Assigned wholesale, from one place.** `layoutDerived()` builds all three tables and is
    called at both sites that derive from a layout, right after `walkableTiles`. Never mutated
    incrementally, so they cannot drift and `leaks.mjs` reads them as layout-bounded.
  - **A catalog reload is a layout change.** The tables read `entryFor`, so a pushed tileset would
    stale them — `SimRoom` already rebuilds the layout on `ASSET_CHANGED`, which is what makes
    caching them safe at all.
  - **The encoded `layoutLoaded` frame is keyed on the layout OBJECT, not on an invalidation
    call.** `rebuildFromLayout` assigns a new one, so a pushed map misses the cache by
    construction and there is no list of "remember to clear this" whose failure mode is every
    viewer decoding a stale map. `layoutDerived.int.test.ts` fails first if a rebuild ever starts
    mutating in place.
  - **A pre-encoded frame goes through `client.enqueueRaw`, never `client.raw`.** `send` is
    `enqueueRaw` plus the packing, and the queue is what HOLDS a message while a client is still
    JOINING. `raw` writes to the socket at once, so the frame arrives before the SDK has a handler
    and is dropped — the world then sits in its loading phase until the deadline and the only
    clue is a browser console warning. That mistake was made here and caught in a real browser,
    not by a test; there is a test now.

  And one shape worth reusing: **a spawn needs ONE free tile, so it draws them at random and takes
  the first free one** (`SPAWN_PROBE_TRIES`, rejection sampling, so the choice stays uniform over
  free tiles) with the old exhaustive filter as the fallback for a genuinely crowded zone. Same
  insight as `pickReachable` for a pet's target: the cheap question is "is this one free", not
  "which ones are".

- **Interest management is a known lever and deliberately NOT built yet.** The trigger to revisit:
  a zone that regularly holds **more than ~150 moving entities**, or **more than ~30 viewers**.
  Map size is deliberately NOT on that list any more, and dropping it was a measurement, not a
  simplification: **the patch wire scales with MOVING ENTITIES, not with area** — a large empty map
  costs nothing on the wire (measured: 0 messages in 20 s on a still `uponu`), so a big map is not
  what makes per-viewer filtering necessary. Two facts decide the rest: `uponu` is
  56×57 tiles while the camera's minimum zoom (1) shows more than the whole map — so an
  interest RADIUS would have to be larger than the map, saving nothing — and the shared encode
  above means per-viewer filtering trades bandwidth for CPU (a `StateView` per viewer re-walks the
  changes once per viewer: 300 movers × 100 viewers is 30 000 filtered field encodes per patch,
  twenty times a second). When it does become necessary, the mechanism is native — `@view()` on
  the synced collections plus `client.view.add/remove` (@colyseus/schema 5, `client.view` in
  core 0.18) — and the honest form here is a **viewport** the client asks for (a client may only
  ever request LESS, never more; see § Security), because distance is not what decides
  visibility when the camera can show everything. Three traps to design around, each a feature
  this world already has: a scuffle PAIR must be atomic in a view (the client draws no cloud
  unless both ends name each other), a call's participants must stay synced regardless of
  distance, and a viewer's own avatar must never leave its own view.
  `entryFor` also memoizes per placement (a WeakMap), because every non-default placement built
  a fresh entry on every call: 1138 ns → 69 ns for a turned or resized piece.
- **A zone map stays at most about twice a screen, decided 2026-09-09** — and the existing
  `MAX_COLS`/`MAX_ROWS` = 100 already says so: 10 000 cells against the ~4350 tiles (87×50) a
  1400×813 canvas shows at minimum zoom. `uponu` at 56×57 is roughly one screen. **Both ways in
  hold to it**: `ZoneStore.clampSize` on zone creation, and `mapSizeRefusal` on a push
  (`zonePushApi.ts`) — which is where the real maps arrive and where, until this was written down,
  the only limit was 32 MB of JSON. A push over the cap is REFUSED rather than clamped, because a
  clamp silently drops whatever was painted past column 100 and there is no sensible answer to
  "which part did you mean"; the message says to split the map into zones joined by a portal
  instead. The check sits at the route and deliberately not in `importZoneTmj`, which would also
  gate `seedBundledZones` — a boot task may never keep the server from starting, and a bundled map
  is our own art where a pushed one is input. So the question
  "do maps grow?" is answered for now, and what a doubling costs is written down here rather than
  re-derived, because **neither of the two things it costs is interest management**:
  - **The client has no viewport culling anywhere.** `PhaserRenderer.buildStatic()` creates one
    GameObject per non-VOID ground cell — ~3700 live objects for `uponu`, all submitted and
    depth-sorted every frame, all destroyed and rebuilt on every `buildStatic`. At twice a screen
    that is ~8-10 000. Nothing in that pipeline scales sublinearly with area, so this is the first
    thing to measure (F8 / `?perf=1`, and judge by frame time — see above) and the first thing to
    fix if a big map feels slow.
  - **The `layoutLoaded` payload is per JOIN and scales with area.** Measured on `uponu`: **245 KB
    of JSON, ~78 B/cell**, of which `walls` is 46 % and `tileActions` the next largest because it
    serializes a full object per painted meeting-room cell. Twice a screen is ~700 KB. Deflate
    handles the wire (`perMessageDeflate` is on, and these arrays are runs of `null,`/`false,`);
    what it does not handle is one `JSON.stringify` of that object on the room's thread, per join
    and per live re-push. The optional-array habit is the lever that already exists —
    `tileFlip` and `decals` are omitted entirely when a map uses none.

  Two consequences of a bigger map that are behaviour rather than cost, and that no optimisation
  addresses: population is **config-driven, not area-derived** (`maxConcurrent` per pet variant,
  hard cap 8), so a bigger map holds the same animals and reads as emptier; and a wander target is
  drawn **uniformly over the whole map** (`characters.ts`, `pets.ts`), so "wander somewhere" turns
  into a long hike. Both are decisions to take deliberately if maps do grow, not bugs.
- **Sprites reach the GPU through one runtime atlas** (`client/src/render/sprites.ts`):
  `spriteTexture()` packs each SpriteData into shared canvas pages and returns
  `{key, frame}`, and `atlasFromImage()` packs a rectangle of an IMAGE into the same
  pages with one `drawImage` — which is how character and pet art gets there, since it
  arrives as a PNG sheet. A texture per sprite (or per skin) is what breaks batching — a
  painted decal field is hundreds of distinct 16×16 pieces, i.e. hundreds of binds per
  frame — so anything that draws a sprite goes through one of those two functions, never
  `createCanvas` of its own. Two exceptions, both deliberate: uploaded background images
  (real PNGs) and the Matrix rain — a TILING texture needs `GL_REPEAT` over a whole
  texture, which cannot be asked of one frame inside a packed page, so it gets one 32×128
  texture for the WORLD (`render/matrixRain.ts`), not one per character.
- **An effect that covers a figure is a tiled sheet, not a pixel loop.** The Matrix
  materialise/dissolve used to paint itself: every cell of the character's frame rectangle
  got a `fillRect` for the body and another for the rain, into a canvas texture per
  character that was re-uploaded every frame — 581 fills per frame for a 16×32 character,
  **4 376 for a 64×64 one**, measured at **7.10 ms per frame** with five 64×64 figures
  materialising at once (headless Chromium, software raster; two `drawImage` measured
  0.0083 ms for the same scene). It is now the ordinary atlas sprite at
  `matrixBodyAlpha()` with `MATRIX_RAIN_SHEET` tiled over it, which is two draws whatever
  the figure's size. Four rules keep that honest, and each is why a detail is where it is:
  the rain was never masked to the silhouette, which is what makes ONE generic sheet
  correct for every skin, pose, direction and frame size; the sheet **tiles rather than
  stretches**, because a frame authored for one height gives a 64×64 figure fat drops and
  a 16×32 one fine ones; the sweep is one BAND of drops in an otherwise empty tile scrolled
  by `matrixRainScrollY()`, and the empty gap (100 px) is longer than the tallest legal
  figure so a second band can never enter while the first is leaving
  (`matrixRain.int.test.ts` pins both, with the geometry read off the committed PNG); and
  per-figure variety comes from a horizontal offset derived from the character id, which is
  what replaced the 64 stagger seeds.
  **The pixel path is gone** (2026-09-11), and with it the seed array on `Character` and a
  second copy of every curve. It existed as a fallback for a sheet that failed to load, and
  the choice it offered was "7.10 ms per frame" against "no effect"; a missing sheet now
  simply draws no effect and the figure whole, which is the honest answer for art that did
  not arrive. What stays in `shared` is only what both sides must agree on — the phase and
  the per-style duration; the curves moved to `client/src/render/warpFx.ts`, where
  presentation belongs.
- **How a pawn arrives and leaves is the owner's choice, from one table.** `WARP_STYLES`
  (`office/effects.ts`) gives, per style, its label, its duration and the sheet it needs:
  `matrix` (the default), `beam`, `phoenix`, `implode`. Five rules, and each is a decision
  rather than a detail:
  - **The duration belongs to the world, not to the renderer.** Between the two phases the
    server MOVES the body (`update`'s `pendingWarp` branch), so the effect is what hides a
    real teleport — a style that took longer on one machine would show the jump on another.
    The engine reads `warpStyle(ch.warpStyle).durationSec`, and `warpStyle.int.test.ts`
    fails if a 1.0 s phoenix ever moves a body on a 0.5 s implosion's schedule.
  - **The style comes from the ACCOUNT, never from the warp message.** Everyone else sees
    it, so § Security applies: a client says which style it wants
    (`setWarpStyle`), the id is validated against the table on the way into the store **and
    on the way out** (that row is reachable by a restore), and the server publishes it on
    the pawn. Join, right-click warp, portal travel and reconnect therefore all look the
    same, and no reconciliation between two sources is needed — the destination, by
    contrast, stays a client REQUEST that the server validates, as it always was.
  - **It is not a lasting pawn property.** `CharacterSync.warpStyle` is set with the phase
    and cleared with it, because it is only ever read while one runs — unlike `skin`, which
    is needed every frame. One place sets both (`beginWarp`), since nine sites begin a
    phase and a style resolved at eight of them is a style forgotten at the ninth.
  - **An unknown id resolves to the DEFAULT, never to "no effect"** — the opposite of the
    `ControllerKind` rule and for the opposite reason: an unclaimed pawn should be inert,
    while an unstyled warp still has to cover the teleport.
  - **Two shapes cover four styles.** Anything that SWEEPS is a tiling texture (matrix,
    beam) for the reason above; anything that sits where the figure is and boils is a frame
    sequence (phoenix), because scrolling a flame reads as a passing light rather than as
    burning; and `implode` needs no art at all — it is a cubed squeeze on the frame the
    renderer already has. Adding a style is a row in the table plus a case in `warpFx.ts`,
    and its art gets a deterministic draw script like the cloud's
    (`scripts/draw-beam.sh`, `scripts/draw-phoenix.sh`, both with `--check` and a
    `--preview` that composites onto the canvas ground — a white beam on a transparent
    sheet looks like nothing in an image viewer and like a beam in the game).
  It cost `PROTOCOL_VERSION` 16: not for the field as such, but because an older build sees
  a style value it does not know, draws nothing, and then the teleport it was hiding becomes
  visible — which is the case AGENTS.md's own exception does NOT cover.
- **Characters and pets are drawn from their sheet, not from pixels.** `poseFrames.ts`
  (shared) turns a pose into a COLUMN — same rule as `spriteForPose`, arithmetic instead
  of arrays — and `client/src/art/sheetStore.ts` hands the renderer that cell out of the
  atlas. So the client holds no hex for art at all; pixels are read from a sheet only by
  the two callers that work on pixels (the character editor, the Matrix effect).
  Measured with 18 characters: update time **7.55 → 0.36 ms**, JS heap **74.6 → 46.6 MB**,
  still one atlas page. The pixel implementation in `spriteData.ts` stays as the
  REFERENCE `poseFrames.int.test.ts` measures the arithmetic against, across every
  bundled sheet, pose, direction and frame — keep the two independent, because that test
  is the only reason "the index picks the same picture" is a fact.
- **Character, pet and avatar art travels as a PNG, not as pixels.** The bundled
  sheets already ARE images (`assets/characters/char_*.png`, `assets/pets/*.png`);
  what a join used to ship was one hex string per pixel. Entries now carry a URL into
  `/art/<kind>/<id>?v=<hash>` (`server/src/artApi.ts`) plus the metadata a sheet cannot
  hold — name, `CharacterSpec`, pet config, and the frame size, without which a client
  would slice a 16×16 pet on the 16×32 character default. Measured: `characterSpritesLoaded`
  668 → 2.9 KB, `petSpritesLoaded` 163 → 1.4 KB, a player avatar 77 → 0.2 KB, and the
  sheets themselves are 20.5 KB for the whole roster (PNG written with
  `filterType: 0, deflateStrategy: 0` — pngjs's RLE default costs 5× on pixel art).
  Two rules that keep it honest: the route stays out of `/assets/` — that prefix is the
  client BUILD and is the one thing served anonymously, while an avatar is personal art
  (the gate used to exempt by file EXTENSION too, which is why `/art/<kind>/<id>` carries
  none; see § Security); and the URL-building half stays free of bundle lookups
  (`server/src/art/artUrl.ts`) — asking `getMergedBundle()` from inside the bundle
  build recurses into a stack overflow on the first join.
  **A sheet carries all four sides.** `left` used to be mirrored from `right` on every
  load, which is the one direction the engine invented — and only correct for symmetric
  art (a bag on one shoulder, a dog's saddle). It is a row now: the bundled sheets were
  converted once (`scripts/add-left-row.sh`, idempotent), stored rows by a one-time boot
  migration (`art/migrateLeftRow.ts`, remembered in `_migrations`), and the editor fills
  it from a mirrored right on **save and export** so three-row data cannot be written
  again. Two rules that keep it from rotting: a sheet's rows are the longest PRESENT
  prefix of (down, up, right, left) — `rowsPresent`, because an EMPTY row draws an
  invisible character in that direction, which is worse than no row — and the only place
  that still mirrors is the sprite store's door (`withLeftRow`), never the drawing path.
  **The database holds the same PNG**, not pixels: `appStore` packs character-shaped
  rows on write and unpacks them on read (`art/artStore.ts`), so every caller still
  deals in SpriteData and nothing else in the server learned about images. Saves are
  still validated as SpriteData BEFORE encoding, which is why packing added no untrusted
  binary path of its own.
  **The sheet is a BLOB in its own column** (`assets.png`), not a base64 field inside the
  `data` JSON — because base64 only ever existed to get bytes through a text column, and
  the column is the thing that was wrong. `splitArt`/`joinArt` in `appStore` are the only
  code that knows, and the in-memory row now carries `png` as a **Buffer**, which is the
  shape a bundled sheet already had: stored and bundled art are one type. Measured on
  char_0: 4 041 → 3 063 stored bytes (−24 %), a read that needs the bytes 3.64 → 1.06 µs,
  a write 3.08 → 0.50 µs, because `JSON.parse` sees 164 bytes instead of 4 KB. **Do not
  read that as a speed fix** — every path involved is cached (the merged bundle is built
  once per cache generation, `/art/<kind>/<id>` answers with an immutable ETag), so the
  absolute saving is microseconds per join; what it buys is a quarter of the space and a
  data model where pixels are bytes. Nothing on the wire changed, so no
  `PROTOCOL_VERSION` bump. Two traps it sprang, both now covered by tests: a reader that
  selects only `data` sees a packed row as having no sheet (that is `migrateLeftRow`
  repacking against the OLD bytes still in the column, and `repack-art` reporting healthy
  rows as failures), and `length(data)` stops being the row's size — the orphan-avatar
  prune reported every avatar as a few hundred bytes until it summed both columns.
  **Saving art is a PNG over HTTP** (protocol 8), not a room message: `POST /art/avatar` for
  your own avatar and `POST /art/asset/:type/:name` for a gallery skin or a pet
  (`artSaveApi.ts`), with the sheet as the BODY and its metadata in an `X-Pixel-Sheet` header —
  base64 in a JSON body would add a third to every save. One hex string per pixel was 95.3 KB
  where the image is 2.8 KB, a factor of 34 on a real sheet (measured on char_0).
  Being a route rather than a message buys four things, and it is worth knowing which: its own
  size limit stated per route instead of the transport's global one; an ANSWER, so a refused
  sheet reaches the editor as a reason instead of vanishing; two fewer message types on the
  room's surface; and a decode that nothing in the room refers to any more, so moving it to a
  worker later is a change to one file. What it does NOT buy is protecting the tick: HTTP and
  the room share one process and one thread.
  That makes a client's PNG the one untrusted IMAGE this server decodes, and `art/sheetPng.ts`
  is the gate the older warning here asked for: a byte cap (2 MB, derived — the largest legal
  sheet is 1.50 MB even as incompressible noise), the PNG signature, an 8-bit non-interlaced
  IHDR, and the DECLARED dimensions checked against the frame size and `MAX_SHEET_CELLS` — all
  before pngjs sees the file, so a 73-byte bomb claiming 30000×30000 never reaches a decoder.
  The sheet is then re-encoded rather than stored as it arrived, so what other viewers are
  served is a PNG this server wrote, and the pixels are never spelled out as hex on the way (48
  → 12.9 ms for the largest legal sheet; the format check they existed for is meaningless for
  decoder output, and the geometry is decided from the header). Authorisation comes from the
  session, never the payload: `/art/avatar` takes no id at all, and the asset route needs an
  admin. The rooms hear about a save through the control bus (`AVATAR_CHANGED_EVENT`, or
  `ASSET_CHANGED_EVENT` as before) — verified end to end in a browser: the POST answers 200 and
  the client re-fetches the art at its new content hash.
  **And that decode runs OFF the thread the world ticks on** (`parsePng`/`packPng`, pngjs's stream
  API): `PNG.sync.read`/`write` run zlib on the main thread, and the largest legal sheet measures
  **47 ms** there — 44 of them the re-encode — against a 20 Hz budget of 50 ms. Measured with a
  20 Hz timer running alongside five uploads: the worst tick ran **63 ms late and only 15 of 20
  ticks happened at all**; through the stream API it is 13-17 ms and no tick is skipped, at the
  same wall clock per conversion (51.6 vs 50.7 ms). So one upload used to stall the simulation of
  every zone in the process for more than a tick, and a client that sends incompressible noise
  decided when — a real sheet is ~13 ms rather than 47, which is why this is about the worst case
  and not the common one. The order is unchanged and is what matters for safety: every cheap
  check still runs synchronously BEFORE any decoder sees the file. `sheetPng.int.test.ts` asserts
  the call form is gone, because nothing about the returned sheet differs and no behavioural test
  can tell the two paths apart.
  Two measurements that came out of the same look and are worth not re-deriving. **The room's
  SQLite writes are not a problem**: `setPlayerSpot` (the 5-second checkpoint) is **3.1 µs**, a
  read 0.8 µs, a viewer setting 4.2 µs — so 300 players checkpointing cost under a millisecond
  spread over five seconds, and moving the store off-thread would buy nothing while making 57 call
  sites async. **`encodeDirectionalSheet` still packs synchronously** (`art/artStore.ts`, on
  `appStore.saveAsset`): 3.2 ms for an ordinary character sheet and **86.7 ms for a maximal one**,
  on an explicit user action ("save my avatar as a template", `SimRoom`'s one call). That one is
  worth fixing when somebody is in there anyway — it needs `saveAsset` to become async, which
  ripples through a store used in 57 places, so it is a change of its own and not a detail. The
  same function on the art-SERVING route is the legacy fallback for un-repacked rows and is
  cached per content hash, i.e. cold and bounded. `mmo-readiness` has a rule for the
  shape (a client-supplied image is bounded and header-checked before decoding) with its own
  planted hole. Legacy rows read back untouched; `scripts/repack-art.sh` shrinks an old
  world on purpose (measured here: 495 → 16 KB), verifying every row by unpacking it
  again before keeping the write. One thing to know: the decoder canonicalises hex to
  upper case, so a packed row reads back equal in colour but not in string case — the
  runtime atlas keys sprites by object identity, so nothing depends on the text.
- **A baked sheet is already an atlas — never slice one into pixels.** Floor and
  wall sheets are registered as one texture per set and drawn by frame
  (`registerSheetTexture`/`sheetFrame`); `shared` names a cell (`SheetCellRef`)
  and stays free of graphics concepts. Slicing them into `SpriteData` is what the
  client used to do, and it turned 533 KB of PNG into ~34 MB of hex strings
  (measured 88.6 → 58.9 MB of heap when it stopped). The same applies to any art
  that arrives as an image: keep it an image.

### UI — one look for all chrome

Every in-app surface (menus, panels, dialogs, editors, buttons, inputs, chips)
uses one style, defined canonically in the CSS block in
`client/src/scenes/OfficeScene.ts`. **Reuse those classes** rather than
hand-rolling: `.pa-btn`, `.pa-panel` + `.pa-head`/`.pa-body`/`.pa-x`, `.pa-b`
(+ `.primary`/`.danger`/`.wide`), `.pa-seg`/`.seg`, `.pa-chip`, `.pa-menurow`,
`.pa-list-row`, `.pa-thumb`. A self-contained widget that cannot share the
stylesheet must mirror the same tokens — including non-CSS colour literals: a
Phaser tint or a canvas fill names the same hex as its CSS counterpart.

Tokens (from uponu.com's palette). Font `'FS Pixel Sans', ui-monospace,
monospace`. Surfaces: window/panel `#1c1a19`, raised `#242220`, inset `#262422`,
deep-inset `#141312`, segment-on `#37342f`. Border **always `2px solid #0a0908`**.
Bevel `inset 0 2px 0 #4a4744, inset 0 -3px 0 #050505` (panels: `#292725`/`#030303`
plus `0 12px 28px rgba(0,0,0,.55)`). Text `#f1efec`/`#f5f3f0`, muted `#adb0b2`,
dim `#818586`, link `#4998c0`. Accents: primary red `#c51a1b` (inset
`#e2585a`/`#5c0f10`) for primary actions *and* "on" toggle states; danger `#7c2634`
(`#b34a5a`/`#45111a`) deliberately darker so destructive stays distinct; warn
`#a86a2e`; live/active green `#7fbf6a`/`#5aa348` for status indicators only, never
a button; highlight `#e7da00`. Radius: buttons `0.35–0.45rem`, panels `0.6rem`.

**Deprecated — do not use** (pre-restyle): panel `#14161c`/`#1b1f2a`, control
`#2a2f3a`, borders `#3a4150`/`#2c323e` or any `1px solid` on chrome, accent
`#3a6df0`, flat `0 8px 0` shadows. (`#14161c` is fine as the Phaser *canvas*
background only.)

- **The client waits for its art, then draws once** (the loading phase in
  `OfficeScene.runLoadingPhase`, panel in `ui/loadingOverlay.ts`). Four independent
  channels feed the first frame — the baked atlas, the catalog message, the layout
  message and the character sheets — and nothing orders them. Drawing as they landed
  gave grey floors, black boxes where trees belong and a burst of "no art for …"
  warnings, all repainted a moment later. So: fetch the HTTP art, wait for both
  messages, then fetch only the tilesets the layout NAMES (`floorSets`/`wallSets` — a
  ground or wall cell can refer to nothing else, so the palette this zone never paints,
  the roads it has not drawn and the collision marker nothing renders all stay home:
  177 KB of 774 KB here, and one sheet more per pack imported) plus the ref images this
  map's placements name (`prefetchRefImages`), and draw once. `update()` returns early while it runs, because the renderer syncs
  furniture every frame and would otherwise resolve ids whose art has not arrived —
  which is what it did, invisibly in Chrome and 62 times over in Firefox.
  Two rules that keep it honest: the wait has a deadline (a panel that never goes away
  is worse than a partial world), and the live-change paths stay — a tileset saved in
  Tiled still introduces art nobody has fetched, and that repaint is what draws it.

### Content pipeline

- **Importing an art pack follows the `tiled-asset-import` skill**
  (`.claude/skills/tiled-asset-import/`). It carries the three decisions every
  import faces — what each piece IS (floor, flat decal, standing decal, furniture),
  sheet or collection, palette or natural-only — and the mechanics that have each
  cost a bug: the 2 px gap plus 1 px extrusion on every sheet, ids as identity,
  deterministic output, and appends that leave existing gids alone.
- **`png/src` is art, `png/baked` is a build product.** ALL art lives under
  `assets/tiled/png/src/` — whether it was drawn by hand (`floors/`, `walls/`) or
  cut from a pack by an import (`furniture/`, `decal/`, `sheets/`, `images/`). A
  map designer only ever puts files there. `png/baked/` holds exactly what can be
  reproduced from `png/src/` alone — the palette-baked floor and wall sheets and the
  furniture atlas — and **nobody places anything in it**. The atlas restores itself
  on the next start; the sheets need `bake-floor-wall-tiled.mts`, deliberately by
  hand, because that bake also writes the floor/wall TILESETS and a changed tile
  count would move every gid in every map.
  That property is the point, and it is what decides where a file goes: the two
  imported grid sheets (`decal-overworld`, `decal-roads`) are cut from packs that
  live outside the repo, so a checkout cannot regenerate them — they are source,
  not build output, however script-written they look. Get that wrong and "clean out
  baked/" silently destroys art.
- **Authoring format follows what a TILE has to say; the browser gets one image
  per kind.** A furniture piece is one object with its own size and its own
  behaviour, so it is one tile → a collection of images. Ground and decoration cut
  from an art sheet are pictures per cell whose arrangement IS the content → a grid
  sheet. Those two are the only choices, and Tiled cannot open the atlas anyway (it
  is shelf-packed with 28 frame sizes). Delivery is then uniform: a grid sheet is
  already one image, and collections are packed into the atlas.
- **The atlas is baked by the server, not by remembering to run a script.**
  `ensureFurnitureAtlas` (`server/src/tiled/furnitureAtlas.ts`) re-bakes at startup
  and on a tileset save when the source art has changed, fingerprinted by CONTENT
  so a fresh clone does not rewrite the artifact. `scripts/bake-atlas.sh` stays for
  baking without a server and for `--check`. Why it matters: a stale atlas silently
  changes the delivery format — ids it lacks travel as single files instead — so
  "one image or many" would depend on whether somebody ran a script. It is still
  committed, because two of the baked sheets are cut from packs that live outside
  the repo and cannot be regenerated from a checkout.
- **Nothing outside the tileset says where art lives.** A `.tsj` names its own
  image; `sets.json` passes that path (and the atlas manifest's) to the client. The
  client used to assemble `png/<set>.png` itself, and moving the baked sheets would
  then have needed a client release to find art that had not changed.
- **A tileset is what its tiles say it is, not what it is called.** A furniture
  tileset is one whose tiles carry the `FurnitureTile` class
  (`isFurnitureTileset`) — no filename prefix decides anything. A layout *names*
  the sets it uses and per-tile numbers index that table, so renaming is safe and
  reordering is a no-op. Nothing enumerates tileset filenames; the client asks
  `/assets/tiled/sets.json`.
- **Furniture behaviour is stated on the tile, never inferred.** Sittability,
  facing, pet perching, what it turns into when switched on — each is its own
  property, present on **every** furniture tile with its default filled in, and
  overridable per placement (`server/src/tiled/furnitureProps.ts`). When you add,
  rename or retire a property, do it in the same commit as `FURNITURE_TILE_PROPS`
  and then distribute it with `scripts/sync-furniture-properties.sh`. Add it to
  **both** the `FurnitureTile` and `FurnitureObject` classes in
  `Pixels.tiled-project` — Tiled only offers a class's own members, so a property
  missing from `FurnitureObject` is settable on the type and invisible on every
  placement. Keep the object class a superset of the tile class.
- **The GroundLayer decides what is ground — not the tile.** A cell painted on
  `GroundLayer` becomes ground whatever tileset it came from: the layout stores the
  tile's LOCAL ID plus which set it belongs to (`OfficeLayout.tiles` +
  `tileFloorSet`/`floorSets`), so an imported art sheet is ground exactly like a
  palette-baked floor set, and no bake is needed for either. This replaced a
  `class === 'FloorTile'` test in the importer that turned every other ground tile
  into VOID — silently, and VOID is neither drawn nor walkable, so a region painted
  with pack art was both invisible and closed. The one restriction left is physical:
  a ground cell is one map cell, so a tileset with bigger tiles is refused with a
  message (`groundFits`).
  Ground and decal are now the same shape (a cell of a sheet) and differ only in
  what the layer means: ground is underneath and makes the cell standable, a decal
  is a picture and never affects walkability. **Only the ground makes a cell
  walkable** — art alone never does.
  **A ground cell keeps the way Tiled turned it.** All three flip bits survive the
  import as one small mask per cell (`OfficeLayout.tileFlip`, resolved only by
  `office/tileOrientation.ts`), so every one of Tiled's eight orientations — two
  mirrors, a half turn, and the four diagonal states — draws in the game as it does in
  the editor. Three things make that safe and cheap. The bits used to be *stripped*
  (`baseGid`), which was itself a fix: a mirrored gid matches no tileset range, and the
  cell silently became VOID, invisible and unwalkable. It is cosmetic only, so it lives
  in the layout and touches nothing but the renderer — a mirrored cell is the same tile
  of the same sheet, and what makes it walkable is still that ground is there. And the
  array is **left out entirely unless the map turns something**, so today it costs
  nothing; a dense array of 3192 zeros would otherwise travel to every client on every
  join. The diagonal states are only expressible because `groundFits` already requires
  a ground tile to be exactly one square cell — a quarter turn of a 16×32 tile would
  overflow its neighbours.
  **A decal turns the same way, when its art can take it.** Decals go through the same
  table (`orientationOf`, the placement's three booleans instead of a mask) and get all
  eight orientations — but only where the art is SQUARE, and that is decided at import,
  not in the renderer: a decal may be several cells tall, and a 32×16 piece turned a
  quarter of the way round would occupy 16×32, i.e. cells nobody painted. What Tiled
  draws for an oversized rotated tile in a tile layer is not something a checkout can be
  compared against, so the import keeps the two mirrors, drops the turn, and names the id
  — the same shape of refusal as `groundFits`.
  **A placed OBJECT turns too, and that is where a turn stops being cosmetic.** Furniture and
  images carry Tiled's object `rotation` (the same field a text label already used), and for
  furniture `entryFor` swaps the piece's sides for a quarter turn — so the cells it blocks,
  the seats it offers, its approach tiles, where a pet perches and how it sorts all follow the
  picture, and its sitter turns with it. That is the whole reason the turn is resolved in
  `entryFor` and not in the renderer: a picture-only rotation is a collision bug with a
  plausible screenshot. Tiled's own pivot decides where the piece lands — "clockwise around
  (x, y)", the bottom-left corner of the unrotated box, so the box SWINGS rather than spinning
  in place (`turnedTopLeftPx`).
  **Any angle is honoured; what a turn cannot carry is dropped, loudly.** A quarter turn keeps
  everything — the sides swap and seats, facing and depth come with them. Any other angle is
  drawn as Tiled shows it and occupies the RECTANGLE around the turned art (`turnedExtent`),
  which is the only answer axis-aligned cells have for a diagonal piece; it covers cells the
  art does not reach, so the piece keeps blocking (never walk through a couch) but loses its
  seats — a seat on a cell where there is no couch is worse than a couch you cannot sit on.
  Air rows go the same way for any turn at all: `backgroundTiles` says "my TOP rows are air",
  which stops meaning anything once the top is a side, so it is dropped towards SOLID. Both
  losses are written onto the placement as ordinary overrides (`canSitOn`, `backgroundTiles`),
  so nothing downstream has to learn about angles, and both are named in a notice the push
  prints. Images take any angle with nothing to drop — a free pixel box, no cells.
  Two numerical details that are load-bearing: the quarter turns are an EXACT swap rather than
  `cos(90°)`, whose 6e-17 would ceil into an extra blocked cell, and a free extent is rounded
  to whole pixels first, because a 32×16 couch at 37° measures 32.04 tall and those four
  hundredths would otherwise cost a whole row.
  **Turning is not a performance question** — measured, because it looks like one: see the
  numbers under "Measuring performance". The old comment saying
  rotation was deliberately not adopted is a warning now rather than a rule: art drawn from
  one fixed camera angle still has no sensible rotated frame, so a turned desk reads wrong
  however correctly it is drawn — it is turn-symmetric pieces (a rug, a crate, a plant) that
  make this worth having.
  **`FurnitureSync.angle` is a synced schema field**, so this bumped `PROTOCOL_VERSION` to 5:
  the client draws the piece and decides what a seat tile is, so a turn that stayed on the
  server would have it drawing across the wrong cells and refusing clicks on real seats.
  Both paths are measured, not argued: the tests pin the table against where the four
  corners of a cell land, and the orientations were read back out of a screenshot of the
  running client — pixel-exact for all eight, where an unturned cell differs in 96 to 226
  of the pixels its art paints.
  **No tile class decides anything any more.** `FloorTile` and `WallTile` are both
  gone: neither carried a property, and the one fact they encoded — how tall a cell
  is — is stated by the tileset itself (`tilewidth`/`tileheight`, passed to the
  client in `sets.json` and kept in one `SheetGrid` table). A `SheetCellRef` is now
  just (sheet, row, col), and a sheet cell is a sheet cell whether it draws ground or
  a wall piece. What still classifies is the LAYER (`GroundLayer`,
  `WallLatticeLayer`, `DecalLayer`, `CollisionLayer`) and, for things with
  behaviour, `FurnitureTile`/`DecalTile` — those carry real properties.
- **A placement's own size is honoured, and it means more than the picture.** Tiled
  lets you resize a tile object; `PlacedFurniture.width/height` carries that, and
  `entryFor(item)` hands every reader the catalog entry as it applies to THAT placement
  — drawn size, footprint in cells, and the air rows scaled with it. That is the point:
  a size decides blocking, seats, approach tiles, pet perching and depth, so resolving
  it anywhere but in one place lets the collision disagree with the picture. Ignoring it
  used to be two bugs at once — drawn at the art's size AND anchored by the art's
  footprint, so a machine placed at 16×16 from 32×32 art sat a cell too high.
  `entryFor` returns the shared entry unchanged when there is no override, so the normal
  case allocates nothing in per-tick loops.
- **Furniture does not travel per patch: the map carries it, the client animates it, and only
  ON/OFF is synced.** The placements arrive once in `layoutLoaded` (uids and overrides included),
  the animation FRAME is resolved client-side per frame from `animationFrameAt` and the scene's own
  clock, and `RoomState.furnitureOn` — the uids that are switched on — is the only furniture fact
  on the wire. A still map therefore costs **nothing**: measured on uponu with one viewer,
  **0 messages in 20 s**.
  It was the other way round until protocol 15, and the numbers are why this is written down. The
  engine expressed an animation frame as a different art ID (`{...item, id: frame}`), so the
  ambient animation swapped its placement list ~5×/s; `SimRoom.syncFurniture` spliced the whole
  `FurnitureSync` array and rebuilt all 163 records of nineteen fields, so every field was dirty
  and each patch carried the entire map: **11 442 bytes per patch, 57 KB/s per viewer, in a world
  where nothing moved** — 46 Mbit/s at 100 viewers, to say that a goldfish and a flag had reached
  their next picture. Measured per swap, four of 163 entries differed, and all four differed
  *only* in that art id.
  Five things make the split hold, and each is a decision rather than a detail:
  - **A frame is presentation timing** (invariant 2), so it belongs to whoever draws — the same
    rule the walk cycle already followed. The phase now differs between viewers, deliberately.
  - **ON/OFF is not animation, it is state**: it comes from who sits where (`autoOnSitters`) and
    from another viewer's click, neither of which a client can derive. It stays server-side, and
    `rebuildFurnitureInstances` runs only when that answer can change — a new map, a toggle,
    somebody sitting down or standing up.
  - **Both halves read the SAME shared resolver.** The engine applies `resolveOnState` to its own
    placement list and the client applies it to the map's; a client that reached its own answer
    would draw a dark monitor at a working desk. Geometry is safe either way — measured, all six
    animation groups agree in footprint, size, `canSitOn`, `sitFacing`, `backgroundTiles` and
    `action` across every frame, so nothing about collision or seats depends on the frame.
  - **An animated piece keeps the render loop awake** (`hasAnimatedFurniture` in `sceneBusy`).
    While the frame came from the server, its patches did that as a side effect; without the rule a
    fountain freezes the moment the scene goes idle.
  - **The ON variant's art is prefetched with the map's** (the loading phase adds
    `resolveOnState` per placement), because the map now names only the off state and a monitor
    lighting up must not wait for a fetch.
  `furnitureAnimation.int.test.ts` pins the inversion — an animated piece placed, 400 ticks, and
  the placement list must NOT be replaced — plus that the frames a client animates from exist, and
  that sitting down still switches the monitor on and standing up switches it off.
- **Decoration is a decal, not an object.** A `DecalTile` painted on a
  `DecalLayer` is a picture and nothing else — it lives in the *layout* (one
  `layoutLoaded`, like the floor), never in `OfficeState.furniture`, so it has no
  synced fields and no scan walks it. That is what lets a map paint hundreds of
  ground patches; a furniture placement costs fifteen synced fields and eleven
  linear scans, which is right for a chair and wrong for grass. Consequences to
  keep: a decal never blocks (the `CollisionLayer` does that), carries no Action,
  and states no behaviour of its own. Anything that must be *interacted with*
  stays furniture. Add a decal property the same way as a furniture one: in
  `DECAL_TILE_PROPS`, in the `DecalTile` class, then distribute with
  `scripts/sync-furniture-properties.sh` (it dispatches per tile class).
- **Flat-or-standing belongs to the layer, not the tile.** A `DecalLayer`'s own
  `occludes` property decides whether everything painted on it lies under the
  characters or sorts against them, and the import copies that answer onto each
  cell (`PlacedDecal.occludes`). Deliberately not a tile property: whether a
  picture is background or an obstacle is a fact about the *place* — the same tree
  is scenery on a hillside and an obstacle beside a path — and a tile-layer cell
  has nowhere to carry an override, so a tile-level answer would force one for the
  whole map. It is also what lets furniture art be painted as a decal, since
  nothing is then read off the tile that a `FurnitureTile` could not answer.
- **A map's tileset table says where each tileset ENDS, not just where it starts.**
  The gid ranges come from the `.tmj`'s own `tilesets` array, and each entry is
  capped at the next entry's `firstgid` (`resolveFromTmjTilesets`) — never at the
  tileset's current tile count on disk. That is what makes **appending** art to a
  tileset harmless for maps saved before it: an older map keeps resolving to what its
  author painted, and simply cannot reach the new tiles until it is saved in Tiled
  again. Taking the count from disk instead let a grown tileset swallow the first
  cells of the next one — a decal in an older map came back as a fountain frame,
  silently. The cap is the smaller of the two answers, so a map NEWER than the
  tilesets leaves a visible hole rather than drawing the wrong art.
  What this does NOT cover, and no cap can: inserting or reordering tiles inside a
  tileset (local ids move), renaming or deleting an id (placements refer to names),
  and re-baking a grid sheet with a different column count (a ground cell's number
  means another cell). Hence: **append only, never insert, never renumber, retire
  instead of delete** — and if art really is removed, the maps that used it must be
  re-authored.
- **A map's pictures are files, not rows.** An image placement carries the path to its
  file under `assets/tiled` (`PlacedImage.src`, layout **version 3**), and the client
  fetches it over HTTP like every other sheet. It used to be stored as a base64 row and
  shipped in an `imagesLoaded` message on every join — a copy of a file that is already
  in git (measured: 60 KB per join for one 46 KB picture, 237 KB when three unused rows
  were still there). The `image` asset type is gone with it: a pushed map writes any
  picture the server lacks to DISK (`tiled/zoneImport.ts`), and nothing writes it to the
  database. A v2 layout is migrated on read by resolving the id against
  `png/src/images/` — and a placement whose file cannot be found is dropped rather than
  carried forward as a hole.
  One trap this sprang, worth knowing before adding the next field: `sanitizeLayoutImages`
  rebuilds every image from a WHITELIST, so `src` — added by that very change — was stripped
  on every write path, the renderer then skipped each image for want of a path, and a map's
  pictures silently stopped appearing (uponu's own logo included, until 2026-08-20). A field
  added to a layout type is not saved until it is named there, and a path that ends up in a
  client fetch is validated there too.
- **A zone has exactly one map, and it comes from Tiled.** The `layouts` table is
  keyed by zone id: no named layouts, no active-layout pointer, no bundled
  read-only default, no code-generated zone. The import is one-way; there is no
  exporter and no in-game world editor.
- **Zone maps are versioned but pushed, never deployed.**
  `assets/tiled/zones/*.tmj` is committed so levels are diffable and shareable,
  and a bundled map **seeds a zone that has none** at startup
  (`tiled/seedBundledZones.ts`), so a fresh deployment has a world. Seeding never
  overwrites: a zone that already has a map keeps it, because a push is authored
  against *that* deployment and a release must not undo one. Changing a live map
  is always `scripts/push-zones.sh` (auth: `PIXEL_ADMIN_TOKEN` in
  `X-Pixel-Admin-Token`). Scratch copies (`*-noimport.tmj`) stay out of git.
  A push is refused if the map is bigger than `MAX_COLS`×`MAX_ROWS` — see the
  zone-size bullet under § Conventions for why that is a refusal and not a clamp.
- **Slash-commands for navigation and quick actions.** The framework in
  `shared/src/commands.ts` (`user`/`admin` groups, gated by `mayRunCommand`) is the
  canonical way to reach another view or trigger a quick action — client-side via
  `ChatUI`'s `clientCommand` hook, server-side in `accountCommands.ts`. A new
  destination or chat-triggerable feature gets a command in the same change; it
  then shows up in `/help` automatically.

### Operations

- **Config via env:** `PIXEL_STREAM_PORT`, `PIXEL_STREAM_HOST`,
  `PIXEL_ADMIN_TOKEN` (also `--token`), `PIXEL_STREAM_DATA_DIR` (holds
  `pixel.db` plus `cert.pem`/`key.pem`; **defaults to `tmp/data` in the repo** so
  a dev world belongs to its checkout — a deployment always sets it, the image to
  `/data` with a volume mounted there), `PIXEL_RESET_WORLD`, and the `PIXEL_OIDC_*`
  set that configures single sign-on (see the Accounts bullet and
  [.env.example](.env.example)).
- **First-start conveniences are development-only** (`dataBootstrap.ts`): the data
  directory is created, a self-signed certificate generated, and a database
  adopted from a former default path. All three are gated on nobody having set
  `PIXEL_STREAM_DATA_DIR`, and that gate is load-bearing — generating a
  certificate in a container's `/data` would flip the server to HTTPS, and the
  deploy topology needs it plain behind Caddy, which terminates TLS itself.
- **`PIXEL_RESET_WORLD=<token>`** empties everything except the `users` table and
  the personal `playerAvatar` assets, once per token, at the next start — before
  any store reads or seeds. A `VACUUM INTO` backup is written first, and no backup
  means no wipe. Survivors are an allow-list (`server/src/worldReset.ts`): a table
  added later is wiped by default, so **if you add one holding account data, add
  it to `KEEP_TABLES` in the same change.**
- **Housekeeping runs at boot, unattended — so it is safe by construction.**
  `maintenance/startupCleanup.ts` runs before anything reads the world (before
  `loadAssetBundle`, since the bundle is built from these rows and then cached
  process-wide). Two tasks today: stored asset rows no tileset carries any more, and
  personal avatars whose account is gone (~77 KB each; the delete paths already clean
  up, so this is for a restored or hand-edited database). A task added there must
  honour the contract in that file's header:
  two independent sources of evidence, a refusal when the evidence looks broken (an
  unreadable tileset registry makes every row look unused — that is a deployment to
  fix, not a licence to delete), a grace period so recent work is never touched, it may
  destroy only what nothing can reach (no tileset offers the id, no layout places it),
  and it may never keep the server from starting. The guards live in pure functions and are tested; nothing here waits
  for a human to read a report, because nobody is watching a boot.
- **The database holds no furniture at all any more.** Furniture used to be uploaded
  into it as pixels; art then moved into Tiled tilesets, and the rows of retired
  packages stayed behind — ids nobody could place, since a mapper only paints what a
  tileset offers, and not inert either: a row without a file has no image to point at,
  so it travelled as SpriteData in `furnitureAssetsLoaded` on every join (695 of them
  were 1.33 MB of a 1.79 MB message). The boot pruned those, and kept the rows a
  tileset still carried, because those were live overrides.
  That whole shape is gone: `furniture` is **not an ASSET_TYPE**, no client can write
  one (the editor offers characters and pets only), and nothing merges one over a
  tileset entry. What is left of it is one boot task that retires the remaining rows
  (`maintenance/retireFurniture.ts`) — unreachable by construction rather than by
  inference, so it needs no grace period, but it writes a copy beside the database
  first, because a row a tileset still carries had been overriding that art until this
  build and that may be somebody's work. The report tells the two groups apart, since
  "retired 40 rows" does not say whether a map just changed.
  The one question that outlived the prune is asked directly now: a stored map that
  places an id **no tileset offers** is a map to re-author and nothing can repair it
  automatically, so `report-unavailable-placements` compares the layouts against the
  tilesets and says nothing on a healthy world (measured: 1775 offered, 127 placed, 0
  missing). `scripts/prune-orphan-assets.sh` remains for the other prune — personal
  avatars whose account is gone.
- **One database, opened by more than one process.** All state lives in `pixel.db` through the
  shared `db.ts` connection — and the server is not the only thing that opens it: every
  maintenance script does (`prune-orphan-assets`, `repack-art`, a zone push), usually while a
  server is running. So the connection sets `busy_timeout = 5000` and `journal_mode = WAL`:
  importing `db.ts` WRITES (a `CREATE TABLE IF NOT EXISTS` for the migration bookkeeping), which
  takes SQLite's write lock, and without a timeout a second process gets
  `SQLITE_BUSY: database is locked` and dies while still importing. That is not theory — it is
  what made about one in eight parallel test runs fail with a bare "test failed", no assertion,
  a different file each time (whoever lost the race), and it took the TAP reporter to see the
  stack. WAL costs the two sidecar files (`-wal`, `-shm`) next to `pixel.db`: a BACKUP must
  therefore be `VACUUM INTO` (which is what `worldReset` and the prune script already do) rather
  than a file copy, since copying `pixel.db` alone would lose whatever is still in the log.
  **Tests never open it.** `server/test-data-dir.mjs` is loaded with `--import`, so every test
  child gets its own temp data directory before any module can open a database — a suite has no
  business touching the world a developer is standing in, least of all one that runs a migration
  on import and honours `PIXEL_RESET_WORLD`. A file that wants its own directory still sets it
  itself; `dbIsolation.int.test.ts` asserts both halves and fails without the setup.
- **Fifteen tables from a pre-fork database are dropped at boot**
  (`schema/dropRetiredTables.ts`): eight `voxel_*` plus `portals` from a voxel world
  that is gone, `dm_keys`/`dm_messages` from a Matrix-side store, `monitor_locks`,
  `arcade_wads`, `zone_customers`, and `zone_meta` (whose only callers were two private
  methods nobody called). They were referenced by **no file of any type** in this repo,
  and — the fact that settled it — **no code creates them**: they arrived with a
  database adopted from the older layout (`migrateFromSplitDbs`, `dataBootstrap`), so a
  fresh deployment never had them. Two held personal data, which is why leaving them was
  not neutral: nothing deleted a row when the account went, because nothing knew they
  were there. Dropped on the dev world 2026-08-27, 37 rows in total.
  **A table needs two independent pieces of evidence to be dropped**, and the second is
  machine-checked: its name is on `RETIRED_TABLES` (a decision written down after
  searching the repo) *and* not on `LIVE_TABLES` (what this server creates, which
  `schemaTables.int.test.ts` rebuilds from the source's own `CREATE TABLE` statements
  and fails on any drift, in both directions). A table on **neither** list is reported
  and left alone — the unknown case must never resolve to "delete", or this becomes the
  way a future table disappears because nobody added it here.
  One deliberate exception to the house rule: **no `VACUUM INTO` snapshot is taken**
  first, unlike every other destructive step here. That was asked for explicitly, and it
  is the line to change if a deployment ever wants the drop to be undoable.
  The same file also removes four **keys** in `settings` that nothing reads
  (`RETIRED_SETTINGS`), and the reason is not the fourteen bytes: three of them are called
  `soundEnabled`, `alwaysShowLabels` and `alertVolume`, which are the names of live
  `ViewerSettings` fields — those are per-account rows in `user_prefs` now, and a global
  row that looks exactly like a live setting and is not one costs somebody an hour. The
  test asserts none of them reaches `getSetting`/`setSetting` and none is a constant's
  value, which are the only two ways this codebase names a key (checked by finding the
  live `voiceNs` and `arcadeDefaultGames` through those same two patterns).
- **Accounts:** users live in the `users` table keyed by a lowercase, immutable
  `user_id` (login id and agent-owner key) with a free display name, a scrypt
  password, an admin flag and a per-user agent token. Presenting
  `PIXEL_ADMIN_TOKEN` on the register screen makes that user an admin and creates
  the account if new — the only way to create a LOCAL user. **There is no
  anonymous mode**: every room and the feed require an account, so with no way to
  log in nobody can join at all, and the server binds to loopback rather than
  serving an ungated app to the network. Agents authenticate the feed with their
  owner's token.
- **Single sign-on is additive, never a replacement** (`server/src/oidc/`). An
  OpenID Connect provider (Zitadel) is a second way into an account, configured
  through `PIXEL_OIDC_*`; the admin token stays the break-glass path, because a
  provider that is down, renamed or misconfigured must not be able to lock every
  admin out of the world. Five rules hold it together, and each one is a decision
  rather than a detail:
  **The subject is the identity.** The account is keyed to the provider's
  immutable `sub` in `oauth_identities`, never to a username or an email — those
  are display facts their owner can change, and re-keying on one would either
  split an identity or merge two. A rename in the directory therefore keeps the
  same avatar, agent token, zone grants and position. The login id is *derived*
  (from `preferred_username`) for readability only, and a collision gets a suffix.
  **Adoption of an existing local account is a stated rule, not an accident.**
  `PIXEL_OIDC_CLAIM_EXISTING` (on by default) lets a first provider login take
  over the local account whose login id matches, which is what makes migrating an
  existing world painless — and it is a real trust statement about the directory,
  so it is a switch, and an account already linked to another subject is never
  adopted either way.
  **Every claim acted on came from the server's own exchange.** The code is
  redeemed and `userinfo` read by this server, over TLS, against endpoints the
  issuer's discovery document named on its own origin — which is what lets this
  work with no OIDC library and no JWT verification (OIDC §3.1.3.7). Nothing a
  browser carries decides anything: the browser holds an opaque `state`, and the
  callback additionally requires the cookie set when the flow started, so a
  callback URL cannot be used to log somebody's browser into this world.
  **The provider may own roles, but not the last admin.** With an admin role
  mapped (`PIXEL_OIDC_ADMIN_ROLE`, or the field in the panel) the directory grants
  and revokes admin on every login; revoking the last *usable* admin is refused and
  logged, because the fix for that mistake would need the very admin panel it just
  closed. **Roles are read from the ID token AND from userinfo**, and from any
  claim matching Zitadel's project-roles URN as well as the configured name —
  because which of those a token carries depends on provider settings this server
  cannot see, and reading userinfo alone (as it did at first) made a correctly
  configured directory look like it was sending no roles at all. `groups` and a
  bare `roles` are deliberately NOT consulted: a directory fills those with things
  that are not authorization for this world. Every login logs the role names it
  saw, because "the role is not arriving" and "the role arrived and nothing
  changed" are indistinguishable from the outside and the first is what costs an
  afternoon.
  **A provisioned account has no password** (`createProvisionedUser`) rather than
  a random one — a credential that exists is a credential that can be attacked,
  and `/login` refuses a row with no hash outright.
  Flows and desktop pairings live in memory with a TTL, a cap and a delete on use
  (`oidc/pending.ts`): the desktop app cannot follow a redirect (no cookie jar,
  and an embedded webview is the wrong place for MFA), so it opens the system
  browser and polls for a bearer that is handed over exactly once.
  **Connecting an account that already exists is a deliberate act, and it ends in
  a confirmation.** Settings → the provider block starts a flow whose target
  account is taken from the SESSION and kept server-side (`PendingFlow.linkUserId`),
  so a callback can never redirect a link onto somebody else. That is not enough on
  its own, and the second half is the part to keep: whoever starts a flow can hand
  its authorize URL to somebody ELSE, and if that person authenticates, their
  directory identity would attach to the starter's account — login CSRF, aimed at
  the link instead of the session. So the exchange stops one step short and the page
  it lands on NAMES BOTH identities and asks; nothing is written until that POST
  arrives carrying a one-time token only that page has. The confirmation is
  authorized by the token alone, deliberately, because it may be submitted from a
  system browser that has no session with this server at all. Three refusals go with
  it — a subject that already signs in as another account, a second identity on an
  account that already has one, and disconnecting when the provider is the account's
  ONLY way in (`hasPassword` is false, so removing the link would lock its owner out
  of a world they can still see).
- **Single sign-on is configured in two halves, and where a field lives is a
  security decision** (`oidc/adminSettings.ts`, admin panel → Sign-in,
  `GET`/`PUT /admin/oidc`). A new field goes on one side or the other; adding one
  without deciding which is the mistake this bullet exists to prevent.
  **Writable from the panel** are the presentation (button label, whether the
  button is offered, whether an ungated navigation goes straight to the provider)
  and — asked for explicitly, so the deployment is not the only way to point this
  world at a directory — the **request this server makes**: issuer, client id,
  redirect URI, scopes, and the **admin role**. That last one looks like the field
  to lock hardest and is not: an admin session can already promote anyone through
  `PATCH /admin/users/:id`, so keeping it in the environment protected almost
  nothing and cost a redeploy every time a directory named its role differently
  than the deployment guessed. What it adds over a manual promotion is automation,
  so it is audited like the rest, and `syncAdminRole` still refuses to revoke the
  last usable admin. A
  server whose environment names no provider can therefore be switched on entirely
  from the panel, which is why `registerOidcAuth` mounts the routes whenever login
  is possible and they answer 404 until a connection exists, and why the effective
  config is merged per request (`oidcConfig()`) instead of memoized.
  **Environment-only** are the client secret, the roles CLAIM (which claim carries
  the roles — a wire detail, not a policy), `CLAIM_EXISTING` and `END_SESSION` —
  the last two decide whose existing local account a directory username may take
  over.
  **Scopes are the sharp one of the writable set, and the panel says so beside the
  field.** They decide which CLAIMS come back, and the roles claim is what
  `PIXEL_OIDC_ADMIN_ROLE` reads — so removing the scope that carries it (in Zitadel,
  the project's role assertion or its `…:aud` scope) makes the next sign-in report a
  user with no roles, which is indistinguishable from a user who lost them and
  therefore revokes admin from everyone but the last usable one. Nothing in the code
  can tell those two apart, so nothing tries to; the consequence is written where it
  is read instead. `openid` is forced on whichever side the scopes come from, and
  each token is checked against RFC 6749's grammar because the string is written
  into the authorize URL.
  Three rules make the editable connection safe enough to ship, and all three are
  tested rather than described:
  **An overridden issuer or client id withholds the secret** — and only those two,
  because they are the identity the secret was issued for, where scopes and the
  redirect URI change what is asked and where the answer lands. `oidcConfig()` drops
  `PIXEL_OIDC_CLIENT_SECRET` the moment either half of that identity is overridden, so pointing the issuer at a server you control and waiting for
  the next login cannot POST the deployment's secret to it. An overridden
  connection is a public client (PKCE only) and the panel says so on the page.
  **Every value is validated where it is stored, on write AND on read.** https
  unless the host is loopback, no query or fragment (the discovery URL is built by
  appending), the redirect URI's path exactly `/auth/oauth/callback` (the route this
  server actually serves — the HOST is deliberately not checked, because behind a
  proxy this process cannot know it, and it need not be: a provider only redirects
  to a URI registered with it). A refusal refuses the WHOLE patch, so half a
  connection — a new issuer with the old client id — is never what a mistake leaves
  behind. Re-validating on read is not belt-and-braces: the row is a JSON blob a
  restore or a hand-edit can reach, and it ends up in a URL credentials travel to.
  **A connection change is logged with the account that made it.** Which directory
  the world trusts is now something a session can change, so it is auditable; the
  line carries the issuer and client id (a browser sees both in the authorize URL)
  and never the secret.
  Two older invariants still hold: each setter reads its fields BY NAME, so an
  unknown key has nowhere to go rather than being checked against a deny-list
  somebody has to maintain; and `/login` keeps rendering the password form even
  with the redirect on, so the break-glass path stays one URL away rather than one
  deployment away.
- **Shell scripts are the front door.** Anything a human runs is a `.sh` in
  `scripts/`, and *what* it starts — node, tsx, anything — is the wrapper's
  business, not the caller's. Never put `node --import tsx scripts/….mts` in docs,
  a README or a CI step. A new human-facing script gets its wrapper in the same
  change, with its usage in the header comment (`scripts/push-zones.sh` is the
  house style). Data — configs, fixtures — does not belong in `scripts/`; it lives
  under `assets/`.
- **Commits:** imperative, no `Co-Authored-By` or AI trailer. Don't commit or push
  without being asked. Prefer a few meaningful commits over micro-commits, and
  never leave debug scaffolding behind.

## Before you ship

- **Run the `mmo-readiness` skill** (`.claude/skills/mmo-readiness/`): typecheck +
  build, no behaviour-tree or server-only code in `client/dist`, no second game
  engine, every `onMessage` handler guarded, the entity/zone/portal invariants —
  and the **security section**, which checks the gates rather than listing them:
  every HTTP route gated or explicitly public, no handler acting on a
  payload-supplied identity, meeting tokens only for members, chat attributed and
  bounded, no secret in a client payload — and the **memory section**, which
  requires the release next to the acquisition: per-connection Maps deleted from,
  bus subscriptions balanced, timers cleared or unref'd, blob URLs revoked,
  textures removed, synced entries deleted, and every deliberate cache naming its
  bound. Treat its failures as blockers.
- `pnpm -r run check-types` and `pnpm build` must be clean.
- If you touched furniture properties:
  `scripts/sync-furniture-properties.sh --check` must report zero changes. It edits a
  MAP in place (`scripts/lib/jsonEdit.mts`) rather than re-serializing it: a `.tmj` is
  written by Tiled, so rewriting one turned a single added field into a 25 000-line
  diff and the next save in Tiled produced the reverse. Tilesets are ours and are
  re-serialized normally.
- If you added, removed or repainted collection art:
  `scripts/bake-atlas.sh --check` must pass (the server would bake it anyway, but
  the committed artifact is what a deployment starts from).
- If you changed the layout format: bump `OfficeLayout.version`, migrate in
  `migrateLayout`, and make sure a migration that cannot be completed is **not
  persisted** — an incomplete one replaced a real map with 3192 holes once, and the
  only reason it was recoverable is that maps live in git as `.tmj`.
  One exception, and it is narrow: an **optional field that an older client ignores
  without misreading anything** is not a format change in this sense. The client
  accepts version 3 and nothing else on purpose (`client/src/net/bridge.ts`, because a
  v1 ground cell holds a pattern where a v2 one holds a tile id), so a bump blacks out
  every shipped desktop build until it updates — and it ships its own bundle with no
  auto-updater. `tileFlip` is the case that earned this sentence: an old client draws
  the cell unmirrored, i.e. exactly what it drew before. A change where an old client
  would draw the WRONG thing still bumps the layout version *and* `PROTOCOL_VERSION`.
- If you touched the server: `cd server && pnpm test`. If you touched the desktop
  Mumble protocol: `cd desktop && pnpm test`.
- For engine changes, drive `OfficeState` directly in a small headless test, plus
  a run with `MOCK=N`. For client changes, sanity-check the Electron shell too —
  especially URLs, fetches, auth and navigation.
- Keep the client a renderer; keep logic in `shared` on the server.

## Claude Code — persistent memory

Conversation memory lives in **`.claude/memory/`** inside this repo (gitignored).
The home directory (`~/.claude/`) is ephemeral and may be wiped on rebuild; the
repo directory persists. Read it at the start of a session.
