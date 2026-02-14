import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'crypto';
import { database } from './database';
import { tokenService } from './token';
import { feishuAPI } from './feishu-api';

// ==================== 类型定义 ====================

interface FeishuMessage {
  type: 'message';
  content: string;
  messageId: string;
  chatType: string;
  chatId: string;
  senderId: string;
}

interface OpenClawMessage {
  type: 'llm_request' | 'llm_response' | 'auth';
  userToken?: string;
  content?: any;
  messageId?: string;
  token?: string;
}

interface WSClient extends WebSocket {
  id: string;
  userId?: number;
  userToken?: string;
  isAuthenticated: boolean;
  clientType: 'feishu' | 'openclaw';
}

interface QueuedMessage {
  userToken: string;
  message: any;
  timestamp: number;
  messageId: string;
}

// ==================== 双 WebSocket 服务 ====================

export class DualWebSocketService {
  // 飞书 WebSocket 服务器
  private feishuWss: WebSocketServer;
  private feishuPort: number;

  // OpenClaw WebSocket 服务器
  private openclawWss: WebSocketServer;
  private openclawPort: number;

  // 连接集合
  private feishuClients: Map<string, WSClient> = new Map();
  private openclawClients: Map<string, WSClient> = new Map();

  // 用户映射表 (feishuUserId -> userToken)
  private userMap: Map<string, string> = new Map();

  // 消息队列
  private feishuQueue: QueuedMessage[] = [];
  private openclawQueue: QueuedMessage[] = [];

  constructor(feishuPort: number, openclawPort: number) {
    this.feishuPort = feishuPort;
    this.openclawPort = openclawPort;

    this.feishuWss = new WebSocketServer({ port: feishuPort, path: '/feishu' });
    this.openclawWss = new WebSocketServer({ port: openclawPort, path: '/openclaw' });

    this.setupFeishuServer();
    this.setupOpenclawServer();
    this.startQueueProcessor();
  }

  // ==================== 飞书 WS 服务器 ====================

  private setupFeishuServer(): void {
    this.feishuWss.on('connection', (ws: WebSocket, req) => {
      const client = ws as WSClient;
      client.id = randomBytes(16).toString('hex');
      client.isAuthenticated = false;
      client.clientType = 'feishu';

      // 从查询参数获取用户 ID
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const feishuUserId = url.searchParams.get('user_id') || '';

      if (feishuUserId) {
        client.userId = undefined; // 飞书端不需要用户 ID
        client.isAuthenticated = true;
        this.feishuClients.set(feishuUserId, client);
        console.log(`[Feishu WS] Connected: ${feishuUserId} (${client.id})`);
      }

      client.on('message', (data: Buffer) => {
        this.handleFeishuMessage(client, data, feishuUserId);
      });

      client.on('close', () => {
        this.handleFeishuDisconnect(client, feishuUserId);
      });

      client.on('error', (error) => {
        console.error(`[Feishu WS] Error for ${client.id}:`, error);
      });
    });

    console.log(`[Feishu WS] Server running on port ${this.feishuPort}`);
  }

  private handleFeishuMessage(client: WSClient, data: Buffer, feishuUserId: string): void {
    try {
      const message = JSON.parse(data.toString());
      console.log(`[Feishu WS] Received from ${feishuUserId}:`, message);

      // 处理飞书消息
      if (message.type === 'message') {
        this.dispatchFeishuMessage(feishuUserId, message);
      }
    } catch (error) {
      console.error('[Feishu WS] Invalid message format:', error);
    }
  }

  private handleFeishuDisconnect(client: WSClient, feishuUserId: string): void {
    console.log(`[Feishu WS] Disconnected: ${feishuUserId} (${client.id})`);
    this.feishuClients.delete(feishuUserId);
  }

  // ==================== OpenClaw WS 服务器 ====================

  private setupOpenclawServer(): void {
    this.openclawWss.on('connection', (ws: WebSocket) => {
      const client = ws as WSClient;
      client.id = randomBytes(16).toString('hex');
      client.isAuthenticated = false;
      client.clientType = 'openclaw';

      console.log(`[OpenClaw WS] Connected: ${client.id}`);

      client.on('message', async (data: Buffer) => {
        await this.handleOpenclawMessage(client, data);
      });

      client.on('close', () => {
        this.handleOpenclawDisconnect(client);
      });

      client.on('error', (error) => {
        console.error(`[OpenClaw WS] Error for ${client.id}:`, error);
      });
    });

    console.log(`[OpenClaw WS] Server running on port ${this.openclawPort}`);
  }

  private async handleOpenclawMessage(client: WSClient, data: Buffer): Promise<void> {
    try {
      const message: OpenClawMessage = JSON.parse(data.toString());
      console.log(`[OpenClaw WS] Received from ${client.id}:`, message);

      // 处理认证消息
      if (message.type === 'auth' && message.token) {
        await this.handleAuth(client, message.token);
        return;
      }

      // 处理 LLM 请求消息
      if (!client.isAuthenticated) {
        this.sendError(client, 'Not authenticated');
        return;
      }

      if (message.type === 'llm_request' && client.userToken) {
        this.dispatchOpenclawMessage(client.userToken, message);
      }
    } catch (error) {
      console.error('[OpenClaw WS] Invalid message format:', error);
      this.sendError(client, 'Invalid message format');
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
    client.userToken = token;
    client.isAuthenticated = true;

    // 保存连接
    this.openclawClients.set(token, client);

    // 更新数据库
    database.setWsConnected(user.id, true);

    // 更新用户映射表
    this.userMap.set(user.feishu_user_id, token);

    // 创建会话
    const existingSession = database.getSessionByWsId(client.id);
    if (!existingSession) {
      database.createSession(user.id, client.id);
    }

    this.sendMessage(client, { type: 'auth_success' });
    console.log(`[OpenClaw WS] Client ${client.id} authenticated as user ${user.id}`);

    // 检查飞书队列，发送离线消息
    this.processFeishuQueueForUser(token);
  }

  private handleOpenclawDisconnect(client: WSClient): void {
    console.log(`[OpenClaw WS] Disconnected: ${client.id}`);

    if (client.userId && client.userToken) {
      database.setWsConnected(client.userId, false);
      database.deleteSession(client.id);
      this.openclawClients.delete(client.userToken);
    }
  }

  // ==================== 消息分发 ====================

  /**
   * 分发飞书消息到 OpenClaw 客户端
   */
  private dispatchFeishuMessage(feishuUserId: string, message: FeishuMessage): void {
    // 查找对应的 userToken
    const userToken = this.findUserToken(feishuUserId);

    if (!userToken) {
      console.log(`[Dispatch] No user token found for ${feishuUserId}`);
      return;
    }

    // 查找 OpenClaw 连接
    const openclawWS = this.openclawClients.get(userToken);

    if (!openclawWS || openclawWS.readyState !== WebSocket.OPEN) {
      // OpenClaw 未在线，加入队列
      console.log(`[Dispatch] OpenClaw offline, queuing message for ${userToken}`);
      this.queueFeishuMessage(userToken, message);
      return;
    }

    // 直接转发
    const forwardMessage = {
      type: 'feishu_message',
      userToken: userToken,
      content: message.content,
      messageId: message.messageId,
      chatType: message.chatType,
      chatId: message.chatId,
      senderId: message.senderId,
      timestamp: Date.now(),
    };

    this.sendMessage(openclawWS, forwardMessage);
    console.log(`[Dispatch] Forwarded: ${feishuUserId} → ${userToken}`);
  }

  /**
   * 分发 OpenClaw 消息（LLM 响应）到飞书
   */
  private dispatchOpenclawMessage(userToken: string, message: any): void {
    const openclawWS = this.openclawClients.get(userToken);

    if (!openclawWS || openclawWS.readyState !== WebSocket.OPEN) {
      console.log(`[Dispatch] OpenClaw not connected, queuing response for ${userToken}`);
      this.queueOpenclawMessage(userToken, message);
      return;
    }

    // 发送确认消息
    const responseMessage = {
      type: 'llm_response',
      userToken: userToken,
      content: message.content,
      messageId: message.messageId || this.generateId(),
      timestamp: Date.now(),
    };

    this.sendMessage(openclawWS, responseMessage);
    console.log(`[Dispatch] LLM response sent to ${userToken}`);

    // 发送到飞书（如果需要）
    this.sendToFeishu(userToken, message.content);
  }

  // ==================== 消息队列 ====================

  private queueFeishuMessage(userToken: string, message: any): void {
    this.feishuQueue.push({
      userToken,
      message,
      timestamp: Date.now(),
      messageId: this.generateId(),
    });
    console.log(`[Queue] Feishu message queued for ${userToken} (total: ${this.feishuQueue.length})`);
  }

  private queueOpenclawMessage(userToken: string, message: any): void {
    this.openclawQueue.push({
      userToken,
      message,
      timestamp: Date.now(),
      messageId: this.generateId(),
    });
    console.log(`[Queue] OpenClaw message queued for ${userToken} (total: ${this.openclawQueue.length})`);
  }

  /**
   * 定时处理队列
   */
  private startQueueProcessor(): void {
    // 每 100ms 检查一次飞书队列
    setInterval(() => {
      this.processFeishuQueue();
    }, 100);

    // 每 100ms 检查一次 OpenClaw 队列
    setInterval(() => {
      this.processOpenclawQueue();
    }, 100);
  }

  private processFeishuQueue(): void {
    const remaining: QueuedMessage[] = [];

    for (const item of this.feishuQueue) {
      const ws = this.openclawClients.get(item.userToken);

      if (ws && ws.readyState === WebSocket.OPEN) {
        const forwardMessage = {
          type: 'feishu_message',
          userToken: item.userToken,
          ...item.message,
          timestamp: Date.now(),
        };
        this.sendMessage(ws, forwardMessage);
        console.log(`[Queue] Delivered queued message to ${item.userToken}`);
      } else {
        remaining.push(item);
      }
    }

    this.feishuQueue = remaining;
  }

  private processOpenclawQueue(): void {
    const remaining: QueuedMessage[] = [];

    for (const item of this.openclawQueue) {
      const ws = this.openclawClients.get(item.userToken);

      if (ws && ws.readyState === WebSocket.OPEN) {
        const responseMessage = {
          type: 'llm_response',
          userToken: item.userToken,
          ...item.message,
          timestamp: Date.now(),
        };
        this.sendMessage(ws, responseMessage);
        this.sendToFeishu(item.userToken, item.message.content);
        console.log(`[Queue] Delivered queued response to ${item.userToken}`);
      } else {
        remaining.push(item);
      }
    }

    this.openclawQueue = remaining;
  }

  /**
   * 为特定用户处理飞书队列
   */
  private processFeishuQueueForUser(userToken: string): void {
    for (let i = this.feishuQueue.length - 1; i >= 0; i--) {
      const item = this.feishuQueue[i];
      if (item.userToken === userToken) {
        const ws = this.openclawClients.get(userToken);

        if (ws && ws.readyState === WebSocket.OPEN) {
          const forwardMessage = {
            type: 'feishu_message',
            userToken: item.userToken,
            ...item.message,
            timestamp: Date.now(),
          };
          this.sendMessage(ws, forwardMessage);
          this.feishuQueue.splice(i, 1);
          console.log(`[Queue] Delivered offline message to ${userToken}`);
        }
      }
    }
  }

  // ==================== 发送消息到飞书 ====================

  private async sendToFeishu(userToken: string, content: any): Promise<void> {
    // 从数据库获取飞书用户 ID
    const user = database.getUserByToken(userToken);

    if (!user) {
      console.log(`[Feishu] User not found for token ${userToken}`);
      return;
    }

    try {
      if (typeof content === 'string') {
        await feishuAPI.sendTextMessage(user.feishu_user_id, content);
      } else {
        await feishuAPI.sendPostMessage(user.feishu_user_id, content);
      }
      console.log(`[Feishu] Message sent to ${user.feishu_user_id}`);
    } catch (error) {
      console.error('[Feishu] Failed to send message:', error);
    }
  }

  // ==================== 公共方法 ====================

  /**
   * 从飞书 Webhook 接收消息
   */
  public receiveFromFeishu(feishuUserId: string, message: FeishuMessage): void {
    this.dispatchFeishuMessage(feishuUserId, message);
  }

  /**
   * 获取连接数
   */
  public getConnectedCount(): { feishu: number; openclaw: number } {
    return {
      feishu: this.feishuClients.size,
      openclaw: this.openclawClients.size,
    };
  }

  /**
   * 关闭服务器
   */
  public close(): void {
    this.feishuWss.close();
    this.openclawWss.close();
  }

  // ==================== 工具方法 ====================

  private sendMessage(client: WSClient, message: any): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }

  private sendError(client: WSClient, error: string): void {
    this.sendMessage(client, { type: 'error', error });
  }

  private findUserToken(feishuUserId: string): string | null {
    // 先从用户映射表查找
    let token = this.userMap.get(feishuUserId);

    if (token) return token;

    // 从数据库查找
    const user = database.getUserByFeishuId(feishuUserId);
    if (user) {
      this.userMap.set(feishuUserId, user.token);
      return user.token;
    }

    return null;
  }

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}
