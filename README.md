# Transrate — オフライン対応 双方向 自動音声翻訳 PWA

スマホに置いたまま、2人の会話を自動で翻訳して読み上げる PWA です。

- **オフラインモード**: 音声認識・言語判定・翻訳をすべて端末内(ブラウザ内)で実行。言語データを一度ダウンロードすれば **ネット接続なし** で動作します。
- **オンラインモード(高精度)**: サーバー側プロキシ経由で Gemini に音声を渡し、言語判定・文字起こし・翻訳を一度に行います。タイ語・ベトナム語・繁体字中国語など、小型モデルでは精度が出にくい言語でも自然な翻訳になります。API キーはサーバーにのみ置き、ブラウザには渡しません。
- 既定は「自動」(通信できるときはオンライン、できないときはオフライン)。

本番: https://translate.flow-t.net (カゴヤVPS)

## 主な機能

- **言語ごとのローカルダウンロード** — 設定画面で言語データ(音声認識モデル + 両方向の翻訳モデル)を端末に保存・削除できます。保存後はオフラインで翻訳可能。
  - **iPhone / iPad の注意**: Safari とホーム画面に追加したアプリは保存領域が別々です。Safari で保存したデータはホーム画面のアプリでは使えないため、先に「ホーム画面に追加」してから、追加したアプリでダウンロードしてください(Safari で開いている間は設定画面に注意書きを表示します)。
- **2言語を事前指定** — 言語 A / 言語 B を設定。オフラインの翻訳モデルは「英語⇄各言語」しか無いため、英語を含まないペア(日本語⇄繁体字中国語など)は英語を経由して2段階で翻訳します(中継翻訳)。
- **話した言語を音声から自動判定、または言語ボタンで固定** — 「自動認識」ボタンを押すと設定した2言語のどちらかを自動で判定して翻訳します。また、操作部に並ぶ2つの言語ボタン（国旗＋言語名）を押せば、話す言語を固定して誤判定なく確実に文字起こし・翻訳できます（オンライン・オフライン双方で対応）。
- **置きっぱなしでもワンタップでも切り替え可能** — 発話区間検出(Silero VAD)で「話し終わり」を検知して自動処理。置いたままでの会話はもちろん、特定の言語で確実に認識させたい場合は該当言語のボタンを押して開始・切り替えできます。自動読み上げのオン/オフや読み上げ停止ボタンは設定画面の「読み上げ音声」内に集約。
- **長押し・タップによるインライン編集と再翻訳** — 会話バブルおよび履歴画面の各項目において、翻訳結果や原文の長押し（またはタップ／編集ボタン）でその場でインライン編集欄を表示。誤認識の修正や文脈の追記を行って即座に再翻訳が可能（履歴と会話画面は双方向に自動同期）。長押し時は触覚フィードバック（バイブレーション）と押し込みアニメーションを提供。
- **話し終わりの判定時間(間)の調整** — 会話のテンポや話し方に合わせて、発話終了とみなす無音時間(1.0秒〜2.2秒、標準1.4秒)を設定画面で変更可能。
- **履歴の全件保存 / 確認アラート付き削除 / 全削除** — IndexedDB に保存。個別削除・全削除のいずれも確認アラートを表示して誤削除を防止。
- **翻訳直後に自動読み上げ** + 各項目の「読み上げ」ボタン。
- テキスト入力からの翻訳、読み上げ音声・速度の選択、処理ログ(直近500件)の閲覧・コピー。
- **処理ログのサーバー自動送信** — 端末の処理ログをネット接続時にサーバーへ送り、開発者がサーバー上で追跡できます(会話の中身は送りません)。

## 技術構成

| 役割 | 使用技術 |
| --- | --- |
| 音声認識・言語判定(オフライン) | Whisper (tiny/base/small, ONNX q8) を [Transformers.js](https://huggingface.co/docs/transformers.js) で実行 |
| 翻訳(オフライン) | Marian 系 ONNX モデル (Helsinki-NLP opus-mt / FuguMT) を Transformers.js で実行。簡体字⇄繁体字は OpenCC(opencc-js) で変換 |
| 音声認識・翻訳(オンライン) | `server/api/translate.php` (PHP) が Gemini API(`generateContent`, 音声 inline_data)を呼ぶ。モデル名・API キーは `/etc/transrate/.env` |
| 発話区間検出 | [@ricky0123/vad-web](https://github.com/ricky0123/vad) (Silero VAD v5) |
| 読み上げ | 端末内蔵の Web Speech API (`speechSynthesis`) |
| 保存 | IndexedDB(履歴・設定・ログ)、Cache API(モデル本体) |
| ビルド / PWA | Vite + vite-plugin-pwa (Workbox) |

モデル本体は HuggingFace から取得し、ブラウザの Cache Storage(`transformers-cache`)に保存されます。ONNX Runtime の wasm と VAD モデルはアプリに同梱(`public/ort`, `public/ort-vad`, `public/vad`)し、Service Worker がプリキャッシュするため、2回目以降は完全オフラインで起動します。

### 対応言語

日本語・中国語(台湾・繁体字)・ベトナム語・タイ語・英語・中国語(簡体字)・韓国語・フランス語・ドイツ語・スペイン語・イタリア語・インドネシア語・ロシア語・ヒンディー語・アラビア語・オランダ語・スウェーデン語・フィンランド語・ウクライナ語・チェコ語・デンマーク語

オフラインの制約(オンラインモードでは制約なし):

- 英語→タイ語、英語→韓国語 は実用品質の小型 ONNX モデルが無いため未対応。したがって 日本語→タイ語 / 日本語→韓国語 はオフラインでは翻訳できません(逆方向は可能)。設定画面のペア選択時に注意書きを表示します。
- 英語を含まないペアは英語経由の2段階翻訳になるため、直接翻訳より精度が落ちます。
- モデル定義は `src/languages.js`。

### データ量の目安

| データ | サイズ |
| --- | --- |
| 音声認識 小 / 中 / 大 | 約40MB / 約75MB / 約250MB |
| 翻訳(1方向) | 約110〜145MB |
| アプリ本体(ONNX Runtime wasm 含む) | 約31MB |

英語を含まないペアは 4 方向分(約450MB)必要です。iPhone ではメモリ上限のため、このようなペアは翻訳モデルを方向ごとに入れ替えて使います(実装メモ参照)。

日本語の認識精度を重視する場合は「大(small)」を推奨します。

## 開発

```bash
npm install
npm run dev          # http://localhost:5173 (このMacでは 5173 が他プロジェクトに使われているため .claude/launch.json は 5174)
npm run dev:api      # オンラインモード用 PHP プロキシをローカル起動(要 php、プロジェクト直下の .env を読む)
npm run dev:https    # 自己署名 HTTPS + LAN 公開(スマホ実機でマイクを試すとき)
npm run build        # dist/ に本番ビルド
npm run preview      # 本番ビルドの確認
npm run deploy       # カゴヤVPS へデプロイ(scripts/deploy.sh)
npm run logs:client  # 本番に届いた端末ログを表示(scripts/client-logs.sh。-f で追跡、-g 文字列 で絞り込み、数字で行数)
```

ローカルでオンラインモードを試す場合は `.env.example` を `.env` にコピーして `GEMINI_API_KEY` を設定し、`npm run dev:api` を併用します(Vite が `/api` を PHP へ中継)。

マイク・PWA インストール・Service Worker は **HTTPS(または localhost)** でのみ動作します。

### デバッグ

ブラウザのコンソールから 16kHz Float32Array を直接流し込めます。

```js
transrateDebug.processAudio(float32Array)
```

## デプロイ(カゴヤVPS / translate.flow-t.net)

```bash
npm run deploy
```

`scripts/deploy.sh` が ビルド → `dist/` を `/var/www/transrate/` へ rsync → `server/api/` を `/var/www/transrate/api/` へ rsync → nginx スニペット(`server/nginx/transrate_site.conf`)を `/etc/nginx/snippets/` へ配置 → `nginx -t && reload` を行います。

サーバー側の構成:

| 項目 | 場所 |
| --- | --- |
| 公開ディレクトリ | `/var/www/transrate` |
| nginx サイト定義 | `/etc/nginx/sites-enabled/translate.conf`(リポジトリの `server/nginx/translate.flow-t.net.conf` と同内容) |
| nginx 共通スニペット | `/etc/nginx/snippets/transrate_site.conf` |
| 証明書 | Let's Encrypt `/etc/letsencrypt/live/translate.flow-t.net/`(webroot 方式、自動更新) |
| Gemini 設定 | `/etc/transrate/.env`(`GEMINI_API_KEY`, `GEMINI_MODEL`。root:www-data 640) |
| API ログ | `/var/log/transrate/api.log`(10MB 超で `.1` に1世代ローテーション) |
| 端末ログ | `/var/log/transrate/client.log`(端末から送られた処理ログ。10MB 超で `.1` に1世代ローテーション) |
| PHP | php8.3-fpm(`/run/php/php8.3-fpm.sock`) |

nginx では以下を設定しています。

- `Cross-Origin-Opener-Policy: same-origin` / `Cross-Origin-Embedder-Policy: credentialless`(ONNX Runtime のマルチスレッド化)
- `.mjs` を `text/javascript`、`.webmanifest` を `application/manifest+json` で配信
- `index.html` / `sw.js` / manifest は no-cache、ハッシュ付きアセット・wasm・onnx は1年キャッシュ
- `/api/` 配下のみ PHP を実行(`client_max_body_size 4m`)

Gemini の API キーは Google Cloud 側でサーバーの IPv4(`133.18.144.38`)に制限してください(PHP は `CURLOPT_IPRESOLVE_V4` で IPv4 固定)。

### API プロキシの仕様(`server/api/translate.php`)

- `POST /api/translate.php`、JSON。`Origin`(無ければ `Referer`)が `translate.flow-t.net` 等の許可ホストでなければ 403。
- 音声: `{ "audio": "<base64 WAV 16kHz mono>", "langs": ["ja", "th"] }` → `{ "lang", "transcript", "translation", "ms" }`
- テキスト: `{ "text": "...", "src": "ja", "dst": "th" }` → `{ "translation", "ms" }`
- Gemini には `response_schema` で JSON 出力を強制し、`thinkingLevel: low` で応答時間を短縮(音声1発話あたり約3〜4秒)。
- 音声の上限は base64 で 3MB(約70秒)、テキストは 2000 文字。

### 端末ログ受信の仕様(`server/api/log.php`)

- `POST /api/log.php`、JSON。送信元チェックは `translate.php` と同じ(許可ホスト以外は 403)。
- `{ "device": "<uuid>", "session": "<uuid>", "version": "1.0.0", "standalone": true, "entries": [{ "id", "ts", "level", "msg", "data" }] }` → 204
- 1回あたり最大200件・本文512KB。`msg` は200文字、`data` は4000バイトで切り詰め。
- 1件1行で `client.log` に追記: `[日時] dev=端末ID先頭8桁 ses=起動ID先頭8桁 v版 app|browser #ログID レベル メッセージ データ`

## 実装メモ

- **翻訳モード**: `auto` / `online` / `offline`(`src/main.js` の `useOnline()`)。自動は `navigator.onLine` で判定し、`online` / `offline` イベントで切り替えます。オンラインで失敗した場合にオフラインへ自動で切り替える等のフォールバックは行わず、エラーを表示します。
- **言語判定(オフライン)**: Whisper の `<|startoftranscript|>` 直後の1トークンを、設定した2言語のトークンだけに制限して生成し、その結果で言語を確定してから文字起こしを行います(`src/worker.js`)。2言語以外に誤判定されることがありません。繁体字/簡体字は Whisper 上は同じ `zh` なので、出力を OpenCC で目的の字体に変換します。
- **中継翻訳**: `routeFor(src, dst)`(`src/languages.js`)が直接モデル → 英語経由の順に経路を決め、ワーカーが順に適用します。
- **ONNX Runtime の最適化レベル**: onnxruntime-web の拡張グラフ最適化が q8 モデルで失敗するため `graphOptimizationLevel: 'basic'` を指定しています。
- **VAD のランタイム読み込み**: onnxruntime-web は wasm ローダー(.mjs)を動的 import しますが、Vite 開発サーバは `/public` 配下の .mjs を import できないため、ローダーを Blob URL 化し、wasm 本体は `wasmBinary` として渡しています(`src/vad.js`)。
- **ハルシネーション対策**: Whisper が無音時に出す定型文(「ご視聴ありがとうございました」等)は翻訳対象から除外します(`src/main.js` の `HALLUCINATIONS`)。
- **ログ**: `console` と IndexedDB の両方に記録し、直近500件のみ保持(設定画面で閲覧・コピー・消去)。
- **ログのサーバー送信**(`src/remote-log.js`): IndexedDB のログを送信済み ID の続きから50件ずつ `/api/log.php` へ送ります。送るタイミングは起動時・30秒ごと・`online` イベント・画面が隠れたとき(keepalive)・エラー記録の2秒後。オフライン中や送信失敗時は端末に残り、次の機会に送ります。`text` / `srcText` / `dstText` / `transcript` / `translation` / `steps` は中身を送らず `{ redacted, len }` に置き換えます。端末ID(`kv` の `deviceId`)は設定画面の処理ログ欄に先頭8桁を表示し、サーバーのログと突き合わせられます。捕捉されなかった `error` / `unhandledrejection` も記録します。
- **保存済み判定と永続キャッシュ**: config / tokenizer / onnx など、そのモデルの動作に必要なファイルが **すべて** Cache API にあるときだけ「保存済み」とします(ワーカーの `checkCached` が transformers.js の `ModelRegistry.is_cached_files` / `is_pipeline_cached_files` で確認)。確認結果は `localStorage` に保持され、アプリ起動時や再読み込み直後でも即座に「保存済み」と認識されるため、起動直後に誤って「未ダウンロード」と誤判定・誤表示されません。
- **保存失敗の検出**: transformers.js は容量不足などでキャッシュ保存に失敗しても警告だけで続行するため、ダウンロード後に保存状態を再確認し、保存されていなければエラーログとトーストで知らせます。
- **ダウンロードと読み込みの分離**: 「ダウンロード」はファイルを Cache API に保存するだけで、メモリには読み込みません(ワーカーの `download`。大きい onnx は受信しながら保存し、メモリに溜めません)。
- **モデルの読み込み優先度と常駐管理**: 音声の聞き取りを開始するためには音声認識(Whisper)が最優先で必要なため、Whisper を最初にメモリへ読み込みます。
- **iPhone のメモリ上限と1モデルオンデマンド入れ替え方式**: iPhone (WebKit) はメモリ上限が厳しく、Whisper と複数モデル(中継翻訳の2モデルなど)が同時に載ると即座にプロセス強制終了(クラッシュ・白画面)します。iOS では起動時は Whisper のみをメモリに常駐させ、翻訳モデルは起動時には載せません。翻訳実行時に必要な翻訳モデルを1つずつ読み込み、中継翻訳(英語経由)でも1段目の翻訳後に解放して2段目を読み込むステップ実行とすることで、同時常駐モデルを常に「Whisper + 翻訳モデル1個」以下に抑え、強制終了を完全に防ぎます。
- **強制終了ガードと自動リカバリ**: モデル読み込みの開始時に `localStorage` へ印を書き、完了・失敗時に消します。起動時に印が残っていれば前回強制終了したと判断して自動読み込みを止めますが、前回のクラッシュが翻訳モデル多重読み込みによるものと判明した場合はガードを自動解除して音声認識単体での安全な読み込みを自動再試行します。
- **オフライン切替(自動モード)**: `offline` イベントで、保存済みでまだ読み込んでいないモデルを端末から読み込んでから可否を判定します。保存済みなのに読み込めなかった場合は「未ダウンロード」ではなく「読み込めませんでした」と表示します。
- **マイクの扱い**: 読み上げ中や停止中は、マイクを止めずにミュート(`track.enabled = false`)するだけにして、同じマイクを使い続けます(`src/vad.js` の `pauseStream` / `resumeStream`)。vad-web の既定動作は停止のたびに `getUserMedia` をやり直し、iPhone ではそのたびに許可ダイアログが出るためです。OS 側がマイクを終了させた場合(通話の割り込みなど)だけ取り直します。なお iPhone のホーム画面アプリは、アプリを起動するたびに最初の1回だけ許可を求めます(iOS の仕様)。
- **オフライン切替に失敗したときの表示**: 自動モードでオフライン翻訳に切り替えられないとき、「言語ペアがオフライン未対応」「端末に保存されていないデータがある(データ名)」「保存済みだが読み込めない」を区別して表示し、必要モデル・読み込み済み・保存状態を処理ログに記録します。起動時には保存容量と永続化状態も記録します。
- **端末発熱・CPU高負荷の解消**: Silero VAD(2MB弱)は 32ms ごとに常時推論されるため、マルチスレッドを有効にするとスレッド管理・スピン待機オーバーヘッドで常時 CPU 100% となりスマホが異常発熱します。`ort.env.wasm.numThreads = 1` に固定することで推論負荷を数%に抑え、長時間の置きっぱなしでも発熱しないように改善しました。
- **バックグラウンド移行・スワイプ復帰の安定化**: iOS WebKit では別アプリへスワイプしたりホームに戻った際にマイクの MediaStreamTrack が無効化・無音化され、AudioContext が suspended になります。`visibilitychange` でバックグラウンド移行時にマイクを一時待機させ、フォアグラウンド復帰時に自動的にマイクを再初期化してシームレスに聞き取りを再開します。手動で停止した際も VAD インスタンスを完全破棄し、次回オン時にクリーンなマイクを再取得します。
- **オンライン時の即時起動**: ネット接続がある場合は、端末内モデルの重い初期化完了を待たずに即座に聞き取りを開始(起動時間0秒)。オフライン用モデルはバックグラウンドで事前読み込みします。オフライン時は読み込み中のモデル名をステータスに表示します。
- **履歴の確認アラートと長押しインライン編集・再翻訳**: 履歴の個別削除・全削除の双方で確認ダイアログを表示して誤削除を防止。履歴一覧および会話バブルの各項目はテキストの長押し（450ms検知・触覚バイブレーション・押し込み演出）または編集ボタンでその場でインライン編集欄を展開でき、再翻訳時は IndexedDB と同時に会話画面・履歴画面の表示を双方向同期します。
- **保存状態の表示**: 設定画面の言語データ欄に、アプリ本体のオフライン保存(Service Worker のインストール)完了状況、保存容量、自動削除からの保護(`navigator.storage.persisted()`)を表示します。起動時、保存済みモデルがあれば `navigator.storage.persist()` を要求します。

## ディレクトリ

```
index.html            画面構造
src/main.js           画面制御・会話処理の流れ
src/worker.js         Web Worker(Whisper / 翻訳)
src/vad.js            発話区間検出
src/tts.js            読み上げ
src/online.js         オンラインモード(WAV エンコード + /api/translate.php 呼び出し)
src/db.js             IndexedDB
src/logger.js         処理ログ
src/remote-log.js     処理ログのサーバー自動送信
src/languages.js      対応言語・モデル定義
src/models.js         保存済みモデルファイルの有無確認・削除・保存容量
styles/main.scss      スタイル(CSS は全て SCSS で管理)
public/ort, ort-vad   ONNX Runtime wasm(音声認識/翻訳用と VAD 用でバージョンが異なる)
public/vad            Silero VAD モデル + AudioWorklet
public/icons          PWA アイコン
server/api/translate.php   Gemini プロキシ(PHP)
server/api/log.php         端末ログ受信(PHP)
server/nginx/         nginx 設定(本番と同内容)
scripts/deploy.sh     デプロイスクリプト
scripts/client-logs.sh  本番の端末ログ表示
.env.example          ローカルで PHP プロキシを動かすときの環境変数の雛形
```
