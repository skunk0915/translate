<?php
/**
 * Transrate 端末ログの受信口。
 * ブラウザ(src/remote-log.js)が IndexedDB に溜めた処理ログをまとめて送ってくるので、
 * 1件1行で client.log に追記する。開発者は scripts/client-logs.sh でサーバー上のログを読む。
 *
 * リクエスト(JSON, POST):
 *   { "device": "<uuid>", "session": "<uuid>", "version": "1.0.0", "standalone": true,
 *     "entries": [ { "id": 1, "ts": 1789500000000, "level": "info", "msg": "起動", "data": {...} }, ... ] }
 * レスポンス: 204(本文なし) / エラー時 { "error": "..." } と 4xx
 */
declare(strict_types=1);
date_default_timezone_set('Asia/Tokyo');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const LOG_DIR_DEFAULT = '/var/log/transrate';
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB を超えたら1世代ローテーション
const MAX_BODY_BYTES = 512 * 1024;
const MAX_ENTRIES = 200;
const MAX_MSG_CHARS = 200;
const MAX_DATA_BYTES = 4000;
const ALLOWED_HOSTS = ['translate.flow-t.net', 'translate.133.18.144.38.sslip.io', 'localhost:5174', 'localhost:4173', 'localhost:4174', 'localhost:5173'];
const LEVELS = ['info', 'warn', 'error'];

function logDir(): string
{
    $dir = getenv('TRANSRATE_LOG_DIR') ?: LOG_DIR_DEFAULT;
    if (!is_dir($dir)) {
        @mkdir($dir, 0750, true);
    }
    return $dir;
}

function appendRotating(string $file, string $text): void
{
    if (is_file($file) && filesize($file) > LOG_MAX_BYTES) {
        @rename($file, $file . '.1');
    }
    @file_put_contents($file, $text, FILE_APPEND | LOCK_EX);
}

// 受信口自体の異常は api.log に残す(client.log は端末ログ専用)
function fail(int $status, string $message, array $data = []): never
{
    http_response_code($status);
    $line = sprintf("[%s] %s log.php %s %s\n", date('Y-m-d H:i:s'), $status >= 500 ? 'ERROR' : 'WARN', $message, $data ? json_encode($data, JSON_UNESCAPED_UNICODE) : '');
    appendRotating(logDir() . '/api.log', $line);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    fail(405, 'POST のみ受け付けます');
}
$originHeader = $_SERVER['HTTP_ORIGIN'] ?? $_SERVER['HTTP_REFERER'] ?? '';
$originHost = $originHeader ? (parse_url($originHeader, PHP_URL_HOST) ?? '') : '';
$originPort = $originHeader ? parse_url($originHeader, PHP_URL_PORT) : null;
$originKey = $originPort ? "{$originHost}:{$originPort}" : $originHost;
if (!in_array($originKey, ALLOWED_HOSTS, true)) {
    fail(403, '許可されていない送信元です', ['origin' => $originHeader]);
}

$raw = file_get_contents('php://input');
if ($raw === false || strlen($raw) > MAX_BODY_BYTES) {
    fail(413, 'リクエストが大きすぎます');
}
$req = json_decode($raw, true);
if (!is_array($req)) {
    fail(400, 'JSON を解釈できません');
}

$uuid = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/';
$device = (string) ($req['device'] ?? '');
$session = (string) ($req['session'] ?? '');
if (!preg_match($uuid, $device) || !preg_match($uuid, $session)) {
    fail(400, 'device / session が不正です');
}
$version = substr(preg_replace('/[^0-9A-Za-z.\-]/', '', (string) ($req['version'] ?? '')), 0, 32);
$standalone = !empty($req['standalone']) ? 'app' : 'browser';
$entries = $req['entries'] ?? null;
if (!is_array($entries) || count($entries) === 0 || count($entries) > MAX_ENTRIES) {
    fail(400, 'entries が不正です');
}

$out = '';
foreach ($entries as $e) {
    if (!is_array($e)) {
        continue;
    }
    $level = in_array($e['level'] ?? '', LEVELS, true) ? $e['level'] : 'info';
    $ts = is_numeric($e['ts'] ?? null) ? (int) $e['ts'] : 0;
    $msg = mb_substr(str_replace(["\r", "\n"], ' ', (string) ($e['msg'] ?? '')), 0, MAX_MSG_CHARS);
    $data = array_key_exists('data', $e) ? json_encode($e['data'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : '';
    if ($data !== '' && strlen((string) $data) > MAX_DATA_BYTES) {
        $data = substr((string) $data, 0, MAX_DATA_BYTES) . '…(truncated)';
    }
    $out .= sprintf(
        "[%s] dev=%s ses=%s v%s %s #%d %s %s %s\n",
        $ts ? date('Y-m-d H:i:s', intdiv($ts, 1000)) : '-',
        substr($device, 0, 8),
        substr($session, 0, 8),
        $version,
        $standalone,
        (int) ($e['id'] ?? 0),
        strtoupper($level),
        $msg,
        $data
    );
}
appendRotating(logDir() . '/client.log', $out);
http_response_code(204);
