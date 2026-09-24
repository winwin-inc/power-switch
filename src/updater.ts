import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

let pendingUpdate: Update | null = null;

/** Query the configured signed update manifest and retain the verified update for installation. */
export async function checkForUpdate(): Promise<{
  version: string;
  notes: string | null;
} | null> {
  pendingUpdate = await check({ timeout: 30_000 });
  if (!pendingUpdate) return null;
  return { version: pendingUpdate.version, notes: pendingUpdate.body ?? null };
}

/** Download and install the update while reporting an approximate percentage to the sidebar. */
export async function installPendingUpdate(
  onProgress: (percentage: number | null) => void,
): Promise<void> {
  if (!pendingUpdate) throw new Error("请先检查是否有可用更新");
  let downloaded = 0;
  let contentLength = 0;
  await pendingUpdate.downloadAndInstall((event) => {
    if (event.event === "Started") {
      contentLength = event.data.contentLength ?? 0;
      onProgress(contentLength ? 0 : null);
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress(
        contentLength
          ? Math.min(100, Math.floor((downloaded / contentLength) * 100))
          : null,
      );
    }
  });
  pendingUpdate = null;
}

/** Restart the app after a successful macOS or Linux update installation. */
export async function restartUpdatedApp(): Promise<void> {
  await relaunch();
}
