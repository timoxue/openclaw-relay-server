import jwt from 'jsonwebtoken';
import { database } from './database';
import type { User, TokenPayload } from '../types';

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';

export const tokenService = {
  // 生成 JWT token
  generateToken: (payload: TokenPayload): string => {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] });
  },

  // 验证 JWT token
  verifyToken: (token: string): TokenPayload | null => {
    try {
      return jwt.verify(token, JWT_SECRET) as TokenPayload;
    } catch {
      return null;
    }
  },

  // 从飞书 user_id 获取或创建用户，返回 token
  getOrCreateUserToken: (feishuUserId: string): string => {
    const existingUser = database.getUserByFeishuId(feishuUserId);

    if (existingUser) {
      // 检查 token 是否即将过期（7天内）
      const expiresAt = new Date(existingUser.token_expires_at);
      const now = new Date();
      const daysUntilExpiry = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

      if (daysUntilExpiry < 7) {
        // 刷新 token
        const newToken = tokenService.generateToken({
          userId: existingUser.id,
          feishuUserId: existingUser.feishu_user_id,
        });
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30); // 30天后过期

        database.updateUserToken(existingUser.id, newToken, expiresAt);
        return newToken;
      }

      return existingUser.token;
    }

    // 创建新用户
    const newToken = tokenService.generateToken({
      userId: 0, // 将在创建后更新
      feishuUserId,
    });
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    // 重新生成包含正确 ID 的 token
    const user = database.createUser(feishuUserId, newToken, expiresAt);
    const finalToken = tokenService.generateToken({
      userId: user.id,
      feishuUserId: user.feishu_user_id,
    });

    database.updateUserToken(user.id, finalToken, expiresAt);
    return finalToken;
  },

  // 验证请求中的 token
  validateRequestToken: (token: string): User | null => {
    const payload = tokenService.verifyToken(token);
    if (!payload) return null;

    const user = database.getUserByToken(token);
    if (!user) return null;

    return user;
  },
};
