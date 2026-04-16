import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { Circle } from 'lucide-react';

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return '--';
  const diff = Date.now() - new Date(dateStr).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function shortenPath(path: string): string {
  const home = '/Users/chriscrabtree/';
  if (path.startsWith(home)) return '~/' + path.slice(home.length);
  return path;
}

type AgentStatus = 'running' | 'has-session' | 'idle';

function getStatus(agentId: string, sessions: Record<string, { sessionId: string | null }>, streaming: boolean, activeAgentId: string | null): AgentStatus {
  if (streaming && activeAgentId === agentId) return 'running';
  const session = sessions[agentId];
  if (session?.sessionId) return 'has-session';
  return 'idle';
}

function statusColor(status: AgentStatus): string {
  switch (status) {
    case 'running': return 'text-terminal-running animate-pulse';
    case 'has-session': return 'text-terminal-success';
    case 'idle': return 'text-terminal-muted';
  }
}

export default function SessionsPage() {
  const { agents, sessions, streaming, activeAgentId, loadAll } = useStore();
  const navigate = useNavigate();

  useEffect(() => {
    loadAll();
    const interval = setInterval(() => {
      useStore.getState().loadSessions();
    }, 10000);
    return () => clearInterval(interval);
  }, [loadAll]);

  // Sort: agents with sessions first, then alphabetically
  const sorted = [...agents].sort((a, b) => {
    const aHas = sessions[a.id]?.sessionId ? 1 : 0;
    const bHas = sessions[b.id]?.sessionId ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-terminal-fg">Sessions</h2>
        <span className="text-[10px] text-terminal-muted">
          {agents.length} agents / {Object.values(sessions).filter(s => s.sessionId).length} active
        </span>
      </div>

      <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-terminal-border text-terminal-muted">
              <th className="text-left px-3 py-2 w-8"></th>
              <th className="text-left px-3 py-2 font-medium">Agent</th>
              <th className="text-left px-3 py-2 font-medium">Workspace</th>
              <th className="text-right px-3 py-2 font-medium">Messages</th>
              <th className="text-right px-3 py-2 font-medium">Last Activity</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((agent) => {
              const session = sessions[agent.id];
              const status = getStatus(agent.id, sessions, streaming, activeAgentId);
              const hasSession = session?.sessionId;

              return (
                <tr
                  key={agent.id}
                  onClick={() => navigate(`/sessions/${agent.id}`)}
                  className={`border-b border-terminal-border last:border-b-0 cursor-pointer transition-colors hover:bg-terminal-accent/5 ${
                    !hasSession ? 'opacity-50' : ''
                  }`}
                >
                  <td className="px-3 py-2">
                    <Circle size={8} className={`fill-current ${statusColor(status)}`} />
                  </td>
                  <td className="px-3 py-2 text-terminal-fg font-medium">
                    {agent.name}
                    {agent.isDefault && (
                      <span className="ml-2 text-[10px] text-terminal-accent bg-terminal-accent/10 px-1 rounded">
                        default
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-terminal-muted">
                    {shortenPath(agent.workspace)}
                  </td>
                  <td className="px-3 py-2 text-right text-terminal-muted">
                    {session?.messageCount ?? 0}
                  </td>
                  <td className="px-3 py-2 text-right text-terminal-muted">
                    {relativeTime(session?.lastActivity ?? null)}
                  </td>
                </tr>
              );
            })}
            {agents.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-terminal-muted">
                  No agents configured
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
