import { useEffect, useState } from 'react';
import { fetchConfig, updateConfig, type Config } from '../lib/api';
import { useStore } from '../store';
import { Save, Check } from 'lucide-react';

export default function SettingsPage() {
  const { status } = useStore();
  const [config, setConfig] = useState<Config | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchConfig().then(setConfig).catch(() => {});
    useStore.getState().loadStatus();
  }, []);

  const handleChange = (field: keyof Config, value: string | number) => {
    if (!config) return;
    setConfig({ ...config, [field]: value });
    setSaved(false);
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await updateConfig({
        allowedUserId: config.allowedUserId,
        timezone: config.timezone,
        claudePath: config.claudePath,
        healthPort: config.healthPort,
        maxConcurrent: config.maxConcurrent,
      });
      setSaved(true);
    } catch {
      // ignore
    }
    setSaving(false);
  };

  if (!config) {
    return <div className="p-5 text-terminal-muted text-xs">Loading...</div>;
  }

  const maskedToken = config.botToken
    ? config.botToken.slice(0, 6) + '...' + config.botToken.slice(-4)
    : '';

  return (
    <div className="p-5">
      <h2 className="text-sm font-semibold text-terminal-fg mb-4">Settings</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl">
        {/* Config form */}
        <div className="bg-terminal-surface border border-terminal-border rounded-lg p-4">
          <h3 className="text-xs font-semibold text-terminal-fg mb-3">Configuration</h3>
          <div className="flex flex-col gap-3">
            <div>
              <label className="block text-[10px] text-terminal-muted mb-1">Bot Token</label>
              <input
                type="text"
                value={maskedToken}
                disabled
                className="bg-terminal-bg border border-terminal-border rounded-md px-3 py-1.5 w-full text-xs text-terminal-muted"
              />
            </div>
            <div>
              <label className="block text-[10px] text-terminal-muted mb-1">Allowed User ID</label>
              <input
                type="text"
                value={config.allowedUserId}
                onChange={(e) => handleChange('allowedUserId', e.target.value)}
                className="bg-terminal-bg border border-terminal-border rounded-md px-3 py-1.5 w-full text-xs text-terminal-fg focus:outline-none focus:border-terminal-accent"
              />
            </div>
            <div>
              <label className="block text-[10px] text-terminal-muted mb-1">Timezone</label>
              <input
                type="text"
                value={config.timezone}
                onChange={(e) => handleChange('timezone', e.target.value)}
                className="bg-terminal-bg border border-terminal-border rounded-md px-3 py-1.5 w-full text-xs text-terminal-fg focus:outline-none focus:border-terminal-accent"
              />
            </div>
            <div>
              <label className="block text-[10px] text-terminal-muted mb-1">Claude Path</label>
              <input
                type="text"
                value={config.claudePath}
                onChange={(e) => handleChange('claudePath', e.target.value)}
                className="bg-terminal-bg border border-terminal-border rounded-md px-3 py-1.5 w-full text-xs text-terminal-fg focus:outline-none focus:border-terminal-accent"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] text-terminal-muted mb-1">Health Port</label>
                <input
                  type="number"
                  value={config.healthPort}
                  onChange={(e) => handleChange('healthPort', Number(e.target.value))}
                  className="bg-terminal-bg border border-terminal-border rounded-md px-3 py-1.5 w-full text-xs text-terminal-fg focus:outline-none focus:border-terminal-accent"
                />
              </div>
              <div>
                <label className="block text-[10px] text-terminal-muted mb-1">Max Concurrent</label>
                <input
                  type="number"
                  value={config.maxConcurrent}
                  onChange={(e) => handleChange('maxConcurrent', Number(e.target.value))}
                  className="bg-terminal-bg border border-terminal-border rounded-md px-3 py-1.5 w-full text-xs text-terminal-fg focus:outline-none focus:border-terminal-accent"
                />
              </div>
            </div>
            <div className="flex items-center gap-3 mt-1">
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1 bg-terminal-accent text-white px-4 py-1.5 rounded-md text-xs font-medium hover:bg-terminal-accent-dim transition-colors disabled:opacity-50"
              >
                {saved ? <Check size={12} /> : <Save size={12} />}
                {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
              </button>
            </div>
          </div>
        </div>

        {/* System status */}
        <div className="bg-terminal-surface border border-terminal-border rounded-lg p-4">
          <h3 className="text-xs font-semibold text-terminal-fg mb-3">System Status</h3>
          {status ? (
            <div className="flex flex-col gap-2 text-xs">
              <div>
                <span className="text-terminal-muted">Status: </span>
                <span className={status.status === 'ok' ? 'text-terminal-success' : 'text-terminal-error'}>
                  {status.status}
                </span>
              </div>
              <div>
                <span className="text-terminal-muted">Uptime: </span>
                <span className="text-terminal-fg">{Math.floor(status.uptime / 3600)}h {Math.floor((status.uptime % 3600) / 60)}m</span>
              </div>
              <div>
                <span className="text-terminal-muted">PID: </span>
                <span className="text-terminal-fg">{status.pid}</span>
              </div>
              <div>
                <span className="text-terminal-muted">Agents: </span>
                <span className="text-terminal-fg">{status.agentCount}</span>
              </div>
              <div>
                <span className="text-terminal-muted">Active Sessions: </span>
                <span className="text-terminal-fg">{status.sessionCount}</span>
              </div>
              <div>
                <span className="text-terminal-muted">Max Concurrent: </span>
                <span className="text-terminal-fg">{status.maxConcurrent}</span>
              </div>
              <div>
                <span className="text-terminal-muted">Timezone: </span>
                <span className="text-terminal-fg">{status.timezone}</span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-terminal-muted">Loading status...</p>
          )}
        </div>
      </div>

      <p className="text-[10px] text-terminal-muted mt-4">Config: ~/.clawster/config.json</p>
    </div>
  );
}
