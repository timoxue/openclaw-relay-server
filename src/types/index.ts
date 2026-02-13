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
