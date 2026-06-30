/**
 * Slash-command registry, shared by client and server so both agree on the set
 * of commands, who may use them, and their help text. Commands fall into groups:
 *   - `user`  — available to everyone
 *   - `admin` — only to (global) admins
 *
 * The client parses `/name args`, renders `/help` from this registry (filtered
 * by the viewer's group), and forwards stateful commands to the server, which
 * re-checks the group before executing.
 */

export type CommandGroup = 'user' | 'admin';

export interface CommandSpec {
  /** Invoked as `/name`. */
  name: string;
  group: CommandGroup;
  /** One-line usage shown by `/help name`, e.g. `/afk`. */
  usage: string;
  /** Short description for `/help`. */
  summary: string;
}

export const COMMANDS: CommandSpec[] = [
  {
    name: 'help',
    group: 'user',
    usage: '/help [command]',
    summary: 'List available commands, or show help for one command.',
  },
  {
    name: 'afk',
    group: 'user',
    usage: '/afk',
    summary: 'Toggle an "afk" marker over your avatar; it clears when you move or run /afk again.',
  },
];

/** Look up a command by name (case-insensitive, leading slash tolerated). */
export function findCommand(name: string): CommandSpec | undefined {
  const n = name.replace(/^\//, '').trim().toLowerCase();
  return COMMANDS.find((c) => c.name === n);
}

/** Commands visible to a viewer: admins see all, users see only `user` ones. */
export function commandsForGroup(isAdmin: boolean): CommandSpec[] {
  return COMMANDS.filter((c) => isAdmin || c.group === 'user');
}

/** Whether a principal may run a command (group gate). */
export function mayRunCommand(cmd: CommandSpec, isAdmin: boolean): boolean {
  return cmd.group === 'user' || isAdmin;
}
