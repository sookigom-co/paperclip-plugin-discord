import type { PluginContext } from "@paperclipai/plugin-sdk";
import { discordFetch, normalizeDiscordPathId } from "./discord-api.js";
import { withRetry } from "./retry.js";

export interface TaskThreadBinding {
  issueId: string;
  issueIdentifier: string | null;
  threadId: string;
  parentChannelId: string;
  companyId: string;
  createdAt: string;
}

export type ThreadAutoArchiveMinutes = 60 | 1440 | 4320 | 10080;

export const DEFAULT_AUTO_ARCHIVE_MINUTES: ThreadAutoArchiveMinutes = 1440;
export const MAX_THREAD_NAME_LENGTH = 100;
export const MAX_ANCESTOR_DEPTH = 5;

const THREAD_NAME_ELLIPSIS = "…";
const FALLBACK_THREAD_NAME = "Paperclip task";

export function issueBindingStateKey(issueId: string): string {
  return `task_thread_issue_${issueId}`;
}

export function threadBindingStateKey(threadId: string): string {
  return `task_thread_tid_${threadId}`;
}

/** State key holding what a channel is currently about, for voice routing. */
export function voiceTargetStateKey(channelId: string): string {
  return `voice_target_${channelId}`;
}

// Instance scope: inbound Discord events carry no company, so the record names its own.
function threadScope(threadId: string) {
  return { scopeKind: "instance" as const, stateKey: threadBindingStateKey(threadId) };
}

function issueScope(companyId: string, issueId: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId || "default",
    stateKey: issueBindingStateKey(issueId),
  };
}

export async function saveBinding(
  ctx: PluginContext,
  binding: TaskThreadBinding,
): Promise<void> {
  await ctx.state.set(issueScope(binding.companyId, binding.issueId), binding);
  await ctx.state.set(threadScope(binding.threadId), binding);
}

export async function getBindingByIssue(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
): Promise<TaskThreadBinding | null> {
  if (!issueId) return null;
  const raw = await ctx.state.get(issueScope(companyId, issueId));
  return asBinding(raw);
}

export async function getBindingByThread(
  ctx: PluginContext,
  threadId: string,
): Promise<TaskThreadBinding | null> {
  if (!threadId) return null;
  const raw = await ctx.state.get(threadScope(threadId));
  return asBinding(raw);
}

export async function deleteBinding(
  ctx: PluginContext,
  binding: TaskThreadBinding,
): Promise<void> {
  await clearState(ctx, issueScope(binding.companyId, binding.issueId));
  await clearState(ctx, threadScope(binding.threadId));
}

// Clears a state row, falling back to a null write on hosts without `state.delete`.
async function clearState(ctx: PluginContext, scope: Parameters<PluginContext["state"]["set"]>[0]): Promise<void> {
  if (typeof ctx.state.delete === "function") {
    await ctx.state.delete(scope);
    return;
  }
  await ctx.state.set(scope, null);
}

function asBinding(raw: unknown): TaskThreadBinding | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<TaskThreadBinding>;
  if (typeof candidate.issueId !== "string" || !candidate.issueId) return null;
  if (typeof candidate.threadId !== "string" || !candidate.threadId) return null;
  return {
    issueId: candidate.issueId,
    issueIdentifier: typeof candidate.issueIdentifier === "string" ? candidate.issueIdentifier : null,
    threadId: candidate.threadId,
    parentChannelId: typeof candidate.parentChannelId === "string" ? candidate.parentChannelId : "",
    companyId: typeof candidate.companyId === "string" ? candidate.companyId : "",
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : "",
  };
}

async function getParentIssueId(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
): Promise<string | null> {
  try {
    const issue = (await ctx.issues.get(issueId, companyId)) as { parentId?: string | null } | null;
    const parentId = issue?.parentId;
    return typeof parentId === "string" && parentId ? parentId : null;
  } catch (error) {
    ctx.logger.debug("Issue lookup failed while walking the ancestor chain", {
      issueId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Where one task's news goes: a channel the operator mapped, or a bound thread. */
export interface IssueDestination {
  destinationId: string;
  kind: "thread" | "channel";
  /** How many parent hops away the task owning this destination is. */
  depth: number;
  issueId: string;
  /** The binding behind a `thread` destination; null for a mapped channel. */
  binding: TaskThreadBinding | null;
}

/** The two places a destination can come from, either of which may be absent. */
export interface IssueDestinationSources {
  channel?: (issueId: string) => string | null;
  thread?: (issueId: string) => Promise<TaskThreadBinding | null>;
}

// Walks up the parent chain and returns the nearest destination with its depth.
export async function resolveDestinationForIssue(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  sources: IssueDestinationSources,
): Promise<IssueDestination | null> {
  if (!sources.channel && !sources.thread) return null;
  const visited = new Set<string>();
  let currentId: string | null = issueId;

  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth++) {
    if (!currentId || visited.has(currentId)) return null;
    visited.add(currentId);

    // At the same task a configured channel outranks an auto-opened thread.
    const channelId = sources.channel?.(currentId) ?? null;
    if (channelId) {
      return { destinationId: channelId, kind: "channel", depth, issueId: currentId, binding: null };
    }

    const binding = sources.thread ? await sources.thread(currentId) : null;
    if (binding) {
      return { destinationId: binding.threadId, kind: "thread", depth, issueId: currentId, binding };
    }

    currentId = await getParentIssueId(ctx, companyId, currentId);
  }

  return null;
}

// Walks up the parent chain and returns the nearest bound thread with its depth.
export async function resolveThreadForIssue(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
): Promise<{ binding: TaskThreadBinding; depth: number } | null> {
  const resolved = await resolveDestinationForIssue(ctx, companyId, issueId, {
    thread: (id) => getBindingByIssue(ctx, companyId, id),
  });
  return resolved?.binding ? { binding: resolved.binding, depth: resolved.depth } : null;
}

export function truncateThreadName(name: string): string {
  const collapsed = name.replace(/\s+/g, " ").trim();
  if (!collapsed) return FALLBACK_THREAD_NAME;
  if (collapsed.length <= MAX_THREAD_NAME_LENGTH) return collapsed;

  const budget = MAX_THREAD_NAME_LENGTH - THREAD_NAME_ELLIPSIS.length;
  let kept = "";
  // Iterate by code point so a surrogate pair is never split in half.
  for (const char of collapsed) {
    if (kept.length + char.length > budget) break;
    kept += char;
  }
  const trimmed = kept.trimEnd();
  return (trimmed || kept) + THREAD_NAME_ELLIPSIS;
}

// The line a freshly bound thread opens with, telling the board how to use it.
export function taskThreadIntroMessage(identifier: string | null): string {
  const name = identifier ? `**${identifier}**` : "이 태스크";
  return (
    `${name} 전용 대화창입니다. 답글을 달지 않고 그냥 입력해도 이 태스크의 코멘트로 올라가고, ` +
    "하위 태스크 소식도 새 창 없이 모두 여기로 모입니다."
  );
}

export function buildThreadName(identifier: string | null, title: string | null): string {
  const parts = [identifier, title].filter((part): part is string => !!part && part.trim().length > 0);
  return truncateThreadName(parts.join(" "));
}

// Promotes an already-posted message into a thread; null when Discord refused.
export async function createThreadFromMessage(
  ctx: PluginContext,
  token: string,
  channelId: string,
  messageId: string,
  opts: { name: string; autoArchiveMinutes?: ThreadAutoArchiveMinutes },
): Promise<string | null> {
  const safeChannelId = normalizeDiscordPathId(channelId);
  const safeMessageId = normalizeDiscordPathId(messageId);

  try {
    let threadId: string | null = null;
    await withRetry(async () => {
      const response = await discordFetch(
        ctx,
        token,
        `/channels/${safeChannelId}/messages/${safeMessageId}/threads`,
        {
          method: "POST",
          body: {
            name: truncateThreadName(opts.name),
            auto_archive_duration: opts.autoArchiveMinutes ?? DEFAULT_AUTO_ARCHIVE_MINUTES,
          },
        },
      );

      if (!response.ok) {
        const text = await response.text();
        const err = new Error(`Discord API error: ${response.status}`);
        (err as any).status = response.status;
        (err as any).headers = response.headers;
        ctx.logger.warn("Discord rejected thread creation", {
          status: response.status,
          body: text,
          channelId: safeChannelId,
          messageId: safeMessageId,
        });
        throw err;
      }

      const data = (await response.json()) as { id?: string };
      threadId = typeof data.id === "string" && data.id ? data.id : null;
    });
    return threadId;
  } catch (error) {
    ctx.logger.error("Thread creation failed", {
      channelId: safeChannelId,
      messageId: safeMessageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
