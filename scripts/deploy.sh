#!/usr/bin/env bash
# カゴヤVPS(translate.flow-t.net)へデプロイする。
#   ./scripts/deploy.sh
# 前提: ~/.ssh/config に kagoya-vps-mizy が定義されていること。
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=kagoya-vps-mizy
WEBROOT=/var/www/transrate

echo "== build"
npm run build

echo "== upload static files"
rsync -az --delete --exclude 'api/' --exclude 'test/' dist/ "$HOST:$WEBROOT/"

echo "== upload api"
rsync -az --delete server/api/ "$HOST:$WEBROOT/api/"

echo "== nginx snippet + permissions"
scp -q server/nginx/transrate_site.conf "$HOST:/etc/nginx/snippets/transrate_site.conf"
ssh "$HOST" bash -s <<'REMOTE'
set -e
chown -R www-data:www-data /var/www/transrate
mkdir -p /var/log/transrate && chown www-data:www-data /var/log/transrate && chmod 750 /var/log/transrate
mkdir -p /var/lib/transrate && chown www-data:www-data /var/lib/transrate && chmod 750 /var/lib/transrate
if [ ! -f /etc/transrate/.env ]; then
  echo "!! /etc/transrate/.env がありません。GEMINI_API_KEY / GEMINI_MODEL を定義してください(オンラインモードが使えません)。"
fi
nginx -t && systemctl reload nginx
echo "deployed: $(date '+%Y-%m-%d %H:%M:%S')"
REMOTE
