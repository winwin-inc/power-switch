import { invoke } from "@tauri-apps/api/core";
import packageJson from "../package.json";

export const repositoryUrl = "https://github.com/winwin-inc/power-switch";
export type AboutLink = "github" | "changelog";

/** Build the release page from the installed app version, including RC suffixes. */
export function releaseNotesUrl(version = packageJson.version): string {
  return `${repositoryUrl}/releases/tag/v${version}`;
}

/** Resolve the two project links shown in About without accepting arbitrary destinations. */
export function aboutLinkUrl(link: AboutLink): string {
  return link === "github" ? repositoryUrl : releaseNotesUrl();
}

/** Open a project link in the system browser through the scoped native opener. */
export function openAboutLink(link: AboutLink): Promise<void> {
  return invoke("plugin:opener|open_url", { url: aboutLinkUrl(link) });
}
