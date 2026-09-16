<?php
session_start();

header('Content-Type: application/json');

$demoMode = isset($_GET['demo']) && $_GET['demo'] === '1';
$allowDemo = $demoMode || (!empty($_SERVER['HTTP_X_DEMO_SESSION']) && $_SERVER['HTTP_X_DEMO_SESSION'] === '1');

if (!isset($_SESSION['usuario_id']) && !$allowDemo) {
    http_response_code(401);
    echo json_encode([
        'ok' => false,
        'error' => 'Sesión inválida o no autenticada. Abre login_demo.php?usuario_id=1 antes de usar la captura.'
    ]);
    exit;
}

$rawInput = file_get_contents('php://input');
$data = json_decode($rawInput, true);

if (!is_array($data) || !isset($data['usuario_id']) || (!isset($data['embedding']) && !isset($data['embeddings']))) {
    http_response_code(400);
    echo json_encode([
        'ok' => false,
        'error' => 'Faltan usuario_id o embedding.'
    ]);
    exit;
}

$usuarioId = (int) $data['usuario_id'];
$embeddings = isset($data['embeddings']) ? $data['embeddings'] : [$data['embedding']];

if (!is_array($embeddings) || count($embeddings) < 1 || count($embeddings) > 10) {
    http_response_code(400);
    echo json_encode([
        'ok' => false,
        'error' => 'Se requiere entre 1 y 10 embeddings.'
    ]);
    exit;
}

foreach ($embeddings as $embedding) {
    if (!is_array($embedding) || count($embedding) !== 128) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Cada embedding debe contener 128 posiciones.']);
        exit;
    }
}

$payload = json_encode([
    'usuario_id' => $usuarioId,
    'embeddings' => $embeddings
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

$ch = curl_init("http://{$node_host}:3000/api/rostros/registrar");
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

http_response_code($httpCode);

echo $response;
