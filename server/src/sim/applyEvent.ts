import type { AgentEvent } from '@pixel/shared';
import type { OfficeState } from '@pixel/shared/office/engine/index.js';
import { extractToolName, isSubagentToolName } from '@pixel/shared/office/toolUtils.js';

/**
 * Apply one ingest AgentEvent to the authoritative OfficeState. A server-side
 * port of the old webview message handler — same OfficeState mutations, now
 * running on the server. `activity` holds the latest human-readable status per
 * agent/sub-agent id (synced to clients for the hover tooltip).
 */
export function applyEvent(os: OfficeState, ev: AgentEvent, activity: Map<number, string>): void {
  // Drop the activity entries of `parentId`'s sub-agents (keyed by their unique,
  // never-reused negative sub-agent ids). MUST run before removeSubagent(s) clears
  // subagentMeta, or the ids are gone. Without this, `activity` leaks one entry per
  // sub-agent forever — the one monotonic, agent-driven growth that slows a single
  // long-running room over hours (GC pressure). Only subagentStart writes sub-agent
  // entries (line below), and no delete ever used a sub-agent id.
  const pruneSubagentActivity = (parentId: number): void => {
    for (const [subId, meta] of os.subagentMeta) {
      if (meta.parentAgentId === parentId) activity.delete(subId);
    }
  };
  switch (ev.t) {
    case 'created':
      os.addAgent(ev.id, undefined, undefined, undefined, false, ev.label);
      break;

    case 'removed':
      activity.delete(ev.id);
      pruneSubagentActivity(ev.id);
      os.removeAllSubagents(ev.id);
      os.removeAgent(ev.id);
      break;

    case 'status':
      os.setAgentActive(ev.id, ev.status === 'active');
      if (ev.status === 'waiting') {
        // Genuine turn end — show the "done" bubble (the client chimes on it).
        activity.delete(ev.id);
        os.showWaitingBubble(ev.id);
      } else if (ev.status === 'idle') {
        // Inactivity timeout — go quiet without the "done" bubble/chime.
        activity.delete(ev.id);
      }
      break;

    case 'toolStart': {
      const toolName = ev.toolName ?? extractToolName(ev.status) ?? '';
      if (ev.status) activity.set(ev.id, ev.status);
      os.setAgentTool(ev.id, toolName);
      os.setAgentActive(ev.id, true);
      os.clearPermissionBubble(ev.id);
      if (isSubagentToolName(toolName)) os.addSubagent(ev.id, ev.toolId);
      break;
    }

    case 'toolDone':
      break;

    case 'toolsClear': {
      activity.delete(ev.id);
      const ch = os.characters.get(ev.id);
      const inlineTeam = ch?.teamName && ch?.isTeamLead && !ch?.teamUsesTmux;
      if (!inlineTeam) {
        pruneSubagentActivity(ev.id);
        os.removeAllSubagents(ev.id);
      }
      os.setAgentTool(ev.id, null);
      os.clearPermissionBubble(ev.id);
      break;
    }

    case 'permission':
      activity.set(ev.id, 'Needs approval');
      os.showPermissionBubble(ev.id);
      break;

    case 'permissionClear':
      os.clearPermissionBubble(ev.id);
      for (const [subId, m] of os.subagentMeta) {
        if (m.parentAgentId === ev.id) os.clearPermissionBubble(subId);
      }
      break;

    case 'subagentStart': {
      const subId = os.getSubagentId(ev.id, ev.parentToolId);
      if (subId !== null) {
        if (ev.status) activity.set(subId, ev.status);
        os.setAgentTool(subId, extractToolName(ev.status) ?? '');
        os.setAgentActive(subId, true);
      }
      break;
    }

    case 'subagentDone':
      break;

    case 'subagentClear': {
      const subId = os.getSubagentId(ev.id, ev.parentToolId);
      if (subId !== null) activity.delete(subId);
      os.removeSubagent(ev.id, ev.parentToolId);
      break;
    }

    case 'team':
      os.setTeamInfo(ev.id, ev.teamName, ev.agentName, ev.isTeamLead, ev.leadAgentId);
      break;

    case 'tokens':
      os.setAgentTokens(ev.id, ev.inputTokens, ev.outputTokens);
      break;
  }
}
