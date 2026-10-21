import { describe, it, expect, vi } from "vitest";
import {
  FULL_RESPONSE_BUDGET,
  FULL_RESPONSE_MAX_PARTS,
  splitFullResponse,
  postFullResponse,
} from "../src/full-response.js";

const DISCORD_CONTENT_LIMIT = 2000;

function paragraphs(count: number, size: number): string {
  return Array.from({ length: count }, (_, i) => `${i}`.padEnd(size, "가")).join("\n\n");
}

describe("splitFullResponse", () => {
  it("leaves a response that fits in one message whole", () => {
    expect(splitFullResponse("답변 전문입니다.")).toEqual(["답변 전문입니다."]);
  });

  it("returns nothing for a blank body", () => {
    expect(splitFullResponse("   \n  ")).toEqual([]);
  });

  it("keeps every part inside Discord's message limit", () => {
    const parts = splitFullResponse(paragraphs(10, 700));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
  });

  it("loses no text across the cuts", () => {
    const body = paragraphs(6, 700);
    const parts = splitFullResponse(body);
    expect(parts.join("\n\n")).toBe(body);
  });

  it("cuts at a paragraph break rather than mid-sentence", () => {
    const parts = splitFullResponse(paragraphs(6, 700));
    for (const part of parts.slice(0, -1)) expect(part.endsWith("가")).toBe(true);
  });

  it("cuts mid-word only when there is no break to use", () => {
    const parts = splitFullResponse("가".repeat(3000));
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(FULL_RESPONSE_BUDGET);
  });

  it("closes an open code fence at a cut and reopens it in the next part", () => {
    const code = Array.from({ length: 60 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const parts = splitFullResponse(`설명\n\n\`\`\`ts\n${code}\n\`\`\``, { budget: 400 });

    expect(parts.length).toBeGreaterThan(2);
    expect(parts[1]!.startsWith("```ts\n")).toBe(true);
    for (const part of parts) {
      const fences = part.split("\n").filter((line) => line.startsWith("```")).length;
      expect(fences % 2).toBe(0);
    }
  });

  it("stops after the part cap and says where the rest is", () => {
    const parts = splitFullResponse("가".repeat(FULL_RESPONSE_BUDGET * 20));
    expect(parts).toHaveLength(FULL_RESPONSE_MAX_PARTS);
    expect(parts.at(-1)).toContain("태스크에서 확인하세요");
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
  });
});

describe("postFullResponse", () => {
  function host() {
    const posted: unknown[] = [];
    const ctx = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      metrics: { write: vi.fn() },
      http: {
        fetch: vi.fn(async (_url: unknown, init: any) => {
          posted.push(JSON.parse(init.body));
          return { ok: true, status: 200, headers: new Headers(), json: async () => ({ id: "m" }), text: async () => "" };
        }),
      },
    } as any;
    return { ctx, posted };
  }

  it("posts nothing when there is no body", async () => {
    const { ctx, posted } = host();
    await postFullResponse(ctx, "token", "ch-1", null);
    expect(posted).toHaveLength(0);
  });

  it("posts every part in order", async () => {
    const { ctx, posted } = host();
    await postFullResponse(ctx, "token", "ch-1", paragraphs(6, 700));
    expect(posted.length).toBeGreaterThan(1);
    expect((posted[0] as any).content.startsWith("0")).toBe(true);
    expect((posted[0] as any).embeds).toBeUndefined();
  });

  it("stops sending the rest once Discord refuses a part", async () => {
    const { ctx, posted } = host();
    ctx.http.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => "Missing Permissions",
    }));

    await postFullResponse(ctx, "token", "ch-1", paragraphs(6, 700));
    expect(posted).toHaveLength(0);
  });
});
