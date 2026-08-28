/**
 * Server-only pet "brain": a mistreevous behaviour tree + blackboard that decides
 * a pet's next high-level action. The shared engine stays the actuator (executes
 * movement/animation from synced state); only this decision logic lives here, so
 * the BT library never enters the client bundle.
 *
 * N3.2: the brain drives the pet's idle decision (sit vs wander) via an injected
 * decider on OfficeState — behaviour-preserving. N3.3 extends the blackboard +
 * tree with affordances (coffee / agent / cat) and richer actions.
 */
import { BehaviourTree, State } from 'mistreevous';
import type { PetAction, PetAffordances } from '@pixel/shared/office/engine/pets.js';

/** Inputs the brain reads to decide what to do after an idle pause: the pet's
 *  drives plus the world affordances OfficeState reports. */
export interface PetBlackboard extends PetAffordances {
  /** Would rather rest now (computed by the caller, e.g. a sit-chance roll). */
  wantsToRest: boolean;
  /** Fancies a coffee now (computed by the caller, e.g. a drink-chance roll). */
  wantsCoffee: boolean;
  /** Fancies a chat now (computed by the caller, e.g. a talk-chance roll). */
  wantsTalk: boolean;
}

/**
 * Priority selector: flee an approaching dog first (cats), else chase a nearby
 * cat (dogs), else go for coffee, else go chat with an agent, else rest, else
 * wander — each "want" gated by its matching affordance. The affordances are
 * already kind-gated by OfficeState (only cats are ever `threatened`, only dogs
 * `canChase`), so one tree covers every pet.
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
      condition [WantsTalk]
      condition [CanTalk]
      action [Talk]
    }
    sequence {
      condition [WantsToRest]
      condition [CanRest]
      action [Sit]
    }
    action [Wander]
  }
}`;

export class PetBrain {
  private readonly bb: PetBlackboard & { action: PetAction } = {
    wantsToRest: false,
    wantsCoffee: false,
    wantsTalk: false,
    canRest: false,
    canChase: false,
    threatened: false,
    canDrink: false,
    canTalk: false,
    action: 'wander',
  };
  private readonly tree: BehaviourTree;

  constructor() {
    const agent = {
      WantsToRest: (): boolean => this.bb.wantsToRest,
      WantsCoffee: (): boolean => this.bb.wantsCoffee,
      WantsTalk: (): boolean => this.bb.wantsTalk,
      CanRest: (): boolean => this.bb.canRest,
      CanChase: (): boolean => this.bb.canChase,
      Threatened: (): boolean => this.bb.threatened,
      CanDrink: (): boolean => this.bb.canDrink,
      CanTalk: (): boolean => this.bb.canTalk,
      Sit: (): State => this.set('sit'),
      Wander: (): State => this.set('wander'),
      Chase: (): State => this.set('chase'),
      Flee: (): State => this.set('flee'),
      Drink: (): State => this.set('drink'),
      Talk: (): State => this.set('talk'),
    };
    this.tree = new BehaviourTree(TREE_DEFINITION, agent);
  }

  private set(action: PetAction): State {
    this.bb.action = action;
    return State.SUCCEEDED;
  }

  /** Evaluate the tree against the given situation and return the chosen action. */
  decide(input: PetBlackboard): PetAction {
    this.tree.reset(); // re-evaluate from the root every tick
    this.bb.wantsToRest = input.wantsToRest;
    this.bb.wantsCoffee = input.wantsCoffee;
    this.bb.wantsTalk = input.wantsTalk;
    this.bb.canRest = input.canRest;
    this.bb.canChase = input.canChase;
    this.bb.threatened = input.threatened;
    this.bb.canDrink = input.canDrink;
    this.bb.canTalk = input.canTalk;
    this.bb.action = 'wander';
    this.tree.step();
    return this.bb.action;
  }
}
