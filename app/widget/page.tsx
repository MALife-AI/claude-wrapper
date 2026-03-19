'use client';

/**
 * widget/page.tsx
 * Minimal shell page for iframe-embedding the chatbot widget.
 * Renders with zero chrome: no padding, transparent body, no scrollbars.
 * The actual chat UI is the /chatbot page mounted inside an iframe.
 *
 * Usage inside any web page:
 *   <iframe src="http://localhost:3001/widget" style="border:none;width:400px;height:600px;" />
 *
 * Or use chatbot_widget.py to inject the floating button into Streamlit.
 */

import { useEffect, useRef, useState } from 'react';

export default function WidgetPage() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);

  // Relay postMessage events from parent window into the embedded chatbot,
  // allowing the host page to pre-fill prompts programmatically:
  //   window.postMessage({ type: 'chatbot:prompt', text: '...' }, '*')
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const iframeEl = iframeRef.current;
      if (!iframeEl?.contentWindow) return;
      if (event.data?.type === 'chatbot:prompt') {
        iframeEl.contentWindow.postMessage(event.data, '*');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <>
      <style>{`
        *,*::before,*::after{box-sizing:border-box}
        html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}

        @keyframes fadeIn{from{opacity:0}to{opacity:1}}
        .iframe-wrap{animation:fadeIn .25s ease-out}

        /* Loading skeleton */
        @keyframes shimmer{
          0%{background-position:-400px 0}
          100%{background-position:400px 0}
        }
        .skeleton{
          background:linear-gradient(90deg,#1B2838 25%,#243447 50%,#1B2838 75%);
          background-size:800px 100%;
          animation:shimmer 1.6s infinite linear;
        }
      `}</style>

      <div
        style={{
          width: '100%',
          height: '100vh',
          position: 'relative',
          background: '#0d1520',
        }}
      >
        {/* Loading skeleton shown until iframe is ready */}
        {!loaded && (
          <div
            className="skeleton"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              color: '#334155',
              fontSize: '12px',
            }}
          >
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '50%',
                background: 'linear-gradient(135deg,#1e3a5f,#0d47a1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '14px',
                fontWeight: 700,
                color: '#93c5fd',
              }}
            >
              AI
            </div>
            <span>로딩 중...</span>
          </div>
        )}

        <iframe
          ref={iframeRef}
          src="/chatbot"
          title="변액운용 AI 어시스턴트"
          className={loaded ? 'iframe-wrap' : ''}
          onLoad={() => setLoaded(true)}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            display: loaded ? 'block' : 'none',
            background: 'transparent',
          }}
          allow="clipboard-write"
          // sandbox keeps the chatbot isolated while still allowing scripts
          // and same-origin fetch to /api/claude/stream
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      </div>
    </>
  );
}
