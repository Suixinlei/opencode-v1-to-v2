/** Anonymous OpenAI-compatible model used by the continuation proof. */
interface AssertionRecord {
  sentinelSeen: boolean;
  probeSeen: boolean;
  probeIndex: number;
  messageCount: number;
  requestDigest: string;
}

const sentinel = Buffer.from(
  requiredEnvironment("E2E_LEGACY_SENTINEL_B64"),
  "base64",
).toString("utf8");
const probes = [
  requiredEnvironment("E2E_PROBE_1"),
  requiredEnvironment("E2E_PROBE_2"),
] as const;
const proof = requiredEnvironment("E2E_PROOF");
const modelId = requiredEnvironment("E2E_MODEL_ID");
const assertions: AssertionRecord[] = [];

function requiredEnvironment(name: string): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`MISSING_ENV_${name}`);
  return value;
}

function digest(value: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(value);
  return `sha256:${hash.digest("hex")}`;
}

function normalizedText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function containsText(value: unknown, needle: string): boolean {
  const expected = normalizedText(needle);
  if (typeof value === "string") {
    return normalizedText(value).includes(expected);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsText(item, needle));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsText(item, needle));
  }
  return false;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function completion(model: string): Response {
  return json({
    id: "chatcmpl_e2e",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: proof },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  });
}

function streamingCompletion(model: string): Response {
  const chunks = [
    {
      id: "chatcmpl_e2e",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: proof },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl_e2e",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

Bun.serve({
  hostname: "0.0.0.0",
  port: 8787,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ healthy: true });
    }
    if (request.method === "GET" && url.pathname === "/assertions") {
      return json({
        requestCount: assertions.length,
        assertions,
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return json({
        object: "list",
        data: [
          {
            id: modelId,
            object: "model",
            created: 1,
            owned_by: "e2e",
          },
        ],
      });
    }
    if (
      request.method !== "POST" ||
      url.pathname !== "/v1/chat/completions"
    ) {
      return json({ accepted: false }, 404);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ accepted: false }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ accepted: false }, 400);
    }

    const raw = JSON.stringify(body);
    const probeOffset = probes.findIndex((probe) =>
      containsText(body, probe)
    );
    const messages = (body as { messages?: unknown }).messages;
    assertions.push({
      sentinelSeen: containsText(body, sentinel),
      probeSeen: probeOffset >= 0,
      probeIndex: probeOffset < 0 ? 0 : probeOffset + 1,
      messageCount: Array.isArray(messages) ? messages.length : 0,
      requestDigest: digest(raw),
    });

    const model =
      typeof (body as { model?: unknown }).model === "string"
        ? (body as { model: string }).model
        : "test-model";
    return (body as { stream?: unknown }).stream === false
      ? completion(model)
      : streamingCompletion(model);
  },
});
