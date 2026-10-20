import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { DiscordMessage, DiscordComponent } from "./discord-api.js";
import { COLORS } from "./constants.js";

type Payload = Record<string, unknown>;

const DEFAULT_BASE_URL = "http://localhost:3100";

const STATUS_LABELS: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
  backlog: "Backlog",
  cancelled: "Cancelled",
};

const PRIORITY_LABELS: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function humanizeStatus(raw: string): string {
  return STATUS_LABELS[raw] ?? raw;
}

export function humanizePriority(raw: string): string {
  return PRIORITY_LABELS[raw] ?? raw;
}

/**
 * Build the base URL for dashboard DEEP LINKS (the `url` of a link button).
 *
 * The web app namespaces every entity route under the company's issue prefix
 * (`/:companyPrefix/issues/:id`, `/:companyPrefix/approvals/:id`). A link built
 * from the API base URL alone makes the app read the first path segment —
 * `issues`, `approvals` — as a company prefix, and it fails with
 * "Organization not found — No organization matches prefix \"APPROVALS\"".
 *
 * This value is for links ONLY. The API base URL must stay un-prefixed: the
 * same configured value carries every `${baseUrl}/api/...` call (approval
 * decisions, reply-to-comment), and those 404 under a company prefix.
 *
 * `issuePrefix` is nullable on purpose — when the lookup fails the caller
 * passes null and links degrade to their previous, prefix-less form instead of
 * the notification failing.
 */
export function buildLinkBaseUrl(baseUrl: string | undefined, issuePrefix?: string | null): string {
  const base = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const prefix = (issuePrefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!prefix) return base;
  return `${base}/${encodeURIComponent(prefix)}`;
}

function resolveBaseUrl(baseUrl?: string): string | null {
  const url = (baseUrl || DEFAULT_BASE_URL).trim();
  const normalized = url.endsWith("/") ? url.slice(0, -1) : url;

  try {
    const parsed = new URL(normalized);
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

/**
 * Payload keys `formatIssueCreated` already renders into a named field, the
 * embed body, or a button — never repeat them in the catch-all loop below.
 */
const RENDERED_ISSUE_PAYLOAD_KEYS = new Set([
  "identifier", "title", "description", "status", "priority",
  "assigneeName", "projectName", "assigneeAgentId", "projectId",
  "creatorName", "parentIdentifier", "parentTitle", "parentId",
]);

/**
 * Bookkeeping keys that must stay off the card.
 *
 * The catch-all loop exists to surface genuinely custom payload fields, but
 * `issue.created` is forwarded verbatim from the host's activity log, so its
 * payload also carries the host's own scheduling and audit bookkeeping plus
 * whatever the worker's enrichment pass added. Rendering those turned every
 * card into a wall of `statusDefaulted: false` / `assignmentWakeSkipReason`
 * / raw `runId` fields that no reader wants.
 *
 * Unknown keys still render — only this named set is suppressed, so a host
 * that starts sending something meaningful keeps showing it.
 */
const INTERNAL_ISSUE_PAYLOAD_KEYS = new Set([
  // Host activity-log envelope (services/activity-log.ts).
  "agentId", "runId", "responsibleUserId",
  // Host issue-create bookkeeping (routes/issues.ts).
  "statusDefaulted", "statusDefaultReason",
  "assignmentWakeSkipped", "assignmentWakeSkipReason",
  "addedReferencedIssues", "removedReferencedIssues", "currentReferencedIssues",
  "referencedIssueIdentifiers", "blockedByIssueIds", "watchdogDiscovery",
  "originKind", "originId", "billingCode",
  // Added by the worker's own enrichment pass, for other formatters' use.
  "assigneeUserId", "agentName", "executorName", "completedBy", "lastComment",
  "completedAt", "updatedAt",
]);

export function formatIssueCreated(event: PluginEvent, baseUrl?: string): DiscordMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? p.title ?? event.entityId);
  const title = String(p.title ?? "Untitled");
  const description = p.description ? String(p.description) : null;
  const status = p.status ? String(p.status) : null;
  const priority = p.priority ? String(p.priority) : null;
  const assigneeName = p.assigneeName ? String(p.assigneeName) : null;
  const projectName = p.projectName ? String(p.projectName) : null;
  const creatorName = p.creatorName ? String(p.creatorName) : null;
  const parentIdentifier = p.parentIdentifier ? String(p.parentIdentifier) : null;
  const parentTitle = p.parentTitle ? String(p.parentTitle) : null;
  const parentId = p.parentId ? String(p.parentId) : null;

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  if (parentIdentifier) {
    const parentLine = parentTitle
      ? `**${parentIdentifier}** — ${parentTitle}`
      : `**${parentIdentifier}**`;
    fields.push({ name: "Parent", value: parentLine, inline: true });
  }
  if (status) fields.push({ name: "Status", value: `\`${humanizeStatus(status)}\``, inline: true });
  if (priority) fields.push({ name: "Priority", value: `\`${humanizePriority(priority)}\``, inline: true });
  if (assigneeName) fields.push({ name: "Assignee", value: assigneeName, inline: true });
  if (projectName) fields.push({ name: "Project", value: projectName, inline: true });

  for (const [key, value] of Object.entries(p)) {
    if (RENDERED_ISSUE_PAYLOAD_KEYS.has(key)) continue;
    if (INTERNAL_ISSUE_PAYLOAD_KEYS.has(key)) continue;
    if (value == null || value === "") continue;
    const display = typeof value === "object" ? JSON.stringify(value) : String(value);
    if (display.length > 0 && display.length <= 1024) {
      fields.push({ name: key, value: display, inline: display.length < 40 });
    }
  }

  const base = resolveBaseUrl(baseUrl);

  const footerParts: string[] = [];
  if (creatorName) footerParts.push(`Created by ${creatorName}`);
  if (projectName) footerParts.push(projectName);
  const footerText = footerParts.length > 0 ? footerParts.join(" • ") : "Paperclip";

  const buttons: DiscordComponent[] = [];
  if (base) {
    buttons.push({ type: 2, style: 5, label: "View Issue", url: `${base}/issues/${event.entityId}` });
  }
  if (base && parentId) {
    buttons.push({
      type: 2,
      style: 5,
      label: "View Parent",
      url: `${base}/issues/${parentId}`,
    });
  }

  return {
    embeds: [
      {
        title: `Issue Created: ${identifier}`,
        description: description
          ? `**${title}**\n> ${description.slice(0, 500)}`
          : `**${title}**`,
        color: COLORS.BLUE,
        fields,
        footer: { text: footerText },
        timestamp: event.occurredAt,
      },
    ],
    components: buttons.length > 0 ? [{ type: 1, components: buttons }] : [],
  };
}

export function formatIssueDone(event: PluginEvent, baseUrl?: string): DiscordMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? p.title ?? event.entityId);
  const title = String(p.title ?? "") || identifier;
  const status = p.status ? String(p.status) : null;
  const priority = p.priority ? String(p.priority) : null;
  const assigneeName = p.assigneeName ? String(p.assigneeName) : null;
  const assigneeUserId = p.assigneeUserId ? String(p.assigneeUserId) : null;
  const executorName = p.executorName ? String(p.executorName) : null;
  const agentName = p.agentName ? String(p.agentName) : null;
  const explicitCompletedBy = p.completedBy ? String(p.completedBy) : null;
  const assigneeAgentId = p.assigneeAgentId ? String(p.assigneeAgentId) : null;
  const completedBy = humanizeActorLabel(
    explicitCompletedBy || assigneeName || executorName || agentName || assigneeUserId || assigneeAgentId,
  ) || "Unknown";
  const lastComment = p.lastComment ? String(p.lastComment) : null;
  const summary = lastComment ? lastComment.slice(0, 200) : "No summary available";
  const parentIdentifier = p.parentIdentifier ? String(p.parentIdentifier) : null;
  const parentTitle = p.parentTitle ? String(p.parentTitle) : null;
  const parentId = p.parentId ? String(p.parentId) : null;

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  fields.push({ name: "Completed by", value: completedBy, inline: true });
  if (status) fields.push({ name: "Status", value: `\`${humanizeStatus(status)}\``, inline: true });
  if (priority) fields.push({ name: "Priority", value: `\`${humanizePriority(priority)}\``, inline: true });
  fields.push({ name: "Summary", value: summary });
  if (parentIdentifier) {
    const parentLine = parentTitle
      ? `**${parentIdentifier}** — ${parentTitle}`
      : `**${parentIdentifier}**`;
    fields.push({ name: "Parent", value: parentLine, inline: true });
  }

  const base = resolveBaseUrl(baseUrl);

  const buttons: DiscordComponent[] = [];
  if (base) {
    buttons.push({ type: 2, style: 5, label: "View Issue", url: `${base}/issues/${event.entityId}` });
  }
  if (p.prUrl) {
    buttons.push({ type: 2, style: 5, label: "View Diff", url: String(p.prUrl) });
  }
  buttons.push({
    type: 2,
    style: 4,
    label: "Reopen",
    custom_id: `issue_reopen_${event.entityId}`,
  });

  return {
    embeds: [
      {
        title: `✅ Issue Completed: ${identifier}`,
        description: `**${title}** is now done.`,
        color: COLORS.GREEN,
        fields,
        footer: { text: "Paperclip" },
        timestamp: event.occurredAt,
      },
    ],
    components: [{ type: 1, components: buttons }],
  };
}

const ROLLUP_TITLE_LIMIT = 140;

const ROLLUP_EVENT_LABELS: Record<string, string> = {
  "issue.created": "Created",
  "agent.run.started": "Run started",
  "agent.run.finished": "Run finished",
  "agent.run.failed": "Run failed",
  "approval.created": "Approval requested",
};

function firstPayloadString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function rollupLabel(eventType: string, status: string | null): string {
  if (eventType === "issue.updated") return status ? humanizeStatus(status) : "Updated";
  const label = ROLLUP_EVENT_LABELS[eventType];
  if (label) return label;
  return status ? humanizeStatus(status) : eventType;
}

/** One line standing in for a full card, for an event rolled up into an ancestor's thread. */
export function formatSubtaskRollup(event: PluginEvent, baseUrl?: string): DiscordMessage {
  const p = event.payload as Payload;
  const identifier = firstPayloadString(p.identifier, p.issueIdentifier);
  const title = firstPayloadString(p.title, p.issueTitle);
  const issueId = firstPayloadString(p.issueId) ?? event.entityId ?? null;
  const status = firstPayloadString(p.status);
  const base = resolveBaseUrl(baseUrl);

  const name = identifier ?? title ?? "Task";
  const head = base && issueId ? `[**${name}**](${base}/issues/${issueId})` : `**${name}**`;
  const titlePart = identifier && title ? ` ${title.slice(0, ROLLUP_TITLE_LIMIT)}` : "";

  return { content: `↳ ${head}${titlePart} — ${rollupLabel(event.eventType, status)}` };
}

function humanizeActorLabel(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("discord:")) return trimmed.slice("discord:".length);
  return trimmed;
}

const APPROVAL_TYPE_LABELS: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  budget_override_required: "Budget Override",
  request_board_approval: "Board Approval",
};

export function humanizeApprovalType(raw: string): string {
  return APPROVAL_TYPE_LABELS[raw] ?? raw;
}

/**
 * Payload keys `formatApprovalCreated` already renders into a named field, the
 * embed body, or a button — never repeat them in the catch-all loop below.
 */
const RENDERED_APPROVAL_PAYLOAD_KEYS = new Set([
  "type", "approvalId", "title", "description", "agentName",
  "issueIds", "linkedIssues",
]);

/**
 * Bookkeeping keys that must stay off the card.
 *
 * `approval.created` is the host's activity-log entry, so its payload is the
 * log envelope — `agentId` / `runId` / `responsibleUserId` — wrapped around a
 * bare `{ type, issueIds }`. Rendering those produced the card the board
 * complained about: an untitled "Approval Requested" showing a raw
 * `request_board_approval`, a UUID under "Linked Issues", and a
 * `responsibleUserId` UUID — none of which say what is being approved.
 *
 * The approval's real payload (what the requester wrote) is merged in by the
 * worker's enrichment pass. Unknown keys from there still render — only this
 * named set is suppressed, so anything an agent attaches keeps showing.
 */
const INTERNAL_APPROVAL_PAYLOAD_KEYS = new Set([
  // Host activity-log envelope (services/activity-log.ts).
  "agentId", "runId", "responsibleUserId", "actorId", "actorType",
  // Approval row columns the card expresses through its own chrome.
  "id", "companyId", "status", "requestedByAgentId", "requestedByUserId",
  "decisionNote", "decidedByUserId", "decidedAt", "createdAt", "updatedAt",
]);

function formatLinkedIssueLine(issue: Record<string, unknown>): string {
  const identifier = issue.identifier ? String(issue.identifier) : null;
  const title = issue.title ? String(issue.title) : "";
  const parts = [identifier ? `**${identifier}** ${title}` : `**${title || "?"}**`];
  const meta: string[] = [];
  if (issue.status) meta.push(humanizeStatus(String(issue.status)));
  if (issue.priority) meta.push(humanizePriority(String(issue.priority)));
  if (issue.assignee) meta.push(`→ ${issue.assignee}`);
  if (meta.length > 0) parts.push(`(${meta.join(" | ")})`);
  if (issue.description) parts.push(`\n> ${String(issue.description).slice(0, 100)}`);
  return parts.join(" ");
}

export function formatApprovalCreated(event: PluginEvent, baseUrl?: string): DiscordMessage {
  const p = event.payload as Payload;
  const approvalType = String(p.type ?? "unknown");
  const approvalId = String(p.approvalId ?? event.entityId);
  const title = String(p.title ?? "");
  const description = String(p.description ?? "");
  const agentName = String(p.agentName ?? "");
  const dashboardBase = resolveBaseUrl(baseUrl);

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  if (agentName) fields.push({ name: "Requested by", value: agentName, inline: true });
  fields.push({ name: "Type", value: `\`${humanizeApprovalType(approvalType)}\``, inline: true });

  // Raw `issueIds` are deliberately not rendered: unenriched they are UUIDs,
  // and a UUID tells the approver nothing. The worker resolves them into
  // `linkedIssues` with identifiers and titles; that is what belongs here.
  const linkedIssues = Array.isArray(p.linkedIssues) ? p.linkedIssues as Array<Record<string, unknown>> : [];
  if (linkedIssues.length > 0) {
    const issueLines = linkedIssues.map(formatLinkedIssueLine);
    const name = linkedIssues.length > 1 ? `Linked Issues (${linkedIssues.length})` : "Linked Issue";
    fields.push({ name, value: issueLines.join("\n\n").slice(0, 1024) });
  }

  for (const [key, value] of Object.entries(p)) {
    if (RENDERED_APPROVAL_PAYLOAD_KEYS.has(key)) continue;
    if (INTERNAL_APPROVAL_PAYLOAD_KEYS.has(key)) continue;
    if (value == null || value === "") continue;
    const display = typeof value === "object" ? JSON.stringify(value) : String(value);
    if (display.length > 0 && display.length <= 1024) {
      fields.push({ name: key, value: display, inline: display.length < 40 });
    }
  }

  const buttons: DiscordComponent[] = [
    {
      type: 2,
      style: 3,
      label: "Approve",
      custom_id: `approval_approve_${approvalId}`,
    },
    {
      type: 2,
      style: 4,
      label: "Reject",
      custom_id: `approval_reject_${approvalId}`,
    },
  ];
  if (dashboardBase) {
    buttons.push({
      type: 2,
      style: 5,
      label: "View",
      url: `${dashboardBase}/approvals/${approvalId}`,
    });
  }
  // One linked issue is the common case (an agent asking the board to sign off
  // on a task); send the approver straight there instead of making them hunt.
  const soleIssueId = linkedIssues.length === 1 && linkedIssues[0]?.id ? String(linkedIssues[0].id) : null;
  if (dashboardBase && soleIssueId) {
    const label = linkedIssues[0]?.identifier
      ? `View ${String(linkedIssues[0].identifier)}`
      : "View Issue";
    buttons.push({ type: 2, style: 5, label, url: `${dashboardBase}/issues/${soleIssueId}` });
  }

  return {
    embeds: [
      {
        title: title ? `Approval: ${title}`.slice(0, 256) : "Approval Requested",
        description: description ? truncate(description, 2000) : undefined,
        color: COLORS.YELLOW,
        fields,
        footer: { text: "Paperclip" },
        timestamp: event.occurredAt,
      },
    ],
    components: [{ type: 1, components: buttons }],
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function formatAgentError(event: PluginEvent): DiscordMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  const errorMessage = String(p.error ?? p.message ?? "Unknown error");

  return {
    embeds: [
      {
        title: "Agent Error",
        description: `**${agentName}** encountered an error`,
        color: COLORS.RED,
        fields: [
          { name: "Error", value: errorMessage.slice(0, 1024) },
        ],
        footer: { text: "Paperclip" },
        timestamp: event.occurredAt,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Session failure classification
// ---------------------------------------------------------------------------

const ERROR_CLASSIFICATIONS: Array<{
  pattern: RegExp;
  label: string;
  nextSteps: string;
}> = [
  {
    pattern: /token.?limit|context.?length|max.?tokens|context.?window/i,
    label: "Session / Token Limit",
    nextSteps: "The session hit its token limit. Use `/clip retry <task>` to restart with a fresh context, or break the task into smaller subtasks.",
  },
  {
    pattern: /budget.?exhaust|budget.?exceed|insufficient.?budget|over.?budget/i,
    label: "Budget Exhausted",
    nextSteps: "The agent's budget has been fully consumed. Use `/clip budget <agent>` to check the current state and top up if needed.",
  },
  {
    pattern: /timeout|timed?.?out|deadline.?exceed/i,
    label: "Timeout",
    nextSteps: "The session timed out before completing. Use `/clip retry <task>` to restart, or increase the timeout if applicable.",
  },
];

function classifyError(errorMessage: string): { label: string; nextSteps: string } {
  for (const cls of ERROR_CLASSIFICATIONS) {
    if (cls.pattern.test(errorMessage)) {
      return { label: cls.label, nextSteps: cls.nextSteps };
    }
  }
  return {
    label: "Unknown Error",
    nextSteps: "Check the agent logs for details. Use `/clip status <agent>` to see the current agent state.",
  };
}

export function formatSessionFailure(event: PluginEvent): DiscordMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  const errorMessage = String(p.error ?? p.message ?? "Unknown error");
  const taskIdentifier = p.issueIdentifier ? String(p.issueIdentifier) : null;
  const taskTitle = p.issueTitle ? String(p.issueTitle) : null;
  const lastActiveAt = p.lastActiveAt ? String(p.lastActiveAt) : null;

  const classification = classifyError(errorMessage);

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

  if (taskIdentifier) {
    const taskLine = taskTitle
      ? `**${taskIdentifier}** — ${taskTitle}`
      : `**${taskIdentifier}**`;
    fields.push({ name: "Task", value: taskLine, inline: true });
  }

  fields.push({ name: "Error Type", value: `\`${classification.label}\``, inline: true });

  if (lastActiveAt) {
    const ts = Math.floor(new Date(lastActiveAt).getTime() / 1000);
    fields.push({ name: "Last Active", value: `<t:${ts}:R>`, inline: true });
  }

  fields.push({ name: "Error", value: errorMessage.slice(0, 1024) });
  fields.push({ name: "Next Steps", value: classification.nextSteps });

  return {
    embeds: [
      {
        title: `Session Failed: ${agentName}`,
        description: `**${agentName}** session ended with an error`,
        color: COLORS.RED,
        fields,
        footer: { text: "Paperclip" },
        timestamp: event.occurredAt,
      },
    ],
  };
}

export interface BudgetWarningData {
  agentName: string;
  agentId: string;
  spent: number;
  limit: number;
  remaining: number;
  pct: number;
}

export function formatBudgetWarning(data: BudgetWarningData): DiscordMessage {
  return {
    embeds: [
      {
        title: `Budget Warning: ${data.agentName}`,
        description: `**${data.agentName}** has used **${data.pct}%** of its budget`,
        color: COLORS.YELLOW,
        fields: [
          { name: "Spent", value: `$${data.spent.toFixed(2)}`, inline: true },
          { name: "Limit", value: `$${data.limit.toFixed(2)}`, inline: true },
          { name: "Remaining", value: `$${data.remaining.toFixed(2)}`, inline: true },
          {
            name: "Next Steps",
            value: `Use \`/clip budget ${data.agentName}\` to check live budget status.`,
          },
        ],
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// Pick the best human-readable name for an agent run notification.
// Paperclip's agent.run.* events set entityId = run id (not agent id), so the
// previous `event.entityId` fallback produced run UUIDs as agent names. Prefer
// the actor (agent id from the event envelope) over entityId, and only show a
// generic label as a last resort.
function resolveRunAgentLabel(event: PluginEvent, p: Payload): string {
  if (typeof p.agentName === "string" && p.agentName) return p.agentName;
  if (typeof p.agentId === "string" && p.agentId) return p.agentId;
  if (typeof event.actorId === "string" && event.actorId) return event.actorId;
  return "Agent";
}

export function formatAgentRunStarted(event: PluginEvent): DiscordMessage {
  const p = event.payload as Payload;
  const agentName = resolveRunAgentLabel(event, p);
  const issueIdentifier = p.issueIdentifier ? String(p.issueIdentifier) : null;
  const issueTitle = p.issueTitle ? String(p.issueTitle) : null;

  const taskLine = issueIdentifier
    ? `\nTask: **${issueIdentifier}**${issueTitle ? ` — ${issueTitle}` : ""}`
    : "";

  return {
    embeds: [
      {
        title: `Run Started: ${agentName}`,
        description: `**${agentName}** has started a new run.${taskLine}`,
        color: COLORS.BLUE,
        footer: { text: "Paperclip" },
        timestamp: event.occurredAt,
      },
    ],
  };
}

export function formatAgentRunFinished(event: PluginEvent): DiscordMessage {
  const p = event.payload as Payload;
  const agentName = resolveRunAgentLabel(event, p);
  const issueIdentifier = p.issueIdentifier ? String(p.issueIdentifier) : null;
  const issueTitle = p.issueTitle ? String(p.issueTitle) : null;

  const taskLine = issueIdentifier
    ? `\nTask: **${issueIdentifier}**${issueTitle ? ` — ${issueTitle}` : ""}`
    : "";

  return {
    embeds: [
      {
        title: `Run Finished: ${agentName}`,
        description: `**${agentName}** completed successfully.${taskLine}`,
        color: COLORS.GREEN,
        footer: { text: "Paperclip" },
        timestamp: event.occurredAt,
      },
    ],
  };
}
