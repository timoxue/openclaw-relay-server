import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import * as lark from '@larksuiteoapi/node-sdk';
import { feishuOAuth } from './services/feishu-oauth';
import { orchestrator } from './services/orchestrator';
import authRoutes from './routes/auth';
import configRoutes from './routes/config';
import feishuRoutes from './routes/feishu';
import qrcodeRoutes from './routes/qrcode';
import orchestratorRoutes from './routes/orchestrator';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5178;

// Feishu configuration
const appId = process.env.FEISHU_APP_ID || '';
const appSecret = process.env.FEISHU_APP_SECRET || '';
const encryptKey = process.env.FEISHU_ENCRYPT_KEY || '';
const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN || '';

console.log('[Server] Feishu configuration:');
console.log(`[Server]   App ID: ${appId}`);
console.log(`[Server]   App Secret: ${appSecret ? '***' : 'NOT SET'}`);
console.log(`[Server]   Encrypt Key: ${encryptKey ? 'SET' : 'NOT SET (can be empty)'}`);
console.log(`[Server]   Verification Token: ${verificationToken ? 'SET' : 'NOT SET'}`);

// Create Feishu API client
export const feishuApiClient = new lark.Client({
  appId,
  appSecret,
  appType: lark.AppType.SelfBuild,
});

// Create Feishu WebSocket client
export const feishuWSClient = new lark.WSClient({
  appId,
  appSecret,
  loggerLevel: lark.LoggerLevel.debug,
});

// Feishu connection status
let feishuConnected = false;

// Middleware
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
      feishu: feishuConnected,
    },
  });
});

// 路由
app.use('/api/auth', authRoutes);
app.use('/api/config', configRoutes);
app.use('/api/feishu', feishuRoutes);
app.use('/api/orchestrator', orchestratorRoutes);
app.use('/', qrcodeRoutes);

// 定期清理过期的 OAuth 会话
setInterval(() => {
  feishuOAuth.cleanupExpiredSessions();
}, 60 * 1000);

// 初始化 orchestrator 和 Feishu WebSocket
async function initializeOrchestrator() {
  try {
    console.log('[Server] Initializing orchestrator and Feishu WebSocket...');

    // Create event dispatcher
    const eventDispatcher = new lark.EventDispatcher({
      encryptKey,
      verificationToken,
    }).register({
      'im.message.receive_v1': async (data: any) => {
        console.log('\n=== MESSAGE RECEIVED (im.message.receive_v1) ===');
        console.log('Event:', JSON.stringify(data, null, 2));
        console.log('=========================\n');

        // Directly access user ID from raw data
        const userId = data.sender?.sender_id?.user_id || '';

        console.log(`[Server] Direct user ID access: ${userId}`);

        // Create message object for orchestrator
        // Note: Feishu SDK passes event data with flattened structure
        const message = data.message || {};
        const sender = data.sender || {};

        const messageData = {
          header: {
            event_id: data.event_id || '',
            event_type: data.event_type || '',
            create_time: data.create_time || '',
            token: data.token || '',
            app_type: data.app_type || '',
            tenant_key: data.tenant_key || '',
          },
          event: {
            sender: {
              sender_id: {
                user_id: userId,
                open_id: sender.sender_id?.open_id || '',
                union_id: sender.sender_id?.union_id || '',
              },
              sender_type: sender.sender_type || '',
            },
            message: {
              message_id: message.message_id || '',
              chat_type: message.chat_type || '',
              chat_id: message.chat_id || '',
              content: message.content || '',
              create_time: message.create_time || '',
              update_time: message.update_time || '',
              message_type: message.message_type || '',
            },
          },
        };

        // Pass to orchestrator
        if (messageData) {
          await orchestrator.handleFeishuMessage(messageData);
        }
      },
      'application.bot.menu_v6': async (data: any) => {
        console.log('\n=== MENU CLICK EVENT ===');
        console.log('Event:', JSON.stringify(data, null, 2));
        console.log('=========================\n');
        // Handle menu/button clicks if needed
      },
    });

    // Start WebSocket connection
    await feishuWSClient.start({
      eventDispatcher: eventDispatcher,
    });

    console.log('[Server] Feishu WebSocket connected successfully');
    feishuConnected = true;

    // Initialize orchestrator
    await orchestrator.initialize();

    console.log('[Server] Orchestrator initialized successfully');
  } catch (error) {
    console.error('[Server] Failed to initialize orchestrator:', error);
    throw error;
  }
}

// Parse Feishu message event
function parseFeishuMessage(data: any): any {
  try {
    // Debug: log raw data structure
    console.log('[Server] Raw event data:', JSON.stringify(data, null, 2));

    // Feishu SDK event data structure
    const header = data.header || {};
    const event = data.event || {};
    const sender = event.sender || {};
    const sender_id = sender.sender_id || {};
    const message = event.message || {};

    console.log('[Server] sender object:', JSON.stringify(sender, null, 2));
    console.log('[Server] sender_id object:', JSON.stringify(sender_id, null, 2));

    const userId = sender_id.user_id || sender_id.open_id || '';
    console.log(`[Server] Parsed user ID: ${userId}`);

    return {
      header: {
        event_id: header.event_id || '',
        event_type: header.event_type || '',
        create_time: header.create_time || '',
        token: header.token || '',
        app_type: header.app_type || '',
        tenant_key: header.tenant_key || '',
      },
      event: {
        sender: {
          sender_id: {
            user_id: userId,
            open_id: sender_id.open_id || '',
            union_id: sender_id.union_id || '',
          },
          sender_type: sender.sender_type || '',
        },
        message: {
          message_id: message.message_id || '',
          chat_type: message.chat_type || '',
          chat_id: message.chat_id || '',
          content: message.content || '',
          create_time: message.create_time || '',
        },
      },
    };
  } catch (error) {
    console.error('[Server] Failed to parse message:', error);
    return null;
  }
}

// Send text message to Feishu user
export async function sendFeishuMessage(userId: string, text: string): Promise<boolean> {
  try {
    console.log(`[Server] Sending text message to user ${userId}: ${text}`);

    const response = await feishuApiClient.im.message.create({
      params: {
        receive_id_type: 'user_id',
      },
      data: {
        receive_id: userId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });

    if (response.code === 0) {
      console.log('[Server] Message sent successfully');
      return true;
    } else {
      console.error(`[Server] Failed to send message: code=${response.code}, msg=${response.msg}`);
      return false;
    }
  } catch (error) {
    console.error('[Server] Error sending message:', error);
    return false;
  }
}

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
app.listen(PORT, async () => {
  console.log(`API server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

  await initializeOrchestrator();
});

// 优雅关闭
const gracefulShutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down gracefully...`);

  try {
    // Stop Feishu WebSocket
    feishuWSClient.close({ force: true });
    console.log('[Server] Feishu WebSocket stopped');

    // Shutdown orchestrator
    await orchestrator.shutdown();
    console.log('[Server] Orchestrator shut down');

    console.log('[Server] All services shut down successfully');
    process.exit(0);
  } catch (error) {
    console.error('[Server] Error during graceful shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
