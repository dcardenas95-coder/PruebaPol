#!/bin/bash
# PruebaPol - Push a GitHub + Deploy a DigitalOcean
# Uso: bash push-deploy.sh "mensaje del commit"

set -e

SERVER="root@138.197.139.58"
REMOTE_DIR="/home/polymaker/app"

# Color
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}=== PruebaPol: Push + Deploy ===${NC}"

# 1. Commit y push
MSG="${1:-update}"
echo -e "\n${GREEN}[1/2] Push a GitHub...${NC}"
git add -A
git commit -m "$MSG" 2>/dev/null && echo "Commit: $MSG" || echo "Sin cambios para commitear"
git push origin main
echo "Push completado."

# 2. Deploy en servidor
echo -e "\n${GREEN}[2/2] Actualizando servidor...${NC}"
ssh $SERVER "cd $REMOTE_DIR && git pull origin main && npm install --production && npm run build && pm2 restart polymaker && echo '' && echo 'Estado:' && pm2 list"

echo -e "\n${GREEN}=== Deploy completado ===${NC}"
