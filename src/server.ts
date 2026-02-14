import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { WebSocketService } from './services/websocket';
import { DualWebSocketService } from './services/dual-websocket';
import { feishuOAuth } from './services/feishu-oauth';
import authRoutes from './routes/auth';
import configRoutes from './routes/config';
import feishuRoutes, { setWebSocketService, setDualWebSocketService } from './routes/feishu';
import qrcodeRoutes from './routes/qrcode';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 3001;

// 双 WebSocket 端口配置
const FEISHU_WS_PORT = Number(process.env.FEISHU_WS_PORT || 5189);
const OPENCLAW_WS_PORT = Number(process.env.OPENCLAW_WS_PORT || 5190);

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
app.use('/', qrcodeRoutes); // QR code routes

// 定期清理过期的 OAuth 会话
setInterval(() => {
  feishuOAuth.cleanupExpiredSessions();
}, 60 * 1000); // 每分钟清理一次

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
// 使用环境变量 USE_DUAL_WS 来决定使用单 WebSocket 还是双 WebSocket
const USE_DUAL_WS = process.env.USE_DUAL_WS === 'true';

let wsService: WebSocketService | null = null;
let dualWsService: DualWebSocketService | null = null;

if (USE_DUAL_WS) {
  // 使用双 WebSocket 服务
  dualWsService = new DualWebSocketService(FEISHU_WS_PORT, OPENCLAW_WS_PORT);
  setDualWebSocketService(dualWsService);
  console.log(`[Dual WS] Feishu WS on port ${FEISHU_WS_PORT}, OpenClaw WS on port ${OPENCLAW_WS_PORT}`);
} else {
  // 使用单 WebSocket 服务（向后兼容）
  wsService = new WebSocketService(Number(WS_PORT));
  setWebSocketService(wsService);
}

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
  console.log(`WebSocket server running on port ${WS_PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  if (wsService) wsService.close();
  if (dualWsService) dualWsService.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  if (wsService) wsService.close();
  if (dualWsService) dualWsService.close();
  process.exit(0);
});
