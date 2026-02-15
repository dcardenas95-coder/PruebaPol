# Guía de Despliegue - PolyMaker en DigitalOcean

## Requisitos previos
- Cuenta en [DigitalOcean](https://digitalocean.com)
- Tu `POLYMARKET_PRIVATE_KEY` (clave privada de tu wallet)
- El código del proyecto en un repositorio Git (GitHub, GitLab, etc.)

---

## Paso 1: Crear el Droplet

1. Entra a [cloud.digitalocean.com](https://cloud.digitalocean.com)
2. Click en **Create → Droplets**
3. Configura:
   - **Region**: Toronto (TOR1) — Canadá, fuera de restricciones de EE.UU.
   - **Image**: Ubuntu 22.04 LTS
   - **Size**: Basic → Regular → **$6/mes** (1 vCPU, 1 GB RAM, 25 GB SSD)
   - **Authentication**: Elige **SSH Key** (más seguro) o **Password**
   - **Hostname**: `polymaker`
4. Click en **Create Droplet**
5. Anota la **IP** del servidor (ej: `159.203.10.50`)

---

## Paso 2: Subir el código a Git

Si tu código no está en un repositorio, desde tu máquina local o Replit:

```bash
# En Replit, puedes conectar con GitHub desde la pestaña Git
# O crear un repo manualmente:
git init
git add .
git commit -m "PolyMaker deploy"
git remote add origin https://github.com/TU_USUARIO/polymaker.git
git push -u origin main
```

---

## Paso 3: Conectarte al servidor

```bash
# Desde tu terminal (Mac/Linux) o PowerShell (Windows)
ssh root@TU_IP_DEL_SERVIDOR

# Si usaste password, te lo pedirá
# Si usaste SSH key, entrará directo
```

---

## Paso 4: Ejecutar el script de instalación

```bash
# Descargar y ejecutar el script de deploy
# Opción A: Si tienes el repo
git clone https://github.com/TU_USUARIO/polymaker.git /tmp/polymaker-setup
bash /tmp/polymaker-setup/deploy.sh

# Opción B: Copiar deploy.sh manualmente y ejecutar
nano deploy.sh
# (pegar el contenido del archivo deploy.sh)
chmod +x deploy.sh
bash deploy.sh
```

El script instalará automáticamente:
- Node.js 20
- PostgreSQL
- PM2 (gestor de procesos)
- Nginx (proxy web)
- Creará la base de datos
- Generará las credenciales

**Guarda las credenciales que muestra al final.**

---

## Paso 5: Configurar la clave privada

```bash
# Editar el archivo de variables de entorno
nano /home/polymaker/.env

# Cambiar POLYMARKET_PRIVATE_KEY por tu clave real
# Guardar: Ctrl+O, Enter, Ctrl+X
```

---

## Paso 6: Desplegar la aplicación

```bash
# Cambiar al usuario polymaker
su - polymaker

# Clonar el proyecto
git clone https://github.com/TU_USUARIO/polymaker.git ~/app
cd ~/app

# Copiar las variables de entorno
cp /home/polymaker/.env .env

# Instalar dependencias
npm install

# Crear las tablas en la base de datos
npm run db:push

# Construir la aplicación
npm run build

# Iniciar con PM2
pm2 start ecosystem.config.cjs
pm2 save
```

---

## Paso 7: Configurar inicio automático

```bash
# Como root (exit para volver a root si estás como polymaker)
exit
pm2 startup systemd -u polymaker --hp /home/polymaker
```

Esto hace que PM2 arranque automáticamente si el servidor se reinicia.

---

## Paso 8: Verificar

```bash
# Ver estado del bot
pm2 status

# Ver logs en tiempo real
pm2 logs polymaker

# Acceder al dashboard
# Abre en tu navegador: http://TU_IP_DEL_SERVIDOR
```

---

## Comandos útiles del día a día

```bash
# Ver logs en tiempo real
pm2 logs polymaker

# Reiniciar el bot
pm2 restart polymaker

# Detener el bot
pm2 stop polymaker

# Ver uso de recursos
pm2 monit

# Actualizar el código
su - polymaker
cd ~/app
git pull
npm install
npm run build
pm2 restart polymaker
```

---

## Seguridad adicional (recomendado)

### Firewall
```bash
# Como root
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

### HTTPS con Let's Encrypt (si tienes dominio)
```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d tu-dominio.com
```

### Proteger el dashboard con contraseña HTTP básica
```bash
apt install apache2-utils
htpasswd -c /etc/nginx/.htpasswd admin
# Te pedirá una contraseña

# Editar la config de Nginx
nano /etc/nginx/sites-available/polymaker
# Agregar dentro del bloque location /:
#   auth_basic "PolyMaker Dashboard";
#   auth_basic_user_file /etc/nginx/.htpasswd;

nginx -t && systemctl restart nginx
```

---

## Solución de problemas

### El bot no arranca
```bash
pm2 logs polymaker --lines 50
# Revisar si hay errores de conexión a la base de datos o variables faltantes
```

### Error de base de datos
```bash
# Verificar que PostgreSQL esté corriendo
systemctl status postgresql

# Verificar conexión
su - polymaker
cd ~/app
node -e "const pg = require('pg'); const c = new pg.Client(process.env.DATABASE_URL); c.connect().then(() => { console.log('OK'); c.end(); }).catch(e => console.error(e.message))"
```

### Verificar que no hay geo-bloqueo
```bash
# Desde el servidor, verificar la IP
curl ifconfig.me
# Debería mostrar una IP de Canadá (Toronto)

# Probar conexión a Polymarket
curl -s https://clob.polymarket.com/ | head -5
# Debería responder sin error 403
```

### Actualizar el código
```bash
su - polymaker
cd ~/app
git pull origin main
npm install
npm run build
pm2 restart polymaker
```

---

## Costos estimados

| Concepto | Costo mensual |
|----------|--------------|
| Droplet (1 CPU, 1 GB) | $6 USD |
| Total | **$6 USD/mes** |

Si necesitas más rendimiento, puedes escalar a $12/mes (2 CPU, 2 GB) desde el panel de DigitalOcean sin perder datos.
