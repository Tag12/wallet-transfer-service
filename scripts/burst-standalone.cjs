/**
 * Zero-dependency concurrency gate — runs with only Node 18+ built-ins, no repo
 * clone and no `npm install`. Pipe it straight from the public repo:
 *
 *   curl -sL https://raw.githubusercontent.com/Tag12/wallet-transfer-service/main/scripts/burst-standalone.cjs \
 *     | BASE_URL=https://wallet-transfer-service.onrender.com JWT_SECRET="<secret>" node -
 *
 * Or locally:  BASE_URL=... JWT_SECRET=... node scripts/burst-standalone.cjs
 *          or:  node scripts/burst-standalone.cjs <base_url> [firstCount] [retryCount]
 *
 * JWT_SECRET must match the target server's secret (it signs a 'faucet' token to
 * fund a fresh user, since the API has no deposit endpoint by design). Fires N
 * concurrent first-transfers (distinct keys) + M concurrent retries (one shared
 * key), then asserts: no 5xx, all distinct transfers applied, all retries collapse
 * to one transfer, and total money is conserved. Exits non-zero on any violation.
 *
 * CommonJS (not ESM) on purpose, so `curl ... | node -` works with no extra flags.
 */

const { createHmac, randomUUID } = require('node:crypto');

const FUND_AMOUNT_PAISE = 1_000_000;
const TRANSFER_AMOUNT_PAISE = 100;
const RETRY_AMOUNT_PAISE = 250;

// Robust arg parsing that works for both `node file <url> [f] [r]` and the piped
// `BASE_URL=... node - [f] [r]` form: the URL is whichever arg starts with http,
// and the counts are the numeric args (in order). Env vars take precedence.
const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith('http'));
const numArgs = args.filter((a) => /^\d+$/.test(a));
const baseUrl = (process.env.BASE_URL || urlArg || '').replace(/\/$/, '');
const firstTransferCount = Number(numArgs[0] || process.env.FIRST_COUNT || 20);
const retryCount = Number(numArgs[1] || process.env.RETRY_COUNT || 20);
const secret = process.env.JWT_SECRET;

if (!baseUrl || !secret) {
  console.error('Usage: BASE_URL=<url> JWT_SECRET=<secret> node burst-standalone.cjs [firstCount] [retryCount]');
  console.error('   or: JWT_SECRET=<secret> node burst-standalone.cjs <base_url> [firstCount] [retryCount]');
  process.exit(1);
}

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

// HS256 JWT, compatible with the server's jsonwebtoken verify (header {alg:HS256,typ:JWT}, claim `sub`).
function sign(sub) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub, iat: Math.floor(Date.now() / 1000) }));
  const data = `${header}.${payload}`;
  const sig = b64url(createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

async function postTransfer(token, toUser, amountPaise, idempotencyKey) {
  const res = await fetch(`${baseUrl}/transfers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to_user: toUser, amount_paise: amountPaise, idempotency_key: idempotencyKey }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function ensureAccount(token) {
  await fetch(`${baseUrl}/accounts`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
}

async function getBalance(token) {
  const res = await fetch(`${baseUrl}/accounts/me`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json();
  return BigInt(body.balance);
}

async function main() {
  const failures = [];
  const userA = `burst_a_${randomUUID()}`;
  const userB = `burst_b_${randomUUID()}`;
  const faucetToken = sign('faucet');
  const tokenA = sign(userA);
  const tokenB = sign(userB);

  console.log(`Target: ${baseUrl}`);
  console.log(`User A: ${userA}`);
  console.log(`User B: ${userB}`);

  console.log('\n[setup] Creating accounts and funding user A from the faucet...');
  await ensureAccount(tokenA);
  await ensureAccount(tokenB);
  const fund = await postTransfer(faucetToken, userA, FUND_AMOUNT_PAISE, randomUUID());
  if (fund.status !== 200) {
    console.error('Funding transfer failed — is JWT_SECRET correct and the faucet wallet seeded?', fund);
    process.exit(1);
  }
  console.log(`[setup] User A funded with ${FUND_AMOUNT_PAISE} paise.`);

  console.log(`\n[burst] ${firstTransferCount} concurrent first-transfers A -> B, distinct idempotency keys...`);
  const firstResults = await Promise.all(
    Array.from({ length: firstTransferCount }, () =>
      postTransfer(tokenA, userB, TRANSFER_AMOUNT_PAISE, randomUUID())),
  );
  if (firstResults.some((r) => r.status >= 500)) {
    failures.push(`${firstResults.filter((r) => r.status >= 500).length}/${firstTransferCount} first-transfers returned 5xx`);
  }
  const firstSuccesses = firstResults.filter((r) => r.status === 200).length;
  if (firstSuccesses !== firstTransferCount) {
    failures.push(`expected ${firstTransferCount} first-transfers to succeed, got ${firstSuccesses}`);
  }

  console.log(`\n[burst] ${retryCount} concurrent retries of ONE transfer, same idempotency_key...`);
  const retryKey = randomUUID();
  const retryResults = await Promise.all(
    Array.from({ length: retryCount }, () => postTransfer(tokenA, userB, RETRY_AMOUNT_PAISE, retryKey)),
  );
  if (retryResults.some((r) => r.status >= 500)) {
    failures.push(`${retryResults.filter((r) => r.status >= 500).length}/${retryCount} retries returned 5xx`);
  }
  const retryIds = new Set(retryResults.filter((r) => r.status === 200).map((r) => r.body.transfer_id));
  if (retryIds.size !== 1) {
    failures.push(`expected all retries to collapse to 1 transfer_id, got ${retryIds.size}`);
  }

  console.log('\n[verify] Reading final balances...');
  const balanceA = await getBalance(tokenA);
  const balanceB = await getBalance(tokenB);
  const total = balanceA + balanceB;
  const expectedTotal = BigInt(FUND_AMOUNT_PAISE);
  const moved = BigInt(firstTransferCount * TRANSFER_AMOUNT_PAISE + RETRY_AMOUNT_PAISE);
  const expectedA = expectedTotal - moved;

  console.log(`  balance A = ${balanceA} (expected ${expectedA})`);
  console.log(`  balance B = ${balanceB} (expected ${moved})`);
  console.log(`  total     = ${total} (expected ${expectedTotal})`);

  if (total !== expectedTotal) failures.push(`conservation violated: total ${total}, expected ${expectedTotal}`);
  if (balanceA !== expectedA || balanceB !== moved) {
    failures.push('balances do not match exact expected movement — possible double-apply or lost transfer');
  }

  if (failures.length) {
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
