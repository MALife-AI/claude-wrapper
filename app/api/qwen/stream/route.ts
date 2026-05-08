import { NextRequest } from 'next/server';

/**
 * POST /api/qwen/stream
 * 자체 호스팅 Qwen 3.6-27B-fp8 (vLLM OpenAI-compatible API) 스트리밍 프록시
 *
 * 요청 body:
 *   { prompt: string, temperature?: number, maxTokens?: number }
 *
 * vLLM 서버 주소는 환경변수 QWEN_API_URL로 설정 (기본값: http://localhost:8000)
 */

const QWEN_API_URL = process.env.QWEN_API_URL || 'http://localhost:8000';
const QWEN_MODEL_NAME = process.env.QWEN_MODEL_NAME || 'qwen3-27b-fp8';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { prompt, temperature = 0.7, maxTokens = 2048 } = body;

  if (!prompt || typeof prompt !== 'string') {
    return new Response(JSON.stringify({ error: 'Prompt required' }), { status: 400 });
  }

  try {
    // vLLM OpenAI-compatible chat completions API (streaming)
    const vllmRes = await fetch(`${QWEN_API_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: QWEN_MODEL_NAME,
        messages: [
          { role: 'user', content: prompt },
        ],
        temperature,
        max_tokens: maxTokens,
        stream: true,
      }),
    });

    if (!vllmRes.ok) {
      const errText = await vllmRes.text();
      return new Response(
        JSON.stringify({ type: 'error', message: `Qwen API error: ${vllmRes.status} ${errText}` }),
        { status: vllmRes.status }
      );
    }

    if (!vllmRes.body) {
      return new Response(
        JSON.stringify({ type: 'error', message: 'No response body from Qwen API' }),
        { status: 502 }
      );
    }

    // OpenAI SSE → claude-wrapper 호환 스트림 변환
    // chatbot.js가 기대하는 형식: { type: 'assistant', message: { content: [{ type: 'text', text: '...' }] } }
    const reader = vllmRes.body.getReader();
    const decoder = new TextDecoder('utf-8');

    const stream = new ReadableStream({
      async start(controller) {
        let buffer = '';
        let fullText = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed === 'data: [DONE]') continue;

              const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
              if (!payload) continue;

              try {
                const parsed = JSON.parse(payload);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  fullText += delta;
                  // claude-wrapper 호환 형식으로 변환
                  const evt = {
                    type: 'assistant',
                    message: {
                      content: [{ type: 'text', text: fullText }],
                    },
                  };
                  controller.enqueue(new TextEncoder().encode(JSON.stringify(evt) + '\n'));
                }
              } catch {
                // JSON 파싱 실패 무시
              }
            }
          }

          // 남은 버퍼 처리
          if (buffer.trim()) {
            const payload = buffer.trim().startsWith('data:') ? buffer.trim().slice(5).trim() : buffer.trim();
            try {
              const parsed = JSON.parse(payload);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                fullText += delta;
                const evt = {
                  type: 'assistant',
                  message: {
                    content: [{ type: 'text', text: fullText }],
                  },
                };
                controller.enqueue(new TextEncoder().encode(JSON.stringify(evt) + '\n'));
              }
            } catch {
              // 무시
            }
          }
        } catch (err) {
          controller.enqueue(new TextEncoder().encode(
            JSON.stringify({ type: 'error', message: `Stream error: ${err}` }) + '\n'
          ));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        type: 'error',
        message: `Qwen 서버 연결 실패 (${QWEN_API_URL}): ${err instanceof Error ? err.message : err}`,
      }),
      { status: 502 }
    );
  }
}
