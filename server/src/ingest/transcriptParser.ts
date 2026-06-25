import type { AgentEvent } from '@pixel/shared';

/**
 * Per-agent parse state carried across transcript lines.
 *
 * A pragmatic port of the original transcriptParser: it covers the record
 * shapes that drive the visuals (tool_use / tool_result, token usage, turn
 * boundaries, team metadata, Task/Agent sub-agents). The original's hook/timer
 * machinery is intentionally omitted — the Colyseus room is authoritative and
 * permission detection is handled separately.
 */
export interface ParseState {
  /** toolId → toolName for tools currently in flight. */
  activeToolNames: Map<string, string>;
  /** toolIds of Task/Agent calls that spawned a visible sub-agent. */
  subagentTools: Set<string>;
  hadToolsInTurn: boolean;
  teamName?: string;
}

export function newParseState(): ParseState {
  return {
    activeToolNames: new Map(),
    subagentTools: new Set(),
    hadToolsInTurn: false,
  };
}

const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

/** Heuristic, human-readable status line for a tool call. */
export function formatToolStatus(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  switch (name) {
    case 'Bash':
      return s('description') || trunc(s('command') || 'Running command');
    case 'Read':
      return `Reading ${base(s('file_path'))}`;
    case 'Edit':
    case 'Write':
      return `Editing ${base(s('file_path'))}`;
    case 'Grep':
      return `Searching "${trunc(s('pattern') || '')}"`;
    case 'Glob':
      return `Finding ${trunc(s('pattern') || 'files')}`;
    case 'WebFetch':
      return `Fetching ${trunc(s('url') || '')}`;
    case 'WebSearch':
      return `Searching the web`;
    case 'Task':
    case 'Agent':
      return s('description') || 'Delegating to sub-agent';
    default:
      return `Using ${name}`;
  }
}

/**
 * Parse one JSONL line for `agentId`, pushing high-level AgentEvents to `emit`.
 * Returns nothing; all effects flow through `emit`.
 */
export function parseLine(
  agentId: number,
  line: string,
  st: ParseState,
  emit: (ev: AgentEvent) => void,
): void {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }

  // Team metadata (Claude: teamName / agentName at the record root).
  const teamName = typeof rec.teamName === 'string' ? rec.teamName : undefined;
  if (teamName && teamName !== st.teamName) {
    st.teamName = teamName;
    emit({
      t: 'team',
      id: agentId,
      teamName,
      agentName: typeof rec.agentName === 'string' ? rec.agentName : undefined,
    });
  }

  // Token usage.
  const usage = (rec as any).message?.usage as
    | { input_tokens?: number; output_tokens?: number }
    | undefined;
  if (usage && (usage.input_tokens || usage.output_tokens)) {
    emit({
      t: 'tokens',
      id: agentId,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    });
  }

  const content = (rec as any).message?.content ?? (rec as any).content;

  if (rec.type === 'assistant' && Array.isArray(content)) {
    const blocks = content as Array<{
      type: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    let usedTool = false;
    for (const b of blocks) {
      if (b.type === 'tool_use' && b.id) {
        usedTool = true;
        const name = b.name || '';
        const status = formatToolStatus(name, b.input || {});
        st.activeToolNames.set(b.id, name);
        emit({ t: 'toolStart', id: agentId, toolId: b.id, status, toolName: name });
        if (SUBAGENT_TOOLS.has(name)) {
          st.subagentTools.add(b.id);
          emit({ t: 'subagentStart', id: agentId, parentToolId: b.id, toolId: b.id, status });
        }
      }
    }
    if (usedTool) {
      st.hadToolsInTurn = true;
      emit({ t: 'status', id: agentId, status: 'active' });
    }
    return;
  }

  if (rec.type === 'user' && Array.isArray(content)) {
    const blocks = content as Array<{ type: string; tool_use_id?: string }>;
    let sawResult = false;
    for (const b of blocks) {
      if (b.type === 'tool_result' && b.tool_use_id) {
        sawResult = true;
        const toolId = b.tool_use_id;
        if (st.subagentTools.has(toolId)) {
          st.subagentTools.delete(toolId);
          emit({ t: 'subagentClear', id: agentId, parentToolId: toolId });
        }
        st.activeToolNames.delete(toolId);
        emit({ t: 'toolDone', id: agentId, toolId });
      }
    }
    if (!sawResult) {
      // A fresh user prompt — new turn begins.
      st.hadToolsInTurn = false;
      emit({ t: 'toolsClear', id: agentId });
    }
    return;
  }

  // Definitive turn end.
  if (rec.type === 'system' && (rec as any).subtype === 'turn_duration') {
    st.hadToolsInTurn = false;
    st.activeToolNames.clear();
    emit({ t: 'toolsClear', id: agentId });
    emit({ t: 'status', id: agentId, status: 'waiting' });
  }
}

function base(p?: string): string {
  if (!p) return 'file';
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

function trunc(s: string, n = 40): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
