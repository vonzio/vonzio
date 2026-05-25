import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "./crypto.js";

const KEY = "a]3Kf9$mPqR7vXw2LnB5tYhJ8cDgE0sU";

describe("crypto", () => {
  it("encrypts and decrypts round-trip", () => {
    const plaintext = "sk-ant-api03-secret-key-value";
    const encrypted = encrypt(plaintext, KEY);
    const decrypted = decrypt(encrypted, KEY);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const plaintext = "same-value";
    const a = encrypt(plaintext, KEY);
    const b = encrypt(plaintext, KEY);
    expect(a).not.toBe(b);
    // But both decrypt to the same value
    expect(decrypt(a, KEY)).toBe(plaintext);
    expect(decrypt(b, KEY)).toBe(plaintext);
  });

  it("fails to decrypt with wrong key", () => {
    const encrypted = encrypt("secret", KEY);
    const wrongKey = "xY9Kf9$mPqR7vXw2LnB5tYhJ8cDgE0sZ";
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it("fails on tampered ciphertext", () => {
    const encrypted = encrypt("secret", KEY);
    const parts = encrypted.split(":");
    // Flip a byte in the ciphertext
    const tampered = parts[0] + ":" + "ff" + parts[1].slice(2) + ":" + parts[2];
    expect(() => decrypt(tampered, KEY)).toThrow();
  });

  it("fails on invalid format (not 4 parts)", () => {
    expect(() => decrypt("not-valid-format", KEY)).toThrow(
      "Invalid encrypted string format",
    );
    expect(() => decrypt("a:b:c", KEY)).toThrow(
      "Invalid encrypted string format",
    );
  });

  it("handles empty string plaintext", () => {
    const encrypted = encrypt("", KEY);
    expect(decrypt(encrypted, KEY)).toBe("");
  });

  it("handles unicode plaintext", () => {
    const plaintext = "clé-secrète-日本語";
    const encrypted = encrypt(plaintext, KEY);
    expect(decrypt(encrypted, KEY)).toBe(plaintext);
  });
});
