import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';

config();

async function seed() {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USER || 'amrutam',
    password: process.env.DB_PASSWORD || 'change_me_in_production',
    database: process.env.DB_NAME || 'amrutam',
  });

  await ds.initialize();

  const email = process.env.ADMIN_EMAIL || 'admin@amrutam.test';
  const password = process.env.ADMIN_PASSWORD || 'AdminPass123!@#Secure';

  // Check if admin already exists (idempotent)
  const existing = await ds.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.length > 0) {
    console.log(`Admin user "${email}" already exists (id: ${existing[0].id}). Skipping.`);
    await ds.destroy();
    return;
  }

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  const userId = randomUUID();
  const profileId = randomUUID();

  await ds.query(
    `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
     VALUES ($1, $2, $3, 'admin', true, true)`,
    [userId, email, passwordHash],
  );

  await ds.query(
    `INSERT INTO profiles (id, user_id, first_name, last_name)
     VALUES ($1, $2, 'System', 'Admin')`,
    [profileId, userId],
  );

  console.log(`Admin user seeded: ${email} (id: ${userId})`);
  await ds.destroy();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
