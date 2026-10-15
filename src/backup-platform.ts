import type { AgentKind, AgentPath, BackupRecord } from "./types";

/** 统一路径分隔符，并按 Windows 路径规则忽略大小写。 */
function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

/** 优先使用备份时的平台信息；旧备份按当前配置路径和标准路径识别。 */
export function backupAgents(
  backup: BackupRecord,
  configuredPaths: AgentPath[],
): AgentKind[] {
  if (backup.agents?.length) return backup.agents;
  const agents = new Set<AgentKind>();
  for (const path of backup.paths.map(normalizePath)) {
    for (const configured of configuredPaths) {
      if (normalizePath(configured.path) === path) agents.add(configured.agent);
    }
    if (/\/\.workbuddy\/(models|mcp)\.json$/.test(path))
      agents.add("workbuddy");
    if (
      /\/\.claude\/settings\.json$|\/\.claude\.json$|\/\.mcp\.json$/.test(path)
    )
      agents.add("claude");
    if (/\/\.codex\/(config\.toml|auth\.json)$/.test(path)) agents.add("codex");
  }
  return [...agents];
}
