import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A Discord thread as the conversation window for one task: descendants roll up
// into it, and plain talk in it becomes a comment on that task.

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

import { _resetRuntimeForTests } from "../src/worker.js";
import { _resetCompanyIdCache } from "../src/company-resolver.js";
import { handleInteraction, type CommandContext } from "../src/commands.js";
import { issueBindingStateKey, threadBindingStateKey, voiceTargetStateKey } from "../src/task-threads.js";

const COMPANY = "11111111-1111-1111-1111-111111111111";
const OTHER_COMPANY = "22222222-2222-2222-2222-222222222222";
const SECRET_ID = "33333333-3333-3333-3333-333333333333";
const DEFAULT_CHANNEL = "ch-default";

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

/** Issues the mock host can resolve, by id. */
let issueFixtures: Record<string, any>;
/** Channels Discord answers 404 for, as a deleted thread does. */
let deadChannels: Set<string>;
/** Channels Discord answers 403 for, as a locked thread or a missing permission does. */
let forbiddenChannels: Set<string>;
/** When true, Discord refuses to open a thread (403), as a missing permission does. */
let threadCreationFails: boolean;
let postedMessageCount: number;
let createdThreadCount: number;
let paperclipFetchMock: ReturnType<typeof vi.fn>;

function buildHost() {
  const stateStore = new Map<string, unknown>();
  const eventHandlers = new Map<string, any[]>();

  const discordFetch = vi.fn(async (url: any, init: any) => {
    const target = String(url);
    const threadMatch = target.match(/\/channels\/([^/]+)\/messages\/([^/]+)\/threads$/);
    if (threadMatch) {
      if (threadCreationFails) {
        return { ok: false, status: 403, headers: new Headers(), json: async () => ({}), text: async () => "missing permission" };
      }
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

async function mount(ctx: any, config = storedConfig()) {
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

/** Every message POST the plugin made, as `{ channelId, body }`. */
function messagePosts(discordFetch: ReturnType<typeof vi.fn>) {
  return discordFetch.mock.calls
    .filter(([url, init]: any[]) => /\/channels\/[^/]+\/messages$/.test(String(url)) && init?.method === "POST")
    .map(([url, init]: any[]) => ({
      channelId: String(url).match(/\/channels\/([^/]+)\/messages$/)![1]!,
      body: JSON.parse(init.body),
    }));
}

/** Every thread-creation POST the plugin made. */
function threadCreations(discordFetch: ReturnType<typeof vi.fn>) {
  return discordFetch.mock.calls.filter(([url]: any[]) => String(url).endsWith("/threads"));
}

/** Every issue-comment POST the plugin made to Paperclip. */
function commentPosts() {
  return paperclipFetchMock.mock.calls.filter(([url]: any[]) => String(url).includes("/comments"));
}

function threadMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "inbound-1",
    channel_id: "thread-1",
    content: "보드가 그냥 말한다",
    author: { id: "u1", username: "board", bot: false },
    ...overrides,
  } as any;
}

/** Seed the binding a human (or a root issue.created) would have created. */
function seedBinding(
  stateStore: Map<string, unknown>,
  binding: {
    issueId: string;
    threadId: string;
    issueIdentifier?: string | null;
    parentChannelId?: string;
    companyId?: string;
  },
) {
  const record = {
    issueId: binding.issueId,
    issueIdentifier: binding.issueIdentifier ?? null,
    threadId: binding.threadId,
    parentChannelId: binding.parentChannelId ?? DEFAULT_CHANNEL,
    companyId: binding.companyId ?? COMPANY,
    createdAt: new Date().toISOString(),
  };
  stateStore.set(`company:${record.companyId}:${issueBindingStateKey(record.issueId)}`, record);
  stateStore.set(`instance::${threadBindingStateKey(record.threadId)}`, record);
  return record;
}

beforeEach(() => {
  gatewayConnects.length = 0;
  issueFixtures = {};
  deadChannels = new Set();
  forbiddenChannels = new Set();
  threadCreationFails = false;
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

describe("outbound: a root task gets a thread, descendants roll up into it", () => {
  it("opens a thread for a root issue.created and binds the task to it", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = {
      id: "root-1",
      identifier: "SOO-1",
      title: "루트 태스크",
      status: "todo",
      parentId: null,
    };
    await mount(host.ctx);

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", "root-1"));

    const posts = messagePosts(host.discordFetch);
    expect(posts[0]!.channelId).toBe(DEFAULT_CHANNEL);
    expect(posts[0]!.body.embeds[0].title).toContain("SOO-1");

    const threads = threadCreations(host.discordFetch);
    expect(threads).toHaveLength(1);
    expect(String(threads[0]![0])).toContain(`/channels/${DEFAULT_CHANNEL}/messages/msg-1/threads`);
    expect(JSON.parse((threads[0]![1] as any).body).name).toBe("SOO-1 루트 태스크");

    const binding = host.stateStore.get(`company:${COMPANY}:${issueBindingStateKey("root-1")}`) as any;
    expect(binding).toMatchObject({ issueId: "root-1", threadId: "thread-1", parentChannelId: DEFAULT_CHANNEL });
    expect(host.stateStore.get(`instance::${threadBindingStateKey("thread-1")}`)).toMatchObject({
      issueId: "root-1",
    });

    // The thread opens with the line telling the board how to use it.
    const intro = posts.find((p) => p.channelId === "thread-1")!;
    expect(intro.body.content).toContain("SOO-1");
    expect(intro.body.content).toContain("코멘트");
    expect(host.stateStore.get(`instance::${voiceTargetStateKey("thread-1")}`)).toMatchObject({
      entityId: "root-1",
      entityType: "issue",
      companyId: COMPANY,
    });
  });

  it("sends a subtask's issue.created to the ancestor's thread without opening a new one", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = { id: "root-1", identifier: "SOO-1", title: "루트", parentId: null };
    issueFixtures["child-1"] = {
      id: "child-1",
      identifier: "SOO-2",
      title: "하위 태스크",
      status: "todo",
      parentId: "root-1",
    };
    await mount(host.ctx);
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-1", issueIdentifier: "SOO-1" });

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", "child-1"));

    const posts = messagePosts(host.discordFetch);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channelId).toBe("thread-1");
    expect(threadCreations(host.discordFetch)).toHaveLength(0);
  });

  it("rolls a subtask completion into the ancestor's thread as one compressed line", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = { id: "root-1", identifier: "SOO-1", title: "루트", parentId: null };
    issueFixtures["child-1"] = {
      id: "child-1",
      identifier: "SOO-2",
      title: "하위 태스크",
      status: "done",
      parentId: "root-1",
      completedAt: "2026-10-20T00:00:00.000Z",
    };
    await mount(host.ctx);
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-1", issueIdentifier: "SOO-1" });

    await emit(host.eventHandlers, "issue.updated", issueEvent("issue.updated", "child-1", { status: "done" }));

    const posts = messagePosts(host.discordFetch);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channelId).toBe("thread-1");
    expect(posts[0]!.body.embeds).toBeUndefined();
    expect(posts[0]!.body.content).toBe(
      "↳ [**SOO-2**](https://paperclip.example.com/SOO/issues/child-1) 하위 태스크 — Done",
    );
  });

  it("keeps the full card when the bound task is the event's own task", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = {
      id: "root-1",
      identifier: "SOO-1",
      title: "루트",
      status: "done",
      parentId: null,
      completedAt: "2026-10-20T00:00:00.000Z",
    };
    await mount(host.ctx);
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-1", issueIdentifier: "SOO-1" });

    await emit(host.eventHandlers, "issue.updated", issueEvent("issue.updated", "root-1", { status: "done" }));

    const posts = messagePosts(host.discordFetch);
    expect(posts[0]!.channelId).toBe("thread-1");
    expect(posts[0]!.body.embeds[0].title).toContain("SOO-1");
  });

  it("keeps the card's excerpt in a bound thread: full responses are for mapped channels only", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = {
      id: "root-1",
      identifier: "SOO-1",
      title: "루트",
      status: "done",
      parentId: null,
      completedAt: "2026-10-20T00:00:00.000Z",
    };
    await mount(host.ctx);
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-1", issueIdentifier: "SOO-1" });
    const response = `${"답변 전문입니다. ".repeat(30)}\n\n끝.`;

    await emit(
      host.eventHandlers,
      "issue.updated",
      issueEvent("issue.updated", "root-1", { status: "done", lastComment: response }),
    );

    const posts = messagePosts(host.discordFetch);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channelId).toBe("thread-1");
    const summary = posts[0]!.body.embeds[0].fields.find((f: any) => f.name === "Summary");
    expect(summary.value).toBe(response.slice(0, 200));
  });

  it("keeps a subtask's approval card whole in the thread, buttons and all", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = { id: "root-1", identifier: "SOO-1", title: "루트", parentId: null };
    issueFixtures["child-1"] = { id: "child-1", identifier: "SOO-2", title: "하위", parentId: "root-1" };
    await mount(host.ctx, storedConfig({ notifyOnApprovalCreated: true }));
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-1", issueIdentifier: "SOO-1" });

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
    expect(posts[0]!.channelId).toBe("thread-1");
    const buttonIds = posts[0]!.body.components[0].components.map((c: any) => c.custom_id);
    expect(buttonIds).toContain("approval_approve_appr-1");
    expect(buttonIds).toContain("approval_reject_appr-1");
  });

  it("routes a run event to the thread of the issue its payload names", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = { id: "root-1", identifier: "SOO-1", title: "루트", parentId: null };
    issueFixtures["child-1"] = { id: "child-1", identifier: "SOO-2", title: "하위", parentId: "root-1" };
    await mount(host.ctx);
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-1", issueIdentifier: "SOO-1" });

    eventCounter += 1;
    await emit(host.eventHandlers, "agent.run.started", {
      eventId: `evt-run-${eventCounter}`,
      eventType: "agent.run.started",
      occurredAt: new Date().toISOString(),
      companyId: COMPANY,
      entityId: "run-1",
      entityType: "heartbeat_run",
      payload: { runId: "run-1", agentId: "agent-1", issueId: "child-1" },
    });

    const posts = messagePosts(host.discordFetch);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channelId).toBe("thread-1");
    expect(posts[0]!.body.content).toContain("↳");
  });

  it("lets the binding win over a configured channel override", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = { id: "root-1", identifier: "SOO-1", title: "루트", parentId: null };
    await mount(host.ctx, storedConfig({ notifyOnAgentError: true, errorsChannelId: "ch-errors" }));
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-1", issueIdentifier: "SOO-1" });

    eventCounter += 1;
    await emit(host.eventHandlers, "agent.run.failed", {
      eventId: `evt-fail-${eventCounter}`,
      eventType: "agent.run.failed",
      occurredAt: new Date().toISOString(),
      companyId: COMPANY,
      entityId: "run-2",
      entityType: "heartbeat_run",
      payload: { runId: "run-2", issueId: "root-1" },
    });

    expect(messagePosts(host.discordFetch)[0]!.channelId).toBe("thread-1");
  });
});

describe("inbound: plain talk in a bound thread is a comment on its task", () => {
  it("routes a message that is not a reply to the thread's task", async () => {
    const host = buildHost();
    await mount(host.ctx);
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-1", issueIdentifier: "SOO-1" });

    await gateway().onMessage(threadMessage());

    expect(commentPosts()).toHaveLength(1);
    const [url, init] = commentPosts()[0]!;
    expect(String(url)).toContain("/api/issues/root-1/comments");
    expect(JSON.parse((init as any).body)).toMatchObject({
      body: "보드가 그냥 말한다",
      authorUserId: "discord:board",
    });
  });

  it("still drops a message that is not a reply in a channel with no binding", async () => {
    const host = buildHost();
    await mount(host.ctx);

    await gateway().onMessage(threadMessage({ channel_id: DEFAULT_CHANNEL }));

    expect(commentPosts()).toHaveLength(0);
  });

  it("refuses a bot author inside a bound thread", async () => {
    const host = buildHost();
    await mount(host.ctx);
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-1" });

    await gateway().onMessage(threadMessage({ author: { id: "b1", username: "webhook", bot: true } }));

    expect(commentPosts()).toHaveLength(0);
  });

  it("lets a reply to a rolled-up subtask card reach that subtask, not the bound task", async () => {
    const host = buildHost();
    await mount(host.ctx);
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-1" });
    host.stateStore.set("instance::msg_thread-1_rollup-9", {
      entityId: "child-1",
      entityType: "issue",
      companyId: COMPANY,
      eventType: "issue.updated",
    });

    await gateway().onMessage(
      threadMessage({ message_reference: { message_id: "rollup-9", channel_id: "thread-1" } }),
    );

    expect(commentPosts()).toHaveLength(1);
    expect(String(commentPosts()[0]![0])).toContain("/api/issues/child-1/comments");
  });

  it("ignores a thread bound under a company this install no longer serves", async () => {
    const host = buildHost();
    await mount(host.ctx);
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-1", companyId: OTHER_COMPANY });

    await gateway().onMessage(threadMessage());

    expect(commentPosts()).toHaveLength(0);
  });

  it("drops an empty message rather than commenting nothing", async () => {
    const host = buildHost();
    await mount(host.ctx);
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-1" });

    await gateway().onMessage(threadMessage({ content: "   " }));

    expect(commentPosts()).toHaveLength(0);
  });
});

describe("degradation: a thread that cannot be created, or no longer exists", () => {
  it("keeps the plain channel behaviour when Discord refuses to open the thread", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = { id: "root-1", identifier: "SOO-1", title: "루트", parentId: null };
    threadCreationFails = true;
    await mount(host.ctx);

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", "root-1"));

    const posts = messagePosts(host.discordFetch);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channelId).toBe(DEFAULT_CHANNEL);
    expect(posts[0]!.body.embeds[0].title).toContain("SOO-1");
    expect(host.stateStore.get(`company:${COMPANY}:${issueBindingStateKey("root-1")}`)).toBeUndefined();
  });

  it("drops the binding and re-posts the full card to the parent channel on a 404", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = { id: "root-1", identifier: "SOO-1", title: "루트", parentId: null };
    issueFixtures["child-1"] = {
      id: "child-1",
      identifier: "SOO-2",
      title: "하위 태스크",
      status: "todo",
      parentId: "root-1",
    };
    await mount(host.ctx);
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-1", issueIdentifier: "SOO-1" });
    deadChannels.add("thread-1");

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", "child-1"));

    const posts = messagePosts(host.discordFetch);
    expect(posts.map((p) => p.channelId)).toEqual(["thread-1", DEFAULT_CHANNEL]);
    // The notification survives, as the full card rather than the rolled-up line.
    expect(posts[1]!.body.embeds[0].title).toContain("SOO-2");
    expect(host.stateStore.get(`instance::${threadBindingStateKey("thread-1")}`)).toBeNull();
    expect(host.stateStore.get(`company:${COMPANY}:${issueBindingStateKey("root-1")}`)).toBeNull();
  });

  it("re-posts to the parent channel but keeps the binding when the thread post fails with 403", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = { id: "root-1", identifier: "SOO-1", title: "루트", parentId: null };
    issueFixtures["child-1"] = {
      id: "child-1",
      identifier: "SOO-2",
      title: "하위 태스크",
      status: "todo",
      parentId: "root-1",
    };
    await mount(host.ctx);
    const binding = seedBinding(host.stateStore, {
      issueId: "root-1",
      threadId: "thread-1",
      issueIdentifier: "SOO-1",
    });
    forbiddenChannels.add("thread-1");

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", "child-1"));

    const posts = messagePosts(host.discordFetch);
    expect(posts.map((p) => p.channelId)).toEqual(["thread-1", DEFAULT_CHANNEL]);
    expect(posts[1]!.body.embeds[0].title).toContain("SOO-2");
    expect(host.stateStore.get(`instance::${threadBindingStateKey("thread-1")}`)).toEqual(binding);
    expect(host.stateStore.get(`company:${COMPANY}:${issueBindingStateKey("root-1")}`)).toEqual(binding);
  });

  it("stops routing inbound talk once the dead thread's binding is gone", async () => {
    const host = buildHost();
    await mount(host.ctx);
    const binding = seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-1" });
    host.stateStore.set(`instance::${threadBindingStateKey(binding.threadId)}`, null);

    await gateway().onMessage(threadMessage());

    expect(commentPosts()).toHaveLength(0);
  });
});

describe("enableTaskThreads: false keeps every current behaviour", () => {
  it("opens no thread and routes by channel", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = { id: "root-1", identifier: "SOO-1", title: "루트", parentId: null };
    issueFixtures["child-1"] = { id: "child-1", identifier: "SOO-2", title: "하위", parentId: "root-1" };
    await mount(host.ctx, storedConfig({ enableTaskThreads: false }));
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-1" });

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", "root-1"));
    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", "child-1"));

    expect(threadCreations(host.discordFetch)).toHaveLength(0);
    expect(messagePosts(host.discordFetch).map((p) => p.channelId)).toEqual([DEFAULT_CHANNEL, DEFAULT_CHANNEL]);
  });

  it("drops a message that is not a reply even inside a bound thread", async () => {
    const host = buildHost();
    await mount(host.ctx, storedConfig({ enableTaskThreads: false }));
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-1" });

    await gateway().onMessage(threadMessage());

    expect(commentPosts()).toHaveLength(0);
  });

  it("keeps opening threads but stops auto-creating them when only autoCreate is off", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = { id: "root-1", identifier: "SOO-1", title: "루트", parentId: null };
    await mount(host.ctx, storedConfig({ autoCreateTaskThreads: false }));

    await emit(host.eventHandlers, "issue.created", issueEvent("issue.created", "root-1"));

    expect(threadCreations(host.discordFetch)).toHaveLength(0);

    // An existing binding still wins for routing, and inbound talk still lands.
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-7" });
    await gateway().onMessage(threadMessage({ channel_id: "thread-7" }));
    expect(commentPosts()).toHaveLength(1);
  });
});

describe("/task-chat and /task-unbind", () => {
  function cmdCtx(overrides: Partial<CommandContext> = {}): CommandContext {
    return {
      baseUrl: "https://paperclip.example.com",
      companyId: COMPANY,
      token: "discord-bot-token",
      defaultChannelId: DEFAULT_CHANNEL,
      taskThreads: { enabled: true, autoCreate: true, autoArchiveMinutes: 10080 },
      ...overrides,
    };
  }

  function interaction(name: string, options: Array<{ name: string; value: string }> = []) {
    return {
      type: 2,
      data: { name, options },
      member: { user: { username: "board" } },
      channel_id: DEFAULT_CHANNEL,
    } as any;
  }

  it("opens a thread for an existing task named by its identifier and binds it", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = {
      id: "root-1",
      identifier: "SOO-42",
      title: "기존 태스크",
      status: "in_progress",
      priority: "high",
    };

    const result = (await handleInteraction(
      host.ctx,
      interaction("task-chat", [{ name: "identifier", value: "soo-42" }]),
      cmdCtx(),
    )) as any;

    const posts = messagePosts(host.discordFetch);
    expect(posts[0]!.channelId).toBe(DEFAULT_CHANNEL);
    expect(posts[0]!.body.embeds[0].title).toBe("Task Chat: SOO-42");
    expect(threadCreations(host.discordFetch)).toHaveLength(1);
    expect(posts[1]!.channelId).toBe("thread-1");

    expect(host.stateStore.get(`company:${COMPANY}:${issueBindingStateKey("root-1")}`)).toMatchObject({
      issueId: "root-1",
      issueIdentifier: "SOO-42",
      threadId: "thread-1",
      parentChannelId: DEFAULT_CHANNEL,
    });
    expect(host.stateStore.get(`instance::${threadBindingStateKey("thread-1")}`)).toMatchObject({
      issueId: "root-1",
    });
    expect(result.data.content).toContain("<#thread-1>");
  });

  it("points at the existing thread instead of opening a second one", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = { id: "root-1", identifier: "SOO-42", title: "기존 태스크" };
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-9", issueIdentifier: "SOO-42" });

    const result = (await handleInteraction(
      host.ctx,
      interaction("task-chat", [{ name: "identifier", value: "SOO-42" }]),
      cmdCtx(),
    )) as any;

    expect(threadCreations(host.discordFetch)).toHaveLength(0);
    expect(messagePosts(host.discordFetch)).toHaveLength(0);
    expect(result.data.content).toContain("<#thread-9>");
  });

  it("reports an unknown identifier without posting anything", async () => {
    const host = buildHost();

    const result = (await handleInteraction(
      host.ctx,
      interaction("task-chat", [{ name: "identifier", value: "SOO-999" }]),
      cmdCtx(),
    )) as any;

    expect(messagePosts(host.discordFetch)).toHaveLength(0);
    expect(result.data.content).toContain("not found");
  });

  it("says so when Discord refuses the thread, and binds nothing", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = { id: "root-1", identifier: "SOO-42", title: "기존 태스크" };
    threadCreationFails = true;

    const result = (await handleInteraction(
      host.ctx,
      interaction("task-chat", [{ name: "identifier", value: "SOO-42" }]),
      cmdCtx(),
    )) as any;

    expect(messagePosts(host.discordFetch)).toHaveLength(1);
    expect(host.stateStore.get(`company:${COMPANY}:${issueBindingStateKey("root-1")}`)).toBeUndefined();
    expect(result.data.content).toContain("refused to open a thread");
  });

  it("refuses to open a thread when task threads are disabled", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = { id: "root-1", identifier: "SOO-42", title: "기존 태스크" };

    const result = (await handleInteraction(
      host.ctx,
      interaction("task-chat", [{ name: "identifier", value: "SOO-42" }]),
      cmdCtx({ taskThreads: { enabled: false, autoCreate: false, autoArchiveMinutes: 10080 } }),
    )) as any;

    expect(messagePosts(host.discordFetch)).toHaveLength(0);
    expect(result.data.content).toContain("disabled");
  });

  it("points at the mapped channel instead of opening a thread that would get nothing", async () => {
    const host = buildHost();
    issueFixtures["root-1"] = { id: "root-1", identifier: "SOO-42", title: "기존 태스크" };

    const result = (await handleInteraction(
      host.ctx,
      interaction("task-chat", [{ name: "identifier", value: "SOO-42" }]),
      cmdCtx({
        taskChannels: [
          { configKey: "SOO-42", channelId: "ch-mapped", issueId: "root-1", issueIdentifier: "SOO-42" },
        ],
      }),
    )) as any;

    expect(threadCreations(host.discordFetch)).toHaveLength(0);
    expect(messagePosts(host.discordFetch)).toHaveLength(0);
    expect(host.stateStore.get(`company:${COMPANY}:${issueBindingStateKey("root-1")}`)).toBeUndefined();
    expect(result.data.content).toContain("<#ch-mapped>");
  });

  it("unbinds the current thread and clears its voice target", async () => {
    const host = buildHost();
    seedBinding(host.stateStore, { issueId: "root-1", threadId: "thread-3", issueIdentifier: "SOO-42" });
    host.stateStore.set(`instance::${voiceTargetStateKey("thread-3")}`, {
      entityId: "root-1",
      entityType: "issue",
      companyId: COMPANY,
    });

    const result = (await handleInteraction(
      host.ctx,
      { ...interaction("task-unbind"), channel_id: "thread-3" },
      cmdCtx(),
    )) as any;

    expect(host.stateStore.get(`instance::${threadBindingStateKey("thread-3")}`)).toBeNull();
    expect(host.stateStore.get(`company:${COMPANY}:${issueBindingStateKey("root-1")}`)).toBeNull();
    expect(host.stateStore.get(`instance::${voiceTargetStateKey("thread-3")}`)).toBeNull();
    expect(result.data.content).toContain("SOO-42");
  });

  it("says nothing is bound when run outside a bound thread", async () => {
    const host = buildHost();

    const result = (await handleInteraction(host.ctx, interaction("task-unbind"), cmdCtx())) as any;

    expect(result.data.content).toContain("not bound");
  });
});
