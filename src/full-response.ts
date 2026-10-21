import type { PluginContext } from "@paperclipai/plugin-sdk";
import { postEmbed } from "./discord-api.js";

/** Room left under Discord's 2000-character message limit for a reopened fence and the overflow notice. */
export const FULL_RESPONSE_BUDGET = 1900;

export const FULL_RESPONSE_MAX_PARTS = 8;

const OVERFLOW_NOTICE = "\n…(여기까지만 옮겼습니다. 나머지는 태스크에서 확인하세요.)";

const MIN_BREAK_RATIO = 0.3;

const BREAKS = ["\n\n", "\n", " "];

// Cuts at the latest paragraph, line or word boundary that still fills the budget.
function splitOnce(text: string, budget: number): [string, string] {
  if (text.length <= budget) return [text, ""];
  const window = text.slice(0, budget + 1);
  for (const separator of BREAKS) {
    const at = window.lastIndexOf(separator);
    if (at > budget * MIN_BREAK_RATIO) {
      return [text.slice(0, at), text.slice(at + separator.length)];
    }
  }
  return [text.slice(0, budget), text.slice(budget)];
}

/** The fence line still open at the end of this text, or null when every fence is closed. */
function openFenceAfter(text: string, openFence: string | null): string | null {
  let current = openFence;
  for (const line of text.split("\n")) {
    if (!line.startsWith("```")) continue;
    current = current ? null : line.trim();
  }
  return current;
}

/** Split a comment body into Discord-sized messages, keeping code fences closed across the cuts. */
export function splitFullResponse(
  body: string,
  options: { budget?: number; maxParts?: number } = {},
): string[] {
  const budget = options.budget ?? FULL_RESPONSE_BUDGET;
  const maxParts = options.maxParts ?? FULL_RESPONSE_MAX_PARTS;
  let rest = body.trim();
  if (!rest) return [];

  const parts: string[] = [];
  let openFence: string | null = null;

  while (rest && parts.length < maxParts) {
    const reopen = openFence ? `${openFence}\n` : "";
    const [head, tail] = splitOnce(rest, budget - reopen.length);
    rest = tail;

    let part = reopen + head;
    openFence = openFenceAfter(head, openFence);
    if (openFence) part += "\n```";
    if (rest && parts.length === maxParts - 1) {
      part += OVERFLOW_NOTICE;
      rest = "";
    }
    parts.push(part);
  }

  return parts;
}

/** Post a task's own response in full, below the card that announced it. */
export async function postFullResponse(
  ctx: PluginContext,
  token: string,
  channelId: string,
  body: string | null,
): Promise<void> {
  if (!body) return;
  for (const part of splitFullResponse(body)) {
    const posted = await postEmbed(ctx, token, channelId, { content: part });
    if (!posted) return;
  }
}
