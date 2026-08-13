/**
 * Is the video behind a Mediathek entry still there?
 *
 * The MediathekView index outlives the media: entries stay listed after the
 * broadcaster has taken the file down, and every one of them turns into a
 * failed download in Radarr. Radarr answers a failed download by blocklisting
 * the release (title + published date), which is not something it can be told
 * to skip -- so the failure must not happen in the first place.
 */

import { mediathekCache } from "@/lib/cache";

const CHECK_TIMEOUT_MS = 5000;
const MAX_PARALLEL_CHECKS = 5;

/**
 * Only a definitive "not there" counts as gone. A timeout, a 5xx, or a CDN
 * that dislikes HEAD keeps the entry: losing a film we could have had is worse
 * than one failed download.
 */
export async function isGone(url: string): Promise<boolean> {
  if (!url) return false;

  const cacheKey = `url_gone_${url}`;
  const cached = mediathekCache.get(cacheKey);
  if (cached && typeof cached.gone === "boolean") {
    return cached.gone;
  }

  let gone = false;
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    gone = response.status === 404 || response.status === 410;
  } catch {
    // Network error, timeout, DNS -- unknown, not proof of absence.
    gone = false;
  }

  mediathekCache.set(cacheKey, { gone });
  return gone;
}

/**
 * Drop entries whose video is gone, in bounded parallel.
 *
 * `urlOf` picks the variant to probe. A Mediathek asset expires as a whole, so
 * probing the variant that is most likely to be grabbed is enough -- there is
 * no point in paying for one request per quality.
 */
export async function dropGoneItems<T>(items: T[], urlOf: (item: T) => string): Promise<T[]> {
  const alive: T[] = [];

  for (let i = 0; i < items.length; i += MAX_PARALLEL_CHECKS) {
    const chunk = items.slice(i, i + MAX_PARALLEL_CHECKS);
    const verdicts = await Promise.all(chunk.map((item) => isGone(urlOf(item))));
    chunk.forEach((item, index) => {
      if (!verdicts[index]) alive.push(item);
    });
  }

  return alive;
}
