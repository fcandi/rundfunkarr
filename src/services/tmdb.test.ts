import { describe, it, expect } from "vitest";

import { pickBestMovieResult } from "./tmdb";

function hit(id: number, title: string, release_date: string) {
  return { id, title, original_title: title, release_date };
}

describe("pickBestMovieResult", () => {
  // Regression for "Lost Country": TMDB's `year` filter is loose, so a 2022
  // film ranked ahead of the 2023 one Radarr was actually asking for. Taking
  // results[0] attached the wrong tmdbid/imdbid to every release.
  it("prefers the result whose release year matches the requested year", () => {
    const results = [
      hit(1046371, "Baladi aldaia", "2022-11-12"),
      hit(999147, "Lost Country", "2023-10-11"),
    ];

    expect(pickBestMovieResult(results, 2023).id).toBe(999147);
  });

  it("keeps TMDB's ranking when no year is requested", () => {
    const results = [
      hit(1046371, "Baladi aldaia", "2022-11-12"),
      hit(999147, "Lost Country", "2023-10-11"),
    ];

    expect(pickBestMovieResult(results, null).id).toBe(1046371);
  });

  it("allows a one-year gap for festival vs. regular release", () => {
    const results = [hit(1, "Other", "2019-01-01"), hit(2, "Wanted", "2023-05-01")];

    expect(pickBestMovieResult(results, 2024).id).toBe(2);
  });

  it("falls back to the first result when no year is close enough", () => {
    const results = [hit(1, "First", "2001-01-01"), hit(2, "Second", "2002-01-01")];

    expect(pickBestMovieResult(results, 2023).id).toBe(1);
  });

  it("never picks an undated result over a dated match", () => {
    const results = [hit(1, "Undated", ""), hit(2, "Dated", "2023-01-01")];

    expect(pickBestMovieResult(results, 2023).id).toBe(2);
  });
});
