'use client';

/**
 * chatbot/page.tsx
 * Floating-style chat widget for 미래에셋생명 변액보험 운용팀.
 *
 * Security note: The renderMarkdown() helper below sanitizes user-visible
 * content by HTML-escaping ALL input before applying regex transforms.
 * No raw external or user-supplied HTML is ever injected; only the safe
 * pattern-matched substrings are wrapped in known-safe tags.
 * The resulting string is then passed to dangerouslySetInnerHTML only for
 * the purpose of rendering the formatted markdown in the assistant bubble.
 */

import { useState, useRef, useEffect, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StreamMessage {
  type: 'system' | 'assistant' | 'user' | 'result' | 'stream_event' | 'error';
  subtype?: string;
  message?: {
    content: Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
    }>;
  };
  event?: {
    type: string;
    delta?: { type: string; text?: string };
    content_block?: { type: string; text?: string };
  };
  result?: string;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  tools?: string[];
  agents?: string[];
}

type MessageRole = 'user' | 'assistant';

interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  isStreaming?: boolean;
  durationMs?: number;
  costUsd?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_BASE = `당신은 미래에셋생명 변액보험 운용팀의 AI 어시스턴트입니다.

작업 디렉토리: /Users/lsc/var_ai_assist/Insurance-Assistant/1차 미팅(20260316)/변액운용/

사용 가능한 도구:
1. Python 코드 실행 (Bash) — calc_engine.py, quant_toolkit.py, bond_analytics.py, market_data_api.py
2. FastAPI 서버 (http://localhost:8000) — 채권 프라이싱, 수익률 곡선, VaR, 포트폴리오 분석 API
3. 웹 검색 (WebSearch) — 실시간 시장 정보
4. 파일 읽기 (Read) — 데이터 파일 직접 접근

응답 규칙:
- 한국어로 응답, 숫자는 억원/조원, 수익률은 %, 상승=빨강 하락=파랑
- 아래 대시보드 데이터를 활용하여 즉시 답변. 추가 분석 필요 시 도구 사용
- 간결하고 핵심 위주로 답변`;

const DASHBOARD_API_URL = 'http://localhost:8000/api/v1/data/snapshot';

const FINANCIAL_AGENTS = {
  'fund-analyst': {
    description: '변액보험 펀드 성과 분석 전문가. 기준가, BM 대비 수익률, 추적오차 등을 계산합니다.',
    prompt: `변액보험 펀드 성과 분석 전문가입니다.
데이터 파일을 직접 읽고 Python으로 정확한 수치를 계산하세요.
기준가 시계열, BM 수익률, 초과수익률, 추적오차를 분석합니다.
결과는 표 형식으로 명확하게 제시하세요.`,
    tools: ['Bash', 'Read', 'WebSearch'],
    model: 'sonnet' as const,
  },
  'risk-manager': {
    description: 'VaR, CVaR, 듀레이션, K-ICS 등 리스크 지표 계산 전문가.',
    prompt: `리스크 관리 전문가입니다.
quant_toolkit.py와 bond_analytics.py를 활용하여 VaR, CVaR, 듀레이션을 계산합니다.
K-ICS 시나리오별 자본 충격도 분석합니다.
FastAPI(http://localhost:8000)의 /api/v1/risk/* 엔드포인트도 활용 가능합니다.`,
    tools: ['Bash', 'Read', 'WebFetch'],
    model: 'sonnet' as const,
  },
  'market-analyst': {
    description: '실시간 시장 데이터, 금리, 환율, 지수 분석 전문가.',
    prompt: `시장 분석 전문가입니다.
WebSearch로 실시간 시장 데이터를 조회하고, market_data_api.py로 로컬 데이터를 분석합니다.
KOSPI, KTB 금리, 환율, 원자재 가격 동향을 종합적으로 분석합니다.`,
    tools: ['WebSearch', 'WebFetch', 'Bash'],
    model: 'sonnet' as const,
  },
};

const QUICK_ACTIONS = [
  {
    label: '오늘 시장 현황',
    prompt: '오늘 주요 시장 지표(KOSPI, 원달러, 국고채 금리)를 분석하고 변액보험 펀드 운용에 미치는 시사점을 설명해줘.',
  },
  {
    label: '펀드 수익률 분석',
    prompt: '2101 데이터를 기반으로 최근 72영업일 동안 BM 대비 초과수익률이 가장 높은 상위 10개 펀드를 분석해줘.',
  },
  {
    label: '리스크 요약',
    prompt: '전체 포트폴리오의 VaR(95%), 듀레이션, 주식 비중 등 주요 리스크 지표를 요약해줘.',
  },
  {
    label: '채권 듀레이션 계산',
    prompt:
      '보유현황(2301) 데이터에서 채권 자산의 수정 듀레이션을 계산하고, 금리 1bp 상승 시 평가손익 영향을 추정해줘.',
  },
  {
    label: 'K-ICS 자본 분석',
    prompt:
      'K-ICS 표준모형 기준으로 현재 포트폴리오의 주요 리스크 익스포저를 분석하고 자본 충격을 추정해줘.',
  },
];

// ---------------------------------------------------------------------------
// Markdown renderer
// All input is HTML-escaped before pattern matching; only known-safe
// structural tags are ever emitted. No raw user/model HTML passes through.
// ---------------------------------------------------------------------------
function renderMarkdown(raw: string): string {
  // 1. Escape HTML entities so model output cannot inject tags
  let s = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. Fenced code blocks — must come first to protect inner content
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const langBadge = lang
      ? `<span style="display:block;background:#1e3a5f;color:#60a5fa;padding:2px 10px;font-family:monospace;font-size:0.7rem;">${lang}</span>`
      : '';
    return (
      `<div style="background:#0f172a;border:1px solid #1e3a5f;border-radius:6px;margin:0.4em 0;overflow:hidden;font-size:0.78rem;">` +
      langBadge +
      `<pre style="margin:0;padding:8px 10px;overflow-x:auto;color:#a5f3fc;line-height:1.5;"><code style="font-family:'Menlo','Monaco','Consolas',monospace;">${code.trimEnd()}</code></pre></div>`
    );
  });

  // 3. Inline code
  s = s.replace(/`([^`\n]+)`/g, (_, c: string) =>
    `<code style="background:#0f172a;color:#34d399;padding:.1em .35em;border-radius:3px;font-family:'Menlo','Monaco','Consolas',monospace;font-size:.85em;">${c}</code>`
  );

  // 4. Markdown table (simplified)
  s = s.replace(/(\|[^\n]+\|\n)((?:\|[-: |]+\|\n))((?:\|[^\n]+\|\n?)+)/g, (tableStr) => {
    const rows = tableStr.trim().split('\n').filter(Boolean);
    if (rows.length < 3) return tableStr;
    const headerCells = rows[0].split('|').filter((c) => c.trim());
    const bodyRows = rows.slice(2);
    const thHtml = headerCells
      .map(
        (c) =>
          `<th style="background:#1e3a5f;color:#93c5fd;padding:5px 10px;text-align:left;border:1px solid #334155;">${c.trim()}</th>`
      )
      .join('');
    const tdRowsHtml = bodyRows
      .map(
        (row) =>
          `<tr>${row
            .split('|')
            .filter((c) => c.trim())
            .map((c) => `<td style="color:#cbd5e1;padding:4px 10px;border:1px solid #2d3748;">${c.trim()}</td>`)
            .join('')}</tr>`
      )
      .join('');
    return (
      `<div style="overflow-x:auto;margin:.4em 0;"><table style="border-collapse:collapse;width:100%;font-size:.8rem;">` +
      `<thead><tr>${thHtml}</tr></thead><tbody>${tdRowsHtml}</tbody></table></div>`
    );
  });

  // 5. Bold / italic / strikethrough
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del style="text-decoration:line-through;opacity:.6;">$1</del>');

  // 5b. Escaped HTML tags that model may output (already escaped in step 1)
  s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br/>');
  s = s.replace(/&lt;hr\s*\/?&gt;/gi, '<hr style="border:none;border-top:1px solid #334155;margin:.6em 0;"/>');
  s = s.replace(/&lt;\/?(?:b|strong)&gt;/gi, ''); // 이미 ** 로 처리됨, 중복 태그 제거
  s = s.replace(/&lt;\/?(?:i|em)&gt;/gi, '');
  s = s.replace(/&lt;\/?(?:del|s|strike)&gt;/gi, '');
  s = s.replace(/&lt;\/?(?:u|ins)&gt;/gi, '');
  s = s.replace(/&lt;\/?(?:sup|sub|mark)&gt;/gi, '');
  s = s.replace(/&lt;\/?p&gt;/gi, '');

  // 6. Headings
  s = s.replace(/^### (.+)$/gm, '<h3 style="font-size:.95rem;font-weight:600;margin:.4em 0 .2em;color:#cbd5e1;">$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2 style="font-size:1.05rem;font-weight:700;margin:.5em 0 .25em;color:#e2e8f0;">$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1 style="font-size:1.15rem;font-weight:700;margin:.6em 0 .3em;color:#e2e8f0;">$1</h1>');

  // 7. Unordered list groups
  s = s.replace(/((?:^[ \t]*[-*+] .+\n?)+)/gm, (block) => {
    const items = block
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => `<li>${line.replace(/^[ \t]*[-*+] /, '')}</li>`)
      .join('');
    return `<ul style="margin:.3em 0 .3em 1.4em;padding:0;line-height:1.6;">${items}</ul>`;
  });

  // 8. Ordered list groups
  s = s.replace(/((?:^[ \t]*\d+\. .+\n?)+)/gm, (block) => {
    const items = block
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => `<li>${line.replace(/^[ \t]*\d+\. /, '')}</li>`)
      .join('');
    return `<ol style="margin:.3em 0 .3em 1.4em;padding:0;line-height:1.6;">${items}</ol>`;
  });

  // 9. Horizontal rule
  s = s.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #334155;margin:.6em 0;"/>');

  // 10. Wrap loose text lines as paragraphs
  s = s.replace(/^(?!<[a-zA-Z\/])(.+)$/gm, '<p style="margin:.3em 0;line-height:1.6;">$1</p>');

  return s;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ChatbotPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [toolActivity, setToolActivity] = useState<string>('');
  const [phase, setPhase] = useState<string>('');  // 현재 단계 표시
  const [elapsedSec, setElapsedSec] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [dashboardSnapshot, setDashboardSnapshot] = useState<string>('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamingIdRef = useRef<string>('');

  // 대시보드 스냅샷 로딩 (마운트 시 + 5분마다 갱신)
  useEffect(() => {
    const loadSnapshot = async () => {
      try {
        const res = await fetch(DASHBOARD_API_URL);
        if (res.ok) {
          const data = await res.json();
          setDashboardSnapshot(data.snapshot || '');
        }
      } catch {
        // FastAPI 미실행 시 무시
      }
    };
    loadSnapshot();
    const interval = setInterval(loadSnapshot, 300000); // 5분마다 갱신
    return () => clearInterval(interval);
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Auto-resize textarea
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [input]);

  const generateId = () => Math.random().toString(36).slice(2, 10);

  const sendMessage = useCallback(
    async (userText: string) => {
      const trimmed = userText.trim();
      if (!trimmed || isLoading) return;

      setInput('');

      const userMsg: ChatMessage = { id: generateId(), role: 'user', content: trimmed };
      const assistantId = generateId();
      streamingIdRef.current = assistantId;
      const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', content: '', isStreaming: true };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsLoading(true);
      setToolActivity('');
      setPhase('연결 중...');
      setElapsedSec(0);
      timerRef.current = setInterval(() => setElapsedSec((s) => s + 1), 1000);

      abortControllerRef.current = new AbortController();

      const contextBlock = dashboardSnapshot
        ? `\n\n${dashboardSnapshot}\n`
        : '';
      const fullPrompt = `${SYSTEM_PROMPT_BASE}${contextBlock}\n\n사용자 질문: ${trimmed}`;

      try {
        const response = await fetch('/api/claude/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: fullPrompt,
            model: 'haiku',            // Haiku = 가장 빠른 응답
            maxTurns: 4,               // 도구 호출 포함 최대 4턴
            useDefaultAgents: false,    // 에이전트 비활성화 = 단일 턴 응답
          }),
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setPhase('생각하는 중...');

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No reader');

        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';
        let finalDurationMs: number | undefined;
        let finalCostUsd: number | undefined;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg: StreamMessage = JSON.parse(line);

              if (
                msg.type === 'stream_event' &&
                msg.event?.type === 'content_block_delta' &&
                msg.event.delta?.type === 'text_delta' &&
                msg.event.delta.text
              ) {
                accumulated += msg.event.delta.text;
                const snap = accumulated;
                setPhase('답변 작성 중...');
                setToolActivity('');
                setMessages((prev) =>
                  prev.map((m) => (m.id === assistantId ? { ...m, content: snap } : m))
                );
              }

              // thinking 이벤트 감지
              if (
                msg.type === 'stream_event' &&
                msg.event?.type === 'content_block_start' &&
                msg.event?.content_block?.type === 'thinking'
              ) {
                setPhase('분석 중...');
              }

              if (msg.type === 'assistant' && msg.message?.content) {
                for (const block of msg.message.content) {
                  if (block.type === 'tool_use' && block.name) {
                    const toolLabels: Record<string, string> = {
                      Bash: '코드 실행 중',
                      WebSearch: '웹 검색 중',
                      Read: '파일 읽는 중',
                      WebFetch: '데이터 수집 중',
                      Grep: '코드 검색 중',
                      Glob: '파일 탐색 중',
                      Write: '파일 작성 중',
                      Edit: '파일 수정 중',
                    };
                    const label = toolLabels[block.name] || `${block.name} 실행 중`;
                    setToolActivity(label);
                    setPhase(label + '...');
                  }
                }
              }

              if (msg.type === 'user') {
                setToolActivity('');
                setPhase('결과 분석 중...');
              }

              if (msg.type === 'result') {
                finalDurationMs = msg.duration_ms;
                finalCostUsd = msg.total_cost_usd;
                if (msg.result && !accumulated) {
                  accumulated = msg.result;
                  setMessages((prev) =>
                    prev.map((m) => (m.id === assistantId ? { ...m, content: accumulated } : m))
                  );
                }
              }

              if (msg.type === 'error') {
                accumulated += accumulated ? '\n\n오류가 발생했습니다.' : '오류가 발생했습니다.';
                setMessages((prev) =>
                  prev.map((m) => (m.id === assistantId ? { ...m, content: accumulated } : m))
                );
              }
            } catch {
              // ignore malformed JSON lines
            }
          }
        }

        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, isStreaming: false, durationMs: finalDurationMs, costUsd: finalCostUsd }
              : m
          )
        );
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: '연결 오류가 발생했습니다. 잠시 후 다시 시도해주세요.', isStreaming: false }
                : m
            )
          );
        }
      } finally {
        setIsLoading(false);
        setToolActivity('');
        setPhase('');
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        inputRef.current?.focus();
      }
    },
    [isLoading, dashboardSnapshot]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(input);
    }
  };

  const handleStop = () => {
    abortControllerRef.current?.abort();
    setIsLoading(false);
    setToolActivity('');
    setPhase('');
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setMessages((prev) =>
      prev.map((m) => (m.id === streamingIdRef.current ? { ...m, isStreaming: false } : m))
    );
  };

  const handleClear = () => {
    setMessages([]);
    setToolActivity('');
    setIsLoading(false);
    abortControllerRef.current?.abort();
  };

  // -------------------------------------------------------------------------
  return (
    <>
      <style>{`
        *,*::before,*::after{box-sizing:border-box}
        html,body{margin:0;padding:0;height:100%;overflow:hidden}
        ::-webkit-scrollbar{width:5px}
        ::-webkit-scrollbar-track{background:#1a2332}
        ::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}
        ::-webkit-scrollbar-thumb:hover{background:#475569}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
        .cursor{display:inline-block;width:2px;height:1em;background:#60a5fa;margin-left:2px;vertical-align:text-bottom;animation:blink 1s infinite}
        @keyframes toolPulse{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
        .tool-pulse{animation:toolPulse .8s linear infinite}
        @keyframes dotPulse{0%,100%{opacity:.7}50%{opacity:1}}
        .dot-pulse{animation:dotPulse 1.4s ease-in-out infinite}
        @keyframes slideUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        .msg-enter{animation:slideUp .2s ease-out}
        .quick-btn:hover:not(:disabled){background:#1e3a5f !important;border-color:#2196F3 !important}
        .send-btn:not(:disabled):hover{box-shadow:0 0 12px rgba(33,150,243,.5)}
      `}</style>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100vh',
          background: '#0d1520',
          fontFamily: "'Pretendard','Apple SD Gothic Neo','Noto Sans KR',sans-serif",
          color: '#e2e8f0',
          fontSize: '13px',
        }}
      >
        {/* Header */}
        <div
          style={{
            background: '#1B2838',
            borderBottom: '1px solid #2d3748',
            padding: '0 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: '48px',
            flexShrink: 0,
            boxShadow: '0 2px 8px rgba(0,0,0,.3)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div
              style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                background: 'linear-gradient(135deg,#2196F3,#0d47a1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '11px',
                fontWeight: 700,
                flexShrink: 0,
                boxShadow: '0 0 8px rgba(33,150,243,.4)',
              }}
            >
              AI
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: '13px', color: '#e2e8f0', lineHeight: 1.2 }}>
                변액운용 AI 어시스턴트
              </div>
              <div style={{ fontSize: '10px', color: '#64748b', lineHeight: 1 }}>
                미래에셋생명 변액보험 운용팀
              </div>
            </div>
            {isLoading && (
              <div
                className="dot-pulse"
                style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e', marginLeft: '4px' }}
              />
            )}
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            {messages.length > 0 && (
              <button
                onClick={handleClear}
                style={{
                  background: 'none',
                  border: '1px solid #334155',
                  borderRadius: '4px',
                  color: '#64748b',
                  cursor: 'pointer',
                  padding: '3px 7px',
                  fontSize: '11px',
                }}
              >
                초기화
              </button>
            )}
            <button
              onClick={() => setIsMinimized((p) => !p)}
              style={{
                background: 'none',
                border: '1px solid #334155',
                borderRadius: '4px',
                color: '#64748b',
                cursor: 'pointer',
                padding: '3px 7px',
                fontSize: '14px',
                lineHeight: 1,
              }}
            >
              {isMinimized ? '▲' : '▼'}
            </button>
          </div>
        </div>

        {!isMinimized && (
          <>
            {/* Messages */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '12px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              {messages.length === 0 && (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flex: 1,
                    gap: '16px',
                    paddingTop: '20px',
                  }}
                >
                  <div
                    style={{
                      width: '56px',
                      height: '56px',
                      borderRadius: '50%',
                      background: 'linear-gradient(135deg,#1e3a5f,#0d47a1)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '20px',
                      fontWeight: 700,
                      boxShadow: '0 0 20px rgba(33,150,243,.2)',
                    }}
                  >
                    AI
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontWeight: 600, marginBottom: '4px', color: '#cbd5e1' }}>
                      무엇을 도와드릴까요?
                    </div>
                    <div style={{ fontSize: '11px', color: '#64748b', lineHeight: 1.5 }}>
                      변액보험 펀드 분석, 리스크 평가, 시장 현황
                      <br />
                      실제 데이터 기반으로 즉시 분석합니다.
                    </div>
                  </div>
                  <div
                    style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%', maxWidth: '340px' }}
                  >
                    {QUICK_ACTIONS.map((action, i) => (
                      <button
                        key={i}
                        className="quick-btn"
                        onClick={() => void sendMessage(action.prompt)}
                        disabled={isLoading}
                        style={{
                          background: '#132033',
                          border: '1px solid #2d3748',
                          borderRadius: '8px',
                          color: '#93c5fd',
                          cursor: 'pointer',
                          padding: '8px 12px',
                          fontSize: '12px',
                          textAlign: 'left',
                          transition: 'all .15s',
                          fontFamily: 'inherit',
                        }}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((msg) => (
                <MessageBubble key={msg.id} msg={msg} renderMarkdown={renderMarkdown} />
              ))}

              {isLoading && phase && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 12px',
                    background: 'linear-gradient(135deg, #0f1d2e, #132033)',
                    border: '1px solid #1e3a5f',
                    borderRadius: '12px',
                    alignSelf: 'flex-start',
                    fontSize: '11px',
                    maxWidth: 'fit-content',
                  }}
                >
                  {/* 스피너 */}
                  <svg
                    className="tool-pulse"
                    style={{ width: 14, height: 14, flexShrink: 0 }}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#60a5fa"
                    strokeWidth="3"
                  >
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <span style={{ color: '#93c5fd' }}>{phase}</span>
                  <span style={{ color: '#475569', fontSize: '10px', fontVariantNumeric: 'tabular-nums' }}>
                    {elapsedSec}초
                  </span>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div
              style={{
                borderTop: '1px solid #2d3748',
                background: '#111a27',
                padding: '10px 12px',
                flexShrink: 0,
              }}
            >
              {messages.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    gap: '5px',
                    marginBottom: '8px',
                    overflowX: 'auto',
                    paddingBottom: '2px',
                  }}
                >
                  {QUICK_ACTIONS.map((action, i) => (
                    <button
                      key={i}
                      className="quick-btn"
                      onClick={() => void sendMessage(action.prompt)}
                      disabled={isLoading}
                      style={{
                        background: '#0d1520',
                        border: '1px solid #2d3748',
                        borderRadius: '12px',
                        color: '#7aadda',
                        cursor: 'pointer',
                        padding: '3px 10px',
                        fontSize: '11px',
                        whiteSpace: 'nowrap',
                        transition: 'all .15s',
                        fontFamily: 'inherit',
                        flexShrink: 0,
                      }}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="질문을 입력하세요... (Shift+Enter: 줄바꿈)"
                  disabled={isLoading}
                  rows={1}
                  style={{
                    flex: 1,
                    background: '#1a2332',
                    border: '1px solid #2d3748',
                    borderRadius: '8px',
                    color: '#e2e8f0',
                    fontSize: '13px',
                    lineHeight: '1.5',
                    padding: '7px 10px',
                    outline: 'none',
                    resize: 'none',
                    fontFamily: 'inherit',
                    minHeight: '36px',
                    maxHeight: '120px',
                    overflowY: 'auto',
                    transition: 'border-color .15s',
                  }}
                  onFocus={(e) => {
                    (e.target as HTMLTextAreaElement).style.borderColor = '#2196F3';
                  }}
                  onBlur={(e) => {
                    (e.target as HTMLTextAreaElement).style.borderColor = '#2d3748';
                  }}
                />
                {isLoading ? (
                  <button
                    onClick={handleStop}
                    style={{
                      background: '#7f1d1d',
                      border: 'none',
                      borderRadius: '8px',
                      color: '#fca5a5',
                      cursor: 'pointer',
                      padding: '7px 10px',
                      fontSize: '12px',
                      fontFamily: 'inherit',
                      height: '36px',
                    }}
                  >
                    중지
                  </button>
                ) : (
                  <button
                    className="send-btn"
                    onClick={() => void sendMessage(input)}
                    disabled={!input.trim()}
                    style={{
                      background: input.trim() ? '#2196F3' : '#1e3a5f',
                      border: 'none',
                      borderRadius: '8px',
                      color: input.trim() ? '#fff' : '#4a6fa5',
                      cursor: input.trim() ? 'pointer' : 'default',
                      padding: '7px 12px',
                      fontSize: '12px',
                      fontFamily: 'inherit',
                      height: '36px',
                      transition: 'all .15s',
                    }}
                  >
                    전송
                  </button>
                )}
              </div>

              <div
                style={{ marginTop: '6px', fontSize: '10px', color: '#334155', textAlign: 'center' }}
              >
                Claude Code · Haiku · 실제 데이터 기반 분석
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Message Bubble
// ---------------------------------------------------------------------------

function MessageBubble({
  msg,
  renderMarkdown: renderMd,
}: {
  msg: ChatMessage;
  renderMarkdown: (raw: string) => string;
}) {
  const isUser = msg.role === 'user';

  /*
   * renderMd() returns HTML built from HTML-escaped input with only known-safe
   * structural tags. It is safe to insert via innerHTML for display purposes.
   */
  const safeHtml = !isUser && msg.content ? renderMd(msg.content) : '';

  return (
    <div
      className="msg-enter"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        gap: '3px',
      }}
    >
      <div
        style={{
          fontSize: '10px',
          color: '#475569',
          paddingLeft: isUser ? 0 : '2px',
          paddingRight: isUser ? '2px' : 0,
        }}
      >
        {isUser ? '나' : '어시스턴트'}
      </div>

      <div
        style={{
          maxWidth: '90%',
          padding: isUser ? '7px 11px' : '9px 12px',
          borderRadius: isUser ? '12px 12px 3px 12px' : '12px 12px 12px 3px',
          background: isUser ? '#1e3a5f' : '#132033',
          border: isUser ? '1px solid #2563eb' : '1px solid #2d3748',
          color: '#e2e8f0',
          lineHeight: 1.55,
          wordBreak: 'break-word',
        }}
      >
        {isUser ? (
          <span style={{ fontSize: '13px', whiteSpace: 'pre-wrap' }}>{msg.content}</span>
        ) : msg.content ? (
          // safeHtml is built from HTML-escaped text; only structural tags emitted
          <div
            style={{ fontSize: '13px' }}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: safeHtml }}
          />
        ) : (
          msg.isStreaming && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#64748b', fontSize: '12px' }}>
              <span className="tool-pulse">분석 중</span>
              <span className="cursor" />
            </span>
          )
        )}
        {!isUser && msg.isStreaming && msg.content && <span className="cursor" />}
      </div>

      {!isUser && !msg.isStreaming && (msg.durationMs || msg.costUsd) && (
        <div style={{ fontSize: '10px', color: '#334155', paddingLeft: '2px' }}>
          {msg.durationMs !== undefined && `${(msg.durationMs / 1000).toFixed(1)}초`}
          {msg.durationMs !== undefined && msg.costUsd !== undefined && ' · '}
          {msg.costUsd !== undefined && `$${msg.costUsd.toFixed(4)}`}
        </div>
      )}
    </div>
  );
}
