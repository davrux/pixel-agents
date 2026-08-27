/**
 * Shared server-side execution of the account/admin slash-commands
 * (users / add / delete / set-admin / remove-admin / kick). SimRoom delegates
 * here, so the chat behaves IDENTICALLY across zones — same registry, same
 * output (incl. the ★ admin marker), same global user store + cross-zone
 * presence + kick bus. Zone-specific commands (afk, …) stay in the room;
 * this handles only the global ones.
 */
import type { CommandSpec } from '@pixel/shared';

import { appStore } from '../appStore.js';
import { userStore, UserStore, isValidPassword, normalizeLoginId, MIN_PASSWORD_LEN } from '../userStore.js';
import { presence } from '../presence.js';
import { controlBus, KICK_EVENT } from '../controlBus.js';

export interface AccountCmdCtx {
  /** The caller (already group-checked by the room). */
  me: { userId: string; isAdmin: boolean };
  /** Send a system chat line back to the caller. */
  sys: (text: string) => void;
  /** Human label of the current place ("Foyer", 'world "default"', …) for the plain /users list. */
  hereLabel: string;
  /** presence zone-id of the current place, to filter the plain /users list. */
  hereId: string;
  /** Optional room-specific cleanup after a user is deleted (e.g. zone-admin grants). */
  afterDeleteUser?: (loginId: string) => void;
}

/** Admin marker (★), shown for real accounts; blank for anonymous/dev users. */
const star = (userId: string): string => (userStore.get(userId)?.isAdmin ? ' ★' : '');

/** Execute one account/admin command. Returns false if `spec` isn't one of them,
 *  so the calling room can fall through to its own world-specific commands. */
export function runAccountCommand(spec: CommandSpec, args: string[], ctx: AccountCmdCtx): boolean {
  const { sys, me } = ctx;
  switch (spec.name) {
    case 'users': {
      const mode = args[0]?.toLowerCase();
      if (mode === 'all') {
        // Every registered account, with its current place (zone/world) or "offline".
        const users = userStore.list();
        sys(
          users.length
            ? `All users (${users.length}):\n` +
                users
                  .map((u) => `• ${UserStore.displayName(u)} (${u.userId})${star(u.userId)} — ${presence.zoneOf(u.userId) ?? 'offline'}`)
                  .join('\n')
            : 'No users registered.',
        );
      } else if (mode === 'online') {
        // Everyone online across all zones (one presence tracker).
        const all = presence.list().sort((a, b) => a.zone.localeCompare(b.zone) || a.name.localeCompare(b.name));
        sys(
          all.length
            ? `Online users (${all.length}):\n` + all.map((u) => `• ${u.name} (${u.userId})${star(u.userId)} — ${u.zone}`).join('\n')
            : 'No users online.',
        );
      } else {
        // Users in the current place only.
        const here = presence.list().filter((u) => u.zone === ctx.hereId);
        sys(
          here.length
            ? `Users in ${ctx.hereLabel} (${here.length}):\n` + here.map((u) => `• ${u.name} (${u.userId})${star(u.userId)}`).join('\n')
            : `No users in ${ctx.hereLabel}.`,
        );
      }
      return true;
    }
    case 'add': {
      const [loginId, password] = args;
      if (!loginId || !password) return sys(`Usage: ${spec.usage}`), true;
      if (!isValidPassword(password)) return sys(`Password must be at least ${MIN_PASSWORD_LEN} characters.`), true;
      if (userStore.exists(loginId)) return sys(`User "${normalizeLoginId(loginId)}" already exists.`), true;
      sys(`Created user "${userStore.createUser(loginId, password).userId}".`);
      return true;
    }
    case 'delete': {
      const loginId = normalizeLoginId(args[0]);
      if (!loginId) return sys(`Usage: ${spec.usage}`), true;
      if (loginId === me.userId) return sys(`You can't delete yourself.`), true;
      // Sessions, preferences, positions, grants and meeting rooms cascade with the row —
      // see the same delete in adminApi.ts. This command used to forget the user's meeting
      // rooms, which is precisely the drift the schema now prevents.
      if (!userStore.deleteUser(loginId)) return sys(`No such user: "${loginId}".`), true;
      // Disconnect them right now if they're online: their session row is already gone, but
      // Colyseus only re-runs onAuth on a fresh connection, not on an open one.
      controlBus.emit(KICK_EVENT, loginId);
      // The two the schema cannot do: the avatar row in the shared assets table, and zones they
      // owned, which become ownerless rather than deleted.
      appStore.deletePlayerAvatar(loginId);
      ctx.afterDeleteUser?.(loginId);
      sys(`Deleted user "${loginId}" and its data.`);
      return true;
    }
    case 'set-admin':
    case 'remove-admin': {
      const on = spec.name === 'set-admin';
      const loginId = normalizeLoginId(args[0]);
      if (!loginId) return sys(`Usage: ${spec.usage}`), true;
      if (!on && loginId === me.userId) return sys(`You can't remove your own admin rights.`), true;
      if (!userStore.exists(loginId)) return sys(`No such user: "${loginId}".`), true;
      userStore.setAdmin(loginId, on);
      sys(`${loginId} is ${on ? 'now a global admin' : 'no longer an admin'} (takes effect on their next login).`);
      return true;
    }
    case 'kick': {
      const loginId = normalizeLoginId(args[0]);
      if (!loginId) return sys(`Usage: ${spec.usage}`), true;
      if (loginId === me.userId) return sys(`You can't kick yourself.`), true;
      if (!presence.zoneOf(loginId)) return sys(`"${loginId}" is not online.`), true;
      controlBus.emit(KICK_EVENT, loginId); // reaches the user in whatever zone/world they're in
      sys(`Kicked "${loginId}".`);
      return true;
    }
  }
  return false; // not an account command — the room handles its own
}
