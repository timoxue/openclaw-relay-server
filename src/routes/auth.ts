import { Router } from 'express';
import { tokenService } from '../services/token';

const router = Router();

// 飞书授权回调 - 根据 user_id 生成 token
router.post('/feishu/authorize', async (req, res) => {
  const { feishu_user_id } = req.body;

  if (!feishu_user_id) {
    return res.status(400).json({ error: 'feishu_user_id is required' });
  }

  try {
    const token = tokenService.getOrCreateUserToken(feishu_user_id);
    res.json({ token });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// 验证 token
router.post('/token/validate', (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'token is required' });
  }

  const user = tokenService.validateRequestToken(token);

  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  res.json({
    valid: true,
    userId: user.id,
    feishuUserId: user.feishu_user_id,
  });
});

// 刷新 token
router.post('/token/refresh', (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'token is required' });
  }

  const user = tokenService.validateRequestToken(token);

  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // 生成新 token
  const { generateToken } = require('../services/token');
  const newToken = generateToken({
    userId: user.id,
    feishuUserId: user.feishu_user_id,
  });

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  // 更新数据库
  const { database } = require('../services/database');
  database.updateUserToken(user.id, newToken, expiresAt);

  res.json({ token: newToken });
});

export default router;
