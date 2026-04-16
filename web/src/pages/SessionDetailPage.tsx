import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useStore } from '../store';
import EventRow from '../components/EventRow';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Send, ArrowLeft, Trash2, Loader2 } from 'lucide-react';

export default function SessionDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const {
    agents,
    events,
    streaming,
    streamText,
    openSession,
    sendMessage,
    clearEvents,
    activeAgentId,
  } = useStore();

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const agent = agents.find((a) => a.id === agentId);

  // Connect WS when entering page
  useEffect(() => {
    if (agentId && agentId !== activeAgentId) {
      openSession(agentId);
    }
    return () => {
      // Don't close on unmount — keep the connection for background streaming
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Load agents if not loaded
  useEffect(() => {
    if (agents.length === 0) {
      useStore.getState().loadAll();
    }
  }, [agents.length]);

  // Auto-scroll on new events
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events.length, streamText]);

  const handleSend = () => {
    if (!input.trim() || streaming) return;
    sendMessage(input);
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    // Auto-resize
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  };

  const shortenPath = (p: string) => {
    const home = '/Users/chriscrabtree/';
    return p.startsWith(home) ? '~/' + p.slice(home.length) : p;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-terminal-border bg-terminal-surface shrink-0">
        <Link to="/" className="text-terminal-muted hover:text-terminal-fg transition-colors">
          <ArrowLeft size={14} />
        </Link>
        <div className="flex-1 min-w-0">
          <span className="text-xs font-medium text-terminal-fg">
            {agent?.name ?? agentId}
          </span>
          {agent && (
            <span className="text-[10px] text-terminal-muted ml-2">
              {shortenPath(agent.workspace)}
            </span>
          )}
        </div>
        {streaming && (
          <div className="flex items-center gap-1 text-[10px] text-terminal-running">
            <Loader2 size={11} className="animate-spin" />
            Running
          </div>
        )}
        <button
          onClick={clearEvents}
          className="text-terminal-muted hover:text-terminal-error transition-colors p-1"
          title="Clear conversation"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Event Stream */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-2">
        {events.length === 0 && !streaming && (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-terminal-muted">
              Send a message to start a conversation with {agent?.name ?? 'this agent'}
            </p>
          </div>
        )}

        {/* Timeline with left border */}
        <div className="border-l border-terminal-border/50 ml-6">
          {events.map((event) => (
            <div key={event.id} className="relative">
              {/* Timeline dot */}
              <div className="absolute -left-[3px] top-2.5 w-1.5 h-1.5 rounded-full bg-terminal-border" />
              <EventRow event={event} />
            </div>
          ))}

          {/* Streaming text (while waiting for result event) */}
          {streaming && streamText && (
            <div className="relative">
              <div className="absolute -left-[3px] top-2.5 w-1.5 h-1.5 rounded-full bg-terminal-running animate-pulse" />
              <div className="px-4 py-2">
                <div className="prose prose-invert prose-xs max-w-none text-terminal-fg text-xs leading-relaxed [&_p]:mb-2 [&_pre]:my-2 [&_code]:text-[11px] [&_code]:bg-terminal-bg [&_code]:px-1 [&_code]:rounded">
                  <ReactMarkdown
                    components={{
                      code({ className, children, ...props }) {
                        const match = /language-(\w+)/.exec(className || '');
                        const code = String(children).replace(/\n$/, '');
                        if (match) {
                          return (
                            <SyntaxHighlighter
                              style={oneDark}
                              language={match[1]}
                              PreTag="div"
                              customStyle={{
                                margin: 0,
                                padding: '0.75rem',
                                fontSize: '11px',
                                borderRadius: '4px',
                                background: '#0a0a0f',
                              }}
                            >
                              {code}
                            </SyntaxHighlighter>
                          );
                        }
                        return (
                          <code className={className} {...props}>
                            {children}
                          </code>
                        );
                      },
                    }}
                  >
                    {streamText}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          )}

          {/* Streaming indicator with no text yet */}
          {streaming && !streamText && events.length > 0 && (
            <div className="relative">
              <div className="absolute -left-[3px] top-2.5 w-1.5 h-1.5 rounded-full bg-terminal-running animate-pulse" />
              <div className="px-4 py-2 flex items-center gap-2">
                <Loader2 size={12} className="text-terminal-running animate-spin" />
                <span className="text-[11px] text-terminal-muted">Processing...</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Input Bar */}
      <div className="border-t border-terminal-border bg-terminal-surface px-4 py-3 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleTextareaInput}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${agent?.name ?? 'agent'}...`}
            rows={1}
            disabled={streaming}
            className="flex-1 bg-terminal-bg border border-terminal-border rounded-md px-3 py-2 text-xs text-terminal-fg placeholder:text-terminal-muted focus:outline-none focus:border-terminal-accent resize-none disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={streaming || !input.trim()}
            className="bg-terminal-accent text-white p-2 rounded-md hover:bg-terminal-accent-dim transition-colors disabled:opacity-30 shrink-0"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
