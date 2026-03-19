'use client';

import { useState, useRef, useEffect } from 'react';

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

interface TimedMessage {
  msg: StreamMessage;
  timestamp: number;
  elapsed: number;
  delta: number;
}

const EXAMPLE_PROMPTS = [
  { label: '거시경제 현황', prompt: '현재 미국 경제 상황을 분석하고, GDP, 인플레이션, 실업률 등 주요 지표를 바탕으로 투자 시사점을 제시해줘' },
  { label: '금리 전망', prompt: '연준(Fed)의 금리 정책 방향을 분석하고, 금리 인하/동결 시나리오별 자산군 투자 전략을 제안해줘' },
  { label: '삼성전자', prompt: '삼성전자 2024년 반도체 실적과 투자 매력도 분석해줘' },
  { label: '간단한 질문', prompt: '오늘 날짜 알려줘' },
];

export default function HomePage() {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [toolUsages, setToolUsages] = useState<Array<{ tool: string; input: string }>>([]);
  const [metadata, setMetadata] = useState<{
    duration_ms?: number;
    num_turns?: number;
    cost_usd?: number;
    tools?: string[];
    agents?: string[];
  } | null>(null);
  const [activeTab, setActiveTab] = useState<'stream' | 'tools' | 'raw'>('stream');
  const [rawMessages, setRawMessages] = useState<TimedMessage[]>([]);
  const streamRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const startTimeRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const [elapsedTime, setElapsedTime] = useState(0);

  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [streamingText]);

  useEffect(() => {
    if (!loading) return;
    const interval = setInterval(() => {
      setElapsedTime(Date.now() - startTimeRef.current);
    }, 100);
    return () => clearInterval(interval);
  }, [loading]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || loading) return;

    setLoading(true);
    setStreamingText('');
    setToolUsages([]);
    setMetadata(null);
    setRawMessages([]);

    const now = Date.now();
    startTimeRef.current = now;
    lastTimeRef.current = now;
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch('/api/claude/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No reader available');

      const decoder = new TextDecoder();
      let buffer = '';

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
            const now = Date.now();
            setRawMessages(prev => [...prev, {
              msg, timestamp: now,
              elapsed: now - startTimeRef.current,
              delta: now - lastTimeRef.current,
            }]);
            lastTimeRef.current = now;

            if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
              const delta = msg.event.delta;
              if (delta?.type === 'text_delta' && delta.text) {
                setStreamingText(prev => prev + delta.text);
              }
            }

            if (msg.type === 'assistant' && msg.message?.content) {
              for (const content of msg.message.content) {
                if (content.type === 'tool_use' && content.name) {
                  setToolUsages(prev => [...prev, {
                    tool: content.name!,
                    input: JSON.stringify(content.input || {}, null, 2)
                  }]);
                }
              }
            }

            if (msg.type === 'system' && msg.subtype === 'init') {
              setMetadata(prev => ({ ...prev, tools: msg.tools, agents: msg.agents }));
            }

            if (msg.type === 'result') {
              setMetadata(prev => ({
                ...prev,
                duration_ms: msg.duration_ms,
                num_turns: msg.num_turns,
                cost_usd: msg.total_cost_usd,
              }));
              if (msg.result) setStreamingText(prev => prev || msg.result || '');
            }

            if (msg.type === 'error') {
              setStreamingText(prev => prev + `\n\n❌ Error: ${JSON.stringify(msg)}`);
            }
          } catch { /* ignore */ }
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        setStreamingText(prev => prev + `\n\n❌ Error: ${(error as Error).message}`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Claude Code API</h1>

        <div className="flex flex-wrap gap-2 mb-4">
          {EXAMPLE_PROMPTS.map((ex, idx) => (
            <button key={idx} onClick={() => setPrompt(ex.prompt)}
              className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm" disabled={loading}>
              {ex.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="mb-6">
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="프롬프트를 입력하세요..."
            className="w-full h-24 p-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
            disabled={loading} />
          <div className="mt-3 flex gap-3">
            <button type="submit" disabled={loading || !prompt.trim()}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-lg font-medium">
              {loading ? '처리 중...' : '전송'}
            </button>
            {loading && (
              <button type="button" onClick={() => { abortControllerRef.current?.abort(); setLoading(false); }}
                className="px-6 py-2 bg-red-600 hover:bg-red-700 rounded-lg font-medium">중지</button>
            )}
          </div>
        </form>

        {(loading || metadata) && (
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-6">
            <div className="p-3 bg-gray-800 rounded-lg">
              <p className="text-gray-400 text-xs">상태</p>
              <p className="text-lg font-bold">
                {loading ? <span className="text-yellow-400 animate-pulse">● 실행중</span>
                  : <span className="text-green-400">● 완료</span>}
              </p>
            </div>
            <div className="p-3 bg-gray-800 rounded-lg">
              <p className="text-gray-400 text-xs">소요시간</p>
              <p className="text-lg font-bold font-mono">
                {loading ? <span className="text-yellow-400">{(elapsedTime / 1000).toFixed(1)}초</span>
                  : metadata?.duration_ms ? `${(metadata.duration_ms / 1000).toFixed(1)}초` : '-'}
              </p>
            </div>
            <div className="p-3 bg-gray-800 rounded-lg">
              <p className="text-gray-400 text-xs">턴 수</p>
              <p className="text-lg font-bold">{metadata?.num_turns || '-'}</p>
            </div>
            <div className="p-3 bg-gray-800 rounded-lg">
              <p className="text-gray-400 text-xs">비용</p>
              <p className="text-lg font-bold">{metadata?.cost_usd ? `$${metadata.cost_usd.toFixed(4)}` : '-'}</p>
            </div>
            <div className="p-3 bg-gray-800 rounded-lg">
              <p className="text-gray-400 text-xs">도구</p>
              <p className="text-lg font-bold">{toolUsages.length}회</p>
            </div>
            <div className="p-3 bg-gray-800 rounded-lg">
              <p className="text-gray-400 text-xs">메시지</p>
              <p className="text-lg font-bold font-mono">{rawMessages.length}</p>
            </div>
          </div>
        )}

        {(streamingText || toolUsages.length > 0 || rawMessages.length > 0) && (
          <>
            <div className="flex border-b border-gray-700 mb-4">
              {(['stream', 'tools', 'raw'] as const).map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 ${activeTab === tab ? 'border-b-2 border-blue-500 text-blue-400' : 'text-gray-400'}`}>
                  {tab === 'stream' ? '응답' : tab === 'tools' ? `도구 (${toolUsages.length})` : `Raw (${rawMessages.length})`}
                </button>
              ))}
            </div>

            <div className="bg-gray-800 rounded-lg p-4 min-h-[300px] max-h-[500px] overflow-auto" ref={streamRef}>
              {activeTab === 'stream' && (
                <pre className="whitespace-pre-wrap text-sm font-mono">
                  {streamingText || (loading ? '응답 대기 중...' : '결과가 없습니다.')}
                  {loading && <span className="animate-pulse">▌</span>}
                </pre>
              )}

              {activeTab === 'tools' && (
                <div className="space-y-3">
                  {toolUsages.length === 0 ? <p className="text-gray-400">사용된 도구가 없습니다.</p> :
                    toolUsages.map((usage, idx) => (
                      <div key={idx} className="p-3 bg-gray-700 rounded">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="px-2 py-0.5 bg-blue-600 rounded text-xs">#{idx + 1}</span>
                          <span className="font-mono text-green-400">{usage.tool}</span>
                        </div>
                        <pre className="text-xs text-gray-400 overflow-auto">{usage.input}</pre>
                      </div>
                    ))}
                </div>
              )}

              {activeTab === 'raw' && (
                <div className="text-xs overflow-auto">
                  {rawMessages.map((timed, idx) => (
                    <div key={idx} className="mb-2 pb-2 border-b border-gray-700">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="px-1.5 py-0.5 bg-gray-600 rounded text-[10px] font-mono">+{(timed.elapsed / 1000).toFixed(2)}s</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${timed.delta > 1000 ? 'bg-red-600' : timed.delta > 500 ? 'bg-yellow-600' : 'bg-green-600'}`}>
                          Δ{timed.delta}ms
                        </span>
                        <span className="text-blue-400 font-bold">[{timed.msg.type}]</span>
                        {timed.msg.subtype && <span className="text-purple-400">({timed.msg.subtype})</span>}
                      </div>
                      <pre className="text-gray-300 overflow-auto">{JSON.stringify(timed.msg, null, 2)}</pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
