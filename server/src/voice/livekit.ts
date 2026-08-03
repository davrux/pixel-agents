/**
 * Shared LiveKit helpers — one place the 2D office (SimRoom) mints zone-voice
 * tokens. A room's identity is `p<id>` so the client can map a LiveKit
 * participant back to its avatar for proximity audio.
 */
import { AccessToken } from 'livekit-server-sdk';

export function voiceConfigured(): boolean {
  return !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
}
export function voiceUrl(): string | undefined {
  return process.env.LIVEKIT_URL;
}

/** Namespaced + sanitised LiveKit room name (keeps deployments/worlds from clashing). */
export function voiceRoomName(ns: string, suffix: string): string {
  return `${ns}-${suffix}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

/** Mint a short-TTL access token for `identity` (e.g. `p42`) named `name` in `room`,
 *  or null if LiveKit isn't configured. `canUpdateOwnMetadata` lets a participant
 *  publish a `deaf` attribute so others see when their sound is off. */
export async function mintVoiceToken(identity: string, name: string, room: string): Promise<string | null> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  const at = new AccessToken(apiKey, apiSecret, { identity, name, ttl: '1h' });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canUpdateOwnMetadata: true });
  return at.toJwt();
}
