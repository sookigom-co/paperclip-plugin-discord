import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `taskChannels`: an existing Discord channel the operator names becomes the
// conversation window for one task, outranking that task's own thread.

const { capturedDefinitions } = vi.hoisted(() => ({ capturedDefinitions: [] as any[] }));

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedDefinitions.push(def);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

const { gatewayConnects } = vi.hoisted(() => ({ gatewayConnects: [] as any[] }));

vi.mock("../src/gateway.js", () => ({
  connectGateway: vi.fn(async (_ctx: any, token: string, onInteraction: any, onMessage: any, options: any) => {
    const record: any = {
      token,
      onInteraction,
      onMessage,
      options,
      closed: false,
      close: () => {
        record.closed = true;
      },
    };
    gatewayConnects.push(record);
    return record;
  }),
}));

import { _resetRuntimeForTests, _getRuntimeForTests } from "../src/worker.js";
import { _resetCompanyIdCache } from "../src/company-resolver.js";
import { issueBindingStateKey, threadBindingStateKey, voiceTargetStateKey } from "../src/task-threads.js";

const COMPANY = "11111111-1111-1111-1111-111111111111";
const SECRET_ID = "33333333-3333-3333-3333-333333333333";
const DEFAULT_CHANNEL = "ch-default";
const TASK_CHANNEL = "ch-soo-61";
const ROOT_UUID = "44444444-4444-4444-4444-444444444444";

function storedConfig(overrides: Record<string, unknown> = {}) {
  return {
    discordBotTokenRef: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
    defaultChannelId: DEFAULT_CHANNEL,
    defaultGuildId: "",
    paperclipBaseUrl: "https://paperclip.example.com",
    notifyOnIssueCreated: true,
    notifyOnIssueDone: true,
    notifyOnApprovalCreated: false,
    notifyOnAgentError: false,
    enableInbound: true,
    enableIntelligence: false,
    intelligenceChannelIds: [],
    enableEscalations: false,
    enableCommands: false,
    topicRouting: false,
    digestMode: "off",
    ...overrides,
  };
}

/** The config shape that maps SOO-61 to one channel. */
function mappedConfig(overrides: Record<string, unknown> = {}) {
  return storedConfig({ taskChannels: { "SOO-61": TASK_CHANNEL }, ...overrides });
}

let issueFixtures: Record<string, any>;
let deadChannels: Set<string>;
let forbiddenChannels: Set<string>;
let postedMessageCount: number;
let createdThreadCount: number;
let paperclipFetchMock: ReturnType<typeof vi.fn>;

function buildHost() {
  const stateStore = new Map<string, unknown>();
  const eventHandlers = new Map<string, any[]>();

  const discordFetch = vi.fn(async (url: any, init: any) => {
    const target = String(url);
    if (/\/threads$/.test(target)) {
      createdThreadCount += 1;
      return {
        ok: true,
        status: 201,
        headers: new Headers(),
        json: async () => ({ id: `thread-${createdThreadCount}` }),
        text: async () => "",
      };
    }

    const postMatch = target.match(/\/channels\/([^/]+)\/messages$/);
    if (postMatch && (init?.method ?? "GET") === "POST") {
      const channelId = postMatch[1]!;
      if (deadChannels.has(channelId)) {
        return { ok: false, status: 404, headers: new Headers(), json: async () => ({}), text: async () => "Unknown Channel" };
      }
      if (forbiddenChannels.has(channelId)) {
        return { ok: false, status: 403, headers: new Headers(), json: async () => ({}), text: async () => "Missing Permissions" };
      }
      postedMessageCount += 1;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ id: `msg-${postedMessageCount}` }),
        text: async () => "",
      };
    }

    return { ok: true, status: 200, headers: new Headers(), json: async () => ({}), text: async () => "" };
  });

  const ctx = {
    config: {
      get: vi.fn(async (companyId?: string) => {
        if (!companyId) throw new Error('not allowed to perform "config.get": company context is required');
        return storedConfig();
      }),
    },
    secrets: { resolve: vi.fn(async () => "discord-bot-token") },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn(async (key: any) => stateStore.get(stateKey(key)) ?? null),
      set: vi.fn(async (key: any, value: unknown) => {
        stateStore.set(stateKey(key), value);
      }),
    },
    metrics: { write: vi.fn() },
    activity: { log: vi.fn() },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: {
      on: vi.fn((name: string, handler: any) => {
        const list = eventHandlers.get(name) ?? [];
        list.push(handler);
        eventHandlers.set(name, list);
        return () => {};
      }),
      emit: vi.fn(),
      subscribe: vi.fn(),
    },
    companies: {
      list: vi.fn(async () => [{ id: COMPANY, name: "Acme" }]),
      get: vi.fn(async () => ({ id: COMPANY, name: "Acme", issuePrefix: "SOO" })),
    },
    agents: { list: vi.fn(async () => []), invoke: vi.fn() },
    issues: {
      list: vi.fn(async () => Object.values(issueFixtures)),
      get: vi.fn(async (issueId: string, companyId?: string) => {
        if (companyId && companyId !== COMPANY) return null;
        return issueFixtures[issueId] ?? null;
      }),
      listComments: vi.fn(async () => []),
    },
    http: { fetch: discordFetch },
  } as any;

  return { ctx, stateStore, eventHandlers, discordFetch };
}

function stateKey(key: { scopeKind: string; scopeId?: string; stateKey: string }): string {
  return `${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`;
}

function definition(): any {
  return capturedDefinitions[capturedDefinitions.length - 1];
}

function gateway(): any {
  return gatewayConnects[gatewayConnects.length - 1];
}

async function mount(ctx: any, config = mappedConfig()) {
  _resetRuntimeForTests();
  _resetCompanyIdCache();
  await definition().setup(ctx);
  await definition().onConfigChanged(config, { companyId: COMPANY });
}

let eventCounter = 0;

function issueEvent(
  eventType: string,
  entityId: string,
  payload: Record<string, unknown> = {},
  companyId = COMPANY,
): any {
  eventCounter += 1;
  return {
    eventId: `evt-${eventCounter}`,
    eventType,
    occurredAt: new Date().toISOString(),
    companyId,
    entityId,
    entityType: "issue",
    payload,
  };
}

async function emit(eventHandlers: Map<string, any[]>, eventType: string, event: any) {
  for (const handler of eventHandlers.get(eventType) ?? []) {
    await handler(event);
  }
}

function messagePosts(discordFetch: ReturnType<typeof vi.fn>) {
  return discordFetch.mock.calls
    .filter(([url, init]: any[]) => /\/channels\/[^/]+\/messages$/.test(String(url)) && init?.method === "POST")
    .map(([url, init]: any[]) => ({
      channelId: String(url).match(/\/channels\/([^/]+)\/messages$/)![1]!,
      body: JSON.parse(init.body),
    }));
}

function threadCreations(discordFetch: ReturnType<typeof vi.fn>) {
  return discordFetch.mock.calls.filter(([url]: any[]) => String(url).endsWith("/threads"));
}

function commentPosts() {
  return paperclipFetchMock.mock.calls.filter(([url]: any[]) => String(url).includes("/comments"));
}

function channelMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "inbound-1",
    channel_id: TASK_CHANNEL,
    content: "보드가 그냥 말한다",
    author: { id: "u1", username: "board", bot: false },
    ...overrides,
  } as any;
}

function seedBinding(
  stateStore: Map<string, unknown>,
  binding: { issueId: string; threadId: string; issueIdentifier?: string | null; parentChannelId?: string },
) {
  const record = {
    issueId: binding.issueId,
    issueIdentifier: binding.issueIdentifier ?? null,
    threadId: binding.threadId,
    parentChannelId: binding.parentChannelId ?? DEFAULT_CHANNEL,
    companyId: COMPANY,
    createdAt: new Date().toISOString(),
  };
  stateStore.set(`company:${COMPANY}:${issueBindingStateKey(record.issueId)}`, record);
  stateStore.set(`instance::${threadBindingStateKey(record.threadId)}`, record);
  return record;
}

/** The root task every mapping in this file names, plus one child of it. */
function seedIssues() {
  issueFixtures[ROOT_UUID] = {
    id: ROOT_UUID,
    identifier: "SOO-61",
    title: "루트 태스크",
    status: "todo",
    parentId: null,
  };
  issueFixtures["child-1"] = {
    id: "child-1",
    identifier: "SOO-62",
    title: "하위 태스크",
    status: "todo",
    parentId: ROOT_UUID,
  };
}

function warnings(ctx: any): string[] {
  return ctx.logger.warn.mock.calls.map(([message]: any[]) => String(message));
}

beforeEach(() => {
  gatewayConnects.length = 0;
  issueFixtures = {};
  deadChannels = new Set();
  forbiddenChannels = new Set();
  postedMessageCount = 0;
  createdThreadCount = 0;
  vi.clearAllMocks();

  paperclipFetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => "",
  })) as any;
  vi.stubGlobal("fetch", paperclipFetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("config: resolving taskChannels keys", () => {
  it("resolves an identifier key to its issue and indexes the channel both ways", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx);

    const router = _getRuntimeForTests()!.taskChannels;
    expect(router.byIssueId.get(ROOT_UUID)).toBe(TASK_CHANNEL);
    expect(router.byChannelId.get(TASK_CHANNEL)).toBe(ROOT_UUID);
    expect(router.mappings).toEqual([
      { configKey: "SOO-61", channelId: TASK_CHANNEL, issueId: ROOT_UUID, issueIdentifier: "SOO-61" },
    ]);
  });

  it("accepts an issue UUID as the key", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx, storedConfig({ taskChannels: { [ROOT_UUID]: TASK_CHANNEL } }));

    expect(_getRuntimeForTests()!.taskChannels.byIssueId.get(ROOT_UUID)).toBe(TASK_CHANNEL);
  });

  it("matches an identifier key case-insensitively", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx, storedConfig({ taskChannels: { "soo-61": TASK_CHANNEL } }));

    expect(_getRuntimeForTests()!.taskChannels.byIssueId.get(ROOT_UUID)).toBe(TASK_CHANNEL);
  });

  it("caches a resolved key so a second bootstrap does not look it up again", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx);
    const listCallsAfterFirst = host.ctx.issues.list.mock.calls.length;

    await definition().onConfigChanged(mappedConfig(), { companyId: COMPANY });

    expect(host.ctx.issues.list.mock.calls.length).toBe(listCallsAfterFirst);
    expect(_getRuntimeForTests()!.taskChannels.byIssueId.get(ROOT_UUID)).toBe(TASK_CHANNEL);
  });

  it("warns once about a key naming no task, and keeps the other keys working", async () => {
    const host = buildHost();
    seedIssues();
    await mount(
      host.ctx,
      storedConfig({ taskChannels: { "SOO-404": "ch-ghost", "SOO-61": TASK_CHANNEL } }),
    );

    const router = _getRuntimeForTests()!.taskChannels;
    expect(router.byChannelId.has("ch-ghost")).toBe(false);
    expect(router.byIssueId.get(ROOT_UUID)).toBe(TASK_CHANNEL);
    expect(router.mappings.find((m) => m.configKey === "SOO-404")).toMatchObject({ issueId: null });

    const unresolvedWarnings = warnings(host.ctx).filter((m) => m.includes("no record of"));
    expect(unresolvedWarnings).toHaveLength(1);
  });

  it("warns when a mapped channel is also the default or approvals channel", async () => {
    const host = buildHost();
    seedIssues();
    await mount(
      host.ctx,
      storedConfig({
        approvalsChannelId: "ch-approvals",
        taskChannels: { "SOO-61": DEFAULT_CHANNEL, [ROOT_UUID]: DEFAULT_CHANNEL },
      }),
    );

    const shared = warnings(host.ctx).filter((m) => m.includes("general notification channel"));
    expect(shared).toHaveLength(1);
    // The warning does not change the configuration.
    expect(_getRuntimeForTests()!.taskChannels.byChannelId.get(DEFAULT_CHANNEL)).toBe(ROOT_UUID);
  });

  it("ignores an entry whose channel id is blank", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx, storedConfig({ taskChannels: { "SOO-61": "   " } }));

    expect(_getRuntimeForTests()!.taskChannels.byChannelId.size).toBe(0);
  });
});

describe("outbound: the mapped channel is where the task's news goes", () => {
  it("posts the mapped task's own card to the mapped channel, whole", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx);

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", ROOT_UUID));

    const posts = messagePosts(host.discordFetch);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channelId).toBe(TASK_CHANNEL);
    expect(posts[0]!.body.embeds[0].title).toContain("SOO-61");
  });

  it("never opens a thread for a task that already has a channel", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx);

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", ROOT_UUID));

    expect(threadCreations(host.discordFetch)).toHaveLength(0);
    expect(host.stateStore.get(`company:${COMPANY}:${issueBindingStateKey(ROOT_UUID)}`)).toBeUndefined();
  });

  it("rolls a descendant's event into the mapped channel as one compressed line", async () => {
    const host = buildHost();
    seedIssues();
    issueFixtures["child-1"].status = "done";
    issueFixtures["child-1"].completedAt = "2026-10-20T00:00:00.000Z";
    await mount(host.ctx);

    await emit(host.eventHandlers, "issue.updated", issueEvent("issue.updated", "child-1", { status: "done" }));

    const posts = messagePosts(host.discordFetch);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channelId).toBe(TASK_CHANNEL);
    expect(posts[0]!.body.embeds).toBeUndefined();
    expect(posts[0]!.body.content).toBe(
      "↳ [**SOO-62**](https://paperclip.example.com/SOO/issues/child-1) 하위 태스크 — Done",
    );
  });

  it("keeps a descendant's approval card whole so its buttons stay pressable", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx, mappedConfig({ notifyOnApprovalCreated: true }));

    eventCounter += 1;
    await emit(host.eventHandlers, "approval.created", {
      eventId: `evt-appr-${eventCounter}`,
      eventType: "approval.created",
      occurredAt: new Date().toISOString(),
      companyId: COMPANY,
      entityId: "appr-1",
      entityType: "approval",
      payload: { approvalId: "appr-1", type: "decision", title: "배포 승인", issueId: "child-1" },
    });

    const posts = messagePosts(host.discordFetch);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channelId).toBe(TASK_CHANNEL);
    const buttonIds = posts[0]!.body.components[0].components.map((c: any) => c.custom_id);
    expect(buttonIds).toContain("approval_approve_appr-1");
    expect(buttonIds).toContain("approval_reject_appr-1");
  });

  it("outranks a thread bound to the same task", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx);
    seedBinding(host.stateStore, { issueId: ROOT_UUID, threadId: "thread-1", issueIdentifier: "SOO-61" });

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", ROOT_UUID));

    expect(messagePosts(host.discordFetch)[0]!.channelId).toBe(TASK_CHANNEL);
  });

  it("outranks topic routing and the default channel", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx, mappedConfig({ topicRouting: true }));
    host.stateStore.set("instance::channel-project-map", { Apollo: "ch-topic" });

    await emit(
      host.eventHandlers,
      "issue.created",
      issueEvent("issue.created", ROOT_UUID, { projectName: "Apollo" }),
    );

    expect(messagePosts(host.discordFetch)[0]!.channelId).toBe(TASK_CHANNEL);
  });

  it("outranks an event-type channel override", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx, mappedConfig({ notifyOnAgentError: true, errorsChannelId: "ch-errors" }));

    eventCounter += 1;
    await emit(host.eventHandlers, "agent.run.failed", {
      eventId: `evt-fail-${eventCounter}`,
      eventType: "agent.run.failed",
      occurredAt: new Date().toISOString(),
      companyId: COMPANY,
      entityId: "run-2",
      entityType: "heartbeat_run",
      payload: { runId: "run-2", issueId: ROOT_UUID },
    });

    expect(messagePosts(host.discordFetch)[0]!.channelId).toBe(TASK_CHANNEL);
  });

  it("works with task threads switched off entirely", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx, mappedConfig({ enableTaskThreads: false }));

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", "child-1"));

    const posts = messagePosts(host.discordFetch);
    expect(posts[0]!.channelId).toBe(TASK_CHANNEL);
    expect(posts[0]!.body.content).toContain("↳");
  });
});

describe("outbound: the nearest ancestor owns the destination", () => {
  it("lets a descendant's own thread win over a mapped grandparent", async () => {
    const host = buildHost();
    seedIssues();
    issueFixtures["grandchild-1"] = {
      id: "grandchild-1",
      identifier: "SOO-63",
      title: "손자",
      status: "todo",
      parentId: "child-1",
    };
    await mount(host.ctx);
    seedBinding(host.stateStore, { issueId: "child-1", threadId: "thread-child", issueIdentifier: "SOO-62" });

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", "grandchild-1"));

    expect(messagePosts(host.discordFetch)[0]!.channelId).toBe("thread-child");
  });

  it("lets a mapped parent win over a thread bound further up", async () => {
    const host = buildHost();
    seedIssues();
    issueFixtures["grandchild-1"] = {
      id: "grandchild-1",
      identifier: "SOO-63",
      title: "손자",
      status: "todo",
      parentId: "child-1",
    };
    issueFixtures["child-1"].parentId = "ancestor-1";
    issueFixtures["ancestor-1"] = { id: "ancestor-1", identifier: "SOO-60", title: "조상", parentId: null };
    await mount(host.ctx, storedConfig({ taskChannels: { "SOO-62": TASK_CHANNEL } }));
    seedBinding(host.stateStore, { issueId: "ancestor-1", threadId: "thread-top", issueIdentifier: "SOO-60" });

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", "grandchild-1"));

    expect(messagePosts(host.discordFetch)[0]!.channelId).toBe(TASK_CHANNEL);
  });

  it("falls back to the ordinary channel chain past the ancestor depth limit", async () => {
    const host = buildHost();
    seedIssues();
    let parentId = ROOT_UUID;
    for (let depth = 1; depth <= 7; depth++) {
      const id = `deep-${depth}`;
      issueFixtures[id] = { id, identifier: `SOO-7${depth}`, title: `깊이 ${depth}`, parentId };
      parentId = id;
    }
    await mount(host.ctx);

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", "deep-7"));

    expect(messagePosts(host.discordFetch)[0]!.channelId).toBe(DEFAULT_CHANNEL);
  });
});

describe("outbound: a mapped channel that refuses the post", () => {
  it("falls back to the channel chain with the full card and keeps the mapping", async () => {
    const host = buildHost();
    seedIssues();
    forbiddenChannels.add(TASK_CHANNEL);
    await mount(host.ctx);

    await emit(host.eventHandlers, "issue.updated", issueEvent("issue.updated", "child-1", { status: "done" }));

    const posts = messagePosts(host.discordFetch);
    expect(posts.map((p) => p.channelId)).toEqual([TASK_CHANNEL, DEFAULT_CHANNEL]);
    // The rolled-up line was compressed for the mapped channel; the fallback is whole.
    expect(posts[1]!.body.embeds[0].title).toContain("SOO-62");
    expect(_getRuntimeForTests()!.taskChannels.byChannelId.get(TASK_CHANNEL)).toBe(ROOT_UUID);
  });

  it("keeps the mapping even on a 404, which retires a thread binding", async () => {
    const host = buildHost();
    seedIssues();
    deadChannels.add(TASK_CHANNEL);
    await mount(host.ctx);

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", ROOT_UUID));

    expect(messagePosts(host.discordFetch).map((p) => p.channelId)).toEqual([TASK_CHANNEL, DEFAULT_CHANNEL]);
    expect(_getRuntimeForTests()!.taskChannels.byChannelId.get(TASK_CHANNEL)).toBe(ROOT_UUID);

    // Still mapped on the next event, too.
    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", "child-1"));
    expect(messagePosts(host.discordFetch).map((p) => p.channelId)).toEqual([
      TASK_CHANNEL,
      DEFAULT_CHANNEL,
      TASK_CHANNEL,
      DEFAULT_CHANNEL,
    ]);
  });
});

describe("inbound: plain talk in a mapped channel is a comment on its task", () => {
  it("routes a message that is not a reply to the mapped task", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx);

    await gateway().onMessage(channelMessage());

    const posts = commentPosts();
    expect(posts).toHaveLength(1);
    expect(String(posts[0]![0])).toBe(`https://paperclip.example.com/api/issues/${ROOT_UUID}/comments`);
    expect(JSON.parse((posts[0]![1] as any).body)).toEqual({
      body: "보드가 그냥 말한다",
      authorUserId: "discord:board",
    });
  });

  it("routes a reply to the card it answers, not to the mapped task", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx);
    host.stateStore.set(`instance::msg_${TASK_CHANNEL}_msg-9`, {
      entityId: "child-1",
      entityType: "issue",
      companyId: COMPANY,
    });

    await gateway().onMessage(
      channelMessage({ message_reference: { message_id: "msg-9", channel_id: TASK_CHANNEL } }),
    );

    expect(String(commentPosts()[0]![0])).toContain("/api/issues/child-1/comments");
  });

  it("falls back to the mapped task when the reply's card is unknown", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx);

    await gateway().onMessage(
      channelMessage({ message_reference: { message_id: "msg-unknown", channel_id: TASK_CHANNEL } }),
    );

    expect(String(commentPosts()[0]![0])).toContain(`/api/issues/${ROOT_UUID}/comments`);
  });

  it("still refuses a bot author, so a voice transcript cannot loop back in", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx);

    await gateway().onMessage(channelMessage({ author: { id: "b1", username: "Voice", bot: true } }));

    expect(commentPosts()).toHaveLength(0);
  });

  it("ignores plain talk in a channel no task is mapped to", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx);

    await gateway().onMessage(channelMessage({ channel_id: DEFAULT_CHANNEL }));

    expect(commentPosts()).toHaveLength(0);
  });

  it("lets a bound thread in the mapped channel keep its own task", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx);
    seedBinding(host.stateStore, {
      issueId: "child-1",
      threadId: "thread-child",
      issueIdentifier: "SOO-62",
      parentChannelId: TASK_CHANNEL,
    });

    await gateway().onMessage(channelMessage({ channel_id: "thread-child" }));

    expect(String(commentPosts()[0]![0])).toContain("/api/issues/child-1/comments");
  });
});

describe("voice: a mapped channel is a fixed destination", () => {
  it("points the channel at its task at bootstrap", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx);

    expect(host.stateStore.get(`instance::${voiceTargetStateKey(TASK_CHANNEL)}`)).toEqual({
      entityId: ROOT_UUID,
      entityType: "issue",
      companyId: COMPANY,
    });
  });

  it("does not let a subtask rollup take the pointer", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx);

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", "child-1"));

    expect(host.stateStore.get(`instance::${voiceTargetStateKey(TASK_CHANNEL)}`)).toEqual({
      entityId: ROOT_UUID,
      entityType: "issue",
      companyId: COMPANY,
    });
  });

  it("leaves an unmapped channel on last-notification-wins", async () => {
    const host = buildHost();
    seedIssues();
    issueFixtures["loose-1"] = { id: "loose-1", identifier: "SOO-90", title: "무관", parentId: null };
    await mount(host.ctx);

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", "loose-1"));

    expect(host.stateStore.get(`instance::${voiceTargetStateKey(DEFAULT_CHANNEL)}`)).toMatchObject({
      entityId: "loose-1",
    });
  });
});

describe("/clip status shows the operator what actually bound", () => {
  it("lists resolved and unresolved mappings", async () => {
    const host = buildHost();
    seedIssues();
    await mount(
      host.ctx,
      storedConfig({ taskChannels: { "SOO-61": TASK_CHANNEL, "SOO-404": "ch-ghost" } }),
    );

    const response: any = await gateway().onInteraction({
      type: 2,
      data: { name: "clip", options: [{ name: "status", type: 1 }] },
      member: { user: { username: "board" } },
    });

    const field = response.data.embeds[0].fields.find((f: any) => f.name.startsWith("Task Channels"));
    expect(field.name).toBe("Task Channels (2)");
    expect(field.value).toContain(`**SOO-61** → <#${TASK_CHANNEL}>`);
    expect(field.value).toContain("`SOO-404` → <#ch-ghost> — task not found, entry ignored");
  });

  it("adds no field when nothing is mapped", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx, storedConfig());

    const response: any = await gateway().onInteraction({
      type: 2,
      data: { name: "clip", options: [{ name: "status", type: 1 }] },
      member: { user: { username: "board" } },
    });

    const names = response.data.embeds[0].fields.map((f: any) => f.name);
    expect(names).toHaveLength(3);
    expect(names.some((name: string) => name.startsWith("Task Channels"))).toBe(false);
  });
});

describe("an empty map leaves every existing route exactly as it was", () => {
  it("opens a thread for a root task and posts to the default channel", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx, storedConfig());

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", ROOT_UUID));

    const posts = messagePosts(host.discordFetch);
    expect(posts[0]!.channelId).toBe(DEFAULT_CHANNEL);
    expect(threadCreations(host.discordFetch)).toHaveLength(1);
    expect(host.stateStore.get(`company:${COMPANY}:${issueBindingStateKey(ROOT_UUID)}`)).toMatchObject({
      threadId: "thread-1",
    });
  });

  it("reads no state and makes no task lookup while resolving nothing", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx, storedConfig());

    expect(host.ctx.issues.list).not.toHaveBeenCalled();
    expect(
      host.ctx.state.get.mock.calls.filter(([key]: any[]) => String(key.stateKey).startsWith("task_channel_key_")),
    ).toHaveLength(0);
  });

  it("routes a descendant to the bound ancestor thread as before", async () => {
    const host = buildHost();
    seedIssues();
    await mount(host.ctx, storedConfig());
    seedBinding(host.stateStore, { issueId: ROOT_UUID, threadId: "thread-1", issueIdentifier: "SOO-61" });

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", "child-1"));

    expect(messagePosts(host.discordFetch)[0]!.channelId).toBe("thread-1");
  });
});
