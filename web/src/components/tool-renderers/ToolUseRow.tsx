import type { ConversationEvent } from '../../lib/api';
import {
  Terminal,
  FileText,
  FilePlus,
  Pencil,
  Search,
  Users,
  Globe,
  ListTodo,
  Wrench,
} from 'lucide-react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';

const toolIcons: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  Bash: Terminal,
  Read: FileText,
  Write: FilePlus,
  Edit: Pencil,
  Grep: Search,
  Glob: Search,
  Agent: Users,
  WebFetch: Globe,
  WebSearch: Globe,
  TodoWrite: ListTodo,
};

function getIcon(toolName: string) {
  return toolIcons[toolName] || Wrench;
}

function getPreview(toolName: string, data: Record<string, unknown>): string {
  const input = (data.input ?? data) as Record<string, unknown>;
  switch (toolName) {
    case 'Bash':
      return String(input.command ?? input.detail ?? '');
    case 'Read':
      return String(input.file_path ?? '');
    case 'Write':
      return String(input.file_path ?? '');
    case 'Edit':
      return String(input.file_path ?? '') +
        (input.old_string ? ` : ${String(input.old_string).slice(0, 50)}` : '');
    case 'Grep':
      return `${String(input.pattern ?? '')} ${input.path ? `in ${String(input.path)}` : ''}`.trim();
    case 'Glob':
      return String(input.pattern ?? '');
    default:
      return String(input.detail ?? input.name ?? '');
  }
}

function formatElapsed(ms: unknown): string {
  if (typeof ms !== 'number') return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

interface Props {
  event: ConversationEvent;
}

export default function ToolUseRow({ event }: Props) {
  const [open, setOpen] = useState(false);
  const toolName = String(event.data.name ?? event.data.tool ?? 'tool');
  const Icon = getIcon(toolName);
  const preview = getPreview(toolName, event.data);
  const elapsed = event.data.elapsed;
  const input = event.data.input as Record<string, unknown> | undefined;

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger asChild>
        <div className="flex items-center gap-2 px-4 py-1 cursor-pointer hover:bg-terminal-accent/5 transition-colors group">
          <div className="w-4 h-4 flex items-center justify-center text-terminal-accent shrink-0">
            <Icon size={13} />
          </div>
          <span className="text-terminal-accent text-xs font-medium shrink-0">
            {toolName}
          </span>
          <span className="text-terminal-muted text-xs truncate flex-1">
            {preview}
          </span>
          {elapsed != null && (
            <span className="text-[10px] text-terminal-muted shrink-0">
              {formatElapsed(elapsed)}
            </span>
          )}
          <ChevronRight
            size={12}
            className={`text-terminal-muted transition-transform shrink-0 ${open ? 'rotate-90' : ''}`}
          />
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content>
        {input && Object.keys(input).length > 0 && (
          <div className="ml-10 mr-4 mb-1 px-3 py-2 bg-terminal-bg border border-terminal-border rounded text-[11px] text-terminal-muted overflow-x-auto">
            <pre className="whitespace-pre-wrap break-all">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
        )}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
