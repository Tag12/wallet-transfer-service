import { PoolClient } from 'pg';
import { getPool } from '../common/db/db';
import { WalletRow } from '../interfaces/wallet.interface';
import { logger } from '../common/logger';

export async function getOrCreateWallet(userId: string, requestId?: string): Promise<WalletRow> {
  const db = getPool();
  const inserted = await db.query<WalletRow>(
    `INSERT INTO wallets (user_id, balance_paise) VALUES ($1, 0)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING *`,
    [userId],
  );
  if (inserted.rows[0]) {
    return inserted.rows[0];
  }
  // No-op create: the wallet already existed. This is the expected idempotent
  // outcome of POST /accounts (calling twice returns the same wallet), not a
  // race — so nothing is logged here.
  const existing = await db.query<WalletRow>('SELECT * FROM wallets WHERE user_id = $1', [userId]);
  return existing.rows[0];
}

export async function ensureWalletExists(client: PoolClient, userId: string, requestId?: string): Promise<void> {
  const result = await client.query(
    `INSERT INTO wallets (user_id, balance_paise) VALUES ($1, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  if (result.rowCount === 0) {
    // rowCount 0 means the wallet already existed. An ON CONFLICT upsert can't
    // distinguish a genuine concurrent race-loser from a wallet that was simply
    // already present, so this is logged at debug (not asserted as a race).
    logger.debug('wallet.create_skipped', { requestId, userId });
  }
}

export async function getBalance(userId: string): Promise<string | null> {
  const db = getPool();
  const result = await db.query<WalletRow>('SELECT balance_paise FROM wallets WHERE user_id = $1', [userId]);
  return result.rows[0] ? result.rows[0].balance_paise : null;
}
