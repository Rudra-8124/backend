import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EncryptionService } from './encryption.service';
import { EnvKeyProvider } from './env-key-provider';
import { KEY_PROVIDER } from './key-provider.interface';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: KEY_PROVIDER,
      useClass: EnvKeyProvider,
    },
    EncryptionService,
  ],
  exports: [EncryptionService, KEY_PROVIDER],
})
export class CryptoModule {}
