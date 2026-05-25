/**
 * Returns a profile-scoped map of decrypted env vars/secrets that should
 * be injected into the agent container at task runtime.
 */
export interface SecretVault {
  getDecryptedForProfile(
    userId: string,
    profileId: string,
  ): Promise<Record<string, string>>;
}
