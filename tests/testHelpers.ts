import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getPool, runMigrations, closePool } from '../src/common/db/db';

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET as string);
}

export function randomUserId(): string {
  return `user_${uuidv4()}`;
}

export async function setupTestDb(): Promise<void> {
  await runMigrations();
}

export async function truncateAll(): Promise<void> {
  const db = getPool();
  await db.query('TRUNCATE TABLE transfers, wallets CASCADE');
}

export async function teardownTestDb(): Promise<void> {
  await closePool();
}

/** Test-only: seeds a wallet balance directly via SQL — there is no deposit endpoint in the API surface. */
export async function fundWalletDirectly(userId: string, amountPaise: number): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO wallets (user_id, balance_paise) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET balance_paise = $2`,
    [userId, amountPaise],
  );
}
