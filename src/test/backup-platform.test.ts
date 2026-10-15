import { describe, expect, it } from "vitest";
import { backupAgents } from "../backup-platform";
import type { BackupRecord } from "../types";

const backup: BackupRecord = {
  id: "backup-1",
  title: "应用模型 · 测试",
  createdAt: 1790035200,
  status: "completed",
  paths: [],
};

describe("backup platform detection", () => {
  /** 平台以备份时的记录为准，之后修改配置路径不应改变归属。 */
  it("prefers saved platform metadata over current paths", () => {
    expect(
      backupAgents(
        { ...backup, agents: ["claude"], paths: ["/custom/settings.json"] },
        [{ agent: "workbuddy", path: "/custom/settings.json", exists: true }],
      ),
    ).toEqual(["claude"]);
  });

  /** 旧备份兼容 Mac/Linux 与 Windows 标准路径，多文件只计一次平台。 */
  it.each([
    ["/home/.workbuddy/models.json", "workbuddy"],
    ["/home/.claude/settings.json", "claude"],
    ["/home/.claude.json", "claude"],
    ["/project/.mcp.json", "claude"],
    ["/home/.codex/config.toml", "codex"],
    ["C:\\Users\\test\\.CODEX\\auth.json", "codex"],
  ])("recognizes the legacy path %s", (path, agent) => {
    expect(backupAgents({ ...backup, paths: [path, path] }, [])).toEqual([
      agent,
    ]);
  });

  /** 自定义配置只按完整路径识别，避免将其他平台的同名文件误分类。 */
  it("recognizes configured paths and leaves unknown paths unclassified", () => {
    expect(
      backupAgents(
        { ...backup, agents: [], paths: ["/portable/custom.json"] },
        [{ agent: "workbuddy", path: "/portable/custom.json", exists: false }],
      ),
    ).toEqual(["workbuddy"]);
    expect(
      backupAgents({ ...backup, paths: ["/unknown/settings.json"] }, []),
    ).toEqual([]);
  });
});
