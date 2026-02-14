# OpenClaw Relay Server

OpenClaw-CN 的中继服务器，用于飞书消息路由和多用户支持。

## 系统架构

```
┌───────────────────────────────────────────────┐
│        OpenClaw Relay Server            │
├───────────────────────────────────────────────┤
│                                              │
│  ┌──────────┐  ┌──────────┐        │
│  │Feishu API │  │Dual WS   │  │ HTTP API│
│  └──────────┘  └──────────┘        │
│       ↓       ↑       ↑       ↑        │
│  ┌──────────┐  ┌──────────┐        │
│  │ Webhook   │  │Feishu WS │  │ Config  │
│  └──────────┘  └──────────┘        │
│       ↓       ↓       ↓                │
│  ┌──────────────────────────────────┐  │
│  │    Message Queue System        │  │
│  └──────────────────────────────────┘  │
│       ↓                                 │
│  ┌──────────────────────────────────┐  │
  │  FeishuAPI Token Manager       │  │
│  └──────────────────────────────────┘  │
│       ↓                                 │
│  ┌──────────────┐  ┌───────────┐  │
│  │OpenClaw WS  │  │  Database  │       │
│  └──────────────┘  └───────────┘       │
│       ↓                                    │
│  ┌───────────────────────────────────┐ │
  │  OpenClaw Gateway (本地)        │ │
│  └───────────────────────────────────┘       │
└─────────────────────────────────────────────┘
```

## 功能特性

### WebSocket 消息路由
- **双 WebSocket 架构**：分别处理飞书和 OpenClaw 两个方向的连接
- **消息转发**：双向消息路由和处理
- **队列机制**：离线消息缓存，连接后自动发送

### Token 管理
- **双层缓存**：内存缓存 + 数据库持久化
- **智能刷新**：仅在 token 过期时刷新
- **自动重试**：API 失败时自动刷新 token 并重试

### 用户认证
- **JWT Token 认证**：Gateway 连接时使用 JWT 认证
- **用户映射**：飞书 user_id ↔ JWT token 映射
- **会话管理**：WebSocket 会话跟踪
- **连接状态**：实时 WebSocket 连接状态

### 飞书集成
- **消息接收**：Webhook 接收飞书消息
- **文本消息**：支持文本消息发送
- **富文本**：支持富文本消息
- **用户信息**：获取飞书用户信息

### HTTP API
- **Token 验证**：验证 JWT Token 有效性
- **Token 刷新**：刷新过期 Token
- **配置获取**：获取 LLM 配置（需要认证）
- **健康检查**：服务健康状态检查
- **Webhook**：飞书消息接收端点

### 数据库
- **用户表**：存储飞书用户、JWT token、飞书 OAuth token
- **会话表**：WebSocket 会话管理
- **配置表**：存储飞书 tenant_access_token（持久化）
- **索引优化**：快速查询索引

## 项目结构

```
openclaw-relay-server/
├── src/
│   ├── server.ts              # Express 主服务器
│   ├── services/
│   │   ├── database.ts         # 数据库服务
│   │   ├── token.ts             # JWT Token 服务
│   │   ├── feishu-api.ts       # 飞书 API 客户端
│   │   ├── feishu-oauth.ts     # 飞书 OAuth 服务
│   ├── websocket.ts          # 单 WebSocket 服务（备用）
│   └── dual-websocket.ts    # 双 WebSocket 服务（主要）
│   └── routes/
│       ├── auth.ts             # 认证路由
│       ├── config.ts           # 配置路由
│       └── feishu.ts          # 飞书路由
├── database/                   # 数据库目录
├── config/                     # 配置目录
├── docker-compose.yml           # Docker Compose 配置
├── Dockerfile                 # Docker 构建文件
├── package.json                # 项目依赖
└── tsconfig.json               # TypeScript 配置
```

## 快速开始

### 本地开发

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 文件，填入必要配置

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

## Token 管理策略

### 缓存机制
1. **内存缓存**（最快）：首次获取后保存在内存中
2. **数据库缓存**（持久化）：同时保存到数据库
3. **服务重启**：优先从数据库加载到内存

### 刷新策略
- **条件刷新**：仅在 token 过期时刷新
- **错误重试**：API 返回 401/403 时刷新
- **最大重试**：失败时重试最多 2 次

## 开发说明

### 添加新的 LLM 提供商

1. 在 `.env` 中添加环境变量
2. 在 `src/services/token.ts` 中添加新的 provider 处理逻辑
3. 测试配置接口：`GET /api/config`

### 添加新的消息类型

1. 在 `src/services/feishu-api.ts` 中添加新的发送方法
2. 在 `src/services/dual-websocket.ts` 中添加消息处理逻辑
3. 更新 WebSocket 消息格式

## 许可证

MIT
