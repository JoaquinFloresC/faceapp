# FaceApp - Reconocimiento Facial con PHP, Node.js y PostgreSQL

Este proyecto implementa una arquitectura segura con la opción A:

- El cliente web solo envia embeddings a PHP.
- PHP valida sesión y reenvía la petición al microservicio Node.js.
- Node.js realiza la lectura y escritura en PostgreSQL usando pgvector.

## Requisitos

- Node.js 18+
- Docker Desktop (recomendado) o PostgreSQL 15+ con la extensión pgvector
- PHP con cURL y un servidor web PHP local para usar la integración PHP

## Opción recomendada: Docker

Docker Compose levanta PostgreSQL con pgvector y el microservicio Node.js. El servidor crea las tablas automáticamente al iniciar.

1. Crea el archivo `.env` a partir de `.env.example` y cambia `ADMIN_EMAIL` y `ADMIN_PASSWORD`.
2. Ejecuta:

```bash
docker compose up --build
```

3. Comprueba el servicio:

```bash
curl http://localhost:3000/health
```

La base de datos se conserva en el volumen `faceapp-pgdata`. Para eliminar también los datos:

```bash
docker compose down -v
```

## Opción manual: PostgreSQL local

Instala PostgreSQL 15 o superior con pgvector y crea la base de datos antes de iniciar Node.js:

```sql
CREATE DATABASE faceapp;
```

Después, ejecuta el esquema completo de [`database/schema.sql`](database/schema.sql) con un usuario que pueda crear la extensión `vector`. El arranque de `server.js` también intenta crear las tablas, pero no puede instalar PostgreSQL, crear la base de datos ni instalar pgvector.

## Configurar variables

Copia `.env.example` a `.env` o usa el `.env` que ya viene preparado con valores por defecto.

```env
PORT=3000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=faceapp
DB_USER=postgres
DB_PASSWORD=postgres
ADMIN_EMAIL=tu-correo-real@dominio.com
ADMIN_PASSWORD=una-clave-segura-de-8-o-mas-caracteres
ADMIN_NAME=Tu nombre
```

`ADMIN_EMAIL` y `ADMIN_PASSWORD` se usan únicamente para crear el primer administrador si todavía no existe. No uses credenciales de ejemplo en producción.

Después de iniciar sesión en `/admin`, puedes crear más administradores desde la sección "Administradores". Cada cuenta tiene su propio correo y contraseña y puede desactivarse sin eliminarla.

## Instalar dependencias Node

```bash
npm install
```

## Iniciar microservicio

```bash
node server.js
```

Puedes comprobarlo con:

```bash
curl http://localhost:3000/health
```

## Ejecutar PHP

Sirve este proyecto desde un servidor PHP local y abre la app.

Para una sesión demo de prueba, puedes abrir:

```text
login_demo.php?usuario_id=1
```

Luego accede a `index.html` o `index.php` donde el navegador pueda llamar a `api_registrar.php` y `api_identificar.php`.

## Endpoints del microservicio

- `POST /api/rostros/registrar`
- `POST /api/rostros/identificar`

## Registro multivista y umbral de reconocimiento

La demo captura cinco muestras durante el registro: rostro al centro, arriba, abajo, izquierda y derecha. Cada muestra se guarda como un embedding independiente para que la identificación pueda comparar varias poses. Las integraciones externas pueden seguir enviando un único campo `embedding`.

Los descriptores de `face-api.js` se comparan usando distancia euclidiana, que es la métrica esperada por ese modelo. Por defecto, la distancia debe ser menor que `0.60` y la diferencia con el segundo candidato debe ser de al menos `0.10` cuando pertenece a otro usuario:

```js
const encontrado = distanciaEuclidiana < 0.60 && !hayAmbiguedad;
```

Puedes ajustar estos valores mediante variables de entorno:

```env
FACE_MATCH_DISTANCE_THRESHOLD=0.60
FACE_MATCH_MARGIN=0.10
```

La búsqueda está aislada por `cliente_id`; nunca compara contra registros de otros clientes ni contra registros antiguos sin cliente. También rechaza la identificación cuando los dos candidatos más cercanos pertenecen a usuarios distintos y están demasiado próximos entre sí.

Con un solo rostro registrado siempre habrá un candidato más cercano, pero solo se considera encontrado si cumple el umbral. Si el consumidor PHP no recibe `distancia_euclidiana`, debe rechazar la respuesta; aceptar una distancia ausente puede convertir cualquier candidato en un falso positivo.

La consulta del endpoint aplica el umbral directamente en PostgreSQL. Por eso, cuando ningún registro está suficientemente cerca, la API devuelve `encontrado: false` sin asignar `usuario_id`; no devuelve el ID del candidato más cercano.

El acceso facial de administradores usa el mismo umbral conservador y registra en auditoría la distancia obtenida en cada intento. Si una distancia está cerca del límite, se debe rechazar y volver a verificar con una captura de mejor calidad.

## Nota de seguridad

El flujo real debe ejecutarse en un servidor PHP autenticado. La validación de sesión se realiza en:

- `api_registrar.php`
- `api_identificar.php`

Si no existe `$_SESSION['usuario_id']`, la petición se rechaza con `401`.

No incluyas API keys directamente en PHP o JavaScript. Usa variables de entorno, por ejemplo `FACECORE_API_KEY`, y revoca las claves que hayan sido expuestas.
