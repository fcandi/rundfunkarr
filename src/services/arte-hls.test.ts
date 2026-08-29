import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isArteUrl,
  extractArteProgrammeId,
  pickBestVariant,
  resolveArteHlsStream,
} from "./arte-hls";

// A real film-list URL: ARTE's top progressive tier, which is only 720p.
const ARTE_MP4 =
  "https://arteptweb-a.akamaihd.net/am/ptweb/099000/099500/" +
  "099586-000-A_SQ_0_VA-STA_11195002_MP4-2200_AMM-PTWEB-60622563387918_1vZQq3eoT1R.mp4";

const MASTER_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7

#EXT-X-STREAM-INF:BANDWIDTH=3517792,RESOLUTION=768x432,FRAME-RATE=25.000
https://example.invalid/v432.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5022736,RESOLUTION=1920x1080,FRAME-RATE=25.000
https://example.invalid/v1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=640x360,FRAME-RATE=25.000
https://example.invalid/v360.m3u8
`;

describe("isArteUrl", () => {
  it("recognises ARTE media hosts", () => {
    expect(isArteUrl(ARTE_MP4)).toBe(true);
    expect(isArteUrl("https://arte-cmafhls.akamaized.net/am/cmaf/x.m3u8")).toBe(true);
  });

  it("leaves other broadcasters alone", () => {
    expect(isArteUrl("https://wdrmedien-a.akamaihd.net/medp/foo.mp4")).toBe(false);
    expect(isArteUrl("https://nrodlzdf-a.akamaihd.net/de/tivi/foo_6660k_p37v17.mp4")).toBe(false);
  });

  it("does not throw on malformed input", () => {
    expect(isArteUrl("not a url")).toBe(false);
  });
});

describe("extractArteProgrammeId", () => {
  it("recovers the programme id from a film-list URL", () => {
    expect(extractArteProgrammeId(ARTE_MP4)).toBe("099586-000-A");
  });

  it("returns null when no id is present", () => {
    expect(extractArteProgrammeId("https://arteptweb-a.akamaihd.net/am/ptweb/x.mp4")).toBeNull();
  });
});

describe("pickBestVariant", () => {
  it("picks the tallest variant and reports its ffmpeg program index", () => {
    // The 1080p entry is the second EXT-X-STREAM-INF, so program index 1.
    expect(pickBestVariant(MASTER_PLAYLIST)).toEqual({
      programIndex: 1,
      width: 1920,
      height: 1080,
    });
  });

  it("returns null for a playlist without resolutions", () => {
    expect(pickBestVariant("#EXTM3U\n#EXT-X-VERSION:7\n")).toBeNull();
  });
});

describe("resolveArteHlsStream", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves a film-list MP4 to the best HLS variant", async () => {
    const manifestUrl = "https://manifest-arte.akamaized.net/api/manifest/v1/Generate/abc/de";
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { attributes: { streams: [{ url: manifestUrl }] } } }),
      } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => MASTER_PLAYLIST } as Response);

    await expect(resolveArteHlsStream(ARTE_MP4)).resolves.toEqual({
      manifestUrl,
      programIndex: 1,
      width: 1920,
      height: 1080,
    });
  });

  it("returns null for non-ARTE URLs without calling the API", async () => {
    await expect(
      resolveArteHlsStream("https://wdrmedien-a.akamaihd.net/medp/foo.mp4")
    ).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns null when the player API fails, so the caller keeps the MP4", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    await expect(resolveArteHlsStream(ARTE_MP4)).resolves.toBeNull();
  });

  it("returns null when the network throws", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(resolveArteHlsStream(ARTE_MP4)).resolves.toBeNull();
  });
});
