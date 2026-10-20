import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface TaskLookupResult {
  id: string;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
}

/** Resolve a task from what a human typed: an identifier like SOO-42, or a raw id. */
export async function findTaskByIdentifier(
  ctx: PluginContext,
  companyId: string,
  input: string,
): Promise<TaskLookupResult | null> {
  const needle = input.trim();
  if (!needle) return null;

  try {
    const direct = (await ctx.issues.get(needle, companyId)) as TaskLookupResult | null;
    if (direct) return direct;
  } catch (error) {
    ctx.logger.debug("Task lookup by id failed; trying the identifier list", {
      input: needle,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const issues = (await ctx.issues.list({ companyId, limit: 200 })) as TaskLookupResult[];
  return (
    issues.find(
      (issue) =>
        issue.id === needle ||
        (issue.identifier ?? "").toLowerCase() === needle.toLowerCase(),
    ) ?? null
  );
}
