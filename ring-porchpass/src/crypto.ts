import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "node:crypto";
import type { EncryptedField } from "./types.js";

/**
 * Field-level encryption for visitor PII at rest (currently just
 * `Pass.visitorPhoneEnc`, but built to encrypt any single string field the
 * same way). AES-256-GCM: a fresh random IV per call, and GCM's built-in
 * authentication tag means a tampered ciphertext fails to decrypt loudly
 * rather than silently returning garbage.
 *
 * NOT FOR PRODUCTION, same framing as `webhookAuth.ts`'s dev secret: the key
 * here is derived (via `scrypt`, a slow KDF meant for *passwords*, not real
 * key management) from an env var or, if unset, a clearly-marked local-dev
 * default — good enough that the demo and test suite encrypt/decrypt
 * correctly with zero configuration, and nowhere near what a real deployment
 * should do. A real deployment must pull its data-encryption key from a
 * proper KMS (AWS KMS, etc.) — ideally via envelope encryption, where KMS
 * holds the long-lived key and only ever hands back a short-lived plaintext
 * data key for the duration of one encrypt/decrypt call — not derive it from
 * a static string an application process holds indefinitely. See
 * FRICTION_LOG.md for what a from-scratch KMS integration would require
 * beyond what a hackathon demo needs.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12; // 96-bit IV, the GCM standard/recommended size
const DEFAULT_DEV_KEY_MATERIAL = "porchpass-local-dev-encryption-key-DO-NOT-USE-IN-PRODUCTION";
// A fixed salt is a real weakness for password hashing (its whole point is a
// per-user salt) but is fine for this narrower use: scrypt is only standing
// in for "derive 32 pseudorandom bytes from a secret," not hashing anything
// an attacker could dictionary-attack per-record — the actual protection
// here is "don't let PORCHPASS_ENCRYPTION_KEY leak," same as any secret.
const KEY_DERIVATION_SALT = "porchpass-static-salt-demo-only";

function getEncryptionKey(): Buffer {
  const material = process.env.PORCHPASS_ENCRYPTION_KEY;
  const keyMaterial = material && material.length > 0 ? material : DEFAULT_DEV_KEY_MATERIAL;
  return scryptSync(keyMaterial, KEY_DERIVATION_SALT, 32); // AES-256 needs a 32-byte key
}

export function isUsingDefaultEncryptionKey(): boolean {
  return !process.env.PORCHPASS_ENCRYPTION_KEY;
}

export function encryptField(plaintext: string): EncryptedField {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { iv: iv.toString("hex"), authTag: authTag.toString("hex"), ciphertext: ciphertext.toString("hex") };
}

export function decryptField(field: EncryptedField): string {
  const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), Buffer.from(field.iv, "hex"));
  decipher.setAuthTag(Buffer.from(field.authTag, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(field.ciphertext, "hex")), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Masks a phone number for API responses: everything but the last 4 digits
 * becomes `•`. This is the one piece of visitor PII PorchPass's own API
 * hands back at all — a homeowner still needs to recognize *which* visitor a
 * pass belongs to — but full plaintext is never re-exposed just to render a
 * pass; only an internal caller with an actual reason (sending the SMS) ever
 * sees the real number, via `decryptField` directly.
 */
export function maskPhone(phone: string): string {
  if (phone.length <= 4) return "•".repeat(phone.length);
  return `${"•".repeat(phone.length - 4)}${phone.slice(-4)}`;
}

/**
 * A deterministic, one-way HMAC-SHA256 of a visitor's phone number — round
 * 5's `Pass.visitorPhoneLookup`. Unlike `encryptField` (which must be
 * reversible so the visitor's SMS can actually be sent), this is
 * specifically *not* reversible: its only job is "do two passes belong to
 * the same visitor?", which an HMAC answers without ever needing to recover
 * the original number from it. Same key material as field encryption
 * (`getEncryptionKey()`) — reusing it is a fine simplification for this
 * demo's single-purpose key; a production KMS integration would mint a
 * separate purpose-scoped key for this the same way it would for encryption.
 */
export function phoneLookupKey(phone: string): string {
  return createHmac("sha256", getEncryptionKey()).update(phone).digest("hex");
}
