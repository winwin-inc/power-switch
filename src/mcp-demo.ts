import type { McpDraft, McpSummary } from "./mcp-api";

const connectors: McpSummary[] = [
  {
    id: "3d921c53-7b74-46b8-a921-661025ac1a87",
    name: "马上赢 X 平台",
    serverId: "msy-x-lightdash",
    url: "https://mcp-x.brandct.com/mcp",
    authMode: "customHeader",
    headerName: "x-api-key",
    hasToken: false,
    builtIn: true,
  },
  {
    id: "8e291422-6e9d-4edf-ae30-83564e6f6a2e",
    name: "马上赢内部 LightDash",
    serverId: "msy-internal-lightdash",
    url: "https://mcp-lightdash.banmahui.cn/mcp",
    authMode: "customHeader",
    headerName: "x-api-key",
    hasToken: false,
    builtIn: true,
  },
];

/** 清空演示自定义连接器与内置令牌，保留固定内置入口。 */
export function resetMcpDemo() {
  for (let index = connectors.length - 1; index >= 0; index--) {
    if (connectors[index].builtIn) connectors[index].hasToken = false;
    else connectors.splice(index, 1);
  }
}

/** Provide a local-only browser preview without sending test requests or writing Agent files. */
export async function demoMcp(
  command: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if (command === "mcp_list") return structuredClone(connectors);
  if (command === "mcp_save") {
    const draft = args.draft as McpDraft;
    const previous = connectors.find((c) => c.id === draft.id);
    const item: McpSummary = {
      id: draft.id || crypto.randomUUID(),
      name: draft.name,
      serverId: draft.serverId,
      url: draft.url,
      authMode: draft.authMode,
      headerName: draft.headerName,
      hasToken:
        draft.authMode !== "none" && Boolean(draft.token || previous?.hasToken),
      builtIn: previous?.builtIn ?? false,
    };
    const index = connectors.findIndex((c) => c.id === item.id);
    if (index >= 0) connectors[index] = item;
    else connectors.push(item);
    return structuredClone(item);
  }
  if (command === "mcp_delete") {
    const index = connectors.findIndex((c) => c.id === args.id);
    if (connectors[index]?.builtIn) throw new Error("内置连接器不能删除");
    if (index >= 0) connectors.splice(index, 1);
    return;
  }
  if (command === "cancel_preview") return;
  throw new Error(
    "浏览器演示不能测试 MCP 连接或写入 Agent 配置，请使用桌面应用。",
  );
}
