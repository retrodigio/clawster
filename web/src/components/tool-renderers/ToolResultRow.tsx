import type { ConversationEvent } from '../../lib/api';
import * as Collapsible from '@radix-ui/react-collapsible';
import { useState } from 'react';
import { ChevronRight, CheckCircle, XCircle } from 'lucide-react';

interface Props {
  event: ConversationEvent;
}

export default function ToolResultRow({ event }: Props) {
  const [open, setOpen] = useState(false);
  const output = String(event.data.output ?? event.data.content ?? event.data.text ?? '');
  const isError = Boolean(event.data.is_error ?? event.data.isError);
  const lines = output.split('\n');
  const lineCount = lines.length;
  const preview = lines.slice(0, 3).join('\n');
  const hasMore = lineCount > 3;

  if (!output.trim()) {
    return (
      <div className="flex items-center gap-2 px-4 py-0.5 ml-4">
        <CheckCircle size={11} className="text-terminal-success shrink-0" />
        <span className="text-[10px] text-terminal-muted">(empty output)</span>
      </div>
    );
  }

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <div className="flex items-start gap-2 px-4 py-1 ml-4 cursor-pointer hover:bg-terminal-accent/5 transition-colors">
          {isError ? (
            <XCircle size={11} className="text-terminal-error shrink-0 mt-0.5" />
          ) : (
            <CheckCircle size={11} className="text-terminal-success shrink-0 mt-0.5" />
          )}
          <div className="flex-1 min-w-0">
            <pre className="text-[11px] text-terminal-muted whitespace-pre-wrap break-all leading-relaxed">
              {open ? output : preview}
            </pre>
            {hasMore && !open && (
              <span className="text-[10px] text-terminal-accent">
                ... {lineCount} lines
              </span>
            )}
          </div>
          {hasMore && (
            <ChevronRight
              size={12}
              className={`text-terminal-muted transition-transform shrink-0 mt-0.5 ${open ? 'rotate-90' : ''}`}
            />
          )}
        </div>
      </Collapsible.Trigger>
    </Collapsible.Root>
  );
}
