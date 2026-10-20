import { describe, it, expect, vi } from "vitest";
import {
  buildThreadName,
  createThreadFromMessage,
  deleteBinding,
  getBindingByIssue,
  getBindingByThread,
  issueBindingStateKey,
  MAX_ANCESTOR_DEPTH,
  MAX_THREAD_NAME_LENGTH,
  resolveThreadForIssue,
  saveBinding,
  threadBindingStateKey,
  truncateThreadName,
  type TaskThreadBinding,
} from "../src/task-threads.js";

const COMPANY_ID = "co-1";

type StoredIssue = { id: string; parentId: string | null };

interface CtxOptions {
  issues?: StoredIssue[];
  issuesGetThrows?: boolean;
  fetch?: ReturnType<typeof vi.fn>;
}

// Keys are scoped the same way the module scopes them: company scope carries a
// scopeId, instance scope does not.
function scopeKeyOf(input: { scopeKind: string; scopeId?: string; stateKey: string }): string {
  return `${input.scopeKind}:${input.scopeId ?? "-"}:${input.stateKey}`;
}

function makeCtx(opts: CtxOptions = {}) {
  const store = new Map<string, unknown>();
  const issuesById = new Map((opts.issues ?? []).map((issue) => [issue.id, issue] as const));

  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    state: {
      get: vi.fn().mockImplementation((input: any) => Promise.resolve(store.get(scopeKeyOf(input)) ?? null)),
      set: vi.fn().mockImplementation((input: any, value: unknown) => {
        store.set(scopeKeyOf(input), value);
        return Promise.resolve(undefined);
      }),
      delete: vi.fn().mockImplementation((input: any) => {
        store.delete(scopeKeyOf(input));
        return Promise.resolve(undefined);
      }),
    },
    issues: {
      get: vi.fn().mockImplementation((issueId: string) => {
        if (opts.issuesGetThrows) return Promise.reject(new Error("issues.get exploded"));
        return Promise.resolve(issuesById.get(issueId) ?? null);
      }),
    },
    http: {
      fetch:
        opts.fetch ??
        vi.fn().mockResolvedValue({
          ok: true,
          status: 201,
          headers: new Headers(),
          json: () => Promise.resolve({ id: "thread-new" }),
          text: () => Promise.resolve(""),
        }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { ctx, store };
}

function makeBinding(overrides: Partial<TaskThreadBinding> = {}): TaskThreadBinding {
  return {
    issueId: "iss-1",
    issueIdentifier: "SOO-99",
    threadId: "thread-1",
    parentChannelId: "ch-1",
    companyId: COMPANY_ID,
    createdAt: "2026-10-20T09:00:00.000Z",
    ...overrides,
  };
}

// Builds a linear parent chain: chain[0] is the leaf, each entry's parent is the next.
function linearChain(ids: string[]): StoredIssue[] {
  return ids.map((id, index) => ({ id, parentId: ids[index + 1] ?? null }));
}

describe("binding storage", () => {
  it("round-trips the same record through both the issue key and the thread key", async () => {
    const { ctx, store } = makeCtx();
    const binding = makeBinding();

    await saveBinding(ctx, binding);

    expect(await getBindingByIssue(ctx, COMPANY_ID, "iss-1")).toEqual(binding);
    expect(await getBindingByThread(ctx, "thread-1")).toEqual(binding);
    expect(store.has(`company:${COMPANY_ID}:${issueBindingStateKey("iss-1")}`)).toBe(true);
    expect(store.has(`instance:-:${threadBindingStateKey("thread-1")}`)).toBe(true);
  });

  it("keeps the thread key in instance scope and the issue key in company scope", async () => {
    const { ctx } = makeCtx();

    await saveBinding(ctx, makeBinding());

    const scopes = ctx.state.set.mock.calls.map((call: any[]) => call[0]);
    expect(scopes).toEqual([
      { scopeKind: "company", scopeId: COMPANY_ID, stateKey: "task_thread_issue_iss-1" },
      { scopeKind: "instance", stateKey: "task_thread_tid_thread-1" },
    ]);
  });

  it("returns null for an unbound issue or thread", async () => {
    const { ctx } = makeCtx();

    expect(await getBindingByIssue(ctx, COMPANY_ID, "iss-nope")).toBeNull();
    expect(await getBindingByThread(ctx, "thread-nope")).toBeNull();
  });

  it("does not leak one company's binding into another", async () => {
    const { ctx } = makeCtx();

    await saveBinding(ctx, makeBinding());

    expect(await getBindingByIssue(ctx, "co-other", "iss-1")).toBeNull();
  });

  it("clears both keys on delete", async () => {
    const { ctx } = makeCtx();
    const binding = makeBinding();
    await saveBinding(ctx, binding);

    await deleteBinding(ctx, binding);

    expect(await getBindingByIssue(ctx, COMPANY_ID, "iss-1")).toBeNull();
    expect(await getBindingByThread(ctx, "thread-1")).toBeNull();
  });

  it("falls back to a null write on hosts without state.delete", async () => {
    const { ctx } = makeCtx();
    const binding = makeBinding();
    await saveBinding(ctx, binding);
    ctx.state.delete = undefined;

    await deleteBinding(ctx, binding);

    expect(await getBindingByIssue(ctx, COMPANY_ID, "iss-1")).toBeNull();
    expect(await getBindingByThread(ctx, "thread-1")).toBeNull();
  });
});

describe("resolveThreadForIssue", () => {
  it("returns depth 0 when the issue is bound to its own thread", async () => {
    const { ctx } = makeCtx({ issues: linearChain(["iss-child", "iss-parent"]) });
    await saveBinding(ctx, makeBinding({ issueId: "iss-child", threadId: "thread-child" }));

    const resolved = await resolveThreadForIssue(ctx, COMPANY_ID, "iss-child");

    expect(resolved).not.toBeNull();
    expect(resolved!.depth).toBe(0);
    expect(resolved!.binding.threadId).toBe("thread-child");
    expect(ctx.issues.get).not.toHaveBeenCalled();
  });

  it("rolls a subtask up to the parent thread at depth 1", async () => {
    const { ctx } = makeCtx({ issues: linearChain(["iss-child", "iss-parent"]) });
    await saveBinding(ctx, makeBinding({ issueId: "iss-parent", threadId: "thread-parent" }));

    const resolved = await resolveThreadForIssue(ctx, COMPANY_ID, "iss-child");

    expect(resolved).not.toBeNull();
    expect(resolved!.depth).toBe(1);
    expect(resolved!.binding.threadId).toBe("thread-parent");
  });

  it("resolves a binding sitting exactly at the depth limit", async () => {
    const ids = ["a0", "a1", "a2", "a3", "a4", "a5"];
    const { ctx } = makeCtx({ issues: linearChain(ids) });
    await saveBinding(ctx, makeBinding({ issueId: "a5", threadId: "thread-a5" }));

    const resolved = await resolveThreadForIssue(ctx, COMPANY_ID, "a0");

    expect(resolved!.depth).toBe(MAX_ANCESTOR_DEPTH);
    expect(resolved!.binding.threadId).toBe("thread-a5");
  });

  it("returns null when the nearest binding is deeper than the depth limit", async () => {
    const ids = ["a0", "a1", "a2", "a3", "a4", "a5", "a6"];
    const { ctx } = makeCtx({ issues: linearChain(ids) });
    await saveBinding(ctx, makeBinding({ issueId: "a6", threadId: "thread-a6" }));

    expect(await resolveThreadForIssue(ctx, COMPANY_ID, "a0")).toBeNull();
  });

  it("does not loop forever on a parentId cycle", async () => {
    const { ctx } = makeCtx({
      issues: [
        { id: "iss-a", parentId: "iss-b" },
        { id: "iss-b", parentId: "iss-a" },
      ],
    });

    expect(await resolveThreadForIssue(ctx, COMPANY_ID, "iss-a")).toBeNull();
    expect(ctx.issues.get.mock.calls.length).toBeLessThanOrEqual(MAX_ANCESTOR_DEPTH + 1);
  });

  it("returns null instead of throwing when ctx.issues.get fails", async () => {
    const { ctx } = makeCtx({ issues: linearChain(["iss-child", "iss-parent"]), issuesGetThrows: true });
    await saveBinding(ctx, makeBinding({ issueId: "iss-parent", threadId: "thread-parent" }));

    await expect(resolveThreadForIssue(ctx, COMPANY_ID, "iss-child")).resolves.toBeNull();
    expect(ctx.logger.debug).toHaveBeenCalled();
  });

  it("returns null when the chain ends without any binding", async () => {
    const { ctx } = makeCtx({ issues: linearChain(["iss-child", "iss-parent"]) });

    expect(await resolveThreadForIssue(ctx, COMPANY_ID, "iss-child")).toBeNull();
  });
});

describe("thread names", () => {
  it("joins identifier and title", () => {
    expect(buildThreadName("SOO-99", "Bind tasks to Discord threads")).toBe(
      "SOO-99 Bind tasks to Discord threads",
    );
  });

  it("omits a missing identifier", () => {
    expect(buildThreadName(null, "Bind tasks to threads")).toBe("Bind tasks to threads");
  });

  it("never exceeds the Discord 100-character limit", () => {
    const name = buildThreadName("SOO-99", "x".repeat(400));
    expect(name.length).toBeLessThanOrEqual(MAX_THREAD_NAME_LENGTH);
    expect(name.startsWith("SOO-99 ")).toBe(true);
  });

  it("does not split a surrogate pair when truncating", () => {
    const name = truncateThreadName("🧵".repeat(80));
    expect(name.length).toBeLessThanOrEqual(MAX_THREAD_NAME_LENGTH);
    expect(/\p{Surrogate}/u.test(name)).toBe(false);
    expect(Array.from(name).every((ch) => ch === "🧵" || ch === "…")).toBe(true);
  });

  it("falls back to a placeholder rather than an empty name", () => {
    expect(truncateThreadName("   ")).toBe("Paperclip task");
    expect(buildThreadName(null, null)).toBe("Paperclip task");
  });
});

describe("createThreadFromMessage", () => {
  it("posts to the message threads endpoint and returns the new thread id", async () => {
    const { ctx } = makeCtx();

    const threadId = await createThreadFromMessage(ctx, "bot-token", "ch-1", "msg-1", {
      name: "SOO-99 Bind tasks",
      autoArchiveMinutes: 4320,
    });

    expect(threadId).toBe("thread-new");
    const [url, init] = ctx.http.fetch.mock.calls[0];
    expect(url).toBe("https://discord.com/api/v10/channels/ch-1/messages/msg-1/threads");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      name: "SOO-99 Bind tasks",
      auto_archive_duration: 4320,
    });
  });

  it("defaults auto_archive_duration to 1440 minutes", async () => {
    const { ctx } = makeCtx();

    await createThreadFromMessage(ctx, "bot-token", "ch-1", "msg-1", { name: "SOO-99" });

    expect(JSON.parse(ctx.http.fetch.mock.calls[0][1].body).auto_archive_duration).toBe(1440);
  });

  it("truncates an over-long name before sending it", async () => {
    const { ctx } = makeCtx();

    await createThreadFromMessage(ctx, "bot-token", "ch-1", "msg-1", { name: "y".repeat(300) });

    const sentName = JSON.parse(ctx.http.fetch.mock.calls[0][1].body).name as string;
    expect(sentName.length).toBeLessThanOrEqual(MAX_THREAD_NAME_LENGTH);
  });

  it("returns null without retrying when Discord answers 403", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('{"message":"Missing Permissions","code":50013}'),
    });
    const { ctx } = makeCtx({ fetch });

    const threadId = await createThreadFromMessage(ctx, "bot-token", "ch-1", "msg-1", {
      name: "SOO-99",
    });

    expect(threadId).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it("returns null when the transport throws", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const { ctx } = makeCtx({ fetch });

    await expect(
      createThreadFromMessage(ctx, "bot-token", "ch-1", "msg-1", { name: "SOO-99" }),
    ).resolves.toBeNull();
  });
});
