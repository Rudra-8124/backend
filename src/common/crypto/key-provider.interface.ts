/**
 * KeyProvider interface — abstraction for encryption key storage.
 * EnvKeyProvider for local dev; swap with KMS implementation in production.
 */
export interface KeyProvider {
  /** Get a key by its ID. Returns the raw key as a Buffer. */
  getKey(keyId: string): Promise<Buffer>;

  /** Get the current active key ID for encryption. */
  getCurrentKeyId(): string;
}

export const KEY_PROVIDER = Symbol('KEY_PROVIDER');
