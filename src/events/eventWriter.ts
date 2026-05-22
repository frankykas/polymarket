import { randomId, type BotDatabase } from "../db.js";
import type { AgentEvent, AgentName, EventVisibility } from "../types.js";

export class AgentEventWriter {
  constructor(private db: BotDatabase) {}

  write(input: {
    type: string;
    agent: AgentName;
    visibility?: EventVisibility;
    message: string;
    payload?: unknown;
  }): AgentEvent {
    const event: AgentEvent = {
      id: randomId("evt"),
      type: input.type,
      agent: input.agent,
      visibility: input.visibility ?? "PRIVATE",
      message: input.message,
      payload: input.payload,
      createdAt: Date.now()
    };
    this.db.saveAgentEvent(event);
    return event;
  }
}
