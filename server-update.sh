#!/bin/bash
# PruebaPol - Actualizar servidor con últimos cambios de GitHub
# Uso: bash /home/polymaker/app/server-update.sh

set -e

APP_DIR="/home/polymaker/app"

echo "=== Actualizando PruebaPol ==="

cd $APP_DIR
echo "[1/4] Descargando cambios..."
git pull origin main

echo "[2/4] Instalando dependencias..."
npm install --production

echo "[3/4] Compilando..."
npm run build

echo "[4/4] Reiniciando bot..."
pm2 restart polymaker

echo ""
pm2 list
echo ""
echo "=== Actualización completada ==="
