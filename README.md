# OpenClaw Relay Server

OpenClaw-CN 的中继服务器，用于飞书消息路由和多用户支持。

## 功能

- WebSocket 消息路由
- 飞书机器人集成
- JWT Token 认证
- Anthropic API 配置下发

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
| PORT | API 端口 | 3000 |
| WS_PORT | WebSocket 端口 | 3001 |
| DATABASE_PATH | 数据库路径 | ./database/openclaw_relay.db |
| JWT_SECRET | JWT 密钥 | - |
| JWT_EXPIRES_IN | Token 有效期 | 30d |
| FEISHU_APP_ID | 飞书应用 ID | - |
| FEISHU_APP_SECRET | 飞书应用密钥 | - |
| ANTHROPIC_API_KEY | Anthropic API Key | - |

## API 文档

### 认证 API

- `POST /api/auth/feishu/authorize` - 飞书授权，获取 token
- `POST /api/auth/token/validate` - 验证 token
- `POST /api/auth/token/refresh` - 刷新 token

### 配置 API

- `GET /api/config` - 获取 Anthropic 配置 (需要认证)
- `GET /api/config/health` - 健康检查

### 飞书 Webhook

- `POST /api/feishu/webhook` - 飞书消息 webhook

## 许可证

MIT
