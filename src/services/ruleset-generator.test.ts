import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApiResultItem, TvdbData } from "@/types";

// Keep the unit hermetic: the generator only ever sees the mocked API and DB.
const prismaMock = vi.hoisted(() => ({
  generatedRuleset: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { generateRulesetForShow } from "./ruleset-generator";

function makeItem(overrides: Partial<ApiResultItem> = {}): ApiResultItem {
  return {
    channel: "ARTE.DE",
    topic: "Fernsehfilme und Serien - Serien",
    title: "Familiengeheimnisse (1/6)",
    description: "",
    filmlisteTimestamp: 1_800_000_000,
    duration: 2490,
    size: 711_014_563,
    url_website: "https://www.arte.tv/de/videos/127977-001-A/",
    url_video: "https://example.com/127977-001-A_720.mp4",
    url_video_low: "https://example.com/127977-001-A_480.mp4",
    url_video_hd: "https://example.com/127977-001-A_1080.mp4",
    ...overrides,
  };
}

function makeShow(overrides: Partial<TvdbData> = {}): TvdbData {
  return {
    id: 446785,
    name: "Pubertat",
    germanName: "Familiengeheimnisse",
    aliases: [],
    episodes: [],
    ...overrides,
  } as TvdbData;
}

interface MediathekRequest {
  queries: Array<{ fields: string[]; query: string }>;
  future: boolean;
}

function mockApi(results: ApiResultItem[]): MediathekRequest[] {
  const requests: MediathekRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      return { ok: true, json: async () => ({ result: { results } }) };
    })
  );
  return requests;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.generatedRuleset.findFirst.mockResolvedValue(null);
  prismaMock.generatedRuleset.create.mockImplementation(async ({ data }) => ({
    id: "11111111-2222-3333-4444-555555555555",
    ...data,
  }));
});

describe("shows that live in a collective topic", () => {
  const arteEpisodes = [1, 2, 3, 4, 5, 6].map((n) =>
    makeItem({ title: `Familiengeheimnisse (${n}/6)` })
  );

  it("searches titles as well, and keeps entries whose broadcast is still ahead", async () => {
    const requests = mockApi(arteEpisodes);

    await generateRulesetForShow(446785, makeShow());

    // Without both of these the ARTE entries are invisible to the generator:
    // the show name is only in the title, and the entries carry the (future)
    // TV date while already being online.
    expect(requests[0].queries[0].fields).toEqual(["topic", "title"]);
    expect(requests[0].future).toBe(true);
  });

  it("scopes the ruleset to this show instead of claiming the whole slot", async () => {
    mockApi([
      ...arteEpisodes,
      makeItem({ title: "Ein ganz anderer Film" }),
      makeItem({ title: "Mord im Mittsommer - Staffel 7 (2/4) - Fall 11" }),
    ]);

    await generateRulesetForShow(446785, makeShow());

    const { data } = prismaMock.generatedRuleset.create.mock.calls[0][0];
    expect(data.topic).toBe("Fernsehfilme und Serien - Serien");

    const filters = JSON.parse(data.filters);
    const titleFilter = filters.find((f: { attribute: string }) => f.attribute === "title");
    expect(titleFilter).toBeDefined();
    // Case-insensitive at match time, exactly like the generation-time check.
    expect(titleFilter.type).toBe("RegexIgnoreCase");

    const scope = new RegExp(titleFilter.value, "i");
    expect(scope.test("Familiengeheimnisse (1/6)")).toBe(true);
    expect(scope.test("Ein ganz anderer Film")).toBe(false);
    expect(scope.test("Mord im Mittsommer - Staffel 7 (2/4) - Fall 11")).toBe(false);
  });

  it("reads the bare (episode/total) numbering ARTE uses", async () => {
    mockApi(arteEpisodes);

    await generateRulesetForShow(446785, makeShow());

    const { data } = prismaMock.generatedRuleset.create.mock.calls[0][0];
    expect(data.matchingStrategy).toBe("SeasonAndEpisodeNumber");
    expect("Familiengeheimnisse (4/6)".match(data.episodeRegex)?.[1]).toBe("4");
    // No season is stated; the matcher fills it in for single-season shows.
    expect(data.seasonRegex).toBe("");
  });

  it("does not read a stated season as an episode count", async () => {
    // "Staffel 7 (2/4)" is episode 2 of season seven, not of season one.
    mockApi([
      makeItem({ title: "Mord im Mittsommer - Staffel 7 (2/4) - Fall 11: Familiengeheimnisse" }),
      makeItem({ title: "Mord im Mittsommer - Staffel 7 (3/4) - Fall 12: Der Fremde" }),
    ]);

    await generateRulesetForShow(
      123456,
      makeShow({ id: 123456, name: "Mord im Mittsommer", germanName: "Mord im Mittsommer" })
    );

    const call = prismaMock.generatedRuleset.create.mock.calls[0];
    if (call) {
      expect(call[0].data.episodeRegex).not.toBe("\\((\\d{1,3})/\\d{1,3}\\)");
    }
  });
});

describe("weak evidence must not mint a ruleset", () => {
  it("refuses on a single stray title match", async () => {
    // One talk-show episode that merely leads with the show name is not
    // evidence that the series runs in that slot -- a ruleset minted from it
    // would block generation for the real show forever.
    mockApi([
      makeItem({ topic: "37 Grad", title: "Familiengeheimnisse - wenn Schweigen krank macht" }),
      makeItem({ topic: "Dokumentationen", title: "Etwas ganz anderes" }),
    ]);

    const result = await generateRulesetForShow(446785, makeShow());

    expect(result).toBeNull();
    expect(prismaMock.generatedRuleset.create).not.toHaveBeenCalled();
  });

  it("does not fall back to a lone topic that never matched the show", async () => {
    // Title search can return 50 foreign entries sharing one collective slot
    // although the show itself is absent from the index; keying an unscoped
    // ruleset on that slot would claim every series in it.
    mockApi([
      makeItem({ topic: "Fernsehfilme und Serien - Serien", title: "Die großen Familiengeheimnisse (1/2)" }),
      makeItem({ topic: "Fernsehfilme und Serien - Serien", title: "Die großen Familiengeheimnisse (2/2)" }),
    ]);

    const result = await generateRulesetForShow(446785, makeShow());

    expect(result).toBeNull();
    expect(prismaMock.generatedRuleset.create).not.toHaveBeenCalled();
  });

  it("refuses a second unscoped ruleset on an occupied topic", async () => {
    // Partial topic matching ("Der Tatortreiniger" vs the existing topic
    // "Tatort") resolves unscoped; if another show already holds a ruleset on
    // that topic, creating a second unscoped one would cross-attribute
    // episodes between the two shows.
    prismaMock.generatedRuleset.findFirst.mockImplementation(async ({ where }) =>
      where.tvdbId === undefined
        ? { id: "x", topic: "Tatort", tvdbId: 83214, showName: "Tatort" }
        : null
    );
    mockApi([makeItem({ topic: "Tatort", title: "Tatort: Irgendein Fall (S01/E01)" })]);

    const result = await generateRulesetForShow(
      999999,
      makeShow({ id: 999999, name: "Der Tatortreiniger", germanName: "Der Tatortreiniger" })
    );

    expect(result).toBeNull();
    expect(prismaMock.generatedRuleset.create).not.toHaveBeenCalled();
  });

  it("does not persist a SeasonAndEpisodeNumber ruleset without an episode pattern", async () => {
    // Strategy detection and pattern emission can disagree; a persisted
    // ruleset with no episode regex would never match and never be retried.
    // "Staffel N Episode M" counts for the strategy but has no emission branch.
    mockApi([1, 2, 3].map((n) =>
      makeItem({ topic: "Familiengeheimnisse", title: `Familiengeheimnisse Staffel 1 Episode ${n}` })
    ));

    const result = await generateRulesetForShow(446785, makeShow());

    expect(result).toBeNull();
    expect(prismaMock.generatedRuleset.create).not.toHaveBeenCalled();
  });

  it("derives the count-of pattern from the same window the strategy saw", async () => {
    // The strategy is detected over fifteen samples; the emission must scan
    // the same window, or recent extras in the first five entries persist a
    // ruleset with an empty episode regex.
    mockApi([
      ...[1, 2, 3, 4, 5].map((n) =>
        makeItem({ title: `Familiengeheimnisse Spezial ${n}`, duration: 400 })
      ),
      ...[1, 2, 3, 4, 5, 6].map((n) => makeItem({ title: `Familiengeheimnisse (${n}/6)` })),
    ]);

    await generateRulesetForShow(446785, makeShow());

    const { data } = prismaMock.generatedRuleset.create.mock.calls[0][0];
    expect(data.episodeRegex).toBe("\\((\\d{1,3})/\\d{1,3}\\)");
  });
});

describe("the caller's search results are reused", () => {
  it("does not hit the external API when results are passed in", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await generateRulesetForShow(
      446785,
      makeShow(),
      [1, 2, 3, 4, 5, 6].map((n) => makeItem({ title: `Familiengeheimnisse (${n}/6)` }))
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prismaMock.generatedRuleset.create).toHaveBeenCalled();
  });
});

describe("shows that have a topic of their own", () => {
  it("keeps the plain topic ruleset unscoped", async () => {
    mockApi([
      makeItem({
        channel: "ARD",
        topic: "Die Augenzeugen",
        title: "Folge 2: Lügen (S01/E02)",
      }),
    ]);

    await generateRulesetForShow(
      463232,
      makeShow({ id: 463232, name: "The Eyewitness", germanName: "Die Augenzeugen" })
    );

    const { data } = prismaMock.generatedRuleset.create.mock.calls[0][0];
    expect(data.topic).toBe("Die Augenzeugen");
    expect(JSON.parse(data.filters).some((f: { attribute: string }) => f.attribute === "title")).toBe(
      false
    );
  });
});
