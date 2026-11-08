// Per-site body codecs: turn opaque RPC bodies into semantic shapes at the fingerprint stage.
// A codec returns a shape string; a request no codec matches falls through to the generic bodyShape().
// Shapes that start with a codec's write prefix are decoded writes; the policy refuses them by prefix
// (blockedShapes, filled from CODEC_WRITE_PREFIXES) without consulting a judge. Anything a codec cannot classify
// is reported as a write (`w[unknown]` / `w[unparseable]`): decoded traffic fails closed, never open.
//
// Adding a site's codec: one file here exporting a Codec, added to CODECS, and its vectors in
// <name>.vectors.json next to it (picked up by fingerprint.test.ts and harness/lib/test_fingerprint.py).
import type { Codec } from './types';
import { gmail } from './gmail';
import { gcal } from './gcal';
import { gtasks } from './gtasks';
import { linkedin, linkedinBadge, linkedinMessaging } from './linkedin';
import { facebook } from './facebook';

export type { Codec } from './types';
export const CODECS: readonly Codec[] = [gcal, gtasks, gmail, linkedin, linkedinBadge, linkedinMessaging, facebook];

/** Every codec's write prefix: blocked by default, whatever the stored policy says. */
export const CODEC_WRITE_PREFIXES: readonly string[] = CODECS.flatMap((c) => c.writePrefixes);

/** The body as it identifies a change, with what only marks a resend taken out (Codec.resend). */
export function resendBody(host: string, template: string, body: string): string {
  for (const c of CODECS) if (c.matches(host, template)) return c.resend ? c.resend(body) : body;
  return body;
}

export function decodeShape(host: string, template: string, body: string | undefined, query = new URLSearchParams()): string | undefined {
  if (!body) return undefined;
  for (const c of CODECS) if (c.matches(host, template)) return c.decode(body, { template, query });
  return undefined;
}
