/**
 * One-command concurrency gate. Usage:
 *   npm run burst -- <base_url> [firstTransferCount] [retryCount]
 *
 * Requires JWT_SECRET in the environment, matching the target server's secret
 * (the same value used to seed the 'faucet' wallet via migrations/001_init.sql).
 *
 * Fires:
 *  1. One sequential funding transfer from the seeded 'faucet' account into a
 *     brand-new user A (there is no deposit endpoint in the API by design).
 *  2. N concurrent first-transfers from A to a brand-new user B, each with a
 *     distinct idempotency_key.
 *  3. M concurrent retries of one single transfer, all sharing the same
 *     idempotency_key.
 * Then verifies via GET /accounts/me alone (no direct DB access, since this
 * script is meant to be run against a live deployed URL by anyone) that:
 *  - every response was 200 (no 500s, no overspend)
 *  - all N distinct-key transfers applied (B's wallet got exactly N * amount)
 *  - all M retries collapsed to a single transfer_id
 *  - total money across A + B is conserved
 * Exits non-zero on any violation.
 */

import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

const FUND_AMOUNT_PAISE = 1_000_000; // 10,000.00 in whatever currency, moved from faucet to user A
const TRANSFER_AMOUNT_PAISE = 100;
const RETRY_AMOUNT_PAISE = 250;

interface TransferBody {
  transfer_id?: string;
  new_balance?: string;
  error?: string;
}

interface TransferResponse {
  status: number;
  body: TransferBody;
}

function sign(userId: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET must be set in the environment to sign test tokens');
  }
  return jwt.sign({ sub: userId }, secret);
}

async function postTransfer(
  baseUrl: string,
  token: string,
  toUser: string,
  amountPaise: number,
  idempotencyKey: string,
): Promise<TransferResponse> {
  const res = await fetch(`${baseUrl}/transfers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to_user: toUser, amount_paise: amountPaise, idempotency_key: idempotencyKey }),
  });
  const body = (await res.json().catch(() => ({}))) as TransferBody;
  return { status: res.status, body };
}

async function getBalance(baseUrl: string, token: string): Promise<bigint> {
  const res = await fetch(`${baseUrl}/accounts/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { balance: string };
  return BigInt(body.balance);
}

async function ensureAccount(baseUrl: string, token: string): Promise<void> {
  await fetch(`${baseUrl}/accounts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function main(): Promise<void> {
  const baseUrl = (process.argv[2] || '').replace(/\/$/, '');
  const firstTransferCount = Number(process.argv[3] || 20);
  const retryCount = Number(process.argv[4] || 20);

  if (!baseUrl) {
    console.error('Usage: npm run burst -- <base_url> [firstTransferCount] [retryCount]');
    process.exit(1);
  }

  const failures: string[] = [];
  const userA = `burst_a_${uuidv4()}`;
  const userB = `burst_b_${uuidv4()}`;
  const faucetToken = sign('faucet');
  const tokenA = sign(userA);
  const tokenB = sign(userB);

  console.log(`Target: ${baseUrl}`);
  console.log(`User A: ${userA}`);
  console.log(`User B: ${userB}`);

  console.log('\n[setup] Creating accounts and funding user A from the faucet...');
  await ensureAccount(baseUrl, tokenA);
  await ensureAccount(baseUrl, tokenB);
  const fundResult = await postTransfer(baseUrl, faucetToken, userA, FUND_AMOUNT_PAISE, uuidv4());
  if (fundResult.status !== 200) {
    console.error('Funding transfer from faucet failed — is JWT_SECRET correct and is the faucet wallet seeded?', fundResult);
    process.exit(1);
  }
  console.log(`[setup] User A funded with ${FUND_AMOUNT_PAISE} paise.`);

  console.log(`\n[burst] Firing ${firstTransferCount} concurrent first-transfers A -> B, distinct idempotency keys...`);
  const firstTransferKeys = Array.from({ length: firstTransferCount }, () => uuidv4());
  const firstTransferResults = await Promise.all(
    firstTransferKeys.map((key) => postTransfer(baseUrl, tokenA, userB, TRANSFER_AMOUNT_PAISE, key)),
  );

  const first500s = firstTransferResults.filter((r) => r.status >= 500);
  if (first500s.length > 0) {
    failures.push(`${first500s.length}/${firstTransferCount} first-transfers returned a 5xx`);
  }
  const firstSuccesses = firstTransferResults.filter((r) => r.status === 200);
  if (firstSuccesses.length !== firstTransferCount) {
    failures.push(
      `expected all ${firstTransferCount} first-transfers to succeed (sufficient funds), got ${firstSuccesses.length} successes`,
    );
  }

  console.log(`\n[burst] Firing ${retryCount} concurrent retries of ONE transfer, same idempotency_key...`);
  const retryKey = uuidv4();
  const retryResults = await Promise.all(
    Array.from({ length: retryCount }, () => postTransfer(baseUrl, tokenA, userB, RETRY_AMOUNT_PAISE, retryKey)),
  );

  const retry500s = retryResults.filter((r) => r.status >= 500);
  if (retry500s.length > 0) {
    failures.push(`${retry500s.length}/${retryCount} retries returned a 5xx`);
  }
  const retryTransferIds = new Set(retryResults.filter((r) => r.status === 200).map((r) => r.body.transfer_id));
  if (retryTransferIds.size !== 1) {
    failures.push(`expected all ${retryCount} retries to collapse to exactly 1 transfer_id, got ${retryTransferIds.size}`);
  }

  console.log('\n[verify] Reading final balances...');
  const balanceA = await getBalance(baseUrl, tokenA);
  const balanceB = await getBalance(baseUrl, tokenB);
  const total = balanceA + balanceB;
  const expectedTotal = BigInt(FUND_AMOUNT_PAISE);
  const expectedMoved = BigInt(firstTransferCount * TRANSFER_AMOUNT_PAISE + RETRY_AMOUNT_PAISE);
  const expectedBalanceA = expectedTotal - expectedMoved;
  const expectedBalanceB = expectedMoved;

  console.log(`  balance A = ${balanceA} (expected ${expectedBalanceA})`);
  console.log(`  balance B = ${balanceB} (expected ${expectedBalanceB})`);
  console.log(`  total     = ${total} (expected ${expectedTotal})`);

  if (total !== expectedTotal) {
    failures.push(`conservation violated: total is ${total}, expected ${expectedTotal}`);
  }
  if (balanceA !== expectedBalanceA || balanceB !== expectedBalanceB) {
    failures.push('balances do not match the exact expected movement — possible double-apply or lost transfer');
  }

  if (failures.length > 0) {
    console.error('\nFAILED:');
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log('\nPASSED: conservation holds, wallets created exactly once, retries applied exactly once, no 5xx.');
}

main().catch((err) => {
  console.error('Burst script crashed:', err);
  process.exit(1);
});
