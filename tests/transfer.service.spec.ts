import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../src/common/db/db';
import { getOrCreateWallet } from '../src/services/wallet.service';
import { createTransfer, getTransferById, AppError } from '../src/services/transfer.service';
import { ErrorCode } from '../src/shared/enums/error-code.enum';
import { setupTestDb, truncateAll, teardownTestDb, randomUserId } from './testHelpers';

beforeAll(async () => {
  await setupTestDb();
});

afterEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await teardownTestDb();
});

async function fundWallet(userId: string, amountPaise: number): Promise<void> {
  await getOrCreateWallet(userId);
  await getPool().query('UPDATE wallets SET balance_paise = $1 WHERE user_id = $2', [amountPaise, userId]);
}

describe('createTransfer', () => {
  it('moves funds and creates the recipient wallet as part of the transfer', async () => {
    const from = randomUserId();
    const to = randomUserId();
    await fundWallet(from, 1000);

    const result = await createTransfer(from, to, 300, uuidv4());

    expect(result.newBalance).toBe('700');
    const toBalance = await getPool().query('SELECT balance_paise FROM wallets WHERE user_id = $1', [to]);
    expect(toBalance.rows[0].balance_paise).toBe('300');
  });

  it('rejects insufficient funds without mutating balances', async () => {
    const from = randomUserId();
    const to = randomUserId();
    await fundWallet(from, 100);

    await expect(createTransfer(from, to, 500, uuidv4())).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_FUNDS,
      status: 402,
    });

    const fromBalance = await getPool().query('SELECT balance_paise FROM wallets WHERE user_id = $1', [from]);
    expect(fromBalance.rows[0].balance_paise).toBe('100');
    // The transaction now COMMITS on a deterministic rejection (so the decision can be
    // replayed later) — only the balance mutation is skipped, not the whole transaction.
    // The to_user wallet, created earlier in the same transaction, survives the commit.
    const toWallet = await getPool().query('SELECT 1 FROM wallets WHERE user_id = $1', [to]);
    expect(toWallet.rowCount).toBe(1);
  });

  it('freezes an insufficient-funds rejection — retrying the same key still returns 402 even after funds arrive', async () => {
    const from = randomUserId();
    const to = randomUserId();
    await fundWallet(from, 100);
    const key = uuidv4();

    await expect(createTransfer(from, to, 500, key)).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_FUNDS,
      status: 402,
    });

    // Top up — plenty of funds now.
    await getPool().query('UPDATE wallets SET balance_paise = 10000 WHERE user_id = $1', [from]);

    // Same key, same body: must still replay the frozen rejection, not succeed.
    await expect(createTransfer(from, to, 500, key)).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_FUNDS,
      status: 402,
    });
    const fromBalance = await getPool().query('SELECT balance_paise FROM wallets WHERE user_id = $1', [from]);
    expect(fromBalance.rows[0].balance_paise).toBe('10000'); // untouched by the replayed rejection
  });

  it('allows a genuinely new attempt (new idempotency_key) to succeed after a prior rejection and a top-up', async () => {
    const from = randomUserId();
    const to = randomUserId();
    await fundWallet(from, 100);

    await expect(createTransfer(from, to, 500, uuidv4())).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_FUNDS,
      status: 402,
    });

    await getPool().query('UPDATE wallets SET balance_paise = 10000 WHERE user_id = $1', [from]);

    const result = await createTransfer(from, to, 500, uuidv4()); // new key = new attempt
    expect(result.newBalance).toBe('9500');
  });

  it('replays an identical retry without moving money twice', async () => {
    const from = randomUserId();
    const to = randomUserId();
    await fundWallet(from, 1000);
    const key = uuidv4();

    const first = await createTransfer(from, to, 300, key);
    const second = await createTransfer(from, to, 300, key);

    expect(second.transferId).toBe(first.transferId);
    expect(second.newBalance).toBe('700');
    const fromBalance = await getPool().query('SELECT balance_paise FROM wallets WHERE user_id = $1', [from]);
    expect(fromBalance.rows[0].balance_paise).toBe('700');
  });

  it('replays the balance captured at the original commit, not a live re-read, when an unrelated transfer happens in between', async () => {
    const from = randomUserId();
    const to = randomUserId();
    const otherTo = randomUserId();
    await fundWallet(from, 1000);
    const key = uuidv4();

    const original = await createTransfer(from, to, 300, key); // balance -> 700
    expect(original.newBalance).toBe('700');

    await createTransfer(from, otherTo, 200, uuidv4()); // unrelated transfer, balance -> 500

    const replay = await createTransfer(from, to, 300, key);
    expect(replay.transferId).toBe(original.transferId);
    expect(replay.newBalance).toBe('700'); // original outcome, not the current balance (500)

    const currentBalance = await getPool().query('SELECT balance_paise FROM wallets WHERE user_id = $1', [from]);
    expect(currentBalance.rows[0].balance_paise).toBe('500'); // current balance has moved on independently
  });

  it('rejects a same-key-different-body retry with 409', async () => {
    const from = randomUserId();
    const to = randomUserId();
    const otherTo = randomUserId();
    await fundWallet(from, 1000);
    const key = uuidv4();

    await createTransfer(from, to, 300, key);

    await expect(createTransfer(from, otherTo, 300, key)).rejects.toMatchObject({
      code: ErrorCode.IDEMPOTENCY_CONFLICT,
      status: 409,
    });
  });

  it('scopes idempotency keys per-caller, not globally', async () => {
    const userA = randomUserId();
    const userB = randomUserId();
    const recipient = randomUserId();
    await fundWallet(userA, 1000);
    await fundWallet(userB, 1000);
    const sharedKey = 'same-literal-key';

    const resultA = await createTransfer(userA, recipient, 100, sharedKey);
    const resultB = await createTransfer(userB, recipient, 200, sharedKey);

    expect(resultA.transferId).not.toBe(resultB.transferId);
    const recipientBalance = await getPool().query('SELECT balance_paise FROM wallets WHERE user_id = $1', [recipient]);
    expect(recipientBalance.rows[0].balance_paise).toBe('300');
  });
});

describe('getTransferById', () => {
  it('returns the persisted transfer', async () => {
    const from = randomUserId();
    const to = randomUserId();
    await fundWallet(from, 1000);

    const result = await createTransfer(from, to, 300, uuidv4());
    const fetched = await getTransferById(result.transferId);

    expect(fetched).not.toBeNull();
    expect(fetched?.from_user).toBe(from);
    expect(fetched?.to_user).toBe(to);
    expect(fetched?.amount_paise).toBe('300');
  });

  it('returns null for a non-existent transfer id', async () => {
    const fetched = await getTransferById(uuidv4());
    expect(fetched).toBeNull();
  });
});

describe('AppError', () => {
  it('carries the error code and http status', () => {
    const err = new AppError(ErrorCode.INSUFFICIENT_FUNDS, 402);
    expect(err.code).toBe(ErrorCode.INSUFFICIENT_FUNDS);
    expect(err.status).toBe(402);
  });

  it('optionally carries the transfer id of the rejected record', () => {
    const err = new AppError(ErrorCode.INSUFFICIENT_FUNDS, 402, 'some-id');
    expect(err.transferId).toBe('some-id');
  });
});
