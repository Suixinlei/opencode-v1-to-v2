import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMixedMigrationPlan,
  cleanupMixedLocal,
  migrateMixedLocal,
  persistableMixedPlan,
  verifyMixedCandidate,
  type MixedSessionShape,
} from "../src/mixed-migration";
import { buildMigrationPlan } from "../src/planner";
import {
  createLegacyFixture,
  FIXTURE_SESSION_ID,
  materializeTargetProjection,
} from "./helpers/fixture";

const roots: string[] = [];

function fixture(): { root: string; database: string } {
  const root = mkdtempSync(join(tmpdir(), "opencode-mixed-test-"));
  roots.push(root);
  const database = join(root, "opencode.db");
  createLegacyFixture(database);
  return { root, database };
}

function insertV2Event(
  database: Database,
  seq: number,
  type: string,
  data: Record<string, unknown>,
): void {
  database
    .query(
      `INSERT INTO event(id, aggregate_id, seq, type, data)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      `evt_existing_v2_${seq}`,
      FIXTURE_SESSION_ID,
      seq,
      type,
      JSON.stringify(data),
    );
}

function insertV2Message(
  database: Database,
  input: {
    id: string;
    type: string;
    seq: number;
    time: number;
    data: Record<string, unknown>;
  },
): void {
  database
    .query(
      `INSERT INTO session_message(
         id, session_id, type, seq, time_created, time_updated, data
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      FIXTURE_SESSION_ID,
      input.type,
      input.seq,
      input.time,
      input.time,
      JSON.stringify(input.data),
    );
}

function seedExistingV2(
  path: string,
  input: {
    position: "between-root-and-legacy" | "after-legacy";
    includePrompt?: boolean;
    includeContext?: boolean;
    sparseLegacyPrefix?: boolean;
  },
): {
  firstV2Seq: number;
  originalInputSeq?: number;
  originalContextSeq?: number;
} {
  const database = new Database(path, { strict: true });
  const current = database
    .query<{ seq: number }, [string]>(
      "SELECT seq FROM event_sequence WHERE aggregate_id = ?",
    )
    .get(FIXTURE_SESSION_ID)!.seq;
  const v2Count =
    2 + (input.includePrompt ? 1 : 0) + (input.includeContext ? 1 : 0);
  const firstV2Seq =
    input.position === "between-root-and-legacy" ? 1 : current + 1;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (input.position === "between-root-and-legacy") {
      database
        .query(
          `UPDATE event
           SET seq = -seq - 1
           WHERE aggregate_id = ? AND seq >= 1`,
        )
        .run(FIXTURE_SESSION_ID);
      database
        .query(
          `UPDATE event
           SET seq = -seq - 1 + ?
           WHERE aggregate_id = ? AND seq < 0`,
        )
        .run(v2Count, FIXTURE_SESSION_ID);
    }
    let seq = firstV2Seq;
    insertV2Event(database, seq, "session.next.agent.switched.1", {
      sessionID: FIXTURE_SESSION_ID,
      messageID: "msg_existing_v2_agent",
      timestamp: 2_050,
      agent: "build",
    });
    insertV2Message(database, {
      id: "msg_existing_v2_agent",
      type: "agent-switched",
      seq,
      time: 2_050,
      data: { agent: "build", time: { created: 2_050 } },
    });
    seq++;
    insertV2Event(database, seq, "session.next.model.switched.1", {
      sessionID: FIXTURE_SESSION_ID,
      messageID: "msg_existing_v2_model",
      timestamp: 2_075,
      model: {
        id: "fixture-model",
        providerID: "fixture-provider",
        variant: "default",
      },
    });
    insertV2Message(database, {
      id: "msg_existing_v2_model",
      type: "model-switched",
      seq,
      time: 2_075,
      data: {
        model: {
          id: "fixture-model",
          providerID: "fixture-provider",
          variant: "default",
        },
        time: { created: 2_075 },
      },
    });
    seq++;
    let originalInputSeq: number | undefined;
    if (input.includePrompt) {
      originalInputSeq = seq;
      insertV2Event(database, seq, "session.next.prompted.1", {
        sessionID: FIXTURE_SESSION_ID,
        messageID: "msg_existing_v2_user",
        timestamp: 2_080,
        prompt: { text: "anonymous existing V2 prompt" },
        delivery: "steer",
      });
      insertV2Message(database, {
        id: "msg_existing_v2_user",
        type: "user",
        seq,
        time: 2_080,
        data: {
          text: "anonymous existing V2 prompt",
          time: { created: 2_080 },
        },
      });
      database
        .query(
          `INSERT INTO session_input(
             id, session_id, prompt, delivery,
             admitted_seq, promoted_seq, time_created
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "msg_existing_v2_user",
          FIXTURE_SESSION_ID,
          JSON.stringify({ text: "anonymous existing V2 prompt" }),
          "steer",
          seq,
          seq,
          2_080,
        );
      seq++;
    }
    let originalContextSeq: number | undefined;
    if (input.includeContext) {
      originalContextSeq = seq;
      insertV2Event(database, seq, "session.next.context.updated.1", {
        sessionID: FIXTURE_SESSION_ID,
        messageID: "msg_existing_v2_context",
        timestamp: 2_090,
        text: "anonymous existing context",
      });
      insertV2Message(database, {
        id: "msg_existing_v2_context",
        type: "system",
        seq,
        time: 2_090,
        data: {
          text: "anonymous existing context",
          time: { created: 2_090 },
        },
      });
      database
        .query(
          `INSERT INTO session_context_epoch(
             session_id, baseline, snapshot, baseline_seq
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          FIXTURE_SESSION_ID,
          JSON.stringify({ kind: "anonymous" }),
          JSON.stringify({ kind: "anonymous" }),
          seq,
        );
      seq++;
    }
    database
      .query(
        `UPDATE event_sequence
         SET seq = ?
         WHERE aggregate_id = ?`,
      )
      .run(
        input.position === "between-root-and-legacy"
          ? current + v2Count
          : seq - 1,
        FIXTURE_SESSION_ID,
      );
    if (input.sparseLegacyPrefix) {
      database
        .query(
          `DELETE FROM event
           WHERE aggregate_id = ?
             AND seq = (
               SELECT MIN(seq)
               FROM event
               WHERE aggregate_id = ?
                 AND type = 'message.updated.1'
             )`,
        )
        .run(FIXTURE_SESSION_ID, FIXTURE_SESSION_ID);
    }
    database.exec("COMMIT");
    return {
      firstV2Seq,
      ...(originalInputSeq === undefined ? {} : { originalInputSeq }),
      ...(originalContextSeq === undefined ? {} : { originalContextSeq }),
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function appendHistoricalProjectionVariant(
  path: string,
  input: { providerExecuted?: boolean } = {},
): { assistantId: string; originalSeq: number; originalData: string } {
  const database = new Database(path, { strict: true });
  const current = database
    .query<{ seq: number }, [string]>(
      "SELECT seq FROM event_sequence WHERE aggregate_id = ?",
    )
    .get(FIXTURE_SESSION_ID)!.seq;
  const assistantId = "msg_existing_v2_historical_assistant";
  const model = {
    id: "fixture-model",
    providerID: "fixture-provider",
    variant: "default",
  };
  let seq = current + 1;
  const originalSeq = seq;
  database.exec("BEGIN IMMEDIATE");
  try {
    insertV2Event(database, seq++, "session.next.step.started.1", {
      sessionID: FIXTURE_SESSION_ID,
      assistantMessageID: assistantId,
      timestamp: 3_000,
      agent: "build",
      model,
    });
    insertV2Event(
      database,
      seq++,
      "session.next.tool.input.started.1",
      {
        sessionID: FIXTURE_SESSION_ID,
        assistantMessageID: assistantId,
        callID: "call_existing_historical",
        name: "fixture-tool",
        timestamp: 3_010,
      },
    );
    insertV2Event(database, seq++, "session.next.tool.input.ended.1", {
      sessionID: FIXTURE_SESSION_ID,
      assistantMessageID: assistantId,
      callID: "call_existing_historical",
      text: "{}",
      timestamp: 3_020,
    });
    insertV2Event(database, seq++, "session.next.tool.called.1", {
      sessionID: FIXTURE_SESSION_ID,
      assistantMessageID: assistantId,
      callID: "call_existing_historical",
      input: {},
      provider: input.providerExecuted ? { executed: true } : {},
      timestamp: 3_030,
    });
    insertV2Event(database, seq++, "session.next.tool.success.1", {
      sessionID: FIXTURE_SESSION_ID,
      assistantMessageID: assistantId,
      callID: "call_existing_historical",
      structured: {},
      content: [],
      provider: input.providerExecuted ? { executed: true } : {},
      timestamp: 3_040,
    });
    insertV2Event(database, seq++, "session.next.reasoning.started.1", {
      sessionID: FIXTURE_SESSION_ID,
      assistantMessageID: assistantId,
      reasoningID: "reasoning_existing_historical",
      providerMetadata: null,
      timestamp: 3_050,
    });
    insertV2Event(database, seq++, "session.next.reasoning.ended.1", {
      sessionID: FIXTURE_SESSION_ID,
      assistantMessageID: assistantId,
      reasoningID: "reasoning_existing_historical",
      text: "anonymous historical reasoning",
      providerMetadata: null,
      timestamp: 3_060,
    });
    insertV2Event(database, seq++, "session.next.step.ended.2", {
      sessionID: FIXTURE_SESSION_ID,
      assistantMessageID: assistantId,
      finish: "stop",
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      timestamp: 3_070,
    });
    const data = {
      agent: "build",
      model,
      time: { created: 3_000, completed: 3_070 },
      content: [
        {
          type: "tool",
          id: "call_existing_historical",
          name: "fixture-tool",
          time: { created: 3_010, completed: 3_040 },
          state: {
            status: "completed",
            input: {},
            structured: {},
            content: [],
          },
        },
        {
          type: "reasoning",
          id: "reasoning_existing_historical",
          text: "anonymous historical reasoning",
          providerMetadata: null,
        },
      ],
      finish: "stop",
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    };
    insertV2Message(database, {
      id: assistantId,
      type: "assistant",
      seq: originalSeq,
      time: 3_000,
      data,
    });
    database
      .query(
        "UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?",
      )
      .run(seq - 1, FIXTURE_SESSION_ID);
    database.exec("COMMIT");
    return {
      assistantId,
      originalSeq,
      originalData: JSON.stringify(data),
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("mixed V1/V2 migration", () => {
  test.each([
    ["bootstrap-v2-then-legacy", false],
    ["v2-then-legacy-tail", true],
  ] as const)(
    "appends missing history for %s without rewriting existing V2",
    async (expectedShape, includePrompt) => {
      const { root, database } = fixture();
      seedExistingV2(database, {
        position: "between-root-and-legacy",
        includePrompt,
      });
      const plan = await buildMixedMigrationPlan({
        databasePath: database,
        sessionIds: [FIXTURE_SESSION_ID],
      });
      const persisted = persistableMixedPlan(plan, expectedShape);
      expect(persisted.sessions[0]?.shape).toBe(
        expectedShape as MixedSessionShape,
      );
      expect(persisted.sessions[0]?.shiftedExistingV2Rows).toBe(false);
      expect(JSON.stringify(persisted)).not.toContain(
        "anonymous existing V2 prompt",
      );

      const candidate = join(root, `${expectedShape}.db`);
      const runDir = join(root, `${expectedShape}-run`);
      const migrated = await migrateMixedLocal({
        sourceDatabase: database,
        candidateDatabase: candidate,
        persistedPlan: persisted,
        runDir,
      });
      expect(migrated.verified).toBe(true);
      const cleaned = await cleanupMixedLocal({
        sourceDatabase: database,
        candidateDatabase: candidate,
        persistedPlan: persisted,
        runDir,
      });
      expect(cleaned.verified).toBe(true);
      expect(
        verifyMixedCandidate(candidate, plan, {
          expectLegacyRemoved: true,
        }).verified,
      ).toBe(true);
      expect(
        JSON.parse(
          readFileSync(
            join(runDir, "mixed-cleanup-receipt.json"),
            "utf8",
          ),
        ).sessions,
      ).toHaveLength(1);
    },
  );

  test.each([false, true])(
    "splices before an existing V2 suffix and shifts inputs/context (sparse=%s)",
    async (sparseLegacyPrefix) => {
      const { root, database } = fixture();
      const seeded = seedExistingV2(database, {
        position: "after-legacy",
        includePrompt: true,
        includeContext: true,
        sparseLegacyPrefix,
      });
      const plan = await buildMixedMigrationPlan({
        databasePath: database,
        sessionIds: [FIXTURE_SESSION_ID],
      });
      const persisted = persistableMixedPlan(plan, `splice-${sparseLegacyPrefix}`);
      const session = persisted.sessions[0]!;
      expect(session.shape).toBe("legacy-then-v2");
      expect(session.shiftedExistingV2Rows).toBe(true);
      expect(session.sparseLegacyPrefix).toBe(sparseLegacyPrefix);

      const candidate = join(root, `splice-${sparseLegacyPrefix}.db`);
      const runDir = join(root, `splice-${sparseLegacyPrefix}-run`);
      await migrateMixedLocal({
        sourceDatabase: database,
        candidateDatabase: candidate,
        persistedPlan: persisted,
        runDir,
      });
      const inspected = new Database(candidate, {
        readonly: true,
        strict: true,
      });
      const event = inspected
        .query<{ seq: number; data: string }, [string]>(
          "SELECT seq, data FROM event WHERE id = ?",
        )
        .get(`evt_existing_v2_${seeded.firstV2Seq}`)!;
      const input = inspected
        .query<
          { admitted_seq: number; promoted_seq: number },
          [string]
        >(
          `SELECT admitted_seq, promoted_seq
           FROM session_input WHERE id = ?`,
        )
        .get("msg_existing_v2_user")!;
      const context = inspected
        .query<{ baseline_seq: number }, [string]>(
          `SELECT baseline_seq
           FROM session_context_epoch WHERE session_id = ?`,
        )
        .get(FIXTURE_SESSION_ID)!;
      inspected.close();
      expect(event.seq).toBe(
        seeded.firstV2Seq + session.generatedEventCount,
      );
      expect(JSON.parse(event.data).agent).toBe("build");
      expect(input).toEqual({
        admitted_seq:
          seeded.originalInputSeq! + session.generatedEventCount,
        promoted_seq:
          seeded.originalInputSeq! + session.generatedEventCount,
      });
      expect(context.baseline_seq).toBe(
        seeded.originalContextSeq! + session.generatedEventCount,
      );

      await cleanupMixedLocal({
        sourceDatabase: database,
        candidateDatabase: candidate,
        persistedPlan: persisted,
        runDir,
      });
      const rerun = await cleanupMixedLocal({
        sourceDatabase: database,
        candidateDatabase: candidate,
        persistedPlan: persisted,
        runDir,
      });
      expect(rerun.verified).toBe(true);
    },
  );

  test("accepts and preserves known historical V2 optional-field projections", async () => {
    const { root, database } = fixture();
    seedExistingV2(database, {
      position: "after-legacy",
    });
    const historical = appendHistoricalProjectionVariant(database);
    const plan = await buildMixedMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    const persisted = persistableMixedPlan(plan, "historical-projection");
    expect(
      persisted.sessions[0]!.historicalProjectionVariants,
    ).toEqual([
      { kind: "reasoning-provider-metadata-null", count: 1 },
      { kind: "reasoning-time-omitted", count: 1 },
      { kind: "tool-output-paths-empty-omitted", count: 1 },
      { kind: "tool-provider-false-omitted", count: 1 },
      { kind: "tool-ran-omitted", count: 1 },
    ]);
    const candidate = join(root, "historical-projection.db");
    const runDir = join(root, "historical-projection-run");
    await migrateMixedLocal({
      sourceDatabase: database,
      candidateDatabase: candidate,
      persistedPlan: persisted,
      runDir,
    });
    await cleanupMixedLocal({
      sourceDatabase: database,
      candidateDatabase: candidate,
      persistedPlan: persisted,
      runDir,
    });
    const inspected = new Database(candidate, {
      readonly: true,
      strict: true,
    });
    const stored = inspected
      .query<{ seq: number; data: string }, [string]>(
        "SELECT seq, data FROM session_message WHERE id = ?",
      )
      .get(historical.assistantId)!;
    inspected.close();
    expect(stored.seq).toBe(
      historical.originalSeq +
        persisted.sessions[0]!.generatedEventCount,
    );
    expect(JSON.parse(stored.data)).toEqual(
      JSON.parse(historical.originalData),
    );
  });

  test("cleans complete V2 dual-write rows without generating or shifting data", async () => {
    const { root, database } = fixture();
    const pure = buildMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    }).sessions[0]!;
    materializeTargetProjection(database, pure);
    const plan = await buildMixedMigrationPlan({
      databasePath: database,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    const persisted = persistableMixedPlan(plan, "dual-write-cleanup");
    expect(persisted.sessions[0]!.shape).toBe(
      "v2-dual-write-cleanup",
    );
    expect(persisted.sessions[0]!.generatedEventCount).toBe(0);
    expect(persisted.sessions[0]!.shiftedExistingV2Rows).toBe(false);

    const candidate = join(root, "dual-write-cleanup.db");
    const runDir = join(root, "dual-write-cleanup-run");
    await migrateMixedLocal({
      sourceDatabase: database,
      candidateDatabase: candidate,
      persistedPlan: persisted,
      runDir,
    });
    await cleanupMixedLocal({
      sourceDatabase: database,
      candidateDatabase: candidate,
      persistedPlan: persisted,
      runDir,
    });
    const inspected = new Database(candidate, {
      readonly: true,
      strict: true,
    });
    const counts = inspected
      .query<
        {
          legacy_messages: number;
          legacy_parts: number;
          v2_messages: number;
        },
        [string, string, string]
      >(
        `SELECT
           (SELECT COUNT(*) FROM message WHERE session_id = ?) AS legacy_messages,
           (SELECT COUNT(*) FROM part WHERE session_id = ?) AS legacy_parts,
           (SELECT COUNT(*) FROM session_message WHERE session_id = ?) AS v2_messages`,
      )
      .get(
        FIXTURE_SESSION_ID,
        FIXTURE_SESSION_ID,
        FIXTURE_SESSION_ID,
      )!;
    inspected.close();
    expect(counts.legacy_messages).toBe(0);
    expect(counts.legacy_parts).toBe(0);
    expect(counts.v2_messages).toBe(pure.expectedMessages.length);
  });

  test("fails closed on pending V2 input and source/candidate aliasing", async () => {
    const { root, database } = fixture();
    seedExistingV2(database, {
      position: "after-legacy",
      includePrompt: true,
    });
    const pending = new Database(database);
    pending
      .query(
        `UPDATE session_input
         SET promoted_seq = NULL
         WHERE id = 'msg_existing_v2_user'`,
      )
      .run();
    pending.close();
    await expect(
      buildMixedMigrationPlan({
        databasePath: database,
        sessionIds: [FIXTURE_SESSION_ID],
      }),
    ).rejects.toThrow("V2_INPUT_WITHOUT_SETTLED_EVENTS");

    const corruptProjection = fixture();
    seedExistingV2(corruptProjection.database, {
      position: "after-legacy",
    });
    const corrupted = new Database(corruptProjection.database);
    corrupted
      .query(
        `UPDATE session_message
         SET data = ?
         WHERE id = 'msg_existing_v2_agent'`,
      )
      .run(
        JSON.stringify({
          agent: "divergent-agent",
          time: { created: 2_050 },
        }),
      );
    corrupted.close();
    await expect(
      buildMixedMigrationPlan({
        databasePath: corruptProjection.database,
        sessionIds: [FIXTURE_SESSION_ID],
      }),
    ).rejects.toThrow("V2_MESSAGE_PROJECTION_DIVERGENCE");

    const interactingSuffix = fixture();
    seedExistingV2(interactingSuffix.database, {
      position: "after-legacy",
    });
    const interacting = new Database(interactingSuffix.database);
    const suffixSeq = interacting
      .query<{ seq: number }, [string]>(
        "SELECT seq FROM event_sequence WHERE aggregate_id = ?",
      )
      .get(FIXTURE_SESSION_ID)!.seq;
    insertV2Event(
      interacting,
      suffixSeq + 1,
      "session.next.text.started.1",
      {
        sessionID: FIXTURE_SESSION_ID,
        assistantMessageID: "msg_fixture_assistant",
        textID: "txt_existing_suffix_interaction",
        timestamp: 2_095,
      },
    );
    interacting
      .query(
        "UPDATE event_sequence SET seq = ? WHERE aggregate_id = ?",
      )
      .run(suffixSeq + 1, FIXTURE_SESSION_ID);
    interacting.close();
    await expect(
      buildMixedMigrationPlan({
        databasePath: interactingSuffix.database,
        sessionIds: [FIXTURE_SESSION_ID],
      }),
    ).rejects.toThrow("COMBINED_V2_PROJECTION_DIVERGENCE");

    const semanticProjectionLoss = fixture();
    seedExistingV2(semanticProjectionLoss.database, {
      position: "after-legacy",
    });
    appendHistoricalProjectionVariant(semanticProjectionLoss.database, {
      providerExecuted: true,
    });
    await expect(
      buildMixedMigrationPlan({
        databasePath: semanticProjectionLoss.database,
        sessionIds: [FIXTURE_SESSION_ID],
      }),
    ).rejects.toThrow("V2_MESSAGE_PROJECTION_DIVERGENCE");

    const clean = fixture();
    seedExistingV2(clean.database, {
      position: "after-legacy",
    });
    const plan = await buildMixedMigrationPlan({
      databasePath: clean.database,
      sessionIds: [FIXTURE_SESSION_ID],
    });
    await expect(
      migrateMixedLocal({
        sourceDatabase: clean.database,
        candidateDatabase: clean.database,
        persistedPlan: persistableMixedPlan(plan, "alias"),
        runDir: root,
      }),
    ).rejects.toThrow("SOURCE_CANDIDATE_COLLISION");

    const hardlink = join(clean.root, "source-hardlink.db");
    linkSync(clean.database, hardlink);
    await expect(
      migrateMixedLocal({
        sourceDatabase: clean.database,
        candidateDatabase: hardlink,
        persistedPlan: persistableMixedPlan(plan, "hardlink-alias"),
        runDir: root,
      }),
    ).rejects.toThrow("SOURCE_CANDIDATE_COLLISION");

    const symlink = join(clean.root, "source-symlink.db");
    symlinkSync(clean.database, symlink);
    await expect(
      cleanupMixedLocal({
        sourceDatabase: clean.database,
        candidateDatabase: symlink,
        persistedPlan: persistableMixedPlan(plan, "symlink-alias"),
        runDir: root,
      }),
    ).rejects.toThrow("SOURCE_CANDIDATE_COLLISION");
  });
});
