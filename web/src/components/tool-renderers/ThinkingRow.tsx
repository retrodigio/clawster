import type { ConversationEvent } from '../../lib/api';
import * as Collapsible from '@radix-ui/react-collapsible';
import { useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';

interface Props {
  event: ConversationEvent;
}

export default function ThinkingRow({ event }: Props) {
  const text = String(event.data.text ?? event.data.content ?? '');
  const isLong = text.length > 200;
  const [open, setOpen] = useState(false);

  if (!text.trim()) {
    return (
      <div className="flex items-center gap-2 px-4 py-0.5">
        <Brain size={12} className="text-terminal-muted" />
        <span className="text-[11px] text-terminal-muted italic">Thinking...</span>
      </div>
    );
  }

  if (!isLong) {
    return (
      <div className="flex items-start gap-2 px-4 py-1">
        <Brain size={12} className="text-terminal-muted shrink-0 mt-0.5" />
        <p className="text-[11px] text-terminal-muted italic leading-relaxed">{text}</p>
      </div>
    );
  }

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <div className="flex items-start gap-2 px-4 py-1 cursor-pointer hover:bg-terminal-accent/5 transition-colors">
          <Brain size={12} className="text-terminal-muted shrink-0 mt-0.5" />
          <p className="text-[11px] text-terminal-muted italic leading-relaxed flex-1">
            {open ? text : text.slice(0, 200) + '...'}
          </p>
          <ChevronRight
            size={12}
            className={`text-terminal-muted transition-transform shrink-0 mt-0.5 ${open ? 'rotate-90' : ''}`}
          />
        </div>
      </Collapsible.Trigger>
    </Collapsible.Root>
  );
}
