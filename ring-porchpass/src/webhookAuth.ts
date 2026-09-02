import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies inbound Ring webhook requests to `POST /ring/events`, mirroring
 * how Ring's real webhook delivery authenticates callers: a shared secret is
 * used to compute an HMAC-SHA256 over the raw request body, sent back as a
 * signature header (`X-Ring-Signature`) for the receiver to independently
 * recompute and compare. This stops anyone who doesn't know the secret from
 * forging doorbell/motion events into a publicly reachable endpoint.
 *
 * NOT FOR PRODUCTION: `DEFAULT_DEV_WEBHOOK_SECRET` only exists so the demo
 * and test suite work out of the box with zero configuration. Any real
 * deployment must set `RING_WEBHOOK_SECRET` to a long random value shared
 * only with the legitimate event source, and should treat the code path that
 * falls back to the default as a misconfiguration worth alerting on.
 */
export const DEFAULT_DEV_WEBHOOK_SECRET = "porchpass-local-dev-secret-DO-NOT-USE-IN-PRODUCTION";

export function getWebhookSecret(): string {
  return process.env.RING_WEBHOOK_SECRET ?? DEFAULT_DEV_WEBHOOK_SECRET;
}

/** Computes the signature header value for a given secret + raw request body. */
export function signPayload(secret: string, rawBody: string | Buffer): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Verifies a caller-supplied signature header against the expected HMAC for
 * `rawBody`, using a constant-time comparison so response timing can't be
 * used to guess the correct signature byte-by-byte.
 */
export function verifySignature(secret: string, rawBody: string | Buffer, signatureHeader: string | undefined | null): boolean {
  if (!signatureHeader) return false;
  const expected = signPayload(secret, rawBody);
  const expectedBuf = Buffer.from(expected, "utf8");
  const givenBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== givenBuf.length) return false;
  return timingSafeEqual(expectedBuf, givenBuf);
}
