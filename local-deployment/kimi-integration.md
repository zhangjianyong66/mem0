# Kimi + mem0 集成配置

本文档记录 Kimi Code CLI 与本地 mem0 服务的集成配置。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  Kimi Code CLI                                              │
│  ┌──────────────────┐      ┌──────────────────┐            │
│  │ Smart Memory     │      │ 其他 MCP Servers │            │
│  │ Skill            │      │ (openspace,      │            │
│  │ (提示词注入)      │      │  WebSearch)      │            │
│  └────────┬─────────┘      └──────────────────┘            │
│           │                                                 │
│           │ 调用 mem0 MCP 工具                              │
│           ↓                                                 │
│  ┌──────────────────────────────────────────┐              │
│  │ mem0 MCP Server                          │              │
│  │ http://localhost:8765                    │              │
│  │ 工具: add_memory, search_memory, ...     │              │
│  └──────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────┘
```

## Kimi 配置文件

### MCP 配置

**文件位置**: `~/.kimi/mcp.json`

```json
{
  "mcpServers": {
    "openspace": {
      "command": "/Users/zhangjianyong/project/OpenSpace/venv/bin/openspace-mcp",
      "env": {
        "OPENSPACE_HOST_SKILL_DIRS": "/Users/zhangjianyong/.openclaw/openspace-skills",
        "OPENSPACE_WORKSPACE": "/Users/zhangjianyong/project/OpenSpace",
        "LLM_MODEL": "openai/kimi-k2.5"
      },
      "timeout": 3600
    },
    "WebSearch": {
      "url": "https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp",
      "transport": "http",
      "headers": {
        "Authorization": "Bearer sk-your-key"
      }
    },
    "mem0": {
      "url": "http://localhost:8765/mcp/kimi/http/zhangjianyong",
      "transport": "http",
      "headers": {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "MCP-Protocol-Version": "2024-11-05"
      }
    }
  }
}
```

### Hooks 配置

**文件位置**: `~/.kimi/config.toml`

```toml
# Smart Memory Hooks
# Skill 实时保存: 偏好、决策、项目信息
# Hooks 总结保存: 经验教训、会话摘要（避免重复）
[[hooks]]
event = "Stop"
command = "bash -c 'LATEST=$(ls -t ~/.kimi/sessions/*/*.json 2>/dev/null | head -1); [ -n \"\$LATEST\" ] && python3 ~/.kimi/skills/smart-memory/scripts/smart_session_saver.py \"\$LATEST\" --mode learnings-only'"
timeout = 60
```

## Smart Memory Skill

**文件位置**: `~/.kimi/skills/smart-memory/SKILL.md`

Skill 通过提示词注入实现：
- **检索**: 每次回答前自动调用 `search_memory`
- **保存**: 回答后识别有价值内容并调用 `add_memories`

## 职责分离

| 记忆类型 | 负责方案 | 说明 |
|---------|---------|------|
| user_preference | Skill (实时) | 用户偏好、习惯 |
| decision | Skill (实时) | 技术决策、选择 |
| project | Skill (实时) | 项目信息 |
| task_learning | Hooks (总结) | 经验教训 |
| anti_pattern | Hooks (总结) | 失败教训 |
| session_summary | Hooks (总结) | 会话摘要 |

## 测试验证

### 测试 1: 实时保存

```
用户: 记住我喜欢用 PostgreSQL

期望:
1. Kimi 识别关键词 "记住"
2. 调用 add_memories 保存
3. 确认已保存
```

### 测试 2: 自动检索

```
用户: 我喜欢用什么数据库？

期望:
1. Kimi 调用 search_memory("喜欢 数据库")
2. 返回 PostgreSQL 相关记忆
3. 基于记忆回答
```

### 测试 3: Hooks 总结

```
进行多次对话后退出 Kimi...

期望:
1. Stop hook 触发
2. 分析整个会话
3. 提取 task_learning 或 anti_pattern
4. 保存到 mem0
```

## 故障排查

### MCP 连接失败

```bash
# 检查 mem0 服务
curl http://localhost:8765/health

# 检查 MCP 端点
curl -X POST http://localhost:8765/mcp/kimi/http/zhangjianyong \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

### Skill 未触发

在 Kimi 对话中询问：
```
你是否加载了 smart-memory skill？
```

### 重复保存

检查职责分离配置：
- Skill 只保存实时内容
- Hooks 使用 `--mode learnings-only`

## 相关文件

| 文件 | 用途 |
|------|------|
| `~/.kimi/mcp.json` | MCP 服务器配置 |
| `~/.kimi/config.toml` | Hooks 配置 |
| `~/.kimi/skills/smart-memory/SKILL.md` | Skill 提示词 |
| `~/.kimi/skills/smart-memory/scripts/smart_session_saver.py` | Hooks 脚本 |

## 更新记录

| 日期 | 说明 |
|------|------|
| 2026-04-05 | 初始配置，Skill + Hooks 职责分离 |
