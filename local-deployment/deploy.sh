#!/bin/bash
# mem0 本地一键部署脚本
# 用法: ./deploy.sh [start|stop|status|restart|backup]

set -e

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 配置
MEM0_DIR="$HOME/project/mem0/openmemory"
QDRANT_BIN="$HOME/.mem0/bin/qdrant-macos"
QDRANT_CONFIG="$HOME/.mem0/qdrant_simple_config.yaml"
API_PORT=8765
QDRANT_PORT=6333

# 检查函数
check_qdrant() {
    curl -s http://localhost:$QDRANT_PORT/healthz > /dev/null 2>&1
}

check_api() {
    curl -s http://localhost:$API_PORT/health > /dev/null 2>&1
}

# 启动 Qdrant
start_qdrant() {
    echo -e "${BLUE}启动 Qdrant...${NC}"
    if check_qdrant; then
        echo -e "${GREEN}✓ Qdrant 已在运行${NC}"
    else
        nohup "$QDRANT_BIN" --config-path "$QDRANT_CONFIG" > ~/.mem0/qdrant.log 2>&1 &
        sleep 2
        if check_qdrant; then
            echo -e "${GREEN}✓ Qdrant 启动成功 (端口 $QDRANT_PORT)${NC}"
        else
            echo -e "${RED}✗ Qdrant 启动失败${NC}"
            exit 1
        fi
    fi
}

# 启动 API
start_api() {
    echo -e "${BLUE}启动 OpenMemory API...${NC}"
    if check_api; then
        echo -e "${GREEN}✓ API 已在运行${NC}"
    else
        cd "$MEM0_DIR/api"
        source .venv/bin/activate
        nohup uvicorn main:app --host 0.0.0.0 --port $API_PORT --workers 1 > ~/.mem0/api.log 2>&1 &
        sleep 3
        if check_api; then
            echo -e "${GREEN}✓ API 启动成功 (端口 $API_PORT)${NC}"
        else
            echo -e "${RED}✗ API 启动失败${NC}"
            exit 1
        fi
    fi
}

# 停止服务
stop_services() {
    echo -e "${BLUE}停止服务...${NC}"
    pkill -f "uvicorn main:app --host 0.0.0.0 --port $API_PORT" 2>/dev/null || true
    pkill -f "qdrant-macos" 2>/dev/null || true
    echo -e "${GREEN}✓ 服务已停止${NC}"
}

# 查看状态
status() {
    echo -e "${BLUE}服务状态:${NC}"
    
    if check_qdrant; then
        echo -e "  ${GREEN}●${NC} Qdrant (端口 $QDRANT_PORT) - 运行中"
    else
        echo -e "  ${RED}●${NC} Qdrant (端口 $QDRANT_PORT) - 未运行"
    fi
    
    if check_api; then
        echo -e "  ${GREEN}●${NC} OpenMemory API (端口 $API_PORT) - 运行中"
    else
        echo -e "  ${RED}●${NC} OpenMemory API (端口 $API_PORT) - 未运行"
    fi
}

# 备份数据
backup() {
    BACKUP_DIR="$HOME/backup/mem0-$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$BACKUP_DIR"
    
    echo -e "${BLUE}备份数据到 $BACKUP_DIR...${NC}"
    
    # 备份数据库
    if [ -f "$HOME/.openclaw/mem0/openmemory.db" ]; then
        cp "$HOME/.openclaw/mem0/openmemory.db" "$BACKUP_DIR/"
        echo -e "  ${GREEN}✓${NC} openmemory.db"
    fi
    
    # 备份 Qdrant
    if [ -d "$HOME/.mem0/storage" ]; then
        tar czf "$BACKUP_DIR/qdrant-storage.tar.gz" -C "$HOME/.mem0" storage/
        echo -e "  ${GREEN}✓${NC} Qdrant storage"
    fi
    
    echo -e "${GREEN}✓ 备份完成: $BACKUP_DIR${NC}"
}

# 主命令
case "${1:-start}" in
    start)
        echo -e "${BLUE}=== 启动 mem0 服务 ===${NC}"
        start_qdrant
        start_api
        echo ""
        status
        echo ""
        echo -e "${GREEN}mem0 服务已启动！${NC}"
        echo "  API: http://localhost:$API_PORT"
        echo "  Qdrant: http://localhost:$QDRANT_PORT"
        ;;
    stop)
        stop_services
        ;;
    restart)
        stop_services
        sleep 2
        start_qdrant
        start_api
        status
        ;;
    status)
        status
        ;;
    backup)
        backup
        ;;
    *)
        echo "用法: $0 [start|stop|restart|status|backup]"
        exit 1
        ;;
esac
