# 테스트 가이드

## 0. 사전 준비 (최초 1회)

```bash
# Claude Code CLI 설치
npm install -g @anthropic-ai/claude-code

# 인증 (브라우저 열림)
claude

# 인증 확인
claude --print "hello"
```

## 1. 프로젝트 설정

```bash
# 새로운 디렉토리에서 테스트
cd ~/test-claude-wrapper

# 프로젝트 클론
git clone https://github.com/YOUR_USERNAME/awesome-demo-generate-agent.git
cd awesome-demo-generate-agent

# 의존성 설치
npm install
```

## 2. 서버 실행

```bash
# 개발 서버 시작
npm run dev
```

새 터미널 창에서 아래 테스트 실행:

## 3. 빠른 테스트

### 기본 동작 확인
```bash
curl -X POST http://localhost:3000/api/claude \
  -H "Content-Type: application/json" \
  -d '{"prompt":"2+2는?"}'
```

### 스트리밍 테스트
```bash
curl -X POST http://localhost:3000/api/claude/stream \
  -H "Content-Type: application/json" \
  -d '{"prompt":"hello in one word"}' \
  --no-buffer
```

### WebSearch 테스트
```bash
curl -X POST http://localhost:3000/api/claude \
  -H "Content-Type: application/json" \
  -d '{"prompt":"오늘 날씨는?"}'
```

## 4. Python 테스트 (requests 필요)

```bash
# requests 설치
pip3 install requests

# 테스트 스크립트 실행
python3 << 'EOF'
import requests

response = requests.post(
    "http://localhost:3000/api/claude",
    json={"prompt": "3+5는?"}
)

result = response.json()
print(f"✅ 결과: {result['result']}")
print(f"💰 비용: ${result['metadata']['cost_usd']:.4f}")
EOF
```

## 5. JavaScript 테스트

```bash
node << 'EOF'
(async () => {
  const response = await fetch('http://localhost:3000/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '5+7은?' })
  });

  const data = await response.json();
  console.log('✅ 결과:', data.result);
  console.log('💰 비용:', `$${data.metadata.cost_usd.toFixed(4)}`);
})();
EOF
```

## 6. 에이전트 테스트

```bash
curl -X POST http://localhost:3000/api/claude \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "최신 AI 뉴스 검색해줘",
    "agents": {
      "news-researcher": {
        "description": "뉴스 검색 전문가",
        "prompt": "최신 뉴스를 검색하고 요약하세요.",
        "tools": ["WebSearch", "WebFetch"],
        "model": "haiku"
      }
    }
  }'
```

## 7. 부하 테스트

```bash
# 10개 동시 요청
for i in {1..10}; do
  curl -X POST http://localhost:3000/api/claude \
    -H "Content-Type: application/json" \
    -d "{\"prompt\":\"$i + $i는?\"}" &
done
wait
```

## 8. 서버 중지

```bash
# npm run dev 실행 중인 터미널에서
Ctrl + C

# 또는 포트로 프로세스 찾아서 종료
lsof -ti:3000 | xargs kill -9
```

## 트러블슈팅

### Claude CLI 인증 오류
```bash
# 재인증
claude

# 인증 상태 확인
ls -la ~/.claude
claude --verbose --print "test"
```

### 포트 사용 중
```bash
# 3000번 포트 사용 중인 프로세스 확인
lsof -i:3000

# 프로세스 종료
lsof -ti:3000 | xargs kill -9
```

### Node.js 버전 문제
```bash
# Node.js 버전 확인 (20.x 권장)
node --version

# macOS Homebrew로 업데이트
brew install node@20
```

## 성공 기준

- ✅ API가 200 응답 반환
- ✅ `result` 필드에 답변 포함
- ✅ `total_cost_usd` 값이 0보다 큼
- ✅ `apiKeySource: "none"` (API 키 사용 안함)
- ✅ 스트리밍 응답이 실시간으로 출력됨
