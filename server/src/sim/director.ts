import { EventEmitter } from 'node:events';

import type { AgentEvent } from '@pixel/shared';

/** Logical state of one (top-level) agent, kept so late-joining viewers can be
 *  brought up to date. Sub-agents are a pure client-side concern (the client's
 *  office engine spawns them from subagent* messages). */
export interface AgentInfo {
  id: number;
  label: string;
  status: 'active' | 'waiting';
  teamName: string;
  agentName: string;
  isTeamLead: boolean;
  leadId: number | null;
  inputTokens: number;
  outputTokens: number;
  /** active toolId → { status, toolName } for replay on join. */
  activeTools: Map<string, { status: string; toolName?: string }>;
  permission: boolean;
}

/**
 * Building-agnostic registry of agents that also forwards every AgentEvent
 * verbatim. Ingest sources (feed, mock) call apply(); the Colyseus room
 * subscribes to 'event' and translates each to the original wire protocol, and
 * uses the registry to replay state to viewers that connect later.
 */
export class AgentDirector extends EventEmitter {
  private readonly agents = new Map<number, AgentInfo>();

  get(id: number): AgentInfo | undefined {
    return this.agents.get(id);
  }
  snapshot(): AgentInfo[] {
    return [...this.agents.values()];
  }

  apply(ev: AgentEvent): void {
    this.updateRegistry(ev);
    this.emit('event', ev);
  }

  private updateRegistry(ev: AgentEvent): void {
    switch (ev.t) {
      case 'created':
        if (!this.agents.has(ev.id)) {
          this.agents.set(ev.id, {
            id: ev.id,
            label: ev.label ?? `agent ${ev.id}`,
            status: 'waiting',
            teamName: '',
            agentName: '',
            isTeamLead: false,
            leadId: null,
            inputTokens: 0,
            outputTokens: 0,
            activeTools: new Map(),
            permission: false,
          });
        }
        break;
      case 'removed':
        this.agents.delete(ev.id);
        break;
      case 'status': {
        // The registry only tracks active vs not (idle replays as 'waiting').
        const a = this.agents.get(ev.id);
        if (a) a.status = ev.status === 'active' ? 'active' : 'waiting';
        break;
      }
      case 'toolStart': {
        const a = this.agents.get(ev.id);
        if (a) {
          a.activeTools.set(ev.toolId, { status: ev.status, toolName: ev.toolName });
          a.status = 'active';
        }
        break;
      }
      case 'toolDone': {
        this.agents.get(ev.id)?.activeTools.delete(ev.toolId);
        break;
      }
      case 'toolsClear': {
        this.agents.get(ev.id)?.activeTools.clear();
        break;
      }
      case 'permission': {
        const a = this.agents.get(ev.id);
        if (a) a.permission = true;
        break;
      }
      case 'permissionClear': {
        const a = this.agents.get(ev.id);
        if (a) a.permission = false;
        break;
      }
      case 'team': {
        const a = this.agents.get(ev.id);
        if (a) {
          a.teamName = ev.teamName ?? '';
          a.agentName = ev.agentName ?? '';
          a.isTeamLead = ev.isTeamLead ?? false;
          a.leadId = ev.leadAgentId ?? null;
        }
        break;
      }
      case 'tokens': {
        const a = this.agents.get(ev.id);
        if (a) {
          a.inputTokens = ev.inputTokens;
          a.outputTokens = ev.outputTokens;
        }
        break;
      }
      // subagent* events are forwarded only (client-side lifecycle).
    }
  }
}

/** Process-wide singleton shared by ingest sources and the relay room. */
export const director = new AgentDirector();
