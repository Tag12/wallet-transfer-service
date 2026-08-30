import { Pool, PoolClient } from 'pg';
import fs from 'fs';
import path from 'path';

let pool: Pool;

export function getPool(): Pool {
  if (!pool) {
    // Neon requires SSL; local Docker/Postgres does not and has no cert configured.
    // Driven by an explicit DB_SSL flag rather than sniffing the connection string
    // (e.g. for "localhost"), since docker-compose connects via the service name
    // "db", not "localhost" — string-sniffing would silently break that path.
    const useSsl = process.env.DB_SSL === 'true';
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export async function runMigrations(): Promise<void> {
  const db = getPool();
  await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  // Resolved from the process working directory (always the project root, whether
  // run via `ts-node src/main.ts` or `node dist/src/main.js`) rather than __dirname,
  // since __dirname's depth relative to the project root differs between dev and build.
  const migrationsDir = path.join(process.cwd(), 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    await db.query(sql);
  }
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined as unknown as Pool;
  }
}
