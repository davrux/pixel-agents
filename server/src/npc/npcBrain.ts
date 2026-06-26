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

export type NpcAction = 'wander' | 'sit';

/** Inputs the brain reads to decide what to do after an idle pause. */
export interface NpcBlackboard {
  /** Would rather rest now (computed by the caller, e.g. a sit-chance roll). */
  wantsToRest: boolean;
}

/** Priority selector: rest if wanted, else wander. */
const TREE_DEFINITION = `root {
  selector {
    sequence {
      condition [WantsToRest]
      action [Sit]
    }
    action [Wander]
  }
}`;

export class NpcBrain {
  private readonly bb: NpcBlackboard & { action: NpcAction } = {
    wantsToRest: false,
    action: 'wander',
  };
  private readonly tree: BehaviourTree;

  constructor() {
    const agent = {
      WantsToRest: (): boolean => this.bb.wantsToRest,
      Sit: (): State => this.set('sit'),
      Wander: (): State => this.set('wander'),
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
    this.bb.action = 'wander';
    this.tree.step();
    return this.bb.action;
  }
}
