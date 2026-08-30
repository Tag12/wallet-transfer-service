import { Logtail } from '@logtail/node';

type LogFields = Record<string, unknown>;

// Ships logs to Betterstack (formerly Logtail) only when a source token is configured
// (i.e. in the deployed environment) — unset locally/in CI, so dev and tests are unaffected.
const logtail = process.env.LOGTAIL_SOURCE_TOKEN
  ? new Logtail(process.env.LOGTAIL_SOURCE_TOKEN)
  : undefined;

function emit(level: string, event: string, fields: LogFields): void {
  const entry = { level, event, time: new Date().toISOString(), ...fields };
  process.stdout.write(JSON.stringify(entry) + '\n');
  if (logtail) {
    void logtail.log(event, level, fields);
  }
}

export const logger = {
  info: (event: string, fields: LogFields = {}) => emit('info', event, fields),
  warn: (event: string, fields: LogFields = {}) => emit('warn', event, fields),
  error: (event: string, fields: LogFields = {}) => emit('error', event, fields),
};
