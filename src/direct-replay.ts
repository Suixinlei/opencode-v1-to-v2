import { Database } from "bun:sqlite";
import type { MigrationPlan } from "./contracts";
import { versionedType } from "./recipe-v1-to-v2";
import { resolveDatabasePath } from "./sqlite-source";

export interface DirectReplayReceipt {
  mode: "direct-transaction";
  sessions: number;
  events: number;
  messages: number;
  inputs: number;
}

export function replayDirectly(
  databasePath: string,
  plan: MigrationPlan,
): DirectReplayReceipt {
  const database = new Database(resolveDatabasePath(databasePath), {
    strict: true,
  });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  const receipt: DirectReplayReceipt = {
    mode: "direct-transaction",
    sessions: 0,
    events: 0,
    messages: 0,
    inputs: 0,
  };
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const session of plan.sessions) {
      if (
        session.state !== "eligible" &&
        session.state !== "resumable"
      ) {
        continue;
      }
      if (session.existingReplayPrefix !== 0) {
        throw new Error(
          `DIRECT_REPLAY_PREFIX_UNSUPPORTED: ${session.sessionId}`,
        );
      }
      const sequence = database
        .query<
          { seq: number; owner_id: string | null },
          [string]
        >(
          `SELECT seq, owner_id
           FROM event_sequence
           WHERE aggregate_id = ?`,
        )
        .get(session.sessionId);
      if (
        !sequence ||
        sequence.seq !== session.baseSeq ||
        sequence.owner_id !== null
      ) {
        throw new Error(
          `DIRECT_REPLAY_SEQUENCE_CHANGED: ${session.sessionId}`,
        );
      }

      for (const event of session.events) {
        database
          .query<never, [string, string, number, string, string]>(
            `INSERT INTO event(id, aggregate_id, seq, type, data)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            event.id,
            event.aggregateID,
            event.seq,
            versionedType(event.type),
            JSON.stringify(event.data),
          );
        if (event.type === "session.next.agent.switched") {
          database
            .query<never, [string, number, string]>(
              "UPDATE session SET agent = ?, time_updated = ? WHERE id = ?",
            )
            .run(
              String(event.data.agent),
              Number(event.data.timestamp),
              session.sessionId,
            );
        }
        if (event.type === "session.next.model.switched") {
          database
            .query<never, [string, number, string]>(
              "UPDATE session SET model = ?, time_updated = ? WHERE id = ?",
            )
            .run(
              JSON.stringify(event.data.model),
              Number(event.data.timestamp),
              session.sessionId,
            );
        }
      }

      const sequenceUpdate = database
        .query<never, [number, string, number]>(
          `UPDATE event_sequence
           SET seq = ?
           WHERE aggregate_id = ? AND seq = ? AND owner_id IS NULL`,
        )
        .run(
          session.targetLastSeq,
          session.sessionId,
          session.baseSeq,
        );
      if (sequenceUpdate.changes !== 1) {
        throw new Error(
          `DIRECT_REPLAY_SEQUENCE_UPDATE_FAILED: ${session.sessionId}`,
        );
      }

      for (const message of session.expectedMessages) {
        database
          .query<
            never,
            [string, string, string, number, number, number, string]
          >(
            `INSERT INTO session_message(
               id, session_id, type, seq, time_created, time_updated, data
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            message.id,
            message.sessionId,
            message.type,
            message.seq,
            message.timeCreated,
            message.timeCreated,
            JSON.stringify(message.data),
          );
      }
      for (const input of session.expectedInputs) {
        database
          .query<
            never,
            [string, string, string, string, number, number, number]
          >(
            `INSERT INTO session_input(
               id, session_id, prompt, delivery,
               admitted_seq, promoted_seq, time_created
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.sessionId,
            JSON.stringify(input.prompt),
            input.delivery,
            input.admittedSeq,
            input.promotedSeq,
            input.timeCreated,
          );
      }
      receipt.sessions++;
      receipt.events += session.events.length;
      receipt.messages += session.expectedMessages.length;
      receipt.inputs += session.expectedInputs.length;
    }
    database.exec("COMMIT");
    return receipt;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}
