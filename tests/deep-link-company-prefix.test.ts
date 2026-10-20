import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression tests for the deep links in Discord cards.
 *
 * The web app routes entities under the company prefix
 * (`/:companyPrefix/issues/:id`), so a link built from the API base URL alone
 * made it read `issues` / `approvals` as a company prefix and fail with
 * "Organization not found — No organization matches prefix \"APPROVALS\"".
 *
 * The fix splits the two base URLs apart, so the end-to-end case below matters
 * as much as the unit cases: the API base URL must stay un-prefixed (it carries
 * `${baseUrl}/api/...`), and ONLY the link buttons may take the prefix.
 */

const { capturedDefinitions } = vi.hoisted(() => {
  const capturedDefinitions: any[] = [];
  return { capturedDefinitions };
});

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedDefinitions.push(def);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

import {
  buildLinkBaseUrl,
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
} from "../src/formatters.js";
import { resolveCompanyIssuePrefix, _resetCompanyPrefixCache } from "../src/company-prefix.js";
import { _resetRuntimeForTests } from "../src/worker.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

const COMPANY_ID = "44806279-f8ba-4f28-a9c3-54ceeea43416";
const API_BASE = "https://paperclip.example.com";
const LINK_BASE = `${API_BASE}/SOO`;

function makeEvent(overrides: Partial<PluginEvent> = {}): PluginEvent {
  return {
    eventType: "issue.created",
    companyId: COMPANY_ID,
    entityId: "issue-1",
    occurredAt: "2026-10-20T12:00:00Z",
    payload: {},
    ...overrides,
  } as PluginEvent;
}

function urlOf(
  msg: { components?: Array<{ components?: Array<Record<string, unknown>> }> },
  label: string,
): string | undefined {
  for (const row of msg.components ?? []) {
    for (const component of row.components ?? []) {
      if (component.label === label) return component.url as string | undefined;
    }
  }
  return undefined;
}

describe("buildLinkBaseUrl", () => {
  it("appends the company prefix", () => {
    expect(buildLinkBaseUrl(API_BASE, "SOO")).toBe(LINK_BASE);
  });

  it("normalizes a trailing slash on the base URL", () => {
    expect(buildLinkBaseUrl(`${API_BASE}///`, "SOO")).toBe(LINK_BASE);
  });

  it("tolerates a prefix supplied with slashes", () => {
    expect(buildLinkBaseUrl(API_BASE, "/SOO/")).toBe(LINK_BASE);
  });

  it("returns the bare base URL when the prefix is unresolved", () => {
    expect(buildLinkBaseUrl(API_BASE, null)).toBe(API_BASE);
    expect(buildLinkBaseUrl(API_BASE, undefined)).toBe(API_BASE);
    expect(buildLinkBaseUrl(API_BASE, "   ")).toBe(API_BASE);
  });

  it("never appends to the API path — the prefix is the FIRST segment only", () => {
    expect(buildLinkBaseUrl(API_BASE, "SOO")).not.toContain("/api");
  });
});

describe("deep links carry the company prefix", () => {
  it("issue.created View Issue", () => {
    const msg = formatIssueCreated(makeEvent({ entityId: "iss-42" }), LINK_BASE);
    expect(urlOf(msg, "View Issue")).toBe(`${API_BASE}/SOO/issues/iss-42`);
  });

  it("issue.created View Parent", () => {
    const msg = formatIssueCreated(
      makeEvent({ payload: { parentId: "par-7", parentIdentifier: "SOO-7" } }),
      LINK_BASE,
    );
    expect(urlOf(msg, "View Parent")).toBe(`${API_BASE}/SOO/issues/par-7`);
  });

  it("issue done View Issue", () => {
    const msg = formatIssueDone(makeEvent({ entityId: "iss-9" }), LINK_BASE);
    expect(urlOf(msg, "View Issue")).toBe(`${API_BASE}/SOO/issues/iss-9`);
  });

  it("approval.created View", () => {
    const msg = formatApprovalCreated(
      makeEvent({ payload: { approvalId: "apr-3" } }),
      LINK_BASE,
    );
    expect(urlOf(msg, "View")).toBe(`${API_BASE}/SOO/approvals/apr-3`);
  });

  it("leaves an external PR link alone", () => {
    const msg = formatIssueDone(
      makeEvent({ payload: { prUrl: "https://github.com/o/r/pull/1" } }),
      LINK_BASE,
    );
    expect(urlOf(msg, "View Diff")).toBe("https://github.com/o/r/pull/1");
  });
});

describe("deep links fall back when the prefix cannot be resolved", () => {
  const fallbackBase = buildLinkBaseUrl(API_BASE, null);

  it("keeps the prefix-less URLs rather than emitting a broken one", () => {
    const created = formatIssueCreated(makeEvent({ entityId: "iss-1" }), fallbackBase);
    expect(urlOf(created, "View Issue")).toBe(`${API_BASE}/issues/iss-1`);

    const approval = formatApprovalCreated(
      makeEvent({ payload: { approvalId: "apr-1" } }),
      fallbackBase,
    );
    expect(urlOf(approval, "View")).toBe(`${API_BASE}/approvals/apr-1`);
  });

  it("still drops link buttons entirely for a localhost base URL", () => {
    const msg = formatIssueCreated(makeEvent(), buildLinkBaseUrl("http://localhost:3100", "SOO"));
    expect(urlOf(msg, "View Issue")).toBeUndefined();
  });
});

describe("resolveCompanyIssuePrefix", () => {
  const originalFetch = global.fetch;

  function makeCtx(companiesGet: unknown) {
    return {
      companies: { get: companiesGet },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  beforeEach(() => {
    _resetCompanyPrefixCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("reads the prefix from the host client without any HTTP call", async () => {
    global.fetch = vi.fn();
    const ctx = makeCtx(vi.fn().mockResolvedValue({ id: COMPANY_ID, issuePrefix: "SOO" }));
    await expect(resolveCompanyIssuePrefix(ctx, COMPANY_ID, API_BASE)).resolves.toBe("SOO");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("caches a successful lookup", async () => {
    const get = vi.fn().mockResolvedValue({ id: COMPANY_ID, issuePrefix: "SOO" });
    const ctx = makeCtx(get);
    await resolveCompanyIssuePrefix(ctx, COMPANY_ID, API_BASE);
    await resolveCompanyIssuePrefix(ctx, COMPANY_ID, API_BASE);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("falls back to the API when the host denies the invocation scope", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: COMPANY_ID, issuePrefix: "SOO" }), { status: 200 }),
    );
    const ctx = makeCtx(vi.fn().mockRejectedValue(new Error("company context is required")));

    await expect(
      resolveCompanyIssuePrefix(ctx, COMPANY_ID, API_BASE, "board-key"),
    ).resolves.toBe("SOO");

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/companies/${COMPANY_ID}`);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer board-key");
  });

  it("returns null when both lookups fail, so the caller can fall back", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const ctx = makeCtx(vi.fn().mockRejectedValue(new Error("denied")));

    await expect(resolveCompanyIssuePrefix(ctx, COMPANY_ID, API_BASE)).resolves.toBeNull();
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it("does not cache a failure", async () => {
    const ctx = makeCtx(vi.fn().mockRejectedValue(new Error("denied")));
    global.fetch = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(resolveCompanyIssuePrefix(ctx, COMPANY_ID, API_BASE)).resolves.toBeNull();

    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ issuePrefix: "SOO" }), { status: 200 }),
    );
    await expect(resolveCompanyIssuePrefix(ctx, COMPANY_ID, API_BASE)).resolves.toBe("SOO");
  });

  it("returns null for an unresolved company id instead of calling out", async () => {
    global.fetch = vi.fn();
    const get = vi.fn();
    const ctx = makeCtx(get);
    await expect(resolveCompanyIssuePrefix(ctx, "default", API_BASE)).resolves.toBeNull();
    await expect(resolveCompanyIssuePrefix(ctx, "", API_BASE)).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("treats a blank issuePrefix as unresolved", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ issuePrefix: "  " }), { status: 200 }),
    );
    const ctx = makeCtx(vi.fn().mockResolvedValue({ id: COMPANY_ID, issuePrefix: "" }));
    await expect(resolveCompanyIssuePrefix(ctx, COMPANY_ID, API_BASE)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the wiring between bootstrap and the posted card.
//
// A unit test on the formatters cannot catch the actual bug — the formatters
// were always correct, the worker handed them the API base URL. These tests
// drive the real `onConfigChanged` -> `notify` path and read the URL off the
// JSON the plugin posts to Discord.
// ---------------------------------------------------------------------------

const UNSCOPED_CONFIG_ERROR =
  'not allowed to perform "config.get": company context is required';

/** What the host throws for `companies.get` outside that company's scope. */
const SCOPE_DENIED = 'not allowed to perform "companies.get": company context is required';

function workerConfig(overrides: Record<string, unknown> = {}) {
  return {
    discordBotTokenRef: { type: "secret_ref", secretId: "33333333-3333-3333-3333-333333333333" },
    defaultGuildId: "",
    defaultChannelId: "ch-1",
    approvalsChannelId: "ch-1",
    notifyOnIssueCreated: true,
    notifyOnIssueDone: true,
    notifyOnApprovalCreated: true,
    notifyOnAgentError: false,
    enableIntelligence: false,
    intelligenceChannelIds: [],
    backfillDays: 0,
    paperclipBaseUrl: API_BASE,
    enableEscalations: false,
    enableMediaPipeline: false,
    enableCustomCommands: false,
    enableProactiveSuggestions: false,
    enableCommands: false,
    enableInbound: false,
    topicRouting: false,
    digestMode: "off",
    ...overrides,
  };
}

function buildWorkerHost(options: {
  issuePrefix?: string | null;
  denyCompaniesGet?: boolean;
  /** Stands in for the host's `ctx.issues.get`; `null` means "no such issue". */
  issuesById?: Record<string, Record<string, unknown> | Error>;
} = {}) {
  const { issuePrefix = "SOO", denyCompaniesGet = false, issuesById } = options;
  const eventHandlers = new Map<string, Array<(event: any) => Promise<void>>>();
  const stateStore = new Map<string, unknown>();
  const config = workerConfig();
  let messageCounter = 0;

  const discordFetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ id: `msg-${++messageCounter}` }),
    text: async () => "",
  }));

  const ctx = {
    config: {
      get: vi.fn(async (companyId?: string) => {
        if (!companyId) throw new Error(UNSCOPED_CONFIG_ERROR);
        return config;
      }),
    },
    __testConfig: config,
    secrets: { resolve: vi.fn(async () => "fake-bot-token") },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn(async (key: any) => stateStore.get(`${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`) ?? null),
      set: vi.fn(async (key: any, value: unknown) => {
        stateStore.set(`${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`, value);
      }),
    },
    metrics: { write: vi.fn() },
    activity: { log: vi.fn() },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: {
      subscribe: vi.fn(),
      emit: vi.fn(),
      on: vi.fn((name: string, fn: any) => {
        const handlers = eventHandlers.get(name) ?? [];
        handlers.push(fn);
        eventHandlers.set(name, handlers);
        return () => {};
      }),
    },
    companies: {
      list: vi.fn(async () => [{ id: COMPANY_ID, name: "sookigom-co" }]),
      get: vi.fn(async (companyId: string) => {
        if (denyCompaniesGet) throw new Error(SCOPE_DENIED);
        return { id: companyId, name: "sookigom-co", issuePrefix };
      }),
    },
    agents: { list: vi.fn(async () => []), invoke: vi.fn() },
    issues: {
      list: vi.fn(async () => []),
      get: vi.fn(async (issueId: string) => {
        const record = issuesById?.[issueId];
        if (record instanceof Error) throw record;
        return record ?? null;
      }),
      listComments: vi.fn(async () => []),
    },
    http: { fetch: discordFetch },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { ctx, eventHandlers, discordFetch };
}

async function mountWorker(ctx: any) {
  if (capturedDefinitions.length === 0) {
    throw new Error("setup() was not captured — the definePlugin mock may not be active");
  }
  const definition = capturedDefinitions[capturedDefinitions.length - 1];
  _resetRuntimeForTests();
  _resetCompanyPrefixCache();
  await definition.setup(ctx);
  await definition.onConfigChanged?.(ctx.__testConfig, { companyId: COMPANY_ID });
  return definition;
}

async function emit(
  eventHandlers: Map<string, Array<(event: any) => Promise<void>>>,
  eventType: string,
  event: any,
) {
  for (const handler of eventHandlers.get(eventType) ?? []) {
    await handler(event);
  }
}

/**
 * The last embed card posted to Discord. Plain-text lines the plugin also sends
 * — the line a bound task thread opens with — are not cards and are skipped.
 */
function postedMessage(discordFetch: ReturnType<typeof vi.fn>): any {
  const posts = discordFetch.mock.calls
    .filter(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("/channels/") && typeof call[1]?.body === "string",
    )
    .map((call: any[]) => JSON.parse(call[1].body))
    .filter((body: any) => Array.isArray(body.embeds));
  const last = posts[posts.length - 1];
  if (!last) throw new Error("Expected a Discord channel POST carrying an embed");
  return last;
}

/** The link-button URLs of the last embed the plugin posted to Discord. */
function postedButtonUrls(discordFetch: ReturnType<typeof vi.fn>): string[] {
  return (postedMessage(discordFetch).components ?? []).flatMap((row: any) =>
    (row.components ?? []).map((c: any) => c.url).filter(Boolean),
  );
}

function postedButtonLabels(discordFetch: ReturnType<typeof vi.fn>): string[] {
  return (postedMessage(discordFetch).components ?? []).flatMap((row: any) =>
    (row.components ?? []).map((c: any) => c.label).filter(Boolean),
  );
}

// ---------------------------------------------------------------------------
// `View Parent` never rendered for any issue, at any nesting depth: the host
// forwards `issue.created` straight from its activity log, whose details object
// has no parent link at all. The button is gated on `payload.parentId`, so it
// was always skipped — these cases pin the lookup that recovers it.
// ---------------------------------------------------------------------------

const HOST_CREATE_PAYLOAD = {
  // Verbatim shape of what the host actually sends (see services/activity-log.ts):
  // no parentId, plus scheduling bookkeeping.
  title: "Child task",
  identifier: "SOO-87",
  status: "backlog",
  statusDefaulted: false,
  statusDefaultReason: "explicit",
  assignmentWakeSkipped: true,
  assignmentWakeSkipReason: "no_agent_assignee",
};

describe("issue.created recovers the parent link the host omits", () => {
  beforeEach(() => {
    _resetCompanyPrefixCache();
  });

  async function emitCreated(
    issuesById: Record<string, Record<string, unknown> | Error>,
    payload: Record<string, unknown> = HOST_CREATE_PAYLOAD,
  ) {
    const { ctx, eventHandlers, discordFetch } = buildWorkerHost({ issuesById });
    await mountWorker(ctx);
    await emit(eventHandlers, "issue.created", {
      eventId: "evt-parent",
      eventType: "issue.created",
      occurredAt: new Date().toISOString(),
      companyId: COMPANY_ID,
      entityId: "child-1",
      entityType: "issue",
      payload,
    });
    return discordFetch;
  }

  it("renders View Parent, prefixed, from the looked-up parentId", async () => {
    const discordFetch = await emitCreated({
      "child-1": { id: "child-1", identifier: "SOO-87", parentId: "parent-1" },
      "parent-1": { id: "parent-1", identifier: "SOO-84", title: "Deep link fix" },
    });

    expect(postedButtonLabels(discordFetch)).toContain("View Parent");
    expect(postedButtonUrls(discordFetch)).toContain(`${API_BASE}/SOO/issues/parent-1`);
  });

  it("names the parent in the embed's Parent field", async () => {
    const discordFetch = await emitCreated({
      "child-1": { id: "child-1", identifier: "SOO-87", parentId: "parent-1" },
      "parent-1": { id: "parent-1", identifier: "SOO-84", title: "Deep link fix" },
    });

    const parentField = postedMessage(discordFetch).embeds[0].fields.find(
      (f: any) => f.name === "Parent",
    );
    expect(parentField?.value).toBe("**SOO-84** — Deep link fix");
  });

  it("keeps the button when the parent itself cannot be read", async () => {
    const discordFetch = await emitCreated({
      "child-1": { id: "child-1", identifier: "SOO-87", parentId: "parent-1" },
      "parent-1": new Error("not allowed to perform \"issues.get\""),
    });

    // An unnamed parent still routes correctly, and the failed lookup must not
    // cost the card its other enrichment.
    expect(postedButtonUrls(discordFetch)).toContain(`${API_BASE}/SOO/issues/parent-1`);
    expect(postedButtonUrls(discordFetch)).toContain(`${API_BASE}/SOO/issues/child-1`);
  });

  it("omits View Parent for a top-level issue", async () => {
    const discordFetch = await emitCreated({
      "child-1": { id: "child-1", identifier: "SOO-87", parentId: null },
    });

    expect(postedButtonLabels(discordFetch)).not.toContain("View Parent");
  });

  it("prefers a parent the event already carried over a lookup", async () => {
    const discordFetch = await emitCreated(
      { "child-1": { id: "child-1", parentId: "stale-parent" } },
      { ...HOST_CREATE_PAYLOAD, parentId: "parent-from-event" },
    );

    expect(postedButtonUrls(discordFetch)).toContain(`${API_BASE}/SOO/issues/parent-from-event`);
  });
});

describe("worker wiring: notifications carry prefixed deep links", () => {
  beforeEach(() => {
    _resetCompanyPrefixCache();
  });

  it("issue.created links into the company dashboard", async () => {
    const { ctx, eventHandlers, discordFetch } = buildWorkerHost();
    await mountWorker(ctx);

    await emit(eventHandlers, "issue.created", {
      eventId: "evt-1",
      eventType: "issue.created",
      occurredAt: new Date().toISOString(),
      companyId: COMPANY_ID,
      entityId: "iss-1",
      entityType: "issue",
      payload: { identifier: "SOO-1", title: "Deep link" },
    });

    expect(postedButtonUrls(discordFetch)).toContain(`${API_BASE}/SOO/issues/iss-1`);
  });

  it("approval.created links into the company dashboard", async () => {
    const { ctx, eventHandlers, discordFetch } = buildWorkerHost();
    await mountWorker(ctx);

    await emit(eventHandlers, "approval.created", {
      eventId: "evt-2",
      eventType: "approval.created",
      occurredAt: new Date().toISOString(),
      companyId: COMPANY_ID,
      entityId: "apr-1",
      entityType: "approval",
      payload: { type: "request_board_approval", approvalId: "apr-1", title: "Ship it" },
    });

    expect(postedButtonUrls(discordFetch)).toContain(`${API_BASE}/SOO/approvals/apr-1`);
  });

  it("leaves the API base URL un-prefixed, so API calls still resolve", async () => {
    const { ctx } = buildWorkerHost();
    await mountWorker(ctx);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { _getRuntimeForTests } = await import("../src/worker.js") as any;
    const rt = _getRuntimeForTests();
    expect(rt.baseUrl).toBe(API_BASE);
    expect(rt.cmdCtx.baseUrl).toBe(API_BASE);
    expect(rt.linkBaseUrl).toBe(`${API_BASE}/SOO`);
  });

  it("still notifies, with prefix-less links, when the prefix cannot be resolved", async () => {
    const originalFetch = global.fetch;
    // Both lookups fail: the host denies the scoped read and the API answers 401.
    global.fetch = vi.fn(async () => new Response("Unauthorized", { status: 401 })) as any;
    try {
      const { ctx, eventHandlers, discordFetch } = buildWorkerHost({ denyCompaniesGet: true });
      await mountWorker(ctx);

      await emit(eventHandlers, "issue.created", {
        eventId: "evt-3",
        eventType: "issue.created",
        occurredAt: new Date().toISOString(),
        companyId: COMPANY_ID,
        entityId: "iss-3",
        entityType: "issue",
        payload: { identifier: "SOO-3", title: "Fallback" },
      });

      expect(postedButtonUrls(discordFetch)).toContain(`${API_BASE}/issues/iss-3`);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("recovers the prefix from the API when the host denies the scoped read", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: COMPANY_ID, issuePrefix: "SOO" }), { status: 200 }),
    ) as any;
    try {
      const { ctx, eventHandlers, discordFetch } = buildWorkerHost({ denyCompaniesGet: true });
      await mountWorker(ctx);

      await emit(eventHandlers, "issue.created", {
        eventId: "evt-4",
        eventType: "issue.created",
        occurredAt: new Date().toISOString(),
        companyId: COMPANY_ID,
        entityId: "iss-4",
        entityType: "issue",
        payload: { identifier: "SOO-4", title: "Recovered" },
      });

      expect(postedButtonUrls(discordFetch)).toContain(`${API_BASE}/SOO/issues/iss-4`);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
