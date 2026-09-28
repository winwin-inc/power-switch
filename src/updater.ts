import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";

/** Query only release metadata through the channel selected in saved settings. */
export async function checkForUpdate(): Promise<{
  version: string;
  notes: string | null;
} | null> {
  return invoke("check_app_update");
}

/** Start the confirmed native download and forward its progress to the sidebar. */
export async function installPendingUpdate(
  version: string,
  onProgress: (percentage: number | null) => void,
): Promise<void> {
  const unlisten = await listen<number | null>(
    "app-update-progress",
    (event) => {
      onProgress(event.payload);
    },
  );
  try {
    await invoke("install_app_update", { version });
  } finally {
    unlisten();
  }
}

/** Restart the app after a successful macOS or Linux update installation. */
export async function restartUpdatedApp(): Promise<void> {
  await relaunch();
}
