import { randomBytes } from 'crypto';
import { database } from './database';
import { tokenService } from './token';

interface QRCodeSession {
  id: string;
  created_at: string;
  expires_at: string;
  token: string | null;
  feishu_user_id: string | null;
  status: 'pending' | 'scanned' | 'authenticated';
}

const SESSION_EXPIRY_MINUTES = 5;

export const qrcodeSessionService = {
  /**
   * Create a new QR code session
   */
  createSession: (): QRCodeSession => {
    const sessionId = randomBytes(16).toString('hex');
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + SESSION_EXPIRY_MINUTES * 60 * 1000);

    // Create session in database
    const stmt = database.getDb().prepare(`
      INSERT INTO qrcode_sessions (id, created_at, expires_at, token, feishu_user_id, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(sessionId, createdAt.toISOString(), expiresAt.toISOString(), null, null, 'pending');

    return {
      id: sessionId,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      token: null,
      feishu_user_id: null,
      status: 'pending'
    };
  },

  /**
   * Get session by ID
   */
  getSession: (sessionId: string): QRCodeSession | null => {
    const stmt = database.getDb().prepare(`
      SELECT * FROM qrcode_sessions WHERE id = ?
    `);
    return stmt.get(sessionId) as QRCodeSession | null;
  },

  /**
   * Mark session as scanned (user found it)
   */
  markScanned: (sessionId: string, feishuUserId: string): boolean => {
    const session = qrcodeSessionService.getSession(sessionId);
    if (!session || session.status !== 'pending') {
      return false;
    }

    // Check if session is expired
    if (new Date() > new Date(session.expires_at)) {
      return false;
    }

    // Generate token for the user
    const token = tokenService.getOrCreateUserToken(feishuUserId);

    // Update session
    const stmt = database.getDb().prepare(`
      UPDATE qrcode_sessions
      SET feishu_user_id = ?, token = ?, status = 'scanned'
      WHERE id = ?
    `);

    stmt.run(feishuUserId, token, sessionId);
    return true;
  },

  /**
   * Mark session as authenticated (user confirmed on web)
   */
  markAuthenticated: (sessionId: string): QRCodeSession | null => {
    const session = qrcodeSessionService.getSession(sessionId);
    if (!session || session.status !== 'scanned') {
      return null;
    }

    // Update session status
    const stmt = database.getDb().prepare(`
      UPDATE qrcode_sessions
      SET status = 'authenticated'
      WHERE id = ?
    `);

    stmt.run(sessionId);
    return qrcodeSessionService.getSession(sessionId);
  },

  /**
   * Delete expired sessions
   */
  deleteExpired: (): void => {
    const stmt = database.getDb().prepare(`
      DELETE FROM qrcode_sessions WHERE expires_at < datetime('now')
    `);
    stmt.run();
  },

  /**
   * Clean up old sessions (run periodically)
   */
  cleanup: (): void => {
    qrcodeSessionService.deleteExpired();
    console.log('QR Code session cleanup completed');
  }
};

// Initialize database table
export function initQRCodeSessionTable(): void {
  const db = database.getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS qrcode_sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      token TEXT,
      feishu_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_qrcode_expires ON qrcode_sessions(expires_at)
  `);
}
