<?php
/**
 * Transrate 履歴 API
 * 認証ユーザー(user_id)ごとに SQLite データベースへ履歴を永続保存する。
 *
 * エンドポイント: POST /api/history.php
 * アクション: list, add, update, remove, clear, sync
 */
declare(strict_types=1);
date_default_timezone_set('Asia/Tokyo');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const DATA_DIR_DEFAULT = '/var/lib/transrate';
const LOG_DIR_DEFAULT = '/var/log/transrate';
const MAX_BODY_BYTES = 1024 * 1024; // 1MB
const MAX_ENTRIES = 500;
const ALLOWED_HOSTS = ['translate.flow-t.net', 'translate.133.18.144.38.sslip.io', 'localhost:5174', 'localhost:4173', 'localhost:4174', 'localhost:5173'];

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

function logError(string $msg, array $data = []): void
{
    $line = sprintf("[%s] ERROR history.php %s %s\n", date('Y-m-d H:i:s'), $msg, $data ? json_encode($data, JSON_UNESCAPED_UNICODE) : '');
    @file_put_contents(logDir() . '/api.log', $line, FILE_APPEND | LOCK_EX);
}

function fail(int $status, string $message, array $data = []): never
{
    http_response_code($status);
    logError($message, $data);
    echo json_encode(['ok' => false, 'error' => $message, 'code' => $data['code'] ?? 'ERROR'], JSON_UNESCAPED_UNICODE);
    exit;
}

function getDb(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }
    $dbPath = dataDir() . '/history.db';
    try {
        $pdo = new PDO('sqlite:' . $dbPath, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_TIMEOUT => 5,
        ]);
        $pdo->exec('PRAGMA journal_mode = WAL;');
        $pdo->exec('PRAGMA synchronous = NORMAL;');
        $pdo->exec('
            CREATE TABLE IF NOT EXISTS history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL DEFAULT "",
                device_id TEXT NOT NULL,
                ts INTEGER NOT NULL,
                src_lang TEXT NOT NULL,
                dst_lang TEXT NOT NULL,
                src_text TEXT NOT NULL,
                dst_text TEXT NOT NULL,
                detect_ms INTEGER,
                transcribe_ms INTEGER,
                translate_ms INTEGER,
                source TEXT NOT NULL DEFAULT "audio",
                mode TEXT NOT NULL DEFAULT "online",
                extra_translations TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token);
        ');

        // マイグレーション: user_id カラムが存在しない場合は追加し、既存データを 'mizy' に統合
        $cols = $pdo->query("PRAGMA table_info(history)")->fetchAll(PDO::FETCH_ASSOC);
        $hasUserId = false;
        foreach ($cols as $c) {
            if (($c['name'] ?? '') === 'user_id') {
                $hasUserId = true;
                break;
            }
        }
        if (!$hasUserId) {
            $pdo->exec('ALTER TABLE history ADD COLUMN user_id TEXT NOT NULL DEFAULT "";');
            $pdo->exec("UPDATE history SET user_id = 'mizy' WHERE user_id = '' OR user_id IS NULL;");
        }
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_history_user_ts ON history (user_id, ts DESC);');
    } catch (Throwable $e) {
        fail(500, 'データベース接続に失敗しました: ' . $e->getMessage());
    }
    return $pdo;
}

function getAuthenticatedUser(PDO $db, array $req): ?string
{
    $token = null;
    if (!empty($_COOKIE['transrate_auth'])) {
        $token = (string) $_COOKIE['transrate_auth'];
    } elseif (!empty($req['token'])) {
        $token = (string) $req['token'];
    } else {
        $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
        if (str_starts_with($auth, 'Bearer ')) {
            $token = substr($auth, 7);
        }
    }
    if (!$token) {
        return null;
    }
    try {
        $stmt = $db->prepare('SELECT user_id, expires_at FROM sessions WHERE token = :t LIMIT 1');
        $stmt->execute([':t' => $token]);
        $row = $stmt->fetch();
        if ($row && (int) $row['expires_at'] > time()) {
            return (string) $row['user_id'];
        }
    } catch (Throwable $e) {
        return null;
    }
    return null;
}

// 送信元チェック
if (php_sapi_name() !== 'cli') {
    $originHeader = $_SERVER['HTTP_ORIGIN'] ?? $_SERVER['HTTP_REFERER'] ?? '';
    $originHost = $originHeader ? (parse_url($originHeader, PHP_URL_HOST) ?? '') : '';
    $originPort = $originHeader ? parse_url($originHeader, PHP_URL_PORT) : null;
    $originKey = $originPort ? "{$originHost}:{$originPort}" : $originHost;
    if (!in_array($originKey, ALLOWED_HOSTS, true)) {
        fail(403, '許可されていない送信元です', ['origin' => $originHeader]);
    }
}

$raw = file_get_contents('php://input');
if (($raw === false || $raw === '') && php_sapi_name() === 'cli') {
    $raw = file_get_contents('php://stdin');
}
if ($raw === false || strlen($raw) > MAX_BODY_BYTES) {
    fail(413, 'リクエストが大きすぎます');
}
$req = json_decode($raw, true);
if (!is_array($req)) {
    fail(400, 'JSON を解釈できません');
}

$db = getDb();
$userId = getAuthenticatedUser($db, $req);
if (!$userId) {
    fail(401, 'ログインが必要です', ['code' => 'UNAUTHORIZED']);
}

$device = trim((string) ($req['device'] ?? ''));
if ($device !== '') {
    $uuidPattern = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
    if (!preg_match($uuidPattern, $device)) {
        $device = '';
    }
}

$action = (string) ($req['action'] ?? 'list');

switch ($action) {
    case 'list':
        $limit = min(500, max(1, (int) ($req['limit'] ?? 200)));
        $stmt = $db->prepare('SELECT * FROM history WHERE user_id = :user ORDER BY ts DESC LIMIT :limit');
        $stmt->bindValue(':user', $userId, PDO::PARAM_STR);
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll();
        $list = [];
        foreach ($rows as $row) {
            $extras = null;
            if (!empty($row['extra_translations'])) {
                $extras = json_decode($row['extra_translations'], true);
            }
            $list[] = [
                'id' => (int) $row['id'],
                'ts' => (int) $row['ts'],
                'srcLang' => $row['src_lang'],
                'dstLang' => $row['dst_lang'],
                'srcText' => $row['src_text'],
                'dstText' => $row['dst_text'],
                'detectMs' => $row['detect_ms'] !== null ? (int) $row['detect_ms'] : null,
                'transcribeMs' => $row['transcribe_ms'] !== null ? (int) $row['transcribe_ms'] : null,
                'translateMs' => $row['translate_ms'] !== null ? (int) $row['translate_ms'] : null,
                'source' => $row['source'],
                'mode' => $row['mode'],
                'extraTranslations' => is_array($extras) ? $extras : [],
            ];
        }
        echo json_encode(['ok' => true, 'entries' => $list], JSON_UNESCAPED_UNICODE);
        break;

    case 'add':
        $entry = $req['entry'] ?? null;
        if (!is_array($entry)) {
            fail(400, 'entry が必要です');
        }
        $ts = is_numeric($entry['ts'] ?? null) ? (int) $entry['ts'] : (int) (microtime(true) * 1000);
        $srcLang = (string) ($entry['srcLang'] ?? '');
        $dstLang = (string) ($entry['dstLang'] ?? '');
        $srcText = (string) ($entry['srcText'] ?? '');
        $dstText = (string) ($entry['dstText'] ?? '');
        $detectMs = isset($entry['detectMs']) && is_numeric($entry['detectMs']) ? (int) $entry['detectMs'] : null;
        $transcribeMs = isset($entry['transcribeMs']) && is_numeric($entry['transcribeMs']) ? (int) $entry['transcribeMs'] : null;
        $translateMs = isset($entry['translateMs']) && is_numeric($entry['translateMs']) ? (int) $entry['translateMs'] : null;
        $source = (string) ($entry['source'] ?? 'audio');
        $mode = (string) ($entry['mode'] ?? 'online');
        $extraJson = !empty($entry['extraTranslations']) && is_array($entry['extraTranslations'])
            ? json_encode($entry['extraTranslations'], JSON_UNESCAPED_UNICODE)
            : null;

        $stmt = $db->prepare('
            INSERT INTO history (user_id, device_id, ts, src_lang, dst_lang, src_text, dst_text, detect_ms, transcribe_ms, translate_ms, source, mode, extra_translations)
            VALUES (:user, :device, :ts, :src_lang, :dst_lang, :src_text, :dst_text, :detect_ms, :transcribe_ms, :translate_ms, :source, :mode, :extra)
        ');
        $stmt->execute([
            ':user' => $userId,
            ':device' => $device,
            ':ts' => $ts,
            ':src_lang' => $srcLang,
            ':dst_lang' => $dstLang,
            ':src_text' => $srcText,
            ':dst_text' => $dstText,
            ':detect_ms' => $detectMs,
            ':transcribe_ms' => $transcribeMs,
            ':translate_ms' => $translateMs,
            ':source' => $source,
            ':mode' => $mode,
            ':extra' => $extraJson,
        ]);
        $newId = (int) $db->lastInsertId();
        echo json_encode(['ok' => true, 'id' => $newId], JSON_UNESCAPED_UNICODE);
        break;

    case 'update':
        $entry = $req['entry'] ?? null;
        if (!is_array($entry) || empty($entry['id'])) {
            fail(400, '有効な entry と id が必要です');
        }
        $id = (int) $entry['id'];
        $srcText = (string) ($entry['srcText'] ?? '');
        $dstText = (string) ($entry['dstText'] ?? '');
        $ts = is_numeric($entry['ts'] ?? null) ? (int) $entry['ts'] : (int) (microtime(true) * 1000);
        $extraJson = !empty($entry['extraTranslations']) && is_array($entry['extraTranslations'])
            ? json_encode($entry['extraTranslations'], JSON_UNESCAPED_UNICODE)
            : null;

        $stmt = $db->prepare('
            UPDATE history
            SET src_text = :src_text, dst_text = :dst_text, extra_translations = :extra, ts = :ts, updated_at = datetime("now", "localtime")
            WHERE id = :id AND user_id = :user
        ');
        $stmt->execute([
            ':id' => $id,
            ':user' => $userId,
            ':src_text' => $srcText,
            ':dst_text' => $dstText,
            ':extra' => $extraJson,
            ':ts' => $ts,
        ]);
        echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
        break;

    case 'remove':
    case 'delete':
        $id = (int) ($req['id'] ?? 0);
        if ($id <= 0) {
            fail(400, 'id が不正です');
        }
        $stmt = $db->prepare('DELETE FROM history WHERE id = :id AND user_id = :user');
        $stmt->execute([':id' => $id, ':user' => $userId]);
        echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
        break;

    case 'clear':
        $stmt = $db->prepare('DELETE FROM history WHERE user_id = :user');
        $stmt->execute([':user' => $userId]);
        echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
        break;

    case 'sync':
        $clientEntries = $req['entries'] ?? [];
        if (!is_array($clientEntries)) {
            fail(400, 'entries が配列ではありません');
        }
        if (!empty($clientEntries)) {
            $db->beginTransaction();
            try {
                $insertStmt = $db->prepare('
                    INSERT INTO history (user_id, device_id, ts, src_lang, dst_lang, src_text, dst_text, detect_ms, transcribe_ms, translate_ms, source, mode, extra_translations)
                    VALUES (:user, :device, :ts, :src_lang, :dst_lang, :src_text, :dst_text, :detect_ms, :transcribe_ms, :translate_ms, :source, :mode, :extra)
                ');
                foreach ($clientEntries as $e) {
                    if (!is_array($e)) continue;
                    $ts = is_numeric($e['ts'] ?? null) ? (int) $e['ts'] : (int) (microtime(true) * 1000);
                    $check = $db->prepare('SELECT id FROM history WHERE user_id = :user AND ts = :ts AND src_text = :src_text LIMIT 1');
                    $check->execute([':user' => $userId, ':ts' => $ts, ':src_text' => (string) ($e['srcText'] ?? '')]);
                    if ($check->fetch()) {
                        continue;
                    }
                    $extraJson = !empty($e['extraTranslations']) && is_array($e['extraTranslations'])
                        ? json_encode($e['extraTranslations'], JSON_UNESCAPED_UNICODE)
                        : null;
                    $insertStmt->execute([
                        ':user' => $userId,
                        ':device' => $device,
                        ':ts' => $ts,
                        ':src_lang' => (string) ($e['srcLang'] ?? ''),
                        ':dst_lang' => (string) ($e['dstLang'] ?? ''),
                        ':src_text' => (string) ($e['srcText'] ?? ''),
                        ':dst_text' => (string) ($e['dstText'] ?? ''),
                        ':detect_ms' => isset($e['detectMs']) ? (int) $e['detectMs'] : null,
                        ':transcribe_ms' => isset($e['transcribeMs']) ? (int) $e['transcribeMs'] : null,
                        ':translate_ms' => isset($e['translateMs']) ? (int) $e['translateMs'] : null,
                        ':source' => (string) ($e['source'] ?? 'audio'),
                        ':mode' => (string) ($e['mode'] ?? 'online'),
                        ':extra' => $extraJson,
                    ]);
                }
                $db->commit();
            } catch (Throwable $e) {
                $db->rollBack();
                fail(500, '一括同期に失敗しました: ' . $e->getMessage());
            }
        }
        $stmt = $db->prepare('SELECT * FROM history WHERE user_id = :user ORDER BY ts DESC LIMIT 200');
        $stmt->execute([':user' => $userId]);
        $rows = $stmt->fetchAll();
        $list = [];
        foreach ($rows as $row) {
            $extras = null;
            if (!empty($row['extra_translations'])) {
                $extras = json_decode($row['extra_translations'], true);
            }
            $list[] = [
                'id' => (int) $row['id'],
                'ts' => (int) $row['ts'],
                'srcLang' => $row['src_lang'],
                'dstLang' => $row['dst_lang'],
                'srcText' => $row['src_text'],
                'dstText' => $row['dst_text'],
                'detectMs' => $row['detect_ms'] !== null ? (int) $row['detect_ms'] : null,
                'transcribeMs' => $row['transcribe_ms'] !== null ? (int) $row['transcribe_ms'] : null,
                'translateMs' => $row['translate_ms'] !== null ? (int) $row['translate_ms'] : null,
                'source' => $row['source'],
                'mode' => $row['mode'],
                'extraTranslations' => is_array($extras) ? $extras : [],
            ];
        }
        echo json_encode(['ok' => true, 'entries' => $list], JSON_UNESCAPED_UNICODE);
        break;

    default:
        fail(400, '未知の action です: ' . $action);
}
