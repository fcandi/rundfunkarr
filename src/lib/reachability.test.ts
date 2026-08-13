import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, Record<string, unknown>>();
vi.mock("@/lib/cache", () => ({
  mediathekCache: {
    get: (key: string) => store.get(key),
    set: (key: string, value: Record<string, unknown>) => void store.set(key, value),
  },
}));

import { dropGoneItems, isGone } from "./reachability";

function mockFetch(status: number) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ status }) as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe("isGone", () => {
  it("treats 404 and 410 as gone", async () => {
    mockFetch(404);
    expect(await isGone("https://example.com/a.mp4")).toBe(true);

    mockFetch(410);
    expect(await isGone("https://example.com/b.mp4")).toBe(true);
  });

  it("keeps everything else, including 5xx and 405", async () => {
    // A CDN that dislikes HEAD, or a hiccup, is not proof of absence.
    mockFetch(405);
    expect(await isGone("https://example.com/c.mp4")).toBe(false);

    mockFetch(503);
    expect(await isGone("https://example.com/d.mp4")).toBe(false);
  });

  it("keeps the entry when the probe throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("timeout");
      })
    );

    expect(await isGone("https://example.com/e.mp4")).toBe(false);
  });

  it("probes each URL only once", async () => {
    const fetchMock = mockFetch(404);

    await isGone("https://example.com/f.mp4");
    await isGone("https://example.com/f.mp4");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses HEAD", async () => {
    const fetchMock = mockFetch(200);

    await isGone("https://example.com/g.mp4");

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "HEAD" });
  });
});

describe("dropGoneItems", () => {
  it("keeps the order of the surviving items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({ status: url.includes("dead") ? 404 : 200 }) as Response)
    );

    const items = [
      { url: "https://example.com/one.mp4" },
      { url: "https://example.com/dead.mp4" },
      { url: "https://example.com/two.mp4" },
    ];

    const alive = await dropGoneItems(items, (item) => item.url);

    expect(alive.map((item) => item.url)).toEqual([
      "https://example.com/one.mp4",
      "https://example.com/two.mp4",
    ]);
  });
});
