/** A site's body decoder: turns an opaque RPC body into a semantic shape at the fingerprint stage. */
export interface Codec {
  /** Stable name, for logs and tests. */
  id: string;
  /** Shape prefixes this codec emits for writes; they are refused by policy (blockedShapes) without a judge. */
  writePrefixes: string[];
  /** Whether this codec owns the request (host and path template). */
  matches: (host: string, template: string) => boolean;
  /** The shape for a body, with the request's path template and query for an endpoint that names its operation there;
   *  anything the codec cannot classify must come back as a write (`…:w[unknown]`). */
  decode: (body: string, at: { template: string; query: URLSearchParams }) => string;
  /** The body with what only marks a resend taken out, so the site's automatic resend of a refused request counts as
   *  the same change (activity.ts, the in-page notice). Only for a field the site flips on a resend and nothing else;
   *  without it, a resend is the same change only when its body is byte-for-byte the same. */
  resend?: (body: string) => string;
}
