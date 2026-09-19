import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KeyProvider } from './key-provider.interface';

/**
 * Environment-based key provider.
 * Reads ENCRYPTION_KEYS (JSON map of keyId → hex-encoded 256-bit keys)
 * and ENCRYPTION_CURRENT_KEY_ID from environment variables.
 */
@Injectable()
export class EnvKeyProvider implements KeyProvider {
  private readonly keys: Map<string, Buffer>;
  private readonly currentKeyId: string;

  constructor(private readonly config: ConfigService) {
    const rawKeys = this.config.get<string>('ENCRYPTION_KEYS', '{}');
    const parsed = JSON.parse(rawKeys) as Record<string, string>;

    this.keys = new Map<string, Buffer>();
    for (const [id, hex] of Object.entries(parsed)) {
      const buf = Buffer.from(hex, 'hex');
      if (buf.length !== 32) {
        throw new Error(`Encryption key "${id}" must be 256 bits (32 bytes), got ${buf.length}`);
      }
      this.keys.set(id, buf);
    }

    this.currentKeyId = this.config.get<string>('ENCRYPTION_CURRENT_KEY_ID', '');
    if (!this.keys.has(this.currentKeyId)) {
      throw new Error(
        `ENCRYPTION_CURRENT_KEY_ID="${this.currentKeyId}" not found in ENCRYPTION_KEYS`,
      );
    }
  }

  async getKey(keyId: string): Promise<Buffer> {
    const key = this.keys.get(keyId);
    if (!key) {
      throw new Error(`Encryption key "${keyId}" not found`);
    }
    return key;
  }

  getCurrentKeyId(): string {
    return this.currentKeyId;
  }
}
