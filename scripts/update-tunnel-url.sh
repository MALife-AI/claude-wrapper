#!/usr/bin/env bash
# 현재 cloudflared-tunnel.service의 trycloudflare URL을 캡처해
# index.html의 window.CLAUDE_WRAPPER_URL 한 줄을 갱신한다.
#
# Quick tunnel은 cloudflared 재시작마다 URL이 바뀌므로
# - cloudflared 재기동 후
# - 또는 systemd 자동 재시작이 발생했을 때
# 이 스크립트를 돌려서 index.html을 동기화한다.
#
# 영구 URL이 필요하면 named tunnel(Cloudflare 계정 + 도메인)으로 마이그레이션 권장:
#   cloudflared tunnel login
#   cloudflared tunnel create <name>
#   cloudflared tunnel route dns <name> api.example.com
#   ExecStart=cloudflared tunnel run <name>

set -euo pipefail

INDEX_HTML="/home/ec2-user/Actuarial-Report/index.html"

URL=$(sudo journalctl -u cloudflared-tunnel.service --no-pager -n 200 \
  | grep -oE "https://[a-zA-Z0-9.-]+\.trycloudflare\.com" \
  | tail -1)

if [ -z "$URL" ]; then
  echo "ERROR: cloudflared journal에서 trycloudflare URL을 찾을 수 없습니다." >&2
  echo "       서비스 상태 확인: sudo systemctl status cloudflared-tunnel" >&2
  exit 1
fi

# health check
if ! curl -sf -m 5 -o /dev/null "$URL/api/claude"; then
  echo "WARN: $URL/api/claude 도달 실패 — wrapper가 :3001에서 동작 중인지 확인" >&2
fi

# index.html 한 줄 교체
sed -i -E "s|window\\.CLAUDE_WRAPPER_URL\\s*=\\s*'[^']+'|window.CLAUDE_WRAPPER_URL = '$URL'|" "$INDEX_HTML"

echo "updated CLAUDE_WRAPPER_URL → $URL"
echo "$INDEX_HTML 변경됨. git add/commit 후 배포(GitHub Pages) 필요."
