# Documentación de FaceCore API

Esta API permite registrar embeddings faciales y buscar coincidencias para identificar a un usuario con reconocimiento facial.

La API está protegida por API keys por cliente. Cada cliente tiene una key propia y permisos específicos.

## Base URL

```text
https://facecoreapi.com
```

## Autenticación

Todos los endpoints protegidos requieren una API key.

### Headers válidos

```http
Authorization: ApiKey <tu_api_key>
```

o

```http
X-API-Key: <tu_api_key>
```

Si la key no es válida, no corresponde al cliente, está revocada, inactiva o no tiene permisos, la API responderá con `401` o `403`.

---

## 1) Registrar rostro

### Endpoint

```http
POST /api/rostros/registrar
```

### Descripción

Guarda uno o varios embeddings faciales asociados a un `usuario_id` dentro del contexto del cliente autenticado. La demo web registra cinco poses: centro, arriba, abajo, izquierda y derecha. Cada pose se almacena como una muestra independiente del mismo usuario.

### Headers

```http
Content-Type: application/json
Authorization: ApiKey <tu_api_key>
```

### Body

```jsonc
{
  "usuario_id": 12,
  "embeddings": [
    [0.1, 0.2, 0.3 /* ... 125 valores numericos más ... */],
    [0.11, 0.21, 0.31 /* ... 125 valores numericos más ... */],
    [0.12, 0.22, 0.32 /* ... 125 valores numericos más ... */],
    [0.13, 0.23, 0.33 /* ... 125 valores numericos más ... */],
    [0.14, 0.24, 0.34 /* ... 125 valores numericos más ... */]
  ]
}
```

El ejemplo está abreviado: en una petición real, cada vector debe contener 128 números.

Importante:
- `usuario_id` es obligatorio
- `embeddings` debe contener entre 1 y 10 vectores
- cada vector debe tener exactamente 128 valores numéricos
- por compatibilidad, también se acepta un único campo `embedding` con 128 valores

### Respuesta exitosa

```json
{
  "ok": true,
  "mensaje": "5 muestras faciales registradas correctamente.",
  "muestras": [
    {
      "id": 1,
      "usuario_id": 12,
      "created_at": "2026-09-12T12:00:00.000Z"
    }
  ]
}
```

### Respuesta de error

```json
{
  "ok": false,
  "error": "Se requiere usuario_id y entre 1 y 10 embeddings vector(128)."
}
```

Status HTTP esperado:
- `201` si fue exitoso
- `400` si faltan datos, hay más de 10 muestras o algún vector no tiene 128 elementos
- `401` si la API key es inválida
- `403` si no tiene permiso
- `500` si falla la base de datos o el proceso

---

## 2) Identificar rostro

### Endpoint

```http
POST /api/rostros/identificar
```

### Descripción

Compara el embedding recibido con los rostros registrados del cliente autenticado y devuelve si existe una coincidencia cercana.

Los descriptores de `face-api.js` se comparan usando distancia euclidiana contra las muestras del cliente autenticado. Por defecto, se considera coincidencia cuando la distancia es menor que `0.60`. Si los dos candidatos más cercanos pertenecen a usuarios distintos y la diferencia entre ellos es menor que `0.10`, la respuesta se marca como ambigua y no se identifica a ningún usuario. Estos valores pueden ajustarse mediante `FACE_MATCH_DISTANCE_THRESHOLD` y `FACE_MATCH_MARGIN`.

Si el cliente tiene un solo rostro registrado, siempre existirá un candidato más cercano. Eso no significa que sea una coincidencia: `encontrado` solo debe ser `true` cuando se cumpla el umbral. La aplicación consumidora debe rechazar la respuesta si falta `distancia_euclidiana`; nunca debe tratar una distancia ausente como una coincidencia confiable.

El umbral se aplica directamente en la consulta de PostgreSQL. Si ninguna muestra queda por debajo de `FACE_MATCH_DISTANCE_THRESHOLD`, la API devuelve `encontrado: false` y `usuario_id: null`; el candidato más cercano no se devuelve como identidad.

### Headers

```http
Content-Type: application/json
Authorization: ApiKey <tu_api_key>
```

### Body

```json
{
  "embedding": [
    0.1, 0.2, 0.3, 0.4, 0.5,
    0.6, 0.7, 0.8, 0.9, 1.0,
    0.11, 0.12, 0.13, 0.14, 0.15,
    0.16, 0.17, 0.18, 0.19, 0.20
  ]
}
```

### Respuesta exitosa

```json
{
  "encontrado": true,
  "mensaje": "Rostro identificado correctamente.",
  "usuario_id": 12,
  "distancia_euclidiana": 0.42,
  "ambigua": false
}
```

### Respuesta cuando no hay coincidencia

```json
{
  "encontrado": false,
  "mensaje": "No se encontró un rostro suficientemente similar.",
  "usuario_id": null,
  "distancia_euclidiana": 0.83,
  "ambigua": false
}
```

Cuando la coincidencia es dudosa, `encontrado` será `false` y `ambigua` será `true`:

```json
{
  "encontrado": false,
  "mensaje": "No se encontró un rostro suficientemente similar.",
  "usuario_id": null,
  "distancia_euclidiana": 0.56,
  "ambigua": true
}
```

### Respuesta de error

```json
{
  "ok": false,
  "error": "Se requiere un embedding numérico vector(128)."
}
```

Status HTTP esperado:
- `200` si se pudo procesar la comparación
- `400` si el embedding no es válido
- `401` si la API key es inválida
- `403` si no tiene permiso
- `500` si falla el proceso interno

---

## 3) Salud del servicio

### Endpoint

```http
GET /health
```

### Descripción

Comprueba que el servicio siga vivo y que la base de datos responda.

### Ejemplo

```bash
curl https://facecoreapi.com/health
```

### Respuesta exitosa

```json
{
  "ok": true,
  "db": true
}
```

---

## 4) Permisos por API key

Cada key puede tener permisos como:

- `face:register`
- `face:identify`

Por ejemplo:
- una key para registro solo puede llamar a `/api/rostros/registrar`
- una key para identificación solo puede llamar a `/api/rostros/identificar`
- una key con ambos permisos puede usar ambos endpoints

La administración de clientes y keys se realiza desde la consola admin.

---

## 5) Ejemplos con PHP

Estos ejemplos llaman directamente al microservicio Node.js. Guarda la API key en una variable de entorno y nunca la expongas en JavaScript del navegador.

### Cliente PHP reutilizable

```php
<?php

function faceCoreRequest(string $url, string $apiKey, array $payload): array
{
  $curl = curl_init($url);
  curl_setopt_array($curl, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode($payload, JSON_THROW_ON_ERROR),
    CURLOPT_HTTPHEADER => [
      'Content-Type: application/json',
      'Accept: application/json',
      'Authorization: ApiKey ' . $apiKey,
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 20,
  ]);

  $body = curl_exec($curl);
  if ($body === false) {
    $error = curl_error($curl);
    curl_close($curl);
    throw new RuntimeException('Error de conexión: ' . $error);
  }

  $status = curl_getinfo($curl, CURLINFO_HTTP_CODE);
  curl_close($curl);
  $response = json_decode($body, true);

  if (!is_array($response)) {
    throw new RuntimeException('La API devolvió una respuesta no válida.');
  }
  if ($status >= 400) {
    throw new RuntimeException($response['error'] ?? 'La API rechazó la petición.');
  }

  return $response;
}

$baseUrl = getenv('FACECORE_API_URL') ?: 'https://facecoreapi.com';
$apiKey = getenv('FACECORE_API_KEY');
if (!$apiKey) {
  throw new RuntimeException('Define FACECORE_API_KEY en el entorno.');
}

$embeddings = [
  array_fill(0, 128, 0.1), // Sustituye por las muestras reales.
  array_fill(0, 128, 0.2),
];
$response = faceCoreRequest(
  $baseUrl . '/api/rostros/registrar',
  $apiKey,
  ['usuario_id' => 42, 'embeddings' => $embeddings]
);

var_dump($response);
```

### Identificar un rostro desde PHP

```php
<?php
$baseUrl = getenv('FACECORE_API_URL') ?: 'https://facecoreapi.com';
$apiKey = getenv('FACECORE_API_KEY');
$embedding = array_fill(0, 128, 0.1); // Sustituye por el embedding real.

$curl = curl_init($baseUrl . '/api/rostros/identificar');
curl_setopt_array($curl, [
  CURLOPT_POST => true,
  CURLOPT_POSTFIELDS => json_encode(['embedding' => $embedding], JSON_THROW_ON_ERROR),
  CURLOPT_HTTPHEADER => [
    'Content-Type: application/json',
    'Authorization: ApiKey ' . $apiKey,
  ],
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_TIMEOUT => 20,
]);

$response = curl_exec($curl);
$curlError = curl_error($curl);
$status = curl_getinfo($curl, CURLINFO_HTTP_CODE);
curl_close($curl);

if ($response === false || $curlError) {
  throw new RuntimeException('Error de conexión con FaceCore: ' . $curlError);
}

$result = json_decode($response, true);
if (!is_array($result)) {
  throw new RuntimeException('FaceCore devolvió una respuesta no válida.');
}

$distance = isset($result['distancia_euclidiana']) && is_numeric($result['distancia_euclidiana'])
  ? (float) $result['distancia_euclidiana']
  : null;
$maxDistance = (float) (getenv('FACECORE_MAX_DISTANCE') ?: '0.60');
$reliable = $distance !== null && is_finite($distance) && $distance < $maxDistance;

if ($status >= 400 || ($result['encontrado'] ?? false) !== true || ($result['ambigua'] ?? false) === true || !$reliable || empty($result['usuario_id'])) {
  echo $result['mensaje'] ?? $result['error'] ?? 'No se encontró un rostro suficientemente similar.';
  exit;
}

echo (int) $result['usuario_id'];
```

Variables necesarias:

```bash
FACECORE_API_URL=https://facecoreapi.com
FACECORE_API_KEY=face_...
FACECORE_MAX_DISTANCE=0.60
```

`FACECORE_API_URL` debe apuntar al despliegue que contiene la versión actual del servidor. Si se usa un dominio remoto, reinicia y despliega allí los cambios; modificar el `server.js` local no actualiza ese dominio.

Los archivos `api/php/api_registrar.php` y `api/php/api_identificar.php` son wrappers PHP que reciben el JSON y reenvían la petición a Node mediante `Authorization: ApiKey ...`. No dependen de una sesión PHP; configuran la key con `FACECORE_API_KEY` en el entorno del servidor. Nunca escribas la API key directamente en el código fuente; usa `FACECORE_API_KEY` y revoca cualquier key que haya quedado expuesta.

---

## 6) Ejemplo con curl

### Registrar:

```bash
curl -X POST https://facecoreapi.com/api/rostros/registrar \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey face_1234567890abcdef" \
  -d '{
    "usuario_id": 42,
    "embedding": [0.1, 0.2, 0.3, 0.4, 0.5]
  }'
```

### Identificar:

```bash
curl -X POST https://facecoreapi.com/api/rostros/identificar \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey face_1234567890abcdef" \
  -d '{
    "embedding": [0.1, 0.2, 0.3, 0.4, 0.5]
  }'
```

> Recuerda que el embedding real debe tener 128 valores, no solo 5.

---

## 7) Recomendaciones de uso en producción

- Nunca compartas la API key entre clientes distintos
- Cada cliente debe tener su propia key
- Revoca keys si un cliente deja de ser confiable
- Revisa los logs de auditoría en la consola admin
- Usa HTTPS en producción
- Guarda las keys en variables de entorno o en un gestor de secretos

---

## 8) Consola administrativa

La consola admin te permite:

- crear clientes
- ver clientes activos/inactivos
- crear API keys
- establecer permisos
- revocar keys
- consultar auditoría
- crear y desactivar usuarios administradores

URL:

```text
https://facecoreapi.com/admin
```

Administrador inicial:

```text
Configura ADMIN_EMAIL, ADMIN_PASSWORD y ADMIN_NAME en .env antes de iniciar el servidor.
```

Una vez dentro de la consola puedes crear más cuentas desde la sección "Administradores". Las contraseñas se guardan como hash con salt y cada cuenta puede activarse o desactivarse.

### Segundo factor y dispositivos nuevos

El inicio administrativo usa contraseña como primer factor. Cuando se detecta un dispositivo nuevo, se puede completar el acceso de una de estas formas:

- Verificación facial con la cámara, si el administrador tiene un rostro registrado.
- Aprobación manual desde otro dispositivo ya autorizado.

El dispositivo autorizado se identifica con un identificador local almacenado en el navegador. Las solicitudes manuales expiran y solo pueden consumirse una vez. El rostro no reemplaza la contraseña.

La consola también permite consultar si el segundo factor biométrico está registrado, actualizarlo o eliminarlo. Al eliminarlo se revocan los dispositivos confiables del administrador.

La verificación facial administrativa usa el mismo umbral conservador configurado en `FACE_MATCH_DISTANCE_THRESHOLD` y registra la distancia de cada intento en la auditoría.

---

## 9) Códigos de estado HTTP

| Código | Significado |
|---|---|
| 200 | Petición procesada correctamente |
| 201 | Registro creado correctamente |
| 400 | Datos inválidos |
| 401 | API key no válida / sesión inválida |
| 403 | Permiso no autorizado |
| 500 | Error interno del servidor |

---

Si necesitas, puedo dejarte también una versión en formato Markdown más elegante para README o una guía de Postman/Insomnia.
