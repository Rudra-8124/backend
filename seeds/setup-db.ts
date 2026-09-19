import { Client } from 'pg';

async function main() {
  const client = new Client({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    database: 'postgres',
  });

  await client.connect();
  console.log('Connected to PostgreSQL as postgres');

  try {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'amrutam') THEN
          CREATE ROLE amrutam WITH LOGIN SUPERUSER PASSWORD 'change_me_in_production';
          RAISE NOTICE 'Role amrutam created';
        ELSE
          ALTER ROLE amrutam WITH LOGIN SUPERUSER PASSWORD 'change_me_in_production';
          RAISE NOTICE 'Role amrutam altered';
        END IF;
      END $$;
    `);
    console.log('Role amrutam configured successfully');
  } catch (err: any) {
    console.error('Error creating role:', err.message);
  }

  try {
    const res = await client.query("SELECT 1 FROM pg_database WHERE datname = 'amrutam'");
    if (res.rowCount === 0) {
      await client.query('CREATE DATABASE amrutam OWNER amrutam');
      console.log('Database amrutam created');
    } else {
      console.log('Database amrutam already exists');
    }
  } catch (err: any) {
    console.error('Error creating database:', err.message);
  }

  await client.end();
}

main().catch(console.error);
