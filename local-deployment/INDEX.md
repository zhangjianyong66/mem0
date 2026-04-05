# 本地部署文档索引

本文档目录包含 mem0 本地部署的完整文档和工具。

## 文件说明

| 文件 | 说明 |
|------|------|
| [README.md](./README.md) | 完整部署指南（主文档） |
| [kimi-integration.md](./kimi-integration.md) | Kimi Code CLI 集成配置 |
| [deploy.sh](./deploy.sh) | 一键部署脚本 |

## 快速导航

- **首次部署**: 阅读 [README.md](./README.md) 的"详细部署步骤"章节
- **日常使用**: 使用 `./deploy.sh [start|stop|status|backup]`
- **Kimi 集成**: 参考 [kimi-integration.md](./kimi-integration.md)
- **故障排查**: 查看 [README.md](./README.md) 的"故障排查"章节

## 相关目录

```
~/project/mem0/
├── local-deployment/     # 📁 本目录（部署文档）
├── openmemory/           # 📁 OpenMemory 源码
├── server/               # 📁 REST API Server 源码
├── docs/                 # 📁 官方文档
└── mem0/                 # 📁 Python SDK 源码
```
