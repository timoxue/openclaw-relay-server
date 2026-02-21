# Audit Dashboard System Design

## Overview

Implement a comprehensive audit and monitoring system for OpenClaw relay server, featuring:
- LLM usage monitoring with async billing
- Asset沉淀 (knowledge extraction, keyword cloud)
- Collaboration efficiency (proxy requests, cross-department index)
- Cost audit (token consumption by department)
- Risk governance (sensitive word interception)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Dashboard Layer                              │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │              StatsAggregator                          │ │
│  │  - Keyword Cloud      - Cross-Dept Index            │ │
│  │  - Knowledge Mining   - Approval Response Time       │ │
│  │  - Token Consumption - Sensitive Interception        │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Audit Services                               │
│  ┌──────────────┐ ┌──────────────────┐ ┌─────────────┐   │
│  │AuditService  │ │ KeywordExtractor│ │LLMProxy     │   │
│  │- Audit logs  │ │- TF-IDF/StopWord│ │- API proxy  │   │
│  │- Sensitive   │ │                  │ │- Async billing│   │
│  └──────────────┴──────────────────┴─────────────┘      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              Infrastructure (Reused)                            │
│  • database - audit_logs, token_usage, sensitive_words, etc.    │
│  • feishuAPI - Send dashboard cards                            │
│  • docker-orchestrator - Inject proxy env vars                   │
└─────────────────────────────────────────────────────────────────┘
```

## Database Schema

### audit_logs

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_data TEXT,
  timestamp INTEGER NOT NULL,
  metadata TEXT
);
```

### token_usage

```sql
CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  request_id TEXT
);
```

### sensitive_words

```sql
CREATE TABLE IF NOT EXISTS sensitive_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT UNIQUE NOT NULL,
  category TEXT,
  severity INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);
```

### knowledge_base

```sql
CREATE TABLE IF NOT EXISTS knowledge_base (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,
  source_url TEXT,
  title TEXT,
  content TEXT NOT NULL,
  extracted_at INTEGER DEFAULT (strftime('%s', 'now')),
  user_id TEXT
);
```

### departments

```sql
CREATE TABLE IF NOT EXISTS departments (
  user_id TEXT PRIMARY KEY,
  department TEXT NOT NULL
);
```

## Core Services

### 1. LLM Proxy Service

**Endpoint:** `/v1/chat/completions`

**Flow:**
1. Validate user identity
2. Record audit log
3. Check sensitive word interception
4. Forward to Zhipu API
5. Async parse `usage` field and store in `token_usage`

**Env Injection:** Modify `docker-orchestrator.ts` to inject:
```env
OPENCLAW_ENV_LLM_BASE_URL=http://relay-server/api/llm-proxy
```

### 2. Keyword Extractor

**Algorithm:** TF-IDF with Chinese stop words

**Features:**
- No external NLP service required
- Configurable stop word list
- Top-N keywords extraction

### 3. Stats Aggregator

**Four Modules:**

| Module | Metrics | Data Source |
|---------|----------|-------------|
| Assets | Keyword Cloud, Knowledge Mining Count | audit_logs, knowledge_base |
| Collaboration | Cross-Dept Index, Approval Response Time | proxy_requests |
| Cost | Token Consumption by Dept | token_usage, departments |
| Risk | Sensitive Interception, Sandbox Health | audit_logs |

### 4. Dashboard Feishu Cards

```typescript
interface DashboardCard {
  module: 'assets' | 'collaboration' | 'cost' | 'risk';
  title: string;
  data: any;
  timestamp: Date;
}
```

## File Structure

```
src/
├── services/
│   ├── llm-proxy.ts           # LLM forwarding + async billing
│   ├── keyword-extractor.ts    # Keyword extraction service
│   ├── audit-service.ts       # Audit logs + sensitive words
│   └── stats-aggregator.ts    # Dashboard metrics
├── routes/
│   ├── llm-proxy.ts          # /v1/chat/completions endpoint
│   └── dashboard.ts          # Dashboard data endpoints
├── types/
│   ├── audit.ts              # Audit types
│   └── stats.ts             # Statistics types
└── utils/
    ├── sensitive-words.ts     # Configurable sensitive word library
    └── stop-words.ts        # Chinese stop word list
```

## Integration Points

1. **docker-orchestrator.ts**: Inject `OPENCLAW_ENV_LLM_BASE_URL` env var
2. **orchestrator.ts**: Add audit log for all message entries
3. **server.ts**: Register `/v1/chat/completions` and dashboard routes
4. **database.ts**: Add new tables and operations

## Security

- Configurable sensitive word library (database table)
- Audit log for all actions
- User identity validation before proxy forwarding
- Department mapping via external configuration
