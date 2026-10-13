import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "./api";
import type { ApplyPreview, ApplyResult } from "./types";

export const mcpPatUrl =
  "https://x.brandct.com/generalSettings/personalAccessTokens";
export const internalMcpPatUrl =
  "https://lightdash.banmahui.cn/generalSettings/personalAccessTokens";

export type McpAuthMode = "none" | "bearer" | "customHeader";
export type McpTarget =
  | "workbuddy"
  | "workbuddyProject"
  | "codex"
  | "codexProject"
  | "claudeUser"
  | "claudeProject";

export interface McpDraft {
  id: string;
  name: string;
  serverId: string;
  url: string;
  authMode: McpAuthMode;
  headerName: string;
  token: string;
}

export interface McpSummary extends Omit<McpDraft, "token"> {
  hasToken: boolean;
  builtIn: boolean;
}

export interface McpTestResult {
  toolCount: number;
}

/** Call native MCP commands and keep browser preview data separate from disk state. */
async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isDesktop) return invoke<T>(command, args);
  const { demoMcp } = await import("./mcp-demo");
  return demoMcp(command, args) as Promise<T>;
}

export const mcpApi = {
  /** Open a built-in PAT application URL through the scoped native system-browser command. */
  openPatPage: (url = mcpPatUrl) =>
    invoke<void>("plugin:opener|open_url", { url }),
  /** List metadata without exposing saved tokens. */
  list: () => call<McpSummary[]>("mcp_list"),
  /** Save one fixed endpoint and optional credential. */
  save: (draft: McpDraft) => call<McpSummary>("mcp_save", { draft }),
  /** Delete only the application library record. */
  delete: (id: string) => call<void>("mcp_delete", { id }),
  /** Initialize the MCP connection and read its tool list. */
  test: (draft: McpDraft) => call<McpTestResult>("mcp_test", { draft }),
  /** Review native files before backing them up and writing them. */
  preview: (id: string, targets: McpTarget[], projectDir: string | null) =>
    call<ApplyPreview>("mcp_preview_apply", { id, targets, projectDir }),
  /** Commit a reviewed transaction. */
  apply: (token: string) => call<ApplyResult>("apply_preview", { token }),
  /** Drop a canceled secret-bearing preview. */
  cancel: (token: string) => call<void>("cancel_preview", { token }),
};
