#!/bin/bash
# PruebaPol - Actualizar servidor con últimos cambios de GitHub
# Uso: bash /home/polymaker/app/server-update.sh
# Script robusto con backup, verificación y rollback automático

APP_DIR="/home/polymaker/app"
BACKUP_DIR="/home/polymaker/dist-backup"
LOG_DIR="/var/log/polymaker"
ECOSYSTEM="$APP_DIR/ecosystem.config.cjs"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

rollback_and_exit() {
  local msg="$1"
  echo -e "${RED}ERROR: $msg${NC}"
  if [ -d "$BACKUP_DIR" ]; then
    echo -e "${YELLOW}      Restaurando build anterior desde backup...${NC}"
    rm -rf "$APP_DIR/dist"
    cp -r "$BACKUP_DIR" "$APP_DIR/dist"
    pm2 restart polymaker 2>/dev/null || pm2 start "$ECOSYSTEM" --only polymaker
    sleep 3
    echo -e "${GREEN}      Restaurado y reiniciado con versión anterior${NC}"
    pm2 list
  else
    echo -e "${RED}      No hay backup disponible para restaurar${NC}"
  fi
  exit 1
}

echo ""
echo "============================================"
echo "  PruebaPol - Actualización del Servidor"
echo "  $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "============================================"
echo ""

cd "$APP_DIR" || { echo -e "${RED}ERROR: No se encontró $APP_DIR${NC}"; exit 1; }

mkdir -p "$LOG_DIR"

# ─── PASO 1: Backup del build actual ───
echo -e "${YELLOW}[1/6] Creando backup del build actual...${NC}"
if [ -d "$APP_DIR/dist" ] && [ -f "$APP_DIR/dist/index.cjs" ]; then
  rm -rf "$BACKUP_DIR"
  cp -r "$APP_DIR/dist" "$BACKUP_DIR" || { echo -e "${RED}ERROR: No se pudo crear backup${NC}"; exit 1; }
  echo -e "${GREEN}      Backup creado en $BACKUP_DIR${NC}"
else
  echo "      No hay build anterior válido, saltando backup"
fi

# ─── PASO 2: Git pull ───
echo -e "${YELLOW}[2/6] Descargando cambios de GitHub...${NC}"
if ! git pull origin main; then
  echo -e "${RED}ERROR: git pull falló. Verifica conexión y credenciales.${NC}"
  exit 1
fi
echo -e "${GREEN}      Código actualizado${NC}"

# ─── PASO 3: Instalar dependencias (incluye devDeps para tsx/vite) ───
echo -e "${YELLOW}[3/6] Instalando dependencias...${NC}"
if ! npm install 2>&1; then
  echo -e "${YELLOW}      Reintentando con cache limpio...${NC}"
  npm cache clean --force
  if ! npm install 2>&1; then
    rollback_and_exit "npm install falló"
  fi
fi
echo -e "${GREEN}      Dependencias instaladas${NC}"

# ─── PASO 4: Compilar (build) ───
echo -e "${YELLOW}[4/6] Compilando aplicación...${NC}"
rm -rf "$APP_DIR/dist"

if ! npx tsx script/build.ts 2>&1; then
  rollback_and_exit "Build falló durante compilación"
fi

# ─── PASO 5: Verificar que el build generó los archivos necesarios ───
echo -e "${YELLOW}[5/6] Verificando build...${NC}"

if [ ! -f "$APP_DIR/dist/index.cjs" ]; then
  rollback_and_exit "Build incompleto - falta dist/index.cjs (servidor)"
fi

if [ ! -f "$APP_DIR/dist/public/index.html" ]; then
  rollback_and_exit "Build incompleto - falta dist/public/index.html (frontend)"
fi

if [ ! -d "$APP_DIR/dist/public/assets" ]; then
  rollback_and_exit "Build incompleto - falta dist/public/assets/ (assets)"
fi

HTML_SIZE=$(stat -c%s "$APP_DIR/dist/public/index.html" 2>/dev/null || echo "0")
CJS_SIZE=$(stat -c%s "$APP_DIR/dist/index.cjs" 2>/dev/null || echo "0")

if [ "$HTML_SIZE" -lt 100 ]; then
  rollback_and_exit "index.html parece vacío o corrupto (${HTML_SIZE} bytes)"
fi

if [ "$CJS_SIZE" -lt 1000 ]; then
  rollback_and_exit "index.cjs parece vacío o corrupto (${CJS_SIZE} bytes)"
fi

JS_COUNT=$(find "$APP_DIR/dist/public/assets" -name "*.js" | wc -l)
CSS_COUNT=$(find "$APP_DIR/dist/public/assets" -name "*.css" | wc -l)
echo -e "${GREEN}      dist/index.cjs .............. OK ($(numfmt --to=iec $CJS_SIZE))${NC}"
echo -e "${GREEN}      dist/public/index.html ...... OK ($(numfmt --to=iec $HTML_SIZE))${NC}"
echo -e "${GREEN}      dist/public/assets/ ......... OK (${JS_COUNT} JS, ${CSS_COUNT} CSS)${NC}"

# ─── PASO 6: Reiniciar PM2 y verificar ───
echo -e "${YELLOW}[6/6] Reiniciando servidor...${NC}"

pm2 stop polymaker 2>/dev/null || true
sleep 2

if pm2 describe polymaker >/dev/null 2>&1; then
  pm2 restart polymaker
else
  pm2 start "$ECOSYSTEM" --only polymaker
fi

sleep 5

PM2_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
  apps = json.load(sys.stdin)
  for a in apps:
    if a.get('name') == 'polymaker':
      print(a.get('pm2_env', {}).get('status', 'unknown'))
      sys.exit(0)
  print('not_found')
except: print('parse_error')
" 2>/dev/null || echo "unknown")

if [ "$PM2_STATUS" = "online" ]; then
  echo -e "${GREEN}      PM2 status: online${NC}"
else
  echo -e "${RED}      PM2 status: $PM2_STATUS${NC}"
  echo "      Últimas líneas de log:"
  pm2 logs polymaker --lines 15 --nostream 2>/dev/null
  echo ""

  echo -e "${YELLOW}      Reintentando reinicio...${NC}"
  pm2 restart polymaker 2>/dev/null || pm2 start "$ECOSYSTEM" --only polymaker
  sleep 5

  PM2_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
  apps = json.load(sys.stdin)
  for a in apps:
    if a.get('name') == 'polymaker':
      print(a.get('pm2_env', {}).get('status', 'unknown'))
      sys.exit(0)
  print('not_found')
except: print('parse_error')
" 2>/dev/null || echo "unknown")

  if [ "$PM2_STATUS" != "online" ]; then
    rollback_and_exit "Servidor no arrancó correctamente (status: $PM2_STATUS)"
  fi
  echo -e "${GREEN}      PM2 status: online (segundo intento)${NC}"
fi

echo ""
echo "      Verificando respuesta HTTP..."
sleep 2

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5000/ 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "304" ]; then
  echo -e "${GREEN}      HTTP check: $HTTP_CODE OK${NC}"
else
  echo -e "${RED}      HTTP check: $HTTP_CODE - La página no responde correctamente${NC}"
  rollback_and_exit "Servidor arrancó pero la página no responde (HTTP $HTTP_CODE)"
fi

API_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5000/api/bot/status 2>/dev/null || echo "000")

if [ "$API_CODE" = "200" ]; then
  echo -e "${GREEN}      API  check: 200 OK (/api/bot/status)${NC}"
else
  echo -e "${YELLOW}      API  check: $API_CODE (puede tardar en inicializar)${NC}"
fi

echo ""
echo "============================================"
pm2 list
echo "============================================"
echo ""
echo -e "${GREEN}=== Actualización completada exitosamente ===${NC}"
echo ""

rm -rf "$BACKUP_DIR"
