#!/bin/bash
set -e

echo "============================================"
echo "  PolyMaker - Script de despliegue"
echo "  DigitalOcean / Ubuntu 22.04+"
echo "============================================"
echo ""

if [ "$EUID" -ne 0 ]; then
  echo "Error: Ejecuta este script como root (sudo bash deploy.sh)"
  exit 1
fi

APP_USER="polymaker"
APP_DIR="/home/$APP_USER/app"
LOG_DIR="/var/log/polymaker"
DB_NAME="polymaker"
DB_USER="polymaker"
DB_PASS=$(openssl rand -hex 16)
SESSION_SECRET=$(openssl rand -hex 32)

echo "[1/8] Actualizando sistema..."
apt update && apt upgrade -y

echo "[2/8] Instalando Node.js 20..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi
echo "  Node.js $(node -v), npm $(npm -v)"

echo "[3/8] Instalando PostgreSQL..."
if ! command -v psql &> /dev/null; then
  apt install -y postgresql postgresql-contrib
fi
systemctl enable postgresql
systemctl start postgresql

echo "[4/8] Configurando base de datos..."
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"

DATABASE_URL="postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME"
echo "  Base de datos configurada: $DB_NAME"

echo "[5/8] Instalando PM2 y Nginx..."
npm install -g pm2
apt install -y nginx
systemctl enable nginx

echo "[6/8] Creando usuario y directorios..."
id -u $APP_USER &>/dev/null || useradd -m -s /bin/bash $APP_USER
mkdir -p $LOG_DIR
chown $APP_USER:$APP_USER $LOG_DIR

echo "[7/8] Configurando Nginx..."
cat > /etc/nginx/sites-available/polymaker << 'NGINX_CONF'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }
}
NGINX_CONF

ln -sf /etc/nginx/sites-available/polymaker /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

echo "[8/8] Generando archivo .env..."
cat > /home/$APP_USER/.env << ENV_FILE
DATABASE_URL=$DATABASE_URL
POLYMARKET_PRIVATE_KEY=CAMBIAR_POR_TU_CLAVE_PRIVADA
SESSION_SECRET=$SESSION_SECRET
NODE_ENV=production
PORT=5000
ENV_FILE
chown $APP_USER:$APP_USER /home/$APP_USER/.env

echo ""
echo "============================================"
echo "  Servidor preparado!"
echo "============================================"
echo ""
echo "Próximos pasos:"
echo ""
echo "1. Edita la clave privada de Polymarket:"
echo "   nano /home/$APP_USER/.env"
echo ""
echo "2. Clona el proyecto:"
echo "   su - $APP_USER"
echo "   git clone TU_REPO_URL $APP_DIR"
echo "   cd $APP_DIR"
echo "   cp /home/$APP_USER/.env .env"
echo ""
echo "3. Instala dependencias y construye:"
echo "   npm install"
echo "   npm run db:push"
echo "   npm run build"
echo ""
echo "4. Verifica que el build se creó correctamente:"
echo "   ls dist/index.cjs"
echo ""
echo "5. Inicia con PM2:"
echo "   pm2 start ecosystem.config.cjs"
echo "   pm2 save"
echo "   exit"
echo "   pm2 startup systemd -u $APP_USER --hp /home/$APP_USER"
echo ""
echo "6. Accede al dashboard:"
echo "   http://$(curl -s ifconfig.me)"
echo ""
echo "============================================"
echo "  Credenciales de la base de datos"
echo "  (guarda esta información)"
echo "============================================"
echo "  DATABASE_URL: $DATABASE_URL"
echo "  DB Password:  $DB_PASS"
echo "  Session Secret: $SESSION_SECRET"
echo "============================================"
