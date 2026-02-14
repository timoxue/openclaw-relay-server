export interface TokenPayload {
  userId: number;
  feishuUserId: string;
}

export interface User {
  id: number;
  feishu_user_id: string;
  token: string;
  token_expires_at: Date;
  feishu_access_token: string;
  feishu_refresh_token: string;
  feishu_token_expires_at: Date;
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
