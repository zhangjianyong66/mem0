# 角色过滤共享记忆

## 问题背景

不同角色需要不同的共享记忆：
- **技术架构细节** → 开发/测试/运维需要，产品/运营不需要
- **产品需求决策** → 产品/开发需要，运营不一定需要  
- **运营数据** → 运营/产品需要，开发不需要

## 解决方案

使用 Mem0 的 `appId` 维度进行角色隔离：

```
orgId: "zhangjiangyong-org"
  ├── appId: "tech"      → 技术团队专属
  ├── appId: "product"   → 产品团队专属
  ├── appId: "operation" → 运营团队专属
  └── (no appId)         → 通用信息（所有角色）
```

## 角色分类规则

### 大模型自动判断

系统使用大模型分析内容，自动判断所属角色：

| 内容类型 | 角色 (appId) | 示例 |
|---------|-------------|------|
| 项目架构、技术栈 | `tech` | "系统采用微服务架构，K8s 部署" |
| 代码规范、API 设计 | `tech` | "代码必须使用 ESLint，2 空格缩进" |
| 环境配置、部署流程 | `tech` | "生产数据库 PostgreSQL 15" |
| 故障处理、监控告警 | `tech` | "数据库连接超时检查连接池" |
| 产品需求、迭代计划 | `product` | "这个功能优先级 P0，本周上线" |
| 用户场景、设计规范 | `product` | "用户反馈需要导出功能" |
| 运营活动、数据分析 | `operation` | "618 活动目标 GMV 1000 万" |
| 用户增长、营销策略 | `operation` | "昨日新增用户 1000，留存 30%" |
| 团队规范、通用流程 | `general` | "周会时间每周五下午 3 点" |

## 代理访问权限

### 当前配置

| 代理 | 可访问角色 | 说明 |
|-----|-----------|------|
| `main` (土豆) | `tech`, `product`, `general` | 主代理，技术+产品 |
| `coder` (猴子) | `tech`, `general` | 开发代理，专注技术 |
| `product` | `product`, `general` | 产品代理 |
| `operation` | `operation`, `general` | 运营代理 |

### 代码实现

```typescript
function getAgentAllowedAppIds(sessionKey: string): string[] {
  const agentId = extractAgentId(sessionKey);
  
  switch (agentId) {
    case "main":
      return ["tech", "product", "general"];
    case "coder":
      return ["tech", "general"];
    case "product":
      return ["product", "general"];
    case "operation":
      return ["operation", "general"];
    default:
      return ["tech", "product", "operation", "general"];
  }
}
```

## 工作流程

### 保存流程

```
对话内容
    ↓
大模型分析
    ↓
判断角色 (tech/product/operation/general)
    ↓
保存到对应 appId scope
```

**日志输出：**
```
openclaw-mem0: captured 2 shared messages to org:tech [架构, 规范]
openclaw-mem0: captured 1 shared messages to org:product [产品需求]
```

### 召回流程

```
用户提问
    ↓
解析代理身份 (main/coder/product/operation)
    ↓
获取允许的 appIds
    ↓
搜索：
  ├── User Scope (个人记忆)
  ├── Session Scope (会话记忆)
  └── Organization Scope:
       ├── General (无 appId)
       └── Role-specific (过滤 appId)
    ↓
合并结果，注入上下文
```

**日志输出：**
```
openclaw-mem0: injecting 5 memories (2 user, 1 session, 2 shared)
```

## 使用示例

### 场景 1：技术讨论

**对话：**
```
开发：我们使用 Docker Compose 本地启动服务
开发：配置已经更新到 docker-compose.yml
```

**自动分类：**
- 角色：`tech`
- 保存到：`org:zhangjiangyong-org:app:tech`

**召回：**
- 土豆 (main) ✅ 可见
- 猴子 (coder) ✅ 可见
- 产品代理 ❌ 不可见

### 场景 2：产品需求

**对话：**
```
产品：用户管理功能优先级 P0，本周五上线
开发：收到，我们评估一下工作量
```

**自动分类：**
- 角色：`product`
- 保存到：`org:zhangjiangyong-org:app:product`

**召回：**
- 土豆 (main) ✅ 可见
- 猴子 (coder) ❌ 不可见
- 产品代理 ✅ 可见

### 场景 3：通用规范

**对话：**
```
产品：团队周会改到每周五下午 3 点
所有人：收到
```

**自动分类：**
- 角色：`general`
- 保存到：`org:zhangjiangyong-org` (无 appId)

**召回：**
- 所有代理 ✅ 可见

## 手动操作

### 搜索指定角色的记忆

```typescript
// 搜索技术相关的共享记忆
memory_search({ 
  query: "数据库配置", 
  scope: "organization",
  orgId: "zhangjiangyong-org",
  appId: "tech"
})

// 搜索产品相关的共享记忆
memory_search({ 
  query: "需求优先级", 
  scope: "organization",
  orgId: "zhangjiangyong-org",
  appId: "product"
})

// 搜索所有共享记忆（所有角色）
memory_search({ 
  query: "关键词", 
  scope: "organization",
  orgId: "zhangjiangyong-org"
})
```

### CLI 命令

```bash
# 搜索技术共享记忆
openclaw mem0 search "数据库" --scope organization --org-id zhangjiangyong-org --app-id tech

# 搜索产品共享记忆
openclaw mem0 search "需求" --scope organization --org-id zhangjiangyong-org --app-id product
```

## 最佳实践

### 1. 明确表达内容属性

- 好："技术团队规范：代码必须使用 ESLint"
- 差："应该用 ESLint 检查一下"

### 2. 跨角色协作时明确指定

如果内容涉及多个角色，可以分条表达：
- "技术方案：使用 Redis 缓存（tech）"
- "产品需求：缓存过期时间 1 小时（product）"

### 3. 定期整理共享记忆

```typescript
// 查看技术共享记忆
memory_list({ scope: "organization", orgId: "zhangjiangyong-org", appId: "tech" })

// 删除过时的技术配置
memory_delete_all({ scope: "organization", orgId: "zhangjiangyong-org", appId: "tech" })
```

## 注意事项

1. **大模型判断有误差**：复杂内容可能被误判角色
2. **通用内容不指定 appId**：所有代理都能看到
3. **自动召回按角色过滤**：代理只能看到自己角色的共享记忆
4. **手动搜索可以跨角色**：明确指定 appId 可以搜索其他角色记忆

## 扩展方向

### 支持更多角色

在 `getAgentAllowedAppIds` 中添加新角色：

```typescript
case "frontend":
  return ["tech", "general"];
case "backend":
  return ["tech", "general"];
case "qa":
  return ["tech", "general"];
```

### 支持角色组合

允许代理配置多个角色：

```typescript
case "tech-lead":
  return ["tech", "product", "general"];
```

### 动态角色权限

从配置文件读取角色权限，不需要硬编码：

```json
{
  "agentRoles": {
    "main": ["tech", "product", "general"],
    "coder": ["tech", "general"]
  }
}
```
