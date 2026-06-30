# Refactor: character skins keyed by stable string IDs (branch `skin-ids`)

## Why
Today a character skin is identified by its **array position** (`Character.palette: number`,
synced as `uint8`, persisted as a number). User-added skins are appended; deletes/reorders
shift positions, and `buildMerged` could silently drop higher indices (the "max chars" bug).
Make the **identity stable**: each skin has an immutable string id; position stops mattering.

## Target model
- A skin id is a string. Bundled skins keep their file-derived ids `char_0 … char_5`; the DB
  override names (`char_<n>`) **become the ids verbatim** (no rename, no data migration of the
  asset rows). New skins get `char_<maxN+1>` (ids are never reused).
- Templates live in an **ordered id-keyed store** (Map<string, LoadedCharacterData>) instead of a
  bare array. Lookups (`getCharacterSprites/Size/PosePlaybackLength`) take an id.
- `Character.palette: number` → **`Character.skin: string`**; `CharacterSync.palette: uint8` →
  **`skin: string`**. (`LoadedCharacterData.palette` — the pixel colour map — is unrelated and
  stays.)
- Prefs (`charPrefs`, `playerPrefs`) become `Record<string,string>` (skin id). **Migration:** a
  stored number `N` → `"char_N"` (since the old index N always named `char_N`).
- `pickDiversePalette` → `pickDiverseSkin` (count usage per known id, pick least-used). Subagents
  inherit the parent's skin id. `dropInvalidPalettes(count)` → `dropInvalidSkins(validIds)`.
- Messages: `setCharacter`/`setPlayerCharacter` carry `skin: string`; `viewerIdentity` carries
  `characterSkin`/`playerSkin`; `characterSpritesLoaded` carries an ordered `[{id,data}]` list +
  `bundledIds` (replaces `defaultCount`). Editor/swatches key off ids.
- Client localStorage `pa-viewer-char`/`pa-player-char` store the id string (old numeric values
  migrate to `char_<n>` on read).

## Stages (typecheck after each)
1. **shared/sprites** — id-keyed template store + id-based accessors; keep an internal index only
   where the colorize cache needs one.
2. **shared/engine** — `Character.skin`; officeState skin prefs/picker/subagent/`setCharacterSkin`.
3. **shared/schema** — `CharacterSync.skin: string`.
4. **server** — assetOverrides id-keyed (drop positional `place` for characters; emit `[{id,data}]`
   + `bundledIds`); appStore prefs as strings + number→id migration; SimRoom messages/validation.
5. **client** — OfficeScene skin state + swatches + editor (`CharacterEditor` create/delete/nameOf
   by id); renderer.
6. **verify** — per-package tsc + vite + mmo-readiness gate; manual: pick skins, add/delete several,
   confirm persistence + player/agent skins survive a reload, and the "max chars" bug is gone.

## Notes / risks
- Wire change (`uint8`→`string`) + persistence migration → not pushed until verified.
- NPC roster (`kind_variant`) is already id-like and separate — out of scope.
- `char_N.png` bundled file naming is unchanged (it only seeds the bundled ids).
