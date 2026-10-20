import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface TaskLookupResult {
  id: string;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
}

const LOOKUP_PAGE_SIZE = 200;
const MAX_LOOKUP_PAGES = 25;

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

  const wanted = needle.toLowerCase();
  const matches = (issue: TaskLookupResult) =>
    issue.id === needle || (issue.identifier ?? "").toLowerCase() === wanted;

  for (let page = 0; page < MAX_LOOKUP_PAGES; page += 1) {
    const issues = (await ctx.issues.list({
      companyId,
      limit: LOOKUP_PAGE_SIZE,
      offset: page * LOOKUP_PAGE_SIZE,
    })) as TaskLookupResult[] | null;
    if (!issues || issues.length === 0) return null;

    const hit = issues.find(matches);
    if (hit) return hit;
    if (issues.length < LOOKUP_PAGE_SIZE) return null;
  }

  ctx.logger.warn("Gave up looking for a task identifier after the page limit", {
    input: needle,
    pagesSearched: MAX_LOOKUP_PAGES,
  });
  return null;
}
