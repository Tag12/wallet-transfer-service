import { getPool, withTransaction } from '../common/db/db';
import { ensureWalletExists } from './wallet.service';
import { hashTransferRequest } from '../common/utils/hash';
import { TransferRow } from '../interfaces/transfer.interface';
import { WalletRow } from '../interfaces/wallet.interface';
import { ErrorCode } from '../shared/enums/error-code.enum';
import { logger } from '../common/logger';

// Per-sender rolling-24h send cap (integer paise). Default 5,000.00 (= 500000 paise).
const DAILY_CAP_PAISE = BigInt(process.env.DAILY_CAP_PAISE ?? '500000');
// System/treasury accounts exempt from the per-user cap (e.g. the funding faucet,
// which moves more than the cap in a single transfer). Comma-separated user ids.
const CAP_EXEMPT = new Set(
  (process.env.CAP_EXEMPT_USERS ?? 'faucet').split(',').map((s) => s.trim()).filter(Boolean),
);

export interface CreateTransferResult {
  transferId: string;
  newBalance: string;
}

type TxResult =
  | { outcome: 'successful'; transferId: string; newBalance: string }
  | { outcome: 'rejected'; transferId: string; errorCode: ErrorCode; errorStatus: number };

export async function createTransfer(
  fromUser: string,
  toUser: string,
  amountPaise: number,
  idempotencyKey: string,
  requestId?: string,
): Promise<CreateTransferResult> {
  const requestHash = hashTransferRequest(toUser, amountPaise);

  const result = await withTransaction<TxResult>(async (client) => {
    // Step 1: idempotency guard is the FIRST statement, before any wallet mutation.
    // Wrapped in a SAVEPOINT so a unique-violation (23505) can be rolled back to
    // without aborting the whole transaction — Postgres poisons the tx on any
    // error until a ROLLBACK/ROLLBACK TO SAVEPOINT is issued.
    let transferId: string;
    await client.query('SAVEPOINT idempotency_insert');
    try {
      const inserted = await client.query<TransferRow>(
        `INSERT INTO transfers (from_user, to_user, amount_paise, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [fromUser, toUser, amountPaise, idempotencyKey, requestHash],
      );
      transferId = inserted.rows[0].id;
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        await client.query('ROLLBACK TO SAVEPOINT idempotency_insert');
        const existing = await client.query<TransferRow>(
          'SELECT * FROM transfers WHERE from_user = $1 AND idempotency_key = $2',
          [fromUser, idempotencyKey],
        );
        const row = existing.rows[0];
        if (row.request_hash !== requestHash) {
          logger.info('transfer.conflict', { requestId, fromUser, idempotencyKey });
          throw new AppError(ErrorCode.IDEMPOTENCY_CONFLICT, 409);
        }
        // Replay the frozen original decision — successful or rejected — never
        // re-evaluate against current state. A caller who wants a genuinely new
        // attempt (e.g. after topping up) must use a new idempotency_key.
        if (row.status === 'rejected') {
          logger.info('transfer.replay', { requestId, fromUser, transferId: row.id, status: 'rejected' });
          return {
            outcome: 'rejected',
            transferId: row.id,
            errorCode: row.error_code as ErrorCode,
            errorStatus: row.error_status as number,
          };
        }
        logger.info('transfer.replay', { requestId, fromUser, transferId: row.id, status: 'successful' });
        return {
          outcome: 'successful',
          transferId: row.id,
          newBalance: row.resulting_balance_paise as string,
        };
      }
      throw err;
    }

    // Step 2 & 3 both use the SAME sorted order — computed once here — for wallet
    // creation and locking. ensureWalletExists's INSERT ON CONFLICT DO NOTHING takes
    // an implicit lock on the target row even when it's a no-op, so creating in
    // (from, to) order while locking in sorted order would reintroduce exactly the
    // AB-BA deadlock this sorting exists to prevent: two concurrent first-transfers
    // in opposite directions between the same brand-new pair would each create their
    // "from" row first, then block on the other's uncommitted "to" row, and vice versa.
    const [first, second] = [fromUser, toUser].sort();
    await ensureWalletExists(client, first, requestId);
    await ensureWalletExists(client, second, requestId);

    const rows = await client.query<WalletRow>(
      'SELECT * FROM wallets WHERE user_id IN ($1, $2) ORDER BY user_id FOR UPDATE',
      [first, second],
    );
    const fromRow = rows.rows.find((r) => r.user_id === fromUser) as WalletRow;
    const toRow = rows.rows.find((r) => r.user_id === toUser) as WalletRow;

    const fromBalance = BigInt(fromRow.balance_paise);
    const amount = BigInt(amountPaise);

    if (fromBalance < amount) {
      // Committed, not thrown: a deterministic business-rule rejection is a decided
      // outcome, same as a success — it must be frozen and replayed identically on
      // retry, not silently succeed later just because the balance changed. Throwing
      // here would roll back this UPDATE along with the idempotency-guard insert
      // above, which is exactly what makes rejections non-idempotent today.
      await client.query(
        'UPDATE transfers SET status = $1, error_code = $2, error_status = $3 WHERE id = $4',
        ['rejected', ErrorCode.INSUFFICIENT_FUNDS, 402, transferId],
      );
      logger.info('transfer.rejected.insufficient_funds', { requestId, fromUser, amountPaise, transferId });
      return { outcome: 'rejected', transferId, errorCode: ErrorCode.INSUFFICIENT_FUNDS, errorStatus: 402 };
    }

    // Daily cap: sum the sender's already-committed successful sends in the rolling
    // 24h window and reject if this transfer would push them over the cap. This is
    // race-free without any new lock because we already hold the sender's wallet row
    // FOR UPDATE above, which serializes all of this sender's concurrent transfers —
    // so `spent` cannot change between this read and our commit. Strict `>` lets a
    // transfer that lands exactly on the cap through. System accounts are exempt.
    if (!CAP_EXEMPT.has(fromUser)) {
      const spentRes = await client.query<{ spent: string }>(
        `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS spent
         FROM transfers
         WHERE from_user = $1 AND status = 'successful' AND created_at > now() - interval '24 hours'`,
        [fromUser],
      );
      const spent = BigInt(spentRes.rows[0].spent);
      if (spent + amount > DAILY_CAP_PAISE) {
        await client.query(
          'UPDATE transfers SET status = $1, error_code = $2, error_status = $3 WHERE id = $4',
          ['rejected', ErrorCode.DAILY_CAP_EXCEEDED, 429, transferId],
        );
        logger.info('transfer.rejected.daily_cap', {
          requestId,
          fromUser,
          amountPaise,
          transferId,
          spent: spent.toString(),
          cap: DAILY_CAP_PAISE.toString(),
        });
        return { outcome: 'rejected', transferId, errorCode: ErrorCode.DAILY_CAP_EXCEEDED, errorStatus: 429 };
      }
    }

    await client.query('UPDATE wallets SET balance_paise = balance_paise - $1 WHERE user_id = $2', [
      amountPaise,
      fromUser,
    ]);
    await client.query('UPDATE wallets SET balance_paise = balance_paise + $1 WHERE user_id = $2', [
      amountPaise,
      toUser,
    ]);

    const newBalance = (fromBalance - amount).toString();
    await client.query('UPDATE transfers SET status = $1, resulting_balance_paise = $2 WHERE id = $3', [
      'successful',
      newBalance,
      transferId,
    ]);
    logger.info('transfer.applied', { requestId, transferId, fromUser, toUser, amountPaise });
    return { outcome: 'successful', transferId, newBalance };
  });

  // Thrown after the transaction has already committed (either outcome) — this
  // shapes the HTTP response only, it carries no rollback risk.
  if (result.outcome === 'rejected') {
    throw new AppError(result.errorCode, result.errorStatus, result.transferId);
  }
  return { transferId: result.transferId, newBalance: result.newBalance };
}

export async function getTransferById(id: string): Promise<TransferRow | null> {
  const db = getPool();
  const result = await db.query<TransferRow>('SELECT * FROM transfers WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

export class AppError extends Error {
  constructor(public code: ErrorCode, public status: number, public transferId?: string) {
    super(code);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
