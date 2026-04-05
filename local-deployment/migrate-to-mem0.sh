#!/bin/bash
# 迁移 OpenMemory 数据从 ~/.openclaw/mem0/ 到 ~/.mem0/data/
# 实现数据统一存储

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== mem0 数据迁移工具 ===${NC}"
echo ""
echo "目标: 将 OpenMemory 数据从 ~/.openclaw/mem0/ 迁移到 ~/.mem0/data/"
echo ""

# 检查源数据
SOURCE_DIR="$HOME/.openclaw/mem0"
TARGET_DIR="$HOME/.mem0/data"
BACKUP_DIR="$HOME/.mem0/backup/migration-$(date +%Y%m%d_%H%M%S)"

if [ ! -d "$SOURCE_DIR" ]; then
    echo -e "${RED}✗ 源目录不存在: $SOURCE_DIR${NC}"
    exit 1
fi

echo -e "${BLUE}1. 检查数据 ===${NC}"
echo "   源目录: $SOURCE_DIR"
echo "   目标目录: $TARGET_DIR"
echo "   备份目录: $BACKUP_DIR"
echo ""

# 显示源数据
echo "   源数据大小:"
du -sh "$SOURCE_DIR"/* 2>/dev/null || echo "   (无法读取)"
echo ""

# 确认迁移
read -p "是否开始迁移? (y/n): " confirm
if [ "$confirm" != "y" ]; then
    echo "已取消"
    exit 0
fi

# 创建备份
echo -e "${BLUE}2. 创建备份 ===${NC}"
mkdir -p "$BACKUP_DIR"
cp -r "$SOURCE_DIR"/* "$BACKUP_DIR/" 2>/dev/null || true
echo -e "${GREEN}✓ 备份已创建: $BACKUP_DIR${NC}"
echo ""

# 停止服务
echo -e "${BLUE}3. 停止服务 ===${NC}"
if pgrep -f "uvicorn main:app --host 0.0.0.0 --port 8765" > /dev/null; then
    echo "   停止 OpenMemory API..."
    pkill -f "uvicorn main:app --host 0.0.0.0 --port 8765" || true
    sleep 2
    echo -e "${GREEN}✓ 服务已停止${NC}"
else
    echo -e "${YELLOW}⚠ 服务未运行${NC}"
fi
echo ""

# 迁移数据
echo -e "${BLUE}4. 迁移数据 ===${NC}"
mkdir -p "$TARGET_DIR"

# 复制数据文件
for file in openmemory.db history.db; do
    if [ -f "$SOURCE_DIR/$file" ]; then
        cp "$SOURCE_DIR/$file" "$TARGET_DIR/"
        echo -e "${GREEN}✓${NC} 已复制: $file"
    else
        echo -e "${YELLOW}⚠${NC} 未找到: $file"
    fi
done

echo ""
echo "   迁移后数据:"
ls -lh "$TARGET_DIR"/*.db 2>/dev/null | awk '{printf "   %s (%s)\n", $9, $5}'
echo ""

# 更新环境变量配置
echo -e "${BLUE}5. 更新环境变量 ===${NC}"
ENV_FILE="$HOME/project/mem0/openmemory/api/.env"
NEW_DB_URL="sqlite:////$TARGET_DIR/openmemory.db"

if [ -f "$ENV_FILE" ]; then
    # 备份原配置
    cp "$ENV_FILE" "$ENV_FILE.backup.$(date +%Y%m%d)"
    
    # 更新 DATABASE_URL
    if grep -q "DATABASE_URL=" "$ENV_FILE"; then
        sed -i.bak "s|DATABASE_URL=.*|DATABASE_URL=$NEW_DB_URL|" "$ENV_FILE"
        rm -f "$ENV_FILE.bak"
        echo -e "${GREEN}✓${NC} 已更新 DATABASE_URL"
        echo "   新路径: $NEW_DB_URL"
    else
        echo "DATABASE_URL=$NEW_DB_URL" >> "$ENV_FILE"
        echo -e "${GREEN}✓${NC} 已添加 DATABASE_URL"
    fi
else
    echo -e "${YELLOW}⚠ 未找到环境变量文件: $ENV_FILE${NC}"
fi
echo ""

# 创建软链接（可选）
echo -e "${BLUE}6. 创建兼容软链接 ===${NC}"
read -p "是否在原位置创建软链接以兼容旧配置? (y/n): " link_confirm
if [ "$link_confirm" == "y" ]; then
    for file in openmemory.db history.db; do
        if [ -f "$SOURCE_DIR/$file" ]; then
            mv "$SOURCE_DIR/$file" "$SOURCE_DIR/$file.migrated"
            ln -s "$TARGET_DIR/$file" "$SOURCE_DIR/$file"
            echo -e "${GREEN}✓${NC} 已创建软链接: $file"
        fi
    done
    echo -e "${YELLOW}⚠ 原数据文件已重命名为 .migrated${NC}"
else
    echo -e "${YELLOW}⚠ 跳过软链接创建${NC}"
    echo "   注意: 需要手动更新所有引用旧路径的配置"
fi
echo ""

# 启动服务
echo -e "${BLUE}7. 启动服务 ===${NC}"
cd "$HOME/project/mem0/openmemory/api"
source .venv/bin/activate
nohup uvicorn main:app --host 0.0.0.0 --port 8765 --workers 1 > "$HOME/.mem0/api.log" 2>&1 &
sleep 3

if pgrep -f "uvicorn main:app --host 0.0.0.0 --port 8765" > /dev/null; then
    echo -e "${GREEN}✓ 服务已启动${NC}"
else
    echo -e "${RED}✗ 服务启动失败，请手动检查${NC}"
fi
echo ""

# 验证
echo -e "${BLUE}8. 验证 ===${NC}"
if curl -s http://localhost:8765/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ API 健康检查通过${NC}"
else
    echo -e "${YELLOW}⚠ API 健康检查失败${NC}"
fi
echo ""

echo -e "${GREEN}=== 迁移完成 ===${NC}"
echo ""
echo "数据现在存储在:"
echo "  ~/.mem0/data/"
echo ""
echo "备份位置:"
echo "  $BACKUP_DIR"
echo ""
echo "如需回滚，运行:"
echo "  cp $BACKUP_DIR/* ~/.openclaw/mem0/"
