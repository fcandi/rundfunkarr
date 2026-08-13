import { describe, expect, it, vi } from "vitest";
import type { ApiResultItem, TmdbMovieData } from "@/types";

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

import { matchMovieItems } from "./movie-matcher";

const movie: TmdbMovieData = {
  tmdbId: 28,
  imdbId: "tt0000028",
  title: "Documentary",
  germanTitle: "Documentary",
  runtime: 45,
  releaseDate: "2026-07-12",
};

function makeItem(
  duration: number,
  id: string,
  overrides: Partial<ApiResultItem> = {}
): ApiResultItem {
  return {
    channel: "ARD",
    topic: "Documentary",
    title: "Documentary",
    description: "",
    filmlisteTimestamp: 1_700_000_000,
    duration,
    size: 1_000_000,
    url_website: `https://example.com/${id}`,
    url_video: `https://example.com/${id}.mp4`,
    url_video_low: "",
    url_video_hd: "",
    ...overrides,
  };
}

describe("matchMovieItems – minimum duration", () => {
  it("compares durations in seconds at the configured boundary", async () => {
    const matches = await matchMovieItems(
      [makeItem(2699, "short"), makeItem(2700, "boundary")],
      movie,
      2700
    );

    expect(matches.map((match) => match.item.url_video)).toEqual([
      "https://example.com/boundary.mp4",
    ]);
  });

  it("does not filter by the setting when it is zero", async () => {
    // 40 min against a 45 min film: below any minimum-duration setting one
    // might configure, but still plausible for the film itself.
    const matches = await matchMovieItems([makeItem(2400, "short")], movie, 0);

    expect(matches).toHaveLength(1);
  });
});

describe("matchMovieItems – runtime plausibility", () => {
  it("rejects a featurette that carries the film's name", async () => {
    // "Nevrland: Auf der Suche" -- a 6 min festival clip whose topic is exactly
    // the film's title, which used to win on title score alone.
    const nevrland: TmdbMovieData = { ...movie, title: "Nevrland", germanTitle: "Nevrland" };
    const clip = makeItem(356, "clip", { topic: "Nevrland", title: "Auf der Suche" });
    const film = makeItem(5098, "film", { topic: "Spielfilm", title: "Nevrland" });

    const matches = await matchMovieItems([clip, film], { ...nevrland, runtime: 89 }, 300);

    expect(matches.map((match) => match.item.url_video)).toEqual(["https://example.com/film.mp4"]);
  });

  it("rejects an overlong entry", async () => {
    const matches = await matchMovieItems([makeItem(45 * 60 * 2, "double")], movie, 0);

    expect(matches).toHaveLength(0);
  });

  it("keeps entries when TMDB reports no runtime", async () => {
    const matches = await matchMovieItems([makeItem(356, "clip")], { ...movie, runtime: null }, 0);

    expect(matches).toHaveLength(1);
  });
});

describe("matchMovieItems – part markers", () => {
  it("rejects one part of a serialised broadcast", async () => {
    // ARTE aired "Fabian oder Der Gang vor die Hunde" (176 min) as four parts.
    const fabian: TmdbMovieData = {
      ...movie,
      title: "Fabian oder der Gang vor die Hunde",
      germanTitle: "Fabian oder der Gang vor die Hunde",
      runtime: 176,
    };
    const part = makeItem(2580, "part", {
      topic: "Fernsehfilme und Serien - Serien",
      title:
        "Fabian oder Der Gang vor die Hunde (1/4) - Die Zeit ist mit den Engeln böse (Audiodeskription)",
    });

    const matches = await matchMovieItems([part], fabian, 300);

    expect(matches).toHaveLength(0);
  });
});

describe("matchMovieItems – title relation", () => {
  it("does not match a title that merely shares a word stem", async () => {
    // The hr documentary "Milky Chance ..." was grabbed as the film "Milk"
    // because a plain includes() matched inside the word.
    const milk: TmdbMovieData = {
      ...movie,
      title: "Milk",
      germanTitle: "Milk",
      runtime: 128,
    };
    const milkyChance = makeItem(86 * 60, "milky", {
      topic: 'Milky Chance - "Two High School Friends Making Music"',
      title: 'Milky Chance – "Two High School Friends Making Music" (DE)',
    });

    const matches = await matchMovieItems([milkyChance], milk, 300);

    expect(matches).toHaveLength(0);
  });

  it("matches through a broadcast annotation", async () => {
    // "Lost Country (Originalversion mit Untertitel)" is the film itself.
    const lostCountry: TmdbMovieData = {
      ...movie,
      title: "Изгубљена земља",
      germanTitle: "Lost Country",
      runtime: 98,
    };
    const item = makeItem(6032, "lost", {
      topic: "Kino - Filme",
      title: "Lost Country (Originalversion mit Untertitel)",
    });

    const matches = await matchMovieItems([item], lostCountry, 300);

    expect(matches).toHaveLength(1);
    expect(matches[0].titleMatch).toBe("exact");
  });
});
