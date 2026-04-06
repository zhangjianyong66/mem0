# OpenClaw 记忆系统组织架构设计

## 1. 当前状态

### 现有代理
| 代理ID | 名称 | 角色 | 当前访问权限 |
|-------|------|------|-------------|
| main | 土豆 | 组织者/协调者 | tech, product, general |
| coder | 猴子 | 开发 | tech, general |

### 当前记忆结构
```
orgId: zhangjiangyong-org
  ├── appId: tech      → 技术架构、代码规范
  ├── appId: product   → 需求决策、产品规范
  ├── appId: operation → 运营活动、数据（预留）
  └── general          → 团队通用规范
```

## 2. 未来代理扩展规划

### 阶段一：基础团队（近期）
| 代理ID | 名称 | 角色 | 记忆访问权限 | 说明 |
|-------|------|------|-------------|------|
| main | 土豆 | 协调者 | all | 核心协调，全权限 |
| coder | 猴子 | 开发 | tech, general | 专注技术实现 |
| product | 待定 | 产品经理 | product, general | 需求管理 |
| designer | 待定 | 设计师 | design, product, general | 视觉/交互设计 |

### 阶段二：完整团队（中期）
| 代理ID | 名称 | 角色 | 记忆访问权限 | 说明 |
|-------|------|------|-------------|------|
| qa | 待定 | 测试 | tech, qa, general | 质量保障 |
| devops | 待定 | 运维 | tech, devops, general | 部署运维 |
| frontend | 待定 | 前端 | tech, frontend, general | 前端专项 |
| backend | 待定 | 后端 | tech, backend, general | 后端专项 |

### 阶段三：专业扩展（远期）
| 代理ID | 名称 | 角色 | 记忆访问权限 | 说明 |
|-------|------|------|-------------|------|
| operation | 待定 | 运营 | operation, product, general | 用户运营 |
| data | 待定 | 数据分析师 | data, product, general | 数据分析 |
| finance | 待定 | 金融分析师 | finance, general | 金融分析 |
| marketing | 待定 | 市场 | marketing, operation, general | 市场推广 |

## 3. 扩展后的记忆架构设计

### 3.1 四层记忆体系

```
orgId: zhangjiangyong-org
│
├── 【通用层】general
│   └── 团队规范、会议记录、跨角色协作流程
│
├── 【技术层】tech (appId)
│   ├── 【架构】architecture → 系统架构、技术选型
│   ├── 【后端】backend → API规范、数据库设计
│   ├── 【前端】frontend → UI组件、交互规范
│   ├── 【DevOps】devops → 部署流程、监控告警
│   └── 【测试】qa → 测试规范、验收标准
│
├── 【产品层】product (appId)
│   ├── 【需求】requirement → 功能需求、用户故事
│   ├── 【设计】design → 设计规范、UI/UX标准
│   └── 【规划】roadmap → 迭代计划、优先级
│
├── 【运营层】operation (appId)
│   ├── 【活动】campaign → 运营活动方案
│   ├── 【数据】analytics → 数据分析、指标定义
│   └── 【用户】user-growth → 增长策略、用户反馈
│
├── 【商业层】business (appId)
│   ├── 【金融】finance → 财务分析、投资回报
│   └── 【市场】marketing → 市场分析、竞品信息
│
└── 【私有层】userId
    └── 各代理的个人记忆空间
```

### 3.2 角色-权限矩阵

| 代理 \ 记忆域 | general | tech-arch | tech-backend | tech-frontend | tech-devops | tech-qa | product-req | product-design | operation-campaign | operation-analytics | business-finance |
|-------------|---------|-----------|--------------|---------------|-------------|---------|-------------|----------------|-------------------|---------------------|------------------|
| main(土豆) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| coder(猴子) | ✅ | ✅ | ✅ | 🔶 | 🔶 | 🔶 | 🔶 | ❌ | ❌ | ❌ | ❌ |
| frontend | ✅ | ✅ | ❌ | ✅ | 🔶 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| backend | ✅ | ✅ | ✅ | ❌ | 🔶 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| devops | ✅ | ✅ | 🔶 | 🔶 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| qa | ✅ | 🔶 | 🔶 | 🔶 | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| product | ✅ | 🔶 | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | 🔶 | 🔶 | ❌ |
| designer | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | 🔶 | ✅ | ❌ | ❌ | ❌ |
| operation | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | 🔶 | ❌ | ✅ | ✅ | ❌ |
| data | ✅ | 🔶 | ❌ | ❌ | ❌ | ❌ | 🔶 | ❌ | 🔶 | ✅ | ❌ |
| finance | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 🔶 | ✅ |

图例：
- ✅ 完全访问（自动召回）
- 🔶 只读访问（可见但不自动召回）
- ❌ 不可访问

### 3.3 动态权限设计

```typescript
interface AgentMemoryProfile {
  agentId: string;
  name: string;
  // 主要角色（自动召回这些记忆）
  primaryRoles: string[];
  // 次要角色（只读，不自动召回，可手动搜索）
  secondaryRoles: string[];
  // 通用记忆（总是可见）
  generalAccess: boolean;
}

const AGENT_PROFILES: Record<string, AgentMemoryProfile> = {
  main: {
    agentId: "main",
    name: "土豆",
    primaryRoles: ["tech", "product", "operation", "business"],
    secondaryRoles: [],
    generalAccess: true,
  },
  coder: {
    agentId: "coder",
    name: "猴子",
    primaryRoles: ["tech"],
    secondaryRoles: ["product"], // 可读产品需求
    generalAccess: true,
  },
  frontend: {
    agentId: "frontend",
    name: "前端",
    primaryRoles: ["tech-frontend"],
    secondaryRoles: ["tech-arch", "product-design"],
    generalAccess: true,
  },
  product: {
    agentId: "product",
    name: "产品经理",
    primaryRoles: ["product"],
    secondaryRoles: ["tech-arch", "operation-analytics"],
    generalAccess: true,
  },
};
```

## 4. 内容分类规则

### 4.1 大模型分类 Prompt

```
分析以下对话内容，判断：
1. 是否适合共享（isShared）
2. 所属角色分类（appId）
3. 详细类别（category）

角色分类：
- general: 团队通用信息（会议、规范、流程）
- tech-arch: 系统架构、技术选型
- tech-backend: 后端开发、API、数据库
- tech-frontend: 前端开发、UI组件、样式
- tech-devops: 部署、CI/CD、监控
- tech-qa: 测试、质量保障
- product-req: 需求、用户故事
- product-design: 设计规范、交互
- product-roadmap: 迭代计划、优先级
- operation-campaign: 运营活动
- operation-analytics: 数据分析、指标
- operation-growth: 用户增长
- business-finance: 财务、投资
- business-marketing: 市场、竞品

输出格式：
{
  "isShared": true/false,
  "appId": "tech-arch/product-req/operation-campaign/...",
  "category": "详细分类",
  "reason": "判断原因"
}
```

### 4.2 分类示例

| 对话内容 | 分类结果 | 说明 |
|---------|---------|------|
| "我们使用微服务架构，K8s 部署" | tech-arch | 系统架构 |
| "API 统一返回 {code, data, msg}" | tech-backend | API规范 |
| "按钮颜色使用主色蓝色 #1890ff" | tech-frontend | 前端规范 |
| "这个功能优先级 P0，本周上线" | product-req | 需求优先级 |
| "618 活动目标 GMV 1000万" | operation-campaign | 运营活动 |
| "昨日新增用户 1000，留存 30%" | operation-analytics | 数据分析 |
| "团队周会改到周五下午" | general | 通用信息 |

## 5. 召回策略

### 5.1 分层召回

```
用户提问
    ↓
1. User Scope (个人记忆) - 优先级最高
    ↓
2. Session Scope (当前会话) - 短期上下文
    ↓
3. Organization Scope:
   ├── 3.1 General (通用记忆)
   ├── 3.2 Primary Roles (主要角色记忆) ← 自动召回
   └── 3.3 Secondary Roles (次要角色记忆) ← 不自动召回
```

### 5.2 配置化召回

```json
{
  "agents": {
    "list": [
      {
        "id": "coder",
        "memoryConfig": {
          "autoRecall": {
            "scopes": ["user", "session", "org:tech", "org:general"],
            "excludeScopes": ["org:product", "org:operation"]
          },
          "manualSearch": {
            "allowScopes": ["org:product"] 
          }
        }
      }
    ]
  }
}
```

## 6. 实施路线图

### Phase 1: 基础架构（当前）✅
- [x] 实现 appId 分类保存
- [x] 实现按角色召回过滤
- [x] 土豆/猴子权限配置

### Phase 2: 扩展团队
- [ ] 添加 product 代理配置
- [ ] 添加 designer 代理配置
- [ ] 细化 tech 子分类 (backend/frontend/devops/qa)

### Phase 3: 完整团队
- [ ] 添加 operation 代理配置
- [ ] 添加 data 分析师代理
- [ ] 实现 secondary roles 只读机制

### Phase 4: 专业扩展
- [ ] 添加 finance 金融分析师
- [ ] 添加 marketing 市场代理
- [ ] 实现动态权限配置（从文件读取）

## 7. 技术实现要点

### 7.1 配置结构

```typescript
// config.ts
interface MemoryRoleConfig {
  roleId: string;
  roleName: string;
  parentRole?: string; // 继承权限
  primaryAgents: string[]; // 主要代理
  secondaryAgents: string[]; // 次要代理（只读）
}

interface AgentMemoryConfig {
  agentId: string;
  primaryRoles: string[];
  secondaryRoles: string[];
}
```

### 7.2 动态权限加载

```typescript
// 从 openclaw.json 读取代理记忆配置
function loadAgentMemoryConfig(agentId: string): AgentMemoryConfig {
  const cfg = readOpenClawConfig();
  return cfg.agents.list.find(a => a.id === agentId)?.memoryConfig;
}
```

## 8. 最佳实践建议

### 8.1 内容命名规范

- 技术文档：前缀 `[TECH]` 或 `[ARCH]`
- 产品文档：前缀 `[PRD]` 或 `[REQ]`
- 运营文档：前缀 `[OPS]` 或 `[DATA]`
- 通用文档：前缀 `[TEAM]` 或 `[GENERAL]`

### 8.2 记忆维护

- 定期清理过时记忆（每季度）
- 重要决策标记为 immutable
- 使用 categories 进一步细分

### 8.3 跨角色协作

- 涉及多角色的内容保存到 general
- 使用明确的角色标签
- 定期同步跨角色信息
