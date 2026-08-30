import request from 'supertest';
import app from '../src/app';
import { closePool } from '../src/common/db/db';
import { setupTestDb, truncateAll } from './testHelpers';

beforeAll(async () => {
  await setupTestDb();
});

afterEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closePool();
});

describe('GET /healthz', () => {
  it('always returns 200', async () => {
    const res = await request(app).get('/healthz').expect(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('GET /readyz', () => {
  it('returns 200 when the datastore is reachable', async () => {
    const res = await request(app).get('/readyz').expect(200);
    expect(res.body.status).toBe('ready');
  });
});

describe('GET /metrics', () => {
  it('returns plaintext metrics including request count and transfer outcome counters', async () => {
    await request(app).get('/healthz'); // generate at least one recorded request
    const res = await request(app).get('/metrics').expect(200);
    expect(res.text).toContain('request_count');
    expect(res.text).toContain('latency_p99_ms');
    expect(res.text).toContain('transfers_applied');
    expect(res.text).toContain('transfers_rejected');
  });
});
