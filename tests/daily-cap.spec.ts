import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import app from '../src/app';
import { getPool, closePool } from '../src/common/db/db';
import { getOrCreateWallet } from '../src/services/wallet.service';
import { createTransfer, AppError } from '../src/services/transfer.service';
import { ErrorCode } from '../src/shared/enums/error-code.enum';
import { setupTestDb, truncateAll, randomUserId, fundWalletDirectly, signToken } from './testHelpers';

// Default cap is 500000 paise (₹5,000); the service reads DAILY_CAP_PAISE at import,
// so these tests assume the default. Senders are funded well above the cap so that
// the *cap*, not the balance, is always the limiting factor.
const CAP = 500000n;

beforeAll(async () => {
  await setupTestDb();
});

afterEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closePool();
});

async function sumSuccessful(userId: string): Promise<bigint> {
  const res = await getPool().query(
    `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS s
     FROM transfers WHERE from_user = $1 AND status = 'successful'`,
    [userId],
  );
  return BigInt(res.rows[0].s);
}

describe('daily send cap', () => {
  it('lets exactly the cap through under a concurrent burst (spent 490k, 5x 100 → only 1 applies)', async () => {
    const from = randomUserId();
    const to = randomUserId();
    await getOrCreateWallet(from);
    await fundWalletDirectly(from, 100_000_000); // balance never the constraint

    // Pre-spend to 490000, leaving exactly one 10000 transfer of headroom.
    await createTransfer(from, to, 490_000, uuidv4());

    // 5 concurrent transfers of 10000; only the first can fit (490000 + 10000 = 500000).
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => createTransfer(from, to, 10_000, uuidv4())),
    );

    const applied = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(applied.length).toBe(1); // exactly one gets through
    expect(rejected.length).toBe(4); // the rest are cleanly declined
    for (const r of rejected as PromiseRejectedResult[]) {
      expect(r.reason).toBeInstanceOf(AppError);
      expect((r.reason as AppError).code).toBe(ErrorCode.DAILY_CAP_EXCEEDED);
      expect((r.reason as AppError).status).toBe(429);
    }

    // Total successful sends land exactly on the cap — never over.
    expect(await sumSuccessful(from)).toBe(CAP);
  });

  it('allows a transfer that lands exactly on the cap, rejects the next paise', async () => {
    const from = randomUserId();
    const to = randomUserId();
    await getOrCreateWallet(from);
    await fundWalletDirectly(from, 100_000_000);

    const ok = await createTransfer(from, to, 500_000, uuidv4()); // exactly the cap
    expect(ok.transferId).toBeDefined();

    await expect(createTransfer(from, to, 1, uuidv4())).rejects.toMatchObject({
      code: ErrorCode.DAILY_CAP_EXCEEDED,
      status: 429,
    });
    expect(await sumSuccessful(from)).toBe(CAP);
  });

  it('replays a cap rejection idempotently (same key → same 429, still not applied)', async () => {
    const from = randomUserId();
    const to = randomUserId();
    await getOrCreateWallet(from);
    await fundWalletDirectly(from, 100_000_000);
    await createTransfer(from, to, 500_000, uuidv4()); // now at the cap

    const key = uuidv4();
    await expect(createTransfer(from, to, 100, key)).rejects.toMatchObject({
      code: ErrorCode.DAILY_CAP_EXCEEDED,
    });
    // Retry with the same key replays the frozen rejection — no late success.
    await expect(createTransfer(from, to, 100, key)).rejects.toMatchObject({
      code: ErrorCode.DAILY_CAP_EXCEEDED,
    });
    expect(await sumSuccessful(from)).toBe(CAP);
  });

  it('exempts system accounts (faucet) from the cap', async () => {
    const to = randomUserId();
    await fundWalletDirectly('faucet', 100_000_000_000);

    // A single send far larger than the cap succeeds for an exempt account.
    const r = await createTransfer('faucet', to, 1_000_000, uuidv4());
    expect(r.transferId).toBeDefined();
    expect(await sumSuccessful('faucet')).toBe(1_000_000n);
  });

  it('does not count sends older than the rolling 24h window', async () => {
    const from = randomUserId();
    const to = randomUserId();
    await getOrCreateWallet(from);
    await fundWalletDirectly(from, 100_000_000);

    // A 400k successful send aged 25h — outside the rolling window, must not count.
    await getPool().query(
      `INSERT INTO transfers (from_user, to_user, amount_paise, idempotency_key, request_hash, status, resulting_balance_paise, created_at)
       VALUES ($1, $2, 400000, $3, 'x', 'successful', 0, now() - interval '25 hours')`,
      [from, to, uuidv4()],
    );

    // A fresh 400k succeeds — proves the 25h-old send didn't count (else 400k+400k > cap).
    expect((await createTransfer(from, to, 400_000, uuidv4())).transferId).toBeDefined();
    // In-window spend is now 400k: +200k would exceed, +100k lands exactly on the cap.
    await expect(createTransfer(from, to, 200_000, uuidv4())).rejects.toMatchObject({
      code: ErrorCode.DAILY_CAP_EXCEEDED,
    });
    expect((await createTransfer(from, to, 100_000, uuidv4())).transferId).toBeDefined();
  });

  it('does not let a replayed success consume extra quota', async () => {
    const from = randomUserId();
    const to = randomUserId();
    await getOrCreateWallet(from);
    await fundWalletDirectly(from, 100_000_000);

    const key = uuidv4();
    await createTransfer(from, to, 300_000, key); // spent 300k
    await createTransfer(from, to, 300_000, key); // replay → no new row, no new spend
    // 300k + 200k = 500k still fits (replay didn't eat 300k of headroom).
    expect((await createTransfer(from, to, 200_000, uuidv4())).transferId).toBeDefined();
    expect(await sumSuccessful(from)).toBe(CAP);
  });

  it('a declined transfer consumes no quota; a smaller one still fits', async () => {
    const from = randomUserId();
    const to = randomUserId();
    await getOrCreateWallet(from);
    await fundWalletDirectly(from, 100_000_000);

    await createTransfer(from, to, 490_000, uuidv4()); // spent 490k
    await expect(createTransfer(from, to, 20_000, uuidv4())).rejects.toMatchObject({
      code: ErrorCode.DAILY_CAP_EXCEEDED, // 490k + 20k > cap
    });
    // The decline consumed nothing, so a 10k transfer still fits (490k + 10k = 500k).
    expect((await createTransfer(from, to, 10_000, uuidv4())).transferId).toBeDefined();
    expect(await sumSuccessful(from)).toBe(CAP);
  });

  it('returns HTTP 429 with DAILY_CAP_EXCEEDED at the API layer', async () => {
    const from = randomUserId();
    const to = randomUserId();
    const token = signToken(from);
    await getOrCreateWallet(from);
    await fundWalletDirectly(from, 100_000_000);
    await createTransfer(from, to, 500_000, uuidv4()); // at the cap

    const res = await request(app)
      .post('/transfers')
      .set('Authorization', `Bearer ${token}`)
      .send({ to_user: to, amount_paise: 100, idempotency_key: uuidv4() });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe(ErrorCode.DAILY_CAP_EXCEEDED);
  });

  it('applies per-sender across all recipients and independently of other users', async () => {
    const A = randomUserId();
    const B = randomUserId();
    const C = randomUserId();
    await getOrCreateWallet(A);
    await fundWalletDirectly(A, 100_000_000);

    // A's sends to different recipients both count toward A's single cap.
    await createTransfer(A, B, 300_000, uuidv4());
    await createTransfer(A, C, 200_000, uuidv4()); // 300k + 200k = 500k (different recipient)
    await expect(createTransfer(A, B, 1, uuidv4())).rejects.toMatchObject({
      code: ErrorCode.DAILY_CAP_EXCEEDED,
    });
    expect(await sumSuccessful(A)).toBe(CAP);

    // C has its own independent cap, unaffected by A hitting theirs.
    await fundWalletDirectly(C, 100_000_000);
    expect((await createTransfer(C, B, 500_000, uuidv4())).transferId).toBeDefined();
  });
});
