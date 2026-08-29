import { prisma } from "@/lib/db";
import { isMkvConversionEnabled } from "@/lib/settings";
import * as fs from "fs/promises";
import { createWriteStream } from "fs";
import * as path from "path";

const MAX_CONCURRENT_DOWNLOADS = 1;

/**
 * Height below which a broadcaster's film-list MP4 is worth replacing with its
 * HLS stream. ARTE tops out at 720p in the film list, so anything taller than
 * that is a genuine gain; equal or smaller means the MP4 already matches.
 */
const HLS_UPGRADE_MIN_HEIGHT = 721;

/** Opt-out for the HLS upgrade path, in case a broadcaster's stream misbehaves. */
function isHlsUpgradeEnabled(): boolean {
  return process.env.HLS_QUALITY_UPGRADE !== "false";
}

async function getDownloadBasePath(): Promise<string> {
  const { getSetting } = await import("@/lib/settings");
  return (
    (await getSetting("download.path")) ||
    process.env.DOWNLOAD_FOLDER_PATH ||
    path.join(process.cwd(), "downloads")
  );
}

async function getDownloadTempPath(): Promise<string> {
  const basePath = await getDownloadBasePath();
  return process.env.DOWNLOAD_TEMP_PATH || path.join(basePath, "incomplete");
}

// Semaphore implementation for limiting concurrent downloads
class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.permits++;
    const next = this.queue.shift();
    if (next) {
      this.permits--;
      next();
    }
  }
}

const downloadSemaphore = new Semaphore(MAX_CONCURRENT_DOWNLOADS);
let isProcessing = false;
let processingPromise: Promise<void> | null = null;

export async function startDownloadProcessing(): Promise<void> {
  if (isProcessing) {
    return processingPromise || Promise.resolve();
  }

  isProcessing = true;
  processingPromise = processQueue();
  await processingPromise;
  isProcessing = false;
  processingPromise = null;
}

async function processQueue(): Promise<void> {
  while (true) {
    // Get next queued download
    const nextDownload = await prisma.download.findFirst({
      where: { status: "queued" },
      orderBy: { createdAt: "asc" },
    });

    if (!nextDownload) {
      // No more items in queue
      break;
    }

    // Start download in background (respecting semaphore)
    processDownload(nextDownload.id).catch(console.error);

    // Small delay to prevent tight loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function processDownload(downloadId: string): Promise<void> {
  await downloadSemaphore.acquire();

  const startTime = Date.now();

  try {
    // Get download info
    const download = await prisma.download.findUnique({
      where: { id: downloadId },
    });

    if (!download || download.status !== "queued") {
      return;
    }

    console.log(`[Download] Starting: ${download.title}`);
    console.log(`[Download] URL: ${download.url}`);

    // Mark as downloading
    await prisma.download.update({
      where: { id: downloadId },
      data: { status: "downloading" },
    });

    // Create temp and category directories
    const downloadBasePath = await getDownloadBasePath();
    const downloadTempPath = await getDownloadTempPath();
    const categoryDir = path.join(downloadBasePath, download.category);
    await fs.mkdir(downloadTempPath, { recursive: true });
    await fs.mkdir(categoryDir, { recursive: true });

    // Some broadcasters publish a downgraded MP4 to the film list while their
    // player serves a better HLS ladder for the same programme (ARTE caps the
    // film list at 720p but streams 1080p). Prefer the stream when it is
    // genuinely taller; fall back to the MP4 on any failure.
    if (isHlsUpgradeEnabled() && (await isMkvConversionEnabled())) {
      const { resolveArteHlsStream } = await import("@/services/arte-hls");
      const hls = await resolveArteHlsStream(download.url);

      if (hls && hls.height >= HLS_UPGRADE_MIN_HEIGHT) {
        console.log(
          `[Download] Upgrading to HLS ${hls.width}x${hls.height} instead of the film-list MP4`
        );

        const tempMkvPath = path.join(downloadTempPath, `${download.title}.mkv`);
        const finalMkvPath = path.join(categoryDir, `${download.title}.mkv`);

        const { downloadHlsToMkv } = await import("./ffmpeg");
        const hlsResult = await downloadHlsToMkv(
          hls.manifestUrl,
          hls.programIndex,
          tempMkvPath,
          async (progress) => {
            await prisma.download.update({
              where: { id: downloadId },
              data: { progress },
            });
          }
        );

        if (hlsResult.success) {
          // The *arr app may have removed the category folder while this
          // download ran, same as in the conversion path below.
          await fs.mkdir(categoryDir, { recursive: true });
          await fs.rename(tempMkvPath, finalMkvPath);
          await completeDownload(
            downloadId,
            download.title,
            download.category,
            finalMkvPath,
            startTime
          );
          return;
        }

        // Not fatal: the MP4 below is still a valid, if smaller, copy.
        await fs.unlink(tempMkvPath).catch(() => {});
        console.warn(`[Download] HLS upgrade failed (${hlsResult.error}), falling back to the MP4`);
      }
    }

    // Determine file extension from URL
    const urlPath = new URL(download.url).pathname;
    const fileExtension = path.extname(urlPath) || ".mp4";
    // Download to temp folder first
    const tempMp4Path = path.join(downloadTempPath, `${download.title}${fileExtension}`);
    const mp4Path = tempMp4Path;

    // Download the file
    const downloadSuccess = await downloadFile(
      download.url,
      mp4Path,
      async (progress, downloadedBytes, totalBytes, speed) => {
        await prisma.download.update({
          where: { id: downloadId },
          data: {
            progress,
            downloadedBytes,
            totalSize: totalBytes,
            speed,
          },
        });
      }
    );

    if (!downloadSuccess) {
      await markAsFailed(downloadId, "Download failed");
      return;
    }

    console.log(`[Download] File downloaded to temp: ${mp4Path}`);

    // Convert MP4 files to MKV unless the user disabled this step.
    if (fileExtension.toLowerCase() === ".mp4" && (await isMkvConversionEnabled())) {
      // Convert in temp folder first
      const tempMkvPath = path.join(downloadTempPath, `${download.title}.mkv`);
      const finalMkvPath = path.join(categoryDir, `${download.title}.mkv`);

      console.log(`[Download] Converting to MKV: ${tempMkvPath}`);

      await prisma.download.update({
        where: { id: downloadId },
        data: { status: "converting" },
      });

      const { convertMp4ToMkv } = await import("./ffmpeg");
      const conversionResult = await convertMp4ToMkv(mp4Path, tempMkvPath);

      if (!conversionResult.success) {
        // Clean up temp file on failure
        await fs.unlink(mp4Path).catch(() => {});
        await markAsFailed(downloadId, conversionResult.error || "Conversion failed");
        return;
      }

      // Move completed MKV to final location. Re-create the category directory
      // first: it was created when this download started, but *arr apps remove
      // the imported file from the category folder while later downloads are
      // still running, and they delete the folder once it is empty. Without
      // this the rename fails with ENOENT and the finished file is stranded.
      await fs.mkdir(categoryDir, { recursive: true });
      console.log(`[Download] Moving to final location: ${finalMkvPath}`);
      await fs.rename(tempMkvPath, finalMkvPath);

      // Clean up temp MP4 file
      await fs.unlink(mp4Path).catch(() => {});

      // Get file size
      const stats = await fs.stat(finalMkvPath);

      // Calculate storage path (may be mapped differently)
      const downloadFolderMapping = process.env.DOWNLOAD_FOLDER_PATH_MAPPING;
      const storagePath = downloadFolderMapping
        ? path.join(downloadFolderMapping, download.category, `${download.title}.mkv`)
        : finalMkvPath;

      // Mark as completed
      const downloadTime = Math.floor((Date.now() - startTime) / 1000);

      await prisma.download.update({
        where: { id: downloadId },
        data: {
          status: "completed",
          progress: 100,
          size: stats.size,
          filePath: storagePath,
          completedAt: new Date(),
        },
      });

      console.log(
        `[Download] Completed: ${download.title} (${Math.round(stats.size / 1024 / 1024)}MB in ${downloadTime}s)`
      );
    } else {
      // Keep non-MP4 files and MP4 files with disabled conversion unchanged.
      const finalPath = path.join(categoryDir, `${download.title}${fileExtension}`);
      // Same reason as above: the category directory may have been removed by
      // the *arr app while this download was running.
      await fs.mkdir(categoryDir, { recursive: true });
      await fs.rename(mp4Path, finalPath);

      const stats = await fs.stat(finalPath);

      const downloadFolderMapping = process.env.DOWNLOAD_FOLDER_PATH_MAPPING;
      const storagePath = downloadFolderMapping
        ? path.join(downloadFolderMapping, download.category, `${download.title}${fileExtension}`)
        : finalPath;

      await prisma.download.update({
        where: { id: downloadId },
        data: {
          status: "completed",
          progress: 100,
          size: stats.size,
          filePath: storagePath,
          completedAt: new Date(),
        },
      });

      console.log(
        `[Download] Completed: ${download.title} (${Math.round(stats.size / 1024 / 1024)}MB)`
      );
    }
  } catch (error) {
    console.error(`[Download] Error processing download ${downloadId}:`, error);
    await markAsFailed(downloadId, error instanceof Error ? error.message : "Unknown error");
  } finally {
    downloadSemaphore.release();

    // Check if there are more items to process
    const hasMore = await prisma.download.count({
      where: { status: "queued" },
    });

    if (hasMore > 0 && !isProcessing) {
      startDownloadProcessing().catch(console.error);
    }
  }
}

/** Record a finished file: size, storage path (honouring the folder mapping), timestamps. */
async function completeDownload(
  downloadId: string,
  title: string,
  category: string,
  finalPath: string,
  startTime: number
): Promise<void> {
  const stats = await fs.stat(finalPath);

  const downloadFolderMapping = process.env.DOWNLOAD_FOLDER_PATH_MAPPING;
  const storagePath = downloadFolderMapping
    ? path.join(downloadFolderMapping, category, path.basename(finalPath))
    : finalPath;

  await prisma.download.update({
    where: { id: downloadId },
    data: {
      status: "completed",
      progress: 100,
      size: stats.size,
      filePath: storagePath,
      completedAt: new Date(),
    },
  });

  const downloadTime = Math.floor((Date.now() - startTime) / 1000);
  console.log(
    `[Download] Completed: ${title} (${Math.round(stats.size / 1024 / 1024)}MB in ${downloadTime}s)`
  );
}

async function markAsFailed(downloadId: string, error: string): Promise<void> {
  await prisma.download.update({
    where: { id: downloadId },
    data: {
      status: "failed",
      error,
      completedAt: new Date(),
    },
  });
}

async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (
    percent: number,
    downloadedBytes: number,
    totalBytes: number,
    speed: number
  ) => Promise<void>
): Promise<boolean> {
  try {
    const response = await fetch(url);

    if (!response.ok || !response.body) {
      console.error(`[Download] HTTP error: ${response.status} ${response.statusText}`);
      return false;
    }

    const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
    const fileStream = createWriteStream(destPath);

    const reader = response.body.getReader();
    let downloadedBytes = 0;
    let lastProgressUpdate = 0;
    let lastSpeedCheck = Date.now();
    let lastSpeedBytes = 0;
    let currentSpeed = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      fileStream.write(Buffer.from(value));
      downloadedBytes += value.length;

      // Calculate speed every second
      const now = Date.now();
      const timeDiff = now - lastSpeedCheck;
      if (timeDiff >= 1000) {
        const bytesDiff = downloadedBytes - lastSpeedBytes;
        currentSpeed = Math.round(bytesDiff / (timeDiff / 1000));
        lastSpeedCheck = now;
        lastSpeedBytes = downloadedBytes;
      }

      // Update progress (throttled to every 1%)
      if (contentLength > 0 && onProgress) {
        const percent = Math.floor((downloadedBytes / contentLength) * 100);
        if (percent > lastProgressUpdate) {
          lastProgressUpdate = percent;
          await onProgress(percent, downloadedBytes, contentLength, currentSpeed);
        }
      }
    }

    fileStream.end();

    return new Promise((resolve) => {
      fileStream.on("finish", () => resolve(true));
      fileStream.on("error", (err) => {
        console.error(`[Download] Write error: ${err}`);
        resolve(false);
      });
    });
  } catch (error) {
    console.error(`[Download] Error downloading file:`, error);
    return false;
  }
}

// Export for use in API routes
export { processDownload };
