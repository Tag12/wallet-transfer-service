import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import app from '../src/app';
import { getPool, closePool } from '../src/common/db/db';
import { getOrCreateWallet } from '../src/services/wallet.service';
import { createTransfer, AppError } from '../src/services/transfer.service';
import { setupTestDb, truncateAll, signToken, randomUserId, fundWalletDirectly } from './testHelpers';

beforeAll(async () => {
  await setupTestDb();
});

afterEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closePool();
});

async function createAccountAndFund(userId: string, amountPaise: number): Promise<void> {
  const token = signToken(userId);
  await request(app).post('/accounts').set('Authorization', `Bearer ${token}`).expect(200);
  await fundWalletDirectly(userId, amountPaise);
}

describe('service-level: get-or-create + transfer race', () => {
  it('creates each wallet exactly once under concurrent first-transfers between a brand-new pair', async () => {
    const from = randomUserId();
    const to = randomUserId();
    await getOrCreateWallet(from);
    await getPool().query('UPDATE wallets SET balance_paise = 10000 WHERE user_id = $1', [from]);

    const attempts = Array.from({ length: 10 }, () => createTransfer(from, to, 50, uuidv4()));
    await Promise.all(attempts);

    const wallets = await getPool().query('SELECT * FROM wallets WHERE user_id = $1', [to]);
    expect(wallets.rowCount).toBe(1); // never two wallet rows, never a 500
    expect(wallets.rows[0].balance_paise).toBe('500');
  });

  it('conserves total money across a concurrent burst of transfers and retries', async () => {
    const from = randomUserId();
    const to = randomUserId();
    await getOrCreateWallet(from);
    await getPool().query('UPDATE wallets SET balance_paise = 10000 WHERE user_id = $1', [from]);
    await getOrCreateWallet(to);

    const uniqueTransfers = Array.from({ length: 10 }, () => createTransfer(from, to, 100, uuidv4()));
    const retryKey = uuidv4();
    const retries = Array.from({ length: 10 }, () => createTransfer(from, to, 250, retryKey));

    await Promise.all([...uniqueTransfers, ...retries]);

    const fromBalance = await getPool().query('SELECT balance_paise FROM wallets WHERE user_id = $1', [from]);
    const toBalance = await getPool().query('SELECT balance_paise FROM wallets WHERE user_id = $1', [to]);
    const total = BigInt(fromBalance.rows[0].balance_paise) + BigInt(toBalance.rows[0].balance_paise);
    expect(total).toBe(10000n); // conservation: nothing lost or created
    // 10 unique transfers of 100 + exactly one retry group of 250 applied once = 1250 moved
    expect(fromBalance.rows[0].balance_paise).toBe('8750');
  });
});

describe('service-level: bidirectional first-transfers between a brand-new pair', () => {
  it('does not deadlock when concurrent first-transfers go in both directions (A->B and B->A)', async () => {
    const userA = randomUserId();
    const userB = randomUserId();
    // Neither wallet is pre-created here, deliberately: the deadlock this reproduces
    // requires BOTH rows to be genuinely brand-new when the race starts. Pre-creating
    // either one (e.g. via getOrCreateWallet to fund it) turns its creation into a fast
    // no-op conflict-check instead of a contested new-row insert, which accidentally
    // eliminates the exact race condition being tested for. Funding isn't needed to
    // reproduce it either: the deadlock happens during wallet creation/locking, before
    // the balance check runs, so it doesn't matter that every attempt here ultimately
    // gets rejected for insufficient funds — what matters is both directions racing to
    // create/lock the SAME two rows at once.

    const aToB = Array.from({ length: 10 }, () => createTransfer(userA, userB, 50, uuidv4()));
    const bToA = Array.from({ length: 10 }, () => createTransfer(userB, userA, 50, uuidv4()));

    const results = await Promise.allSettled([...aToB, ...bToA]);

    const unexpectedErrors = results.filter(
      (r) => r.status === 'rejected' && !(r.reason instanceof AppError),
    );
    expect(unexpectedErrors).toEqual([]); // no deadlock (40P01) or other non-AppError failure

    const wallets = await getPool().query('SELECT * FROM wallets WHERE user_id IN ($1, $2)', [userA, userB]);
    expect(wallets.rowCount).toBe(2); // exactly one row each, never duplicated, never a 500
  });
});

describe('HTTP-level: concurrent burst against the live app', () => {
  it('handles many concurrent first-transfers between two brand-new users: exactly-once wallet creation, no 500s, conserved total', async () => {
    const from = randomUserId();
    const to = randomUserId();
    const fromToken = signToken(from);
    await createAccountAndFund(from, 10000);

    const idempotencyKeys = Array.from({ length: 15 }, () => uuidv4());
    const responses = await Promise.all(
      idempotencyKeys.map((key) =>
        request(app)
          .post('/transfers')
          .set('Authorization', `Bearer ${fromToken}`)
          .send({ to_user: to, amount_paise: 100, idempotency_key: key }),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    const toWallets = await getPool().query('SELECT balance_paise FROM wallets WHERE user_id = $1', [to]);
    expect(toWallets.rowCount).toBe(1); // exactly one wallet row created despite 15 concurrent first-transfers
    expect(toWallets.rows[0].balance_paise).toBe('1500');

    const fromWallet = await getPool().query('SELECT balance_paise FROM wallets WHERE user_id = $1', [from]);
    const total = BigInt(fromWallet.rows[0].balance_paise) + BigInt(toWallets.rows[0].balance_paise);
    expect(total).toBe(10000n); // conservation: nothing lost or created
  });

  it('applies many concurrent retries of the same idempotency key exactly once', async () => {
    const from = randomUserId();
    const to = randomUserId();
    const fromToken = signToken(from);
    await createAccountAndFund(from, 10000);

    const retryKey = uuidv4();
    const retryResponses = await Promise.all(
      Array.from({ length: 15 }, () =>
        request(app)
          .post('/transfers')
          .set('Authorization', `Bearer ${fromToken}`)
          .send({ to_user: to, amount_paise: 250, idempotency_key: retryKey }),
      ),
    );

    for (const res of retryResponses) {
      expect(res.status).toBe(200);
    }
    const transferIds = new Set(retryResponses.map((r) => r.body.transfer_id));
    expect(transferIds.size).toBe(1); // every retry returns the exact same transfer

    const fromWallet = await getPool().query('SELECT balance_paise FROM wallets WHERE user_id = $1', [from]);
    expect(fromWallet.rows[0].balance_paise).toBe('9750'); // moved exactly once, not 15 times
  });
});
