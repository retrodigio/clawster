import type { ConversationEvent } from '../../lib/api';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface Props {
  event: ConversationEvent;
}

export default function TextRow({ event }: Props) {
  const text = String(event.data.text ?? event.data.content ?? '');
  if (!text.trim()) return null;

  return (
    <div className="px-4 py-2">
      <div className="prose prose-invert prose-xs max-w-none text-terminal-fg text-xs leading-relaxed [&_p]:mb-2 [&_pre]:my-2 [&_ul]:mb-2 [&_ol]:mb-2 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_code]:text-[11px] [&_code]:bg-terminal-bg [&_code]:px-1 [&_code]:rounded">
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
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
}
