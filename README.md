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
NODE_HOST=localhost
FACECORE_API_KEY=face_tu_api_key
```

`ADMIN_EMAIL` y `ADMIN_PASSWORD` se usan únicamente para crear el primer administrador si todavía no existe. No uses credenciales de ejemplo en producción.

`FACECORE_API_KEY` es la API key del cliente que se crea desde `/admin`. Los archivos PHP la leen desde el entorno del servidor y la envían a Node mediante `Authorization: ApiKey ...`. Nunca la escribas directamente en PHP, JavaScript ni en Git.

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

Sirve `public/` y `api/php/` desde Apache, XAMPP, Laragon u otro servidor PHP con cURL habilitado. Configura estas variables en el entorno de PHP:

```env
NODE_HOST=localhost
FACECORE_API_KEY=face_tu_api_key
```

Los wrappers PHP reciben JSON y reenvían las peticiones autenticadas a Node:

- `POST api/php/api_registrar.php`: requiere `usuario_id` y `embedding` o `embeddings`.
- `POST api/php/api_identificar.php`: requiere `embedding`.

No necesitan `$_SESSION['usuario_id']`; la autenticación entre PHP y Node se realiza con `FACECORE_API_KEY`. La API key debe tener los permisos `face:register` o `face:identify` correspondientes.

Ejemplo de llamada directa al wrapper de registro:

```bash
curl -X POST http://localhost/faceapp/api/php/api_registrar.php \
	-H "Content-Type: application/json" \
	-d '{"usuario_id":42,"embedding":[0.1,0.2]}'
```

El ejemplo anterior está incompleto deliberadamente: en una petición real el embedding debe contener 128 valores numéricos.

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

Las rutas Node `POST /api/rostros/registrar` y `POST /api/rostros/identificar` exigen una API key válida mediante `Authorization: ApiKey ...`. Los wrappers PHP también usan esa API key, pero la mantienen únicamente en el entorno del servidor y no la exponen al navegador.

No incluyas API keys directamente en PHP o JavaScript. Usa variables de entorno, por ejemplo `FACECORE_API_KEY`, y revoca las claves que hayan sido expuestas.
