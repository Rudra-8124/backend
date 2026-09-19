import { EncryptionService } from './encryption.service';
import { KeyProvider } from './key-provider.interface';

/** In-memory key provider for unit tests. */
class TestKeyProvider implements KeyProvider {
  private keys: Map<string, Buffer>;
  private currentId: string;

  constructor(keys: Record<string, string>, currentId: string) {
    this.keys = new Map();
    for (const [id, hex] of Object.entries(keys)) {
      this.keys.set(id, Buffer.from(hex, 'hex'));
    }
    this.currentId = currentId;
  }

  async getKey(keyId: string): Promise<Buffer> {
    const k = this.keys.get(keyId);
    if (!k) throw new Error(`Key not found: ${keyId}`);
    return k;
  }

  getCurrentKeyId(): string {
    return this.currentId;
  }
}

describe('EncryptionService', () => {
  // Two 256-bit keys for rotation tests
  const KEY1_HEX = 'a'.repeat(64); // 32 bytes of 0xaa
  const KEY2_HEX = 'b'.repeat(64); // 32 bytes of 0xbb

  let service: EncryptionService;
  let keyProvider: TestKeyProvider;

  beforeEach(() => {
    keyProvider = new TestKeyProvider({ k1: KEY1_HEX, k2: KEY2_HEX }, 'k1');
    service = new EncryptionService(keyProvider);
  });

  it('should encrypt and decrypt a string', async () => {
    const plaintext = 'Hello, PHI data!';
    const ciphertext = await service.encrypt(plaintext);
    const decrypted = await service.decrypt(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it('should produce different ciphertexts for the same plaintext (random IV)', async () => {
    const plaintext = 'same input';
    const c1 = await service.encrypt(plaintext);
    const c2 = await service.encrypt(plaintext);
    expect(c1).not.toBe(c2);
    // But both decrypt to the same value
    expect(await service.decrypt(c1)).toBe(plaintext);
    expect(await service.decrypt(c2)).toBe(plaintext);
  });

  it('should produce ciphertext in "keyId:iv:tag:data" format', async () => {
    const ciphertext = await service.encrypt('test');
    const parts = ciphertext.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('k1'); // key ID
    expect(parts[1]).toHaveLength(24); // 12 bytes hex = 24 chars
    expect(parts[2]).toHaveLength(32); // 16 bytes hex = 32 chars (auth tag)
  });

  it('should detect tampered ciphertext (auth tag verification failure)', async () => {
    const ciphertext = await service.encrypt('sensitive data');
    const parts = ciphertext.split(':');

    // Tamper with the encrypted data
    const tampered =
      parts[0] + ':' + parts[1] + ':' + parts[2] + ':' + 'ff'.repeat(parts[3].length / 2);
    await expect(service.decrypt(tampered)).rejects.toThrow();
  });

  it('should detect tampered auth tag', async () => {
    const ciphertext = await service.encrypt('sensitive data');
    const parts = ciphertext.split(':');

    // Tamper with auth tag
    const tampered = parts[0] + ':' + parts[1] + ':' + '00'.repeat(16) + ':' + parts[3];
    await expect(service.decrypt(tampered)).rejects.toThrow();
  });

  it('should support key rotation — decrypt with old key', async () => {
    // Encrypt with k1
    const ciphertext = await service.encrypt('rotated data');
    expect(ciphertext.startsWith('k1:')).toBe(true);

    // Switch to k2 for new encryptions
    const rotatedProvider = new TestKeyProvider({ k1: KEY1_HEX, k2: KEY2_HEX }, 'k2');
    const rotatedService = new EncryptionService(rotatedProvider);

    // New encryption uses k2
    const newCiphertext = await rotatedService.encrypt('new data');
    expect(newCiphertext.startsWith('k2:')).toBe(true);

    // Old ciphertext still decryptable (k1 key is still in the provider)
    const decrypted = await rotatedService.decrypt(ciphertext);
    expect(decrypted).toBe('rotated data');
  });

  it('should fail to decrypt with unknown key ID', async () => {
    const ciphertext = await service.encrypt('test');
    // Replace key ID with unknown
    const tampered = 'unknown' + ciphertext.slice(2);
    await expect(service.decrypt(tampered)).rejects.toThrow('Key not found');
  });

  it('should reject invalid ciphertext format', async () => {
    await expect(service.decrypt('not:enough:parts')).rejects.toThrow('Invalid ciphertext format');
    await expect(service.decrypt('too:many:parts:here:extra')).rejects.toThrow(
      'Invalid ciphertext format',
    );
  });

  it('should handle empty string encryption', async () => {
    const ciphertext = await service.encrypt('');
    const decrypted = await service.decrypt(ciphertext);
    expect(decrypted).toBe('');
  });

  it('should handle unicode and multi-byte characters', async () => {
    const plaintext = '日本語テスト 🏥 مرحبا';
    const ciphertext = await service.encrypt(plaintext);
    const decrypted = await service.decrypt(ciphertext);
    expect(decrypted).toBe(plaintext);
  });
});
