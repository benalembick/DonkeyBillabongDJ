import { Emitter } from "./events";

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry {
  id: number;
  time: number;
  level: LogLevel;
  source: string;
  message: string;
}

/** Ring-buffered application event log (diagnostics panel). */
export class EventLog extends Emitter<{ entry: LogEntry }> {
  private entries: LogEntry[] = [];
  private nextId = 1;
  private readonly capacity: number;

  constructor(capacity = 1000) {
    super();
    this.capacity = capacity;
  }

  add(level: LogLevel, source: string, message: string): void {
    const entry: LogEntry = { id: this.nextId++, time: Date.now(), level, source, message };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    if (level === "error") console.error(`[${source}] ${message}`);
    else if (level === "warn") console.warn(`[${source}] ${message}`);
    this.emit("entry", entry);
  }

  info(source: string, message: string): void {
    this.add("info", source, message);
  }
  warn(source: string, message: string): void {
    this.add("warn", source, message);
  }
  error(source: string, message: string): void {
    this.add("error", source, message);
  }

  all(): readonly LogEntry[] {
    return this.entries;
  }
}
