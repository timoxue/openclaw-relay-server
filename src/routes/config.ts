import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

// 获取 LLM 配置 (需要认证)
router.get('/', authMiddleware, (req: AuthRequest, res) => {
  const provider = process.env.LLM_PROVIDER || 'zhipu';

  // 根据不同提供商返回对应配置
  let config: any = {
    provider,
  };

  if (provider === 'zhipu') {
    // 智谱 AI 配置
    config = {
      ...config,
      model: process.env.LLM_MODEL || 'glm-4.7',
      apiKey: process.env.LLM_API_KEY || '',
      baseUrl: process.env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4/',
    };
  } else if (provider === 'anthropic') {
    // Anthropic 配置（兼容旧配置）
    config = {
      ...config,
      model: process.env.ANTHROPIC_MODEL || 'anthropic/claude-opus-4-5',
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      baseUrl: process.env.ANTHROPIC_BASE_URL,
    };
  }

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
