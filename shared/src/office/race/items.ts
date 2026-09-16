/**
 * What a driver can pick up and what it does — one table, the way every other "kinds of thing" in
 * this world is one table (`APPLIANCES`, `CHASES`, `WARP_STYLES`).
 *
 * A kart holds AT MOST ONE item, and that single rule is what let the whole feature arrive without
 * a box state on the wire: a box hands you something only if your hands are empty, so a box never
 * has to be empty itself. The alternative — boxes that deplete and recharge — needs a synced flag
 * per box per zone, and it buys a fairness nobody asked for; what it would actually produce is a
 * viewer drawing a full box that is not there.
 *
 * Three items, and the set was chosen for what it does NOT need:
 *
 *  - `boost` is the pads' own effect, reached from the driver's seat instead of from a place on
 *    the road. Nothing new: `Kart.boostMs` already exists and already carries past the pad.
 *  - `shield` is a flag with a clock. It turns off what happens TO you — being shoved, and
 *    spinning on somebody's oil — rather than adding a power, which is what keeps it from being
 *    strictly better than the other two.
 *  - `oil` is the only one that leaves anything behind, and it leaves a CELL rather than a moving
 *    object. A homing shell was the obvious fourth and is deliberately not here: a projectile is a
 *    new moving entity with its own tick and its own synced collection, and that is a feature of
 *    its own rather than a row in this table.
 *
 * The ids are the wire, so this list is APPEND-ONLY and `KartItem.None` stays 0 — the same
 * deny-by-default zero as `ControllerKind.NONE`, so a kart nobody has given anything to is holding
 * nothing rather than holding the first row of a table.
 */

/** What a kart is holding. 0 is nothing, and the order IS the wire. */
export enum KartItem {
  None = 0,
  Boost = 1,
  Shield = 2,
  Oil = 3,
}

export interface KartItemSpec {
  kind: KartItem;
  /** What the HUD calls it. */
  label: string;
  /** What the HUD draws. One glyph, because the slot is a slot and not a sentence. */
  glyph: string;
}

export const KART_ITEMS: readonly KartItemSpec[] = [
  { kind: KartItem.Boost, label: 'Boost', glyph: '⏩' },
  { kind: KartItem.Shield, label: 'Shield', glyph: '🛡' },
  { kind: KartItem.Oil, label: 'Oil', glyph: '🛢' },
];

/** The spec for a kind, or null for `None` and for anything this build does not know. */
export function kartItem(kind: number): KartItemSpec | null {
  return KART_ITEMS.find((i) => i.kind === kind) ?? null;
}

/**
 * Which item a box hands out, from a number in [0, 1).
 *
 * Uniform over the table, deliberately: the classic of this genre weights the draw by position, so
 * the car at the back gets the strong things — and that is a decision about FAIRNESS which needs a
 * running order, an opinion about what "strong" means, and somebody to complain to. Uniform is the
 * honest starting point, and weighting it later is a change to this one function.
 */
export function drawItem(roll: number): KartItem {
  const at = Math.min(KART_ITEMS.length - 1, Math.max(0, Math.floor(roll * KART_ITEMS.length)));
  return KART_ITEMS[at].kind;
}
