import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionMigrationPlan } from "../../src/contracts";
import { versionedType } from "../../src/recipe-v1-to-v2";

export const FIXTURE_SESSION_ID = "ses_fixture_legacy";
export const FIXTURE_PROMPT = "anonymous migration prompt";

function insertEvent(
  database: Database,
  seq: number,
  type: string,
  data: Record<string, unknown>,
): void {
  database
    .query<never, [string, string, number, string, string]>(
      `INSERT INTO event(id, aggregate_id, seq, type, data)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      `evt_fixture_${seq.toString().padStart(3, "0")}`,
      FIXTURE_SESSION_ID,
      seq,
      type,
      JSON.stringify(data),
    );
}

export function createLegacyFixture(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true, strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      agent TEXT,
      model TEXT,
      metadata TEXT,
      revert TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER
    );
    CREATE TABLE event_sequence (
      aggregate_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      owner_id TEXT
    );
    CREATE TABLE event (
      id TEXT PRIMARY KEY,
      aggregate_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id)
    );
    CREATE UNIQUE INDEX event_aggregate_seq_idx
      ON event(aggregate_id, seq);
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id)
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES message(id)
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id)
    );
    CREATE UNIQUE INDEX session_message_session_seq_idx
      ON session_message(session_id, seq);
    CREATE TABLE session_input (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      delivery TEXT NOT NULL,
      admitted_seq INTEGER NOT NULL,
      promoted_seq INTEGER,
      time_created INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id)
    );
    CREATE TABLE session_context_epoch (
      session_id TEXT PRIMARY KEY,
      baseline TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      baseline_seq INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id)
    );
  `);
  database.close();
  seedLegacyFixture(path);
}

export function seedLegacyFixture(path: string): void {
  const database = new Database(path, { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  const sessionInfo = {
    id: FIXTURE_SESSION_ID,
    slug: "fixture",
    projectID: "fixture-project",
    directory: "/workspace",
    title: "Anonymous fixture",
    version: "1.17.18",
    agent: "build",
    model: {
      id: "fixture-model",
      providerID: "fixture-provider",
      variant: "default",
    },
    cost: 0.25,
    tokens: {
      input: 10,
      output: 5,
      reasoning: 2,
      cache: { read: 1, write: 0 },
    },
    time: { created: 1_000, updated: 2_100 },
  };
  const sessionColumns = new Set(
    database
      .query<{ name: string }, []>("PRAGMA table_info(session)")
      .all()
      .map((column) => column.name),
  );
  const storedModel = JSON.stringify({
    id: "fixture-model",
    providerID: "fixture-provider",
    variant: "default",
  });
  if (sessionColumns.has("project_id")) {
    database
      .query<
        never,
        [string, string, number, number, string]
      >(
        `INSERT INTO project(
           id, worktree, time_created, time_updated, sandboxes
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("fixture-project", "/workspace", 1_000, 2_100, "[]");
    database
      .query<
        never,
        [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          number,
          number,
        ]
      >(
        `INSERT INTO session(
           id, project_id, slug, directory, title, version,
           agent, model, time_created, time_updated
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        FIXTURE_SESSION_ID,
        "fixture-project",
        "fixture",
        "/workspace",
        "Anonymous fixture",
        "1.17.18",
        "build",
        storedModel,
        1_000,
        2_100,
      );
  } else {
    database
      .query<never, [string, string, string, string, number, number]>(
        `INSERT INTO session(
           id, version, agent, model, time_created, time_updated
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        FIXTURE_SESSION_ID,
        "1.17.18",
        "build",
        storedModel,
        1_000,
        2_100,
      );
  }
  const userInfo = {
    id: "msg_fixture_user",
    sessionID: FIXTURE_SESSION_ID,
    role: "user",
    time: { created: 1_100 },
    agent: "build",
    model: {
      providerID: "fixture-provider",
      modelID: "fixture-model",
    },
  };
  const assistantInfo = {
    id: "msg_fixture_assistant",
    sessionID: FIXTURE_SESSION_ID,
    role: "assistant",
    time: { created: 1_200, completed: 2_000 },
    parentID: "msg_fixture_user",
    modelID: "fixture-model",
    providerID: "fixture-provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/workspace", root: "/workspace" },
    cost: 0.25,
    tokens: {
      input: 10,
      output: 5,
      reasoning: 2,
      cache: { read: 1, write: 0 },
    },
    finish: "stop",
  };

  const messages = [userInfo, assistantInfo];
  for (const message of messages) {
    const { id, sessionID, ...data } = message;
    database
      .query<never, [string, string, number, number, string]>(
        `INSERT INTO message(
           id, session_id, time_created, time_updated, data
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionID,
        message.time.created,
        "completed" in message.time
          ? message.time.completed
          : message.time.created,
        JSON.stringify(data),
      );
  }

  const parts = [
    {
      id: "prt_01_user_text",
      messageID: userInfo.id,
      type: "text",
      text: FIXTURE_PROMPT,
    },
    {
      id: "prt_02_user_file",
      messageID: userInfo.id,
      type: "file",
      mime: "text/plain",
      filename: "fixture.txt",
      url: "data:text/plain;base64,Zml4dHVyZQ==",
    },
    {
      id: "prt_03_user_agent",
      messageID: userInfo.id,
      type: "agent",
      name: "explore",
    },
    {
      id: "prt_10_step_start",
      messageID: assistantInfo.id,
      type: "step-start",
      snapshot: "snapshot-start",
    },
    {
      id: "prt_11_reasoning",
      messageID: assistantInfo.id,
      type: "reasoning",
      text: "fixture reasoning",
      time: { start: 1_250, end: 1_300 },
    },
    {
      id: "prt_12_tool",
      messageID: assistantInfo.id,
      type: "tool",
      callID: "call_fixture",
      tool: "read",
      state: {
        status: "completed",
        input: { path: "fixture.txt" },
        output: "fixture output",
        title: "Read fixture",
        metadata: { lines: 1 },
        time: { start: 1_350, end: 1_500 },
      },
    },
    {
      id: "prt_13_text",
      messageID: assistantInfo.id,
      type: "text",
      text: "fixture answer",
      time: { start: 1_600, end: 1_700 },
    },
    {
      id: "prt_14_patch",
      messageID: assistantInfo.id,
      type: "patch",
      hash: "fixture-hash",
      files: ["fixture.txt"],
    },
    {
      id: "prt_15_step_finish",
      messageID: assistantInfo.id,
      type: "step-finish",
      reason: "stop",
      snapshot: "snapshot-end",
      cost: 0.25,
      tokens: {
        input: 10,
        output: 5,
        reasoning: 2,
        cache: { read: 1, write: 0 },
      },
    },
  ];

  for (let index = 0; index < parts.length; index++) {
    const value = parts[index]!;
    const { id, messageID, ...data } = value;
    const time = 1_110 + index * 50;
    database
      .query<never, [string, string, string, number, number, string]>(
        `INSERT INTO part(
           id, message_id, session_id, time_created, time_updated, data
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        messageID,
        FIXTURE_SESSION_ID,
        time,
        time,
        JSON.stringify(data),
      );
  }

  const eventCount = 1 + messages.length + parts.length;
  database
    .query<never, [string, number]>(
      "INSERT INTO event_sequence(aggregate_id, seq) VALUES (?, ?)",
    )
    .run(FIXTURE_SESSION_ID, eventCount - 1);
  insertEvent(database, 0, "session.created.1", {
    sessionID: FIXTURE_SESSION_ID,
    info: sessionInfo,
  });
  let seq = 1;
  insertEvent(database, seq++, "message.updated.1", {
    sessionID: FIXTURE_SESSION_ID,
    info: userInfo,
  });
  for (const value of parts.filter(
    (part) => part.messageID === userInfo.id,
  )) {
    insertEvent(database, seq++, "message.part.updated.1", {
      sessionID: FIXTURE_SESSION_ID,
      part: { ...value, sessionID: FIXTURE_SESSION_ID },
      time: 1_100 + seq,
    });
  }
  insertEvent(database, seq++, "message.updated.1", {
    sessionID: FIXTURE_SESSION_ID,
    info: assistantInfo,
  });
  for (const value of parts.filter(
    (part) => part.messageID === assistantInfo.id,
  )) {
    insertEvent(database, seq++, "message.part.updated.1", {
      sessionID: FIXTURE_SESSION_ID,
      part: { ...value, sessionID: FIXTURE_SESSION_ID },
      time: 1_200 + seq,
    });
  }
  database.close();
}

export function seedV2CompatibilityFixture(path: string): string {
  const sessionId = "ses_fixture_v2_compat";
  const database = new Database(path, { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .query<never, [string, string, string, string, number, number]>(
        `INSERT INTO session(
           id, version, agent, model, time_created, time_updated
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        "1.18.9",
        "build",
        JSON.stringify({
          id: "fixture-model",
          providerID: "fixture-provider",
          variant: "default",
        }),
        3_000,
        3_200,
      );
    database
      .query("INSERT INTO event_sequence(aggregate_id, seq) VALUES (?, ?)")
      .run(sessionId, 2);
    database
      .query(
        `INSERT INTO event(id, aggregate_id, seq, type, data)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "evt_v2_compat_root",
        sessionId,
        0,
        "session.created.1",
        JSON.stringify({
          sessionID: sessionId,
          info: {
            id: sessionId,
            agent: "build",
            model: {
              id: "fixture-model",
              providerID: "fixture-provider",
              variant: "default",
            },
            time: { created: 3_000, updated: 3_200 },
          },
        }),
      );
    database
      .query(
        `INSERT INTO event(id, aggregate_id, seq, type, data)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "evt_v2_compat_agent",
        sessionId,
        1,
        "session.next.agent.switched.1",
        JSON.stringify({
          timestamp: 3_100,
          sessionID: sessionId,
          messageID: "msg_v2_compat_agent",
          agent: "build",
        }),
      );
    database
      .query(
        `INSERT INTO event(id, aggregate_id, seq, type, data)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "evt_v2_compat_prompt",
        sessionId,
        2,
        "session.next.prompted.1",
        JSON.stringify({
          timestamp: 3_200,
          sessionID: sessionId,
          messageID: "msg_v2_compat_user",
          prompt: { text: "anonymous compatibility prompt" },
          delivery: "steer",
        }),
      );
    database
      .query(
        `INSERT INTO message(
           id, session_id, time_created, time_updated, data
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "msg_v2_compat_legacy",
        sessionId,
        3_200,
        3_200,
        JSON.stringify({
          role: "user",
          time: { created: 3_200 },
          agent: "build",
          model: {
            providerID: "fixture-provider",
            modelID: "fixture-model",
          },
        }),
      );
    database
      .query(
        `INSERT INTO part(
           id, message_id, session_id, time_created, time_updated, data
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "prt_v2_compat_legacy",
        "msg_v2_compat_legacy",
        sessionId,
        3_200,
        3_200,
        JSON.stringify({
          type: "text",
          text: "anonymous compatibility prompt",
        }),
      );
    database
      .query(
        `INSERT INTO session_message(
           id, session_id, type, seq, time_created, time_updated, data
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "msg_v2_compat_agent",
        sessionId,
        "agent-switched",
        1,
        3_100,
        3_100,
        JSON.stringify({
          agent: "build",
          time: { created: 3_100 },
        }),
      );
    database
      .query(
        `INSERT INTO session_message(
           id, session_id, type, seq, time_created, time_updated, data
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "msg_v2_compat_user",
        sessionId,
        "user",
        2,
        3_200,
        3_200,
        JSON.stringify({
          text: "anonymous compatibility prompt",
          time: { created: 3_200 },
        }),
      );
    database
      .query(
        `INSERT INTO session_input(
           id, session_id, prompt, delivery,
           admitted_seq, promoted_seq, time_created
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "msg_v2_compat_user",
        sessionId,
        JSON.stringify({ text: "anonymous compatibility prompt" }),
        "steer",
        2,
        2,
        3_200,
      );
    database
      .query(
        `INSERT INTO session_input(
           id, session_id, prompt, delivery,
           admitted_seq, promoted_seq, time_created
         ) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        "msg_v2_compat_pending",
        sessionId,
        JSON.stringify({ text: "anonymous pending prompt" }),
        "queue",
        3,
        3_300,
      );
    database
      .query(
        `INSERT INTO session_context_epoch(
           session_id, baseline, snapshot, baseline_seq
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        JSON.stringify({ kind: "compat-baseline" }),
        JSON.stringify({ kind: "compat-snapshot" }),
        2,
      );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  return sessionId;
}

export function materializeTargetProjection(
  path: string,
  plan: SessionMigrationPlan,
  eventCount = plan.events.length,
): void {
  const database = new Database(path, { strict: true });
  const events = plan.events.slice(0, eventCount);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const event of events) {
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
            plan.sessionId,
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
            plan.sessionId,
          );
      }
    }
    const finalSeq = events.at(-1)?.seq ?? plan.baseSeq;
    database
      .query<never, [number, string]>(
        "UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?",
      )
      .run(finalSeq, plan.sessionId);

    for (const message of plan.expectedMessages.filter(
      (message) => message.seq <= finalSeq,
    )) {
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
    for (const input of plan.expectedInputs.filter(
      (input) => input.promotedSeq <= finalSeq,
    )) {
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
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}
