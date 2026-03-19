import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// MCP 서버 설정 (예시 - 필요시 추가)
// WebSearch는 Claude Code 내장 도구로 이미 사용 가능
const MCP_SERVERS: MCPServer[] = [
  // 예시: Alpha Vantage (금융 데이터) - API 키 필요
  // { name: 'alphavantage', transport: 'http', url: 'https://mcp.alphavantage.co/mcp?apikey=YOUR_KEY' },
  // 예시: Notion - OAuth 필요
  // { name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp' },
];

interface MCPServer {
  name: string;
  transport: 'http' | 'stdio' | 'sse';
  url?: string;           // for http/sse
  command?: string;       // for stdio
  args?: string[];        // for stdio
  env?: Record<string, string>;  // environment variables
}

// 커스텀 서브에이전트 인터페이스
interface CustomAgent {
  description: string;           // 에이전트 설명 (Claude가 위임 시점 결정에 사용)
  prompt: string;                // 시스템 프롬프트
  tools?: string[];              // 사용 가능한 도구 목록
  disallowedTools?: string[];    // 차단할 도구 목록
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';  // 모델 선택
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
}

// 기본 서브에이전트 설정
const DEFAULT_AGENTS: Record<string, CustomAgent> = {
  'financial-analyst': {
    description: '금융 분석 전문가. 주식, 경제지표, 시장 동향 분석에 사용.',
    prompt: `금융 분석 전문가. 데이터 출처 명시, 리스크 언급, 면책 조항 포함.`,
    tools: ['WebSearch', 'WebFetch'],
    model: 'sonnet'
  },
  'rule-extractor': {
    description: '보험 약관에서 비즈니스 규칙을 추출하는 전문가. 조건문, 임계값, 논리적 관계를 식별.',
    prompt: `당신은 보험 약관 분석 전문가입니다. 텍스트에서 비즈니스 규칙을 추출하여 JSON 형식으로 반환하세요.

출력 형식:
{
  "conditions": [
    {
      "type": "atomic",  // 또는 "group"
      "field": {"table": "테이블명", "column": "컬럼명"},
      "operator": "==|!=|>|>=|<|<=|IN|NOT_IN|CONTAINS|IS_NULL|IS_NOT_NULL|BETWEEN",
      "value": "비교값",
      // group인 경우:
      "logic": "AND|OR|NOT",
      "children": [...]
    }
  ],
  "action": {
    "type": "approve|reject|refer",
    "message": "결과 메시지"
  }
}

한국어 용어 매핑:
- 나이/연령 -> customer.age
- 보험료 -> contract.premium
- 가입금액 -> contract.coverage_amount
- 계약일 -> contract.start_date
- 면책기간 -> policy.exclusion_period_days
- 보험기간 -> policy.term_years
- 진단확정일 -> diagnosis.confirmed_date
- 사망일 -> claim.death_date
- 자기부담금 -> coverage.deductible_amount

반드시 유효한 JSON만 반환하세요.`,
    disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit'],
    model: 'opus'
  }
};

interface ClaudeMessage {
  type: 'system' | 'assistant' | 'user' | 'result' | 'stream_event';
  subtype?: string;
  event?: {
    type: string;
    message?: Record<string, unknown>;
    index?: number;
    content_block?: Record<string, unknown>;
    delta?: Record<string, unknown>;
    usage?: Record<string, unknown>;
  };
  message?: {
    model?: string;
    id?: string;
    role?: string;
    content: Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
    }>;
    usage?: Record<string, unknown>;
    stop_reason?: string | null;
  };
  tools?: string[];
  agents?: string[];
  slash_commands?: string[];
  mcp_servers?: string[];
  model?: string;
  permissionMode?: string;
  cwd?: string;
  claude_code_version?: string;
  output_style?: string;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permission_denials?: string[];
  uuid?: string;
  parent_tool_use_id?: string | null;
}

interface ClaudeAPIResponse {
  success: boolean;
  result: string;
  messages: ClaudeMessage[];  // 모든 메시지 (init, stream_event, assistant, user, result)
  metadata: {
    session_id: string;
    duration_ms: number;
    duration_api_ms: number;
    num_turns: number;
    cost_usd: number;
    tools_used: string[];
    model: string;
    usage: Record<string, unknown>;
    modelUsage: Record<string, unknown>;
    permission_denials: string[];
  };
  init: {
    cwd: string;
    tools: string[];
    agents: string[];
    slash_commands: string[];
    mcp_servers: string[];
    model: string;
    permissionMode: string;
    claude_code_version: string;
    output_style: string;
  };
  stream_events: ClaudeMessage[];  // stream_event만 별도로
  raw_output: string;  // 원본 출력
}

/**
 * Claude Code API Wrapper
 *
 * POST /api/claude
 * Body: {
 *   prompt: string;
 *   allowedTools?: string[];    // 허용할 도구 목록
 *   disallowedTools?: string[]; // 차단할 도구 목록
 *   systemPrompt?: string;      // 시스템 프롬프트
 *   appendSystemPrompt?: string; // 추가 시스템 프롬프트
 *   agents?: Record<string, CustomAgent>;  // 추가 커스텀 서브에이전트
 *   useDefaultAgents?: boolean; // 기본 에이전트 사용 여부 (기본값: true)
 *   images?: Array<{ data: string; media_type?: string; filename?: string }>;  // base64 이미지
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      prompt,
      allowedTools,
      disallowedTools,
      systemPrompt,
      appendSystemPrompt,
      agents,
      useDefaultAgents = true,
      images,
      model,
      maxTurns,
    } = body;

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json(
        { error: 'Prompt is required and must be a string' },
        { status: 400 }
      );
    }

    // 이미지 처리: base64 → temp 파일 저장
    let imageTempDir: string | null = null;
    let finalPrompt = prompt;

    if (images && Array.isArray(images) && images.length > 0) {
      imageTempDir = join(tmpdir(), `claude-wrapper-img-${Date.now()}`);
      mkdirSync(imageTempDir, { recursive: true });

      const filePaths: string[] = [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (!img.data) continue;
        const mediaType = img.media_type || 'image/jpeg';
        let ext = 'jpg';
        if (mediaType.includes('png')) ext = 'png';
        else if (mediaType.includes('pdf')) ext = 'pdf';
        const filename = img.filename || `file_${i + 1}.${ext}`;
        const filepath = join(imageTempDir, filename);
        writeFileSync(filepath, Buffer.from(img.data, 'base64'));
        filePaths.push(filepath);
      }

      if (filePaths.length > 0) {
        const fileList = filePaths.map(p => `  - ${p}`).join('\n');
        finalPrompt = `다음 파일을 Read 도구로 읽은 후 분석하세요:\n${fileList}\n\n${prompt}`;
      }
    }

    // Claude CLI 경로 감지
    const possiblePaths = [
      '/opt/homebrew/bin/claude',  // macOS Homebrew
      'claude'  // PATH에서 찾기
    ];

    const claudePath = possiblePaths.find(path =>
      path === 'claude' || existsSync(path)
    ) || 'claude';
    // 모델 선택: 클라이언트가 지정 가능, 기본값 opus
    const validModels: Record<string, string> = {
      'opus': 'opus',
      'sonnet': 'sonnet',
      'haiku': 'haiku',
    };
    const selectedModel = (model && typeof model === 'string' && validModels[model])
      ? validModels[model]
      : 'opus';

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',  // 실시간 토큰 스트리밍
      '--model', selectedModel,
      '--dangerously-skip-permissions',
    ];

    // max turns (이미지 분석 등 단순 작업은 1턴으로 제한)
    if (maxTurns && typeof maxTurns === 'number' && maxTurns > 0) {
      args.push('--max-turns', String(maxTurns));
    }

    // 허용 도구
    if (allowedTools && Array.isArray(allowedTools) && allowedTools.length > 0) {
      args.push('--allowedTools', allowedTools.join(','));
    }

    // 차단 도구
    if (disallowedTools && Array.isArray(disallowedTools) && disallowedTools.length > 0) {
      args.push('--disallowedTools', disallowedTools.join(','));
    }

    // 시스템 프롬프트
    if (systemPrompt && typeof systemPrompt === 'string') {
      args.push('--system-prompt', systemPrompt);
    }

    // 추가 시스템 프롬프트
    if (appendSystemPrompt && typeof appendSystemPrompt === 'string') {
      args.push('--append-system-prompt', appendSystemPrompt);
    }

    // MCP 서버 설정 추가
    if (MCP_SERVERS.length > 0) {
      const mcpConfig: Record<string, unknown> = {};
      for (const server of MCP_SERVERS) {
        if (server.transport === 'http' || server.transport === 'sse') {
          mcpConfig[server.name] = {
            transport: server.transport,
            url: server.url,
          };
        } else {
          mcpConfig[server.name] = {
            transport: 'stdio',
            command: server.command,
            args: server.args || [],
            env: server.env || {},
          };
        }
      }
      args.push('--mcp-config', JSON.stringify(mcpConfig));
    }

    // 서브에이전트 설정 추가
    const mergedAgents: Record<string, CustomAgent> = {};

    // 기본 에이전트 추가 (useDefaultAgents가 true인 경우)
    if (useDefaultAgents) {
      Object.assign(mergedAgents, DEFAULT_AGENTS);
    }

    // 사용자 정의 에이전트 추가 (기본 에이전트 덮어쓰기 가능)
    if (agents && typeof agents === 'object') {
      Object.assign(mergedAgents, agents);
    }

    // 에이전트가 있으면 CLI에 추가
    if (Object.keys(mergedAgents).length > 0) {
      args.push('--agents', JSON.stringify(mergedAgents));
    }

    // Prompt is sent via stdin to avoid OS arg length limits for large documents
    console.log(`Executing Claude Code [${model || 'opus'}]: ${claudePath} ${args.join(' ')} (prompt via stdin, ${finalPrompt.length} chars)`);

    // Execute Claude Code using spawn
    const output = await new Promise<string>((resolve, reject) => {
      // CLAUDECODE 환경변수 제거 (중첩 세션 방지)
      const cleanEnv = { ...process.env };
      delete cleanEnv.CLAUDECODE;
      const child = spawn(claudePath, args, {
        cwd: process.cwd(),
        env: {
          ...cleanEnv,
          PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
          TERM: 'xterm-256color',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Send prompt via stdin (handles arbitrarily large prompts)
      child.stdin.write(finalPrompt);
      child.stdin.end();

      let stdoutData = '';
      let stderrData = '';

      child.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderrData += data.toString();
      });

      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Claude request timed out'));
      }, 1800000); // 30분 타임아웃

      child.on('close', (code, signal) => {
        clearTimeout(timeout);

        if (code === 0) {
          resolve(stdoutData);
        } else {
          const errorMsg = `Process exited with code ${code}, signal ${signal}`;
          const fullError = stderrData ? `${errorMsg}\nStderr: ${stderrData}` : errorMsg;
          reject(new Error(fullError));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Parse stream-json output (multiple JSON objects, one per line)
    const lines = output.trim().split('\n');
    const messages: ClaudeMessage[] = [];
    const streamEvents: ClaudeMessage[] = [];
    let initData: ClaudeMessage | null = null;
    let resultData: ClaudeMessage | null = null;
    const toolsUsed: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ClaudeMessage;
        messages.push(parsed);

        if (parsed.type === 'system' && parsed.subtype === 'init') {
          initData = parsed;
        }

        if (parsed.type === 'stream_event') {
          streamEvents.push(parsed);
        }

        if (parsed.type === 'result') {
          resultData = parsed;
        }

        // Track tool usage
        if (parsed.type === 'assistant' && parsed.message?.content) {
          for (const content of parsed.message.content) {
            if (content.type === 'tool_use' && content.name) {
              if (!toolsUsed.includes(content.name)) {
                toolsUsed.push(content.name);
              }
            }
          }
        }
      } catch {
        console.error('Failed to parse line:', line.substring(0, 100));
      }
    }

    if (!resultData) {
      return NextResponse.json(
        { error: 'No result in Claude response', raw: output.substring(0, 1000) },
        { status: 500 }
      );
    }

    const response: ClaudeAPIResponse = {
      success: !resultData.is_error,
      result: resultData.result || '',
      messages,
      stream_events: streamEvents,
      raw_output: output,
      metadata: {
        session_id: resultData.session_id || '',
        duration_ms: resultData.duration_ms || 0,
        duration_api_ms: resultData.duration_api_ms || 0,
        num_turns: resultData.num_turns || 0,
        cost_usd: resultData.total_cost_usd || 0,
        tools_used: toolsUsed,
        model: 'opus',
        usage: resultData.usage || {},
        modelUsage: resultData.modelUsage || {},
        permission_denials: resultData.permission_denials || [],
      },
      init: {
        cwd: initData?.cwd || '',
        tools: initData?.tools || [],
        agents: initData?.agents || [],
        slash_commands: initData?.slash_commands || [],
        mcp_servers: initData?.mcp_servers || [],
        model: initData?.model || 'opus',
        permissionMode: initData?.permissionMode || '',
        claude_code_version: initData?.claude_code_version || '',
        output_style: initData?.output_style || '',
      },
    };

    // temp 이미지 파일 정리
    if (imageTempDir) {
      try { rmSync(imageTempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    return NextResponse.json(response);
  } catch (error: unknown) {
    console.error('Claude API error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return NextResponse.json(
      { error: 'Failed to execute Claude', details: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * GET endpoint for documentation
 */
export async function GET() {
  return NextResponse.json({
    message: 'Claude Code API Wrapper',
    model: 'opus (default), sonnet, haiku 선택 가능',
    mcp_servers: MCP_SERVERS.map(s => s.name),
    default_agents: Object.keys(DEFAULT_AGENTS),
    usage: 'POST /api/claude with { "prompt": "your prompt here" }',
    options: {
      prompt: 'string (required) - The prompt to send to Claude',
      allowedTools: 'string[] (optional) - Tools to allow (e.g., ["WebSearch", "Read"])',
      disallowedTools: 'string[] (optional) - Tools to block (e.g., ["Edit", "Write"])',
      systemPrompt: 'string (optional) - Custom system prompt',
      appendSystemPrompt: 'string (optional) - Append to default system prompt',
      agents: 'Record<string, CustomAgent> (optional) - Custom subagents',
      useDefaultAgents: 'boolean (optional, default: true) - Include default agents',
      images: 'Array<{data: string, media_type?: string, filename?: string}> (optional) - Base64 encoded images for vision/OCR',
      model: 'string (optional, default: "opus") - "opus" | "sonnet" | "haiku"',
      maxTurns: 'number (optional) - Max agentic turns (e.g., 2 for simple image analysis)',
    },
    agent_schema: {
      description: 'string (required) - When Claude should delegate to this agent',
      prompt: 'string (required) - System prompt for the agent',
      tools: 'string[] (optional) - Allowed tools',
      disallowedTools: 'string[] (optional) - Blocked tools',
      model: 'sonnet | opus | haiku | inherit (optional)',
      permissionMode: 'default | acceptEdits | bypassPermissions | plan (optional)',
    },
    available_tools: [
      'Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write',
      'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill',
    ],
    examples: {
      basic: {
        method: 'POST',
        url: '/api/claude',
        body: {
          prompt: '삼성전자 주가 분석해줘',
        },
      },
      with_custom_agent: {
        method: 'POST',
        url: '/api/claude',
        body: {
          prompt: '최신 AI 뉴스를 요약해줘',
          agents: {
            'news-researcher': {
              description: '뉴스 리서치 전문가. 최신 뉴스 검색 및 요약에 사용.',
              prompt: '당신은 뉴스 리서처입니다. 최신 뉴스를 검색하고 핵심만 요약하세요.',
              tools: ['WebSearch', 'WebFetch'],
              model: 'haiku',
            },
          },
        },
      },
    },
  });
}
