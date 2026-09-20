<?php
/**
 * Transrate オンラインモード用プロキシ。
 * ブラウザから音声(WAV)またはテキストを受け取り、サーバー側で Gemini API を呼び出す。
 * API キーは環境ファイル(既定: /etc/transrate/.env)にのみ置き、クライアントへは一切返さない。
 *
 * リクエスト(JSON, POST):
 *   { "audio": "<base64 wav>", "langs": ["ja","th"] }            … 言語判定 + 文字起こし + 翻訳
 *   { "text": "...", "src": "ja", "dst": "th" }                    … テキスト翻訳
 * レスポンス(JSON):
 *   { "lang": "ja", "transcript": "...", "translation": "..." } / { "translation": "..." }
 *   エラー時: { "error": "..." } と 4xx/5xx
 */
declare(strict_types=1);
date_default_timezone_set('Asia/Tokyo');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const ENV_FILE_DEFAULT = '/etc/transrate/.env';
const LOG_DIR_DEFAULT = '/var/log/transrate';
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB を超えたら1世代ローテーション
const MAX_AUDIO_BASE64 = 3 * 1024 * 1024; // 約2.2MB の WAV(16kHz 16bit で約70秒)
const MAX_TEXT_CHARS = 2000;
const ALLOWED_HOSTS = ['translate.flow-t.net', 'translate.133.18.144.38.sslip.io', 'localhost:5174', 'localhost:4173', 'localhost:5173'];

const LANG_NAMES = [
    'ja' => 'Japanese', 'en' => 'English', 'zh-TW' => 'Traditional Chinese (Taiwan)', 'zh' => 'Simplified Chinese',
    'vi' => 'Vietnamese', 'th' => 'Thai', 'ko' => 'Korean', 'fr' => 'French', 'de' => 'German', 'es' => 'Spanish',
    'it' => 'Italian', 'id' => 'Indonesian', 'ru' => 'Russian', 'hi' => 'Hindi', 'ar' => 'Arabic', 'nl' => 'Dutch',
    'sv' => 'Swedish', 'fi' => 'Finnish', 'uk' => 'Ukrainian', 'cs' => 'Czech', 'da' => 'Danish',
];

function logLine(string $level, string $msg, array $data = []): void
{
    $dir = getenv('TRANSRATE_LOG_DIR') ?: LOG_DIR_DEFAULT;
    if (!is_dir($dir)) {
        @mkdir($dir, 0750, true);
    }
    $file = $dir . '/api.log';
    if (is_file($file) && filesize($file) > LOG_MAX_BYTES) {
        @rename($file, $file . '.1');
    }
    $line = sprintf("[%s] %s %s %s\n", date('Y-m-d H:i:s'), strtoupper($level), $msg, $data ? json_encode($data, JSON_UNESCAPED_UNICODE) : '');
    @file_put_contents($file, $line, FILE_APPEND | LOCK_EX);
}

function fail(int $status, string $message, array $data = []): never
{
    http_response_code($status);
    logLine($status >= 500 ? 'error' : 'warn', $message, $data);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function loadEnv(): array
{
    $path = getenv('TRANSRATE_ENV_FILE') ?: ENV_FILE_DEFAULT;
    if (!is_readable($path)) {
        fail(500, '設定ファイルが読み込めません', ['path' => $path]);
    }
    $env = [];
    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) {
            continue;
        }
        [$k, $v] = explode('=', $line, 2);
        $env[trim($k)] = trim(trim($v), "\"'");
    }
    foreach (['GEMINI_API_KEY', 'GEMINI_MODEL'] as $k) {
        if (empty($env[$k])) {
            fail(500, "設定 {$k} が未定義です");
        }
    }
    return $env;
}

// ---- 入口チェック ----
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
if (($raw === false || $raw === '') && php_sapi_name() === 'cli') {
    $raw = file_get_contents('php://stdin');
}
if ($raw === false || strlen($raw) > MAX_AUDIO_BASE64 + 4096) {
    fail(413, 'リクエストが大きすぎます');
}
$req = json_decode($raw, true);
if (!is_array($req)) {
    fail(400, 'JSON を解釈できません');
}

$env = loadEnv();
$model = $env['GEMINI_MODEL'];
$endpoint = "https://generativelanguage.googleapis.com/v1beta/models/{$model}:generateContent";

// ---- リクエスト組み立て ----
$parts = [];
$schema = [];
$mode = '';
if (isset($req['audio'])) {
    $mode = 'audio';
    $langs = $req['langs'] ?? null;
    if (!is_array($langs) || count($langs) !== 2 || !isset(LANG_NAMES[$langs[0]], LANG_NAMES[$langs[1]]) || $langs[0] === $langs[1]) {
        fail(400, 'langs は異なる2言語の配列で指定してください');
    }
    $audio = (string) $req['audio'];
    if ($audio === '' || strlen($audio) > MAX_AUDIO_BASE64 || !preg_match('/^[A-Za-z0-9+\/=]+$/', $audio)) {
        fail(400, 'audio が不正です');
    }
    $a = $langs[0];
    $b = $langs[1];
    $src = $req['src'] ?? null;
    if ($src !== null && $src !== '' && ($src === $a || $src === $b)) {
        $target = ($src === $a) ? $b : $a;
        $prompt = "The audio contains one utterance spoken in {$src} (" . LANG_NAMES[$src] . "). "
            . "Transcribe it accurately and clearly in {$src}'s standard script, omitting filler words, hesitation sounds, and stuttering (such as 'えーと', 'あのー', 'えー', 'その', 'um', 'uh', 'er', 'like', etc.) to make the transcript clean and concise. "
            . "Translate it naturally into {$target} (" . LANG_NAMES[$target] . "), also omitting filler words. "
            . "Keep the conversational tone and original intent. If there is no intelligible human speech, return empty strings for transcript and translation. "
            . "Return JSON only.";
        $parts[] = ['inline_data' => ['mime_type' => 'audio/wav', 'data' => $audio]];
        $parts[] = ['text' => $prompt];
        $schema = [
            'type' => 'OBJECT',
            'properties' => [
                'lang' => ['type' => 'STRING', 'enum' => [$src]],
                'transcript' => ['type' => 'STRING'],
                'translation' => ['type' => 'STRING'],
            ],
            'required' => ['lang', 'transcript', 'translation'],
        ];
    } else {
        $prompt = "The audio contains one utterance spoken in either {$a} (" . LANG_NAMES[$a] . ") or {$b} (" . LANG_NAMES[$b] . "). "
            . "Identify which language is spoken, transcribe it accurately and clearly in that language's standard script, omitting filler words, hesitation sounds, and stuttering (such as 'えーと', 'あのー', 'えー', 'その', 'um', 'uh', 'er', 'like', etc.) to make the transcript clean and concise. "
            . "Translate it naturally into the other language (if the speech is {$a}, translate into " . LANG_NAMES[$b] . "; if it is {$b}, translate into " . LANG_NAMES[$a] . "), also omitting filler words. "
            . "Keep the conversational tone and original intent. If there is no intelligible human speech, return empty strings for transcript and translation. "
            . "Return JSON only.";
        $parts[] = ['inline_data' => ['mime_type' => 'audio/wav', 'data' => $audio]];
        $parts[] = ['text' => $prompt];
        $schema = [
            'type' => 'OBJECT',
            'properties' => [
                'lang' => ['type' => 'STRING', 'enum' => [$a, $b]],
                'transcript' => ['type' => 'STRING'],
                'translation' => ['type' => 'STRING'],
            ],
            'required' => ['lang', 'transcript', 'translation'],
        ];
    }
} elseif (isset($req['text'])) {
    $mode = 'text';
    $text = trim((string) $req['text']);
    if ($text === '' || mb_strlen($text) > MAX_TEXT_CHARS) {
        fail(400, 'text が空か長すぎます');
    }
    $langs = $req['langs'] ?? null;
    $src = $req['src'] ?? '';
    $dst = $req['dst'] ?? '';

    if (is_array($langs) && count($langs) === 2 && isset(LANG_NAMES[$langs[0]], LANG_NAMES[$langs[1]]) && $langs[0] !== $langs[1]) {
        $a = $langs[0];
        $b = $langs[1];
        $prompt = "The following text is written in either {$a} (" . LANG_NAMES[$a] . ") or {$b} (" . LANG_NAMES[$b] . "). "
            . "Identify which language it is written in, and translate it naturally into the other language "
            . "(if the text is {$a}, translate into " . LANG_NAMES[$b] . "; if it is {$b}, translate into " . LANG_NAMES[$a] . "). "
            . "Keep the conversational tone. Output JSON only.\n\n" . $text;
        $parts[] = ['text' => $prompt];
        $schema = [
            'type' => 'OBJECT',
            'properties' => [
                'lang' => ['type' => 'STRING', 'enum' => [$a, $b]],
                'translation' => ['type' => 'STRING'],
            ],
            'required' => ['lang', 'translation'],
        ];
    } elseif (isset(LANG_NAMES[$src], LANG_NAMES[$dst]) && $src !== $dst) {
        $prompt = 'Translate the following ' . LANG_NAMES[$src] . ' text into ' . LANG_NAMES[$dst]
            . ". Keep the meaning and conversational tone; output only the translation as JSON.\n\n" . $text;
        $parts[] = ['text' => $prompt];
        $schema = ['type' => 'OBJECT', 'properties' => ['translation' => ['type' => 'STRING']], 'required' => ['translation']];
    } else {
        fail(400, 'langs または src / dst が不正です');
    }
} else {
    fail(400, 'audio または text が必要です');
}

$validThinkingLevels = [
    'minimal' => 'MINIMAL',
    'low' => 'LOW',
    'medium' => 'MEDIUM',
];
$reqLevel = strtolower(trim((string) ($req['thinkingLevel'] ?? $req['thinking_level'] ?? 'minimal')));
$thinkingLevel = $validThinkingLevels[$reqLevel] ?? 'MINIMAL';

$body = [
    'contents' => [['parts' => $parts]],
    'generationConfig' => [
        'temperature' => 0.2,
        'response_mime_type' => 'application/json',
        'response_schema' => $schema,
        'thinkingConfig' => ['thinkingLevel' => $thinkingLevel],
    ],
];

// ---- Gemini 呼び出し ----
$t0 = microtime(true);
$ch = curl_init($endpoint);
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 60,
    CURLOPT_IPRESOLVE => CURL_IPRESOLVE_V4,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'x-goog-api-key: ' . $env['GEMINI_API_KEY']],
    CURLOPT_POSTFIELDS => json_encode($body),
]);
$res = curl_exec($ch);
$status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
$curlErr = curl_error($ch);
curl_close($ch);
$ms = (int) round((microtime(true) - $t0) * 1000);

if ($res === false) {
    fail(502, '翻訳サービスに接続できません', ['curl' => $curlErr]);
}
$json = json_decode($res, true);
if ($status !== 200 || !is_array($json)) {
    fail(502, '翻訳サービスがエラーを返しました', ['status' => $status, 'body' => mb_substr($res, 0, 500)]);
}
$textOut = $json['candidates'][0]['content']['parts'][0]['text'] ?? null;
$out = is_string($textOut) ? json_decode($textOut, true) : null;
if (!is_array($out)) {
    fail(502, '翻訳結果を解釈できません', ['body' => mb_substr($res, 0, 500)]);
}

$out['ms'] = $ms;
logLine('info', "ok {$mode}", ['ms' => $ms, 'lang' => $out['lang'] ?? null, 'len' => mb_strlen($out['translation'] ?? ''), 'thinking' => $thinkingLevel, 'tokens' => $json['usageMetadata']['totalTokenCount'] ?? null]);
echo json_encode($out, JSON_UNESCAPED_UNICODE);
