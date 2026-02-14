import { Router, Request, Response } from 'express';
import { database } from '../services/database';
import { qrcodeSessionService, initQRCodeSessionTable } from '../services/qrcode-session';

const router = Router();
const SESSION_EXPIRY_MINUTES = 5;

// Initialize QR code session table
initQRCodeSessionTable();

// Get environment variables
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || 'http://localhost:5178';

/**
 * GET /auth/qrcode - Display QR code login page with Feishu QR SDK
 */
router.get('/auth/qrcode', async (req: Request, res: Response) => {
  try {
    // Create a new QR code session in database
    const session = qrcodeSessionService.createSession();
    const sessionId = session.id;

    // Generate the redirect URI
    const redirectUri = `${SERVER_BASE_URL}/oauth/callback`;

    // Generate QR login URL for Feishu QR SDK
    // Using passport.feishu.cn for QR login
    const goto = `https://passport.feishu.cn/suite/passport/oauth/authorize?` +
      `client_id=${FEISHU_APP_ID}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `response_type=code&` +
      `state=${sessionId}`;

    // Render HTML page with Feishu QR SDK
    res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenClaw 飞书二维码登录</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 20px;
      padding: 40px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 500px;
      width: 100%;
      text-align: center;
    }
    h1 {
      color: #333;
      margin-bottom: 10px;
      font-size: 28px;
    }
    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 14px;
    }
    .qr-container {
      background: #f8f9fa;
      border-radius: 12px;
      padding: 20px;
      margin: 20px 0;
      display: inline-block;
      min-width: 200px;
      min-height: 200px;
    }
    .status {
      margin-top: 30px;
      padding: 15px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      min-height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .status.pending {
      background: #e3f2fd;
      color: #1976d2;
    }
    .status.authenticated {
      background: #d4edda;
      color: #155724;
    }
    .status.expired {
      background: #f8d7da;
      color: #721c24;
    }
    .instructions {
      margin-top: 20px;
      color: #666;
      font-size: 13px;
      line-height: 1.6;
      text-align: left;
    }
    .instructions ol {
      margin: 10px 0;
      padding-left: 20px;
    }
    .instructions li {
      margin: 8px 0;
    }
    .token-display {
      margin-top: 20px;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 8px;
      border: 1px solid #dee2e6;
      display: none;
    }
    .token-display.show {
      display: block;
    }
    .token-label {
      font-size: 12px;
      color: #666;
      margin-bottom: 8px;
    }
    .token-value {
      font-family: 'Courier New', monospace;
      font-size: 12px;
      word-break: break-all;
      background: white;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid #e9ecef;
    }
    .copy-btn {
      margin-top: 10px;
      padding: 10px 20px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
    }
    .copy-btn:hover {
      background: #5568d3;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔐 OpenClaw 登录</h1>
    <p class="subtitle">使用飞书扫描二维码授权登录</p>

    <div class="qr-container" id="login_container"></div>

    <div class="status pending" id="status">
      等待扫描...
    </div>

    <div class="token-display" id="tokenDisplay">
      <div class="token-label">你的 Token：</div>
      <div class="token-value" id="tokenValue"></div>
      <button class="copy-btn" onclick="copyToken()">复制 Token</button>
    </div>

    <div class="instructions">
      <strong>使用说明：</strong>
      <ol>
        <li>使用飞书 App 扫描上方二维码</li>
        <li>在飞书中确认授权登录</li>
        <li>授权成功后自动显示 Token</li>
        <li>将 Token 复制到 OpenClaw 配置文件</li>
      </ol>
    </div>
  </div>

  <!-- Feishu QR SDK -->
  <script src="https://sf3-cn.feishucdn.com/obj/static/lark/passport/qrcode/LarkSSOSDKWebQRCode-1.0.1.js"></script>
  <script>
    const sessionId = '${sessionId}';
    const statusEl = document.getElementById('status');
    const tokenDisplay = document.getElementById('tokenDisplay');
    const tokenValue = document.getElementById('tokenValue');
    const goto = ${JSON.stringify(goto)};

    // Wait for SDK to load
    window.addEventListener('load', function() {
      // Clear container before creating new QR code
      const loginContainer = document.getElementById('login_container');
      loginContainer.innerHTML = '';

      // Initialize Feishu QR Login SDK
      var QRLoginObj = QRLogin({
        id: "login_container",
        goto: goto,
        width: "280",
        height: "280",
        style: "width: 280px; height: 280px;",
        onSuccess: function(res) {
          console.log('QR login success:', res);
        },
        onError: function(err) {
          console.error('QR login error:', err);
          statusEl.textContent = '登录失败: ' + (err.message || '未知错误');
          statusEl.className = 'status expired';
        }
      });

      // Handle message from Feishu QR SDK
      var handleMessage = function(event) {
        var origin = event.origin;
        if (QRLoginObj.matchOrigin(origin)) {
          var loginTmpCode = event.data;
          console.log('Received tmp_code:', loginTmpCode);
          // Redirect to authorization page with tmp_code
          window.location.href = goto + '&tmp_code=' + loginTmpCode;
        }
      };

      if (typeof window.addEventListener != "undefined") {
        window.addEventListener("message", handleMessage, false);
      } else if (typeof window.attachEvent != "undefined") {
        window.attachEvent("onmessage", handleMessage);
      }
    });

    // Handle QR login success
    window.handleLoginSuccess = function(code) {
      console.log('QR login success, code:', code);
      // The code will be sent to the callback endpoint
    };

    // Poll for OAuth status
    function pollStatus() {
      fetch('/api/qrcode/oauth-status/' + sessionId)
        .then(res => res.json())
        .then(data => {
          updateStatus(data);

          if (data.status === 'pending') {
            setTimeout(pollStatus, 2000);
          }
        })
        .catch(err => {
          console.error('Polling error:', err);
          setTimeout(pollStatus, 2000);
        });
    }

    function updateStatus(data) {
      statusEl.className = 'status ' + data.status;

      switch (data.status) {
        case 'pending':
          statusEl.textContent = '等待扫描...';
          break;
        case 'authenticated':
          statusEl.textContent = '✅ 验证成功！';
          tokenDisplay.classList.add('show');
          tokenValue.textContent = data.token || 'Token not available';
          break;
        case 'expired':
          statusEl.textContent = '⏰ 二维码已过期，请刷新页面';
          break;
      }
    }

    function copyToken() {
      const token = tokenValue.textContent;
      // Try modern clipboard API first, fallback to execCommand
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(token).then(() => {
          alert('Token 已复制！');
        }).catch(() => {
          fallbackCopyToken(token);
        });
      } else {
        fallbackCopyToken(token);
      }
    }

    function fallbackCopyToken(token) {
      const textArea = document.createElement('textarea');
      textArea.value = token;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        alert('Token 已复制！');
      } catch (err) {
        alert('复制失败，请手动复制');
      }
      document.body.removeChild(textArea);
    }

    // Start polling
    pollStatus();

    // Auto-refresh after 5 minutes
    setTimeout(() => {
      if (statusEl.textContent.includes('等待')) {
        window.location.reload();
      }
    }, ${SESSION_EXPIRY_MINUTES * 60 * 1000});
  </script>
</body>
</html>
    `);

  } catch (error: any) {
    console.error('QR code page error:', error);
    res.status(500).send('Internal server error');
  }
});

/**
 * GET /api/qrcode/oauth-status/:state - Get OAuth session status
 */
router.get('/api/qrcode/oauth-status/:state', (req: Request, res: Response) => {
  try {
    const { state } = req.params;

    const session = qrcodeSessionService.getSession(state);

    if (!session) {
      return res.json({ status: 'expired' });
    }

    // Check if expired
    const expiresAt = new Date(session.expires_at);
    if (new Date() > expiresAt) {
      return res.json({ status: 'expired' });
    }

    res.json({
      status: session.status,
      token: session.token,
      userId: session.feishu_user_id,
    });

  } catch (error: any) {
    console.error('Get status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /oauth/callback - OAuth callback from Feishu
 */
router.get('/oauth/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      console.error('OAuth error:', error);
      return res.status(400).send(`<h1>授权失败</h1><p>错误: ${error}</p>`);
    }

    if (!code || !state) {
      return res.status(400).send('<h1>授权失败</h1><p>缺少必要的参数</p>');
    }

    const sessionState = state as string;

    // Validate session exists in database
    const session = qrcodeSessionService.getSession(sessionState);
    if (!session) {
      return res.status(400).send('<h1>授权失败</h1><p>会话无效或已过期</p>');
    }

    // Check if expired
    const expiresAt = new Date(session.expires_at);
    if (new Date() > expiresAt) {
      return res.status(400).send('<h1>授权失败</h1><p>会话已过期</p>');
    }

    // Complete OAuth flow
    const result = await completeOAuthFlow(code as string);

    // Update session in database
    const db = database.getDb();
    const stmt = db.prepare(`
      UPDATE qrcode_sessions
      SET token = ?, feishu_user_id = ?, status = 'authenticated'
      WHERE id = ?
    `);
    stmt.run(result.token, result.userId, sessionState);

    // Close the window and return success (for QR SDK)
    res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>授权成功 - OpenClaw</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 20px;
      padding: 40px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 500px;
      width: 100%;
      text-align: center;
    }
    h1 {
      color: #155724;
      margin-bottom: 20px;
      font-size: 32px;
    }
    .success-icon {
      font-size: 64px;
      margin-bottom: 20px;
    }
    .user-info {
      margin: 20px 0;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 8px;
      font-size: 14px;
      color: #666;
    }
    .token-display {
      margin-top: 20px;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 8px;
      border: 1px solid #dee2e6;
    }
    .token-label {
      font-size: 12px;
      color: #666;
      margin-bottom: 8px;
    }
    .token-value {
      font-family: 'Courier New', monospace;
      font-size: 12px;
      word-break: break-all;
      background: white;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid #e9ecef;
    }
    .copy-btn {
      margin-top: 10px;
      padding: 10px 20px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
    }
    .copy-btn:hover {
      background: #5568d3;
    }
    .close-btn {
      margin-top: 15px;
      padding: 8px 16px;
      background: #6c757d;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
    }
    .close-btn:hover {
      background: #5a6268;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="success-icon">✅</div>
    <h1>授权成功！</h1>
    <div class="user-info">
      <strong>用户:</strong> ${result.name}<br>
      <strong>用户ID:</strong> ${result.userId}
    </div>
    <div class="token-display">
      <div class="token-label">你的 Token：</div>
      <div class="token-value" id="tokenValue">${result.token}</div>
      <button class="copy-btn" onclick="copyToken()">复制 Token</button>
    </div>
    <button class="close-btn" onclick="window.close()">关闭窗口</button>
  </div>

  <script>
    function copyToken() {
      const token = document.getElementById('tokenValue').textContent;
      // Try modern clipboard API first, fallback to execCommand
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(token).then(() => {
          alert('Token 已复制！');
        }).catch(() => {
          fallbackCopyToken(token);
        });
      } else {
        fallbackCopyToken(token);
      }
    }

    function fallbackCopyToken(token) {
      const textArea = document.createElement('textarea');
      textArea.value = token;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        alert('Token 已复制！');
      } catch (err) {
        alert('复制失败，请手动复制');
      }
      document.body.removeChild(textArea);
    }
  </script>
</body>
</html>
    `);

  } catch (error: any) {
    console.error('OAuth callback error:', error);
    res.status(500).send(`<h1>授权失败</h1><p>服务器错误: ${error.message}</p>`);
  }
});

/**
 * Complete OAuth flow: exchange code for token and get user info
 */
async function completeOAuthFlow(code: string): Promise<{ token: string; userId: string; name: string }> {
  const axios = require('axios');

  // Step 1: Get app_access_token
  const appTokenResponse = await axios.post('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
    app_id: FEISHU_APP_ID,
    app_secret: process.env.FEISHU_APP_SECRET,
  });

  if (appTokenResponse.data.code !== 0) {
    throw new Error(`Failed to get app access token: ${JSON.stringify(appTokenResponse.data)}`);
  }

  const appAccessToken = appTokenResponse.data.app_access_token;

  // Step 2: Exchange authorization code for user access token using app_access_token
  const tokenResponse = await axios.post('https://open.feishu.cn/open-apis/authen/v1/oidc/access_token', {
    grant_type: 'authorization_code',
    client_id: FEISHU_APP_ID,
    code,
  }, {
    headers: {
      'Authorization': `Bearer ${appAccessToken}`,
    },
  });

  if (tokenResponse.data.code !== 0) {
    throw new Error(`Failed to get user access token: ${JSON.stringify(tokenResponse.data)}`);
  }

  const userAccessToken = tokenResponse.data.data.access_token;
  const refreshToken = tokenResponse.data.data.refresh_token;
  const expiresIn = tokenResponse.data.data.expires_in; // seconds

  // Calculate token expiration time
  const feishuTokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

  // Step 3: Get user info
  const userInfoResponse = await axios.get('https://open.feishu.cn/open-apis/authen/v1/user_info', {
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
    },
  });

  console.log('User info response:', JSON.stringify(userInfoResponse.data));

  if (userInfoResponse.data.code !== 0) {
    throw new Error(`Failed to get user info: ${JSON.stringify(userInfoResponse.data)}`);
  }

  // Handle different response structures
  const userData = userInfoResponse.data.data;
  const userId = userData?.user?.user_id || userData?.user_id;
  const name = userData?.user?.name || userData?.name;

  if (!userId) {
    throw new Error(`Failed to extract user_id from response: ${JSON.stringify(userInfoResponse.data)}`);
  }

  // First create or get user (need database user.id for token payload)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  let user = database.getUserByFeishuId(userId);

  if (user) {
    // Update existing user's Feishu tokens
    database.updateUserAndFeishuTokens(user.id, user.token, expiresAt, userAccessToken, refreshToken, feishuTokenExpiresAt);
  } else {
    // Create new user with Feishu tokens using a temporary token
    const tempToken = 'temp_' + Date.now();
    user = database.createUserWithFeishuTokens(userId, tempToken, expiresAt, userAccessToken, refreshToken, feishuTokenExpiresAt);
  }

  // Generate proper JWT token using tokenService for consistency
  const { tokenService } = require('../services/token');
  const token = tokenService.generateToken({
    userId: user.id,           // ← 数据库用户ID（数字）
    feishuUserId: user.feishu_user_id,  // ← 飞书用户ID（字符串）
  });

  // Update user with the final token
  database.updateUserToken(user.id, token, expiresAt);

  return {
    token,
    userId,   // 飞书用户ID（用于显示）
    name,
  };
}

export default router;
