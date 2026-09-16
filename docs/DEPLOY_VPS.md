# Despliegue en VPS para FaceApp

Esta guía describe cómo desplegar la aplicación en un VPS Ubuntu con Docker, PostgreSQL + pgvector y Nginx como reverse proxy con HTTPS.

## 1) Preparar el VPS

Conéctate al servidor y ejecuta:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git docker.io docker-compose-plugin nginx certbot python3-certbot-nginx
```

Activar Docker:

```bash
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker $USER
```

Cierra sesión y vuelve a entrar para aplicar el grupo `docker`.

---

## 2) Clonar el proyecto

```bash
mkdir -p /var/www/faceapp
cd /var/www/faceapp
git clone <tu-repo> .
```

Asegúrate de que en el proyecto exista:

- `server.js`
- `db.js`
- `package.json`
- `database/schema.sql`
- `public/`

---

## 3) Configurar variables de entorno

Crea un archivo `.env` en la raíz:

```env
PORT=3000
DB_HOST=db
DB_PORT=5432
DB_NAME=faceapp
DB_USER=postgres
DB_PASSWORD=postgres
NODE_ENV=production
```

> En producción real, usa secretos seguros y no valores fijos en Git.

---

## 4) Crear Dockerfile

En la raíz del proyecto crea `Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
```

---

## 5) Crear docker-compose.yml

En la raíz crea `docker-compose.yml`:

```yaml
version: "3.9"

services:
  db:
    image: pgvector/pgvector:pg15
    container_name: faceapp-db
    restart: always
    environment:
      POSTGRES_DB: faceapp
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  app:
    build: .
    container_name: faceapp-app
    restart: always
    env_file:
      - .env
    depends_on:
      - db
    ports:
      - "3000:3000"

volumes:
  pgdata:
```

---

## 6) Levantar la infraestructura

Ejecuta:

```bash
docker compose up -d --build
```

Comprueba el estado:

```bash
docker compose ps
docker compose logs -f app
docker compose logs -f db
```

---

## 7) Aplicar el esquema SQL

La forma recomendada es ejecutar el SQL del proyecto:

```bash
docker exec -i faceapp-db psql -U postgres -d faceapp < database/schema.sql
```

Si la app intenta crear tablas por sí sola, eso puede servir como fallback, pero lo más limpio es aplicar la migración explícita.

---

## 8) Configurar Nginx

Crea el host virtual de Nginx:

```bash
sudo nano /etc/nginx/sites-available/faceapp
```

Contenido:

```nginx
server {
    listen 80;
    server_name tu-dominio.com www.tu-dominio.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Activa el sitio:

```bash
sudo ln -s /etc/nginx/sites-available/faceapp /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

---

## 9) Activar HTTPS con Let’s Encrypt

```bash
sudo certbot --nginx -d tu-dominio.com -d www.tu-dominio.com
```

Esto genera el certificado y reconfigura Nginx para HTTPS.

---

## 10) Probar la app

### Verificar salud del servicio

```bash
curl http://localhost:3000/health
```

### Acceder al admin

```text
https://tu-dominio.com/admin
```

### Probar la API

```bash
curl -X POST https://tu-dominio.com/api/rostros/identificar \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey tu_api_key" \
  -d '{"embedding":[0.1,0.2,0.3]}'
```

> En producción el embedding debe tener 128 valores, no menos.

---

## 11) Mantener y monitorizar

### Ver logs

```bash
docker compose logs -f app
docker compose logs -f db
```

### Backup de PostgreSQL

```bash
docker exec faceapp-db pg_dump -U postgres faceapp > backup.sql
```

### Reiniciar servicios

```bash
docker compose restart
```

---

## 12) Recomendaciones finales de producción

- usa DNS con dominio real
- usa HTTPS siempre
- guarda las variables de entorno en un archivo `.env` seguro o gestor de secretos
- no compartas API keys entre clientes
- usa API keys por cliente con permisos
- configura logs y backups
- usa un servidor con reinicio automático

---

## 13) Checklist final

- [ ] VPS listo
- [ ] Docker instalado
- [ ] `.env` configurado
- [ ] `Dockerfile` creado
- [ ] `docker-compose.yml` creado
- [ ] PostgreSQL + pgvector levantado
- [ ] schema SQL ejecutado
- [ ] app Node arrancada
- [ ] Nginx proxy configurado
- [ ] HTTPS activo
- [ ] `/health` responde
- [ ] `/admin` accesible

---

Si quieres, puedo dejarte también una versión lista para copiar de `docker-compose.yml` y el `Dockerfile` adaptada exactamente a este proyecto.
