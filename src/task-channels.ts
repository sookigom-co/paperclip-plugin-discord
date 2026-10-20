import type { PluginContext } from "@paperclipai/plugin-sdk";
import { normalizeDiscordId } from "./discord-api.js";
import { findTaskByIdentifier } from "./task-lookup.js";

/** One `taskChannels` entry, with the issue its key resolved to. */
export interface TaskChannelMapping {
  /** The key exactly as the operator wrote it. */
  configKey: string;
  channelId: string;
  /** Null when the key names no task this company has; the entry is then inert. */
  issueId: string | null;
  issueIdentifier: string | null;
}

/** The `taskChannels` map, resolved once per bootstrap and indexed both ways. */
export interface TaskChannelRouter {
  mappings: TaskChannelMapping[];
  byIssueId: Map<string, string>;
  byChannelId: Map<string, string>;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function emptyTaskChannelRouter(): TaskChannelRouter {
  return { mappings: [], byIssueId: new Map(), byChannelId: new Map() };
}

function cacheScope(companyId: string, configKey: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId || "default",
    stateKey: `task_channel_key_${configKey.toLowerCase()}`,
  };
}

type KeyResolution = { issueId: string | null; issueIdentifier: string | null };

function asKeyResolution(raw: unknown): KeyResolution | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<KeyResolution>;
  if (typeof candidate.issueId !== "string" || !candidate.issueId) return null;
  return {
    issueId: candidate.issueId,
    issueIdentifier: typeof candidate.issueIdentifier === "string" ? candidate.issueIdentifier : null,
  };
}

async function lookupQuietly(ctx: PluginContext, companyId: string, configKey: string) {
  try {
    return await findTaskByIdentifier(ctx, companyId, configKey);
  } catch (error) {
    ctx.logger.debug("taskChannels key lookup failed", {
      configKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// Resolves one key to an issue id, reading and filling the per-company cache.
async function resolveConfigKey(
  ctx: PluginContext,
  companyId: string,
  configKey: string,
): Promise<KeyResolution> {
  const scope = cacheScope(companyId, configKey);
  const cached = asKeyResolution(await ctx.state.get(scope));
  if (cached) return cached;

  const task = await lookupQuietly(ctx, companyId, configKey);
  // An unconfirmed UUID key still stands, since configuration is the authority.
  const issueId = task?.id ?? (UUID_REGEX.test(configKey) ? configKey : null);
  const resolution: KeyResolution = { issueId, issueIdentifier: task?.identifier ?? null };
  if (issueId) await ctx.state.set(scope, resolution);
  return resolution;
}

/** Resolve the configured `taskChannels` map into a router. Never throws. */
export async function buildTaskChannelRouter(
  ctx: PluginContext,
  companyId: string,
  raw: unknown,
): Promise<TaskChannelRouter> {
  const router = emptyTaskChannelRouter();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return router;

  for (const [rawKey, rawChannel] of Object.entries(raw as Record<string, unknown>)) {
    const configKey = typeof rawKey === "string" ? rawKey.trim() : "";
    const channelId = normalizeDiscordId(rawChannel);
    if (!configKey || !channelId) {
      ctx.logger.warn("Ignoring a taskChannels entry with no usable task key or channel id", {
        configKey: rawKey,
      });
      continue;
    }

    const resolution = await resolveConfigKey(ctx, companyId, configKey);
    const mapping: TaskChannelMapping = { configKey, channelId, ...resolution };
    router.mappings.push(mapping);

    if (!mapping.issueId) {
      ctx.logger.warn("taskChannels names a task this company has no record of; that entry is inert", {
        configKey,
        channelId,
      });
      continue;
    }

    const channelTaken = router.byChannelId.get(channelId);
    if (channelTaken && channelTaken !== mapping.issueId) {
      ctx.logger.warn("Two taskChannels entries point at one channel; the later key wins", {
        channelId,
        previousIssueId: channelTaken,
        issueId: mapping.issueId,
      });
    }
    router.byIssueId.set(mapping.issueId, channelId);
    router.byChannelId.set(channelId, mapping.issueId);
  }

  return router;
}

/** Warn when a mapped channel is also a general notification channel, and follow the configuration anyway. */
export function warnOnSharedTaskChannels(
  ctx: PluginContext,
  router: TaskChannelRouter,
  reserved: Array<{ label: string; channelId: string | null }>,
): void {
  if (router.byChannelId.size === 0) return;
  for (const { label, channelId } of reserved) {
    if (!channelId) continue;
    const issueId = router.byChannelId.get(channelId);
    if (!issueId) continue;
    ctx.logger.warn(
      "A taskChannels channel is also a general notification channel; plain chat there will become task comments",
      { channelId, issueId, sharedWith: label },
    );
  }
}
