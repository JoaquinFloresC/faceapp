<?php
session_start();

$usuarioId = filter_input(INPUT_GET, 'usuario_id', FILTER_VALIDATE_INT);
if ($usuarioId === false || $usuarioId === null) {
    $usuarioId = 1;
}

$_SESSION['usuario_id'] = $usuarioId;

header('Location: index.html');
exit;
