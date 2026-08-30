import { getPool } from '../src/common/db/db';
import { getOrCreateWallet, ensureWalletExists, getBalance } from '../src/services/wallet.service';
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

describe('getOrCreateWallet', () => {
  it('creates a new wallet with a zero balance', async () => {
    const userId = randomUserId();
    const wallet = await getOrCreateWallet(userId);
    expect(wallet.user_id).toBe(userId);
    expect(wallet.balance_paise).toBe('0');
  });

  it('is idempotent — calling twice returns the same wallet, never two rows', async () => {
    const userId = randomUserId();
    await getOrCreateWallet(userId);
    await getOrCreateWallet(userId);

    const rows = await getPool().query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
    expect(rows.rowCount).toBe(1);
  });
});

describe('ensureWalletExists', () => {
  it('creates the wallet if absent, within a caller-provided transaction', async () => {
    const userId = randomUserId();
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await ensureWalletExists(client, userId);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const rows = await getPool().query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].balance_paise).toBe('0');
  });

  it('is a no-op if the wallet already exists, and does not reset its balance', async () => {
    const userId = randomUserId();
    await getOrCreateWallet(userId);
    await getPool().query('UPDATE wallets SET balance_paise = 500 WHERE user_id = $1', [userId]);

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await ensureWalletExists(client, userId);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const rows = await getPool().query('SELECT balance_paise FROM wallets WHERE user_id = $1', [userId]);
    expect(rows.rows[0].balance_paise).toBe('500');
  });
});

describe('getBalance', () => {
  it('returns the current balance for an existing wallet', async () => {
    const userId = randomUserId();
    await getOrCreateWallet(userId);
    await getPool().query('UPDATE wallets SET balance_paise = 750 WHERE user_id = $1', [userId]);

    const balance = await getBalance(userId);
    expect(balance).toBe('750');
  });

  it('returns null when no wallet exists for the user', async () => {
    const balance = await getBalance(randomUserId());
    expect(balance).toBeNull();
  });
});
