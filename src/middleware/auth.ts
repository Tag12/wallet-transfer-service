import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../common/logger';
import { ErrorCode } from '../shared/enums/error-code.enum';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

export function auth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;

  if (!token) {
    logger.warn('auth.failed', { requestId: req.requestId, reason: 'missing_token' });
    res.status(401).json({ error: ErrorCode.UNAUTHORIZED, message: 'Missing bearer token' });
    return;
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET as string) as jwt.JwtPayload;
    if (!payload.sub || typeof payload.sub !== 'string') {
      throw new Error('missing_sub');
    }
    req.userId = payload.sub;
    next();
  } catch {
    logger.warn('auth.failed', { requestId: req.requestId, reason: 'invalid_token' });
    res.status(401).json({ error: ErrorCode.INVALID_TOKEN, message: 'Invalid or expired token' });
  }
}
