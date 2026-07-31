import { readSessionSourceSnapshot } from "../src/sqlite-source";
import { asFiniteNumber, asObject, asString, sha256 } from "../src/stable";

const [databasePath, ...sessionIds] = Bun.argv.slice(2);
if (!databasePath || sessionIds.length === 0) {
  throw new Error("usage: audit-session-selection.ts database session...");
}

function model(value: unknown): unknown {
  const object = asObject(value);
  if (!object) return null;
  return {
    id: asString(object.id) ?? null,
    providerID: asString(object.providerID) ?? null,
    variant: asString(object.variant) ?? null,
  };
}

for (const sessionId of sessionIds) {
  const snapshot = readSessionSourceSnapshot(databasePath, sessionId);
  const sessionEvents = snapshot.events
    .filter(
      (event) =>
        event.type === "session.created.1" ||
        event.type === "session.updated.1",
    )
    .map((event) => {
      const info = asObject(event.data.info);
      const time = info && asObject(info.time);
      return {
        seq: event.seq,
        type: event.type,
        agent: info ? (asString(info.agent) ?? null) : null,
        model: model(info?.model),
        timeUpdated: time ? (asFiniteNumber(time.updated) ?? null) : null,
        infoDigest: sha256(info),
      };
    });
  const messages = snapshot.messages.map((message) => {
    const time = asObject(message.data.time);
    return {
      id: message.id,
      role: asString(message.data.role) ?? null,
      agent: asString(message.data.agent) ?? null,
      model: model(message.data.model),
      timeCreated: message.timeCreated,
      timeUpdated: message.timeUpdated,
      timeCompleted: time ? (asFiniteNumber(time.completed) ?? null) : null,
    };
  });
  console.log(
    JSON.stringify({
      sessionId,
      stored: {
        agent: snapshot.session.agent ?? null,
        model: snapshot.session.model ?? null,
        timeCreated: snapshot.session.timeCreated,
        timeUpdated: snapshot.session.timeUpdated,
      },
      sessionEvents,
      messages,
    }),
  );
}
