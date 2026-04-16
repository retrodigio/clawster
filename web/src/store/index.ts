import { create } from 'zustand';
import {
  fetchAgents,
  fetchSessions,
  fetchStatus,
  type Agent,
  type Session,
  type SystemStatus,
  type ConversationEvent,
} from '../lib/api';

// Legacy WebSocket message types
export interface WsStreamMessage { type: 'stream'; text: string }
export interface WsActivityMessage { type: 'activity'; detail: string; elapsed: number; type_: 'tool_use' | 'thinking' | 'text' }
export interface WsDoneMessage { type: 'done'; text: string; sessionId: string | null }
export interface WsErrorMessage { type: 'error'; message: string }
export interface WsStartMessage { type: 'start'; agentId: string }
export interface WsEventMessage { type: 'event'; event: ConversationEvent }
export type WsMessage = WsStreamMessage | WsActivityMessage | WsDoneMessage | WsErrorMessage | WsStartMessage | WsEventMessage;

interface AppState {
  // Data
  agents: Agent[];
  sessions: Record<string, Session>;
  status: SystemStatus | null;

  // Active session
  activeAgentId: string | null;
  events: ConversationEvent[];
  streaming: boolean;
  streamText: string;

  // WebSocket
  ws: WebSocket | null;

  // Actions
  loadAll(): Promise<void>;
  loadAgents(): Promise<void>;
  loadSessions(): Promise<void>;
  loadStatus(): Promise<void>;

  openSession(agentId: string): void;
  closeSession(): void;
  connectWs(agentId: string): void;
  disconnectWs(): void;
  sendMessage(prompt: string): void;
  clearEvents(): void;
}

function makeEvent(
  type: ConversationEvent['type'],
  data: Record<string, unknown> = {},
): ConversationEvent {
  return {
    id: crypto.randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    data,
  };
}

export const useStore = create<AppState>((set, get) => ({
  // Initial state
  agents: [],
  sessions: {},
  status: null,
  activeAgentId: null,
  events: [],
  streaming: false,
  streamText: '',
  ws: null,

  loadAgents: async () => {
    try {
      const agents = await fetchAgents();
      set({ agents });
    } catch {
      // ignore
    }
  },

  loadSessions: async () => {
    try {
      const sessions = await fetchSessions();
      set({ sessions });
    } catch {
      // ignore
    }
  },

  loadStatus: async () => {
    try {
      const status = await fetchStatus();
      set({ status });
    } catch {
      // ignore
    }
  },

  loadAll: async () => {
    await Promise.all([get().loadAgents(), get().loadSessions(), get().loadStatus()]);
  },

  openSession: (agentId: string) => {
    const prev = get().activeAgentId;
    if (prev === agentId) return;
    get().disconnectWs();
    set({ activeAgentId: agentId, events: [], streaming: false, streamText: '' });
    get().connectWs(agentId);
  },

  closeSession: () => {
    get().disconnectWs();
    set({ activeAgentId: null, events: [], streaming: false, streamText: '' });
  },

  connectWs: (agentId: string) => {
    get().disconnectWs();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/chat/${agentId}`);

    ws.onmessage = (rawEvent) => {
      const data: WsMessage = JSON.parse(rawEvent.data);

      switch (data.type) {
        case 'event': {
          // New event protocol: append conversation event directly
          set((state) => ({ events: [...state.events, data.event] }));
          break;
        }
        case 'start': {
          set({ streaming: true, streamText: '' });
          break;
        }
        case 'stream': {
          set({ streamText: data.text });
          break;
        }
        case 'activity': {
          // Legacy activity messages: convert to tool_use events
          const activityEvent = makeEvent('tool_use', {
            name: data.type_ === 'tool_use' ? 'tool' : data.type_,
            detail: data.detail,
            elapsed: data.elapsed,
          });
          set((state) => ({ events: [...state.events, activityEvent] }));
          break;
        }
        case 'done': {
          // Add final result event with full text
          const resultEvent = makeEvent('result', { text: data.text, sessionId: data.sessionId });
          set((state) => ({
            streaming: false,
            streamText: '',
            events: [...state.events, resultEvent],
          }));
          // Refresh sessions after completion
          get().loadSessions();
          break;
        }
        case 'error': {
          const errorEvent = makeEvent('system', { text: `Error: ${data.message}`, isError: true });
          set((state) => ({
            streaming: false,
            streamText: '',
            events: [...state.events, errorEvent],
          }));
          break;
        }
      }
    };

    ws.onerror = () => {
      set({ streaming: false, streamText: '' });
    };

    ws.onclose = () => {
      set({ ws: null });
    };

    set({ ws });
  },

  disconnectWs: () => {
    const { ws } = get();
    if (ws) {
      ws.close();
      set({ ws: null });
    }
  },

  sendMessage: (prompt: string) => {
    const { ws, streaming } = get();
    if (!ws || streaming || !prompt.trim()) return;

    // Add user message event
    const userEvent = makeEvent('user', { text: prompt.trim() });
    set((state) => ({
      streaming: true,
      streamText: '',
      events: [...state.events, userEvent],
    }));

    ws.send(JSON.stringify({ prompt: prompt.trim() }));
  },

  clearEvents: () => set({ events: [], streamText: '' }),
}));
