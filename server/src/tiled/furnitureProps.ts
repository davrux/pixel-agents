/**
 * The furniture behaviour properties, defined once.
 *
 * Three readers share this file, and they have to agree exactly or a mapper's
 * edit silently means something different depending on who looks at it:
 *   - tiledFurniture.ts reads them off a FurnitureTile → the catalog default
 *   - mapBridge.ts reads/writes them on a FurnitureObject → the instance override
 *   - server/scripts/sync-furniture-properties.mts stamps the full set, defaults
 *     included, onto every tile in every furniture tileset
 *
 * Same reasoning as actionProps.ts next door: a tile's own value and a placed
 * instance's override go through one definition and one parser.
 *
 * ── Why tiles carry every property and objects only their overrides ──
 *
 * Every FurnitureTile spells out all of these, defaults included, so that
 * opening a tile in Tiled shows the whole set of things it could do. Nothing
 * has to be remembered and added by hand — a property you must know to add is
 * a property you will forget, and a missing `canSitOn` is indistinguishable
 * from a deliberate "no".
 *
 * A FurnitureObject deliberately does the opposite and carries only what it
 * actually overrides, because here absence is the data: it means "whatever this
 * type says". Writing `canSitOn: false` onto every placement of a sittable
 * chair, just to be thorough, would turn every chair in the map unsittable on
 * the next import — a bool has two states and this question has three.
 *
 * What makes the full set VISIBLE on a placement is not the file but the
 * object's class: Tiled offers a class's members to any object carrying it,
 * whether or not the file lists them. That is also why a placement dragged
 * straight from the Tilesets panel shows nothing — Tiled gives it no class at
 * all — and why sync-furniture-properties.mts stamps `FurnitureObject` onto
 * those. Keep this class's member list in Pixels.tiled-project a superset of
 * FurnitureTile's (bar `label`, whose instance counterpart is `name`), or a
 * property becomes settable on the type and invisible on the placement.
 */
import { Direction } from '@pixel/shared/office/types.js';
import type { PlacedFurniture } from '@pixel/shared/office/types.js';
import { prop, type PropBag, type TiledProp } from './actionProps.js';

/** Compass letters, as authored in Tiled (see the SitFacing enum in
 *  Pixels.tiled-project) — the engine's Direction is a number, which is no use
 *  in a dropdown. '' means "unset". */
const SIT_FACING: Record<string, Direction> = {
  N: Direction.UP,
  E: Direction.RIGHT,
  S: Direction.DOWN,
  W: Direction.LEFT,
};

const SIT_FACING_LETTER = new Map<Direction, string>(Object.entries(SIT_FACING).map(([letter, dir]) => [dir, letter]));

export function sitFacingFromLetter(value: unknown): Direction | undefined {
  return typeof value === 'string' && value in SIT_FACING ? SIT_FACING[value] : undefined;
}

export function sitFacingLetter(dir: Direction | undefined): string {
  return dir === undefined ? '' : (SIT_FACING_LETTER.get(dir) ?? '');
}

/**
 * Every behaviour property a FurnitureTile carries, with the value that means
 * "behaves like the plainest possible object". The sync script writes exactly
 * this list — adding a property here and re-running it is the whole procedure
 * for introducing one.
 *
 * `propertyType` names an enum from Pixels.tiled-project so Tiled offers a
 * dropdown instead of a free-text field.
 */
export const FURNITURE_TILE_PROPS: ReadonlyArray<{
  name: string;
  default: string | number | boolean;
  propertyType?: string;
}> = [
  { name: 'label', default: '' },
  { name: 'canSitOn', default: false },
  { name: 'sitFacing', default: '', propertyType: 'SitFacing' },
  { name: 'petCanSitOn', default: false },
  { name: 'backgroundTiles', default: 0 },
  { name: 'onState', default: '' },
  { name: 'actionKind', default: '', propertyType: 'ActionKind' },
  { name: 'actionVideo', default: false },
  { name: 'actionUrl', default: '' },
  { name: 'actionPose', default: '', propertyType: 'ApplianceKind' },
];

/** The behaviour a FurnitureTile declares — the catalog default for every
 *  placement of it. Absent/empty values are simply left out, so the catalog
 *  entry itself stays sparse and the resolve* helpers' `??` chains work. */
export function furnitureBehaviourFromTile(props: PropBag): {
  canSitOn?: boolean;
  sitFacing?: Direction;
  petCanSitOn?: boolean;
  backgroundTiles?: number;
  onState?: string;
} {
  const sitFacing = sitFacingFromLetter(props.sitFacing);
  return {
    ...(props.canSitOn === true ? { canSitOn: true } : {}),
    ...(sitFacing !== undefined ? { sitFacing } : {}),
    ...(props.petCanSitOn === true ? { petCanSitOn: true } : {}),
    ...(typeof props.backgroundTiles === 'number' && props.backgroundTiles > 0 ? { backgroundTiles: props.backgroundTiles } : {}),
    ...(typeof props.onState === 'string' && props.onState ? { onState: props.onState } : {}),
  };
}

/**
 * A placed object's own overrides — only the properties it actually carries.
 *
 * Booleans are read as present-or-not rather than true-or-false: a bool
 * property Tiled wrote onto this object means the mapper touched it there, so
 * both `true` and `false` are real answers, while an absent one inherits.
 */
export function furnitureBehaviourFromObject(props: PropBag): Partial<PlacedFurniture> {
  const sitFacing = sitFacingFromLetter(props.sitFacing);
  return {
    ...(typeof props.canSitOn === 'boolean' ? { canSitOn: props.canSitOn } : {}),
    ...(sitFacing !== undefined ? { sitFacing } : {}),
    ...(typeof props.petCanSitOn === 'boolean' ? { petCanSitOn: props.petCanSitOn } : {}),
    ...(typeof props.backgroundTiles === 'number' ? { backgroundTiles: props.backgroundTiles } : {}),
    ...(typeof props.onState === 'string' && props.onState ? { onState: props.onState } : {}),
  };
}

/** The Tiled properties for a placed object's overrides — see this file's
 *  header for why this one emits nothing when nothing is overridden. */
export function furnitureBehaviourProps(item: PlacedFurniture): TiledProp[] {
  const out: TiledProp[] = [];
  if (item.canSitOn !== undefined) out.push(prop('canSitOn', item.canSitOn));
  if (item.sitFacing !== undefined) out.push(prop('sitFacing', sitFacingLetter(item.sitFacing), 'SitFacing'));
  if (item.petCanSitOn !== undefined) out.push(prop('petCanSitOn', item.petCanSitOn));
  if (item.backgroundTiles !== undefined) out.push(prop('backgroundTiles', item.backgroundTiles));
  if (item.onState !== undefined) out.push(prop('onState', item.onState));
  return out;
}
