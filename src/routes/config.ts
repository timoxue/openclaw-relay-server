import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

// 获取 Anthropic 配置 (需要认证)
router.get('/', authMiddleware, (req: AuthRequest, res) => {
  // 从环境变量读取配置
  const config = {
    model: process.env.ANTHROPIC_MODEL || 'anthropic/claude-opus-4-5',
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  };

  if (!config.apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  res.json(config);
});

// 健康检查
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

export default router;
