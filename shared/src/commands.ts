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

/** WebSocket close code used when an admin kicks a user, so the client can show
 *  a "kicked" notice and skip its auto-reconnect. (Custom codes must be ≥4000.)
 *  IMPORTANT: must NOT collide with Colyseus' own close codes, which the transport
 *  uses for its own reasons — WS_CLOSE_CONSENTED=4000, WS_CLOSE_WITH_ERROR=4002
 *  (sent e.g. on an unregistered/undecodable message), WS_CLOSE_DEVMODE_RESTART=4010.
 *  Using 4002 made every protocol error look like an admin kick. 4100 is clear of them. */
export const KICK_CLOSE_CODE = 4100;

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
  {
    name: 'users',
    group: 'user',
    usage: '/users [all|online]',
    summary: 'List users in your zone (★ = admin); /users all = every account (with zone/offline); /users online = everyone online.',
  },
  {
    name: 'add',
    group: 'admin',
    usage: '/add <loginid> <password>',
    summary: 'Create a user account (password min 6 characters).',
  },
  {
    name: 'delete',
    group: 'admin',
    usage: '/delete <loginid>',
    summary: 'Delete a user account and its avatar/prefs.',
  },
  {
    name: 'set-admin',
    group: 'admin',
    usage: '/set-admin <loginid>',
    summary: 'Grant a user global admin rights.',
  },
  {
    name: 'remove-admin',
    group: 'admin',
    usage: '/remove-admin <loginid>',
    summary: 'Revoke a user\'s global admin rights.',
  },
  {
    name: 'kick',
    group: 'admin',
    usage: '/kick <loginid>',
    summary: 'Disconnect an online user (they can log back in).',
  },
  {
    name: 'admin-site',
    group: 'admin',
    usage: '/admin-site',
    summary: 'Open the administration page (users, roles, room passwords).',
  },
  {
    name: 'matrix',
    group: 'user',
    usage: '/matrix [@user:server]',
    summary: 'Open the Matrix chat panel (optionally start a direct chat).',
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
