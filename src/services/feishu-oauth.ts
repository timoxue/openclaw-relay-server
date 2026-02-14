import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { database } from './database';

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || 'http://localhost:5178';

interface FeishuPreAuthCodeResponse {
  code: number;
  pre_auth_code: string;
  expires_in: number;
}

interface FeishuUserAccessTokenResponse {
  code: number;
  user_access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface FeishuUserInfoResponse {
  code: number;
  data: {
    user: {
      user_id: string;
      name: string;
      en_name: string;
      avatar_url: string;
    };
  };
}

interface OAuthSession {
  pre_auth_code: string;
  state: string;
  redirect_uri: string;
  expires_at: Date;
}

// Session store for OAuth flows (in-memory for simplicity)
const oauthSessions = new Map<string, OAuthSession>();

export class FeishuOAuth {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://open.feishu.cn',
      timeout: 10000,
    });
  }

  /**
   * Get pre-authorization code from Feishu
   */
  async getPreAuthCode(): Promise<string> {
    // First get tenant_access_token
    const tokenResponse = await this.client.post<{
      code: number;
      app_access_token: string;
    }>('/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET,
    });

    if (tokenResponse.data.code !== 0) {
      throw new Error('Failed to get tenant access token');
    }

    const tenantAccessToken = tokenResponse.data.app_access_token;

    // Get pre-auth code
    const response = await this.client.post<FeishuPreAuthCodeResponse>(
      '/open-apis/authen/v1/oidc/pre_auth_code',
      { app_id: FEISHU_APP_ID },
      {
        headers: {
          Authorization: `Bearer ${tenantAccessToken}`,
        },
      }
    );

    if (response.data.code !== 0) {
      throw new Error(`Failed to get pre-auth code: ${JSON.stringify(response.data)}`);
    }

    return response.data.pre_auth_code;
  }

  /**
   * Generate OAuth authorization URL for QR code
   */
  generateAuthUrl(preAuthCode: string, state: string): string {
    const redirectUri = `${SERVER_BASE_URL}/oauth/callback`;
    const url = new URL('https://open.feishu.cn/open-apis/authen/v1/oidc/authorize');

    url.searchParams.set('app_id', FEISHU_APP_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'openid');
    url.searchParams.set('state', state);
    url.searchParams.set('pre_auth_code', preAuthCode);

    return url.toString();
  }

  /**
   * Create OAuth session and return auth URL
   */
  async createOAuthSession(): Promise<{ authUrl: string; state: string }> {
    const preAuthCode = await this.getPreAuthCode();
    const state = crypto.randomBytes(16).toString('hex');

    oauthSessions.set(state, {
      pre_auth_code: preAuthCode,
      state,
      redirect_uri: `${SERVER_BASE_URL}/oauth/callback`,
      expires_at: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
    });

    const authUrl = this.generateAuthUrl(preAuthCode, state);

    return { authUrl, state };
  }

  /**
   * Exchange authorization code for user access token
   */
  async getUserAccessToken(code: string): Promise<string> {
    const response = await this.client.post<FeishuUserAccessTokenResponse>(
      '/open-apis/authen/v1/oidc/access_token',
      {
        app_id: FEISHU_APP_ID,
        app_secret: FEISHU_APP_SECRET,
        grant_type: 'authorization_code',
        code,
      }
    );

    if (response.data.code !== 0) {
      throw new Error(`Failed to get user access token: ${JSON.stringify(response.data)}`);
    }

    return response.data.user_access_token;
  }

  /**
   * Get user info using user access token
   */
  async getUserInfo(userAccessToken: string): Promise<{ user_id: string; name: string }> {
    const response = await this.client.get<FeishuUserInfoResponse>(
      '/open-apis/authen/v1/user_info',
      {
        headers: {
          Authorization: `Bearer ${userAccessToken}`,
        },
      }
    );

    if (response.data.code !== 0) {
      throw new Error(`Failed to get user info: ${JSON.stringify(response.data)}`);
    }

    return {
      user_id: response.data.data.user.user_id,
      name: response.data.data.user.name,
    };
  }

  /**
   * Complete OAuth flow and generate relay token
   */
  async completeOAuthFlow(code: string): Promise<{ token: string; userId: string; name: string }> {
    const userAccessToken = await this.getUserAccessToken(code);
    const userInfo = await this.getUserInfo(userAccessToken);

    // Generate JWT token for relay server
    const token = this.generateToken(userInfo.user_id);

    // Update or create user in database
    let user = database.getUserByFeishuId(userInfo.user_id);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    if (user) {
      // Update existing user's token
      database.updateUserToken(user.id, token, expiresAt);
    } else {
      // Create new user
      user = database.createUser(userInfo.user_id, token, expiresAt);
    }

    return {
      token,
      userId: userInfo.user_id,
      name: userInfo.name,
    };
  }

  /**
   * Generate JWT token for relay server
   */
  private generateToken(userId: string): string {
    const jwt = require('jsonwebtoken');
    const secret = process.env.JWT_SECRET || 'openclaw-secret-key';

    return jwt.sign(
      {
        userId,
        type: 'relay_token',
      },
      secret,
      { expiresIn: '30d' }
    );
  }

  /**
   * Validate and remove OAuth session
   */
  validateAndRemoveSession(state: string): boolean {
    const session = oauthSessions.get(state);
    if (!session) {
      return false;
    }

    if (new Date() > session.expires_at) {
      oauthSessions.delete(state);
      return false;
    }

    oauthSessions.delete(state);
    return true;
  }

  /**
   * Clean up expired sessions
   */
  cleanupExpiredSessions(): void {
    const now = new Date();
    for (const [state, session] of oauthSessions.entries()) {
      if (now > session.expires_at) {
        oauthSessions.delete(state);
      }
    }
  }
}

export const feishuOAuth = new FeishuOAuth();
