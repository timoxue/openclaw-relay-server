# Token 类型说明

本文档详细说明中继服务器系统中使用的三种 Token 的关系和用途。

---

## 概述

在 OpenClaw 飞书中继系统中，使用了三种不同的 Token，它们各有不同的用途和生命周期：

1. **feishu_access_token** - 飞书访问令牌
2. **feishu_refresh_token** - 飞书刷新令牌
3. **配置文件 Token (JWT)** - 中继服务器认证令牌

---

## 1. feishu_access_token（飞书访问令牌）

| 属性 | 说明 |
|------|------|
| **来源** | 飞书 OAuth 授权流程中，用 `code` 换取 |
| **用途** | 中继服务器调用飞书 API（发送消息、获取用户信息等） |
| **有效期** | 约 2 小时（由飞书返回的 `expires_in` 决定） |
| **存储位置** | 中继服务器数据库 `users` 表的 `feishu_access_token` 字段 |
| **谁使用** | 中继服务器（调用 `feishuAPI.sendTextMessage` 时） |
| **用户是否需要** | ❌ 不需要，用户无需知道这个 token |
| **过期后处理** | 用 `feishu_refresh_token` 自动刷新 |

### 代码位置

- **生成**: `src/routes/qrcode.ts:594`
  ```typescript
  const userAccessToken = tokenResponse.data.data.access_token;
  const expiresIn = tokenResponse.data.data.expires_in;
  const feishuTokenExpiresAt = new Date(Date.now() + expiresIn * 1000);
  ```

- **存储**: `src/routes/qrcode.ts:640` 或 `src/routes/qrcode.ts:643`
  ```typescript
  // 更新现有用户
  database.updateUserAndFeishuTokens(
    user.id, token, expiresAt,
    userAccessToken, refreshToken, feishuTokenExpiresAt
  );

  // 或创建新用户
  user = database.createUserWithFeishuTokens(
    userId, token, expiresAt,
    userAccessToken, refreshToken, feishuTokenExpiresAt
  );
  ```

- **使用**: `src/services/feishu-api.ts`（调用飞书 API 时）

---

## 2. feishu_refresh_token（飞书刷新令牌）

| 属性 | 说明 |
|------|------|
| **来源** | 飞书 OAuth 授权流程中，和 `access_token` 一起返回 |
| **用途** | 当 `feishu_access_token` 过期时，用它获取新的 `access_token` |
| **有效期** | 通常较长（几天到几个月，由飞书决定） |
| **存储位置** | 中继服务器数据库 `users` 表的 `feishu_refresh_token` 字段 |
| **谁使用** | 中继服务器（当 `access_token` 过期时自动刷新） |
| **用户是否需要** | ❌ 不需要，用户无需知道这个 token |
| **过期后处理** | 如果也过期，用户需要重新扫描二维码授权 |

### 代码位置

- **生成**: `src/routes/qrcode.ts:594`
  ```typescript
  const refreshToken = tokenResponse.data.data.refresh_token;
  ```

- **存储**: `src/routes/qrcode.ts:640` 或 `src/routes/qrcode.ts:643`（与 access_token 一起存储）

- **使用**: `src/routes/auth.ts:132-142`（刷新逻辑）
  ```typescript
  const refreshResponse = await axios.post(
    'https://open.feishu.cn/open-apis/authen/v1/oidc/refresh_access_token',
    {
      grant_type: 'refresh_token',
      refresh_token: user.feishu_refresh_token,
    }
  );

  const newAccessToken = refreshResponse.data.data.access_token;
  const newRefreshToken = refreshResponse.data.data.refresh_token;

  // 更新数据库
  database.updateUserAndFeishuTokens(
    user.id, token, token_expires_at,
    newAccessToken, newRefreshToken, newTokenExpiresAt
  );
  ```

---

## 3. 配置文件 Token（中继服务器 JWT Token）

| 属性 | 说明 |
|------|------|
| **来源** | 中继服务器生成，使用 `jsonwebtoken` 签名 |
| **用途** | OpenClaw 客户端认证连接到中继服务器的 WebSocket |
| **有效期** | 30 天（在代码中设置 `expiresIn: '30d'`） |
| **存储位置** | OpenClaw 客户端配置文件 `~/.openclaw/openclaw.json` |
| **谁使用** | OpenClaw 客户端（插件发送认证消息时） |
| **用户是否需要** | ✅ 需要，用户扫描二维码后复制到配置文件 |
| **过期后处理** | 30天后需要重新扫描二维码获取新的 JWT Token |

### 代码位置

- **生成**: `src/routes/qrcode.ts:623-632`
  ```typescript
  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET || 'openclaw-secret-key';
  const token = jwt.sign(
    {
      userId,
      type: 'relay_token',
    },
    secret,
    { expiresIn: '30d' }
  );
  ```

- **验证**: `src/services/token.ts` (tokenService.verifyToken)
  ```typescript
  verifyToken(token: string): any | null {
    try {
      const decoded = jwt.verify(token, this.secret);
      if (decoded.type !== 'relay_token') {
        return null;
      }
      return decoded;
    } catch (error) {
      return null;
    }
  }
  ```

- **使用**: 插件 `index.js:76-79` (发送认证消息)
  ```javascript
  sendAuth() {
    const { token } = this.config;
    this.ws.send(JSON.stringify({
      type: 'auth',
      token: token
    }));
  }
  ```

### JWT Payload 示例

```json
{
  "userId": "xuedu",      // 飞书用户ID
  "type": "relay_token",   // 标识这是中继服务器token
  "iat": 1771047576,      // 签发时间戳
  "exp": 1773639576       // 过期时间戳（30天后）
}
```

### 配置文件示例

```json
{
  "channels": {
    "feishu-relay": {
      "enabled": true,
      "type": "openclaw-feishu-relay",
      "relayUrl": "ws://43.160.237.217:5190/openclaw",
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ4dWVkdSIsInR5cGUiOiJyZWxheV90b2tlbiIsImlhdCI6MTc3MTA0NzU3NiwiZXhwIjoxNzczNjM5NTc2fQ.42ai4sugbIGxNN7H1JFh7cTwp-gIuMpEQoEIzr9_j6g"
    }
  }
}
```

---

## 完整流程图

### OAuth 授权流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                     用户（在飞书App中）                           │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           │ 1. 扫描二维码
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   中继服务器 OAuth 回调                           │
│                  (src/routes/qrcode.ts)                          │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │  调用飞书 API        │
              │  (用 code 换取 token) │
              └────────┬───────────────┘
                       │
                       ▼
            ┌──────────────────────────────┐
            │ 飞书服务器返回             │
            │ - access_token (2小时)      │
            │ - refresh_token (长期)      │
            └────────┬───────────────────┘
                     │
                     ▼
        ┌────────────────────────────────────┐
        │  存入数据库                      │
        │  users 表:                       │
        │  - feishu_access_token          │
        │  - feishu_refresh_token          │
        │  - feishu_token_expires_at      │
        └────────┬───────────────────────┘
                 │
                 ▼
        ┌────────────────────────────────────┐
        │  生成 JWT Token (30天)           │
        │  payload: {userId, type: 'relay_token'}│
        └────────┬───────────────────────┘
                 │
                 ▼
        ┌────────────────────────────────────┐
        │  返回给用户显示                  │
        │  用户复制到 ~/.openclaw/openclaw.json│
        └────────────────────────────────────┘
```

### 日常运行时的 Token 使用

```
┌─────────────────────────────────────────────────────────────────┐
│               OpenClaw 客户端（插件）                          │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          │ 2. 连接时发送
                          │    {type: 'auth', token: JWT_TOKEN}
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│              中继服务器 WebSocket 服务                         │
│         (src/services/dual-websocket.ts)                      │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          │ 3. 验证 JWT Token
                          ▼
                    ┌───────────────┐
                    │ 验证成功      │
                    └───────┬───────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              飞书发送消息流程                                │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          │ 4. 从数据库取出
                          ▼
        ┌─────────────────────────────────────┐
        │  feishu_access_token (2小时有效)  │
        └──────────────────┬────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │  调用飞书 API        │
              │  (发送消息给用户)      │
              └────────────────────────┘

              如果 access_token 过期:
              ┌────────────────────────┐
              │  从数据库取出        │
              │  feishu_refresh_token │
              └──────────┬───────────┘
                         │
                         ▼
              ┌────────────────────────┐
              │  调用飞书刷新API     │
              │  获取新的            │
              │  feishu_access_token  │
              └──────────┬───────────┘
                         │
                         ▼
              ┌────────────────────────┐
              │  更新数据库          │
              │  继续发送消息        │
              └────────────────────────┘
```

---

## 三者关系总结

```
feishu_access_token  ────  ──────►  中继服务器调用飞书API
    (2小时，自动刷新)                    │
                                        │
                                        ▼
                            ┌───────────────────┐
                            │   中继服务器     │
                            └───────────────────┘
                                        │
                                        │
feishu_refresh_token ──  ────►  自动刷新 access_token
    (长期)
                                        │
                                        │
配置文件 token ──── ───────────►  OpenClaw客户端连接认证
    (JWT, 30天)
```

---

## 对比表

| 特性 | feishu_access_token | feishu_refresh_token | 配置文件 Token (JWT) |
|------|-------------------|---------------------|---------------------|
| **颁发者** | 飞书服务器 | 飞书服务器 | 中继服务器 |
| **用途** | 调用飞书 API | 刷新 access_token | WebSocket 连接认证 |
| **有效期** | ~2 小时 | 长期（几天-几个月） | 30 天 |
| **存储位置** | 中继服务器数据库 | 中继服务器数据库 | 用户配置文件 |
| **谁使用** | 中继服务器 | 中继服务器 | OpenClaw 客户端 |
| **用户可见** | ❌ | ❌ | ✅ |
| **格式** | 字符串 | 字符串 | JWT |
| **过期处理** | 自动刷新 | 需重新授权 | 需重新扫码 |

---

## 数据库表结构

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feishu_user_id TEXT UNIQUE NOT NULL,
  token TEXT UNIQUE NOT NULL,                    -- JWT Token (30天)
  token_expires_at DATETIME NOT NULL,

  -- 飞书 Token
  feishu_access_token TEXT,                      -- 飞书访问令牌 (2小时)
  feishu_refresh_token TEXT,                     -- 飞书刷新令牌 (长期)
  feishu_token_expires_at DATETIME,

  ws_connected BOOLEAN DEFAULT 0,
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 关键要点

1. **独立管理**: 三种 Token 各司其职，不互相包含
2. **自动刷新**: `feishu_access_token` 过期时自动刷新，用户无感知
3. **用户交互**: 用户只需要知道配置文件中的 JWT Token
4. **安全隔离**: 飞书 Token 存储在服务器端，JWT Token 仅用于连接认证
5. **过期策略**:
   - JWT Token: 30 天后过期，需重新扫码
   - feishu_refresh_token: 过期后需重新扫码
   - feishu_access_token: 2 小时过期，自动刷新

---

## 相关文件

- `src/routes/qrcode.ts` - OAuth 流程和 Token 生成
- `src/routes/auth.ts` - Token 刷新和用户信息获取
- `src/services/token.ts` - JWT Token 验证
- `src/services/feishu-api.ts` - 飞书 API 调用
- `src/services/dual-websocket.ts` - WebSocket 认证
- `src/services/database.ts` - 数据库操作
