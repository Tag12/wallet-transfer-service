import { Router, Request, Response } from 'express';
import { getPool } from '../common/db/db';

const router = Router();

const metrics = {
  requestCount: 0,
  errorCount: 0,
  transfersApplied: 0,
  transfersRejected: 0,
  latenciesMs: [] as number[],
};

export function recordRequest(latencyMs: number, isError: boolean): void {
  metrics.requestCount += 1;
  if (isError) metrics.errorCount += 1;
  metrics.latenciesMs.push(latencyMs);
  if (metrics.latenciesMs.length > 1000) metrics.latenciesMs.shift();
}

export function recordTransferOutcome(applied: boolean): void {
  if (applied) metrics.transfersApplied += 1;
  else metrics.transfersRejected += 1;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

router.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

router.get('/readyz', async (_req: Request, res: Response) => {
  try {
    await getPool().query('SELECT 1');
    res.status(200).json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not_ready' });
  }
});

router.get('/metrics', (_req: Request, res: Response) => {
  const sorted = [...metrics.latenciesMs].sort((a, b) => a - b);
  const errorRate = metrics.requestCount > 0 ? metrics.errorCount / metrics.requestCount : 0;
  const lines = [
    `request_count ${metrics.requestCount}`,
    `error_rate ${errorRate}`,
    `latency_p50_ms ${percentile(sorted, 50)}`,
    `latency_p99_ms ${percentile(sorted, 99)}`,
    `transfers_applied ${metrics.transfersApplied}`,
    `transfers_rejected ${metrics.transfersRejected}`,
  ];
  res.status(200).type('text/plain').send(lines.join('\n') + '\n');
});

export default router;
