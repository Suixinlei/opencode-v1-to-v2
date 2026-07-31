import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupLegacyProjections } from "../src/cleanup";
import { cleanupLocal, migrateLocal } from "../src/executor";
import { inventoryDatabase } from "../src/inventory";
import {
  assistantContextProof,
  deriveLegacyChallenge,
} from "../src/live-continuation-proof";
import { buildMigrationPlan, persistablePlan } from "../src/planner";
import { sha256 } from "../src/stable";
import { verifyMigration } from "../src/verifier";
import {
  createLegacyFixture,
  FIXTURE_PROMPT,
  FIXTURE_SESSION_ID,
  materializeTargetProjection,
  seedV2CompatibilityFixture,
} from "./helpers/fixture";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "opencode-migration-test-"));
  roots.push(root);
  const database = join(root, "opencode.db");
  createLegacyFixture(database);
  return database;
}

function replaceLegacyPart(
  databasePath: string,
  partId: string,
  data: Record<string, unknown>,
): void {
  const database = new Database(databasePath);
  database
    .query("UPDATE part SET data = ? WHERE id = ?")
    .run(JSON.stringify(data), partId);
  const row = database
    .query<{ id: string; data: string }, []>(
      `SELECT id, data FROM event
       WHERE type = 'message.part.updated.1'
       ORDER BY seq`,
    )
    .all()
    .find((event) => {
      const value = JSON.parse(event.data) as {
        part?: { id?: string };
      };
      return value.part?.id === partId;
    });
  if (!row) throw new Error(`Missing legacy part event: ${partId}`);
  const eventData = JSON.parse(row.data) as {
    part: Record<string, unknown>;
  };
  eventData.part = {
    id: partId,
    messageID: "msg_fixture_assistant",
    sessionID: FIXTURE_SESSION_ID,
    ...data,
  };
  database
    .query("UPDATE event SET data = ? WHERE id = ?")
    .run(JSON.stringify(eventData), row.id);
  database.close();
}

function replaceLegacyMessage(
  databasePath: string,
  messageId: string,
  data: Record<string, unknown>,
): void {
  const database = new Database(databasePath);
  database
    .query("UPDATE message SET data = ? WHERE id = ?")
    .run(JSON.stringify(data), messageId);
  const row = database
    .query<{ id: string; data: string }, []>(
      `SELECT id, data FROM event
       WHERE type = 'message.updated.1'
       ORDER BY seq`,
    )
    .all()
    .find((event) => {
      const value = JSON.parse(event.data) as {
        info?: { id?: string };
      };
      return value.info?.id === messageId;
    });
  if (!row) throw new Error(`Missing legacy message event: ${messageId}`);
  const eventData = JSON.parse(row.data) as Record<string, unknown>;
  eventData.info = {
    id: messageId,
    sessionID: FIXTURE_SESSION_ID,
    ...data,
  };
  database
    .query("UPDATE event SET data = ? WHERE id = ?")
    .run(JSON.stringify(eventData), row.id);
  database.close();
}

function replaceAssistantParts(
  databasePath: string,
  parts: readonly {
    id: string;
    data: Record<string, unknown>;
    time: number;
  }[],
): void {
  const database = new Database(databasePath);
  const existingEvents = database
    .query<
      {
        id: string;
        aggregate_id: string;
        type: string;
        data: string;
      },
      []
    >(
      `SELECT id, aggregate_id, type, data
       FROM event
       ORDER BY seq`,
    )
    .all()
    .filter((event) => {
      if (event.type !== "message.part.updated.1") return true;
      const value = JSON.parse(event.data) as {
        part?: { messageID?: string };
      };
      return value.part?.messageID !== "msg_fixture_assistant";
    });

  database
    .query("DELETE FROM part WHERE message_id = ?")
    .run("msg_fixture_assistant");
  for (const part of parts) {
    database
      .query(
        `INSERT INTO part(
           id, message_id, session_id, time_created, time_updated, data
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        part.id,
        "msg_fixture_assistant",
        FIXTURE_SESSION_ID,
        part.time,
        part.time,
        JSON.stringify(part.data),
      );
  }

  database.query("DELETE FROM event").run();
  let seq = 0;
  for (const event of existingEvents) {
    database
      .query(
        `INSERT INTO event(id, aggregate_id, seq, type, data)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(event.id, event.aggregate_id, seq++, event.type, event.data);
  }
  for (const [index, part] of parts.entries()) {
    database
      .query(
        `INSERT INTO event(id, aggregate_id, seq, type, data)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        `evt_fixture_multi_${index}`,
        FIXTURE_SESSION_ID,
        seq++,
        "message.part.updated.1",
        JSON.stringify({
          sessionID: FIXTURE_SESSION_ID,
          part: {
            id: part.id,
            messageID: "msg_fixture_assistant",
            sessionID: FIXTURE_SESSION_ID,
            ...part.data,
          },
          time: part.time,
        }),
      );
  }
  database
    .query("UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?")
    .run(seq - 1, FIXTURE_SESSION_ID);
  database.close();
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("V1 to V2 migration planner", () => {
  test("derives and verifies a redacted live continuation challenge", () => {
    const database = fixture();
    const challenge = deriveLegacyChallenge(database, FIXTURE_SESSION_ID);
    expect(challenge.expectedPrefix).toBe(
      [...FIXTURE_PROMPT].slice(0, 12).join(""),
    );
    const proof = assistantContextProof(
      [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "text",
              text:
                `OLD[${challenge.expectedPrefix}]\nPROBE[probe-value]`,
            },
          ],
        },
      ],
      challenge.expectedPrefix,
      "probe-value",
      challenge.sourceTexts,
    );
    expect(proof.oldContextReachedModel).toBe(true);
    expect(proof.newProbeReachedModel).toBe(true);
    expect(proof.assistantProofDigest).not.toContain(
      challenge.expectedPrefix,
    );
    const flattened = assistantContextProof(
      [
        {
          type: "assistant",
          content: [
            {
              type: "text",
              text:
                `OLD[${challenge.expectedPrefix}]\nPROBE[probe-value]`,
            },
          ],
        },
      ],
      challenge.expectedPrefix,
      "probe-value",
      challenge.sourceTexts,
    );
    expect(flattened.oldContextReachedModel).toBe(true);
    expect(flattened.newProbeReachedModel).toBe(true);
    const nonPrefixFragment = assistantContextProof(
      [
        {
          type: "assistant",
          content: [
            {
              type: "text",
              text:
                `OLD[${FIXTURE_PROMPT.slice(5, 17)}]\nPROBE[probe-value]`,
            },
          ],
        },
      ],
      challenge.expectedPrefix,
      "probe-value",
      challenge.sourceTexts,
    );
    expect(nonPrefixFragment.oldContextReachedModel).toBe(true);
    const unicodeCountOffByOne = assistantContextProof(
      [
        {
          type: "assistant",
          content: [
            {
              type: "text",
              text:
                `OLD[${FIXTURE_PROMPT.slice(5, 16)}]\nPROBE[probe-value]`,
            },
          ],
        },
      ],
      challenge.expectedPrefix,
      "probe-value",
      challenge.sourceTexts,
    );
    expect(unicodeCountOffByOne.oldContextReachedModel).toBe(true);
    const tooShortToProveContext = assistantContextProof(
      [
        {
          type: "assistant",
          content: [
            {
              type: "text",
              text:
                `OLD[${FIXTURE_PROMPT.slice(0, 6)}]\nPROBE[probe-value]`,
            },
          ],
        },
      ],
      challenge.expectedPrefix,
      "probe-value",
      challenge.sourceTexts,
    );
    expect(tooShortToProveContext.oldContextReachedModel).toBe(false);
  });

  test("targets the latest legacy user text for live continuation proof", () => {
    const databasePath = fixture();
    const latestPrompt = "latest legacy user prompt for continuation proof";
    const database = new Database(databasePath);
    database
      .query(
        `INSERT INTO message(
           id, session_id, time_created, time_updated, data
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "msg_fixture_latest_user",
        FIXTURE_SESSION_ID,
        3_000,
        3_000,
        JSON.stringify({
          role: "user",
          time: { created: 3_000 },
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
        "prt_fixture_latest_user",
        "msg_fixture_latest_user",
        FIXTURE_SESSION_ID,
        3_000,
        3_000,
        JSON.stringify({ type: "text", text: latestPrompt }),
      );
    database.close();

    const challenge = deriveLegacyChallenge(
      databasePath,
      FIXTURE_SESSION_ID,
    );
    expect(challenge.selection).toBe("latest-non-probe-user-text");
    expect(challenge.expectedPrefix).toBe(
      [...latestPrompt].slice(0, 12).join(""),
    );
  });

  test("builds a deterministic, redacted, eligible plan", () => {
    const database = fixture();
    const first = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    const second = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    const session = first.sessions[0]!;

    expect(session.state).toBe("eligible");
    expect(session.diagnostics.filter((item) => item.severity === "blocking"))
      .toEqual([]);
    expect(session.events.map((event) => event.type)).toEqual([
      "session.next.agent.switched",
      "session.next.model.switched",
      "session.next.prompted",
      "session.next.step.started",
      "session.next.reasoning.started",
      "session.next.reasoning.ended",
      "session.next.tool.input.started",
      "session.next.tool.input.ended",
      "session.next.tool.called",
      "session.next.tool.success",
      "session.next.text.started",
      "session.next.text.ended",
      "session.next.step.ended",
      "session.next.agent.switched",
    ]);
    expect(first.planDigest).toBe(second.planDigest);
    expect(session.events).toEqual(second.sessions[0]!.events);

    const persisted = persistablePlan(first, "fixture-run");
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain(FIXTURE_PROMPT);
    expect(persisted.sessions[0]!.generatedEventDigest).toBe(
      sha256(session.events),
    );
  });

  test("reads a checkpointed standalone WAL database without sidecar writes", () => {
    const database = fixture();
    const sqlite = new Database(database);
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    sqlite.close();
    rmSync(`${database}-wal`, { force: true });
    rmSync(`${database}-shm`, { force: true });

    expect(
      buildMigrationPlan({
        databasePath: database,
        sessionIds: [FIXTURE_SESSION_ID],
      }).sessions[0]!.state,
    ).toBe("eligible");
    expect(existsSync(`${database}-wal`)).toBe(false);
    expect(existsSync(`${database}-shm`)).toBe(false);

    writeFileSync(`${database}-wal`, "pending");
    expect(() =>
      buildMigrationPlan({
        databasePath: database,
        sessionIds: [FIXTURE_SESSION_ID],
      }),
    ).toThrow("UNSAFE_WAL_PRESENT");
  });

  test("fails closed when the aggregate has an owner", () => {
    const database = fixture();
    const sqlite = new Database(database);
    sqlite
      .query("UPDATE event_sequence SET owner_id = ? WHERE aggregate_id = ?")
      .run("owner-fixture", FIXTURE_SESSION_ID);
    sqlite.close();

    const plan = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    expect(plan.sessions[0]!.state).toBe("blocked");
    expect(plan.sessions[0]!.diagnostics.map((item) => item.code)).toContain(
      "OWNER_CONFLICT",
    );
  });

  test("fails closed for an unknown part type", () => {
    const database = fixture();
    const sqlite = new Database(database);
    sqlite
      .query("UPDATE part SET data = ? WHERE id = ?")
      .run(JSON.stringify({ type: "future-part" }), "prt_13_text");
    sqlite.close();

    const plan = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    expect(plan.sessions[0]!.state).toBe("blocked");
    expect(plan.sessions[0]!.diagnostics.map((item) => item.code)).toContain(
      "LEGACY_PROJECTION_DIVERGENCE",
    );
    expect(plan.sessions[0]!.diagnostics.map((item) => item.code)).toContain(
      "UNKNOWN_PART_TYPE",
    );
  });

  test("recognizes a deterministic replay prefix as resumable", () => {
    const database = fixture();
    const before = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    materializeTargetProjection(database, before.sessions[0]!, 1);
    const sqlite = new Database(database);
    sqlite
      .query("UPDATE event_sequence SET owner_id = ? WHERE aggregate_id = ?")
      .run("fixture-workspace-owner", FIXTURE_SESSION_ID);
    sqlite.close();
    const after = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    });

    expect(after.sessions[0]!.state).toBe("resumable");
    expect(after.sessions[0]!.existingReplayPrefix).toBe(1);
    expect(after.planDigest).toBe(before.planDigest);
  });

  test("restores a session selection changed after the last user turn", () => {
    const database = fixture();
    const sqlite = new Database(database);
    const terminalModel = {
      id: "terminal-model",
      providerID: "terminal-provider",
      variant: "review",
    };
    sqlite
      .query(
        `UPDATE session
         SET agent = ?, model = ?, time_updated = ?
         WHERE id = ?`,
      )
      .run(
        "review",
        JSON.stringify(terminalModel),
        2_500,
        FIXTURE_SESSION_ID,
      );
    const root = sqlite
      .query<{ id: string; data: string }, []>(
        `SELECT id, data FROM event
         WHERE type = 'session.created.1'
         ORDER BY seq
         LIMIT 1`,
      )
      .get()!;
    const rootData = JSON.parse(root.data) as {
      info: Record<string, unknown> & {
        time: Record<string, unknown>;
      };
    };
    rootData.info.agent = "review";
    rootData.info.model = terminalModel;
    rootData.info.time.updated = 2_500;
    sqlite
      .query("UPDATE event SET data = ? WHERE id = ?")
      .run(JSON.stringify(rootData), root.id);
    sqlite.close();

    const plan = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    const session = plan.sessions[0]!;
    expect(session.state).toBe("eligible");
    expect(session.events.slice(-2).map((event) => event.type)).toEqual([
      "session.next.agent.switched",
      "session.next.model.switched",
    ]);
    expect(session.events.at(-2)?.data.agent).toBe("review");
    expect(session.events.at(-1)?.data.model).toEqual(terminalModel);

    materializeTargetProjection(database, session);
    expect(verifyMigration(database, plan).verified).toBe(true);
    const projectedDatabase = new Database(database, { readonly: true });
    const projected = projectedDatabase
      .query<
        {
          agent: string;
          model: string;
          time_updated: number;
        },
        [string]
      >(
        "SELECT agent, model, time_updated FROM session WHERE id = ?",
      )
      .get(FIXTURE_SESSION_ID)!;
    projectedDatabase.close();
    expect(projected.agent).toBe("review");
    expect(JSON.parse(projected.model)).toEqual(terminalModel);
    expect(projected.time_updated).toBe(2_500);
  });

  test("blocks when the session root diverges from its legacy events", () => {
    const database = fixture();
    const sqlite = new Database(database);
    sqlite
      .query("UPDATE session SET agent = ? WHERE id = ?")
      .run("tampered-agent", FIXTURE_SESSION_ID);
    sqlite.close();

    const session = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    }).sessions[0]!;
    expect(session.state).toBe("blocked");
    expect(
      session.diagnostics.some(
        (entry) =>
          entry.code === "LEGACY_PROJECTION_DIVERGENCE" &&
          entry.message.includes("session agent/model/update-time"),
      ),
    ).toBe(true);
  });

  test("preserves a monotonic session touch without relaxing selection checks", () => {
    const database = fixture();
    const sqlite = new Database(database);
    const stored = sqlite
      .query<{ time_updated: number }, [string]>(
        "SELECT time_updated FROM session WHERE id = ?",
      )
      .get(FIXTURE_SESSION_ID)!;
    const touchedAt = stored.time_updated + 10_000;
    sqlite
      .query("UPDATE session SET time_updated = ? WHERE id = ?")
      .run(touchedAt, FIXTURE_SESSION_ID);
    sqlite.close();

    const plan = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    const session = plan.sessions[0]!;
    expect(session.state).toBe("eligible");
    expect(
      session.diagnostics.some(
        (entry) =>
          entry.severity === "warning" &&
          entry.code === "NORMALIZED_SESSION_TOUCH",
      ),
    ).toBe(true);
    expect(session.events.at(-1)?.data.timestamp).toBe(touchedAt);

    materializeTargetProjection(database, session);
    expect(verifyMigration(database, plan).verified).toBe(true);
    const projectedDatabase = new Database(database, { readonly: true });
    const projected = projectedDatabase
      .query<{ time_updated: number }, [string]>(
        "SELECT time_updated FROM session WHERE id = ?",
      )
      .get(FIXTURE_SESSION_ID)!;
    projectedDatabase.close();
    expect(projected.time_updated).toBe(touchedAt);
  });

  test("normalizes a non-semantic assistant event absent from the V1 projection", () => {
    const database = fixture();
    const sqlite = new Database(database);
    const current = sqlite
      .query<{ seq: number }, [string]>(
        "SELECT seq FROM event_sequence WHERE aggregate_id = ?",
      )
      .get(FIXTURE_SESSION_ID)!.seq;
    sqlite
      .query(
        `INSERT INTO event(id, aggregate_id, seq, type, data)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "evt_fixture_stale_assistant",
        FIXTURE_SESSION_ID,
        current + 1,
        "message.updated.1",
        JSON.stringify({
          sessionID: FIXTURE_SESSION_ID,
          info: {
            id: "msg_fixture_stale_assistant",
            sessionID: FIXTURE_SESSION_ID,
            role: "assistant",
            parentID: "msg_fixture_user",
            time: { created: 2_100, completed: 2_200 },
            error: { name: "UnknownError", data: {} },
          },
        }),
      );
    sqlite
      .query("UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?")
      .run(current + 1, FIXTURE_SESSION_ID);
    sqlite.close();

    const session = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    }).sessions[0]!;
    expect(session.state).toBe("eligible");
    expect(session.diagnostics.map((item) => item.code)).toContain(
      "NORMALIZED_STALE_EVENT_TAIL",
    );
  });

  test("normalizes only an empty raw field retained on a settled tool error", () => {
    const database = fixture();
    const errorTool = {
      type: "tool",
      callID: "call_fixture",
      tool: "read",
      state: {
        status: "error",
        input: { path: "fixture.txt" },
        error: "fixture error",
        time: { start: 1_350, end: 1_500 },
      },
    };
    replaceLegacyPart(database, "prt_12_tool", errorTool);
    const sqlite = new Database(database);
    sqlite
      .query("UPDATE part SET data = ? WHERE id = ?")
      .run(
        JSON.stringify({
          ...errorTool,
          state: { ...errorTool.state, raw: "" },
        }),
        "prt_12_tool",
      );
    sqlite.close();

    const session = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    }).sessions[0]!;
    expect(session.state).toBe("eligible");
    expect(session.diagnostics.map((item) => item.code)).toContain(
      "NORMALIZED_EXECUTION_FIELD",
    );

    const nonEmptyDatabase = fixture();
    replaceLegacyPart(nonEmptyDatabase, "prt_12_tool", errorTool);
    const nonEmpty = new Database(nonEmptyDatabase);
    nonEmpty
      .query("UPDATE part SET data = ? WHERE id = ?")
      .run(
        JSON.stringify({
          ...errorTool,
          state: { ...errorTool.state, raw: "not-empty" },
        }),
        "prt_12_tool",
      );
    nonEmpty.close();
    expect(
      buildMigrationPlan({
        databasePath: nonEmptyDatabase,
        sessionIds: [FIXTURE_SESSION_ID],
      }).sessions[0]!.state,
    ).toBe("blocked");
  });

  test("fails closed for unknown tool states and compaction markers", () => {
    const toolDatabase = fixture();
    const toolSqlite = new Database(toolDatabase);
    toolSqlite
      .query("UPDATE part SET data = ? WHERE id = ?")
      .run(
        JSON.stringify({
          type: "tool",
          callID: "call_fixture",
          tool: "read",
          state: { status: "future-state" },
        }),
        "prt_12_tool",
      );
    toolSqlite.close();
    const toolPlan = buildMigrationPlan({
      databasePath: toolDatabase,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    expect(toolPlan.sessions[0]!.state).toBe("blocked");
    expect(toolPlan.sessions[0]!.diagnostics.map((item) => item.code)).toContain(
      "UNKNOWN_TOOL_STATE",
    );

    const compactionDatabase = fixture();
    const compactionSqlite = new Database(compactionDatabase);
    compactionSqlite
      .query("UPDATE part SET data = ? WHERE id = ?")
      .run(
        JSON.stringify({ type: "compaction", auto: true }),
        "prt_01_user_text",
      );
    compactionSqlite.close();
    const compactionPlan = buildMigrationPlan({
      databasePath: compactionDatabase,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    expect(compactionPlan.sessions[0]!.state).toBe("blocked");
    expect(
      compactionPlan.sessions[0]!.diagnostics.map((item) => item.code),
    ).toContain("UNSUPPORTED_COMPACTION");

    const activeCompactionDatabase = fixture();
    const activeCompaction = new Database(activeCompactionDatabase);
    activeCompaction
      .query("UPDATE session SET time_compacting = ? WHERE id = ?")
      .run(2_000, FIXTURE_SESSION_ID);
    activeCompaction.close();
    const activeCompactionPlan = buildMigrationPlan({
      databasePath: activeCompactionDatabase,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    expect(activeCompactionPlan.sessions[0]!.state).toBe("blocked");
    expect(
      activeCompactionPlan.sessions[0]!.diagnostics.map(
        (item) => item.code,
      ),
    ).toContain("UNSUPPORTED_COMPACTION");
  });

  test("settles a pending tool without losing its parsed input", () => {
    const database = fixture();
    const sqlite = new Database(database);
    const pending = {
      type: "tool",
      callID: "call_fixture",
      tool: "read",
      state: {
        status: "pending",
        input: { path: "fixture.txt" },
        raw: "{\"path\":\"fixture.txt\"",
        time: { start: 1_350 },
      },
    };
    sqlite
      .query("UPDATE part SET data = ? WHERE id = ?")
      .run(JSON.stringify(pending), "prt_12_tool");
    const row = sqlite
      .query<{ id: string; data: string }, []>(
        `SELECT id, data FROM event
         WHERE type = 'message.part.updated.1'
         ORDER BY seq`,
      )
      .all()
      .find((event) => {
        const data = JSON.parse(event.data) as {
          part?: { id?: string };
        };
        return data.part?.id === "prt_12_tool";
      })!;
    const eventData = JSON.parse(row.data) as {
      part: Record<string, unknown>;
    };
    eventData.part = {
      id: "prt_12_tool",
      messageID: "msg_fixture_assistant",
      sessionID: FIXTURE_SESSION_ID,
      ...pending,
    };
    sqlite
      .query("UPDATE event SET data = ? WHERE id = ?")
      .run(JSON.stringify(eventData), row.id);
    sqlite.close();

    const session = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    }).sessions[0]!;
    expect(session.state).toBe("eligible");
    const called = session.events.find(
      (event) => event.type === "session.next.tool.called",
    );
    expect(called?.data.input).toEqual({ path: "fixture.txt" });
    const assistant = session.expectedMessages.find(
      (message) => message.type === "assistant",
    );
    const tool = Array.isArray(assistant?.data.content)
      ? assistant.data.content.find(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            "type" in entry &&
            entry.type === "tool",
        )
      : undefined;
    expect(
      typeof tool === "object" &&
        tool !== null &&
        "state" in tool &&
        typeof tool.state === "object" &&
        tool.state !== null &&
        "input" in tool.state
        ? tool.state.input
        : undefined,
    ).toEqual({ path: "fixture.txt" });
  });

  test("splits a real multi-step V1 assistant into stable V2 blocks", () => {
    const database = fixture();
    const multiStepParts = Array.from({ length: 5 }, (_, index) => {
      const step = index + 1;
      const prefix = `prt_${10 + index * 2}`;
      return [
        {
          id: `${prefix}_step_start`,
          time: 1_210 + index * 100,
          data: {
            type: "step-start",
            snapshot: `snapshot-${step}`,
          },
        },
        {
          id: `prt_${11 + index * 2}_tool`,
          time: 1_250 + index * 100,
          data: {
            type: "tool",
            callID: `call_multi_${step}`,
            tool: "read",
            state: {
              status: "completed",
              input: { step },
              output: `result-${step}`,
              metadata: {},
              time: {
                start: 1_250 + index * 100,
                end: 1_290 + index * 100,
              },
            },
          },
        },
      ];
    }).flat();
    replaceAssistantParts(database, [
      ...multiStepParts,
      {
        id: "prt_99_step_finish",
        time: 1_900,
        data: {
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
      },
    ]);

    const plan = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    const session = plan.sessions[0]!;
    expect(session.state).toBe("eligible");
    expect(
      session.diagnostics.some(
        (diagnostic) => diagnostic.code === "ASSISTANT_MULTIPLE_STEPS",
      ),
    ).toBe(false);

    const starts = session.events.filter(
      (event) => event.type === "session.next.step.started",
    );
    expect(starts).toHaveLength(5);
    expect(
      new Set(starts.map((event) => event.data.assistantMessageID)).size,
    ).toBe(5);
    expect(starts[0]!.data.assistantMessageID).toBe(
      "msg_fixture_assistant",
    );

    const assistants = session.expectedMessages.filter(
      (message) => message.type === "assistant",
    );
    expect(assistants).toHaveLength(5);
    expect(
      assistants.map((assistant) =>
        Array.isArray(assistant.data.content)
          ? assistant.data.content.map((part) =>
              typeof part === "object" &&
              part !== null &&
              "id" in part
                ? part.id
                : undefined,
            )
          : [],
      ),
    ).toEqual([
      ["call_multi_1"],
      ["call_multi_2"],
      ["call_multi_3"],
      ["call_multi_4"],
      ["call_multi_5"],
    ]);
    expect(
      session.diagnostics.filter(
        (diagnostic) =>
          diagnostic.severity === "warning" &&
          diagnostic.message.includes("has no step-finish"),
      ),
    ).toHaveLength(4);

    materializeTargetProjection(database, session);
    expect(verifyMigration(database, plan).verified).toBe(true);
  });

  test("does not duplicate aggregate cost across multi-step assistants", () => {
    const database = fixture();
    const tokenShape = {
      input: 4,
      output: 2,
      reasoning: 1,
      cache: { read: 0, write: 0 },
    };
    replaceAssistantParts(database, [
      {
        id: "prt_10_step_start",
        time: 1_210,
        data: { type: "step-start", snapshot: "snapshot-1" },
      },
      {
        id: "prt_11_tool",
        time: 1_220,
        data: {
          type: "tool",
          callID: "call_cost_1",
          tool: "read",
          state: {
            status: "completed",
            input: { step: 1 },
            output: "result-1",
            metadata: {},
            time: { start: 1_220, end: 1_250 },
          },
        },
      },
      {
        id: "prt_12_step_finish",
        time: 1_260,
        data: {
          type: "step-finish",
          reason: "tool-calls",
          cost: 0.1,
          tokens: tokenShape,
        },
      },
      {
        id: "prt_20_step_start",
        time: 1_300,
        data: { type: "step-start", snapshot: "snapshot-2" },
      },
      {
        id: "prt_21_tool",
        time: 1_320,
        data: {
          type: "tool",
          callID: "call_cost_2",
          tool: "read",
          state: {
            status: "completed",
            input: { step: 2 },
            output: "result-2",
            metadata: {},
            time: { start: 1_320, end: 1_350 },
          },
        },
      },
      {
        id: "prt_22_step_finish",
        time: 1_360,
        data: {
          type: "step-finish",
          reason: "stop",
          cost: 0.15,
          tokens: tokenShape,
        },
      },
    ]);

    const session = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    }).sessions[0]!;
    expect(session.state).toBe("eligible");
    const ended = session.events.filter(
      (event) => event.type === "session.next.step.ended",
    );
    expect(ended.map((event) => event.data.cost)).toEqual([0.1, 0.15]);
    expect(
      ended.reduce((total, event) => total + Number(event.data.cost), 0),
    ).toBeCloseTo(0.25);
    expect(
      session.expectedMessages
        .filter((message) => message.type === "assistant")
        .map((message) => message.data.cost),
    ).toEqual([0.1, 0.15]);
  });

  test("preserves rich completed tool state and data URI attachments", () => {
    const database = fixture();
    const structured = {
      exit: 0,
      truncated: false,
      diagnostics: [{ severity: "warning" }],
      todos: [{ status: "done" }],
      outputPath: "/workspace/result.txt",
    };
    replaceLegacyPart(database, "prt_12_tool", {
      type: "tool",
      callID: "call_fixture",
      tool: "read",
      state: {
        status: "completed",
        input: {
          argv: ["read"],
          filePath: "fixture.txt",
          questions: [{ id: "q1" }],
          todos: [{ id: "t1" }],
        },
        output: "fixture output",
        metadata: structured,
        attachments: [
          {
            mime: "text/plain",
            filename: "result.txt",
            url: "data:text/plain;base64,cmVzdWx0",
          },
        ],
        time: { start: 1_350, end: 1_500 },
      },
    });

    const session = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    }).sessions[0]!;
    expect(session.state).toBe("eligible");
    const success = session.events.find(
      (event) => event.type === "session.next.tool.success",
    )!;
    expect(success.data.structured).toEqual(structured);
    expect(success.data.content).toEqual([
      { type: "text", text: "fixture output" },
      {
        type: "file",
        uri: "data:text/plain;base64,cmVzdWx0",
        mime: "text/plain",
        name: "result.txt",
      },
    ]);
  });

  test("settles interrupted and ordinary tool errors as failed", () => {
    for (const [label, state] of [
      [
        "interrupted",
        {
          status: "error",
          input: { command: "fixture" },
          raw: "fixture raw input",
          error: "interrupted",
          metadata: { interrupted: true },
          time: { start: 1_350, end: 1_500 },
        },
      ],
      [
        "ordinary",
        {
          status: "error",
          input: { command: "fixture" },
          error: "ordinary failure",
          time: { start: 1_350, end: 1_500 },
        },
      ],
    ] as const) {
      const database = fixture();
      replaceLegacyPart(database, "prt_12_tool", {
        type: "tool",
        callID: `call_${label}`,
        tool: "bash",
        state,
      });
      const session = buildMigrationPlan({
        databasePath: database,
        sessionIds: [FIXTURE_SESSION_ID],
      }).sessions[0]!;
      expect(session.state).toBe("eligible");
      const failed = session.events.find(
        (event) => event.type === "session.next.tool.failed",
      );
      expect(failed?.data.callID).toBe(`call_${label}`);
      expect(
        typeof failed?.data.error === "object" &&
          failed.data.error !== null &&
          "message" in failed.data.error
          ? failed.data.error.message
          : undefined,
      ).toBe(state.error);
    }
  });

  test("keeps user summary metadata out of prompt semantics", () => {
    const database = fixture();
    replaceLegacyMessage(database, "msg_fixture_user", {
      role: "user",
      time: { created: 1_100 },
      agent: "build",
      model: {
        providerID: "fixture-provider",
        modelID: "fixture-model",
      },
      summary: {
        additions: 2,
        deletions: 1,
        files: 1,
        diffs: [{ file: "fixture.txt" }],
      },
    });
    const session = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    }).sessions[0]!;
    expect(session.state).toBe("eligible");
    const prompted = session.events.find(
      (event) => event.type === "session.next.prompted",
    );
    expect(
      typeof prompted?.data.prompt === "object" &&
        prompted.data.prompt !== null &&
        "text" in prompted.data.prompt
        ? prompted.data.prompt.text
        : undefined,
    ).toBe(FIXTURE_PROMPT);
    expect(JSON.stringify(prompted)).not.toContain("diffs");
  });

  test("excludes ordinary assistant error turns like the V1 lowerer", () => {
    const database = fixture();
    replaceLegacyMessage(database, "msg_fixture_assistant", {
      role: "assistant",
      time: { created: 1_200 },
      parentID: "msg_fixture_user",
      modelID: "fixture-model",
      providerID: "fixture-provider",
      mode: "build",
      agent: "build",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      error: {
        name: "UnknownError",
        data: { message: "anonymous failure" },
      },
    });
    const session = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    }).sessions[0]!;
    expect(session.state).toBe("eligible");
    expect(
      session.diagnostics.some(
        (entry) =>
          entry.severity === "warning" &&
          entry.code === "UNSUPPORTED_ASSISTANT_STATE",
      ),
    ).toBe(true);
    expect(
      session.events.some(
        (event) => event.type === "session.next.step.started",
      ),
    ).toBe(false);
  });

  test("keeps ignored V1 text out of V2 context and reports the normalization", () => {
    const database = fixture();
    const sqlite = new Database(database);
    const ignored = {
      type: "text",
      text: FIXTURE_PROMPT,
      ignored: true,
    };
    sqlite
      .query("UPDATE part SET data = ? WHERE id = ?")
      .run(JSON.stringify(ignored), "prt_01_user_text");
    const event = sqlite
      .query<{ data: string }, []>(
        `SELECT data FROM event
         WHERE type = 'message.part.updated.1'
         ORDER BY seq
         LIMIT 1`,
      )
      .get()!;
    const eventData = JSON.parse(event.data) as Record<string, unknown>;
    eventData.part = {
      id: "prt_01_user_text",
      messageID: "msg_fixture_user",
      sessionID: FIXTURE_SESSION_ID,
      ...ignored,
    };
    sqlite
      .query(
        `UPDATE event SET data = ?
         WHERE type = 'message.part.updated.1'
           AND seq = (
             SELECT MIN(seq) FROM event
             WHERE type = 'message.part.updated.1'
           )`,
      )
      .run(JSON.stringify(eventData));
    sqlite.close();

    const plan = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    expect(plan.sessions[0]!.state).toBe("eligible");
    expect(JSON.stringify(plan.sessions[0]!.events)).not.toContain(
      FIXTURE_PROMPT,
    );
    expect(
      plan.sessions[0]!.diagnostics.some(
        (item) =>
          item.severity === "warning" && item.path === "part.ignored",
      ),
    ).toBe(true);
  });

  test("normalizes execution-only system overrides and text provider metadata", () => {
    const database = fixture();
    const sqlite = new Database(database, { readonly: true });
    const user = JSON.parse(
      sqlite
        .query<{ data: string }, []>(
          "SELECT data FROM message WHERE id = 'msg_fixture_user'",
        )
        .get()!.data,
    ) as Record<string, unknown>;
    const text = JSON.parse(
      sqlite
        .query<{ data: string }, []>(
          "SELECT data FROM part WHERE id = 'prt_13_text'",
        )
        .get()!.data,
    ) as Record<string, unknown>;
    sqlite.close();

    const systemOverride = "anonymous execution-only system override";
    const providerState = "anonymous provider text state";
    replaceLegacyMessage(database, "msg_fixture_user", {
      ...user,
      system: systemOverride,
      tools: { read: false },
      format: { type: "text" },
    });
    replaceLegacyPart(database, "prt_13_text", {
      ...text,
      metadata: { fixture: { opaque: providerState } },
    });

    const plan = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    const session = plan.sessions[0]!;
    expect(session.state).toBe("eligible");
    expect(
      session.diagnostics.some(
        (item) =>
          item.severity === "warning" && item.path === "message.system",
      ),
    ).toBe(true);
    expect(
      session.diagnostics.some(
        (item) =>
          item.severity === "warning" && item.path === "part.metadata",
      ),
    ).toBe(true);
    const generated = JSON.stringify(session.events);
    expect(generated).not.toContain(systemOverride);
    expect(generated).not.toContain(providerState);

    materializeTargetProjection(database, session);
    expect(verifyMigration(database, plan).verified).toBe(true);
  });

  test("inventory and persisted plan never contain message bodies", async () => {
    const database = fixture();
    const inventory = await inventoryDatabase({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
      runId: "redaction-test",
    });
    const persisted = persistablePlan(
      buildMigrationPlan({
        databasePath: database,
        sessionIds: [FIXTURE_SESSION_ID],
      }),
      "redaction-test",
    );
    const hostile = new Database(database);
    const hostileMessage = hostile
      .query<{ data: string }, []>(
        "SELECT data FROM message WHERE id = 'msg_fixture_user'",
      )
      .get()!;
    const hostileMessageData = JSON.parse(hostileMessage.data) as Record<
      string,
      unknown
    >;
    hostileMessageData.role = "sensitive-discriminator-body";
    hostile
      .query("UPDATE message SET data = ? WHERE id = 'msg_fixture_user'")
      .run(JSON.stringify(hostileMessageData));
    const hostilePart = hostile
      .query<{ data: string }, []>(
        "SELECT data FROM part WHERE id = 'prt_01_user_text'",
      )
      .get()!;
    const hostilePartData = JSON.parse(hostilePart.data) as Record<
      string,
      unknown
    >;
    hostilePartData.type = "sensitive-discriminator-body";
    hostile
      .query("UPDATE part SET data = ? WHERE id = 'prt_01_user_text'")
      .run(JSON.stringify(hostilePartData));
    hostile
      .query("UPDATE event SET type = ? WHERE seq = 0")
      .run("sensitive-discriminator-body");
    hostile.close();
    const hostileInventory = await inventoryDatabase({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
      runId: "hostile-redaction-test",
    });

    const output = JSON.stringify({
      inventory,
      persisted,
      hostileInventory,
    });
    expect(output).not.toContain(FIXTURE_PROMPT);
    expect(output).not.toContain("fixture reasoning");
    expect(output).not.toContain("fixture output");
    expect(output).not.toContain("fixture answer");
    expect(output).not.toContain("sensitive-discriminator-body");
    expect(output).toContain("<unknown>");
  });

  test("protects unselected legacy sessions from any change", () => {
    const database = fixture();
    const sqlite = new Database(database);
    sqlite
      .query(
        `INSERT INTO session(
           id, version, agent, model, time_created, time_updated
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "ses_fixture_protected",
        "1.17.18",
        "build",
        JSON.stringify({
          id: "fixture-model",
          providerID: "fixture-provider",
        }),
        3_000,
        3_000,
      );
    sqlite
      .query("INSERT INTO event_sequence(aggregate_id, seq) VALUES (?, ?)")
      .run("ses_fixture_protected", 0);
    sqlite
      .query(
        `INSERT INTO event(id, aggregate_id, seq, type, data)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "evt_fixture_protected",
        "ses_fixture_protected",
        0,
        "session.created.1",
        JSON.stringify({
          sessionID: "ses_fixture_protected",
          info: { id: "ses_fixture_protected" },
        }),
      );
    sqlite.close();

    const plan = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    expect(plan.protectedSessions).toHaveLength(1);
    expect(plan.protectedSessions[0]!.kind).toBe("legacy");
    materializeTargetProjection(database, plan.sessions[0]!);
    expect(verifyMigration(database, plan).verified).toBe(true);

    const changed = new Database(database);
    changed
      .query("UPDATE session SET time_updated = ? WHERE id = ?")
      .run(3_001, "ses_fixture_protected");
    changed.close();
    expect(verifyMigration(database, plan).verified).toBe(false);
  });

  test("auto-selects only pure legacy and protects V2 compatibility rows", async () => {
    const database = fixture();
    const compatibilitySession = seedV2CompatibilityFixture(database);
    const plan = buildMigrationPlan({ databasePath: database });

    expect(plan.sessions.map((session) => session.sessionId)).toEqual([
      FIXTURE_SESSION_ID,
    ]);
    expect(plan.protectedSessions).toEqual([
      expect.objectContaining({
        sessionId: compatibilitySession,
        kind: "v2",
      }),
    ]);
    const explicitMixed = buildMigrationPlan({
      databasePath: database,
      sessionIds: [compatibilitySession],
    });
    expect(explicitMixed.sessions[0]!.state).toBe("blocked");
    expect(
      explicitMixed.sessions[0]!.diagnostics.some(
        (entry) => entry.code === "MIXED_EVENT_DIVERGENCE",
      ),
    ).toBe(true);
    expect(() =>
      cleanupLegacyProjections(database, explicitMixed),
    ).toThrow("VERIFY_FAILED");
    const inventory = await inventoryDatabase({
      databasePath: database,
      runId: "selector-test",
    });
    expect(inventory.counts).toEqual(
      expect.objectContaining({
        legacySessions: 1,
        protectedV2Sessions: 1,
        projectionClasses: {
          "legacy-only": 1,
          "legacy-and-v2": 1,
        },
      }),
    );

    materializeTargetProjection(database, plan.sessions[0]!);
    cleanupLegacyProjections(database, plan);
    const protectedDatabase = new Database(database, { readonly: true });
    const protectedCounts = protectedDatabase
      .query<
        { messages: number; parts: number; pending: number },
        [string, string, string]
      >(
        `SELECT
           (SELECT COUNT(*) FROM message WHERE session_id = ?) AS messages,
           (SELECT COUNT(*) FROM part WHERE session_id = ?) AS parts,
           (SELECT COUNT(*) FROM session_input
            WHERE session_id = ? AND promoted_seq IS NULL) AS pending`,
      )
      .get(
        compatibilitySession,
        compatibilitySession,
        compatibilitySession,
      )!;
    protectedDatabase.close();
    expect(protectedCounts).toEqual({
      messages: 1,
      parts: 1,
      pending: 1,
    });

    const changed = new Database(database);
    changed
      .query("UPDATE event_sequence SET owner_id = ? WHERE aggregate_id = ?")
      .run("unexpected-owner", compatibilitySession);
    changed.close();
    expect(
      verifyMigration(database, plan, { expectLegacyRemoved: true }).verified,
    ).toBe(false);

    const restoredSequence = new Database(database);
    restoredSequence
      .query("UPDATE event_sequence SET owner_id = NULL WHERE aggregate_id = ?")
      .run(compatibilitySession);
    restoredSequence.close();
    expect(
      verifyMigration(database, plan, { expectLegacyRemoved: true }).verified,
    ).toBe(true);

    const changedPart = new Database(database);
    changedPart
      .query("UPDATE part SET time_updated = time_updated + 1 WHERE session_id = ?")
      .run(compatibilitySession);
    changedPart.close();
    expect(
      verifyMigration(database, plan, { expectLegacyRemoved: true }).verified,
    ).toBe(false);
  });

  test("blocks an explicit legacy selection when V2 context state exists", () => {
    const database = fixture();
    const sqlite = new Database(database);
    sqlite
      .query(
        `INSERT INTO session_context_epoch(
           session_id, baseline, snapshot, baseline_seq
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        FIXTURE_SESSION_ID,
        JSON.stringify({ kind: "v2-baseline" }),
        JSON.stringify({ kind: "v2-snapshot" }),
        0,
      );
    sqlite.close();

    const automatic = buildMigrationPlan({ databasePath: database });
    expect(automatic.sessions).toHaveLength(0);
    expect(automatic.protectedSessions).toEqual([
      expect.objectContaining({
        sessionId: FIXTURE_SESSION_ID,
        kind: "v2",
      }),
    ]);

    const explicit = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    expect(explicit.sessions[0]!.state).toBe("blocked");
    expect(
      explicit.sessions[0]!.diagnostics.some(
        (entry) =>
          entry.code === "MIXED_EVENT_DIVERGENCE" &&
          entry.message.includes("context epoch"),
      ),
    ).toBe(true);
    expect(() => cleanupLegacyProjections(database, explicit)).toThrow(
      "VERIFY_FAILED",
    );
    const preserved = new Database(database, { readonly: true });
    const count = preserved
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
         FROM session_context_epoch
         WHERE session_id = ?`,
      )
      .get(FIXTURE_SESSION_ID)!.count;
    preserved.close();
    expect(count).toBe(1);
  });
});

describe("migration verification and cleanup", () => {
  test("cleans a checkpointed WAL candidate without sidecars", async () => {
    const source = fixture();
    const plan = buildMigrationPlan({
      databasePath: source,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    const candidate = `${source}.candidate`;
    copyFileSync(source, candidate);
    materializeTargetProjection(candidate, plan.sessions[0]!);
    const wal = new Database(candidate);
    wal.exec("PRAGMA journal_mode = WAL");
    wal.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    wal.close();
    rmSync(`${candidate}-wal`, { force: true });
    rmSync(`${candidate}-shm`, { force: true });
    const runDir = join(source, "..", "wal-cleanup");
    mkdirSync(runDir, { recursive: true });

    const receipt = await cleanupLocal({
      sourceDatabase: source,
      candidateDatabase: candidate,
      persistedPlan: persistablePlan(plan, "wal-cleanup"),
      runDir,
    });

    expect(
      receipt.sessions.every((session) => session.legacyRowsRemoved),
    ).toBe(true);
    expect(
      verifyMigration(candidate, plan, {
        expectLegacyRemoved: true,
        allowContinuationSuffix: true,
      }).verified,
    ).toBe(true);
  });

  test("verifies target projection and removes legacy rows idempotently", () => {
    const database = fixture();
    const plan = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    materializeTargetProjection(database, plan.sessions[0]!);

    expect(verifyMigration(database, plan).verified).toBe(true);
    const tampered = new Database(database);
    tampered
      .query("UPDATE session SET metadata = ? WHERE id = ?")
      .run(JSON.stringify({ changed: true }), FIXTURE_SESSION_ID);
    tampered.close();
    expect(verifyMigration(database, plan).verified).toBe(false);
    const restored = new Database(database);
    restored
      .query("UPDATE session SET metadata = NULL WHERE id = ?")
      .run(FIXTURE_SESSION_ID);
    restored.close();
    expect(verifyMigration(database, plan).verified).toBe(true);
    const first = cleanupLegacyProjections(database, plan);
    expect(first.removedMessages).toBe(2);
    expect(first.removedParts).toBe(9);
    expect(
      verifyMigration(database, plan, { expectLegacyRemoved: true }).verified,
    ).toBe(true);

    const second = cleanupLegacyProjections(database, plan);
    expect(second.removedMessages).toBe(0);
    expect(second.removedParts).toBe(0);
  });

  test("cleans legacy rows and reruns migration after a verified V2 continuation suffix", async () => {
    const source = fixture();
    const plan = buildMigrationPlan({
      databasePath: source,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    const session = plan.sessions[0]!;
    const database = `${source}.continued`;
    copyFileSync(source, database);
    materializeTargetProjection(database, session);

    const continued = new Database(database);
    const continuationSeq = session.targetLastSeq + 1;
    continued.exec("BEGIN IMMEDIATE");
    try {
      continued
        .query(
          `INSERT INTO event(id, aggregate_id, seq, type, data)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          "evt_fixture_continuation",
          FIXTURE_SESSION_ID,
          continuationSeq,
          "session.next.prompted.1",
          JSON.stringify({
            timestamp: 2_200,
            sessionID: FIXTURE_SESSION_ID,
            messageID: "msg_fixture_continuation",
            prompt: { text: "anonymous continuation" },
            delivery: "steer",
          }),
        );
      continued
        .query(
          `INSERT INTO session_message(
             id, session_id, type, seq, time_created, time_updated, data
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "msg_fixture_continuation",
          FIXTURE_SESSION_ID,
          "user",
          continuationSeq,
          2_200,
          2_200,
          JSON.stringify({
            text: "anonymous continuation",
            time: { created: 2_200 },
          }),
        );
      continued
        .query(
          `INSERT INTO session_input(
             id, session_id, prompt, delivery,
             admitted_seq, promoted_seq, time_created
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "msg_fixture_continuation",
          FIXTURE_SESSION_ID,
          JSON.stringify({ text: "anonymous continuation" }),
          "steer",
          continuationSeq,
          continuationSeq,
          2_200,
        );
      continued
        .query(
          `INSERT INTO session_context_epoch(
             session_id, baseline, snapshot, baseline_seq
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          FIXTURE_SESSION_ID,
          JSON.stringify({ kind: "v2-baseline" }),
          JSON.stringify({ kind: "v2-snapshot" }),
          continuationSeq,
        );
      continued
        .query(
          "UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?",
        )
        .run(continuationSeq, FIXTURE_SESSION_ID);
      continued
        .query("UPDATE session SET time_updated = ? WHERE id = ?")
        .run(2_200, FIXTURE_SESSION_ID);
      continued.exec("COMMIT");
    } catch (error) {
      continued.exec("ROLLBACK");
      throw error;
    } finally {
      continued.close();
    }

    expect(verifyMigration(database, plan).verified).toBe(false);
    expect(
      verifyMigration(database, plan, {
        allowContinuationSuffix: true,
      }).verified,
    ).toBe(true);

    const cleaned = cleanupLegacyProjections(database, plan);
    expect(cleaned.removedMessages).toBe(2);
    expect(cleaned.removedParts).toBe(9);
    expect(
      verifyMigration(database, plan, {
        expectLegacyRemoved: true,
        allowContinuationSuffix: true,
      }).verified,
    ).toBe(true);

    const inspected = new Database(database, { readonly: true });
    const preserved = inspected
      .query<
        {
          continuationEvents: number;
          continuationMessages: number;
          continuationInputs: number;
          contextEpochs: number;
        },
        [string, number, string, string, string]
      >(
        `SELECT
           (SELECT COUNT(*) FROM event
            WHERE aggregate_id = ? AND seq > ?) AS continuationEvents,
           (SELECT COUNT(*) FROM session_message
            WHERE id = ?) AS continuationMessages,
           (SELECT COUNT(*) FROM session_input
            WHERE id = ?) AS continuationInputs,
           (SELECT COUNT(*) FROM session_context_epoch
            WHERE session_id = ?) AS contextEpochs`,
      )
      .get(
        FIXTURE_SESSION_ID,
        session.targetLastSeq,
        "msg_fixture_continuation",
        "msg_fixture_continuation",
        FIXTURE_SESSION_ID,
      )!;
    inspected.close();
    expect(preserved).toEqual({
      continuationEvents: 1,
      continuationMessages: 1,
      continuationInputs: 1,
      contextEpochs: 1,
    });

    const rerun = await migrateLocal({
      sourceDatabase: source,
      candidateDatabase: database,
      persistedPlan: persistablePlan(plan, "cleaned-continuation-rerun"),
      runDir: join(source, "..", "cleaned-continuation-rerun"),
    });
    expect(rerun.state).toBe("verified");
    if (rerun.state !== "verified") throw new Error("expected verified rerun");
    expect(rerun.receipt.sessions[0]?.appendedEvents).toBe(0);
    expect(
      verifyMigration(database, plan, {
        expectLegacyRemoved: true,
        allowContinuationSuffix: true,
      }).verified,
    ).toBe(true);
  });

  test("refuses source/candidate aliasing and stale legacy cleanup", async () => {
    const source = fixture();
    const plan = buildMigrationPlan({
      databasePath: source,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    const persisted = persistablePlan(plan, "collision-test");
    const runDir = join(
      mkdtempSync(join(tmpdir(), "opencode-migration-run-")),
      "run",
    );
    mkdirSync(runDir, { recursive: true });

    await expect(
      migrateLocal({
        sourceDatabase: source,
        candidateDatabase: source,
        persistedPlan: persisted,
        runDir,
      }),
    ).rejects.toThrow("SOURCE_CANDIDATE_COLLISION");

    await expect(
      migrateLocal({
        sourceDatabase: source,
        candidateDatabase: join(runDir, "invalid-stop.db"),
        persistedPlan: persisted,
        runDir,
        stopAfterEvents: -1,
      }),
    ).rejects.toThrow("INVALID_STOP_AFTER_EVENTS");

    const candidate = join(runDir, "candidate.db");
    copyFileSync(source, candidate);
    materializeTargetProjection(candidate, plan.sessions[0]!);
    const changed = new Database(candidate);
    changed
      .query("UPDATE part SET time_updated = time_updated + 1 WHERE id = ?")
      .run("prt_13_text");
    changed.close();

    await expect(
      cleanupLocal({
        sourceDatabase: source,
        candidateDatabase: candidate,
        persistedPlan: persisted,
        runDir,
      }),
    ).rejects.toThrow("SOURCE_DIVERGENCE");
  });

  test("materializes and verifies a migration without Docker replay", async () => {
    const source = fixture();
    const plan = buildMigrationPlan({
      databasePath: source,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    const runDir = join(
      mkdtempSync(join(tmpdir(), "opencode-direct-replay-")),
      "run",
    );
    mkdirSync(runDir, { recursive: true });
    const candidate = join(runDir, "candidate.db");
    const result = await migrateLocal({
      sourceDatabase: source,
      candidateDatabase: candidate,
      persistedPlan: persistablePlan(plan, "direct-replay-test"),
      runDir,
      directReplay: true,
    });
    expect(result.state).toBe("verified");
    expect(verifyMigration(candidate, plan).verified).toBe(true);
    expect(existsSync(join(runDir, "direct-replay.json"))).toBe(true);
    expect(existsSync(join(runDir, "official-replay.json"))).toBe(false);
  });
});
