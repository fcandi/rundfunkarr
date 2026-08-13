import type { ApiResultItem, TmdbMovieData } from "@/types";
import { getSetting } from "@/lib/settings";
import { hasPartMarker, stripBroadcastAnnotations } from "@/lib/titles";

// Default duration tolerance in minutes
const DEFAULT_DURATION_TOLERANCE = 10;

// A film's Mediathek entry may deviate from TMDB's runtime -- TV cuts, PAL
// speed-up, differing credit lengths -- but only within a band. Everything far
// outside it is a different piece of content that merely carries the film's
// name: a featurette, an interview, a making-of, or one part of a serialised
// broadcast. The duration used to be a scoring input only, which let a 6-minute
// festival clip named "Nevrland" win against the 89-minute film.
const MIN_RUNTIME_RATIO = 0.6;
const MAX_RUNTIME_RATIO = 1.4;

/**
 * Is this item's length plausible for the film? Unknown runtimes (TMDB has no
 * value) get the benefit of the doubt -- the minimum-duration setting is the
 * only guard left in that case.
 */
export function isRuntimePlausible(
  itemDurationSeconds: number,
  movieRuntimeMinutes: number
): boolean {
  if (!movieRuntimeMinutes || movieRuntimeMinutes <= 0) return true;

  const itemMinutes = itemDurationSeconds / 60;
  return (
    itemMinutes >= movieRuntimeMinutes * MIN_RUNTIME_RATIO &&
    itemMinutes <= movieRuntimeMinutes * MAX_RUNTIME_RATIO
  );
}

/**
 * Get the duration tolerance setting
 */
async function getDurationTolerance(): Promise<number> {
  const setting = await getSetting("matching.movie.durationTolerance");
  if (setting) {
    const parsed = parseInt(setting, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_DURATION_TOLERANCE;
}

/**
 * Normalize a title for comparison
 * - Lowercase
 * - Remove special characters
 * - Normalize spaces
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[/:;,"'@#?$%^*+=!|<>()&""'']/g, "")
    .replace(/[-–—]/g, " ") // Normalize different dash types
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Does `haystack` contain `needle` as a whole word sequence?
 *
 * A plain `includes()` matches inside words, which is how an hr documentary
 * titled "Milky Chance - Two High School Friends Making Music" passed as the
 * film "Milk".
 */
function containsWholeWords(haystack: string, needle: string): boolean {
  if (!needle) return false;

  const words = haystack.split(" ").filter(Boolean);
  const needleWords = needle.split(" ").filter(Boolean);
  if (needleWords.length === 0 || needleWords.length > words.length) return false;

  for (let i = 0; i + needleWords.length <= words.length; i++) {
    if (needleWords.every((word, offset) => words[i + offset] === word)) return true;
  }
  return false;
}

/**
 * Partial match in either direction, but always on word boundaries.
 */
function titlesOverlap(a: string, b: string): boolean {
  return containsWholeWords(a, b) || containsWholeWords(b, a);
}

/**
 * Calculate string similarity (0-1)
 */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const distance = levenshteinDistance(a, b);
  const maxLength = Math.max(a.length, b.length);
  return 1 - distance / maxLength;
}

export interface MovieMatchResult {
  item: ApiResultItem;
  score: number; // 0-100, higher is better
  titleMatch: "exact" | "fuzzy" | "partial";
  durationDiff: number; // Difference in minutes
}

/**
 * Match mediathek items to a movie
 * Returns items sorted by match score (best first)
 */
export async function matchMovieItems(
  items: ApiResultItem[],
  movieData: TmdbMovieData,
  minDurationSeconds: number
): Promise<MovieMatchResult[]> {
  const durationTolerance = await getDurationTolerance();
  const results: MovieMatchResult[] = [];

  const normalizedGermanTitle = normalizeTitle(movieData.germanTitle);
  const normalizedOriginalTitle = normalizeTitle(movieData.title);
  const movieRuntimeMinutes = movieData.runtime || 0;

  console.log(
    `[MovieMatcher] Matching ${items.length} items against "${movieData.germanTitle}" (original: "${movieData.title}"), runtime: ${movieRuntimeMinutes} min`
  );

  for (const item of items) {
    // Skip m3u8 streams
    if (item.url_video.endsWith(".m3u8")) continue;

    // Broadcast annotations ("(Originalversion mit Untertitel)") are not part
    // of the film's name -- comparing with them attached turns an exact match
    // into a partial one.
    const normalizedTopic = normalizeTitle(stripBroadcastAnnotations(item.topic));
    const normalizedTitle = normalizeTitle(stripBroadcastAnnotations(item.title));
    const combinedTitle = normalizeTitle(stripBroadcastAnnotations(`${item.topic} ${item.title}`));

    // Item duration in minutes
    const itemDurationMinutes = Math.floor(item.duration / 60);
    const durationDiff = Math.abs(movieRuntimeMinutes - itemDurationMinutes);

    if (minDurationSeconds > 0 && item.duration < minDurationSeconds) continue;

    // One part of a serialised broadcast is not the film.
    if (hasPartMarker(item.title) || hasPartMarker(item.topic)) {
      console.log(`[MovieMatcher] Skipping part of a serialised broadcast: "${item.title}"`);
      continue;
    }

    // A length far off the film's runtime means different content under the
    // same name (featurette, interview, making-of).
    if (!isRuntimePlausible(item.duration, movieRuntimeMinutes)) {
      console.log(
        `[MovieMatcher] Skipping "${item.title}" (${itemDurationMinutes} min): implausible for a ${movieRuntimeMinutes} min film`
      );
      continue;
    }

    let titleMatch: "exact" | "fuzzy" | "partial" | null = null;
    let titleScore = 0;

    // Try matching against German title
    if (
      normalizedTopic === normalizedGermanTitle ||
      normalizedTitle === normalizedGermanTitle ||
      combinedTitle === normalizedGermanTitle
    ) {
      titleMatch = "exact";
      titleScore = 100;
    } else {
      // Fuzzy match
      const topicSimilarity = stringSimilarity(normalizedTopic, normalizedGermanTitle);
      const titleSimilarity = stringSimilarity(normalizedTitle, normalizedGermanTitle);
      const combinedSimilarity = stringSimilarity(combinedTitle, normalizedGermanTitle);
      const bestSimilarity = Math.max(topicSimilarity, titleSimilarity, combinedSimilarity);

      if (bestSimilarity >= 0.9) {
        titleMatch = "exact";
        titleScore = bestSimilarity * 100;
      } else if (bestSimilarity >= 0.7) {
        titleMatch = "fuzzy";
        titleScore = bestSimilarity * 100;
      } else if (
        titlesOverlap(normalizedTopic, normalizedGermanTitle) ||
        titlesOverlap(normalizedTitle, normalizedGermanTitle)
      ) {
        titleMatch = "partial";
        titleScore = 60;
      }
    }

    // Try matching against original title if no German match
    if (!titleMatch && normalizedOriginalTitle !== normalizedGermanTitle) {
      if (
        normalizedTopic === normalizedOriginalTitle ||
        normalizedTitle === normalizedOriginalTitle ||
        combinedTitle === normalizedOriginalTitle
      ) {
        titleMatch = "exact";
        titleScore = 95; // Slightly lower score for original title match
      } else {
        const topicSimilarity = stringSimilarity(normalizedTopic, normalizedOriginalTitle);
        const titleSimilarity = stringSimilarity(normalizedTitle, normalizedOriginalTitle);
        const combinedSimilarity = stringSimilarity(combinedTitle, normalizedOriginalTitle);
        const bestSimilarity = Math.max(topicSimilarity, titleSimilarity, combinedSimilarity);

        if (bestSimilarity >= 0.9) {
          titleMatch = "exact";
          titleScore = bestSimilarity * 95;
        } else if (bestSimilarity >= 0.7) {
          titleMatch = "fuzzy";
          titleScore = bestSimilarity * 90;
        } else if (
          titlesOverlap(normalizedTopic, normalizedOriginalTitle) ||
          titlesOverlap(normalizedTitle, normalizedOriginalTitle)
        ) {
          titleMatch = "partial";
          titleScore = 55;
        }
      }
    }

    if (!titleMatch) continue;

    // Calculate duration score (0-20 points)
    let durationScore = 0;
    if (movieRuntimeMinutes > 0) {
      if (durationDiff <= durationTolerance) {
        // Within tolerance: full points
        durationScore = 20;
      } else if (durationDiff <= durationTolerance * 2) {
        // Slightly outside tolerance: partial points
        durationScore = 10;
      }
      // Outside 2x tolerance: 0 points
    } else {
      // No runtime info from TMDB: give benefit of the doubt
      durationScore = 10;
    }

    // Total score (weighted)
    const totalScore = titleScore * 0.8 + durationScore;

    results.push({
      item,
      score: totalScore,
      titleMatch,
      durationDiff,
    });
  }

  // Sort by score (highest first)
  results.sort((a, b) => b.score - a.score);

  console.log(`[MovieMatcher] Found ${results.length} matches`);
  if (results.length > 0) {
    const best = results[0];
    console.log(
      `[MovieMatcher] Best match: "${best.item.topic}" - "${best.item.title}" (score: ${best.score.toFixed(1)}, duration diff: ${best.durationDiff} min)`
    );
  }

  return results;
}
