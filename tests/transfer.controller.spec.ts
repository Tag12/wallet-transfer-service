import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import app from '../src/app';
import { closePool } from '../src/common/db/db';
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

describe('POST /transfers identity', () => {
  it('never trusts a client-supplied identity — caller identity comes only from the token', async () => {
    const userA = randomUserId();
    const userB = randomUserId();
    const tokenA = signToken(userA);

    const res = await request(app)
      .post('/transfers')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ to_user: userB, amount_paise: 100, idempotency_key: uuidv4(), from_user: userB })
      .expect(402); // insufficient funds for userA, proving from_user body field was ignored, not honored as userB
    expect(res.body.error).toBe('INSUFFICIENT_FUNDS');
  });
});

describe('POST /transfers validation', () => {
  it('rejects a missing to_user', async () => {
    const token = signToken(randomUserId());
    const res = await request(app)
      .post('/transfers')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount_paise: 100, idempotency_key: uuidv4() })
      .expect(400);
    expect(res.body.error).toBe('MISSING_FIELD');
  });

  it('rejects a missing idempotency_key', async () => {
    const token = signToken(randomUserId());
    const res = await request(app)
      .post('/transfers')
      .set('Authorization', `Bearer ${token}`)
      .send({ to_user: randomUserId(), amount_paise: 100 })
      .expect(400);
    expect(res.body.error).toBe('MISSING_FIELD');
  });

  it('rejects self-transfer', async () => {
    const userId = randomUserId();
    const token = signToken(userId);
    await createAccountAndFund(userId, 1000);

    const res = await request(app)
      .post('/transfers')
      .set('Authorization', `Bearer ${token}`)
      .send({ to_user: userId, amount_paise: 100, idempotency_key: uuidv4() })
      .expect(400);
    expect(res.body.error).toBe('SELF_TRANSFER');
  });

  it('rejects zero and negative amounts', async () => {
    const userId = randomUserId();
    const token = signToken(userId);
    const to = randomUserId();

    for (const amount of [0, -50]) {
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${token}`)
        .send({ to_user: to, amount_paise: amount, idempotency_key: uuidv4() })
        .expect(400);
      expect(res.body.error).toBe('INVALID_AMOUNT');
    }
  });

  it('rejects insufficient funds for an unfunded caller against an unknown recipient, returning the transfer_id of the rejected record', async () => {
    const userId = randomUserId();
    const token = signToken(userId);
    const to = randomUserId();

    const res = await request(app)
      .post('/transfers')
      .set('Authorization', `Bearer ${token}`)
      .send({ to_user: to, amount_paise: 100, idempotency_key: uuidv4() })
      .expect(402);
    expect(res.body.error).toBe('INSUFFICIENT_FUNDS');
    expect(res.body.transfer_id).toBeTruthy();
  });
});

describe('POST /transfers idempotent rejection', () => {
  it('freezes an insufficient-funds rejection under the same key even after the caller is funded', async () => {
    const userId = randomUserId();
    const token = signToken(userId);
    const to = randomUserId();
    const key = uuidv4();

    await request(app)
      .post('/transfers')
      .set('Authorization', `Bearer ${token}`)
      .send({ to_user: to, amount_paise: 100, idempotency_key: key })
      .expect(402);

    await createAccountAndFund(userId, 10000);

    const retry = await request(app)
      .post('/transfers')
      .set('Authorization', `Bearer ${token}`)
      .send({ to_user: to, amount_paise: 100, idempotency_key: key })
      .expect(402);
    expect(retry.body.error).toBe('INSUFFICIENT_FUNDS');
  });

  it('lets a new idempotency_key succeed after a prior rejection and a top-up', async () => {
    const userId = randomUserId();
    const token = signToken(userId);
    const to = randomUserId();

    await request(app)
      .post('/transfers')
      .set('Authorization', `Bearer ${token}`)
      .send({ to_user: to, amount_paise: 100, idempotency_key: uuidv4() })
      .expect(402);

    await createAccountAndFund(userId, 10000);

    await request(app)
      .post('/transfers')
      .set('Authorization', `Bearer ${token}`)
      .send({ to_user: to, amount_paise: 100, idempotency_key: uuidv4() })
      .expect(200);
  });
});

describe('POST /transfers unknown recipient', () => {
  it('auto-creates the recipient wallet as part of a successful transfer', async () => {
    const from = randomUserId();
    const to = randomUserId();
    await createAccountAndFund(from, 1000);
    const token = signToken(from);

    const res = await request(app)
      .post('/transfers')
      .set('Authorization', `Bearer ${token}`)
      .send({ to_user: to, amount_paise: 300, idempotency_key: uuidv4() })
      .expect(200);

    expect(res.body.new_balance).toBe('700');

    const recipientToken = signToken(to);
    const recipientBalance = await request(app)
      .get('/accounts/me')
      .set('Authorization', `Bearer ${recipientToken}`)
      .expect(200);
    expect(recipientBalance.body.balance).toBe('300');
  });
});

describe('GET /transfers/:id', () => {
  it('returns 404 for a non-existent transfer', async () => {
    const token = signToken(randomUserId());
    await request(app)
      .get(`/transfers/${uuidv4()}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('lets a participant read the transfer details', async () => {
    const from = randomUserId();
    const to = randomUserId();
    await createAccountAndFund(from, 1000);
    const fromToken = signToken(from);

    const created = await request(app)
      .post('/transfers')
      .set('Authorization', `Bearer ${fromToken}`)
      .send({ to_user: to, amount_paise: 300, idempotency_key: uuidv4() })
      .expect(200);

    const toToken = signToken(to);
    const fromView = await request(app)
      .get(`/transfers/${created.body.transfer_id}`)
      .set('Authorization', `Bearer ${fromToken}`)
      .expect(200);
    const toView = await request(app)
      .get(`/transfers/${created.body.transfer_id}`)
      .set('Authorization', `Bearer ${toToken}`)
      .expect(200);

    expect(fromView.body.from_user).toBe(from);
    expect(toView.body.to_user).toBe(to);
    expect(fromView.body.status).toBe('successful');
    expect(fromView.body.error_code).toBeUndefined();
  });

  it('shows a rejected transfer honestly — status rejected with its error_code, not a bare success shape', async () => {
    const from = randomUserId();
    const to = randomUserId();
    const token = signToken(from);

    const rejected = await request(app)
      .post('/transfers')
      .set('Authorization', `Bearer ${token}`)
      .send({ to_user: to, amount_paise: 100, idempotency_key: uuidv4() })
      .expect(402);

    const view = await request(app)
      .get(`/transfers/${rejected.body.transfer_id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(view.body.status).toBe('rejected');
    expect(view.body.error_code).toBe('INSUFFICIENT_FUNDS');
  });

  it('returns 403 for a caller who is not a participant in the transfer', async () => {
    const from = randomUserId();
    const to = randomUserId();
    const outsider = randomUserId();
    await createAccountAndFund(from, 1000);
    const fromToken = signToken(from);

    const created = await request(app)
      .post('/transfers')
      .set('Authorization', `Bearer ${fromToken}`)
      .send({ to_user: to, amount_paise: 300, idempotency_key: uuidv4() })
      .expect(200);

    const outsiderToken = signToken(outsider);
    await request(app)
      .get(`/transfers/${created.body.transfer_id}`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .expect(403);
  });
});
