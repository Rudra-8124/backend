import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';
import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';

async function seedK6Data() {
  console.log('=== Seeding Data for k6 Load Testing ===');

  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL || 'postgresql://amrutam:amrutam_dev_password@localhost:5432/amrutam',
    synchronize: false,
    logging: false,
  });

  await dataSource.initialize();
  console.log('Database connected.');

  const passwordHash = await argon2.hash('K6LoadTestPassword123!', {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  // 1. Create or retrieve dedicated Load Test Patient
  const patientEmail = 'k6_patient@amrutam.local';
  let patientUserId: string;

  const existingPat = await dataSource.query(`SELECT id FROM users WHERE email = $1`, [patientEmail]);
  if (existingPat.length > 0) {
    patientUserId = existingPat[0].id;
  } else {
    const patUser = await dataSource.query(
      `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
       VALUES (gen_random_uuid(), $1, $2, 'patient', true, true)
       RETURNING id;`,
      [patientEmail, passwordHash],
    );
    patientUserId = patUser[0].id;

    await dataSource.query(
      `INSERT INTO profiles (user_id, first_name, last_name, city)
       VALUES ($1, 'K6Load', 'Patient', 'Bangalore')
       ON CONFLICT (user_id) DO NOTHING;`,
      [patientUserId],
    );
  }

  // Generate valid JWT token for the patient via API login or dotenv
  let patientToken = '';
  try {
    const loginRes = await fetch('http://localhost:3000/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: patientEmail, password: 'K6LoadTestPassword123!' }),
    });
    if (loginRes.ok) {
      const loginBody = (await loginRes.json()) as { accessToken: string };
      patientToken = loginBody.accessToken;
      console.log('Successfully obtained patient access token from API login.');
    }
  } catch {
    // fallback if API not yet up
  }

  if (!patientToken) {
    const dotenv = await import('dotenv');
    dotenv.config();
    const jwtSecret = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-must-be-at-least-32-characters-long';
    patientToken = jwt.sign(
      {
        sub: patientUserId,
        email: patientEmail,
        role: 'patient',
        type: 'access',
      },
      jwtSecret,
      { expiresIn: '24h' },
    );
  }

  // 2. Ensure at least 5 verified doctors exist
  const doctorIds: string[] = [];
  const existingDocs = await dataSource.query(`SELECT id FROM doctors WHERE is_verified = true LIMIT 10;`);

  if (existingDocs.length >= 5) {
    doctorIds.push(...existingDocs.map((d: { id: string }) => d.id));
  } else {
    for (let i = 0; i < 5; i++) {
      const docEmail = `k6_doctor_${Date.now()}_${i}@amrutam.local`;
      const docUser = await dataSource.query(
        `INSERT INTO users (id, email, password_hash, role, is_active, is_verified)
         VALUES (gen_random_uuid(), $1, $2, 'doctor', true, true)
         RETURNING id;`,
        [docEmail, passwordHash],
      );
      const docUserId = docUser[0].id;

      await dataSource.query(
        `INSERT INTO profiles (user_id, first_name, last_name, city)
         VALUES ($1, 'Ayush', 'Vaidya_${i}', 'Mumbai')
         ON CONFLICT (user_id) DO NOTHING;`,
        [docUserId],
      );

      const docRes = await dataSource.query(
        `INSERT INTO doctors (
          user_id, bio, license_number, specializations, languages,
          experience_years, fee_cents, rating_avg, rating_count, is_verified
        ) VALUES (
          $1, 'Specialist in Ayurvedic Panchakarma, herbs, and stress relief.',
          $2, ARRAY['Ayurveda', 'Panchakarma', 'Skin'], ARRAY['English', 'Hindi'],
          12, 45000, 4.85, 40, true
        ) RETURNING id;`,
        [docUserId, `LIC-K6-${Date.now()}-${i}`],
      );
      doctorIds.push(docRes[0].id);
    }
  }

  console.log(`Found/created ${doctorIds.length} verified doctors.`);

  // 3. Generate 1,000 discrete availability slots for write load test
  console.log('Generating 1,000 fresh availability slots for write scenario...');
  const slotIds: string[] = [];
  const baseTime = Date.now() + 7 * 24 * 3600 * 1000; // 7 days in the future to avoid collision

  for (let i = 0; i < 1000; i++) {
    const assignedDoctorId = doctorIds[i % doctorIds.length];
    const startTime = new Date(baseTime + i * 35 * 60 * 1000); // 35 min increments per slot
    const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);
    const partitionMonth = startTime.toISOString().slice(0, 7) + '-01';

    const slotRow = await dataSource.query(
      `INSERT INTO availability_slots (id, partition_month, doctor_id, start_time, end_time, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'AVAILABLE', now(), now())
       RETURNING id;`,
      [partitionMonth, assignedDoctorId, startTime, endTime],
    );

    slotIds.push(slotRow[0].id);
  }

  console.log(`Created ${slotIds.length} available slots.`);

  // 4. Save test data payload for k6
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const k6Payload = {
    baseUrl: process.env.BASE_URL || 'http://localhost:3000',
    patientToken,
    patientUserId,
    doctorIds,
    searchTerms: ['Ayurveda', 'Panchakarma', 'Skin', 'Delhi', 'Bangalore', 'Mumbai'],
    slotIds,
  };

  const outputPath = path.join(dataDir, 'k6-test-data.json');
  fs.writeFileSync(outputPath, JSON.stringify(k6Payload, null, 2));
  console.log(`k6 test data saved to: ${outputPath}`);

  await dataSource.destroy();
  console.log('=== k6 Data Seeding Completed Successfully ===');
}

seedK6Data().catch((err) => {
  console.error('Failed to seed k6 data:', err);
  process.exit(1);
});
