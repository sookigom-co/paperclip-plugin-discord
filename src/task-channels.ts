import type { PluginContext } from "@paperclipai/plugin-sdk";
import { normalizeDiscordId } from "./discord-api.js";
import { findTaskByIdentifier } from "./task-lookup.js";

/** A `taskChannels` value: a channel id, or a channel id with per-task options. */
export type TaskChannelEntry = string | Record<string, unknown>;

/** One `taskChannels` entry, with the issue its key resolved to. */
export interface TaskChannelMapping {
  /** The key exactly as the operator wrote it. */
  configKey: string;
  channelId: string;
  /** This entry's `fullText`, or null to follow the global `fullTaskResponses`. */
  fullText: boolean | null;
  /** Null when the key names no task this company has; the entry is then inert. */
  issueId: string | null;
  issueIdentifier: string | null;
}

/** The `taskChannels` map, resolved once per bootstrap and indexed both ways. */
export interface TaskChannelRouter {
  mappings: TaskChannelMapping[];
  byIssueId: Map<string, string>;
  byChannelId: Map<string, string>;
  /** Only the issues whose entry set `fullText` explicitly. */
  fullTextByIssueId: Map<string, boolean>;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CHANNEL_KEYS = ["channel", "channelId", "channel_id"];
const FULL_TEXT_KEYS = ["fullText", "full_text", "fullResponse", "full_response"];

export function emptyTaskChannelRouter(): TaskChannelRouter {
  return { mappings: [], byIssueId: new Map(), byChannelId: new Map(), fullTextByIssueId: new Map() };
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

function asBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const text = raw.trim().toLowerCase();
    if (text === "true") return true;
    if (text === "false") return false;
  }
  return null;
}

/** One entry's channel and options, whether written as a bare id or as an object. */
function parseEntry(
  ctx: PluginContext,
  configKey: string,
  raw: unknown,
): { channelId: string; fullText: boolean | null } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const channelId = normalizeDiscordId(raw);
    return channelId ? { channelId, fullText: null } : null;
  }

  const record = raw as Record<string, unknown>;
  const channelKey = CHANNEL_KEYS.find((key) => record[key] !== undefined);
  const channelId = channelKey ? normalizeDiscordId(record[channelKey]) : "";
  if (!channelId) return null;

  const fullTextKey = FULL_TEXT_KEYS.find((key) => record[key] !== undefined);
  const fullText = fullTextKey ? asBoolean(record[fullTextKey]) : null;
  if (fullTextKey && fullText === null) {
    ctx.logger.warn("A taskChannels entry sets a non-boolean full-text option; following the global setting", {
      configKey,
      option: fullTextKey,
    });
  }

  const unknownKeys = Object.keys(record).filter(
    (key) => !CHANNEL_KEYS.includes(key) && !FULL_TEXT_KEYS.includes(key),
  );
  if (unknownKeys.length > 0) {
    ctx.logger.warn("Ignoring unrecognized options in a taskChannels entry", { configKey, unknownKeys });
  }

  return { channelId, fullText };
}

/** Resolve the configured `taskChannels` map into a router. Never throws. */
export async function buildTaskChannelRouter(
  ctx: PluginContext,
  companyId: string,
  raw: unknown,
): Promise<TaskChannelRouter> {
  const router = emptyTaskChannelRouter();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return router;

  for (const [rawKey, rawEntry] of Object.entries(raw as Record<string, unknown>)) {
    const configKey = typeof rawKey === "string" ? rawKey.trim() : "";
    const entry = configKey ? parseEntry(ctx, configKey, rawEntry) : null;
    if (!entry) {
      ctx.logger.warn("Ignoring a taskChannels entry with no usable task key or channel id", {
        configKey: rawKey,
      });
      continue;
    }

    const resolution = await resolveConfigKey(ctx, companyId, configKey);
    const mapping: TaskChannelMapping = {
      configKey,
      channelId: entry.channelId,
      fullText: entry.fullText,
      ...resolution,
    };
    router.mappings.push(mapping);

    if (!mapping.issueId) {
      ctx.logger.warn("taskChannels names a task this company has no record of; that entry is inert", {
        configKey,
        channelId: mapping.channelId,
      });
      continue;
    }

    const channelTaken = router.byChannelId.get(mapping.channelId);
    if (channelTaken && channelTaken !== mapping.issueId) {
      ctx.logger.warn("Two taskChannels entries point at one channel; the later key wins", {
        channelId: mapping.channelId,
        previousIssueId: channelTaken,
        issueId: mapping.issueId,
      });
    }
    router.byIssueId.set(mapping.issueId, mapping.channelId);
    router.byChannelId.set(mapping.channelId, mapping.issueId);
    if (mapping.fullText !== null) router.fullTextByIssueId.set(mapping.issueId, mapping.fullText);
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
