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
      // 提取文本内容
      let textToSend = '';
      if (typeof content === 'string') {
        textToSend = content;
      } else if (typeof content === 'object' && content.text) {
        textToSend = content.text;
      }

      if (textToSend) {
        await feishuAPI.sendTextMessage(to, textToSend);
        console.log(`[Feishu] Message sent to ${to}`);
      } else {
        console.error(`[Feishu] No text content to send:`, content);
        this.sendError(client, 'No text content to send');
        return;
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
