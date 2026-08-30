import express, { Request, Response, NextFunction } from 'express';
import { requestId } from './middleware/requestId';
import { recordRequest } from './controllers/health.controller';
import accountController from './controllers/account.controller';
import transferController from './controllers/transfer.controller';
import healthController from './controllers/health.controller';
import { logger } from './common/logger';

const app = express();

app.use(express.json());
app.use(requestId);

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    recordRequest(Date.now() - start, res.statusCode >= 500);
  });
  next();
});

app.use(healthController);
app.use(accountController);
app.use(transferController);

app.use((err: Error & { status?: number }, req: Request, res: Response, _next: NextFunction) => {
  if ((err as SyntaxError & { status?: number }).status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'INVALID_JSON', message: 'Request body contains invalid JSON' });
  }
  logger.error('request.unhandled_error', { requestId: req.requestId, message: err.message });
  return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Something went wrong' });
});

export default app;
