import type { ConversationEvent } from '../lib/api';
import ToolUseRow from './tool-renderers/ToolUseRow';
import ToolResultRow from './tool-renderers/ToolResultRow';
import ThinkingRow from './tool-renderers/ThinkingRow';
import TextRow from './tool-renderers/TextRow';
import UserRow from './tool-renderers/UserRow';
import SystemRow from './tool-renderers/SystemRow';

interface EventRowProps {
  event: ConversationEvent;
}

export default function EventRow({ event }: EventRowProps) {
  switch (event.type) {
    case 'user':
      return <UserRow event={event} />;
    case 'assistant':
    case 'text_delta':
      return <TextRow event={event} />;
    case 'tool_use':
      return <ToolUseRow event={event} />;
    case 'tool_result':
      return <ToolResultRow event={event} />;
    case 'thinking':
      return <ThinkingRow event={event} />;
    case 'result':
      return <TextRow event={event} />;
    case 'system':
      return <SystemRow event={event} />;
    default:
      return (
        <div className="px-4 py-1 text-[10px] text-terminal-muted">
          Unknown event: {event.type}
        </div>
      );
  }
}
