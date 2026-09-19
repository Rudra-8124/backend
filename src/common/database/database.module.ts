import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { join } from 'path';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type: 'postgres' as const,
        host: cfg.get<string>('DB_HOST'),
        port: cfg.get<number>('DB_PORT', 5432),
        username: cfg.get<string>('DB_USER'),
        password: cfg.get<string>('DB_PASSWORD'),
        database: cfg.get<string>('DB_NAME'),
        entities: [join(__dirname, '../../**/*.entity{.ts,.js}')],
        synchronize: false,
        logging: cfg.get('NODE_ENV') === 'development',
        // Connection pool — see capacity.md
        extra: {
          max: 20,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        },
      }),
    }),
  ],
})
export class DatabaseModule {}
