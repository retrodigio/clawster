export interface Agent {
  id: string;
  name: string;
  workspace: string;
  telegramChatId: string;
  isDefault?: boolean;
  topics?: Record<string, { name: string }>;
  heartbeat?: { every: string; activeHours?: { start: string; end: string }; target: string; to: string };
  tasks?: { name: string; schedule: string; prompt: string; enabled?: boolean }[];
}

export interface Session {
  sessionId: string | null;
  lastActivity: string;
  lastHeartbeat: string | null;
  messageCount: number;
}

export interface SystemStatus {
  status: string;
  uptime: number;
  agentCount: number;
  sessionCount: number;
  maxConcurrent: number;
  pid: number;
  timezone: string;
}

export interface Config {
  botToken: string;
  allowedUserId: string;
  timezone: string;
  claudePath: string;
  healthPort: number;
  maxConcurrent: number;
}

export interface ConversationEvent {
  id: string;
  type: 'system' | 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'text_delta' | 'thinking' | 'result';
  timestamp: string;
  data: Record<string, unknown>;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export async function fetchAgents(): Promise<Agent[]> {
  return json<Agent[]>('/api/agents');
}

export async function fetchAgent(id: string): Promise<Agent> {
  return json<Agent>(`/api/agents/${id}`);
}

export async function fetchSession(agentId: string): Promise<Session> {
  return json<Session>(`/api/sessions/${agentId}`);
}

export async function fetchSessions(): Promise<Record<string, Session>> {
  return json<Record<string, Session>>('/api/sessions');
}

export async function fetchStatus(): Promise<SystemStatus> {
  return json<SystemStatus>('/api/status');
}

export async function fetchConfig(): Promise<Config> {
  return json<Config>('/api/config');
}

export async function updateConfig(config: Partial<Config>): Promise<void> {
  await json<void>('/api/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export async function addAgent(agent: Partial<Agent>): Promise<Agent> {
  return json<Agent>('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agent),
  });
}

export async function removeAgent(id: string): Promise<void> {
  await json<void>(`/api/agents/${id}`, { method: 'DELETE' });
}

export async function updateAgent(id: string, agent: Partial<Agent>): Promise<Agent> {
  return json<Agent>(`/api/agents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agent),
  });
}

export async function clearSession(agentId: string): Promise<void> {
  await json<void>(`/api/sessions/${agentId}`, { method: 'DELETE' });
}
