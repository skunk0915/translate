<?php
/**
 * Transrate ユーザー認証 API
 * ID/パスワード認証を行い、セッショントークンを発行・検証する。
 *
 * エンドポイント: POST /api/auth.php
 * アクション: login, check, logout
 */
declare(strict_types=1);
date_default_timezone_set('Asia/Tokyo');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const ENV_FILE_DEFAULT = '/etc/transrate/.env';
const DATA_DIR_DEFAULT = '/var/lib/transrate';
const LOG_DIR_DEFAULT = '/var/log/transrate';
const ALLOWED_HOSTS = ['translate.flow-t.net', 'translate.133.18.144.38.sslip.io', 'localhost:5174', 'localhost:4173', 'localhost:4174', 'localhost:5173'];
const TOKEN_LIFETIME = 365 * 86400; // 1年間有効

function dataDir(): string
{
    $dir = getenv('TRANSRATE_DATA_DIR');
    if (!$dir) {
        $dir = is_dir(DATA_DIR_DEFAULT) || @mkdir(DATA_DIR_DEFAULT, 0750, true)
            ? DATA_DIR_DEFAULT
            : __DIR__ . '/../../data';
    }
    if (!is_dir($dir)) {
        @mkdir($dir, 0750, true);
    }
    return $dir;
}

function logDir(): string
{
    $dir = getenv('TRANSRATE_LOG_DIR') ?: LOG_DIR_DEFAULT;
    if (!is_dir($dir)) {
        @mkdir($dir, 0750, true);
    }
    return $dir;
}

function logLine(string $level, string $msg, array $data = []): void
{
    $file = logDir() . '/api.log';
    $line = sprintf("[%s] %s auth.php %s %s\n", date('Y-m-d H:i:s'), strtoupper($level), $msg, $data ? json_encode($data, JSON_UNESCAPED_UNICODE) : '');
    @file_put_contents($file, $line, FILE_APPEND | LOCK_EX);
}

function fail(int $status, string $message, array $data = []): never
{
    http_response_code($status);
    logLine('warn', $message, $data);
    echo json_encode(['ok' => false, 'error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function loadEnv(): array
{
    $path = getenv('TRANSRATE_ENV_FILE') ?: ENV_FILE_DEFAULT;
    if (!is_readable($path)) {
        // ローカル開発用
        $local = __DIR__ . '/../../.env';
        if (is_readable($local)) $path = $local;
        else fail(500, '設定ファイルが読み込めません');
    }
    $env = [];
    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) continue;
        [$k, $v] = explode('=', $line, 2);
        $env[trim($k)] = trim(trim($v), "\"'");
    }
    return $env;
}

function getDb(): PDO
{
    static $pdo = null;
    if ($pdo !== null) return $pdo;
    $dbPath = dataDir() . '/history.db';
    $pdo = new PDO('sqlite:' . $dbPath, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_TIMEOUT => 5,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL;');
    $pdo->exec('
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token);
    ');
    return $pdo;
}

// 送信元チェック
if (php_sapi_name() !== 'cli') {
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
}

$raw = file_get_contents('php://input');
if ($raw === false || $raw === '') {
    if (php_sapi_name() === 'cli') $raw = file_get_contents('php://stdin');
}
$req = json_decode((string) $raw, true) ?? [];
$action = (string) ($req['action'] ?? 'check');

$db = getDb();
$env = loadEnv();
$expectedUser = $env['AUTH_USERNAME'] ?? 'mizy';
$expectedPass = $env['AUTH_PASSWORD'] ?? 'mizy';

// トークン取得関数（Cookie、ヘッダー、ボディ）
function extractToken(array $req): ?string
{
    if (!empty($_COOKIE['transrate_auth'])) return (string) $_COOKIE['transrate_auth'];
    if (!empty($req['token'])) return (string) $req['token'];
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (str_starts_with($auth, 'Bearer ')) return substr($auth, 7);
    return null;
}

if ($action === 'login') {
    $username = trim((string) ($req['username'] ?? ''));
    $password = (string) ($req['password'] ?? '');

    if ($username === '' || $password === '') {
        fail(400, 'IDとパスワードを入力してください');
    }

    if ($username !== $expectedUser || $password !== $expectedPass) {
        logLine('warn', 'ログイン失敗', ['user' => $username]);
        fail(401, 'IDまたはパスワードが正しくありません');
    }

    // 成功: トークン発行
    $token = bin2hex(random_bytes(32));
    $expiresAt = time() + TOKEN_LIFETIME;

    $stmt = $db->prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (:t, :u, :e)');
    $stmt->execute([':t' => $token, ':u' => $expectedUser, ':e' => $expiresAt]);

    // 長期Cookie (1年) を発行 (HttpOnly, Secure, SameSite=Lax)
    $isHttps = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['SERVER_PORT'] ?? 80) == 443;
    setcookie('transrate_auth', $token, [
        'expires' => $expiresAt,
        'path' => '/',
        'domain' => '',
        'secure' => $isHttps,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);

    logLine('info', 'ログイン成功', ['user' => $expectedUser]);
    echo json_encode(['ok' => true, 'user' => $expectedUser, 'token' => $token], JSON_UNESCAPED_UNICODE);
    exit;
} elseif ($action === 'check') {
    $token = extractToken($req);
    if (!$token) {
        echo json_encode(['ok' => false], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $stmt = $db->prepare('SELECT user_id, expires_at FROM sessions WHERE token = :t LIMIT 1');
    $stmt->execute([':t' => $token]);
    $row = $stmt->fetch();

    if ($row && $row['expires_at'] > time()) {
        echo json_encode(['ok' => true, 'user' => $row['user_id'], 'token' => $token], JSON_UNESCAPED_UNICODE);
        exit;
    }

    echo json_encode(['ok' => false], JSON_UNESCAPED_UNICODE);
    exit;
} elseif ($action === 'logout') {
    $token = extractToken($req);
    if ($token) {
        $stmt = $db->prepare('DELETE FROM sessions WHERE token = :t');
        $stmt->execute([':t' => $token]);
    }
    setcookie('transrate_auth', '', [
        'expires' => time() - 3600,
        'path' => '/',
        'domain' => '',
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    logLine('info', 'ログアウト');
    echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
    exit;
} else {
    fail(400, '不正なアクションです');
}
