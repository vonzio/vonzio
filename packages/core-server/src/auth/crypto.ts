import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  hkdfSync,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * HKDF `info` parameter — domain-separation context for key derivation.
 * Stable identifier; treat it as part of the wire format, not branding.
 *
 * Changing this string makes every previously-encrypted blob undecryptable.
 * Migration 20 (db/migrations.ts) re-encrypts all stored ciphertexts from
 * the legacy info to this one on the first boot that includes it.
 */
const HKDF_INFO = "vonzio-encryption";

/** Legacy info string used by installs predating migration 20. */
const HKDF_INFO_LEGACY = "reclaude-encryption";

function deriveKey(passphrase: string, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", passphrase, salt, info, 32));
}

export function encrypt(plaintext: string, encryptionKey: string): string {
  const salt = randomBytes(16);
  const key = deriveKey(encryptionKey, salt, HKDF_INFO);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Format: salt:iv:ciphertext:tag (hex encoded)
  return `${salt.toString("hex")}:${iv.toString("hex")}:${encrypted.toString("hex")}:${tag.toString("hex")}`;
}

function decryptWithInfo(encryptedString: string, encryptionKey: string, info: string): string {
  const parts = encryptedString.split(":");
  if (parts.length !== 4) {
    throw new Error("Invalid encrypted string format");
  }

  const salt = Buffer.from(parts[0], "hex");
  const iv = Buffer.from(parts[1], "hex");
  const encrypted = Buffer.from(parts[2], "hex");
  const tag = Buffer.from(parts[3], "hex");

  if (iv.length !== IV_LENGTH) {
    throw new Error("Invalid IV length");
  }
  if (tag.length !== TAG_LENGTH) {
    throw new Error("Invalid auth tag length");
  }

  const key = deriveKey(encryptionKey, salt, info);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

export function decrypt(encryptedString: string, encryptionKey: string): string {
  return decryptWithInfo(encryptedString, encryptionKey, HKDF_INFO);
}

/**
 * Decrypts a blob written before migration 20 (HKDF info "reclaude-encryption").
 * Used by the one-shot re-encryption migration; not called at request time.
 */
export function decryptLegacy(encryptedString: string, encryptionKey: string): string {
  return decryptWithInfo(encryptedString, encryptionKey, HKDF_INFO_LEGACY);
}
