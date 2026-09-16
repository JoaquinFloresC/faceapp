<?php
header('Content-Type: application/json');

$rawInput = file_get_contents('php://input');
$data = json_decode($rawInput, true);

if (!is_array($data) || !isset($data['embedding'])) {
    http_response_code(400);
    echo json_encode([
        'ok' => false,
        'error' => 'Falta el embedding.'
    ]);
    exit;
}

$embedding = $data['embedding'];

if (!is_array($embedding) || count($embedding) !== 128) {
    http_response_code(400);
    echo json_encode([
        'ok' => false,
        'error' => 'El embedding debe contener 128 posiciones.'
    ]);
    exit;
}

$payload = json_encode([
    'embedding' => $embedding
]);

$node_host = getenv('NODE_HOST') ?: 'host.docker.internal';
$apiKey = getenv('FACECORE_API_KEY');
if (!$apiKey) {
    http_response_code(500);
    echo json_encode([
        'ok' => false,
        'error' => 'FACECORE_API_KEY no está configurada en el servidor PHP.'
    ]);
    exit;
}

$ch = curl_init("http://{$node_host}:3000/api/rostros/identificar");
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Content-Type: application/json',
    'Accept: application/json',
    'Authorization: ApiKey ' . $apiKey
]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 20);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

if ($response === false) {
    $error = curl_error($ch);
    curl_close($ch);
    http_response_code(502);
    echo json_encode([
        'ok' => false,
        'error' => 'Fallo de comunicación con el microservicio: ' . $error
    ]);
    exit;
}

curl_close($ch);

$body = json_decode($response, true);

if ($httpCode >= 400 || !is_array($body)) {
    http_response_code($httpCode ?: 500);
    echo $response;
    exit;
}

if (!empty($body['encontrado']) && $body['encontrado'] === true) {
    $usuarioId = isset($body['usuario_id']) ? (int) $body['usuario_id'] : null;
    $asistencia = [
        'usuario_id' => $usuarioId,
        'fecha' => date('Y-m-d H:i:s'),
        'origen' => 'face_recognition',
        'mensaje' => 'Asistencia marcada correctamente.'
    ];

    // Aquí normalmente se registra en tu sistema real.
    // Este punto es un placeholder de integración con tu backend legado.
    http_response_code(200);
    echo json_encode([
        'ok' => true,
        'encontrado' => true,
        'mensaje' => 'Asistencia marcada correctamente.',
        'usuario_id' => $usuarioId,
        'asistencia' => $asistencia
    ]);
    exit;
}

http_response_code(200);
echo json_encode([
    'ok' => false,
    'encontrado' => false,
    'mensaje' => $body['mensaje'] ?? 'No se pudo marcar la asistencia.'
]);
