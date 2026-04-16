import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { fetchAgent, fetchSession, clearSession, type Agent, type Session } from '../lib/api';
import { ArrowLeft, MessageSquare, Trash2, Clock, Folder, Hash } from 'lucide-react';

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  return new Date(dateStr).toLocaleString();
}

function truncate(str: string, len: number): string {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

export default function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!agentId) return;
    fetchAgent(agentId).then(setAgent).catch(() => {});
    fetchSession(agentId).then(setSession).catch(() => {});
  }, [agentId]);

  if (!agent) {
    return <div className="p-5 text-terminal-muted text-xs">Loading...</div>;
  }

  const handleClear = async () => {
    if (!agentId) return;
    setClearing(true);
    try {
      await clearSession(agentId);
      setSession(await fetchSession(agentId));
    } catch {
      // ignore
    }
    setClearing(false);
  };

  return (
    <div className="p-5">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-terminal-muted mb-5">
        <Link to="/agents" className="hover:text-terminal-fg transition-colors flex items-center gap-1">
          <ArrowLeft size={12} />
          Agents
        </Link>
        <span>/</span>
        <span className="text-terminal-fg">{agent.name}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl">
        {/* Configuration */}
        <div className="bg-terminal-surface border border-terminal-border rounded-lg p-4">
          <h3 className="text-xs font-semibold text-terminal-fg mb-3">Configuration</h3>
          <div className="flex flex-col gap-2.5 text-xs">
            <div className="flex items-center gap-2">
              <Hash size={11} className="text-terminal-muted" />
              <span className="text-terminal-muted">ID:</span>
              <span className="text-terminal-fg">{agent.id}</span>
            </div>
            <div className="flex items-center gap-2">
              <Folder size={11} className="text-terminal-muted" />
              <span className="text-terminal-muted">Workspace:</span>
              <span className="text-terminal-fg">{agent.workspace}</span>
            </div>
            <div className="flex items-center gap-2">
              <MessageSquare size={11} className="text-terminal-muted" />
              <span className="text-terminal-muted">Chat ID:</span>
              <span className="text-terminal-fg">{agent.telegramChatId}</span>
            </div>
            {agent.isDefault && (
              <span className="inline-block w-fit bg-terminal-accent/20 text-terminal-accent text-[10px] px-2 py-0.5 rounded">
                Default Agent
              </span>
            )}
            {agent.heartbeat && (
              <div className="flex items-center gap-2">
                <Clock size={11} className="text-terminal-muted" />
                <span className="text-terminal-muted">Heartbeat:</span>
                <span className="text-terminal-fg">
                  Every {agent.heartbeat.every}
                  {agent.heartbeat.activeHours && (
                    <span className="text-terminal-muted">
                      {' '}({agent.heartbeat.activeHours.start}-{agent.heartbeat.activeHours.end})
                    </span>
                  )}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Session */}
        <div className="bg-terminal-surface border border-terminal-border rounded-lg p-4">
          <h3 className="text-xs font-semibold text-terminal-fg mb-3">Session</h3>
          <div className="flex flex-col gap-2.5 text-xs">
            <div>
              <span className="text-terminal-muted">Session ID: </span>
              <span className="text-terminal-fg">{session?.sessionId ? truncate(session.sessionId, 20) : 'None'}</span>
            </div>
            <div>
              <span className="text-terminal-muted">Messages: </span>
              <span className="text-terminal-fg">{session?.messageCount ?? 0}</span>
            </div>
            <div>
              <span className="text-terminal-muted">Last Activity: </span>
              <span className="text-terminal-fg">{formatDate(session?.lastActivity ?? null)}</span>
            </div>
            <div>
              <span className="text-terminal-muted">Last Heartbeat: </span>
              <span className="text-terminal-fg">{formatDate(session?.lastHeartbeat ?? null)}</span>
            </div>
            <div className="flex items-center gap-3 mt-2">
              <button
                onClick={() => navigate(`/sessions/${agent.id}`)}
                className="bg-terminal-accent text-white px-4 py-1.5 rounded-md text-xs hover:bg-terminal-accent-dim transition-colors"
              >
                Open Session
              </button>
              <button
                onClick={handleClear}
                disabled={clearing}
                className="flex items-center gap-1 text-terminal-error text-xs hover:underline disabled:opacity-50"
              >
                <Trash2 size={11} />
                {clearing ? 'Clearing...' : 'Clear'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Topics */}
      {agent.topics && Object.keys(agent.topics).length > 0 && (
        <div className="mt-5 max-w-4xl">
          <h3 className="text-xs font-semibold text-terminal-fg mb-2">Topics</h3>
          <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-terminal-border">
                  <th className="text-left px-3 py-1.5 text-terminal-muted font-normal">#</th>
                  <th className="text-left px-3 py-1.5 text-terminal-muted font-normal">Name</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(agent.topics).map(([id, topic]) => (
                  <tr key={id} className="border-b border-terminal-border last:border-b-0">
                    <td className="px-3 py-1.5 text-terminal-fg">{id}</td>
                    <td className="px-3 py-1.5 text-terminal-fg">{topic.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tasks */}
      {agent.tasks && agent.tasks.length > 0 && (
        <div className="mt-5 max-w-4xl">
          <h3 className="text-xs font-semibold text-terminal-fg mb-2">Tasks</h3>
          <div className="bg-terminal-surface border border-terminal-border rounded-lg p-3">
            <div className="flex flex-col gap-1.5">
              {agent.tasks.map((task, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className={`w-1.5 h-1.5 rounded-full ${task.enabled !== false ? 'bg-terminal-success' : 'bg-terminal-error'}`} />
                  <code className="text-terminal-muted">{task.schedule}</code>
                  <span className="text-terminal-fg">{task.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
