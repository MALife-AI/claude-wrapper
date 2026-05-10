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

# 현재 동작 중인 cloudflared 프로세스의 로그만 봐야 함.
# (재시작 backoff 중 이전 실패 시도가 남긴 stale URL을 잡지 않기 위해)
# 최대 60초까지 polling.
URL=""
for _ in $(seq 1 60); do
  PID=$(systemctl show -p MainPID --value cloudflared-tunnel.service 2>/dev/null || echo 0)
  if [ -n "$PID" ] && [ "$PID" != "0" ]; then
    URL=$(journalctl _PID="$PID" --no-pager 2>/dev/null \
      | grep -oE "https://[a-zA-Z0-9.-]+\.trycloudflare\.com" \
      | tail -1 || true)
  fi
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  echo "ERROR: cloudflared journal에서 trycloudflare URL을 찾을 수 없습니다." >&2
  echo "       서비스 상태 확인: systemctl status cloudflared-tunnel" >&2
  exit 1
fi

# health check
if ! curl -sf -m 5 -o /dev/null "$URL/api/claude"; then
  echo "WARN: $URL/api/claude 도달 실패 — wrapper가 :3001에서 동작 중인지 확인" >&2
fi

# 이미 같은 URL이면 sed 자체는 idempotent하지만 mtime이 바뀌니 미리 확인
CURRENT=$(grep -oE "window\\.CLAUDE_WRAPPER_URL\\s*=\\s*'[^']+'" "$INDEX_HTML" \
  | grep -oE "https://[a-zA-Z0-9.-]+\\.trycloudflare\\.com" || true)
if [ "$CURRENT" = "$URL" ]; then
  echo "CLAUDE_WRAPPER_URL already up-to-date: $URL"
  exit 0
fi

# index.html 한 줄 교체
sed -i -E "s|window\\.CLAUDE_WRAPPER_URL\\s*=\\s*'[^']+'|window.CLAUDE_WRAPPER_URL = '$URL'|" "$INDEX_HTML"

# 캐시 버스터: 로컬 JS/CSS 자산의 ?v=<timestamp> 갱신.
# 브라우저가 index.html은 no-cache로 못 캐시하지만, 옛 자산을 디스크 캐시에서
# 끌어쓸 가능성을 막기 위해 새 deploy마다 쿼리를 바꿔준다.
TS=$(date +%s)
sed -i -E "s#(app\\.js|chatbot\\.js|financial\\.js|variance\\.js|style\\.css)(\\?v=[0-9]+)?\"#\\1?v=$TS\"#g" "$INDEX_HTML"

echo "updated CLAUDE_WRAPPER_URL → $URL (cache-buster v=$TS)"

# Auto-commit/push: index.html 한 파일만 origin/main에 반영해 GitHub Pages 재배포 트리거.
# 실패해도 wrapper/cloudflared는 계속 동작해야 하므로 stderr 경고 후 0 반환.
REPO_DIR="/home/ec2-user/Actuarial-Report"
HOSTNAME_PART="${URL#https://}"
HOSTNAME_PART="${HOSTNAME_PART%%.*}"

if cd "$REPO_DIR" 2>/dev/null && git diff --quiet -- index.html; then
  : # index.html 실제 변경 없음 (이론적으로 도달 불가하지만 안전장치)
elif cd "$REPO_DIR" 2>/dev/null; then
  if git commit -m "chore: auto-sync CLAUDE_WRAPPER_URL → $HOSTNAME_PART" -- index.html >/dev/null 2>&1; then
    if git push origin main >/tmp/url-sync-push.log 2>&1; then
      echo "git push success → origin/main"
    else
      echo "WARN: git push 실패 (로그: /tmp/url-sync-push.log)" >&2
    fi
  else
    echo "WARN: git commit 실패 — index.html 수동 확인 필요" >&2
  fi
fi
