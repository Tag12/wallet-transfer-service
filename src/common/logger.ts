import { Logtail } from '@logtail/node';

type LogFields = Record<string, unknown>;

// Ships logs to Betterstack (formerly Logtail) only when a source token is configured
// (i.e. in the deployed environment) — unset locally/in CI, so dev and tests are unaffected.
// Modern Betterstack sources have a per-source ingesting host; when LOGTAIL_ENDPOINT is
// set we target it explicitly, otherwise the client falls back to its default host.
const logtail = process.env.LOGTAIL_SOURCE_TOKEN
  ? new Logtail(
      process.env.LOGTAIL_SOURCE_TOKEN,
      process.env.LOGTAIL_ENDPOINT ? { endpoint: process.env.LOGTAIL_ENDPOINT } : undefined,
    )
  : undefined;

const LEVELS = ['debug', 'info', 'warn', 'error'];
// Logs below this level are dropped. Defaults to 'info', so 'debug' events
// (e.g. the no-op wallet-create skips) stay out of normal output unless
// LOG_LEVEL=debug is set explicitly.
const threshold = LEVELS.indexOf(process.env.LOG_LEVEL ?? 'info');

function emit(level: string, event: string, fields: LogFields): void {
  if (LEVELS.indexOf(level) < threshold) return;
  const entry = { level, event, time: new Date().toISOString(), ...fields };
  process.stdout.write(JSON.stringify(entry) + '\n');
  if (logtail) {
    void logtail.log(event, level, fields);
  }
}

export const logger = {
  debug: (event: string, fields: LogFields = {}) => emit('debug', event, fields),
  info: (event: string, fields: LogFields = {}) => emit('info', event, fields),
  warn: (event: string, fields: LogFields = {}) => emit('warn', event, fields),
  error: (event: string, fields: LogFields = {}) => emit('error', event, fields),
};
