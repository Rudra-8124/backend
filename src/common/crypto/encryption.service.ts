import { Injectable, Inject } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { KeyProvider, KEY_PROVIDER } from './key-provider.interface';

/**
 * AES-256-GCM field-level encryption service.
 *
 * Ciphertext format: "keyId:iv:authTag:ciphertext" (all hex-encoded except keyId).
 * - 96-bit (12 byte) random IV per message
 * - 128-bit auth tag
 * - Decrypt selects key by keyId prefix → supports key rotation.
 */
@Injectable()
export class EncryptionService {
  constructor(@Inject(KEY_PROVIDER) private readonly keyProvider: KeyProvider) {}

  /**
   * Encrypt plaintext using the current active key.
   * Returns "keyId:iv:authTag:ciphertext" format.
   */
  async encrypt(plaintext: string): Promise<string> {
    const keyId = this.keyProvider.getCurrentKeyId();
    const key = await this.keyProvider.getKey(keyId);
    const iv = randomBytes(12); // 96-bit IV

    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `${keyId}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * Decrypt ciphertext. Extracts keyId from the prefix to select the correct key.
   * Throws on tampered data (auth tag verification failure).
   */
  async decrypt(ciphertext: string): Promise<string> {
    const parts = ciphertext.split(':');
    if (parts.length !== 4) {
      throw new Error('Invalid ciphertext format: expected "keyId:iv:authTag:ciphertext"');
    }

    const [keyId, ivHex, authTagHex, encryptedHex] = parts;
    const key = await this.keyProvider.getKey(keyId);
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  }
}
