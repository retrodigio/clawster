import type { ConversationEvent } from '../../lib/api';
import { User } from 'lucide-react';

interface Props {
  event: ConversationEvent;
}

export default function UserRow({ event }: Props) {
  const text = String(event.data.text ?? event.data.content ?? '');

  return (
    <div className="flex justify-end px-4 py-2">
      <div className="flex items-start gap-2 max-w-[80%]">
        <div className="bg-terminal-accent/15 border border-terminal-accent/30 rounded-lg px-3 py-2">
          <p className="text-xs text-terminal-fg whitespace-pre-wrap">{text}</p>
        </div>
        <div className="w-5 h-5 rounded bg-terminal-accent/20 flex items-center justify-center shrink-0 mt-0.5">
          <User size={12} className="text-terminal-accent" />
        </div>
      </div>
    </div>
  );
}
