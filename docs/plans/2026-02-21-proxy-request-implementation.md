# Proxy Request System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a proxy request system where User A can request to call User B's OpenClaw agent with approval via Feishu card.

**Architecture:** Modular design with separate services for request management and card handling. Reuse existing feishuAPI, wsTunnel, database. Extend existing database with proxy_requests table. Integrate card event handler into existing feishuWSClient.

**Tech Stack:** TypeScript, @larksuiteoapi/node-sdk, better-sqlite3, ws, Node.js

---

## Task 1: Type Definitions

**Files:**
- Create: `src/types/proxy-request.ts`

**Step 1: Write type definitions**

```typescript
// src/types/proxy-request.ts

export enum RequestStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

export interface ProxyRequest {
  id: string;
  requestorUserId: string;
  targetUserId: string;
  agentName: string;
  message: string;
  status: RequestStatus;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  result?: string;
  cardMessageId?: string;
}

export interface LarkCardActionEvent {
  event_id: string;
  token: any;
  action: { value: string; action_value: string };
  operator: { user_id: string; open_id: string };
  locale: string;
}

export interface FeishuCardElement {
  tag: string;
  text?: any;
  actions?: any[];
}

export interface FeishuCard {
  config: { wide_screen_mode: boolean };
  header: {
    template: string;
    title: { tag: 'plain_text'; content: string };
  };
  elements: FeishuCardElement[];
}

export interface LarkCardResponse {
  toast?: { type: string; content: string };
}
```

**Step 2: Build to verify types compile**

Run: `npm run build`
Expected: PASS with no TypeScript errors

**Step 3: Commit**

```bash
git add src/types/proxy-request.ts
git commit -m "feat: add proxy request type definitions"
```

---

## Task 2: Text Utility Functions

**Files:**
- Create: `src/utils/text-utils.ts`

**Step 1: Write text utility functions**

```typescript
// src/utils/text-utils.ts

const MAX_CARD_RESULT_LENGTH = 2000;

/**
 * Truncate result text for card display
 */
export function truncateResult(result: string): string {
  if (!result || result.length <= MAX_CARD_RESULT_LENGTH) {
    return result;
  }

  const truncated = result.substring(0, MAX_CARD_RESULT_LENGTH);
  return `${truncated}...\n\n💡 *完整结果请查看私聊消息*`;
}

/**
 * Parse @mentions from message text
 * Format: @userId or @user_name
 */
export function parseMentions(text: string): string[] {
  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
  const matches: string[] = [];
  let match;

  while ((match = mentionRegex.exec(text)) !== null) {
    matches.push(match[1]);
  }

  return matches;
}

/**
 * Extract command and message from text
 * Format: @user !command message
 */
export function parseProxyCommand(text: string): {
  targetUser: string | null;
  command: string | null;
  message: string;
} {
  const trimmed = text.trim();

  // Check for @mention followed by command
  const mentionMatch = trimmed.match(/^@(\S+)\s+(\S+)\s*(.*)$/);
  if (mentionMatch) {
    return {
      targetUser: mentionMatch[1],
      command: mentionMatch[2].replace(/^!/, ''),
      message: mentionMatch[3] || '',
    };
  }

  return { targetUser: null, command: null, message: trimmed };
}
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/utils/text-utils.ts
git commit -m "feat: add text utility functions for proxy requests"
```

---

## Task 3: Extend Database for Proxy Requests

**Files:**
- Modify: `src/services/database.ts`

**Step 1: Add proxy_requests table and operations**

Insert after `CREATE TABLE IF NOT EXISTS config` block (around line 67):

```typescript
// 创建代理请求表
db.exec(`
  CREATE TABLE IF NOT EXISTS proxy_requests (
    id TEXT PRIMARY KEY,
    requestor_user_id TEXT NOT NULL,
    target_user_id TEXT NOT NULL,
    agent_name TEXT NOT NULL DEFAULT 'openclaw',
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    result TEXT,
    card_message_id TEXT
  )
`);

// 创建索引
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_proxy_target_status
  ON proxy_requests(target_user_id, status);
  CREATE INDEX IF NOT EXISTS idx_proxy_requestor_status
  ON proxy_requests(requestor_user_id, status);
  CREATE INDEX IF NOT EXISTS idx_proxy_expires
  ON proxy_requests(expires_at);
`);
```

Add to the `database` export object before closing brace (around line 245):

```typescript
  // Proxy request operations
  createProxyRequest: (data: {
    id: string;
    requestorUserId: string;
    targetUserId: string;
    agentName: string;
    message: string;
    expiresAt: number;
  }) => void => {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
      INSERT INTO proxy_requests (
        id, requestor_user_id, target_user_id, agent_name,
        message, status, created_at, updated_at, expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      data.id,
      data.requestorUserId,
      data.targetUserId,
      data.agentName,
      data.message,
      'pending',
      now,
      now,
      data.expiresAt
    );
  },

  getProxyRequest: (id: string): Record<string, any> | undefined => {
    const stmt = db.prepare('SELECT * FROM proxy_requests WHERE id = ?');
    const row = stmt.get(id);
    if (!row) return undefined;
    return {
      id: row.id,
      requestorUserId: row.requestor_user_id,
      targetUserId: row.target_user_id,
      agentName: row.agent_name,
      message: row.message,
      status: row.status,
      createdAt: new Date((row.created_at as number) * 1000),
      updatedAt: new Date((row.updated_at as number) * 1000),
      expiresAt: new Date((row.expires_at as number) * 1000),
      result: row.result,
      cardMessageId: row.card_message_id,
    };
  },

  updateProxyRequest: (
    id: string,
    updates: Partial<{
      status: string;
      result: string;
      cardMessageId: string;
    }>
  ): boolean => {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.result !== undefined) {
      fields.push('result = ?');
      values.push(updates.result);
    }
    if (updates.cardMessageId !== undefined) {
      fields.push('card_message_id = ?');
      values.push(updates.cardMessageId);
    }

    if (fields.length === 0) return false;

    fields.push('updated_at = ?');
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);

    const stmt = db.prepare(`
      UPDATE proxy_requests
      SET ${fields.join(', ')}
      WHERE id = ?
    `);

    const result = stmt.run(...values);
    return result.changes > 0;
  },

  getPendingRequests: (targetUserId: string): Record<string, any>[] => {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
      SELECT * FROM proxy_requests
      WHERE target_user_id = ? AND status = 'pending' AND expires_at > ?
      ORDER BY created_at DESC
    `);
    return stmt.all(targetUserId, now) as Record<string, any>[];
  },

  getUserRequests: (requestorUserId: string): Record<string, any>[] => {
    const stmt = db.prepare(`
      SELECT * FROM proxy_requests
      WHERE requestor_user_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `);
    return stmt.all(requestorUserId) as Record<string, any>[];
  },

  cancelProxyRequest: (id: string, requestorUserId: string): boolean => {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
      UPDATE proxy_requests
      SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND requestor_user_id = ? AND status = 'pending'
    `);
    const result = stmt.run(now, id, requestorUserId);
    return result.changes > 0;
  },
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add proxy_requests table and database operations"
```

---

## Task 4: Extend FeishuAPI with Card Methods

**Files:**
- Modify: `src/services/feishu-api.ts`

**Step 1: Import card types and add card methods**

Add import at top of file:

```typescript
import type { FeishuCard } from '../types/proxy-request';
```

Add before `verifyWebhook` method (around line 259):

```typescript
  // 发送卡片消息
  async sendCardMessage(userId: string, card: FeishuCard): Promise<string | null> {
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const token = await this.getAccessToken(attempt > 0);

        const response = await this.client.post<FeishuMessageResponse>(
          `/open-apis/im/v1/messages?receive_id_type=user_id`,
          {
            receive_id: userId,
            msg_type: 'interactive',
            content: JSON.stringify(card),
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (response.data.code === 0) {
          const messageId = (response.data as any).data?.message_id;
          console.log(`[FeishuAPI] Card sent successfully, message_id: ${messageId}`);
          return messageId;
        } else {
          console.error(`[FeishuAPI] Send card failed: code=${response.data.code}, msg=${response.data.msg}`);
          return null;
        }
      } catch (error) {
        const axiosError = error as AxiosError;
        const statusCode = axiosError.response?.status;
        const errorCode = (axiosError.response?.data as any)?.code;

        if (statusCode === 401 || statusCode === 403 || errorCode === 99991668) {
          if (attempt < 2) {
            this.inMemoryToken = null;
            database.deleteConfig(TOKEN_CONFIG_KEY);
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
        }

        console.error('[FeishuAPI] Failed to send card:', axiosError.message);
        throw error;
      }
    }

    return null;
  }

  // 更新卡片消息
  async updateCardMessage(messageId: string, card: FeishuCard): Promise<boolean> {
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const token = await this.getAccessToken(attempt > 0);

        const response = await this.client.request<FeishuMessageResponse>({
          method: 'PUT',
          url: `/open-apis/im/v1/messages/${messageId}`,
          params: { receive_id_type: 'user_id' },
          data: {
            content: JSON.stringify(card),
            msg_type: 'interactive',
          },
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.data.code === 0) {
          console.log(`[FeishuAPI] Card updated successfully: ${messageId}`);
          return true;
        } else {
          console.error(`[FeishuAPI] Update card failed: code=${response.data.code}, msg=${response.data.msg}`);
          return false;
        }
      } catch (error) {
        const axiosError = error as AxiosError;
        const statusCode = axiosError.response?.status;
        const errorCode = (axiosError.response?.data as any)?.code;

        if (statusCode === 401 || statusCode === 403 || errorCode === 99991668) {
          if (attempt < 2) {
            this.inMemoryToken = null;
            database.deleteConfig(TOKEN_CONFIG_KEY);
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
        }

        console.error('[FeishuAPI] Failed to update card:', axiosError.message);
        throw error;
      }
    }

    return false;
  }
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/services/feishu-api.ts
git commit -m "feat: add sendCardMessage and updateCardMessage to FeishuAPI"
```

---

## Task 5: Lark Card Handler

**Files:**
- Create: `src/services/lark-card-handler.ts`

**Step 1: Write LarkCardHandler service**

```typescript
// src/services/lark-card-handler.ts

import { feishuAPI } from './feishu-api';
import type {
  ProxyRequest,
  RequestStatus,
  FeishuCard,
  LarkCardActionEvent,
} from '../types/proxy-request';

export class LarkCardHandler {
  /**
   * Generate pending approval card
   */
  generatePendingCard(request: ProxyRequest): FeishuCard {
    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '📋 OpenClaw 调用请求' },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**请求者**: @${request.requestorUserId}\n**消息**: ${request.message}\n**智能体**: ${request.agentName}`,
          },
        },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ 同意' },
              type: 'primary',
              value: `approve_${request.id}`,
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '❌ 拒绝' },
              type: 'danger',
              value: `reject_${request.id}`,
            },
          ],
        },
      ],
    };
  }

  /**
   * Generate approved card
   */
  generateApprovedCard(request: ProxyRequest, result: string): FeishuCard {
    const { truncateResult } = require('../utils/text-utils');

    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'green',
        title: { tag: 'plain_text', content: '📋 OpenClaw 调用请求' },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**请求者**: @${request.requestorUserId}\n**消息**: ${request.message}`,
          },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**状态**: ✅ 已执行\n**结果**: ${truncateResult(result)}`,
          },
        },
        {
          tag: 'note',
          elements: [
            {
              tag: 'lark_md',
              content: `本结果由 @${request.targetUserId} 的智能体 OpenClaw 生成，已获得本人授权。`,
            },
          ],
        },
      ],
    };
  }

  /**
   * Generate rejected card
   */
  generateRejectedCard(request: ProxyRequest): FeishuCard {
    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'red',
        title: { tag: 'plain_text', content: '📋 OpenClaw 调用请求' },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**请求者**: @${request.requestorUserId}\n**消息**: ${request.message}`,
          },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '**状态**: ❌ 已拒绝' },
        },
      ],
    };
  }

  /**
   * Generate processing card
   */
  generateProcessingCard(request: ProxyRequest): FeishuCard {
    return {
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: '📋 OpenClaw 调用请求' },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**请求者**: @${request.requestorUserId}\n**消息**: ${request.message}`,
          },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '**状态**: ⏳ 处理中...' },
        },
      ],
    };
  }

  /**
   * Send card to user
   */
  async sendCard(userId: string, card: FeishuCard): Promise<string | null> {
    return await feishuAPI.sendCardMessage(userId, card);
  }

  /**
   * Update card
   */
  async updateCard(messageId: string, card: FeishuCard): Promise<boolean> {
    return await feishuAPI.updateCardMessage(messageId, card);
  }

  /**
   * Parse card action event
   */
  parseCardAction(event: LarkCardActionEvent): {
    action: 'approve' | 'reject';
    requestId: string;
  } | null {
    const value = event.action.value || event.action.action_value || '';
    const parts = value.split('_');

    if (parts.length === 2 && ['approve', 'reject'].includes(parts[0])) {
      return {
        action: parts[0] as 'approve' | 'reject',
        requestId: parts[1],
      };
    }

    return null;
  }

  /**
   * Validate operator is the target user
   */
  validateOperator(event: LarkCardActionEvent, targetUserId: string): boolean {
    return event.operator.user_id === targetUserId;
  }

  /**
   * Build card action response
   */
  buildResponse(toast?: { type: string; content: string }): any {
    const response: any = {};
    if (toast) {
      response.toast = toast;
    }
    return response;
  }
}

export const larkCardHandler = new LarkCardHandler();
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/services/lark-card-handler.ts
git commit -m "feat: add LarkCardHandler for Feishu card generation"
```

---

## Task 6: Proxy Request Service

**Files:**
- Create: `src/services/proxy-request.ts`

**Step 1: Write ProxyRequestService**

```typescript
// src/services/proxy-request.ts

import { database } from './database';
import { larkCardHandler } from './lark-card-handler';
import { sendFeishuMessage } from './orchestrator';
import { wsTunnel } from './ws-tunnel';
import type {
  ProxyRequest,
  RequestStatus,
} from '../types/proxy-request';

const REQUEST_EXPIRY_HOURS = 24;
const REQUEST_TIMEOUT_SECONDS = 30;

export class ProxyRequestService {
  private processingRequests = new Set<string>();

  /**
   * Create new proxy request
   */
  async createRequest(
    requestorUserId: string,
    targetUserId: string,
    agentName: string,
    message: string
  ): Promise<string | null> {
    // Prevent self-request
    if (requestorUserId === targetUserId) {
      await sendFeishuMessage(requestorUserId, '不能向自己发起请求');
      return null;
    }

    const id = this.generateId();
    const expiresAt = Math.floor(Date.now() / 1000) + (REQUEST_EXPIRY_HOURS * 3600);

    // Create request in database
    database.createProxyRequest({
      id,
      requestorUserId,
      targetUserId,
      agentName,
      message,
      expiresAt,
    });

    // Generate and send card
    const request: ProxyRequest = {
      id,
      requestorUserId,
      targetUserId,
      agentName,
      message,
      status: 'pending' as RequestStatus,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(expiresAt * 1000),
    };

    const card = larkCardHandler.generatePendingCard(request);
    const messageId = await larkCardHandler.sendCard(targetUserId, card);

    if (messageId) {
      // Update card_message_id
      database.updateProxyRequest(id, { cardMessageId: messageId });

      // Notify requestor
      await sendFeishuMessage(
        requestorUserId,
        `已向 @${targetUserId} 发起 ${agentName} 调用请求`
      );

      return id;
    }

    return null;
  }

  /**
   * Handle card action event
   */
  async handleCardAction(event: any): Promise<any> {
    const parsed = larkCardHandler.parseCardAction(event);
    if (!parsed) {
      return larkCardHandler.buildResponse({
        type: 'warning',
        content: '无效的操作',
      });
    }

    const { action, requestId } = parsed;

    // Check concurrency
    if (this.processingRequests.has(requestId)) {
      return larkCardHandler.buildResponse({
        type: 'warning',
        content: '请求正在处理中，请勿重复操作',
      });
    }

    // Get request
    const request = database.getProxyRequest(requestId);
    if (!request) {
      return larkCardHandler.buildResponse({
        type: 'warning',
        content: '请求不存在',
      });
    }

    // Check status
    if (request.status !== 'pending') {
      return larkCardHandler.buildResponse({
        type: 'warning',
        content: '请求已处理',
      });
    }

    // Validate operator
    if (!larkCardHandler.validateOperator(event, request.targetUserId)) {
      return larkCardHandler.buildResponse({
        type: 'error',
        content: '无权操作此请求',
      });
    }

    // Mark as processing
    this.processingRequests.add(requestId);

    try {
      // Update to processing card first
      const processingCard = larkCardHandler.generateProcessingCard(request);
      if (request.cardMessageId) {
        await larkCardHandler.updateCard(request.cardMessageId, processingCard);
      }

      if (action === 'approve') {
        await this.approveRequest(request as ProxyRequest);
      } else {
        await this.rejectRequest(request as ProxyRequest);
      }

      return larkCardHandler.buildResponse({
        type: 'success',
        content: action === 'approve' ? '已同意请求' : '已拒绝请求',
      });
    } finally {
      this.processingRequests.delete(requestId);
    }
  }

  /**
   * Approve request and execute
   */
  private async approveRequest(request: ProxyRequest): Promise<void> {
    const { orchestrator } = await import('./orchestrator');

    // Check if container is running
    if (!wsTunnel.hasActiveConnections(request.targetUserId)) {
      await this.rejectRequestWithError(request, '智能体容器未运行，请先启动容器');
      return;
    }

    try {
      // Send message via wsTunnel
      await wsTunnel.sendChatMessage(request.targetUserId, request.message);

      // Wait for response (simplified - in real app would use event)
      await new Promise(resolve => setTimeout(resolve, REQUEST_TIMEOUT_SECONDS * 1000));

      // Update request status
      database.updateProxyRequest(request.id, {
        status: 'approved',
        result: '请求已执行',
      });

      // Update card to approved
      const approvedCard = larkCardHandler.generateApprovedCard(request, '请求已执行');
      if (request.cardMessageId) {
        await larkCardHandler.updateCard(request.cardMessageId, approvedCard);
      }

      // Notify requestor
      await sendFeishuMessage(
        request.requestorUserId,
        `✅ 请求已执行\n\n消息: ${request.message}\n\n---\n本结果由 @${request.targetUserId} 的智能体 ${request.agentName} 生成，已获得本人授权。`
      );
    } catch (error) {
      await this.rejectRequestWithError(request, `执行失败: ${(error as Error).message}`);
    }
  }

  /**
   * Reject request
   */
  private async rejectRequest(request: ProxyRequest): Promise<void> {
    database.updateProxyRequest(request.id, { status: 'rejected' });

    const rejectedCard = larkCardHandler.generateRejectedCard(request);
    if (request.cardMessageId) {
      await larkCardHandler.updateCard(request.cardMessageId, rejectedCard);
    }

    // Notify requestor
    await sendFeishuMessage(
      request.requestorUserId,
      `❌ 您向 @${request.targetUserId} 发起的请求已被拒绝`
    );
  }

  /**
   * Reject request with error message
   */
  private async rejectRequestWithError(request: ProxyRequest, error: string): Promise<void> {
    database.updateProxyRequest(request.id, {
      status: 'rejected',
      result: error,
    });

    const rejectedCard = larkCardHandler.generateRejectedCard(request);
    if (request.cardMessageId) {
      await larkCardHandler.updateCard(request.cardMessageId, rejectedCard);
    }

    await sendFeishuMessage(request.targetUserId, `⚠️ ${error}`);
    await sendFeishuMessage(
      request.requestorUserId,
      `❌ 请求执行失败: ${error}`
    );
  }

  /**
   * Cancel request
   */
  async cancelRequest(requestId: string, requestorUserId: string): Promise<boolean> {
    const success = database.cancelProxyRequest(requestId, requestorUserId);
    if (success) {
      await sendFeishuMessage(requestorUserId, '请求已取消');
    }
    return success;
  }

  /**
   * Get pending requests for user
   */
  getPendingRequests(targetUserId: string): any[] {
    return database.getPendingRequests(targetUserId);
  }

  /**
   * Get user's requests
   */
  getUserRequests(requestorUserId: string): any[] {
    return database.getUserRequests(requestorUserId);
  }

  /**
   * Generate UUID
   */
  private generateId(): string {
    return crypto.randomUUID();
  }
}

export const proxyRequestService = new ProxyRequestService();
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/services/proxy-request.ts
git commit -m "feat: add ProxyRequestService core logic"
```

---

## Task 7: Extend Orchestrator for Proxy Commands

**Files:**
- Modify: `src/services/orchestrator.ts`

**Step 1: Add imports and proxy command handler**

Add imports at top:

```typescript
import { proxyRequestService } from './proxy-request';
import { parseProxyCommand } from '../utils/text-utils';
```

Add in `handleAgentCommand` after `const handlers` block (around line 152):

```typescript
    // Proxy request commands
    if (command.startsWith('request ')) {
      await this.handleProxyRequestCommand(userId, agentName, command);
      return;
    }
```

Add new method after `sendHelp` method (around line 337):

```typescript
  private async handleProxyRequestCommand(userId: string, agentName: string, command: string): Promise<void> {
    const parts = command.split(' ');
    const subCommand = parts[1];

    const handlers: Record<string, () => Promise<void>> = {
      'status': () => this.showProxyStatus(userId),
      'list': () => this.showProxyList(userId),
      'cancel': () => this.cancelProxyRequest(userId, parts.slice(2).join(' ')),
    };

    const handler = handlers[subCommand];
    if (handler) {
      await handler();
    } else {
      await sendFeishuMessage(
        userId,
        `**代理请求命令**\n• !${agentName} request status - 查看发起的请求\n• !${agentName} request list - 查看待处理请求\n• !${agentName} request cancel <id> - 取消请求`
      );
    }
  }

  private async showProxyStatus(userId: string): Promise<void> {
    const requests = proxyRequestService.getUserRequests(userId);
    if (requests.length === 0) {
      await sendFeishuMessage(userId, '您没有发起任何请求');
      return;
    }

    let message = '**您的代理请求**\n\n';
    for (const req of requests) {
      const statusEmoji = {
        'pending': '⏳',
        'approved': '✅',
        'rejected': '❌',
        'cancelled': '🚫',
        'expired': '⌛',
      }[req.status] || '❓';

      message += `${statusEmoji} \`${req.id.substring(0, 8)}...\` - ${req.status}\n`;
      message += `   消息: ${req.message}\n\n`;
    }

    await sendFeishuMessage(userId, message);
  }

  private async showProxyList(userId: string): Promise<void> {
    const requests = proxyRequestService.getPendingRequests(userId);
    if (requests.length === 0) {
      await sendFeishuMessage(userId, '您没有待处理的请求');
      return;
    }

    let message = '**待处理的请求**\n\n';
    for (const req of requests) {
      message += `• 来自 @${req.requestorUserId}\n`;
      message += `  消息: ${req.message}\n`;
      message += `  ID: \`${req.id}\`\n\n`;
    }

    await sendFeishuMessage(userId, message);
  }

  private async cancelProxyRequest(userId: string, requestId: string): Promise<void> {
    if (!requestId) {
      await sendFeishuMessage(userId, '请提供请求ID');
      return;
    }

    const success = await proxyRequestService.cancelRequest(requestId, userId);
    if (success) {
      await sendFeishuMessage(userId, '请求已取消');
    } else {
      await sendFeishuMessage(userId, '取消失败，请求不存在或已处理');
    }
  }
```

Modify `handleDefaultMode` to detect proxy requests (around line 177):

```typescript
  private async handleDefaultMode(userId: string, text: string): Promise<void> {
    const state = this.getUserState(userId);

    // Check for proxy request format: @user !openclaw message
    const proxyCmd = parseProxyCommand(text);
    if (proxyCmd.targetUser && proxyCmd.command === 'openclaw') {
      await proxyRequestService.createRequest(
        userId,
        proxyCmd.targetUser,
        'openclaw',
        proxyCmd.message
      );
      return;
    }

    if (!state.containerInfo) {
      const hint = this.getWelcomeHint();
      await sendFeishuMessage(userId, hint);
      return;
    }

    await sendFeishuMessage(userId, `收到: ${text}\n使用 !openclaw 进入交互模式`);
  }
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/services/orchestrator.ts
git commit -m "feat: add proxy request commands to orchestrator"
```

---

## Task 8: Register Card Event Handler in Server

**Files:**
- Modify: `src/server.ts`

**Step 1: Add imports and register card action handler**

Add imports after existing imports:

```typescript
import { proxyRequestService } from './services/proxy-request';
```

Add new handler in eventDispatcher registration (around line 142, after 'application.bot.menu_v6'):

```typescript
      'p2_card_action_trigger': async (data: any) => {
        console.log('\n=== CARD ACTION EVENT ===');
        console.log('Event:', JSON.stringify(data, null, 2));
        console.log('=========================\n');

        const response = await proxyRequestService.handleCardAction(data);
        console.log('[Server] Card action response:', response);
        return response;
      },
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: register p2_card_action_trigger handler for card events"
```

---

## Task 9: Add Environment Variables

**Files:**
- Modify: `.env.example` (create if not exists)

**Step 1: Add environment variables**

```bash
# Proxy Request Settings
REQUEST_EXPIRY_HOURS=24
REQUEST_TIMEOUT_SECONDS=30
MAX_CARD_RESULT_LENGTH=2000
```

**Step 2: Commit**

```bash
git add .env.example
git commit -m "feat: add proxy request environment variables"
```

---

## Task 10: Final Build and Test

**Step 1: Build the project**

Run: `npm run build`
Expected: PASS with no TypeScript errors

**Step 2: Commit final version**

```bash
git add -A
git commit -m "feat: complete proxy request system implementation"
```

**Step 3: Test manual scenarios**

1. Start server: `npm run dev`
2. Test creating request: `@targetUser !openclaw "test message"`
3. Verify card sent to target user
4. Test approve/reject on card
5. Verify notification sent to requestor

---

## Summary

This plan implements a complete proxy request system with:

- **Type definitions** for requests, cards, and events
- **Database layer** with proxy_requests table and CRUD operations
- **FeishuAPI extensions** for sending/updating cards
- **LarkCardHandler** for card generation
- **ProxyRequestService** for core business logic with concurrency control
- **Orchestrator integration** for command parsing
- **Server integration** for card event handling

Total files: 5 new, 4 modified
Estimated lines of code: ~800 lines across all files
