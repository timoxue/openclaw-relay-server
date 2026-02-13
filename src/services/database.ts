import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { User, Session } from '../types';

const dbDir = path.dirname(process.env.DATABASE_PATH || './database/openclaw_relay.db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(process.env.DATABASE_PATH || './database/openclaw_relay.db');

// 启用外键约束
db.pragma('foreign_keys = ON');

// 创建用户表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feishu_user_id TEXT UNIQUE NOT NULL,
    token TEXT UNIQUE NOT NULL,
    token_expires_at DATETIME NOT NULL,
    ws_connected BOOLEAN DEFAULT 0,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 创建会话表
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    ws_id TEXT NOT NULL,
    connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);

// 创建索引
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_users_feishu_id ON users(feishu_user_id);
  CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);
  CREATE INDEX IF NOT EXISTS idx_sessions_ws_id ON sessions(ws_id);
`);

export const database = {
  // 用户操作
  createUser: (feishuUserId: string, token: string, expiresAt: Date): User => {
    const stmt = db.prepare(`
      INSERT INTO users (feishu_user_id, token, token_expires_at)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(feishuUserId, token, expiresAt.toISOString());
    return database.getUserById(result.lastInsertRowid as number)!;
  },

  getUserByFeishuId: (feishuUserId: string): User | undefined => {
    const stmt = db.prepare('SELECT * FROM users WHERE feishu_user_id = ?');
    return stmt.get(feishuUserId) as User | undefined;
  },

  getUserByToken: (token: string): User | undefined => {
    const stmt = db.prepare('SELECT * FROM users WHERE token = ? AND token_expires_at > datetime("now")');
    return stmt.get(token) as User | undefined;
  },

  getUserById: (id: number): User | undefined => {
    const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
    return stmt.get(id) as User | undefined;
  },

  updateUserToken: (id: number, token: string, expiresAt: Date): void => {
    const stmt = db.prepare(`
      UPDATE users SET token = ?, token_expires_at = ? WHERE id = ?
    `);
    stmt.run(token, expiresAt.toISOString(), id);
  },

  setWsConnected: (userId: number, connected: boolean): void => {
    const stmt = db.prepare(`
      UPDATE users SET ws_connected = ?, last_seen = datetime("now") WHERE id = ?
    `);
    stmt.run(connected ? 1 : 0, userId);
  },

  updateLastSeen: (userId: number): void => {
    const stmt = db.prepare('UPDATE users SET last_seen = datetime("now") WHERE id = ?');
    stmt.run(userId);
  },

  // 会话操作
  createSession: (userId: number, wsId: string): Session => {
    const stmt = db.prepare(`
      INSERT INTO sessions (user_id, ws_id) VALUES (?, ?)
    `);
    const result = stmt.run(userId, wsId);
    const stmt2 = db.prepare('SELECT * FROM sessions WHERE id = ?');
    return stmt2.get(result.lastInsertRowid as number) as Session;
  },

  deleteSession: (wsId: string): void => {
    const stmt = db.prepare('DELETE FROM sessions WHERE ws_id = ?');
    stmt.run(wsId);
  },

  getSessionByWsId: (wsId: string): Session | undefined => {
    const stmt = db.prepare('SELECT * FROM sessions WHERE ws_id = ?');
    return stmt.get(wsId) as Session | undefined;
  },

  getUserByWsId: (wsId: string): User | undefined => {
    const stmt = db.prepare(`
      SELECT u.* FROM users u
      INNER JOIN sessions s ON u.id = s.user_id
      WHERE s.ws_id = ?
    `);
    return stmt.get(wsId) as User | undefined;
  },
};

export default db;
