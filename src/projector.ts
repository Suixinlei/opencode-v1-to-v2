/** Pure model of the pinned OpenCode 1.18.9 SessionMessage projector. */
import type {
  ExpectedSessionInput,
  ExpectedSessionMessage,
  JsonObject,
  ReplayEvent,
} from "./contracts";
import { asObject, asString } from "./stable";

type MutableMessage = {
  id: string;
  sessionId: string;
  type: ExpectedSessionMessage["type"];
  seq: number;
  timeCreated: number;
  data: JsonObject;
};

function requiredObject(
  value: unknown,
  field: string,
  event: ReplayEvent,
): JsonObject {
  const result = asObject(value);
  if (!result) {
    throw new Error(`${event.type} requires object ${field}`);
  }
  return result;
}

function requiredString(
  value: unknown,
  field: string,
  event: ReplayEvent,
): string {
  const result = asString(value);
  if (result === undefined) {
    throw new Error(`${event.type} requires string ${field}`);
  }
  return result;
}

function requiredNumber(
  value: unknown,
  field: string,
  event: ReplayEvent,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${event.type} requires number ${field}`);
  }
  return value;
}

function content(message: MutableMessage): JsonObject[] {
  const value = message.data.content;
  if (!Array.isArray(value)) {
    throw new Error(`assistant ${message.id} has invalid content`);
  }
  return value as JsonObject[];
}

function findAssistant(
  messages: MutableMessage[],
  event: ReplayEvent,
): MutableMessage | undefined {
  const id = requiredString(
    event.data.assistantMessageID,
    "assistantMessageID",
    event,
  );
  return messages.findLast(
    (message) => message.id === id && message.type === "assistant",
  );
}

function latestTool(
  message: MutableMessage | undefined,
  callId: string,
): JsonObject | undefined {
  if (!message) return undefined;
  return content(message).findLast(
    (item) => item.type === "tool" && item.id === callId,
  );
}

function cloneObject(value: unknown): JsonObject {
  return structuredClone(requiredObject(value, "object", {
    id: "",
    aggregateID: "",
    seq: 0,
    type: "projection",
    data: {},
  }));
}

export function projectReplayEvents(events: readonly ReplayEvent[]): {
  messages: ExpectedSessionMessage[];
  inputs: ExpectedSessionInput[];
} {
  const messages: MutableMessage[] = [];
  const inputs: ExpectedSessionInput[] = [];

  for (const event of events) {
    const timestamp = requiredNumber(event.data.timestamp, "timestamp", event);
    const sessionId = requiredString(
      event.data.sessionID,
      "sessionID",
      event,
    );

    if (event.type === "session.next.agent.switched") {
      messages.push({
        id: requiredString(event.data.messageID, "messageID", event),
        sessionId,
        type: "agent-switched",
        seq: event.seq,
        timeCreated: timestamp,
        data: {
          agent: requiredString(event.data.agent, "agent", event),
          time: { created: timestamp },
        },
      });
      continue;
    }

    if (event.type === "session.next.model.switched") {
      messages.push({
        id: requiredString(event.data.messageID, "messageID", event),
        sessionId,
        type: "model-switched",
        seq: event.seq,
        timeCreated: timestamp,
        data: {
          model: cloneObject(event.data.model),
          time: { created: timestamp },
        },
      });
      continue;
    }

    if (event.type === "session.next.prompted") {
      const prompt = requiredObject(event.data.prompt, "prompt", event);
      const messageId = requiredString(
        event.data.messageID,
        "messageID",
        event,
      );
      messages.push({
        id: messageId,
        sessionId,
        type: "user",
        seq: event.seq,
        timeCreated: timestamp,
        data: {
          text: requiredString(prompt.text, "prompt.text", event),
          ...(Array.isArray(prompt.files)
            ? { files: structuredClone(prompt.files) }
            : {}),
          ...(Array.isArray(prompt.agents)
            ? { agents: structuredClone(prompt.agents) }
            : {}),
          time: { created: timestamp },
        },
      });
      inputs.push({
        id: messageId,
        sessionId,
        prompt: structuredClone(prompt),
        delivery: "steer",
        admittedSeq: event.seq,
        promotedSeq: event.seq,
        timeCreated: timestamp,
      });
      continue;
    }

    if (event.type === "session.next.prompt.admitted") continue;

    if (event.type === "session.next.context.updated") {
      messages.push({
        id: requiredString(event.data.messageID, "messageID", event),
        sessionId,
        type: "system",
        seq: event.seq,
        timeCreated: timestamp,
        data: {
          text: requiredString(event.data.text, "text", event),
          time: { created: timestamp },
        },
      });
      continue;
    }

    if (event.type === "session.next.synthetic") {
      messages.push({
        id: requiredString(event.data.messageID, "messageID", event),
        sessionId,
        type: "synthetic",
        seq: event.seq,
        timeCreated: timestamp,
        data: {
          sessionID: sessionId,
          text: requiredString(event.data.text, "text", event),
          time: { created: timestamp },
        },
      });
      continue;
    }

    if (event.type === "session.next.step.started") {
      const current = messages.findLast(
        (message) => message.type === "assistant",
      );
      const currentTime = current && asObject(current.data.time);
      if (current && currentTime && currentTime.completed === undefined) {
        currentTime.completed = timestamp;
      }
      messages.push({
        id: requiredString(
          event.data.assistantMessageID,
          "assistantMessageID",
          event,
        ),
        sessionId,
        type: "assistant",
        seq: event.seq,
        timeCreated: timestamp,
        data: {
          agent: requiredString(event.data.agent, "agent", event),
          model: cloneObject(event.data.model),
          time: { created: timestamp },
          content: [],
          ...(typeof event.data.snapshot === "string"
            ? { snapshot: { start: event.data.snapshot } }
            : {}),
        },
      });
      continue;
    }

    if (event.type === "session.next.text.started") {
      const assistant = findAssistant(messages, event);
      if (assistant) {
        content(assistant).push({
          type: "text",
          id: requiredString(event.data.textID, "textID", event),
          text: "",
        });
      }
      continue;
    }

    if (event.type === "session.next.text.ended") {
      const assistant = findAssistant(messages, event);
      const textId = requiredString(event.data.textID, "textID", event);
      const item = assistant
        ? content(assistant).findLast(
            (candidate) =>
              candidate.type === "text" && candidate.id === textId,
          )
        : undefined;
      if (item) item.text = requiredString(event.data.text, "text", event);
      continue;
    }

    if (event.type === "session.next.reasoning.started") {
      const assistant = findAssistant(messages, event);
      if (assistant) {
        content(assistant).push({
          type: "reasoning",
          id: requiredString(event.data.reasoningID, "reasoningID", event),
          text: "",
          ...(asObject(event.data.providerMetadata)
            ? {
                providerMetadata: structuredClone(
                  event.data.providerMetadata,
                ),
              }
            : {}),
          time: { created: timestamp },
        });
      }
      continue;
    }

    if (event.type === "session.next.reasoning.ended") {
      const assistant = findAssistant(messages, event);
      const reasoningId = requiredString(
        event.data.reasoningID,
        "reasoningID",
        event,
      );
      const item = assistant
        ? content(assistant).findLast(
            (candidate) =>
              candidate.type === "reasoning" &&
              candidate.id === reasoningId,
          )
        : undefined;
      if (item) {
        item.text = requiredString(event.data.text, "text", event);
        const priorTime = asObject(item.time);
        item.time = {
          created:
            typeof priorTime?.created === "number"
              ? priorTime.created
              : timestamp,
          completed: timestamp,
        };
        if (asObject(event.data.providerMetadata)) {
          item.providerMetadata = structuredClone(
            event.data.providerMetadata,
          );
        }
      }
      continue;
    }

    if (event.type === "session.next.tool.input.started") {
      const assistant = findAssistant(messages, event);
      if (assistant) {
        content(assistant).push({
          type: "tool",
          id: requiredString(event.data.callID, "callID", event),
          name: requiredString(event.data.name, "name", event),
          time: { created: timestamp },
          state: { status: "pending", input: "" },
        });
      }
      continue;
    }

    if (event.type === "session.next.tool.input.ended") {
      const assistant = findAssistant(messages, event);
      const tool = latestTool(
        assistant,
        requiredString(event.data.callID, "callID", event),
      );
      const state = tool && asObject(tool.state);
      if (state?.status === "pending") {
        state.input = requiredString(event.data.text, "text", event);
      }
      continue;
    }

    if (event.type === "session.next.tool.called") {
      const assistant = findAssistant(messages, event);
      const tool = latestTool(
        assistant,
        requiredString(event.data.callID, "callID", event),
      );
      if (tool) {
        tool.provider = structuredClone(
          requiredObject(event.data.provider, "provider", event),
        );
        const time = requiredObject(tool.time, "tool.time", event);
        time.ran = timestamp;
        tool.state = {
          status: "running",
          input: structuredClone(
            requiredObject(event.data.input, "input", event),
          ),
          structured: {},
          content: [],
        };
      }
      continue;
    }

    if (event.type === "session.next.tool.success") {
      const assistant = findAssistant(messages, event);
      const tool = latestTool(
        assistant,
        requiredString(event.data.callID, "callID", event),
      );
      const state = tool && asObject(tool.state);
      if (tool && state?.status === "running") {
        const provider = asObject(tool.provider) ?? {};
        const settlement = requiredObject(
          event.data.provider,
          "provider",
          event,
        );
        tool.provider = {
          executed:
            settlement.executed === true || provider.executed === true,
          ...(asObject(provider.metadata)
            ? { metadata: structuredClone(provider.metadata) }
            : {}),
          ...(asObject(settlement.metadata)
            ? { resultMetadata: structuredClone(settlement.metadata) }
            : {}),
        };
        const time = requiredObject(tool.time, "tool.time", event);
        time.completed = timestamp;
        tool.state = {
          status: "completed",
          input: structuredClone(
            requiredObject(state.input, "tool.state.input", event),
          ),
          structured: structuredClone(
            requiredObject(event.data.structured, "structured", event),
          ),
          content: structuredClone(
            Array.isArray(event.data.content) ? event.data.content : [],
          ),
          outputPaths: Array.isArray(event.data.outputPaths)
            ? structuredClone(event.data.outputPaths)
            : [],
          ...(event.data.result === undefined
            ? {}
            : { result: structuredClone(event.data.result) }),
        };
      }
      continue;
    }

    if (event.type === "session.next.tool.failed") {
      const assistant = findAssistant(messages, event);
      const tool = latestTool(
        assistant,
        requiredString(event.data.callID, "callID", event),
      );
      const state = tool && asObject(tool.state);
      if (
        tool &&
        state &&
        (state.status === "pending" || state.status === "running")
      ) {
        const provider = asObject(tool.provider) ?? {};
        const settlement = requiredObject(
          event.data.provider,
          "provider",
          event,
        );
        tool.provider = {
          executed:
            settlement.executed === true || provider.executed === true,
          ...(asObject(provider.metadata)
            ? { metadata: structuredClone(provider.metadata) }
            : {}),
          ...(asObject(settlement.metadata)
            ? { resultMetadata: structuredClone(settlement.metadata) }
            : {}),
        };
        const time = requiredObject(tool.time, "tool.time", event);
        time.completed = timestamp;
        tool.state = {
          status: "error",
          input:
            typeof state.input === "string"
              ? {}
              : structuredClone(
                  requiredObject(state.input, "tool.state.input", event),
                ),
          structured:
            state.status === "running" && asObject(state.structured)
              ? structuredClone(state.structured)
              : {},
          content:
            state.status === "running" && Array.isArray(state.content)
              ? structuredClone(state.content)
              : [],
          error: structuredClone(
            requiredObject(event.data.error, "error", event),
          ),
          ...(event.data.result === undefined
            ? {}
            : { result: structuredClone(event.data.result) }),
        };
      }
      continue;
    }

    if (event.type === "session.next.step.ended") {
      const assistant = findAssistant(messages, event);
      if (assistant) {
        const time = requiredObject(assistant.data.time, "time", event);
        time.completed = timestamp;
        assistant.data.finish = requiredString(
          event.data.finish,
          "finish",
          event,
        );
        assistant.data.cost = requiredNumber(event.data.cost, "cost", event);
        assistant.data.tokens = structuredClone(
          requiredObject(event.data.tokens, "tokens", event),
        );
        if (
          typeof event.data.snapshot === "string" ||
          Array.isArray(event.data.files)
        ) {
          assistant.data.snapshot = {
            ...(asObject(assistant.data.snapshot) ?? {}),
            ...(typeof event.data.snapshot === "string"
              ? { end: event.data.snapshot }
              : {}),
            ...(Array.isArray(event.data.files)
              ? { files: structuredClone(event.data.files) }
              : {}),
          };
        }
      }
      continue;
    }

    if (event.type === "session.next.step.failed") {
      const assistant = findAssistant(messages, event);
      if (assistant) {
        const time = requiredObject(assistant.data.time, "time", event);
        time.completed = timestamp;
        assistant.data.finish = "error";
        assistant.data.error = structuredClone(
          requiredObject(event.data.error, "error", event),
        );
      }
      continue;
    }

    if (event.type === "session.next.retried") continue;

    throw new Error(`Unsupported projected event type ${event.type}`);
  }

  return {
    messages: messages.map((message) => structuredClone(message)),
    inputs: inputs.map((input) => structuredClone(input)),
  };
}
