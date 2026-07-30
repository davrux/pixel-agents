/**
 * Trust-on-first-use store for TLS certificates the system doesn't trust.
 *
 * The desktop app talks to user-configured, self-hosted servers that usually
 * present self-signed certificates. Rather than disabling verification, we ask
 * the user to trust THIS host's THIS certificate (shown by fingerprint) and
 * remember the answer.
 *
 * Two callers share this store:
 *  - main.ts installs a Chromium `setCertificateVerifyProc` for the app's own
 *    HTTP/WebSocket traffic;
 *  - mumble/settings.ts checks a Node `tls` socket, which does NOT go through
 *    Chromium's verify proc and so needs its own check against the same store.
 */
import { BrowserWindow, app, dialog } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TRUSTED_CERTS_FILE = 'trusted-certs.json';

function trustedCertsPath(): string {
  return join(app.getPath('userData'), TRUSTED_CERTS_FILE);
}

// host -> set of accepted certificate fingerprints (e.g. "sha256/AbC...").
const trustedCerts = new Map<string, Set<string>>();
// host|fingerprint -> in-flight decision, so concurrent requests for the same
// untrusted cert share one dialog instead of stacking prompts.
const pendingTrust = new Map<string, Promise<boolean>>();

export async function loadTrustedCerts(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(trustedCertsPath(), 'utf8');
  } catch {
    return; // none stored yet
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [host, fps] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(fps)) trustedCerts.set(host, new Set(fps.filter((f): f is string => typeof f === 'string')));
      }
    }
  } catch {
    // corrupt store — start fresh (a rejected cert will simply re-prompt)
  }
}

async function saveTrustedCerts(): Promise<void> {
  const obj: Record<string, string[]> = {};
  for (const [host, fps] of trustedCerts) obj[host] = [...fps];
  try {
    await writeFile(trustedCertsPath(), JSON.stringify(obj), 'utf8');
  } catch {
    // best-effort persistence; trust still holds for this session
  }
}

export function isTrusted(host: string, fingerprint: string): boolean {
  return trustedCerts.get(host)?.has(fingerprint) === true;
}

export async function rememberTrust(host: string, fingerprint: string): Promise<void> {
  const set = trustedCerts.get(host) ?? new Set<string>();
  set.add(fingerprint);
  trustedCerts.set(host, set);
  await saveTrustedCerts();
}

export interface CertPromptDetails {
  host: string;
  subject: string;
  issuer: string;
  fingerprint: string;
  /** Extra context line, e.g. Chromium's verification result. */
  because?: string;
  /** What the connection is for, so the dialog can say "voice server". */
  what?: string;
}

/** Ask the user whether to trust a certificate. Default button is Cancel, so an
 *  accidental Enter or window close does NOT trust. */
export async function promptTrustCertificate(
  window: BrowserWindow | null,
  details: CertPromptDetails,
): Promise<boolean> {
  const what = details.what ?? 'server';
  const detail =
    `${details.host} presented a certificate that is not trusted by the system` +
    `${details.because ? ` (${details.because})` : ''}.\n\n` +
    `Subject: ${details.subject}\n` +
    `Issuer:  ${details.issuer}\n` +
    `Fingerprint: ${details.fingerprint}\n\n` +
    `Only trust this if you recognize the ${what}. The certificate will be ` +
    `remembered for this host; if it ever changes you will be asked again.`;
  const opts = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Trust and Connect'],
    defaultId: 0,
    cancelId: 0,
    title: `Untrusted ${what} certificate`,
    message: `Trust the certificate for ${details.host}?`,
    detail,
  };
  const { response } = window ? await dialog.showMessageBox(window, opts) : await dialog.showMessageBox(opts);
  return response === 1;
}

/** Trust check with de-duplicated prompting: concurrent callers for the same
 *  (host, fingerprint) share one dialog. Remembers an accepted certificate. */
export async function ensureTrusted(
  window: BrowserWindow | null,
  details: CertPromptDetails,
): Promise<boolean> {
  if (isTrusted(details.host, details.fingerprint)) return true;
  const key = `${details.host}|${details.fingerprint}`;
  let decision = pendingTrust.get(key);
  if (!decision) {
    decision = promptTrustCertificate(window, details);
    pendingTrust.set(key, decision);
    void decision.finally(() => pendingTrust.delete(key));
  }
  const accepted = await decision;
  if (accepted) await rememberTrust(details.host, details.fingerprint);
  return accepted;
}
