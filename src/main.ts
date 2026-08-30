import app from './app';
import { runMigrations } from './common/db/db';
import { logger } from './common/logger';

const PORT = process.env.PORT || 3000;

async function bootstrap(): Promise<void> {
  await runMigrations();
  app.listen(PORT, () => {
    logger.info('server.started', { port: PORT });
  });
}

bootstrap().catch((err) => {
  logger.error('server.start_failed', { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
