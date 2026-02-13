# OpenClaw Relay Server

OpenClaw-CN 的中继服务器，用于飞书消息路由和多用户支持。

## 功能

- WebSocket 消息路由
- 飞书机器人集成
- JWT Token 认证
- LLM API 配置下发（支持智谱 AI / Anthropic）

## 快速开始

### 本地开发

```bash
# 安装依赖
npm install

# 复制环境变量
cp .env.example .env
# 编辑 .env 填入配置

# 启动开发服务器
npm run dev
```

### Docker 部署

```bash
# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| PORT | API 端口 | 5178 |
| WS_PORT | WebSocket 端口 | 5179 |
| DATABASE_PATH | 数据库路径 | ./database/openclaw_relay.db |
| JWT_SECRET | JWT 密钥 | - |
| JWT_EXPIRES_IN | Token 有效期 | 30d |
| FEISHU_APP_ID | 飞书应用 ID | - |
| FEISHU_APP_SECRET | 飞书应用密钥 | - |
| **LLM 配置** | | |
| LLM_PROVIDER | LLM 提供商 (zhipu/anthropic) | zhipu |
| LLM_API_KEY | 智谱/Anthropic API Key | - |
| LLM_MODEL | 模型名称 | glm-4.7 |
| LLM_BASE_URL | API 地址 | https://open.bigmodel.cn/api/paas/v4/ |

### 智谱 AI 配置（默认）

```env
LLM_PROVIDER=zhipu
LLM_API_KEY=你的智谱API密钥
LLM_MODEL=glm-4.7
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4/
```

**获取智谱 API Key:**
1. 访问 https://open.bigmodel.cn/
2. 注册/登录账号
3. 进入 "API Keys" 页面
4. 创建新的 API Key

### Anthropic 配置（可选）

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-xxxxx
ANTHROPIC_MODEL=anthropic/claude-opus-4-5
```

## API 文档

### 认证 API

- `POST /api/auth/feishu/authorize` - 飞书授权，获取 token
- `POST /api/auth/token/validate` - 验证 token
- `POST /api/auth/token/refresh` - 刷新 token

### 配置 API

- `GET /api/config` - 获取 LLM 配置 (需要认证)
  - 返回格式: `{ provider, model, apiKey, baseUrl }`
  - 根据 `LLM_PROVIDER` 返回智谱或 Anthropic 配置
- `GET /api/config/health` - 健康检查

### 飞书 Webhook

- `POST /api/feishu/webhook` - 飞书消息 webhook

## 许可证

MIT
