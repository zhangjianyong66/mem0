# Mem0 记忆层级架构分析报告

**分析时间**: 2026-04-03
**更新时间**: 2026-04-03 (重构后)
**分析对象**: mem0 OpenClaw 插件源码

---

## 一、Mem0 官方四级记忆架构

根据官方文档 `/docs/core-concepts/memory-types.mdx`，Mem0 定义了以下四级记忆架构：

| 层级 | 英文名称 | 生命周期 | 说明 | 标识字段 |
|------|---------|----------|------|----------|
| **1. 对话记忆** | Conversation memory | 单次响应 | 单轮对话中的即时消息，轮次结束后丢失 | `conversationId` |
| **2. 会话记忆** | Session memory | 分钟到小时 | 短期事实，适用于当前任务或频道 | `sessionId` |
| **3. 用户记忆** | User memory | 周到永久 | 长期知识，绑定到人/账户/工作区 | `userId` |
| **4. 组织记忆** | Organizational memory | 全局配置 | 多代理或团队共享的上下文 | `orgId` / `appId` |

### 层级关系

```
Conversation turn → Session memory → User memory → Org memory
                                          ↓
                                    Mem0 retrieval layer
```

---

## 二、OpenClaw 插件实现（重构版）

### 已实现功能

#### 1. 记忆层级支持

| 层级 | 支持状态 | 实现方式 |
|------|---------|----------|
| Conversation | ✅ 已实现 | `ConversationMemoryManager` 内存缓存 |
| Session | ✅ 已实现 | `sessionId` 参数 |
| User | ✅ 已实现 | `userId` 参数 |
| Organization | ✅ 已实现 | `orgId` / `appId` 参数 |

#### 2. 统一的 Scope 类型

```typescript
export type MemoryScope =
  | "conversation"    // Single turn, in-memory only
  | "session"         // Minutes to hours, sessionId
  | "user"            // Weeks to permanent, userId
  | "organization"    // Global shared, orgId/appId
  | "all";

export interface ScopeFilter {
  type: MemoryScope;
  userId?: string;
  sessionId?: string;
  conversationId?: string;
  orgId?: string;
  appId?: string;
}
```

#### 3. 统一的请求类型

```typescript
export interface SearchRequest {
  query: string;
  scope: ScopeFilter;
  options?: SearchOptions;
}

export interface StoreRequest {
  facts: string[];
  scope: ScopeFilter;
  category?: string;
  importance?: number;
  metadata?: Record<string, unknown>;
}

export interface ListRequest {
  scope: ScopeFilter;
  limit?: number;
}
```

#### 4. Provider 接口

```typescript
export interface Mem0Provider {
  add(request: StoreRequest): Promise<StoreResult>;
  search(request: SearchRequest): Promise<SearchResult>;
  get(id: string): Promise<MemoryItem>;
  update(id: string, data: { text: string; metadata?: Record<string, unknown> }): Promise<void>;
  delete(id: string): Promise<void>;
  list(request: ListRequest): Promise<MemoryItem[]>;
  deleteAll(scope: ScopeFilter): Promise<void>;
  history(id: string): Promise<HistoryEntry[]>;
}
```

#### 5. 审计日志

`AuditLogger` 类记录所有 CRUD 操作：
- 存储在与 history 相同的 SQLite 数据库
- 通过 `features.auditLog: true` 启用
- 记录操作类型、用户、范围、耗时等

#### 6. 工具列表（8 个工具）

| 工具名 | 功能 | scope 参数 |
|--------|------|------------|
| `memory_search` | 搜索记忆 | `conversation`/`session`/`user`/`organization`/`all` |
| `memory_store` | 存储记忆 | 默认 `user` |
| `memory_list` | 列出记忆 | 支持 scope 过滤 |
| `memory_get` | 获取单条 | 无 scope |
| `memory_forget` | 删除记忆 | 支持 scope 过滤 |
| `memory_update` | 更新记忆 | 无 scope |
| `memory_history` | 查看历史 | 无 scope |
| `memory_delete_all` | 批量删除 | 需要 scope |

---

## 三、实体维度（数据隔离）

实体维度与层级不同，用于隔离不同主体的数据：

| 维度 | 字段 | 用途 | 示例 |
|------|------|------|------|
| User | `userId` | 用户/账户隔离 | `"alice"` |
| Agent | 内部处理 | 代理人格/工具隔离 | `"researcher"` |
| App | `appId` | 应用/产品隔离 | `"ios_retail"` |
| Session | `sessionId` | 会话线程隔离 | `"ticket-9241"` |

---

## 四、配置结构

```typescript
{
  mode: "platform" | "open-source",
  apiKey?: string,           // Platform mode
  projectId?: string,        // Platform mode
  defaultScope: {
    userId: string,          // Required
    orgId?: string,
    appId?: string
  },
  features: {
    autoRecall: boolean,     // Default: true
    autoCapture: boolean,    // Default: true
    auditLog: boolean,       // Default: false
    graph: boolean           // Default: false
  },
  oss?: {
    embedder?: { provider: string; config: Record<string, unknown> };
    vectorStore?: { provider: string; config: Record<string, unknown> };
    llm?: { provider: string; config: Record<string, unknown> };
    historyDbPath?: string;
    disableHistory?: boolean;
  },
  topK?: number,             // Default: 5
  searchThreshold?: number   // Default: 0.5
}
```

---

## 五、关键文件

| 文件 | 内容 |
|------|------|
| `types.ts` | 所有类型定义：MemoryScope, ScopeFilter, Request/Response 类型 |
| `config.ts` | 配置解析、默认值、schema 验证 |
| `providers.ts` | PlatformProvider, OSSProvider, AuditLogger, ConversationMemoryManager |
| `index.ts` | 工具定义、生命周期钩子、CLI 命令 |

---

## 六、实现总结

| 功能 | 状态 | 说明 |
|------|------|------|
| Conversation 层级 | ✅ 完成 | `ConversationMemoryManager` 内存缓存，TTL 过期 |
| Organization 层级 | ✅ 完成 | `orgId`/`appId` 参数支持 |
| Scope 命名规范化 | ✅ 完成 | 统一使用 `user` 而非 `long-term` |
| SQLite 审计日志 | ✅ 完成 | `AuditLogger` 类，同一数据库文件 |
| Provider 接口统一 | ✅ 完成 | 使用 Request/Response 类型 |
| 配置结构优化 | ✅ 完成 | 嵌套 `defaultScope` 和 `features` |
| 测试更新 | ✅ 完成 | 99 个测试全部通过 |