import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApiResultItem, TmdbMovieData } from "@/types";

// Keep the unit hermetic: no DB, no network, no ruleset store.
vi.mock("@/lib/settings", () => ({
  // null -> defaults kick in: quality "all", minDuration 300s, fuzzy/0.7
  getSetting: vi.fn().mockResolvedValue(null),
  getMinDurationSeconds: vi.fn().mockResolvedValue(300),
}));
vi.mock("@/lib/cache", () => ({
  mediathekCache: { get: vi.fn().mockReturnValue(undefined), set: vi.fn() },
}));
vi.mock("@/lib/fetch-retry", () => ({ fetchWithRetry: vi.fn() }));
// No rulesets -> every API result becomes an "unmatched" item.
vi.mock("./rulesets", () => ({
  ensureRulesetsLoaded: vi.fn().mockResolvedValue(undefined),
  getRulesetsForTopic: vi.fn().mockReturnValue([]),
  getRulesetsForTopicAndTvdbId: vi.fn().mockReturnValue([]),
  getAllTopics: vi.fn().mockReturnValue([]),
  getOrGenerateRulesetForShow: vi.fn().mockResolvedValue(null),
}));
vi.mock("./tmdb", () => ({
  searchMovieByTitle: vi.fn().mockResolvedValue(null),
}));
vi.mock("./shows", () => ({
  getShowInfoByTvdbId: vi.fn(),
}));

import {
  fetchMovieSearchByQuery,
  fetchMovieSearchResults,
  fetchSearchResultsById,
  fetchSearchResultsByString,
} from "./mediathek";
import { fetchWithRetry } from "@/lib/fetch-retry";
import { mediathekCache } from "@/lib/cache";
import { getMinDurationSeconds } from "@/lib/settings";
import { searchMovieByTitle } from "./tmdb";
import { getShowInfoByTvdbId } from "./shows";
import { getRulesetsForTopicAndTvdbId } from "./rulesets";
import type { Ruleset, TvdbData, TvdbEpisode } from "@/types";

const mockedSearchMovieByTitle = vi.mocked(searchMovieByTitle);
const mockedFetch = vi.mocked(fetchWithRetry);
const mockedGetMinDuration = vi.mocked(getMinDurationSeconds);
const mockedCacheSet = vi.mocked(mediathekCache.set);
const mockedGetShowInfo = vi.mocked(getShowInfoByTvdbId);
const mockedGetRulesets = vi.mocked(getRulesetsForTopicAndTvdbId);

function makeItem(overrides: Partial<ApiResultItem> = {}): ApiResultItem {
  return {
    channel: "ARD",
    topic: "Irgendeine Sendung",
    title: "Irgendeine Sendung (S01/E03)",
    description: "",
    filmlisteTimestamp: 1_700_000_000,
    duration: 3600,
    size: 1_000_000_000,
    url_website: "https://example.com/show",
    url_video: "https://example.com/show_720.mp4",
    url_video_low: "https://example.com/show_480.mp4",
    url_video_hd: "https://example.com/show_1080.mp4",
    ...overrides,
  };
}

function mockApi(results: ApiResultItem[]): void {
  mockedFetch.mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify({ result: { results } }),
  } as Response);
}

/** Reachability probes (HEAD) go through the global fetch; default: alive. */
function mockReachability(statusByUrl: Record<string, number> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({ status: statusByUrl[url] ?? 200 }) as Response)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetMinDuration.mockResolvedValue(300);
  mockedSearchMovieByTitle.mockResolvedValue(null);
  mockReachability();
});

describe("fetchSearchResultsByString – generic result gating", () => {
  it("emits NO generic results for a season-only query (no q)", async () => {
    // Regression for tvsearch&season=01 without q: without the gate this
    // returned generic items for every unrelated show whose title contains "S01".
    mockApi([
      makeItem({ topic: "Show A", title: "Show A (S01/E01)" }),
      makeItem({ topic: "Show B", title: "Show B (S01/E02)" }),
    ]);

    const xml = await fetchSearchResultsByString(null, "01", 100, 0);

    expect(xml).toContain('total="0"');
    expect(xml).not.toContain("<item>");
  });

  it("DOES emit generic results for an actual text query (q set)", async () => {
    mockApi([makeItem({ topic: "Markus Lanz", title: "Markus Lanz (S2026/E70)" })]);

    const xml = await fetchSearchResultsByString("Markus Lanz", null, 100, 0);

    expect(xml).not.toContain('total="0"');
    expect(xml).toContain("<item>");
  });

  it("treats a whitespace-only q like an empty query (no generic results)", async () => {
    mockApi([makeItem({ topic: "Show C", title: "Show C (S01/E04)" })]);

    const xml = await fetchSearchResultsByString("   ", "01", 100, 0);

    expect(xml).toContain('total="0"');
    expect(xml).not.toContain("<item>");
  });
});

describe("fetchMovieSearchByQuery – configured minimum duration", () => {
  it("includes movies at the configured boundary and rejects shorter results", async () => {
    mockedGetMinDuration.mockResolvedValue(2700);
    // The release name comes from the item title, so distinguish the two
    // candidates there rather than via the (shared) topic.
    mockApi([
      makeItem({ topic: "Kino - Filme", title: "Too Short", duration: 2699 }),
      makeItem({ topic: "Kino - Filme", title: "At Boundary", duration: 2700 }),
    ]);

    const xml = await fetchMovieSearchByQuery("Documentary", 100, 0);

    expect(xml).toContain("At.Boundary");
    expect(xml).not.toContain("Too.Short");
    expect(mockedCacheSet).toHaveBeenCalledWith(
      expect.stringContaining("movie_query_Documentary__100_0_all_2700"),
      expect.any(Object)
    );
  });
});

describe("fetchMovieSearchByQuery – release title", () => {
  // Regression for ARTE anthology strands: "Lost Country" airs under the topic
  // "Kino - Filme" (ARTE.DE) / "Cinéma - Films" (ARTE.FR). Naming the release
  // after the topic made every film of the strand share one release name and
  // Radarr rejected it: "Unknown Movie. Unable to match to correct movie using
  // release title."
  it("names the release after the film, not the anthology strand it aired in", async () => {
    mockApi([
      makeItem({
        topic: "Kino - Filme",
        title: "Lost Country (Originalversion mit Untertitel)",
        duration: 6032,
      }),
    ]);

    const xml = await fetchMovieSearchByQuery("Lost Country 2023", 100, 0);

    expect(xml).toContain("Lost.Country.2023.GERMAN");
    expect(xml).not.toContain("Kino.-.Filme");
    // The accessibility annotation must not leak into the release name.
    expect(xml).not.toContain("Untertitel");
  });

  it("uses the year Radarr asked for, not the Mediathek index timestamp", async () => {
    mockApi([
      makeItem({
        topic: "Kino - Filme",
        title: "Lost Country",
        duration: 6032,
        // Entered the index in 2026, but the film is from 2023.
        filmlisteTimestamp: 1_785_186_890,
      }),
    ]);

    const xml = await fetchMovieSearchByQuery("Lost Country 2023", 100, 0);

    expect(xml).toContain("Lost.Country.2023.GERMAN");
    expect(xml).not.toContain("Lost.Country.2026");
  });

  it("falls back to the topic when the item has no usable title", async () => {
    mockApi([makeItem({ topic: "Der Film", title: "", duration: 6032 })]);

    const xml = await fetchMovieSearchByQuery("Der Film", 100, 0);

    expect(xml).toContain("Der.Film");
  });
});

describe("fetchMovieSearchByQuery – plausibility of the emitted releases", () => {
  // Every emitted item carries the film's tmdbid, so Radarr accepts it for that
  // movie regardless of the release name. Anything that is not the film itself
  // must therefore be dropped here.
  const nevrland: TmdbMovieData = {
    tmdbId: 571032,
    imdbId: "tt8305718",
    title: "Nevrland",
    germanTitle: "Nevrland",
    runtime: 89,
    releaseDate: "2019-01-26",
  };

  it("drops a short featurette that carries the film's name", async () => {
    mockedSearchMovieByTitle.mockResolvedValue(nevrland);
    mockApi([
      makeItem({
        topic: "Max Ophüls Preis",
        title: "Nevrland: Auf der Suche",
        duration: 356,
        url_video: "https://example.com/clip_720.mp4",
      }),
      makeItem({
        topic: "Spielfilm",
        title: "Nevrland - Spielfilm, Österreich 2019",
        duration: 5098,
        url_video: "https://example.com/film_720.mp4",
      }),
    ]);

    const xml = await fetchMovieSearchByQuery("Nevrland 2019", 100, 0);

    expect(xml).toContain("film_720.mp4");
    expect(xml).not.toContain("clip_720.mp4");
  });

  it("drops one part of a serialised broadcast", async () => {
    mockedSearchMovieByTitle.mockResolvedValue({
      ...nevrland,
      title: "Fabian oder der Gang vor die Hunde",
      germanTitle: "Fabian oder der Gang vor die Hunde",
      runtime: 176,
    });
    mockApi([
      makeItem({
        topic: "Fernsehfilme und Serien - Serien",
        title: "Fabian oder Der Gang vor die Hunde (1/4) - Die Zeit ist mit den Engeln böse",
        duration: 2580,
      }),
    ]);

    const xml = await fetchMovieSearchByQuery("Fabian oder der Gang vor die Hunde 2021", 100, 0);

    expect(xml).toContain('total="0"');
    expect(xml).not.toContain("<item>");
  });

  it("drops an entry whose video the broadcaster has taken down", async () => {
    // The MediathekView index outlives the media: "Leid und Herrlichkeit" was
    // still listed weeks after ARTE removed the file, and every search turned
    // into a failed download plus a blocklist entry in Radarr.
    mockedSearchMovieByTitle.mockResolvedValue(nevrland);
    mockApi([
      makeItem({
        topic: "Spielfilm",
        title: "Nevrland",
        duration: 5098,
        url_video: "https://example.com/gone_720.mp4",
        url_video_hd: "https://example.com/gone_1080.mp4",
        url_video_low: "",
      }),
    ]);
    mockReachability({ "https://example.com/gone_1080.mp4": 404 });

    const xml = await fetchMovieSearchByQuery("Nevrland 2019", 100, 0);

    expect(xml).toContain('total="0"');
    expect(xml).not.toContain("<item>");
  });

  it("keeps an entry when the probe itself fails", async () => {
    // A timeout or a CDN that dislikes HEAD is not proof of absence -- losing a
    // film we could have had is worse than one failed download.
    mockedSearchMovieByTitle.mockResolvedValue(nevrland);
    mockApi([makeItem({ topic: "Spielfilm", title: "Nevrland", duration: 5098 })]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("timeout");
      })
    );

    const xml = await fetchMovieSearchByQuery("Nevrland 2019", 100, 0);

    expect(xml).toContain("<item>");
  });

  it("still emits the film itself", async () => {
    mockedSearchMovieByTitle.mockResolvedValue({
      ...nevrland,
      tmdbId: 999147,
      imdbId: "tt6430442",
      title: "Изгубљена земља",
      germanTitle: "Lost Country",
      runtime: 98,
      releaseDate: "2023-05-23",
    });
    mockApi([
      makeItem({
        topic: "Kino - Filme",
        title: "Lost Country (Originalversion mit Untertitel)",
        duration: 6032,
      }),
    ]);

    const xml = await fetchMovieSearchByQuery("Lost Country 2023", 100, 0);

    expect(xml).toContain("Lost.Country.2023.GERMAN");
    expect(xml).toContain("999147");
  });
});

describe("fetchMovieSearchResults – configured minimum duration", () => {
  it("applies the configured boundary to TMDB and IMDB-backed searches", async () => {
    mockedGetMinDuration.mockResolvedValue(2700);
    mockApi([
      makeItem({ topic: "Documentary", title: "Documentary", duration: 2699 }),
      makeItem({
        topic: "Documentary",
        title: "Documentary",
        duration: 2700,
        url_video: "https://example.com/boundary_720.mp4",
      }),
    ]);
    const movie: TmdbMovieData = {
      tmdbId: 28,
      imdbId: "tt0000028",
      title: "Documentary",
      germanTitle: "Documentary",
      runtime: 45,
      releaseDate: "2026-07-12",
    };

    const xml = await fetchMovieSearchResults(movie, 100, 0);

    expect(xml).toContain("boundary_720.mp4");
    expect(xml).not.toContain("show_720.mp4");
    expect(mockedCacheSet).toHaveBeenCalledWith(
      expect.stringContaining("movie_28_100_0_all_2700"),
      expect.any(Object)
    );
  });
});

describe("accessibility versions are never offered as the regular release", () => {
  it("drops an audio-described episode from a text search", async () => {
    // The case that started this: for "Die Augenzeugen" the broadcaster kept
    // only the audio-described versions online. Offering them as the regular
    // episode puts a spoken picture description into the library.
    mockApi([
      makeItem({ topic: "Die Augenzeugen", title: "Folge 2: Lügen (S01/E02) (Audiodeskription)" }),
    ]);

    const xml = await fetchSearchResultsByString("Die Augenzeugen", null, 100, 0);

    expect(xml).toContain('total="0"');
    expect(xml).not.toContain("<item>");
  });

  it("keeps the regular episode next to the audio-described one", async () => {
    mockApi([
      makeItem({ topic: "Die Augenzeugen", title: "Folge 1: Schweigen (S01/E01)" }),
      makeItem({
        topic: "Die Augenzeugen",
        title: "Folge 1: Schweigen (S01/E01) (Audiodeskription)",
      }),
    ]);

    const xml = await fetchSearchResultsByString("Die Augenzeugen", null, 100, 0);

    expect(xml).toContain("Schweigen");
    expect(xml).not.toContain("Audiodeskription");
    expect((xml.match(/<item>/g) || []).length).toBeGreaterThan(0);
  });

  it("drops a sign-language film from a movie search", async () => {
    mockApi([
      makeItem({ topic: "Kino - Filme", title: "Der Film (Gebärdensprache)", duration: 5400 }),
    ]);

    const xml = await fetchMovieSearchByQuery("Der Film", 100, 0);

    expect(xml).toContain('total="0"');
  });

  it("still offers a language variant -- OmU is a legitimate audio track", async () => {
    mockApi([
      makeItem({
        topic: "Die Augenzeugen",
        title: "Folge 3: Kontrollverlust (S01/E03) (Originalversion mit Untertitel)",
      }),
    ]);

    const xml = await fetchSearchResultsByString("Die Augenzeugen", null, 100, 0);

    expect(xml).toContain("<item>");
  });
});

describe("series releases point at media that is still there", () => {
  it("drops an episode whose video the broadcaster has taken down", async () => {
    // Same trap as on the movie side: Sonarr answers the failed download by
    // blocklisting the release, which then blocks it even once it is valid again.
    const item = makeItem({
      topic: "Die Augenzeugen",
      title: "Folge 1: Schweigen (S01/E01)",
      url_video_hd: "https://example.com/gone_1080.mp4",
    });
    mockApi([item]);
    mockReachability({ "https://example.com/gone_1080.mp4": 404 });

    const xml = await fetchSearchResultsByString("Die Augenzeugen", null, 100, 0);

    expect(xml).toContain('total="0"');
    expect(xml).not.toContain("<item>");
  });

  it("keeps the episode when the probe itself fails", async () => {
    // A timeout or a CDN that dislikes HEAD is not proof of absence -- losing an
    // episode we could have had is worse than one failed download.
    const item = makeItem({
      topic: "Die Augenzeugen",
      title: "Folge 1: Schweigen (S01/E01)",
      url_video_hd: "https://example.com/flaky_1080.mp4",
    });
    mockApi([item]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );

    const xml = await fetchSearchResultsByString("Die Augenzeugen", null, 100, 0);

    expect(xml).toContain("<item>");
  });
});

describe("episodes numbered without a season", () => {
  const ARTE_SLOT = "Fernsehfilme und Serien - Serien";

  /** What the generator writes for a collective slot: "(episode/total)", no season. */
  function countOfRuleset(overrides: Partial<Ruleset> = {}): Ruleset {
    return {
      id: 1,
      mediaId: 446785,
      topic: ARTE_SLOT,
      priority: 0,
      filters: JSON.stringify([
        { attribute: "duration", type: "GreaterThan", value: "15" },
        { attribute: "title", type: "Regex", value: "^Familiengeheimnisse(?![A-Za-z0-9])" },
      ]),
      titleRegexRules: "[]",
      episodeRegex: "\\((\\d{1,3})/\\d{1,3}\\)",
      seasonRegex: "",
      matchingStrategy: "SeasonAndEpisodeNumber" as Ruleset["matchingStrategy"],
      media: {
        media_id: 446785,
        media_name: "Pubertat",
        media_type: "show",
        media_tvdbId: 446785,
        media_tmdbId: null,
        media_imdbId: null,
      },
      ...overrides,
    };
  }

  function makeShow(episodes: TvdbEpisode[]): TvdbData {
    return {
      id: 446785,
      name: "Pubertat",
      germanName: "Familiengeheimnisse",
      aliases: [],
      episodes,
    } as unknown as TvdbData;
  }

  const singleSeason: TvdbEpisode[] = [1, 2, 3, 4, 5, 6].map((n) => ({
    name: `Folge ${n}`,
    aired: null,
    runtime: 45,
    seasonNumber: 1,
    episodeNumber: n,
  }));

  it("files a bare (3/6) under the show's only season", async () => {
    const show = makeShow(singleSeason);
    mockedGetShowInfo.mockResolvedValue(show);
    mockedGetRulesets.mockReturnValue([countOfRuleset()]);
    mockApi([makeItem({ topic: ARTE_SLOT, title: "Familiengeheimnisse (3/6)" })]);

    const xml = await fetchSearchResultsById(show, null, null, 100, 0);

    expect(xml).toContain("S01E03");
  });

  it("refuses to guess the season when the show has more than one", async () => {
    // Nothing in "(3/6)" says which season -- filing it under the first would
    // hand Sonarr the wrong episode.
    const show = makeShow([
      ...singleSeason,
      { name: "Folge 1", aired: null, runtime: 45, seasonNumber: 2, episodeNumber: 1 },
    ]);
    mockedGetShowInfo.mockResolvedValue(show);
    mockedGetRulesets.mockReturnValue([countOfRuleset()]);
    mockApi([makeItem({ topic: ARTE_SLOT, title: "Familiengeheimnisse (3/6)" })]);

    const xml = await fetchSearchResultsById(show, null, null, 100, 0);

    expect(xml).toContain('total="0"');
  });

  it("leaves the other shows of the collective slot alone", async () => {
    const show = makeShow(singleSeason);
    mockedGetShowInfo.mockResolvedValue(show);
    mockedGetRulesets.mockReturnValue([countOfRuleset()]);
    mockApi([
      makeItem({ topic: ARTE_SLOT, title: "Familiengeheimnisse (3/6)" }),
      makeItem({
        topic: ARTE_SLOT,
        title: "Eine fremde Serie (3/6)",
        url_video: "https://example.com/fremde_720.mp4",
        url_video_low: "https://example.com/fremde_480.mp4",
        url_video_hd: "https://example.com/fremde_1080.mp4",
      }),
    ]);

    const xml = await fetchSearchResultsById(show, null, null, 100, 0);

    // Both entries are episode 3 of the same slot and would produce the very
    // same release name, so the media URL is what tells them apart.
    expect(xml).toContain("show_1080.mp4");
    expect(xml).not.toContain("fremde");
  });
});
