# mem0 本地部署指南

本文档记录 mem0 项目的本地部署方案，方便下次部署或他人参考。

## 当前部署状态

| 服务 | 地址 | 状态 | 用途 |
|------|------|------|------|
| OpenMemory API | http://localhost:8765 | 运行中 | MCP Server |
| Qdrant 向量库 | localhost:6333 | 运行中 | 向量存储 |

**部署时间**: 2026-04-05  
**部署版本**: mem0 v1.1  
**部署方式**: OpenMemory 本地部署 + Qdrant 向量存储

## 部署架构

```
┌─────────────────────────────────────────────────────────┐
│                    Kimi Code CLI                        │
│  ┌─────────────────┐                                    │
│  │  Smart Memory   │◄── 提示词注入（实时保存/检索）      │
│  │     Skill       │                                    │
│  └────────┬────────┘                                    │
│           │ 调用 MCP 工具                                │
│           ↓                                             │
│  ┌──────────────────────────────────┐                   │
│  │  mem0 MCP Server                 │                   │
│  │  http://localhost:8765           │                   │
│  │  ┌────────────┐  ┌────────────┐  │                   │
│  │  │  Memory    │  │   Search   │  │                   │
│  │  │  Storage   │  │   Memory   │  │                   │
│  │  └─────┬──────┘  └────────────┘  │                   │
│  └────────┼──────────────────────────┘                   │
│           │                                             │
│           ↓ 向量检索                                    │
│  ┌─────────────────┐                                    │
│  │  Qdrant         │  向量数据库（端口 6333）            │
│  │  localhost:6333 │                                    │
│  └─────────────────┘                                    │
└─────────────────────────────────────────────────────────┘
```

## 项目结构

```
~/project/mem0/                    # 本目录
├── local-deployment/              # 📁 本地部署文档（本目录）
│   ├── README.md                  # 部署指南
│   ├── deploy.sh                  # 一键部署脚本
│   └── kimi-integration.md        # Kimi 集成配置
├── openmemory/                    # OpenMemory 本地部署版本
│   ├── api/                       # API/MCP 服务
│   │   ├── .venv/                 # Python 虚拟环境
│   │   ├── main.py                # FastAPI 入口
│   │   └── .env                   # 环境变量配置
│   ├── compose/                   # 各种向量数据库的 Docker Compose
│   │   ├── qdrant.yml
│   │   ├── pgvector.yml
│   │   └── ...
│   └── README.md                  # OpenMemory 官方文档
├── server/                        # mem0 REST API Server
│   ├── docker-compose.yaml        # Docker Compose 配置
│   ├── Dockerfile
│   └── main.py                    # FastAPI 入口
├── docs/                          # 官方文档
├── mem0/                          # Python SDK 源码
└── ...

~/.openclaw/mem0/                  # 本地数据目录
├── history.db                     # SQLite 历史数据
└── openmemory.db                  # OpenMemory 主数据库

~/.mem0/                           # mem0 工具数据目录
├── bin/qdrant-macos              # Qdrant 向量数据库
├── qdrant_simple_config.yaml     # Qdrant 配置
└── storage/                       # Qdrant 数据存储
```

## 快速启动

### 方式 1: 使用部署脚本（推荐）

```bash
cd ~/project/mem0/local-deployment
./deploy.sh start    # 启动所有服务
./deploy.sh status   # 查看状态
./deploy.sh backup   # 备份数据
```

### 方式 2: 手动启动

**1. 启动 Qdrant 向量数据库**
```bash
~/.mem0/bin/qdrant-macos --config-path ~/.mem0/qdrant_simple_config.yaml
```

**2. 启动 OpenMemory API**
```bash
cd ~/project/mem0/openmemory/api
source .venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8765 --workers 1
```

## 详细部署步骤

### 前置要求

- Python 3.10+
- OpenAI API Key (或其他 LLM Provider)
- macOS (Qdrant 二进制文件为 macOS 版本)

### 第一步：配置环境变量

编辑 `~/project/mem0/openmemory/api/.env`:

```bash
# 向量数据库配置
VECTOR_STORE_PROVIDER=qdrant
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=memories

# LLM 配置
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-your-key-here
OPENAI_MODEL=gpt-4o-mini

# 嵌入模型配置
EMBEDDING_PROVIDER=openai
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

### 第二步：启动 Qdrant

```bash
# 创建数据目录
mkdir -p ~/.mem0/storage

# 启动 Qdrant
nohup ~/.mem0/bin/qdrant-macos \
  --config-path ~/.mem0/qdrant_simple_config.yaml \
  > ~/.mem0/qdrant.log 2>&1 &

# 验证
curl http://localhost:6333/healthz
```

### 第三步：启动 OpenMemory API

```bash
cd ~/project/mem0/openmemory/api

# 安装依赖（如果未安装）
pip install -r requirements.txt

# 或使用虚拟环境
source .venv/bin/activate

# 启动 API
uvicorn main:app --host 0.0.0.0 --port 8765 --workers 1
```

### 第四步：配置 Kimi MCP

编辑 `~/.kimi/mcp.json`:

```json
{
  "mcpServers": {
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

## 验证部署

```bash
# 1. 检查 Qdrant
curl http://localhost:6333/healthz
# 期望输出: {"status":"ok"}

# 2. 检查 API
curl http://localhost:8765/health
# 期望输出: {"status":"ok"}

# 3. 检查 MCP 端点
curl -X POST http://localhost:8765/mcp/kimi/http/zhangjianyong \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
# 期望返回工具列表
```

## 数据备份与恢复

### 备份

```bash
# 使用部署脚本
./deploy.sh backup

# 或手动备份
BACKUP_DIR="~/backup/mem0-$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"
cp ~/.openclaw/mem0/openmemory.db "$BACKUP_DIR/"
tar czf "$BACKUP_DIR/qdrant-storage.tar.gz" -C ~/.mem0 storage/
```

### 恢复

```bash
# 停止服务
./deploy.sh stop

# 恢复数据
cp ~/backup/mem0-20260101/openmemory.db ~/.openclaw/mem0/
tar xzf ~/backup/mem0-20260101/qdrant-storage.tar.gz -C ~/

# 启动服务
./deploy.sh start
```

## 故障排查

### 端口占用

```bash
# 检查端口
lsof -i :8765  # API 端口
lsof -i :6333  # Qdrant 端口

# 释放端口
kill -9 <PID>
```

### 依赖问题

```bash
cd ~/project/mem0/openmemory/api
pip install -r requirements.txt
```

### 数据损坏

```bash
# 重置 Qdrant 数据（会丢失所有向量）
rm -rf ~/.mem0/storage/*

# 重置 OpenMemory 数据库（会丢失所有记忆）
rm ~/.openclaw/mem0/openmemory.db
```

## 相关文档

- [OpenMemory README](../openmemory/README.md) - OpenMemory 官方文档
- [Kimi 集成配置](./kimi-integration.md) - Kimi + mem0 集成指南
- [部署脚本](./deploy.sh) - 一键部署脚本
- [mem0 官方文档](../docs/) - 完整文档

## 更新记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-04-05 | v1.1 | 初始部署，OpenMemory + Qdrant |

---

## 数据存储位置（推荐统一结构）

### 当前数据分布

| 数据类型 | 当前位置 | 建议迁移到 |
|---------|---------|-----------|
| OpenMemory 主数据库 | `~/.openclaw/mem0/openmemory.db` | `~/.mem0/data/openmemory.db` |
| OpenMemory 历史记录 | `~/.openclaw/mem0/history.db` | `~/.mem0/data/history.db` |
| mem0 CLI 数据库 | `~/.mem0/data/memories.db` | `~/.mem0/data/memories.db` (不变) |
| Qdrant 向量数据 | `~/.mem0/qdrant_data/` | `~/.mem0/qdrant_data/` (不变) |

### 推荐的统一目录结构

```
~/.mem0/                           # 统一根目录
├── data/                          # 所有数据库文件
│   ├── openmemory.db             # OpenMemory 主数据库 ⭐
│   ├── history.db                # OpenMemory 历史记录 ⭐
│   └── memories.db               # mem0 CLI 数据库
├── qdrant_data/                   # 向量数据
│   ├── collections/
│   └── aliases/
├── backup/                        # 备份目录
│   └── vectors_*.json
└── config/                        # 配置文件
    ├── qdrant_simple_config.yaml
    └── openmemory.env
```

> ⭐ 表示建议从 `~/.openclaw/mem0/` 迁移过来的文件

### 迁移好处

1. **统一管理** - 所有 mem0 相关数据在一个目录
2. **便于备份** - 只需备份 `~/.mem0/` 目录
3. **清晰结构** - 数据、向量、配置、备份分离
4. **避免混淆** - 不再与 openclaw 数据混合

### 执行迁移

```bash
# 使用迁移脚本（推荐）
cd ~/project/mem0/local-deployment
./migrate-to-mem0.sh

# 或手动迁移
cp ~/.openclaw/mem0/*.db ~/.mem0/data/
# 然后更新 ~/.env 中的 DATABASE_URL
```

### 迁移后更新配置

编辑 `~/project/mem0/openmemory/api/.env`:

```bash
# 修改前
DATABASE_URL=sqlite:////Users/zhangjianyong/.openclaw/mem0/openmemory.db

# 修改后
DATABASE_URL=sqlite:////Users/zhangjianyong/.mem0/data/openmemory.db
```

### 回滚方案

如果迁移后出现问题：

```bash
# 1. 停止服务
pkill -f "uvicorn main:app"

# 2. 恢复数据
BACKUP_DIR="~/.mem0/backup/migration-YYYYMMDD_HHMMSS"
cp $BACKUP_DIR/* ~/.openclaw/mem0/

# 3. 恢复配置
sed -i 's|/.mem0/data/|/.openclaw/mem0/|' ~/project/mem0/openmemory/api/.env

# 4. 启动服务
./deploy.sh start
```

---

## ✅ 数据已迁移完成

**迁移时间**: 2026-04-05  
**迁移状态**: ✅ 完成

### 迁移后数据位置

```
~/.mem0/                           # 统一根目录 ✅
├── data/                          # 所有数据库
│   ├── openmemory.db (292K)      # 主数据库
│   ├── history.db (12K)          # 历史记录
│   └── memories.db (140K)        # CLI 数据库
├── qdrant_data/ (78M)            # 向量数据
├── backup/ (51M)                 # 备份
│   └── migration-20260405_*/     # 迁移备份
└── config/                       # 配置文件

~/.openclaw/mem0/                  # 原位置（保留软链接兼容）
├── openmemory.db -> ~/.mem0/data/openmemory.db
├── history.db -> ~/.mem0/data/history.db
└── *.migrated                    # 原数据文件备份
```

### 备份位置

- 自动备份: `~/.mem0/backup/migration-20260405_115720/`
- 原数据: `~/.openclaw/mem0/*.migrated`

### 回滚命令

如需回滚到迁移前状态：

```bash
# 1. 停止服务
pkill -f "uvicorn main:app --host 0.0.0.0 --port 8765"

# 2. 恢复数据
BACKUP="~/.mem0/backup/migration-20260405_115720"
cp $BACKUP/* ~/.openclaw/mem0/

# 3. 更新配置
sed -i 's|/.mem0/data/|/.openclaw/mem0/|' ~/project/mem0/openmemory/api/.env

# 4. 启动服务
~/project/mem0/local-deployment/deploy.sh start
```
