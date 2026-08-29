/**
 * ARTE ships only downgraded progressive MP4s to the MediathekView film list.
 * Its highest tier there is `MP4-2200`, which is 1280x720 - measured across
 * several titles, `url_video_hd` never exceeds that. The ARTE player itself
 * serves an HLS ladder that goes up to 1920x1080 for the same programme.
 *
 * This module bridges the two: it recovers the ARTE programme id from the MP4
 * URL in the film list, asks the public player API for the HLS manifest, and
 * reports the best variant. The caller can then let ffmpeg mux that stream
 * instead of fetching the 720p MP4.
 *
 * Everything here is best-effort. Any failure returns null so the caller falls
 * back to the plain MP4 download path.
 */

/**
 * Programme ids look like `099586-000-A` and appear in every ARTE media URL.
 *
 * The trailing guard is a character-class lookahead rather than `\b`: in a real
 * URL the id is followed by `_SQ_0_...`, and `_` is a word character, so `\b`
 * would never match there.
 */
const ARTE_PROGRAMME_ID = /(?<![A-Za-z0-9])(\d{6}-\d{3}-[A-Z])(?![A-Za-z0-9])/;

const ARTE_HOST_PATTERN =
  /(^|\.)arte(ptweb|tve|-cmafhls)?[-.a-z0-9]*\.(akamaihd|akamaized|tv)\.net/i;

const PLAYER_API = "https://api.arte.tv/api/player/v2/config";

export interface ArteHlsStream {
  /** Master playlist URL, ready to hand to ffmpeg. */
  manifestUrl: string;
  /** ffmpeg program index (`-map p:<index>`) carrying the best video variant. */
  programIndex: number;
  width: number;
  height: number;
}

export function isArteUrl(url: string): boolean {
  try {
    return ARTE_HOST_PATTERN.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function extractArteProgrammeId(url: string): string | null {
  const match = ARTE_PROGRAMME_ID.exec(url);
  return match ? match[1] : null;
}

/**
 * Parse an HLS master playlist and return the highest variant by pixel height.
 *
 * The program index is the variant's position among `EXT-X-STREAM-INF` entries,
 * which is exactly how ffmpeg numbers programs for this demuxer.
 */
export function pickBestVariant(
  manifest: string
): { programIndex: number; width: number; height: number } | null {
  const lines = manifest.split(/\r?\n/);
  let variantIndex = -1;
  let best: { programIndex: number; width: number; height: number } | null = null;

  for (const line of lines) {
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    variantIndex += 1;

    const resolution = /RESOLUTION=(\d+)x(\d+)/.exec(line);
    if (!resolution) continue;

    const width = Number(resolution[1]);
    const height = Number(resolution[2]);
    if (!best || height > best.height) {
      best = { programIndex: variantIndex, width, height };
    }
  }

  return best;
}

/**
 * Resolve an ARTE film-list MP4 URL to the best HLS variant the player offers.
 *
 * Returns null when the URL is not ARTE, the programme id cannot be recovered,
 * the player API is unreachable, or the manifest carries no usable variant.
 */
export async function resolveArteHlsStream(
  mp4Url: string,
  lang = "de"
): Promise<ArteHlsStream | null> {
  if (!isArteUrl(mp4Url)) return null;

  const programmeId = extractArteProgrammeId(mp4Url);
  if (!programmeId) {
    console.log(`[ArteHLS] No programme id in URL, keeping MP4: ${mp4Url}`);
    return null;
  }

  try {
    const configResponse = await fetch(`${PLAYER_API}/${lang}/${programmeId}`, {
      headers: { accept: "application/json" },
    });
    if (!configResponse.ok) {
      console.log(`[ArteHLS] Player API returned ${configResponse.status} for ${programmeId}`);
      return null;
    }

    const config = await configResponse.json();
    const streams = config?.data?.attributes?.streams;
    const manifestUrl: string | undefined = Array.isArray(streams) ? streams[0]?.url : undefined;
    if (!manifestUrl) {
      console.log(`[ArteHLS] No stream in player config for ${programmeId}`);
      return null;
    }

    const manifestResponse = await fetch(manifestUrl);
    if (!manifestResponse.ok) {
      console.log(`[ArteHLS] Manifest fetch returned ${manifestResponse.status}`);
      return null;
    }

    const best = pickBestVariant(await manifestResponse.text());
    if (!best) {
      console.log(`[ArteHLS] No variant with a resolution in manifest for ${programmeId}`);
      return null;
    }

    return { manifestUrl, ...best };
  } catch (error) {
    console.log(`[ArteHLS] Lookup failed for ${programmeId}, keeping MP4:`, error);
    return null;
  }
}
