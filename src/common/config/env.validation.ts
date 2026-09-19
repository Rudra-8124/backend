import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().default(3000),

  // Postgres
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(5432),
  DB_NAME: Joi.string().required(),
  DB_USER: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),

  // Redis
  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().default(6379),

  // JWT
  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),

  // Field-level encryption
  ENCRYPTION_KEYS: Joi.string().required(),
  ENCRYPTION_CURRENT_KEY_ID: Joi.string().required(),

  // CORS
  CORS_ORIGINS: Joi.string().default('http://localhost:3000'),

  // Payment provider
  PAYMENT_WEBHOOK_SECRET: Joi.string().required(),

  // MFA
  TOTP_ISSUER: Joi.string().default('Amrutam'),

  // Admin seed (optional)
  ADMIN_EMAIL: Joi.string().email({ tlds: false }).optional(),
  ADMIN_PASSWORD: Joi.string().min(12).optional(),
});
