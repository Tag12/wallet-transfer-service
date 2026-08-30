import request from 'supertest';
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

describe('auth', () => {
  it('rejects requests with no token', async () => {
    await request(app).get('/accounts/me').expect(401);
  });

  it('rejects requests with an invalid token', async () => {
    await request(app).get('/accounts/me').set('Authorization', 'Bearer garbage').expect(401);
  });
});

describe('POST /accounts', () => {
  it('creates a wallet with a zero balance for a brand-new user', async () => {
    const token = signToken(randomUserId());
    const res = await request(app).post('/accounts').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.balance).toBe('0');
  });

  it('is idempotent — calling twice returns the same wallet, never two', async () => {
    const userId = randomUserId();
    const token = signToken(userId);

    const first = await request(app).post('/accounts').set('Authorization', `Bearer ${token}`).expect(200);
    const second = await request(app).post('/accounts').set('Authorization', `Bearer ${token}`).expect(200);

    expect(first.body.balance).toBe('0');
    expect(second.body.balance).toBe('0');
  });
});

describe('GET /accounts/me', () => {
  it('returns the current balance for an existing wallet', async () => {
    const userId = randomUserId();
    const token = signToken(userId);
    await request(app).post('/accounts').set('Authorization', `Bearer ${token}`).expect(200);
    await fundWalletDirectly(userId, 4200);

    const res = await request(app).get('/accounts/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.balance).toBe('4200');
  });

  it('returns balance 0 for a caller who has never created a wallet', async () => {
    const token = signToken(randomUserId());
    const res = await request(app).get('/accounts/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.balance).toBe('0');
  });
});
