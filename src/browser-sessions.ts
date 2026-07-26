import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface BrowserSession {
  id: string;
  parentId: string | null;
  name: string | null;
  createdAt: number;
  updatedAt: number;
  messages: AgentMessage[];
}

/**
 * Small page-local session tree. The browser runtime itself is ephemeral, so
 * these branches intentionally disappear on refresh along with Pyodide MEMFS.
 */
export class BrowserSessions {
  private readonly sessions = new Map<string, BrowserSession>();
  private currentId: string;

  constructor() {
    const initial = this.create(null, []);
    this.currentId = initial.id;
  }

  get current(): BrowserSession {
    return this.sessions.get(this.currentId)!;
  }

  save(messages: readonly AgentMessage[]): void {
    const session = this.current;
    session.messages = [...messages];
    session.updatedAt = Date.now();
  }

  startNew(messages: readonly AgentMessage[]): BrowserSession {
    this.save(messages);
    const session = this.create(null, []);
    this.currentId = session.id;
    return session;
  }

  fork(messages: readonly AgentMessage[], messageCount: number): BrowserSession {
    this.save(messages);
    const parentId = this.currentId;
    const session = this.create(parentId, messages.slice(0, messageCount));
    this.currentId = session.id;
    return session;
  }

  clone(messages: readonly AgentMessage[]): BrowserSession {
    return this.fork(messages, messages.length);
  }

  switchTo(id: string, messages: readonly AgentMessage[]): AgentMessage[] | null {
    if (!this.sessions.has(id)) return null;
    this.save(messages);
    this.currentId = id;
    return [...this.current.messages];
  }

  rename(name: string): void {
    this.current.name = name.trim() || null;
    this.current.updatedAt = Date.now();
  }

  list(messages: readonly AgentMessage[]): BrowserSession[] {
    this.save(messages);
    return [...this.sessions.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  label(session: BrowserSession): string {
    if (session.name) return session.name;
    const firstUser = session.messages.find(
      (message) => typeof message === "object" && message !== null && message.role === "user",
    );
    if (!firstUser || !("content" in firstUser)) return "New session";
    const content = firstUser.content;
    const value =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((part): part is { type: "text"; text: string } =>
                Boolean(part && part.type === "text" && typeof part.text === "string"),
              )
              .map((part) => part.text)
              .join(" ")
          : "";
    const singleLine = value.replace(/\s+/g, " ").trim();
    return singleLine ? truncate(singleLine, 52) : "New session";
  }

  exportCurrent(messages: readonly AgentMessage[]): BrowserSession {
    this.save(messages);
    const session = this.current;
    return { ...session, messages: [...session.messages] };
  }

  private create(parentId: string | null, messages: readonly AgentMessage[]): BrowserSession {
    const now = Date.now();
    const id = `session-${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const session: BrowserSession = {
      id,
      parentId,
      name: null,
      createdAt: now,
      updatedAt: now,
      messages: [...messages],
    };
    this.sessions.set(id, session);
    return session;
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
