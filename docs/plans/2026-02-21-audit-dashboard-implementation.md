# Audit Dashboard System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement comprehensive audit and monitoring system with LLM proxy, keyword extraction, and dashboard analytics.

**Architecture:** Modular services (LLM Proxy, Keyword Extractor, Audit Service, Stats Aggregator) using existing database and Feishu APIs.

**Tech Stack:** TypeScript, better-sqlite3, axios, @larksuiteoapi/node-sdk, TF-IDF algorithm

---

## Task 1: Audit Type Definitions

**Files:**
- Create: `src/types/audit.ts`

**Step 1: Write audit types**

```typescript
// src/types/audit.ts

export enum ActionType {
  MESSAGE_SEND = 'message_send',
  LLM_REQUEST = 'llm_request',
  SENSITIVE_INTERCEPT = 'sensitive_intercept',
  KNOWLEDGE_EXTRACT = 'knowledge_extract',
  PROXY_REQUEST = 'proxy_request',
  CONTAINER_START = 'container_start',
  CONTAINER_STOP = 'container_stop',
}

export interface AuditLog {
  id?: number;
  userId: string;
  actionType: ActionType;
  actionData?: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface TokenUsage {
  id?: number;
  userId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timestamp: Date;
  requestId?: string;
}

export interface SensitiveWord {
  id?: number;
  word: string;
  category?: string;
  severity?: number;
  createdAt?: Date;
}

export interface KnowledgeEntry {
  id?: number;
  sourceType: string;
  sourceUrl?: string;
  title?: string;
  content: string;
  extractedAt: Date;
  userId?: string;
}

export interface Department {
  userId: string;
  department: string;
}

export interface DashboardMetrics {
  assets: {
    keywords: { word: string; count: number }[];
    knowledgeCount: number;
  };
  collaboration: {
    crossDeptIndex: Record<string, Record<string, number>>;
    avgApprovalTime: number; // seconds
  };
  cost: {
    byDepartment: Record<string, { tokens: number; cost: number }>;
    totalTokens: number;
    totalCost: number;
  };
  risk: {
    sensitiveInterceptions: number;
    sandboxHealth: 'healthy' | 'warning' | 'error';
  };
}
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS with no TypeScript errors

**Step 3: Commit**

```bash
git add src/types/audit.ts
git commit -m "feat: add audit type definitions"
```

---

## Task 2: Database Schema for Audit

**Files:**
- Modify: `src/services/database.ts`

**Step 1: Add audit tables and indexes**

Insert after `proxy_requests` table creation (around line 84):

```typescript
// 创建审计日志表
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    action_data TEXT,
    timestamp INTEGER NOT NULL,
    metadata TEXT
  )
`);

// 创建 Token 使用表
db.exec(`
  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    request_id TEXT
  )
`);

// 创建敏感词表
db.exec(`
  CREATE TABLE IF NOT EXISTS sensitive_words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT UNIQUE NOT NULL,
    category TEXT,
    severity INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  )
`);

// 创建知识库表
db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_base (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    source_url TEXT,
    title TEXT,
    content TEXT NOT NULL,
    extracted_at INTEGER DEFAULT (strftime('%s', 'now')),
    user_id TEXT
  )
`);

// 创建部门映射表
db.exec(`
  CREATE TABLE IF NOT EXISTS departments (
    user_id TEXT PRIMARY KEY,
    department TEXT NOT NULL
  )
`);
```

Add indexes after existing indexes (around line 98):

```typescript
  CREATE INDEX IF NOT EXISTS idx_audit_user_time
  ON audit_logs(user_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_type_time
  ON audit_logs(action_type, timestamp);
  CREATE INDEX IF NOT EXISTS idx_usage_user_time
  ON token_usage(user_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_usage_model_time
  ON token_usage(model, timestamp);
  CREATE INDEX IF NOT EXISTS idx_sensitive_word
  ON sensitive_words(word);
  CREATE INDEX IF NOT EXISTS idx_kb_source
  ON knowledge_base(source_type, extracted_at);
```

**Step 2: Add database operations**

Insert before closing brace of `database` export (around line 389):

```typescript
  // Audit operations
  createAuditLog: (log: {
    userId: string;
    actionType: string;
    actionData?: string;
    metadata?: Record<string, any>;
  }): void => {
    const stmt = db.prepare(`
      INSERT INTO audit_logs (user_id, action_type, action_data, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      log.userId,
      log.actionType,
      log.actionData || null,
      Math.floor(Date.now() / 1000),
      log.metadata ? JSON.stringify(log.metadata) : null
    );
  },

  getAuditLogs: (userId?: string, limit: number = 100): any[] => {
    let query = 'SELECT * FROM audit_logs';
    const params: any[] = [];

    if (userId) {
      query += ' WHERE user_id = ?';
      params.push(userId);
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    const stmt = db.prepare(query);
    return stmt.all(...params).map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      actionType: row.action_type,
      actionData: row.action_data,
      timestamp: new Date((row.timestamp as number) * 1000),
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));
  },

  // Token usage operations
  createTokenUsage: (usage: {
    userId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    requestId?: string;
  }): void => {
    const stmt = db.prepare(`
      INSERT INTO token_usage
      (user_id, model, prompt_tokens, completion_tokens, total_tokens, timestamp, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      usage.userId,
      usage.model,
      usage.promptTokens,
      usage.completionTokens,
      usage.totalTokens,
      Math.floor(Date.now() / 1000),
      usage.requestId || null
    );
  },

  getTokenUsageByUser: (userId: string, days: number = 30): any[] => {
    const since = Math.floor((Date.now() - days * 24 * 3600 * 1000) / 1000);
    const stmt = db.prepare(`
      SELECT * FROM token_usage
      WHERE user_id = ? AND timestamp >= ?
      ORDER BY timestamp DESC
    `);
    return stmt.all(userId, since);
  },

  getTokenUsageByDepartment: (days: number = 30): any[] => {
    const since = Math.floor((Date.now() - days * 24 * 3600 * 1000) / 1000);
    const stmt = db.prepare(`
      SELECT d.department, SUM(u.total_tokens) as total_tokens
      FROM token_usage u
      INNER JOIN departments d ON u.user_id = d.user_id
      WHERE u.timestamp >= ?
      GROUP BY d.department
    `);
    return stmt.all(since);
  },

  // Sensitive words operations
  addSensitiveWord: (word: string, category?: string, severity?: number): void => {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO sensitive_words (word, category, severity)
      VALUES (?, ?, ?)
    `);
    stmt.run(word, category || null, severity || 1);
  },

  getSensitiveWords: (): any[] => {
    const stmt = db.prepare('SELECT * FROM sensitive_words ORDER BY severity DESC');
    return stmt.all();
  },

  checkSensitiveContent: (content: string): { detected: boolean; word?: string } => {
    const words = db.prepare('SELECT word FROM sensitive_words').all() as { word: string }[];
    for (const { word } of words) {
      if (content.includes(word)) {
        return { detected: true, word };
      }
    }
    return { detected: false };
  },

  // Knowledge base operations
  addKnowledgeEntry: (entry: {
    sourceType: string;
    sourceUrl?: string;
    title?: string;
    content: string;
    userId?: string;
  }): void => {
    const stmt = db.prepare(`
      INSERT INTO knowledge_base (source_type, source_url, title, content, user_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.sourceType,
      entry.sourceUrl || null,
      entry.title || null,
      entry.content,
      entry.userId || null
    );
  },

  getKnowledgeStats: (days: number = 7): { count: number; byType: Record<string, number> } => {
    const since = Math.floor((Date.now() - days * 24 * 3600 * 1000) / 1000);
    const stmt = db.prepare(`
      SELECT source_type, COUNT(*) as count
      FROM knowledge_base
      WHERE extracted_at >= ?
      GROUP BY source_type
    `);
    const rows = stmt.all(since) as { source_type: string; count: number }[];
    const byType: Record<string, number> = {};
    let total = 0;

    for (const row of rows) {
      byType[row.source_type] = row.count;
      total += row.count;
    }

    return { count: total, byType };
  },

  // Department operations
  setDepartment: (userId: string, department: string): void => {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO departments (user_id, department)
      VALUES (?, ?)
    `);
    stmt.run(userId, department);
  },

  getDepartment: (userId: string): string | null => {
    const stmt = db.prepare('SELECT department FROM departments WHERE user_id = ?');
    const result = stmt.get(userId) as { department: string } | undefined;
    return result?.department || null;
  },

  getAllDepartments: (): Record<string, string> => {
    const stmt = db.prepare('SELECT user_id, department FROM departments');
    const rows = stmt.all() as { user_id: string; department: string }[];
    const result: Record<string, string> = {};

    for (const row of rows) {
      result[row.user_id] = row.department;
    }

    return result;
  },
```

**Step 3: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/services/database.ts
git commit -m "feat: add audit tables and database operations"
```

---

## Task 3: Audit Service

**Files:**
- Create: `src/services/audit-service.ts`

**Step 1: Write audit service**

```typescript
// src/services/audit-service.ts

import { database } from './database';
import type { AuditLog, SensitiveWord, KnowledgeEntry } from '../types/audit';

export class AuditService {
  /**
   * Record audit log
   */
  log(userId: string, actionType: string, actionData?: string, metadata?: Record<string, any>): void {
    database.createAuditLog({
      userId,
      actionType,
      actionData,
      metadata,
    });
  }

  /**
   * Check if content contains sensitive words
   */
  checkSensitiveContent(content: string): { detected: boolean; word?: string } {
    return database.checkSensitiveContent(content);
  }

  /**
   * Add sensitive word to library
   */
  addSensitiveWord(word: string, category?: string, severity?: number): void {
    database.addSensitiveWord(word, category, severity);
  }

  /**
   * Get all sensitive words
   */
  getSensitiveWords(): SensitiveWord[] {
    return database.getSensitiveWords();
  }

  /**
   * Add knowledge base entry
   */
  addKnowledgeEntry(entry: KnowledgeEntry): void {
    database.addKnowledgeEntry(entry);
  }

  /**
   * Get audit logs for user
   */
  getAuditLogs(userId?: string, limit: number = 100): AuditLog[] {
    return database.getAuditLogs(userId, limit);
  }

  /**
   * Get statistics
   */
  getStats(days: number = 7): any {
    const knowledgeStats = database.getKnowledgeStats(days);
    const tokenUsage = database.getTokenUsageByDepartment(days);

    return {
      knowledge: knowledgeStats,
      tokenUsage,
    };
  }
}

export const auditService = new AuditService();
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/services/audit-service.ts
git commit -m "feat: add AuditService for logging and sensitive word check"
```

---

## Task 4: Stop Words List

**Files:**
- Create: `src/utils/stop-words.ts`

**Step 1: Write Chinese stop words**

```typescript
// src/utils/stop-words.ts

/**
 * Common Chinese stop words
 */
export const STOP_WORDS = new Set([
  // 常用助词
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看',
  // 代词
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们', '它们',
  '这', '那', '这', '那', '这个', '那个', '这里', '那里',
  // 连词
  '和', '与', '或', '但是', '因此', '所以', '如果', '那么', '因为', '而',
  // 介词
  '在', '从', '到', '于', '对', '向', '为', '以', '把', '被',
  // 副词
  '很', '非常', '太', '更', '最', '都', '也', '不', '没', '已经', '刚刚',
  '正在', '马上', '立刻', '突然', '仍然', '始终',
  // 助词
  '了', '着', '过', '吧', '吗', '呢', '啊', '呀', '啦',
  // 量词
  '个', '些', '点', '次', '回', '遍', '趟',
  // 动词（高频）
  '是', '有', '做', '说', '看', '听', '想', '要', '用', '给', '叫', '让',
  '帮', '问', '答', '说', '讲', '谈', '讨论',
  // 形容词（高频）
  '大', '小', '多', '少', '好', '坏', '新', '旧', '高', '低', '长', '短',
  '快', '慢', '早', '晚', '远', '近', '厚', '薄',
  // 其他
  '什么', '怎么', '怎样', '如何', '为什么', '哪儿', '哪里', '哪儿', '谁',
  '多少', '几', '哪些', '这些', '那些', '这种', '那种',
]);
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/utils/stop-words.ts
git commit -m "feat: add Chinese stop words list"
```

---

## Task 5: Keyword Extractor

**Files:**
- Create: `src/services/keyword-extractor.ts`

**Step 1: Write keyword extractor**

```typescript
// src/services/keyword-extractor.ts

import { STOP_WORDS } from '../utils/stop-words';

interface Document {
  id: string;
  words: Set<string>;
  wordCount: number;
}

interface KeywordScore {
  word: string;
  score: number;
  count: number;
}

/**
 * Lightweight keyword extractor using TF-IDF
 */
export class KeywordExtractor {
  private documents: Document[] = [];
  private topKeywords: Map<string, number> = new Map();

  /**
   * Segment Chinese text (simple character-based for now)
   */
  private segment(text: string): string[] {
    // Remove punctuation and split into words
    const cleanText = text
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, ' ')
      .toLowerCase();
    const words = cleanText.split(/\s+/).filter(w => w.length > 1);

    return words.filter(word => !STOP_WORDS.has(word));
  }

  /**
   * Add document to corpus
   */
  addDocument(id: string, text: string): void {
    const words = new Set(this.segment(text));
    this.documents.push({
      id,
      words,
      wordCount: words.size,
    });

    // Update top keywords counter
    for (const word of words) {
      this.topKeywords.set(word, (this.topKeywords.get(word) || 0) + 1);
    }
  }

  /**
   * Calculate TF-IDF scores
   */
  private calculateTFIDF(word: string, doc: Document): number {
    // TF: term frequency in document
    const tf = doc.words.has(word) ? 1 : 0;

    // IDF: inverse document frequency
    const docsWithWord = this.documents.filter(d => d.words.has(word)).length;
    const idf = Math.log(this.documents.length / (docsWithWord + 1));

    return tf * idf;
  }

  /**
   * Extract top N keywords from corpus
   */
  extractTopKeywords(topN: number = 20): KeywordScore[] {
    const scores: KeywordScore[] = [];

    for (const [word, count] of this.topKeywords.entries()) {
      // Calculate average TF-IDF across documents
      let totalScore = 0;
      let docsWithWord = 0;

      for (const doc of this.documents) {
        if (doc.words.has(word)) {
          totalScore += this.calculateTFIDF(word, doc);
          docsWithWord++;
        }
      }

      const avgScore = docsWithWord > 0 ? totalScore / docsWithWord : 0;

      scores.push({
        word,
        score: avgScore,
        count,
      });
    }

    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
  }

  /**
   * Extract keywords from single text
   */
  extractFromText(text: string, topN: number = 10): string[] {
    const words = this.segment(text);
    const wordFreq = new Map<string, number>();

    for (const word of words) {
      wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
    }

    return Array.from(wordFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([word]) => word);
  }

  /**
   * Clear document corpus
   */
  clear(): void {
    this.documents = [];
    this.topKeywords.clear();
  }

  /**
   * Get corpus size
   */
  size(): number {
    return this.documents.length;
  }
}

export const keywordExtractor = new KeywordExtractor();
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/services/keyword-extractor.ts
git commit -m "feat: add TF-IDF keyword extractor with Chinese stop words"
```

---

## Task 6: Stats Aggregator

**Files:**
- Create: `src/services/stats-aggregator.ts`

**Step 1: Write stats aggregator**

```typescript
// src/services/stats-aggregator.ts

import { database } from './database';
import { keywordExtractor } from './keyword-extractor';
import type { DashboardMetrics } from '../types/audit';
import { RequestStatus } from '../types/proxy-request';

/**
 * Aggregate dashboard metrics for four modules
 */
export class StatsAggregator {
  /**
   * Get keywords cloud (24h)
   */
  getKeywordsCloud(hours: number = 24): { word: string; count: number }[] {
    const since = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
    const logs = database
      .prepare('SELECT * FROM audit_logs WHERE timestamp >= ?')
      .all(since) as any[];

    keywordExtractor.clear();

    for (const log of logs) {
      if (log.action_data) {
        keywordExtractor.addDocument(log.id.toString(), log.action_data);
      }
    }

    const topKeywords = keywordExtractor.extractTopKeywords(30);
    return topKeywords.map(k => ({ word: k.word, count: k.count }));
  }

  /**
   * Get knowledge extraction stats (24h)
   */
  getKnowledgeStats(hours: number = 24): { count: number; byType: Record<string, number> } {
    const since = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
    const rows = database
      .prepare('SELECT source_type, COUNT(*) as count FROM knowledge_base WHERE extracted_at >= ? GROUP BY source_type')
      .all(since) as { source_type: string; count: number }[];

    const byType: Record<string, number> = {};
    let total = 0;

    for (const row of rows) {
      byType[row.source_type] = row.count;
      total += row.count;
    }

    return { count: total, byType };
  }

  /**
   * Get cross-department collaboration index
   */
  getCrossDeptIndex(hours: number = 24): Record<string, Record<string, number>> {
    const since = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
    const rows = database
      .prepare(`
        SELECT
          d1.department as from_dept,
          d2.department as to_dept,
          COUNT(*) as count
        FROM proxy_requests p
        INNER JOIN departments d1 ON p.requestor_user_id = d1.user_id
        INNER JOIN departments d2 ON p.target_user_id = d2.user_id
        WHERE p.created_at >= ? AND p.status = ?
        GROUP BY d1.department, d2.department
      `)
      .all(since, RequestStatus.APPROVED) as any[];

    const index: Record<string, Record<string, number>> = {};

    for (const row of rows) {
      if (!index[row.from_dept]) {
        index[row.from_dept] = {};
      }
      index[row.from_dept][row.to_dept] = row.count;
    }

    return index;
  }

  /**
   * Get average approval response time
   */
  getAvgApprovalTime(hours: number = 24): number {
    const since = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
    const row = database
      .prepare(`
        SELECT AVG(updated_at - created_at) as avg_time
        FROM proxy_requests
        WHERE created_at >= ? AND status = ?
      `)
      .get(since, RequestStatus.APPROVED) as { avg_time: number } | undefined;

    return row?.avg_time || 0;
  }

  /**
   * Get token consumption by department
   */
  getTokenConsumption(days: number = 7): Record<string, { tokens: number; cost: number }> {
    const since = Math.floor((Date.now() - days * 24 * 3600 * 1000) / 1000);
    const rows = database
      .prepare(`
        SELECT d.department, SUM(u.total_tokens) as total_tokens
        FROM token_usage u
        INNER JOIN departments d ON u.user_id = d.user_id
        WHERE u.timestamp >= ?
        GROUP BY d.department
      `)
      .all(since) as { department: string; total_tokens: number }[];

    const result: Record<string, { tokens: number; cost: number }> = {};
    const costPerToken = 0.0001; // Adjust based on actual pricing

    for (const row of rows) {
      result[row.department] = {
        tokens: row.total_tokens,
        cost: row.total_tokens * costPerToken,
      };
    }

    return result;
  }

  /**
   * Get sensitive interception stats
   */
  getSensitiveStats(hours: number = 24): { count: number; byCategory: Record<string, number> } {
    const since = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
    const logs = database
      .prepare(`
        SELECT metadata FROM audit_logs
        WHERE action_type = 'sensitive_intercept' AND timestamp >= ?
      `)
      .all(since) as { metadata: string }[];

    const byCategory: Record<string, number> = {};

    for (const log of logs) {
      try {
        const meta = JSON.parse(log.metadata);
        const category = meta.category || 'unknown';
        byCategory[category] = (byCategory[category] || 0) + 1;
      } catch {
        // Ignore parse errors
      }
    }

    return { count: logs.length, byCategory };
  }

  /**
   * Get sandbox health status
   */
  getSandboxHealth(): 'healthy' | 'warning' | 'error' {
    // Count containers by status
    const running = database
      .prepare('SELECT COUNT(*) as count FROM audit_logs WHERE action_type = ? AND timestamp >= ?')
      .get('container_start', Math.floor((Date.now() - 3600000) / 1000)) as { count: number };

    const stopped = database
      .prepare('SELECT COUNT(*) as count FROM audit_logs WHERE action_type = ? AND timestamp >= ?')
      .get('container_stop', Math.floor((Date.now() - 3600000) / 1000)) as { count: number };

    // Simple health check
    if (stopped.count > running.count) {
      return 'warning';
    }

    return 'healthy';
  }

  /**
   * Get all dashboard metrics
   */
  getDashboardMetrics(): DashboardMetrics {
    return {
      assets: {
        keywords: this.getKeywordsCloud(24),
        knowledgeCount: this.getKnowledgeStats(24).count,
      },
      collaboration: {
        crossDeptIndex: this.getCrossDeptIndex(24),
        avgApprovalTime: this.getAvgApprovalTime(24),
      },
      cost: {
        byDepartment: this.getTokenConsumption(7),
        totalTokens: 0,
        totalCost: 0,
      },
      risk: {
        sensitiveInterceptions: this.getSensitiveStats(24).count,
        sandboxHealth: this.getSandboxHealth(),
      },
    };
  }
}

export const statsAggregator = new StatsAggregator();
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/services/stats-aggregator.ts
git commit -m "feat: add StatsAggregator for dashboard metrics"
```

---

## Task 7: LLM Proxy Service

**Files:**
- Create: `src/services/llm-proxy.ts`

**Step 1: Write LLM proxy service**

```typescript
// src/services/llm-proxy.ts

import axios from 'axios';
import { database } from './database';
import { auditService } from './audit-service';

const ZHIPU_API_BASE = 'https://open.bigmodel.cn/api/paas/v4';

interface ChatCompletionRequest {
  model: string;
  messages: any[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

interface ChatCompletionResponse {
  id: string;
  created: number;
  model: string;
  choices: any[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class LLMProxyService {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.ZHIPU_API_KEY_GLM4 || process.env.LLM_API_KEY || '';
  }

  /**
   * Forward chat completion request to Zhipu API
   */
  async forwardChatCompletion(userId: string, request: ChatCompletionRequest): Promise<any> {
    // Audit log
    auditService.log(userId, 'llm_request', JSON.stringify(request), {
      model: request.model,
      messageCount: request.messages.length,
    });

    // Check sensitive content
    const userMessage = this.extractUserMessage(request);
    const sensitiveCheck = auditService.checkSensitiveContent(userMessage);

    if (sensitiveCheck.detected) {
      auditService.log(userId, 'sensitive_intercept', userMessage, {
        word: sensitiveCheck.word,
        userId,
      });

      return {
        error: {
          message: 'Content contains sensitive words',
          code: 'sensitive_content',
        },
      };
    }

    try {
      const response = await axios.post<ChatCompletionResponse>(
        `${ZHIPU_API_BASE}/chat/completions`,
        request,
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Async billing - store usage
      if (response.data.usage) {
        this.recordUsage(userId, request.model, response.data.usage, response.data.id);
      }

      return response.data;
    } catch (error: any) {
      console.error('[LLMProxy] Forward error:', error.message);
      throw error;
    }
  }

  /**
   * Extract user message from request
   */
  private extractUserMessage(request: ChatCompletionRequest): string {
    if (request.messages && request.messages.length > 0) {
      const lastMessage = request.messages[request.messages.length - 1];
      if (typeof lastMessage.content === 'string') {
        return lastMessage.content;
      } else if (Array.isArray(lastMessage.content)) {
        return JSON.stringify(lastMessage.content);
      }
    }
    return '';
  }

  /**
   * Record token usage asynchronously
   */
  private recordUsage(userId: string, model: string, usage: any, requestId: string): void {
    // Use setImmediate for async processing
    setImmediate(() => {
      try {
        database.createTokenUsage({
          userId,
          model,
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
          requestId,
        });
      } catch (error) {
        console.error('[LLMProxy] Failed to record usage:', error);
      }
    });
  }
}

export const llmProxyService = new LLMProxyService();
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/services/llm-proxy.ts
git commit -m "feat: add LLMProxyService with async billing"
```

---

## Task 8: LLM Proxy Route

**Files:**
- Create: `src/routes/llm-proxy.ts`

**Step 1: Write LLM proxy route**

```typescript
// src/routes/llm-proxy.ts

import express from 'express';
import { llmProxyService } from '../services/llm-proxy';
import { auditService } from '../services/audit-service';

const router = express.Router();

/**
 * POST /v1/chat/completions
 * LLM proxy endpoint for containers
 */
router.post('/v1/chat/completions', async (req, res) => {
  try {
    // Extract user ID from header or query
    const userId = req.headers['x-user-id'] as string || req.query.userId as string;

    if (!userId) {
      return res.status(401).json({
        error: {
          message: 'Missing user identification',
          code: 'missing_user_id',
        },
      });
    }

    // Forward request
    const response = await llmProxyService.forwardChatCompletion(userId, req.body);

    if (response.error) {
      return res.status(400).json(response);
    }

    res.json(response);
  } catch (error: any) {
    console.error('[LLMProxy Route] Error:', error);
    res.status(500).json({
      error: {
        message: 'Internal server error',
        code: 'internal_error',
      },
    });
  }
});

export default router;
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/routes/llm-proxy.ts
git commit -m "feat: add LLM proxy route /v1/chat/completions"
```

---

## Task 9: Dashboard Route

**Files:**
- Create: `src/routes/dashboard.ts`

**Step 1: Write dashboard route**

```typescript
// src/routes/dashboard.ts

import express from 'express';
import { statsAggregator } from '../services/stats-aggregator';
import { auditService } from '../services/audit-service';

const router = express.Router();

/**
 * GET /api/dashboard/metrics
 * Get all dashboard metrics
 */
router.get('/metrics', (req, res) => {
  try {
    const metrics = statsAggregator.getDashboardMetrics();
    res.json(metrics);
  } catch (error: any) {
    console.error('[Dashboard] Error getting metrics:', error);
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

/**
 * GET /api/dashboard/keywords
 * Get keyword cloud
 */
router.get('/keywords', (req, res) => {
  const hours = parseInt(req.query.hours as string) || 24;
  const keywords = statsAggregator.getKeywordsCloud(hours);
  res.json({ keywords });
});

/**
 * GET /api/dashboard/knowledge
 * Get knowledge extraction stats
 */
router.get('/knowledge', (req, res) => {
  const hours = parseInt(req.query.hours as string) || 24;
  const stats = statsAggregator.getKnowledgeStats(hours);
  res.json(stats);
});

/**
 * GET /api/dashboard/collaboration
 * Get collaboration metrics
 */
router.get('/collaboration', (req, res) => {
  const hours = parseInt(req.query.hours as string) || 24;
  const crossDeptIndex = statsAggregator.getCrossDeptIndex(hours);
  const avgApprovalTime = statsAggregator.getAvgApprovalTime(hours);
  res.json({ crossDeptIndex, avgApprovalTime });
});

/**
 * GET /api/dashboard/cost
 * Get cost metrics
 */
router.get('/cost', (req, res) => {
  const days = parseInt(req.query.days as string) || 7;
  const consumption = statsAggregator.getTokenConsumption(days);
  res.json(consumption);
});

/**
 * GET /api/dashboard/risk
 * Get risk metrics
 */
router.get('/risk', (req, res) => {
  const hours = parseInt(req.query.hours as string) || 24;
  const sensitiveStats = statsAggregator.getSensitiveStats(hours);
  const health = statsAggregator.getSandboxHealth();
  res.json({
    sensitiveInterceptions: sensitiveStats.count,
    byCategory: sensitiveStats.byCategory,
    sandboxHealth: health,
  });
});

/**
 * POST /api/dashboard/sensitive-words
 * Add sensitive word
 */
router.post('/sensitive-words', (req, res) => {
  const { word, category, severity } = req.body;

  if (!word) {
    return res.status(400).json({ error: 'Missing word' });
  }

  auditService.addSensitiveWord(word, category, severity);
  res.json({ success: true });
});

/**
 * GET /api/dashboard/sensitive-words
 * Get all sensitive words
 */
router.get('/sensitive-words', (req, res) => {
  const words = auditService.getSensitiveWords();
  res.json({ words });
});

/**
 * POST /api/dashboard/departments
 * Set user department
 */
router.post('/departments', (req, res) => {
  const { userId, department } = req.body;

  if (!userId || !department) {
    return res.status(400).json({ error: 'Missing userId or department' });
  }

  const { database } = require('../services/database');
  database.setDepartment(userId, department);

  res.json({ success: true });
});

export default router;
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/routes/dashboard.ts
git commit -m "feat: add dashboard API routes"
```

---

## Task 10: Inject Proxy Env Vars

**Files:**
- Modify: `src/services/docker-orchestrator.ts`

**Step 1: Add proxy base URL to container env**

Add to Env array (around line 136, after `OPENCLAW_ENV_LLM_PROVIDER`):

```typescript
          `OPENCLAW_ENV_LLM_PROVIDER=${process.env.LLM_PROVIDER || 'zai'}`,
          // Proxy to relay server for LLM API
          `OPENCLAW_ENV_LLM_BASE_URL=${process.env.LLM_BASE_URL || 'http://host.docker.internal:5178/api/llm-proxy'}`,
          // User ID for audit
          `OPENCLAW_ENV_USER_ID=${userId}`,
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/services/docker-orchestrator.ts
git commit -m "feat: inject LLM proxy base URL into container env"
```

---

## Task 11: Register Routes in Server

**Files:**
- Modify: `src/server.ts`

**Step 1: Import and register new routes**

Add imports after existing route imports (around line 11):

```typescript
import llmProxyRoutes from './routes/llm-proxy';
import dashboardRoutes from './routes/dashboard';
```

Add route registration after existing routes (around line 71):

```typescript
app.use('/api/orchestrator', orchestratorRoutes);
app.use('/api/llm-proxy', llmProxyRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/', qrcodeRoutes);
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: register LLM proxy and dashboard routes"
```

---

## Task 12: Add Environment Variables

**Files:**
- Modify: `.env.example` (create if not exists)

**Step 1: Add new environment variables**

```bash
# LLM Proxy Settings
ZHIPU_API_KEY_GLM4=your_api_key_here
ZHIPU_API_KEY_GLM5=your_api_key_here
LLM_BASE_URL=http://host.docker.internal:5178/api/llm-proxy

# Dashboard Settings
DASHBOARD_HOURS=24
DASHBOARD_DAYS=7
TOKEN_COST_RATE=0.0001
```

**Step 2: Commit**

```bash
git add .env.example
git commit -m "feat: add LLM proxy and dashboard environment variables"
```

---

## Task 13: Final Build and Test

**Step 1: Build project**

Run: `npm run build`
Expected: PASS with no TypeScript errors

**Step 2: Commit final version**

```bash
git add -A
git commit -m "feat: complete audit dashboard system implementation"
```

**Step 3: Test manual scenarios**

1. Start server: `npm run dev`
2. Test LLM proxy: `curl -X POST http://localhost:5178/api/llm-proxy/v1/chat/completions -H "x-user-id: test-user" -d '{"model":"glm-4","messages":[{"role":"user","content":"hello"}]}'`
3. Test dashboard: `curl http://localhost:5178/api/dashboard/metrics`
4. Test sensitive word: Add word via API, then try request containing it
5. Check database: `sqlite3 database/openclaw_relay.db "SELECT * FROM audit_logs LIMIT 10;"`

---

## Summary

This plan implements a comprehensive audit dashboard with:

- **Database Layer**: audit_logs, token_usage, sensitive_words, knowledge_base, departments
- **Audit Service**: Logging, sensitive word interception
- **Keyword Extractor**: TF-IDF with Chinese stop words
- **LLM Proxy**: Forwarding to Zhipu with async billing
- **Stats Aggregator**: Four modules (assets, collaboration, cost, risk)
- **Dashboard API**: REST endpoints for all metrics
- **Container Integration**: Proxy base URL injection

Total files: 7 new, 3 modified
Estimated lines of code: ~1500 lines across all files
