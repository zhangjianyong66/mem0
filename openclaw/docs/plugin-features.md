# OpenClaw Mem0 插件功能细节文档

## 概述

OpenClaw Mem0 插件为 OpenClaw 代理提供长期记忆能力，支持多代理记忆隔离、智能共享记忆分类、以及四层记忆架构。

## 记忆架构

### 四层记忆层级

| 层级 | 标识符 | 生命周期 | 用途 |
|-----|--------|---------|------|
| **Conversation** | `conversationId` | 单轮对话 | 临时上下文，内存中 |
| **Session** | `sessionId` | 分钟到小时 | 当前会话短期记忆 |
| **User** | `userId` | 永久 | 代理专属长期记忆 |
| **Organization** | `orgId`/`appId` | 全局共享 | 跨代理共享记忆 |

### 多代理记忆隔离

每个代理自动获得独立的记忆命名空间：

```
userId 格式:
- main 代理:  org-user-${USER}
- coder 代理: org-user-${USER}:agent:coder
```

**隔离规则：**
- `agent:main:*` → 基础 userId
- `agent:<name>:*` → `${baseUserId}:agent:${name}`
- `agent:*:subagent:*` → 子代理使用父代理命名空间

## 智能共享记忆

### 自动分类机制

Auto Capture 自动分析对话内容，智能分类保存：

```typescript
个人记忆 → User Scope (隔离)
共享记忆 → Organization Scope (共享)
```

### 共享内容识别规则

自动保存到共享记忆的内容类型：

| 类型 | 匹配模式 | 示例 |
|-----|---------|------|
| 项目信息 | `/^(项目\|系统\|架构\|设计)/` | "项目使用 Go + Vue 技术栈" |
| 配置参数 | `/^(配置\|设置\|参数\|环境)/` | "数据库连接池配置为 100" |
| 最佳实践 | `/^(最佳实践\|规范\|标准\|约定)/` | "代码审查必须包含单元测试" |
| 流程方法 | `/^(流程\|步骤\|方法\|方案)/` | "发布流程：测试 → 预发 → 生产" |
| 技术文档 | `/^(api\|接口\|数据库\|文档)/i` | "API 基础路径 /api/v1" |
| 通用规则 | `/(统一\|一致\|共同\|通用)/` | "团队统一使用 2 空格缩进" |

### 个人内容识别规则

保存到私有记忆的内容特征：

- `/我觉得\|我认为\|我想\|我感觉/` → 个人意见
- `/^(我\|帮我\|给我)/` → 个人请求
- `/请帮我\|帮我\|给我/` → 具体帮助请求

## 功能模块

### 1. Auto Recall (自动召回)

**触发时机:** `before_agent_start`

**召回范围:**
- 仅搜索当前代理的 `user` + `session` 记忆
- **不**包含共享记忆（避免污染上下文）

**召回策略:**
```typescript
1. 语义搜索当前问题相关记忆 (topK * 2)
2. 动态阈值过滤 (score >= max(0.6, threshold))
3. 短提示词(<100字符)额外召回近期偏好
4. 合并去重后返回 topK 条
```

### 2. Auto Capture (自动保存)

**触发时机:** `agent_end`

**保存逻辑:**
```typescript
1. 过滤系统噪音消息
2. 分析每条内容：isSharedContent()
3. 个人内容 → provider.add(scope: user)
4. 共享内容 → provider.add(scope: organization)
5. 记录日志: captured X messages (personal: Y, shared: Z)
```

**跳过条件:**
- 非交互式触发器 (cron, heartbeat, automation)
- 子代理会话
- 无成功消息

### 3. 记忆工具 (Agent Tools)

| 工具 | 功能 | 默认 Scope |
|-----|------|-----------|
| `memory_search` | 搜索记忆 | user |
| `memory_store` | 保存记忆 | user |
| `memory_list` | 列出记忆 | user |
| `memory_get` | 获取单条 | user |
| `memory_update` | 更新记忆 | user |
| `memory_forget` | 删除记忆 | user |
| `memory_delete_all` | 清空记忆 | user |
| `memory_history` | 获取历史 | user |

**Scope 参数选项:**
- `"conversation"` - 临时对话
- `"session"` - 当前会话
- `"user"` - 用户私有记忆 (默认)
- `"organization"` - 组织共享记忆
- `"all"` - 搜索所有层级

### 使用示例

```typescript
// 搜索共享记忆
memory_search({ query: "项目架构", scope: "organization" })

// 保存到共享空间
memory_store({ 
  facts: ["数据库使用 PostgreSQL 15"], 
  scope: "organization" 
})

// 搜索所有记忆（个人+共享）
memory_search({ query: "技术栈", scope: "all" })
```

## 配置参数

### 完整配置示例

```json
{
  "openclaw-mem0": {
    "enabled": true,
    "config": {
      "mode": "open-source",
      "defaultScope": {
        "userId": "org-user-${USER}",
        "orgId": "zhangjiangyong-org"
      },
      "features": {
        "autoRecall": false,
        "autoCapture": true,
        "auditLog": false,
        "graph": false
      },
      "topK": 5,
      "searchThreshold": 0.5,
      "oss": {
        "vectorStore": {
          "provider": "qdrant",
          "config": {
            "url": "http://localhost:6333",
            "collectionName": "memories"
          }
        },
        "embedder": {
          "provider": "openai",
          "config": {
            "model": "text-embedding-v4",
            "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1"
          }
        },
        "llm": {
          "provider": "openai",
          "config": {
            "model": "qwen-max"
          }
        }
      }
    }
  }
}
```

### 参数说明

| 参数 | 类型 | 默认值 | 说明 |
|-----|------|-------|------|
| `mode` | string | `"platform"` | 模式: platform / open-source |
| `defaultScope.userId` | string | 必填 | 用户标识 |
| `defaultScope.orgId` | string | - | 组织标识（启用共享记忆） |
| `defaultScope.appId` | string | - | 应用标识 |
| `features.autoRecall` | boolean | `true` | 自动召回 |
| `features.autoCapture` | boolean | `true` | 自动保存 |
| `features.auditLog` | boolean | `false` | 审计日志 |
| `features.graph` | boolean | `false` | 图记忆 |
| `topK` | number | `5` | 召回数量 |
| `searchThreshold` | number | `0.5` | 相似度阈值 |

## CLI 命令

```bash
# 搜索记忆
openclaw mem0 search "关键词"

# 搜索共享记忆
openclaw mem0 search "关键词" --scope organization

# 搜索所有记忆
openclaw mem0 search "关键词" --scope all

# 查看统计
openclaw mem0 stats

# 搜索特定代理的记忆
openclaw mem0 search "关键词" --agent coder
```

## 日志标识

| 日志信息 | 含义 |
|---------|------|
| `captured X messages (personal: Y, shared: Z)` | 自动保存完成 |
| `captured X shared messages to org` | 共享记忆保存 |
| `skipping capture for non-interactive trigger` | 跳过非交互式会话 |
| `skipping capture for subagent` | 跳过子代理 |
| `injecting X memories (Y user, Z session)` | 自动召回注入 |
| `skipping recall for non-interactive trigger` | 跳过非交互式召回 |

## 技术细节

### 消息过滤管道

1. **噪音检测** - 过滤系统消息、心跳、单字回复
2. **通用助手检测** - 过滤标准客套话
3. **内容剥离** - 移除媒体样板、路由元数据
4. **截断** - 限制 2000 字符

### Session Key 解析

```typescript
// 格式: agent:<agentId>:<session>
"agent:main:main"           → userId: "org-user-${USER}"
"agent:coder:uuid"          → userId: "org-user-${USER}:agent:coder"
"agent:main:subagent:uuid"  → 子代理，使用父代理命名空间
```

### 并发安全

- 使用 `ctx.sessionKey` 直接获取会话标识
- 避免共享可变状态
- 支持多用户同时会话

## 版本历史

- **v2.0.0** - 智能共享记忆分类、多代理隔离优化
