import { Request, Response, NextFunction } from 'express';
import { tokenService } from '../services/token';

export interface AuthRequest extends Request {
  user?: {
    id: number;
    feishuUserId: string;
  };
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const user = tokenService.validateRequestToken(token);

  if (!user) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  req.user = {
    id: user.id,
    feishuUserId: user.feishu_user_id,
  };

  next();
}
