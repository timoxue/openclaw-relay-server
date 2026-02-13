# OpenClaw Relay Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 创建飞书消息中继服务器，支持多用户 OpenClaw Gateway 通过 WebSocket 连接，实现飞书机器人消息路由

**Architecture:**
- 用户本地 OpenClaw Gateway 通过 WebSocket 连接到中继服务器
- 飞书机器人接收消息后，通过 webhook 推送到中继服务器
- 中继服务器根据 user_id 路由消息到对应的 WebSocket 连接
- 中继服务器提供 Token 生成/验证、配置下发 API

**Tech Stack:** Node.js, Express, ws (WebSocket), SQLite, Docker, Nginx

---

## 项目结构

```
openclaw-relay-server/
├── src/
│   ├── server.ts              # 主服务器
│   ├── routes/
│   │   ├── auth.ts            # 认证 API
│   │   ├── config.ts          # 配置 API
│   │   └── feishu.ts          # 飞书 webhook
│   ├── services/
│   │   ├── websocket.ts       # WebSocket 管理
│   │   ├── feishu-api.ts      # 飞书 API
│   │   ├── token.ts           # Token 服务
│   │   └── database.ts        # 数据库
│   ├── middleware/
│   │   └── auth.ts            # JWT 验证
│   └── types/
├── database/
│   └── openclaw_relay.db
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── nginx/
│   └── default.conf
├── package.json
├── tsconfig.json
└── .env.example
```

---

## Task 1: 项目初始化

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `.gitignore`

**Step 1: 创建 package.json**

```json
{
  "name": "openclaw-relay-server",
  "version": "1.0.0",
  "description": "OpenClaw-CN relay server for Feishu message routing",
  "main": "dist/server.js",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest"
  },
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.14.2",
    "jsonwebtoken": "^9.0.2",
    "better-sqlite3": "^9.2.2",
    "axios": "^1.6.2",
    "dotenv": "^16.3.1"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/ws": "^8.5.10",
    "@types/jsonwebtoken": "^9.0.5",
    "@types/better-sqlite3": "^7.6.8",
    "typescript": "^5.3.3",
    "tsx": "^4.7.0",
    "vitest": "^1.1.0"
  }
}
```

**Step 2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: 创建 .env.example**

```env
NODE_ENV=development
PORT=3000
WS_PORT=3001

# Database
DATABASE_PATH=./database/openclaw_relay.db

# JWT
JWT_SECRET=your-secret-key-change-in-production
JWT_EXPIRES_IN=30d

# Feishu
FEISHU_APP_ID=cli_xxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxx
FEISHU_VERIFICATION_TOKEN=xxxxxxxx
FEISHU EncryptKey=xxxxxxxx

# Anthropic (for config distribution)
ANTHROPIC_API_KEY=sk-ant-xxxxx

# CORS
ALLOWED_ORIGINS=http://localhost:3000
```

**Step 4: 创建 .gitignore**

```
node_modules/
dist/
database/*.db
database/*.db-shm
database/*.db-wal
.env
*.log
certs/
```

**Step 5: 初始化并提交**

```bash
npm install
git add .
git commit -m "feat: initialize relay server project"
```

---

## Task 2: 数据库层

**Files:**
- Create: `src/services/database.ts`
- Create: `src/types/index.ts`

**Step 1: 创建类型定义**

```typescript
// src/types/index.ts
export interface User {
  id: number;
  feishu_user_id: string;
  token: string;
  token_expires_at: Date;
  ws_connected: boolean;
  last_seen: Date;
  created_at: Date;
}

export interface Session {
  id: number;
  user_id: number;
  ws_id: string;
  connected_at: Date;
}

export interface FeishuAuthRequest {
  feishu_user_id: string;
}

export interface ConfigResponse {
  model: string;
  apiKey: string;
  baseUrl?: string;
}
```

**Step 2: 创建数据库服务**

```typescript
// src/services/database.ts
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { User, Session } from '../types';

const dbDir = path.dirname(process.env.DATABASE_PATH || './database/openclaw_relay.db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(process.env.DATABASE_PATH || './database/openclaw_relay.db');

// 启用外键约束
db.pragma('foreign_keys = ON');

// 创建用户表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feishu_user_id TEXT UNIQUE NOT NULL,
    token TEXT UNIQUE NOT NULL,
    token_expires_at DATETIME NOT NULL,
    ws_connected BOOLEAN DEFAULT 0,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 创建会话表
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    ws_id TEXT NOT NULL,
    connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);

// 创建索引
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_users_feishu_id ON users(feishu_user_id);
  CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);
  CREATE INDEX IF NOT EXISTS idx_sessions_ws_id ON sessions(ws_id);
`);

export const database = {
  // 用户操作
  createUser: (feishuUserId: string, token: string, expiresAt: Date): User => {
    const stmt = db.prepare(`
      INSERT INTO users (feishu_user_id, token, token_expires_at)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(feishuUserId, token, expiresAt.toISOString());
    return database.getUserById(result.lastInsertRowid as number);
  },

  getUserByFeishuId: (feishuUserId: string): User | undefined => {
    const stmt = db.prepare('SELECT * FROM users WHERE feishu_user_id = ?');
    return stmt.get(feishuUserId) as User | undefined;
  },

  getUserByToken: (token: string): User | undefined => {
    const stmt = db.prepare('SELECT * FROM users WHERE token = ? AND token_expires_at > datetime("now")');
    return stmt.get(token) as User | undefined;
  },

  getUserById: (id: number): User | undefined => {
    const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
    return stmt.get(id) as User | undefined;
  },

  updateUserToken: (id: number, token: string, expiresAt: Date): void => {
    const stmt = db.prepare(`
      UPDATE users SET token = ?, token_expires_at = ? WHERE id = ?
    `);
    stmt.run(token, expiresAt.toISOString(), id);
  },

  setWsConnected: (userId: number, connected: boolean): void => {
    const stmt = db.prepare(`
      UPDATE users SET ws_connected = ?, last_seen = datetime("now") WHERE id = ?
    `);
    stmt.run(connected ? 1 : 0, userId);
  },

  updateLastSeen: (userId: number): void => {
    const stmt = db.prepare('UPDATE users SET last_seen = datetime("now") WHERE id = ?');
    stmt.run(userId);
  },

  // 会话操作
  createSession: (userId: number, wsId: string): Session => {
    const stmt = db.prepare(`
      INSERT INTO sessions (user_id, ws_id) VALUES (?, ?)
    `);
    const result = stmt.run(userId, wsId);
    const stmt2 = db.prepare('SELECT * FROM sessions WHERE id = ?');
    return stmt2.get(result.lastInsertRowid as number) as Session;
  },

  deleteSession: (wsId: string): void => {
    const stmt = db.prepare('DELETE FROM sessions WHERE ws_id = ?');
    stmt.run(wsId);
  },

  getSessionByWsId: (wsId: string): Session | undefined => {
    const stmt = db.prepare('SELECT * FROM sessions WHERE ws_id = ?');
    return stmt.get(wsId) as Session | undefined;
  },

  getUserByWsId: (wsId: string): User | undefined => {
    const stmt = db.prepare(`
      SELECT u.* FROM users u
      INNER JOIN sessions s ON u.id = s.user_id
      WHERE s.ws_id = ?
    `);
    return stmt.get(wsId) as User | undefined;
  },
};

export default db;
```

**Step 3: 运行构建检查**

```bash
npm run build
```

**Step 4: 提交**

```bash
git add src/types src/services/database.ts
git commit -m "feat: implement database layer with SQLite"
```

---

## Task 3: Token 服务

**Files:**
- Create: `src/services/token.ts`

**Step 1: 创建 Token 服务**

```typescript
// src/services/token.ts
import jwt from 'jsonwebtoken';
import { database } from './database';
import type { User } from '../types';

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';

export interface TokenPayload {
  userId: number;
  feishuUserId: string;
}

export const tokenService = {
  // 生成 JWT token
  generateToken: (payload: TokenPayload): string => {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
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
```

**Step 2: 提交**

```bash
git add src/services/token.ts
git commit -m "feat: implement JWT token service"
```

---

## Task 4: 飞书 API 服务

**Files:**
- Create: `src/services/feishu-api.ts`

**Step 1: 创建飞书 API 服务**

```typescript
// src/services/feishu-api.ts
import axios, { AxiosInstance } from 'axios';

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';

interface FeishuAccessTokenResponse {
  code: number;
  app_access_token: string;
  expire: number;
}

interface FeishuMessageResponse {
  code: number;
  msg: string;
}

interface FeishuUserInfo {
  user_id: string;
  name: string;
}

export class FeishuAPI {
  private client: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpireAt: number = 0;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://open.feishu.cn',
      timeout: 10000,
    });
  }

  // 获取 tenant_access_token
  async getAccessToken(): Promise<string> {
    const now = Date.now() / 1000;

    if (this.accessToken && this.tokenExpireAt > now + 300) {
      return this.accessToken;
    }

    const response = await this.client.post<FeishuAccessTokenResponse>(
      '/open-apis/auth/v3/tenant_access_token/internal',
      {
        app_id: FEISHU_APP_ID,
        app_secret: FEISHU_APP_SECRET,
      }
    );

    if (response.data.code !== 0) {
      throw new Error('Failed to get Feishu access token');
    }

    this.accessToken = response.data.app_access_token;
    this.tokenExpireAt = now + response.data.expire - 300; // 提前5分钟刷新

    return this.accessToken;
  }

  // 发送文本消息
  async sendTextMessage(userId: string, text: string): Promise<boolean> {
    const token = await this.getAccessToken();

    const response = await this.client.post<FeishuMessageResponse>(
      `/open-apis/im/v1/messages?receive_id_type=user_id`,
      {
        receive_id: userId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    return response.data.code === 0;
  }

  // 发送富文本消息
  async sendPostMessage(userId: string, content: any): Promise<boolean> {
    const token = await this.getAccessToken();

    const response = await this.client.post<FeishuMessageResponse>(
      `/open-apis/im/v1/messages?receive_id_type=user_id`,
      {
        receive_id: userId,
        msg_type: 'post',
        content: JSON.stringify(content),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    return response.data.code === 0;
  }

  // 获取用户信息
  async getUserInfo(userId: string): Promise<FeishuUserInfo | null> {
    const token = await this.getAccessToken();

    try {
      const response = await this.client.get<{
        code: number;
        data: { user: FeishuUserInfo };
      }>(`/open-apis/contact/v3/users/${userId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.data.code === 0) {
        return response.data.data.user;
      }
    } catch (error) {
      console.error('Failed to get user info:', error);
    }

    return null;
  }

  // 验证 webhook 请求
  verifyWebhook(headers: any): boolean {
    // TODO: 实现飞书 webhook 验证逻辑
    // 参考: https://open.feishu.cn/document/common-capabilities/message-card/message-card-content-language/using-verification-token-to-verify-event-request
    return true;
  }
}

export const feishuAPI = new FeishuAPI();
```

**Step 2: 提交**

```bash
git add src/services/feishu-api.ts
git commit -m "feat: implement Feishu API service"
```

---

## Task 5: WebSocket 服务

**Files:**
- Create: `src/services/websocket.ts`

**Step 1: 创建 WebSocket 服务**

```typescript
// src/services/websocket.ts
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'crypto';
import { database } from './database';
import { tokenService } from './token';
import { feishuAPI } from './feishu-api';
import type { TokenPayload } from '../types';

interface ClientMessage {
  type: 'send_message' | 'ping' | 'auth';
  to?: string;
  content?: any;
  token?: string;
}

interface ServerMessage {
  type: 'message' | 'error' | 'pong' | 'auth_success';
  from?: string;
  content?: any;
  error?: string;
}

interface WSClient extends WebSocket {
  id: string;
  userId?: number;
  isAuthenticated: boolean;
}

export class WebSocketService {
  private wss: WebSocketServer;
  private clients: Map<string, WSClient> = new Map();

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    this.setupServer();
  }

  private setupServer(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      const client = ws as WSClient;
      client.id = randomBytes(16).toString('hex');
      client.isAuthenticated = false;

      console.log(`WebSocket client connected: ${client.id}`);

      client.on('message', async (data: Buffer) => {
        try {
          const message: ClientMessage = JSON.parse(data.toString());
          await this.handleMessage(client, message);
        } catch (error) {
          this.sendError(client, 'Invalid message format');
        }
      });

      client.on('close', () => {
        this.handleDisconnect(client);
      });

      client.on('error', (error) => {
        console.error(`WebSocket error for ${client.id}:`, error);
      });
    });

    console.log(`WebSocket server running on port ${this.wss.options.port}`);
  }

  private async handleMessage(client: WSClient, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'auth':
        await this.handleAuth(client, message.token || '');
        break;

      case 'send_message':
        if (!client.isAuthenticated) {
          this.sendError(client, 'Not authenticated');
          return;
        }
        if (message.to && message.content) {
          await this.sendMessageToFeishu(client, message.to, message.content);
        }
        break;

      case 'ping':
        this.sendMessage(client, { type: 'pong' });
        break;

      default:
        this.sendError(client, 'Unknown message type');
    }
  }

  private async handleAuth(client: WSClient, token: string): Promise<void> {
    const payload = tokenService.verifyToken(token);

    if (!payload) {
      this.sendError(client, 'Invalid token');
      return;
    }

    const user = database.getUserByToken(token);
    if (!user) {
      this.sendError(client, 'User not found');
      return;
    }

    client.userId = user.id;
    client.isAuthenticated = true;

    // 创建或更新会话
    const existingSession = database.getSessionByWsId(client.id);
    if (!existingSession) {
      database.createSession(user.id, client.id);
    }

    database.setWsConnected(user.id, true);
    this.clients.set(client.id, client);

    this.sendMessage(client, { type: 'auth_success' });
    console.log(`Client ${client.id} authenticated as user ${user.id}`);
  }

  private async sendMessageToFeishu(client: WSClient, to: string, content: any): Promise<void> {
    if (!client.userId) return;

    try {
      // 根据内容类型发送
      if (typeof content === 'string') {
        await feishuAPI.sendTextMessage(to, content);
      } else {
        await feishuAPI.sendPostMessage(to, content);
      }

      // 更新最后活跃时间
      database.updateLastSeen(client.userId);
    } catch (error) {
      console.error('Failed to send message to Feishu:', error);
      this.sendError(client, 'Failed to send message');
    }
  }

  private handleDisconnect(client: WSClient): void {
    console.log(`WebSocket client disconnected: ${client.id}`);

    if (client.userId) {
      database.setWsConnected(client.userId, false);
      database.deleteSession(client.id);
    }

    this.clients.delete(client.id);
  }

  private sendMessage(client: WSClient, message: ServerMessage): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }

  private sendError(client: WSClient, error: string): void {
    this.sendMessage(client, { type: 'error', error });
  }

  // 发送消息给指定用户
  public sendToUser(feishuUserId: string, message: any): boolean {
    const user = database.getUserByFeishuId(feishuUserId);
    if (!user || !user.ws_connected) return false;

    const session = database.getSessionByWsId;
    // 找到用户的 WebSocket 连接
    for (const [clientId, client] of this.clients.entries()) {
      if (client.userId === user.id && client.isAuthenticated) {
        this.sendMessage(client, {
          type: 'message',
          from: feishuUserId,
          content: message,
        });
        return true;
      }
    }

    return false;
  }

  // 获取连接数
  public getConnectedCount(): number {
    return this.clients.size;
  }

  // 关闭服务器
  public close(): void {
    this.wss.close();
  }
}
```

**Step 2: 提交**

```bash
git add src/services/websocket.ts
git commit -m "feat: implement WebSocket service"
```

---

## Task 6: 认证路由

**Files:**
- Create: `src/routes/auth.ts`
- Create: `src/middleware/auth.ts`

**Step 1: 创建认证中间件**

```typescript
// src/middleware/auth.ts
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
```

**Step 2: 创建认证路由**

```typescript
// src/routes/auth.ts
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
  const newToken = tokenService.generateToken({
    userId: user.id,
    feishuUserId: user.feishu_user_id,
  });

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  // 更新数据库
  // 需要在 database.ts 添加 updateToken 方法

  res.json({ token: newToken });
});

export default router;
```

**Step 3: 提交**

```bash
git add src/routes/auth.ts src/middleware/auth.ts
git commit -m "feat: implement auth routes and middleware"
```

---

## Task 7: 配置路由

**Files:**
- Create: `src/routes/config.ts`

**Step 1: 创建配置路由**

```typescript
// src/routes/config.ts
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
```

**Step 2: 提交**

```bash
git add src/routes/config.ts
git commit -m "feat: implement config routes"
```

---

## Task 8: 飞书 Webhook 路由

**Files:**
- Create: `src/routes/feishu.ts`

**Step 1: 创建飞书 webhook 路由**

```typescript
// src/routes/feishu.ts
import { Router, Request, Response } from 'express';
import { feishuAPI } from '../services/feishu-api';
import { database } from '../services/database';

interface FeishuWebhookEvent {
  header: {
    event_id: string;
    timestamp: string;
    event_type: string;
    tenant_key: string;
  };
  event: {
    sender: {
      sender_id: {
        open_id: string;
        user_id: string;
      };
      sender_type: string;
    };
    message: {
      message_id: string;
      chat_type: string;
      chat_id: string;
      content: string;
      msg_type: string;
      create_time: string;
    };
  };
}

const router = Router();

// 飞书消息 webhook
router.post('/webhook', async (req: Request, res: Response) => {
  console.log('Received Feishu webhook:', JSON.stringify(req.body, null, 2));

  const { header, event } = req.body as FeishuWebhookEvent;

  // URL 验证（首次配置时）
  if (header.event_type === 'url_verification') {
    const challenge = req.body.challenge;
    return res.json({ challenge });
  }

  // 处理消息事件
  if (header.event_type === 'im.message.receive_v1') {
    const senderId = event.sender.sender_id.user_id;

    // 解析消息内容
    let content = '';
    try {
      const parsedContent = JSON.parse(event.message.content);
      content = parsedContent.text || '';
    } catch {
      content = event.message.content;
    }

    // 查找用户并转发消息
    const user = database.getUserByFeishuId(senderId);

    if (user && user.ws_connected) {
      // TODO: 实现向用户 WebSocket 连接发送消息
      // 这里需要在 WebSocket 服务中添加 sendToUser 方法
      console.log(`Forwarding message to user ${user.id}: ${content}`);

      res.json({ code: 0, msg: 'Message forwarded' });
    } else {
      console.log(`User ${senderId} not connected, sending fallback message`);

      // 发送未连接提示
      await feishuAPI.sendTextMessage(
        senderId,
        'OpenClaw Gateway 未连接，请先启动控制面板'
      );

      res.json({ code: 0, msg: 'User not connected' });
    }
  }

  res.json({ code: 0, msg: 'ok' });
});

export default router;
```

**Step 2: 提交**

```bash
git add src/routes/feishu.ts
git commit -m "feat: implement Feishu webhook route"
```

---

## Task 9: 主服务器

**Files:**
- Create: `src/server.ts`

**Step 1: 创建主服务器**

```typescript
// src/server.ts
import express from 'express';
import cors from 'cors';
import { WebSocketService } from './services/websocket';
import authRoutes from './routes/auth';
import configRoutes from './routes/config';
import feishuRoutes from './routes/feishu';

const app = express();
const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 3001;

// 中间件
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
}));
app.use(express.json());

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      api: true,
      websocket: true,
    },
  });
});

// 路由
app.use('/api/auth', authRoutes);
app.use('/api/config', configRoutes);
app.use('/api/feishu', feishuRoutes);

// 404 处理
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// 错误处理
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 启动服务器
const wsService = new WebSocketService(Number(WS_PORT));

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
  console.log(`WebSocket server running on port ${WS_PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  wsService.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  wsService.close();
  process.exit(0);
});
```

**Step 2: 安装缺失依赖**

```bash
npm install cors
npm install -D @types/cors
```

**Step 3: 测试运行**

```bash
npm run dev
```

预期输出：
```
API server running on port 3000
WebSocket server running on port 3001
Environment: development
```

**Step 4: 测试健康检查**

```bash
curl http://localhost:3000/health
```

预期输出：
```json
{"status":"ok","timestamp":"2026-02-13T...","services":{"api":true,"websocket":true}}
```

**Step 5: 提交**

```bash
git add src/server.ts package.json
git commit -m "feat: implement main server"
```

---

## Task 10: Docker 配置

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`

**Step 1: 创建 .dockerignore**

```
node_modules
dist
database
*.log
.env
.git
```

**Step 2: 创建 Dockerfile**

```dockerfile
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm ci

COPY src ./src

RUN npm run build

FROM node:22-alpine

WORKDIR /app

# 安装 sqlite3 运行时依赖
RUN apk add --no-cache sqlite

# 复制 package 文件并安装生产依赖
COPY package*.json ./
RUN npm ci --only=production

# 从构建阶段复制编译后的文件
COPY --from=builder /app/dist ./dist

# 创建数据库目录
RUN mkdir -p /app/database

ENV NODE_ENV=production
ENV PORT=3000
ENV WS_PORT=3001
ENV DATABASE_PATH=/app/data/openclaw_relay.db

EXPOSE 3000 3001

CMD ["node", "dist/server.js"]
```

**Step 3: 创建 docker-compose.yml**

```yaml
version: '3.8'

services:
  relay-server:
    build: .
    container_name: openclaw-relay
    ports:
      - "3000:3000"
      - "3001:3001"
    environment:
      - NODE_ENV=production
      - PORT=3000
      - WS_PORT=3001
      - DATABASE_PATH=/app/data/openclaw_relay.db
      - JWT_SECRET=${JWT_SECRET}
      - JWT_EXPIRES_IN=30d
      - FEISHU_APP_ID=${FEISHU_APP_ID}
      - FEISHU_APP_SECRET=${FEISHU_APP_SECRET}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    volumes:
      - ./data:/app/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  # Nginx 反向代理 (可选，用于 SSL)
  nginx:
    image: nginx:alpine
    container_name: openclaw-nginx
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/ssl:/etc/nginx/ssl:ro
    depends_on:
      - relay-server
    restart: unless-stopped
```

**Step 4: 创建 nginx 配置目录**

```bash
mkdir -p nginx/ssl
```

**Step 5: 创建 nginx/nginx.conf**

```nginx
events {
    worker_connections 1024;
}

http {
    upstream relay_api {
        server relay-server:3000;
    }

    upstream relay_ws {
        server relay-server:3001;
    }

    # HTTP 重定向到 HTTPS
    server {
        listen 80;
        server_name your-domain.com;
        return 301 https://$server_name$request_uri;
    }

    # HTTPS
    server {
        listen 443 ssl http2;
        server_name your-domain.com;

        ssl_certificate /etc/nginx/ssl/fullchain.pem;
        ssl_certificate_key /etc/nginx/ssl/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;

        # API
        location /api/ {
            proxy_pass http://relay_api;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X_Auth-Token $http_x_auth_token;
        }

        # 健康检查
        location /health {
            proxy_pass http://relay_api;
        }

        # WebSocket
        location /ws {
            proxy_pass http://relay_ws;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_read_timeout 86400;
            proxy_send_timeout 86400;
        }
    }
}
```

**Step 6: 创建 .env 文件模板**

```bash
cp .env.example .env
# 编辑 .env 填入实际配置
```

**Step 7: 提交**

```bash
git add Dockerfile docker-compose.yml .dockerignore nginx .env.example
git commit -m "feat: add Docker configuration"
```

---

## Task 11: 测试

**Files:**
- Create: `tests/auth.test.ts`
- Create: `tests/websocket.test.ts`

**Step 1: 创建测试目录**

```bash
mkdir -p tests
```

**Step 2: 安装测试依赖**

```bash
npm install -D vitest @vitest/coverage-v8
```

**Step 3: 创建认证测试**

```typescript
// tests/auth.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tokenService } from '../src/services/token';
import { database } from '../src/services/database';

describe('Token Service', () => {
  const testFeishuId = 'test_user_123';

  beforeAll(() => {
    // 清理测试数据
    const user = database.getUserByFeishuId(testFeishuId);
    if (user) {
      // 删除测试用户 (需要实现删除方法)
    }
  });

  it('should generate a valid token', () => {
    const token = tokenService.generateToken({
      userId: 1,
      feishuUserId: testFeishuId,
    });

    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
  });

  it('should verify a valid token', () => {
    const payload = { userId: 1, feishuUserId: testFeishuId };
    const token = tokenService.generateToken(payload);
    const verified = tokenService.verifyToken(token);

    expect(verified).toEqual(payload);
  });

  it('should reject an invalid token', () => {
    const verified = tokenService.verifyToken('invalid_token');
    expect(verified).toBeNull();
  });

  it('should create or get user token', () => {
    const token = tokenService.getOrCreateUserToken(testFeishuId);
    expect(token).toBeTruthy();

    // 再次调用应该返回相同的 token (未过期时)
    const token2 = tokenService.getOrCreateUserToken(testFeishuId);
    expect(token2).toBe(token);
  });
});
```

**Step 4: 添加 vitest 配置到 package.json**

```json
"scripts": {
  "test": "vitest",
  "test:coverage": "vitest --coverage"
}
```

**Step 5: 运行测试**

```bash
npm test
```

**Step 6: 提交**

```bash
git add tests/ package.json vitest.config.ts
git commit -m "test: add authentication tests"
```

---

## Task 12: README 文档

**Files:**
- Create: `README.md`

**Step 1: 创建 README**

```markdown
# OpenClaw Relay Server

OpenClaw-CN 的中继服务器，用于飞书消息路由和多用户支持。

## 功能

- WebSocket 消息路由
- 飞书机器人集成
- JWT Token 认证
- Anthropic API 配置下发

## 快速开始

### 本地开发

\`\`\`bash
# 安装依赖
npm install

# 复制环境变量
cp .env.example .env
# 编辑 .env 填入配置

# 启动开发服务器
npm run dev
\`\`\`

### Docker 部署

\`\`\`bash
# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
\`\`\`

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
```

**Step 2: 提交**

```bash
git add README.md
git commit -m "docs: add README"
```

---

## 部署检查清单

- [ ] 创建云服务器实例
- [ ] 安装 Docker 和 Docker Compose
- [ ] 配置域名 DNS 解析
- [ ] 申请 SSL 证书 (Let's Encrypt)
- [ ] 配置环境变量 (.env)
- [ ] 部署服务 `docker-compose up -d`
- [ ] 验证服务状态 `curl https://your-domain.com/health`
- [ ] 配置飞书机器人 webhook URL

---

Plan complete and saved to `docs/plans/2026-02-13-relay-server-implementation.md`.
