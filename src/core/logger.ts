type LogLevel = "debug" | "info" | "warn" | "error";

function emit(level: LogLevel, agent: string, message: string, data?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    agent,
    message,
  };
  if (data !== undefined) {
    entry.data = data;
  }
  process.stdout.write(JSON.stringify(entry) + "\n");
}

export const log = {
  debug: (agent: string, message: string, data?: Record<string, unknown>) => emit("debug", agent, message, data),
  info: (agent: string, message: string, data?: Record<string, unknown>) => emit("info", agent, message, data),
  warn: (agent: string, message: string, data?: Record<string, unknown>) => emit("warn", agent, message, data),
  error: (agent: string, message: string, data?: Record<string, unknown>) => emit("error", agent, message, data),
};
