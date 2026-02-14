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

// 获取用户信息
router.get('/user/info', (req, res) => {
  const { token } = req.query;

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token is required' });
  }

  const { database } = require('../services/database');
  const user = database.getUserByToken(token);

  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  res.json({
    id: user.id,
    feishuUserId: user.feishu_user_id,
    tokenExpiresAt: user.token_expires_at,
    wsConnected: user.ws_connected,
    lastSeen: user.last_seen,
    createdAt: user.created_at,
  });
});

// 从飞书 API 获取用户详细信息
router.get('/user/feishu-info', async (req, res) => {
  const { token } = req.query;

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token is required' });
  }

  const { database } = require('../services/database');
  const user = database.getUserByToken(token);

  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // 检查是否有飞书 token
  if (!user.feishu_access_token) {
    return res.status(400).json({ error: 'No Feishu access token found. Please re-authorize.' });
  }

  // 检查 token 是否过期
  const now = new Date();
  const tokenExpiresAt = user.feishu_token_expires_at ? new Date(user.feishu_token_expires_at) : null;

  if (tokenExpiresAt && tokenExpiresAt < now) {
    // Token 过期，尝试刷新
    if (!user.feishu_refresh_token) {
      return res.status(401).json({ error: 'Feishu token expired. Please re-authorize.' });
    }

    try {
      const axios = require('axios');
      // 刷新飞书 token
      const refreshResponse = await axios.post(
        'https://open.feishu.cn/open-apis/authen/v1/oidc/refresh_access_token',
        {
          grant_type: 'refresh_token',
          refresh_token: user.feishu_refresh_token,
        }
      );

      if (refreshResponse.data.code !== 0) {
        return res.status(401).json({ error: 'Failed to refresh Feishu token. Please re-authorize.' });
      }

      const newAccessToken = refreshResponse.data.data.access_token;
      const newRefreshToken = refreshResponse.data.data.refresh_token;
      const expiresIn = refreshResponse.data.data.expires_in;
      const newTokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

      // 更新数据库
      database.updateUserAndFeishuTokens(
        user.id,
        user.token,
        user.token_expires_at,
        newAccessToken,
        newRefreshToken,
        newTokenExpiresAt
      );

      // 用新 token 获取用户信息
      const userInfoResponse = await axios.get('https://open.feishu.cn/open-apis/authen/v1/user_info', {
        headers: {
          Authorization: `Bearer ${newAccessToken}`,
        },
      });

      if (userInfoResponse.data.code !== 0) {
        return res.status(500).json({ error: 'Failed to get user info from Feishu' });
      }

      const userData = userInfoResponse.data.data;

      return res.json({
        fromCache: false,
        feishuUserInfo: {
          user_id: userData?.user_id,
          name: userData?.name,
          avatar_url: userData?.avatar_url,
          avatar_big: userData?.avatar_big,
          avatar_middle: userData?.avatar_middle,
          avatar_thumb: userData?.avatar_thumb,
          en_name: userData?.en_name,
          open_id: userData?.open_id,
          union_id: userData?.union_id,
          email: userData?.email,
          mobile: userData?.mobile,
        },
        tokenRefreshed: true,
      });
    } catch (error: any) {
      console.error('Failed to refresh Feishu token:', error);
      return res.status(500).json({ error: 'Failed to refresh Feishu token' });
    }
  }

  // Token 有效，直接调用飞书 API
  try {
    const axios = require('axios');
    const userInfoResponse = await axios.get('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: {
        Authorization: `Bearer ${user.feishu_access_token}`,
      },
    });

    if (userInfoResponse.data.code !== 0) {
      return res.status(500).json({ error: 'Failed to get user info from Feishu' });
    }

    const userData = userInfoResponse.data.data;

    res.json({
      fromCache: false,
      feishuUserInfo: {
        user_id: userData?.user_id,
        name: userData?.name,
        avatar_url: userData?.avatar_url,
        avatar_big: userData?.avatar_big,
        avatar_middle: userData?.avatar_middle,
        avatar_thumb: userData?.avatar_thumb,
        en_name: userData?.en_name,
        open_id: userData?.open_id,
        union_id: userData?.union_id,
        email: userData?.email,
        mobile: userData?.mobile,
      },
      tokenRefreshed: false,
    });
  } catch (error: any) {
    console.error('Failed to get Feishu user info:', error);
    res.status(500).json({ error: 'Failed to get user info from Feishu' });
  }
});

export default router;
