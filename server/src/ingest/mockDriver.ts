import { director } from '../sim/director.js';

/**
 * Synthetic agents that drive the director with plausible activity, so the
 * world is alive without a real Claude client. Enable with MOCK=<n>.
 */
const TOOLS = [
  'Reading src/index.ts',
  'Editing OfficeRoom.ts',
  'Running tests',
  'Searching "TODO"',
  'Fetching docs.colyseus.io',
  'Thinking…',
];
const USERS = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'];

export function startMockDriver(count: number): void {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const id = 1000 + i;
    ids.push(id);
    director.apply({ t: 'created', id, label: USERS[i % USERS.length] });
  }

  let toolSeq = 0;
  setInterval(() => {
    const id = ids[Math.floor(Math.random() * ids.length)];
    const roll = Math.random();
    if (roll < 0.45) {
      // Start a tool (go active).
      const toolId = `m${toolSeq++}`;
      const status = TOOLS[Math.floor(Math.random() * TOOLS.length)];
      director.apply({ t: 'toolStart', id, toolId, status, toolName: status.split(' ')[0] });
      setTimeout(() => director.apply({ t: 'toolDone', id, toolId }), 2000 + Math.random() * 4000);
    } else if (roll < 0.6) {
      director.apply({ t: 'status', id, status: 'waiting' });
    } else if (roll < 0.72) {
      // Permission prompt that auto-clears.
      director.apply({ t: 'permission', id });
      setTimeout(() => director.apply({ t: 'permissionClear', id }), 4000);
    } else if (roll < 0.82) {
      // Spawn a short-lived sub-agent.
      const toolId = `sub${toolSeq++}`;
      director.apply({ t: 'subagentStart', id, parentToolId: toolId, toolId, status: 'Sub-agent working' });
      setTimeout(() => director.apply({ t: 'subagentClear', id, parentToolId: toolId }), 6000);
    } else {
      director.apply({
        t: 'tokens',
        id,
        inputTokens: Math.floor(Math.random() * 120_000),
        outputTokens: Math.floor(Math.random() * 40_000),
      });
    }
  }, 1500);

  console.log(`[mock] driving ${count} synthetic agents`);
}
