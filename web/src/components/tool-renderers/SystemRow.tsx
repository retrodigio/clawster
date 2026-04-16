import type { ConversationEvent } from '../../lib/api';

interface Props {
  event: ConversationEvent;
}

export default function SystemRow({ event }: Props) {
  const text = String(event.data.text ?? event.data.message ?? '');
  const isError = Boolean(event.data.isError);

  return (
    <div className="flex justify-center px-4 py-1">
      <span className={`text-[10px] ${isError ? 'text-terminal-error' : 'text-terminal-muted'}`}>
        {text}
      </span>
    </div>
  );
}
