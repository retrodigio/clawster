import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { addAgent, removeAgent } from '../lib/api';
import * as Dialog from '@radix-ui/react-dialog';
import { Plus, Trash2, Circle, X } from 'lucide-react';

export default function AgentsPage() {
  const { agents, sessions, loadAgents, loadSessions } = useStore();
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newWorkspace, setNewWorkspace] = useState('');
  const [newChatId, setNewChatId] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    loadAgents();
    loadSessions();
  }, [loadAgents, loadSessions]);

  const handleAdd = async () => {
    if (!newName.trim() || !newWorkspace.trim()) return;
    setAdding(true);
    try {
      await addAgent({
        id: newName.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        name: newName.trim(),
        workspace: newWorkspace.trim(),
        telegramChatId: newChatId.trim(),
      });
      setDialogOpen(false);
      setNewName('');
      setNewWorkspace('');
      setNewChatId('');
      await loadAgents();
    } catch {
      // ignore
    }
    setAdding(false);
  };

  const handleRemove = async (id: string) => {
    if (!confirm(`Remove agent "${id}"? This cannot be undone.`)) return;
    setRemoving(id);
    try {
      await removeAgent(id);
      await loadAgents();
    } catch {
      // ignore
    }
    setRemoving(null);
  };

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-terminal-fg">Agents</h2>
        <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
          <Dialog.Trigger asChild>
            <button className="flex items-center gap-1 text-xs text-terminal-accent hover:text-terminal-accent-dim transition-colors">
              <Plus size={13} />
              Add Agent
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 bg-black/60" />
            <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-terminal-surface border border-terminal-border rounded-lg p-6 w-[400px]">
              <div className="flex items-center justify-between mb-4">
                <Dialog.Title className="text-sm font-semibold text-terminal-fg">
                  Add Agent
                </Dialog.Title>
                <Dialog.Close asChild>
                  <button className="text-terminal-muted hover:text-terminal-fg">
                    <X size={14} />
                  </button>
                </Dialog.Close>
              </div>
              <div className="flex flex-col gap-3">
                <div>
                  <label className="block text-[10px] text-terminal-muted mb-1">Name</label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="MyProject"
                    className="bg-terminal-bg border border-terminal-border rounded-md px-3 py-2 w-full text-xs text-terminal-fg focus:outline-none focus:border-terminal-accent"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-terminal-muted mb-1">Workspace Path</label>
                  <input
                    type="text"
                    value={newWorkspace}
                    onChange={(e) => setNewWorkspace(e.target.value)}
                    placeholder="/Users/chriscrabtree/projects/myproject"
                    className="bg-terminal-bg border border-terminal-border rounded-md px-3 py-2 w-full text-xs text-terminal-fg focus:outline-none focus:border-terminal-accent"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-terminal-muted mb-1">Telegram Chat ID</label>
                  <input
                    type="text"
                    value={newChatId}
                    onChange={(e) => setNewChatId(e.target.value)}
                    placeholder="-100XXXXXXXXXX"
                    className="bg-terminal-bg border border-terminal-border rounded-md px-3 py-2 w-full text-xs text-terminal-fg focus:outline-none focus:border-terminal-accent"
                  />
                </div>
                <button
                  onClick={handleAdd}
                  disabled={adding || !newName.trim() || !newWorkspace.trim()}
                  className="mt-2 bg-terminal-accent text-white px-4 py-2 rounded-md text-xs font-medium hover:bg-terminal-accent-dim transition-colors disabled:opacity-50"
                >
                  {adding ? 'Adding...' : 'Add Agent'}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>

      <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-terminal-border text-terminal-muted">
              <th className="text-left px-3 py-2 w-8"></th>
              <th className="text-left px-3 py-2 font-medium">Name</th>
              <th className="text-left px-3 py-2 font-medium">Workspace</th>
              <th className="text-left px-3 py-2 font-medium">Chat ID</th>
              <th className="text-left px-3 py-2 font-medium">Heartbeat</th>
              <th className="text-right px-3 py-2 font-medium">Session</th>
              <th className="text-right px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const session = sessions[agent.id];
              const hasSession = session?.sessionId;

              return (
                <tr
                  key={agent.id}
                  onClick={() => navigate(`/agents/${agent.id}`)}
                  className="border-b border-terminal-border last:border-b-0 cursor-pointer transition-colors hover:bg-terminal-accent/5"
                >
                  <td className="px-3 py-2">
                    <Circle
                      size={8}
                      className={`fill-current ${hasSession ? 'text-terminal-success' : 'text-terminal-muted'}`}
                    />
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
                    {agent.workspace.replace('/Users/chriscrabtree/', '~/')}
                  </td>
                  <td className="px-3 py-2 text-terminal-muted">
                    {agent.telegramChatId}
                  </td>
                  <td className="px-3 py-2 text-terminal-muted">
                    {agent.heartbeat ? agent.heartbeat.every : '--'}
                  </td>
                  <td className="px-3 py-2 text-right text-terminal-muted">
                    {session?.messageCount ?? 0} msgs
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemove(agent.id);
                      }}
                      disabled={removing === agent.id}
                      className="text-terminal-muted hover:text-terminal-error transition-colors p-1 disabled:opacity-50"
                      title="Remove agent"
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {agents.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-terminal-muted">
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
