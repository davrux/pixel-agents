/**
 * Server-only NPC "brain": a mistreevous behaviour tree + blackboard that decides
 * an NPC's next high-level action. The shared engine stays the actuator (executes
 * movement/animation from synced state); only this decision logic lives here, so
 * the BT library never enters the client bundle.
 *
 * N3.2: the brain drives the pet's idle decision (sit vs wander) via an injected
 * decider on OfficeState — behaviour-preserving. N3.3 extends the blackboard +
 * tree with affordances (coffee / agent / cat) and richer actions.
 */
import { BehaviourTree, State } from 'mistreevous';
import type { NpcAction, NpcAffordances } from '@pixel/shared/office/engine/pets.js';

/** Inputs the brain reads to decide what to do after an idle pause: the NPC's
 *  drives plus the world affordances OfficeState reports. */
export interface NpcBlackboard extends NpcAffordances {
  /** Would rather rest now (computed by the caller, e.g. a sit-chance roll). */
  wantsToRest: boolean;
  /** Fancies a coffee now (computed by the caller, e.g. a drink-chance roll). */
  wantsCoffee: boolean;
}

/**
 * Priority selector: flee an approaching dog first (cats), else chase a nearby
 * cat (dogs), else go for coffee if wanted and a station is free, else rest if
 * wanted and somewhere to rest exists, else wander. The affordances are already
 * kind-gated by OfficeState (only cats are ever `threatened`, only dogs
 * `canChase`), so one tree covers every NPC.
 */
const TREE_DEFINITION = `root {
  selector {
    sequence {
      condition [Threatened]
      action [Flee]
    }
    sequence {
      condition [CanChase]
      action [Chase]
    }
    sequence {
      condition [WantsCoffee]
      condition [CanDrink]
      action [Drink]
    }
    sequence {
      condition [WantsToRest]
      condition [CanRest]
      action [Sit]
    }
    action [Wander]
  }
}`;

export class NpcBrain {
  private readonly bb: NpcBlackboard & { action: NpcAction } = {
    wantsToRest: false,
    wantsCoffee: false,
    canRest: false,
    canChase: false,
    threatened: false,
    canDrink: false,
    action: 'wander',
  };
  private readonly tree: BehaviourTree;

  constructor() {
    const agent = {
      WantsToRest: (): boolean => this.bb.wantsToRest,
      WantsCoffee: (): boolean => this.bb.wantsCoffee,
      CanRest: (): boolean => this.bb.canRest,
      CanChase: (): boolean => this.bb.canChase,
      Threatened: (): boolean => this.bb.threatened,
      CanDrink: (): boolean => this.bb.canDrink,
      Sit: (): State => this.set('sit'),
      Wander: (): State => this.set('wander'),
      Chase: (): State => this.set('chase'),
      Flee: (): State => this.set('flee'),
      Drink: (): State => this.set('drink'),
    };
    this.tree = new BehaviourTree(TREE_DEFINITION, agent);
  }

  private set(action: NpcAction): State {
    this.bb.action = action;
    return State.SUCCEEDED;
  }

  /** Evaluate the tree against the given situation and return the chosen action. */
  decide(input: NpcBlackboard): NpcAction {
    this.tree.reset(); // re-evaluate from the root every tick
    this.bb.wantsToRest = input.wantsToRest;
    this.bb.wantsCoffee = input.wantsCoffee;
    this.bb.canRest = input.canRest;
    this.bb.canChase = input.canChase;
    this.bb.threatened = input.threatened;
    this.bb.canDrink = input.canDrink;
    this.bb.action = 'wander';
    this.tree.step();
    return this.bb.action;
  }
}
