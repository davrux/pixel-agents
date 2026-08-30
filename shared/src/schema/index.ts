// PawnSync is deliberately NOT re-exported: it is the base every synced pawn extends, and that
// happens inside officeSync.ts. Nothing outside ever needs the base itself — it was exported (as
// EntitySync) with no importer for as long as it existed, and an export nobody consumes is a
// surface that has to be kept working for nobody. `mmo-readiness` checks the inheritance in
// officeSync.ts directly, which is where the rule actually lives.
export { RoomState, CharacterSync, PetSync, FurnitureSync } from './officeSync.js';
