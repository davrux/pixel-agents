/**
 * Server-only NPC "brain": a mistreevous behaviour tree + blackboard that decides
 * an NPC's next high-level action each tick. The shared engine stays the
 * actuator (executes movement/animation from synced state); only this decision
 * logic lives here, so the BT library never enters the client bundle.
 *
 * N3.1 introduces the harness and reproduces the pet FSM's idle decision
 * (lifespan → despawn, tired → sit, ready → wander, else idle). Wiring it into
 * the live pet sim, plus affordances/interactions, follow in N3.2/N3.3.
 */
import { BehaviourTree, State } from 'mistreevous';

export type NpcAction = 'despawn' | 'sit' | 'wander' | 'idle';

/** Inputs the brain reads to decide. Mirrors the pet FSM's situation flags. */
export interface NpcBlackboard {
  /** Lifespan elapsed → retire. */
  lifeOver: boolean;
  /** Wandered enough this cycle → go rest (sit). */
  restNeeded: boolean;
  /** Wander pause elapsed → move to a new spot. */
  readyToMove: boolean;
}

/** Priority selector: despawn > sit > wander > idle. Each leaf records the
 *  chosen action on the blackboard. */
const TREE_DEFINITION = `root {
  selector {
    sequence {
      condition [LifeOver]
      action [Despawn]
    }
    sequence {
      condition [RestNeeded]
      action [Sit]
    }
    sequence {
      condition [ReadyToMove]
      action [Wander]
    }
    action [Idle]
  }
}`;

export class NpcBrain {
  private readonly bb: NpcBlackboard & { action: NpcAction } = {
    lifeOver: false,
    restNeeded: false,
    readyToMove: false,
    action: 'idle',
  };
  private readonly tree: BehaviourTree;

  constructor() {
    const agent = {
      LifeOver: (): boolean => this.bb.lifeOver,
      RestNeeded: (): boolean => this.bb.restNeeded,
      ReadyToMove: (): boolean => this.bb.readyToMove,
      Despawn: (): State => this.set('despawn'),
      Sit: (): State => this.set('sit'),
      Wander: (): State => this.set('wander'),
      Idle: (): State => this.set('idle'),
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
    this.bb.lifeOver = input.lifeOver;
    this.bb.restNeeded = input.restNeeded;
    this.bb.readyToMove = input.readyToMove;
    this.bb.action = 'idle';
    this.tree.step();
    return this.bb.action;
  }
}
