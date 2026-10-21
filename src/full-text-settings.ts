import type { PluginContext } from "@paperclipai/plugin-sdk";

/** The full-response switches `/clip fulltext` stores, layered over plugin config. */
export interface FullTextOverrides {
  /** The default for every mapped channel, or null to follow `taskFullText`. */
  global: boolean | null;
  /** Per-task switches, which outrank both defaults. */
  byIssueId: Record<string, boolean>;
}

const STATE_KEY = "full_text_overrides";

/** The configured default for mapped channels; `fullTaskResponses` is the pre-rename key for `taskFullText`. */
export function configFullTextDefault(config: {
  taskFullText?: boolean;
  fullTaskResponses?: boolean;
}): boolean {
  return (config.taskFullText ?? config.fullTaskResponses) !== false;
}

export function emptyFullTextOverrides(): FullTextOverrides {
  return { global: null, byIssueId: {} };
}

function overridesScope(companyId: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId || "default",
    stateKey: STATE_KEY,
  };
}

function asBoolean(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

/** Read the stored switches; anything unreadable counts as no override at all. */
export async function readFullTextOverrides(
  ctx: PluginContext,
  companyId: string,
): Promise<FullTextOverrides> {
  try {
    const raw = await ctx.state.get(overridesScope(companyId));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyFullTextOverrides();

    const record = raw as { global?: unknown; byIssueId?: unknown };
    const byIssueId: Record<string, boolean> = {};
    if (record.byIssueId && typeof record.byIssueId === "object" && !Array.isArray(record.byIssueId)) {
      for (const [issueId, value] of Object.entries(record.byIssueId as Record<string, unknown>)) {
        const parsed = asBoolean(value);
        if (parsed !== null) byIssueId[issueId] = parsed;
      }
    }
    return { global: asBoolean(record.global), byIssueId };
  } catch (error) {
    ctx.logger.warn("Reading the full-response switches failed; following plugin configuration", {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return emptyFullTextOverrides();
  }
}

/** Set the default for every mapped channel, or null to hand it back to configuration. */
export async function setGlobalFullText(
  ctx: PluginContext,
  companyId: string,
  value: boolean | null,
): Promise<FullTextOverrides> {
  const next: FullTextOverrides = { ...(await readFullTextOverrides(ctx, companyId)), global: value };
  await ctx.state.set(overridesScope(companyId), next);
  return next;
}

/** Set one task's switch, or null to hand it back to its `taskChannels` entry. */
export async function setTaskFullText(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  value: boolean | null,
): Promise<FullTextOverrides> {
  const current = await readFullTextOverrides(ctx, companyId);
  const byIssueId = { ...current.byIssueId };
  if (value === null) delete byIssueId[issueId];
  else byIssueId[issueId] = value;
  const next: FullTextOverrides = { ...current, byIssueId };
  await ctx.state.set(overridesScope(companyId), next);
  return next;
}

/** The default a mapped channel takes when neither its entry nor its task says otherwise. */
export function resolveDefaultFullText(overrides: FullTextOverrides, configDefault: boolean): boolean {
  return overrides.global ?? configDefault;
}

/** Where a mapped channel's effective setting comes from. */
export type FullTextSource = "task-switch" | "task-entry" | "default-switch" | "settings";

export interface FullTextDecision {
  fullText: boolean;
  source: FullTextSource;
}

/** Resolve one task's setting: its switch, then its entry, then the default. */
export function resolveFullText(args: {
  overrides: FullTextOverrides;
  issueId: string;
  entryFullText: boolean | null;
  configDefault: boolean;
}): FullTextDecision {
  const taskSwitch = args.overrides.byIssueId[args.issueId];
  if (taskSwitch !== undefined) return { fullText: taskSwitch, source: "task-switch" };
  if (args.entryFullText !== null) return { fullText: args.entryFullText, source: "task-entry" };
  if (args.overrides.global !== null) return { fullText: args.overrides.global, source: "default-switch" };
  return { fullText: args.configDefault, source: "settings" };
}
