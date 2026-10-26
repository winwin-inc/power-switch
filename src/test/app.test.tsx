import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import {
  AgentPicker,
  ApplyReview,
  ModelForm,
  ProtocolMark,
} from "../components";
import {
  newModel,
  type AppData,
  type ApplyPreview,
  type ModelTestResult,
} from "../types";
import { api } from "../api";
import { pickLocalPath } from "../file-picker";

vi.mock("../file-picker", () => ({ pickLocalPath: vi.fn() }));

vi.mock("../api", () => ({
  isDesktop: false,
  api: {
    data: vi.fn(),
    save: vi.fn(),
    testModel: vi.fn(),
    listModels: vi.fn(),
    delete: vi.fn(),
    settings: vi.fn(),
    preview: vi.fn(),
    apply: vi.fn(),
    cancel: vi.fn(),
    restore: vi.fn(),
    deleteBackup: vi.fn(),
    importPreview: vi.fn(),
    importConfirm: vi.fn(),
    share: vi.fn(),
  },
}));
const sample = {
  ...newModel(),
  id: "1",
  name: "我的模型",
  baseUrl: "https://api.example.com/v1",
  modelId: "test-model",
  apiKey: "secret-test-key",
};
const data: AppData = {
  models: [sample],
  settings: {
    theme: "system",
    workbuddyPath: null,
    claudePath: null,
    codexDir: null,
    autoUpdate: true,
    receiveRc: false,
  },
  agents: [],
  dataDir: "/test/app",
  backups: [],
};
const preview: ApplyPreview = {
  token: "preview-1",
  title: "应用模型",
  files: [
    {
      path: "/test/models.json",
      before: "[]",
      after: '{"apiKey":"••••••••"}',
      fingerprint: "hash",
    },
  ],
  notices: ["请手动选择模型"],
};
const successfulTest: ModelTestResult = {
  message: "测试通过：已发送 test 并收到模型回复。",
  elapsedMs: 120,
  verificationToken: "verified-test-ticket",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.data).mockResolvedValue(structuredClone(data));
  vi.mocked(api.cancel).mockResolvedValue();
  vi.mocked(api.testModel).mockReset().mockResolvedValue(successfulTest);
  vi.mocked(api.listModels)
    .mockReset()
    .mockResolvedValue(["test-model", "test-model-new"]);
});
afterEach(() => vi.useRealTimers());

describe("Agent icons", () => {
  it("keeps the compact sidebar identity and brand navigation accessible", async () => {
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "模型库" });
    const footer = container.querySelector(".sidebar-status") as HTMLElement;
    expect(footer).toHaveTextContent("本机存储");
    expect(footer).not.toHaveTextContent("应用配置前自动备份");
    expect(footer).not.toHaveTextContent("power-switch");
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    await userEvent.click(
      screen.getByRole("link", { name: "power-switch，返回模型库" }),
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "模型库",
    );
  });

  it("shows the Codex icon for OpenAI Responses models", () => {
    const { container } = render(
      <ProtocolMark protocol="openai-responses" name="专注代码" />,
    );
    const mark = container.querySelector(".protocol-mark.openai-responses");
    expect(mark).toHaveClass("brand-icon");
    expect(mark?.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("codex.png"),
    );
    expect(mark).not.toHaveTextContent("专");
  });
});

describe("model editing", () => {
  it("offers Responses for Codex while retaining the provider model-list requirement", async () => {
    render(
      <ModelForm
        initial={newModel()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    const protocol = screen.getByRole("combobox", { name: "协议" });
    expect(
      screen.getByRole("option", { name: "OpenAI Responses" }),
    ).toBeEnabled();
    await userEvent.selectOptions(protocol, "openai-responses");
    expect(screen.getByRole("button", { name: "保存模型" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "测试模型" })).toBeDisabled();
  });
  it("opens the animated newcomer guide and leads into New API import", async () => {
    render(<App />);
    await screen.findByText("我的模型");
    const actions = screen
      .getAllByRole("button")
      .map((button) => button.textContent?.trim());
    expect(actions.indexOf("导入链接")).toBeLessThan(
      actions.indexOf("从 New API 添加"),
    );
    const guideButton = screen.getByRole("button", { name: "新手指引" });
    expect(guideButton.closest(".sidebar-utilities")).not.toBeNull();
    await userEvent.click(guideButton);
    expect(
      screen.getByRole("heading", { name: "申请 WorkBuddy 密钥" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /下一步/ }));
    expect(
      screen.getByRole("heading", { name: "在模型库找到它" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /下一步/ }));
    expect(
      screen.getByRole("heading", { name: "应用到 Agent" }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /开始从 New API 添加/ }),
    );
    expect(
      await screen.findByRole("heading", { name: "从 New API 添加模型" }),
    ).toBeInTheDocument();
  });

  it("defaults image input on without changing an explicit saved off value", async () => {
    const props = { onSave: vi.fn(), onCancel: vi.fn(), busy: false };
    const { rerender } = render(<ModelForm initial={newModel()} {...props} />);
    await userEvent.click(screen.getByText("高级设置"));
    expect(screen.getByRole("checkbox", { name: "图像输入" })).toBeChecked();
    rerender(
      <ModelForm
        key="saved"
        initial={{ ...sample, supportsImages: false }}
        {...props}
      />,
    );
    await userEvent.click(screen.getByText("高级设置"));
    expect(
      screen.getByRole("checkbox", { name: "图像输入" }),
    ).not.toBeChecked();
  });
  it.each(["openai-chat", "openai-responses", "anthropic-messages"] as const)(
    "defaults %s to 524288 and high while preserving saved values",
    async (protocol) => {
      const props = { onSave: vi.fn(), onCancel: vi.fn(), busy: false };
      const { rerender } = render(
        <ModelForm initial={{ ...newModel(), protocol }} {...props} />,
      );
      const hint = screen.getByText(/如果你不了解这些参数/);
      expect(hint).toBeVisible();
      expect(hint.closest("details")).toBeNull();
      if (protocol !== "openai-responses")
        await userEvent.click(screen.getByText("高级设置"));
      expect(screen.getByLabelText(/上下文窗口/)).toHaveValue(524_288);
      expect(screen.getByRole("radio", { name: "高" })).toBeChecked();
      rerender(
        <ModelForm
          key="saved-context"
          initial={{ ...sample, contextWindow: 128_000 }}
          {...props}
        />,
      );
      await userEvent.click(screen.getByText("高级设置"));
      expect(screen.getByLabelText(/上下文窗口/)).toHaveValue(128_000);
    },
  );

  it("preserves custom capabilities in copied model drafts", async () => {
    render(
      <ModelForm
        initial={{
          ...sample,
          id: "",
          contextWindow: 262_144,
          reasoningLevels: ["low"],
        }}
        copy
        onSave={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    await userEvent.click(screen.getByText("高级设置"));
    expect(screen.getByLabelText(/上下文窗口/)).toHaveValue(262_144);
    expect(screen.getByRole("radio", { name: "低" })).toBeChecked();
  });
  it("shows five Chinese reasoning levels and defaults new models to high", async () => {
    render(
      <ModelForm
        initial={newModel()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    await userEvent.click(screen.getByText("高级设置"));
    const levels = within(screen.getByRole("radiogroup", { name: "思考强度" }));
    expect(
      levels
        .getAllByRole("radio")
        .map((input) => input.parentElement?.textContent),
    ).toEqual(["低", "中", "高", "超高", "极致"]);
    expect(levels.getByRole("radio", { name: "高" })).toBeChecked();
    expect(
      levels
        .getAllByRole("radio")
        .filter((input) => (input as HTMLInputElement).checked),
    ).toHaveLength(1);
    const independent = newModel();
    independent.reasoningLevels.push("low");
    expect(newModel().reasoningLevels).toEqual(["high"]);
  });

  it.each([
    { reasoningLevels: [] },
    { reasoningLevels: ["none", "minimal", "low"] },
  ])(
    "preserves saved reasoning levels $reasoningLevels and hidden values on save",
    async ({ reasoningLevels }) => {
      const saved = { ...sample, reasoningLevels };
      const save = vi.fn();
      render(
        <ModelForm
          initial={saved}
          onSave={save}
          onCancel={vi.fn()}
          busy={false}
        />,
      );
      await userEvent.click(screen.getByText("高级设置"));
      expect(screen.getByRole("radio", { name: "高" })).not.toBeChecked();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "测试模型" })).toBeEnabled(),
      );
      await userEvent.click(screen.getByRole("button", { name: "测试模型" }));
      await userEvent.click(screen.getByRole("button", { name: "保存模型" }));
      expect(save).toHaveBeenCalledWith(saved, successfulTest);
    },
  );

  it("shows one default for legacy multi-level models and saves only the newly selected level", async () => {
    const saved = { ...sample, reasoningLevels: ["low", "high", "xhigh"] };
    const save = vi.fn();
    render(
      <ModelForm
        initial={saved}
        onSave={save}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    await userEvent.click(screen.getByText("高级设置"));
    const levels = within(screen.getByRole("radiogroup", { name: "思考强度" }));
    expect(levels.getByRole("radio", { name: "高" })).toBeChecked();
    expect(levels.getByRole("radio", { name: "低" })).not.toBeChecked();
    expect(levels.getByRole("radio", { name: "超高" })).not.toBeChecked();
    await userEvent.click(levels.getByRole("radio", { name: "中" }));
    await userEvent.click(levels.getByRole("radio", { name: "中" }));
    expect(levels.getByRole("radio", { name: "中" })).toBeChecked();
    expect(levels.getByRole("radio", { name: "高" })).not.toBeChecked();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "测试模型" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "测试模型" }));
    await userEvent.click(screen.getByRole("button", { name: "保存模型" }));
    expect(save).toHaveBeenCalledWith(
      { ...saved, reasoningLevels: ["medium"] },
      successfulTest,
    );
  });

  it("keeps the shared context default across protocols until manually edited", async () => {
    render(
      <ModelForm
        initial={newModel()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    const protocol = screen.getByRole("combobox", { name: "协议" });
    await userEvent.selectOptions(protocol, "openai-responses");
    const context = screen.getByLabelText(/上下文窗口/);
    expect(context).toHaveValue(524_288);
    await userEvent.selectOptions(protocol, "anthropic-messages");
    expect(context).toHaveValue(524_288);
    fireEvent.change(context, { target: { value: "262144" } });
    await userEvent.selectOptions(protocol, "openai-responses");
    expect(context).toHaveValue(262_144);
    await userEvent.selectOptions(protocol, "openai-chat");
    expect(context).toHaveValue(262_144);
  });

  it("keeps saved context when changing protocols", async () => {
    render(
      <ModelForm
        initial={{ ...sample, contextWindow: 128_000 }}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "协议" }),
      "openai-responses",
    );
    expect(screen.getByLabelText(/上下文窗口/)).toHaveValue(128_000);
  });
  it("masks the key and only saves on submit", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(
      <ModelForm
        initial={sample}
        onSave={save}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getByDisplayValue("secret-test-key")).toHaveAttribute(
      "type",
      "password",
    );
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "保存模型" })).toBeDisabled();
    expect(api.testModel).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "显示密钥" }));
    expect(screen.getByDisplayValue("secret-test-key")).toHaveAttribute(
      "type",
      "text",
    );
    await user.click(screen.getByRole("button", { name: "测试模型" }));
    expect(api.testModel).toHaveBeenCalledWith(sample);
    expect(screen.getByRole("button", { name: "保存模型" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "保存模型" }));
    expect(save).toHaveBeenCalledWith(sample, successfulTest);
  });
  it("does not save when canceling", async () => {
    const cancel = vi.fn();
    const save = vi.fn();
    render(
      <ModelForm
        initial={sample}
        onSave={save}
        onCancel={cancel}
        busy={false}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });
});

describe("model test gating and indicators", () => {
  it("prevents every submit until a successful test and blocks saving after a failed retest", async () => {
    const save = vi.fn();
    const { container } = render(
      <ModelForm
        initial={sample}
        onSave={save}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    fireEvent.submit(container.querySelector("form")!);
    expect(save).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "测试模型" }));
    expect(screen.getByRole("button", { name: "保存模型" })).toBeEnabled();
    vi.mocked(api.testModel).mockRejectedValueOnce(
      "测试未通过：HTTP 401，鉴权失败",
    );
    await userEvent.click(screen.getByRole("button", { name: "测试模型" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 401");
    expect(screen.getByRole("button", { name: "保存模型" })).toBeDisabled();
    fireEvent.submit(container.querySelector("form")!);
    expect(save).not.toHaveBeenCalled();
  });

  it("requires another test after changing any draft configuration", async () => {
    render(
      <ModelForm
        initial={sample}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "测试模型" }));
    await user.type(screen.getByDisplayValue("secret-test-key"), "-changed");
    expect(screen.getByRole("button", { name: "保存模型" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "刷新模型清单" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "模型 ID" }),
      "test-model",
    );
    await user.click(screen.getByRole("button", { name: "测试模型" }));
    expect(api.testModel).toHaveBeenLastCalledWith({
      ...sample,
      apiKey: "secret-test-key-changed",
    });
    expect(screen.getByRole("button", { name: "保存模型" })).toBeEnabled();
    await user.click(screen.getByText("高级设置"));
    await user.click(screen.getByRole("checkbox", { name: "图像输入" }));
    expect(screen.getByRole("button", { name: "保存模型" })).toBeDisabled();
  });

  it("ignores an old response after editing during the request and does not double-send", async () => {
    let resolve!: (result: ModelTestResult) => void;
    vi.mocked(api.testModel).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(
      <ModelForm
        initial={sample}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "测试模型" }));
    expect(screen.getByRole("button", { name: "测试中…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存模型" })).toBeDisabled();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "模型 ID" }),
      "test-model-new",
    );
    await act(async () => {
      resolve(successfulTest);
    });
    expect(screen.getByRole("button", { name: "保存模型" })).toBeDisabled();
    expect(screen.queryByText(/测试通过，耗时/)).not.toBeInTheDocument();
    expect(api.testModel).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "测试模型" }));
    expect(screen.getByRole("button", { name: "保存模型" })).toBeEnabled();
  });

  it("does not let a canceled form response enable saving in a newly opened form", async () => {
    let resolve!: (result: ModelTestResult) => void;
    vi.mocked(api.testModel).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = render(
      <ModelForm
        initial={sample}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "测试模型" }));
    first.unmount();
    render(
      <ModelForm
        initial={sample}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    await act(async () => {
      resolve(successfulTest);
    });
    expect(screen.getByRole("button", { name: "保存模型" })).toBeDisabled();
    expect(screen.queryByText(/测试通过，耗时/)).not.toBeInTheDocument();
  });

  it("shows no initial marker, then green or red only after explicit card tests", async () => {
    render(<App />);
    await screen.findByText("我的模型");
    expect(
      screen.queryByRole("img", { name: /模型测试/ }),
    ).not.toBeInTheDocument();
    expect(api.testModel).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "测试模型 我的模型" }),
    );
    expect(
      await screen.findByRole("img", { name: "模型测试通过" }),
    ).toHaveClass("passed");
    expect(screen.getByRole("img", { name: "模型测试通过" })).toHaveAttribute(
      "title",
      "测试通过，耗时0.12 秒",
    );
    vi.mocked(api.testModel).mockRejectedValueOnce("测试未通过：请求超时");
    await userEvent.click(
      screen.getByRole("button", { name: "测试模型 我的模型" }),
    );
    expect(
      await screen.findByRole("img", { name: "模型测试未通过" }),
    ).toHaveClass("failed");
    expect(
      screen.queryByRole("img", { name: "模型测试通过" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("请求超时");
    expect(api.save).not.toHaveBeenCalled();
    expect(api.apply).not.toHaveBeenCalled();
  });

  it("retains a saved test while a copied model loads its catalog and needs its own test", async () => {
    const copy = { ...sample, id: "", name: "我的模型 · 副本" };
    vi.mocked(api.save)
      .mockResolvedValueOnce(sample)
      .mockResolvedValueOnce({ ...copy, id: "2" });
    render(<App />);
    await screen.findByText("我的模型");
    await userEvent.click(
      screen.getByRole("button", { name: "编辑 我的模型" }),
    );
    expect(screen.getByRole("button", { name: "保存模型" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "测试模型" }));
    await userEvent.click(screen.getByRole("button", { name: "保存模型" }));
    expect(
      await screen.findByRole("img", { name: "模型测试通过" }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "更多操作 我的模型" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "复制 我的模型" }),
    );
    expect(screen.getByRole("button", { name: "保存模型" })).toBeDisabled();
    expect(api.testModel).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("option", { name: "test-model" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "测试模型" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "测试模型" }));
    expect(api.testModel).toHaveBeenLastCalledWith(copy);
    expect(screen.getByRole("button", { name: "保存模型" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "保存模型" }));
    expect(api.save).toHaveBeenLastCalledWith(copy, "verified-test-ticket");
  });

  it("ignores an earlier card request after saving and beginning a newer test", async () => {
    let rejectOld!: (reason: string) => void;
    let resolveNew!: (result: ModelTestResult) => void;
    vi.mocked(api.testModel)
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
      )
      .mockResolvedValueOnce(successfulTest)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveNew = resolve;
        }),
      );
    vi.mocked(api.save).mockResolvedValue(sample);
    render(<App />);
    await screen.findByText("我的模型");
    await userEvent.click(
      screen.getByRole("button", { name: "测试模型 我的模型" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "编辑 我的模型" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "测试模型" }));
    await userEvent.click(screen.getByRole("button", { name: "保存模型" }));
    await screen.findByRole("img", { name: "模型测试通过" });
    await userEvent.click(
      screen.getByRole("button", { name: "测试模型 我的模型" }),
    );
    await act(async () => {
      rejectOld("旧请求失败");
    });
    expect(
      screen.queryByRole("img", { name: "模型测试未通过" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "测试模型 我的模型" }),
    ).toBeDisabled();
    await act(async () => {
      resolveNew(successfulTest);
    });
    expect(
      screen.getByRole("img", { name: "模型测试通过" }),
    ).toBeInTheDocument();
  });
});

describe("temporary model test feedback", () => {
  it("hides success after exactly five seconds or manual dismissal without relocking save", async () => {
    vi.useFakeTimers();
    render(
      <ModelForm
        initial={sample}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "测试模型" }));
    });
    expect(screen.getByText("测试通过，耗时0.12 秒")).toBeInTheDocument();
    expect(
      screen.queryByText(/已发送 test 并收到模型回复/),
    ).not.toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(4999);
    });
    expect(screen.getByText("测试通过，耗时0.12 秒")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("测试通过，耗时0.12 秒")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存模型" })).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "测试模型" }));
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭测试提示" }));
    expect(screen.queryByText("测试通过，耗时0.12 秒")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存模型" })).toBeEnabled();
  });

  it("expires card results, restarts the deadline on retest, and retains verification dots", async () => {
    vi.useFakeTimers();
    vi.mocked(api.testModel).mockRejectedValueOnce("测试未通过：HTTP 401");
    render(<App />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "测试模型 我的模型" }),
      );
    });
    expect(screen.getByText("测试未通过：HTTP 401")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText("测试未通过：HTTP 401")).not.toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "模型测试未通过" }),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "测试模型 我的模型" }),
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "测试模型 我的模型" }),
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(4999);
    });
    expect(screen.getByText("测试通过，耗时0.12 秒")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("测试通过，耗时0.12 秒")).not.toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "模型测试通过" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: /模型库/ }));
    expect(screen.queryByText("测试通过，耗时0.12 秒")).not.toBeInTheDocument();
  });
});

describe("settings and backup controls", () => {
  /** 验证单平台、多平台、历史备份的筛选，并确保不沿用模型库筛选。 */
  it("filters backups by platform independently of the model library", async () => {
    const common = { createdAt: 1790035200, status: "completed" };
    vi.mocked(api.data).mockResolvedValue({
      ...data,
      backups: [
        {
          ...common,
          id: "wb",
          title: "WorkBuddy 备份",
          paths: ["/custom/wb.json"],
          agents: ["workbuddy"],
        },
        {
          ...common,
          id: "claude",
          title: "Claude 备份",
          paths: ["/custom/claude.json"],
          agents: ["claude"],
        },
        {
          ...common,
          id: "shared",
          title: "联合备份",
          paths: ["/custom/a", "/custom/b"],
          agents: ["workbuddy", "codex"],
        },
        {
          ...common,
          id: "legacy",
          title: "历史备份",
          paths: ["/home/.codex/auth.json", "/home/.codex/config.toml"],
        },
        {
          ...common,
          id: "unknown",
          title: "未知备份",
          paths: ["/old/custom.json"],
        },
      ],
    });
    render(<App />);
    await screen.findByText("我的模型");
    await userEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    await userEvent.click(screen.getByRole("button", { name: "模型配置备份" }));
    const all = screen.getByRole("button", { name: /^全部/ });
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(all).toHaveTextContent("5");
    expect(screen.getAllByRole("article")).toHaveLength(5);

    await userEvent.click(screen.getByRole("button", { name: "WorkBuddy" }));
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByText("WorkBuddy 备份")).toBeVisible();
    expect(screen.getByText("联合备份")).toBeVisible();
    expect(screen.queryByText("Claude 备份")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByText("联合备份")).toBeVisible();
    expect(screen.getByText("历史备份")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText("Claude 备份")).toBeVisible();
    await userEvent.click(all);
    expect(screen.getAllByRole("article")).toHaveLength(5);
  });

  /** 某平台没有备份时显示对应空态，允许随时切回全部。 */
  it("shows a platform-specific empty state", async () => {
    render(<App />);
    await screen.findByText("我的模型");
    await userEvent.click(screen.getByRole("button", { name: "模型配置备份" }));
    await userEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(
      screen.getByRole("heading", { name: "还没有 Codex 的模型配置备份" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "清空备份" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /^全部/ }));
    expect(
      screen.getByRole("heading", { name: "还没有模型配置备份" }),
    ).toBeVisible();
  });

  /** Verify that every available module heading contains only its title. */
  it("shows module headings without a trailing dot", async () => {
    render(<App />);
    await screen.findByText("我的模型");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      /^模型库$/,
    );

    await userEvent.click(screen.getByRole("button", { name: "模型配置备份" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      /^模型配置备份$/,
    );

    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      /^设置$/,
    );
  });

  it("shows model deletion in the fixed global tip", async () => {
    vi.mocked(api.delete).mockResolvedValue();
    render(<App />);
    await screen.findByText("我的模型");
    await userEvent.click(
      screen.getByRole("button", { name: "更多操作 我的模型" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "删除 我的模型" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("模型已从模型库删除。");
    expect(notice.parentElement).toHaveClass("app-shell");
    expect(notice.closest(".page-content")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps the SKILL sidebar entry unavailable", async () => {
    render(<App />);
    await screen.findByText("我的模型");
    const skills = screen.getByRole("button", { name: /SKILL 技能/ });
    expect(skills).toBeDisabled();
    expect(skills).toHaveTextContent("待开放");
    expect(
      screen.getByRole("heading", { name: /^模型库/ }),
    ).toBeInTheDocument();
  });

  it("keeps native selections in the draft until saving and preserves them on cancel", async () => {
    vi.mocked(api.data).mockResolvedValue({
      ...data,
      agents: [
        {
          agent: "workbuddy",
          path: "/home/.workbuddy/models.json",
          exists: true,
        },
        { agent: "claude", path: "/home/.claude/settings.json", exists: true },
        { agent: "codex", path: "/home/.codex/config.toml", exists: true },
      ],
    });
    vi.mocked(pickLocalPath)
      .mockResolvedValueOnce("/portable")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("/chosen/custom.json")
      .mockResolvedValueOnce("C:\\portable\\codex");
    vi.mocked(api.settings).mockResolvedValue();
    render(<App />);
    await screen.findByText("我的模型");
    await userEvent.click(screen.getByRole("button", { name: /设置/ }));
    await userEvent.click(
      screen.getByRole("button", { name: "选择 WorkBuddy 配置目录" }),
    );
    expect(
      screen.getByRole("textbox", { name: "WorkBuddy 配置路径" }),
    ).toHaveValue("/portable/models.json");
    await userEvent.click(
      screen.getByRole("button", { name: "选择 WorkBuddy 配置文件" }),
    );
    expect(
      screen.getByRole("textbox", { name: "WorkBuddy 配置路径" }),
    ).toHaveValue("/portable/models.json");
    await userEvent.click(
      screen.getByRole("button", { name: "选择 Claude Code 配置文件" }),
    );
    expect(
      screen.getByRole("textbox", { name: "Codex 配置路径" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /选择 Codex.*配置目录/ }),
    ).toBeEnabled();
    await userEvent.click(
      screen.getByRole("button", { name: /选择 Codex.*配置目录/ }),
    );
    expect(screen.getByRole("textbox", { name: "Codex 配置路径" })).toHaveValue(
      "C:\\portable\\codex",
    );
    expect(api.settings).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(api.settings).toHaveBeenCalledWith({
      ...data.settings,
      workbuddyPath: "/portable/models.json",
      claudePath: "/chosen/custom.json",
      codexDir: "C:\\portable\\codex",
    });
    expect(api.apply).not.toHaveBeenCalled();
  });

  it("only deletes the selected backup after the second confirmation", async () => {
    vi.mocked(api.data).mockResolvedValue({
      ...data,
      backups: [
        {
          id: "backup-1",
          title: "测试备份",
          createdAt: 1790035200,
          status: "complete",
          paths: ["/test/models.json"],
        },
      ],
    });
    vi.mocked(api.deleteBackup).mockResolvedValue();
    render(<App />);
    await screen.findByText("我的模型");
    await userEvent.click(screen.getByRole("button", { name: /模型配置备份/ }));
    await userEvent.click(
      screen.getByRole("button", { name: "删除备份 测试备份" }),
    );
    expect(api.deleteBackup).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(api.deleteBackup).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "删除备份 测试备份" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认删除备份" }));
    expect(api.deleteBackup).toHaveBeenCalledWith("backup-1");
    expect(api.restore).not.toHaveBeenCalled();
    expect(api.apply).not.toHaveBeenCalled();
  });
});

describe("Claude 1M apply option", () => {
  it.each([
    ["auto", true],
    ["auto-v", true],
    ["fast", true],
    ["glm-5.2", true],
    ["glm-5.3", true],
    ["glm-5.3-flash", true],
    ["MiniMax-M3", true],
    ["MiniMax-M3.1-Flash-Preview", true],
    ["MiniMax-M2.7-highspeed", false],
    ["k3", false],
    ["future-model", true],
    ["k3-preview", true],
    ["K3", true],
  ])("defaults %s to %s", (modelId, enabled) => {
    render(
      <AgentPicker
        model={{ ...sample, protocol: "anthropic-messages", modelId }}
        onPreview={vi.fn()}
        busy={false}
      />,
    );
    const option = screen.getByRole("checkbox", { name: /是否 1M模型/ });
    expect(option).toBeEnabled();
    if (enabled) expect(option).toBeChecked();
    else expect(option).not.toBeChecked();
  });

  it.each(["MiniMax-M2.7-highspeed", "k3", "glm-5.3"])(
    "passes a manual override for %s and resets it on reopening",
    async (modelId) => {
      const next = vi.fn();
      const initial = {
        ...sample,
        protocol: "anthropic-messages" as const,
        modelId,
      };
      const { unmount } = render(
        <AgentPicker model={initial} onPreview={next} busy={false} />,
      );
      const option = screen.getByRole("checkbox", { name: /是否 1M模型/ });
      const enabled = (option as HTMLInputElement).checked;
      await userEvent.click(option);
      await userEvent.click(screen.getByRole("button", { name: "预览变更" }));
      expect(next).toHaveBeenCalledWith(["claude"], false, !enabled);
      expect(initial.modelId).toBe(modelId);
      unmount();
      render(<AgentPicker model={initial} onPreview={next} busy={false} />);
      expect(
        screen.getByRole("checkbox", { name: /是否 1M模型/ }),
      ).toHaveProperty("checked", enabled);
    },
  );

  it("disables the option while Claude is deselected or a preview is loading", async () => {
    const props = {
      model: { ...sample, protocol: "anthropic-messages" as const },
      onPreview: vi.fn(),
    };
    const { rerender } = render(<AgentPicker {...props} busy={false} />);
    const claude = screen.getByRole("checkbox", { name: /Claude Code/ });
    const option = screen.getByRole("checkbox", { name: /是否 1M模型/ });
    await userEvent.click(claude);
    expect(option).toBeDisabled();
    expect(screen.getByRole("button", { name: "预览变更" })).toBeDisabled();
    await userEvent.click(claude);
    expect(option).toBeEnabled();
    rerender(<AgentPicker {...props} busy={true} />);
    expect(option).toBeDisabled();
  });

  it.each(["openai-chat", "openai-responses"] as const)(
    "hides the option for %s",
    (protocol) => {
      render(
        <AgentPicker
          model={{ ...sample, protocol }}
          onPreview={vi.fn()}
          busy={false}
        />,
      );
      expect(
        screen.queryByRole("checkbox", { name: /是否 1M模型/ }),
      ).toBeNull();
    },
  );

  it("forwards the current selection through App without saving or testing the model", async () => {
    vi.mocked(api.data).mockResolvedValue({
      ...data,
      models: [{ ...sample, protocol: "anthropic-messages" }],
    });
    vi.mocked(api.preview).mockResolvedValue(preview);
    render(<App />);
    await screen.findByText("我的模型");
    await userEvent.click(screen.getByRole("button", { name: "应用到 Agent" }));
    await userEvent.click(
      screen.getByRole("checkbox", { name: /是否 1M模型/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
    await userEvent.click(screen.getByRole("button", { name: "应用到 Agent" }));
    expect(screen.getByRole("checkbox", { name: /是否 1M模型/ })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "预览变更" }));
    expect(api.preview).toHaveBeenLastCalledWith("1", ["claude"], false, true);
    await screen.findByRole("button", { name: "确认覆盖应用" });
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    await userEvent.click(screen.getByRole("button", { name: "应用到 Agent" }));
    await userEvent.click(
      screen.getByRole("checkbox", { name: /是否 1M模型/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "预览变更" }));
    expect(api.preview).toHaveBeenLastCalledWith("1", ["claude"], false, false);
    expect(api.save).not.toHaveBeenCalled();
    expect(api.testModel).not.toHaveBeenCalled();
    expect(api.apply).not.toHaveBeenCalled();
  });
});

describe("confirmation boundary", () => {
  it("disables incompatible Agent checkboxes", async () => {
    const next = vi.fn();
    render(<AgentPicker model={sample} onPreview={next} busy={false} />);
    expect(
      screen.getByRole("checkbox", { name: /Claude Code/ }),
    ).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Codex/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "预览变更" }));
    expect(
      screen.getByRole("checkbox", {
        name: /写入后打开 WorkBuddy 新建任务页/,
      }),
    ).toBeChecked();
    expect(next).toHaveBeenCalledWith(["workbuddy"], true, undefined);
  });
  it("allows Codex only for its native Responses protocol", async () => {
    const next = vi.fn();
    render(
      <AgentPicker
        model={{ ...sample, protocol: "openai-responses" }}
        onPreview={next}
        busy={false}
      />,
    );
    const codex = screen.getByRole("checkbox", { name: /Codex/ });
    expect(codex).toBeEnabled();
    expect(codex).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "预览变更" }));
    expect(next).toHaveBeenCalledWith(["codex"], false, undefined);
  });
  it("allows opting out and resets the default after reselecting WorkBuddy", async () => {
    const next = vi.fn();
    render(<AgentPicker model={sample} onPreview={next} busy={false} />);
    const workbuddy = screen.getByRole("checkbox", {
      name: /^WorkBuddy 加入模型列表/,
    });
    const autoSelect = screen.getByRole("checkbox", {
      name: /写入后打开 WorkBuddy 新建任务页/,
    });
    await userEvent.click(autoSelect);
    await userEvent.click(screen.getByRole("button", { name: "预览变更" }));
    expect(next).toHaveBeenLastCalledWith(["workbuddy"], false, undefined);
    await userEvent.click(workbuddy);
    expect(autoSelect).toBeDisabled();
    expect(autoSelect).not.toBeChecked();
    await userEvent.click(workbuddy);
    expect(autoSelect).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "预览变更" }));
    expect(next).toHaveBeenLastCalledWith(["workbuddy"], true, undefined);
  });
  it("shows the WorkBuddy post-write action in the second confirmation", () => {
    render(
      <ApplyReview
        preview={{
          ...preview,
          notices: [
            "配置成功写入后，将唤起 WorkBuddy 新建任务页并预选该模型。",
          ],
        }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getByText(/配置成功写入后，将唤起 WorkBuddy/)).toBeVisible();
  });
  it("requires the explicit second confirmation", async () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    render(
      <ApplyReview
        preview={preview}
        onConfirm={confirm}
        onCancel={cancel}
        busy={false}
      />,
    );
    expect(confirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "确认覆盖应用" }));
    expect(confirm).toHaveBeenCalledOnce();
  });
  it("never writes while opening and canceling a preview", async () => {
    vi.mocked(api.preview).mockResolvedValue(preview);
    render(<App />);
    await screen.findByText("我的模型");
    await userEvent.click(screen.getByRole("button", { name: "应用到 Agent" }));
    await userEvent.click(screen.getByRole("button", { name: "预览变更" }));
    await screen.findByRole("button", { name: "确认覆盖应用" });
    expect(api.apply).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(api.cancel).toHaveBeenCalledWith("preview-1");
    expect(api.apply).not.toHaveBeenCalled();
  });
  it("applies a saved Responses model to Codex without another network test", async () => {
    vi.mocked(api.data).mockResolvedValue({
      ...data,
      models: [
        { ...sample, protocol: "openai-responses", contextWindow: 128000 },
      ],
    });
    vi.mocked(api.preview).mockResolvedValue(preview);
    vi.mocked(api.apply).mockResolvedValue({
      backupId: "backup-1",
      paths: [],
      message: "已应用",
    });
    render(<App />);
    await screen.findByText("我的模型");
    await userEvent.click(screen.getByRole("button", { name: "应用到 Agent" }));
    await userEvent.click(screen.getByRole("button", { name: "预览变更" }));
    expect(api.preview).toHaveBeenCalledWith("1", ["codex"], false, undefined);
    await userEvent.click(screen.getByRole("button", { name: "确认覆盖应用" }));
    await screen.findByText("已应用");
    expect(api.testModel).not.toHaveBeenCalled();
  });
});

describe("library and imports", () => {
  it("enables the Codex filter", async () => {
    render(<App />);
    await screen.findByText("我的模型");
    const codex = screen.getByRole("button", { name: "Codex" });
    expect(codex).toBeEnabled();
    await userEvent.click(codex);
    expect(screen.getByText("没有找到匹配的模型")).toBeInTheDocument();
  });
  it("shows which imported rows failed while keeping successful rows", async () => {
    vi.mocked(api.importPreview).mockResolvedValue({
      token: "import-1",
      rows: [
        {
          index: 0,
          name: "成功模型",
          protocol: "openai-chat",
          baseUrl: "https://api.example.com/v1",
          modelId: "ok",
          hasApiKey: true,
          duplicate: false,
        },
        {
          index: 1,
          name: "失败模型",
          protocol: "openai-responses",
          baseUrl: "https://api.example.com/v1",
          modelId: "bad",
          hasApiKey: true,
          duplicate: false,
        },
      ],
    });
    vi.mocked(api.importConfirm).mockResolvedValue({
      savedCount: 1,
      failures: [{ index: 1, message: "测试未通过" }],
    });
    render(<App />);
    await screen.findByText("我的模型");
    await userEvent.click(screen.getByRole("button", { name: "导入链接" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "模型链接" }),
      "power-switch://model/import?v=1&data=test",
    );
    await userEvent.click(screen.getByRole("button", { name: "预览导入" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "确认导入" }),
    );
    expect(
      await screen.findByText("已保存 1 个模型，尚未应用到 Agent。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "第 2 项未保存：测试未通过",
    );
  });
  it("filters locally and hides list credentials", async () => {
    render(<App />);
    await screen.findByText("我的模型");
    expect(screen.queryByText("secret-test-key")).not.toBeInTheDocument();
    await userEvent.type(
      screen.getByRole("textbox", { name: "搜索模型" }),
      "absent",
    );
    expect(screen.getByText("没有找到匹配的模型")).toBeInTheDocument();
  });
  it("previews links without importing or applying automatically", async () => {
    vi.mocked(api.importPreview).mockResolvedValue({
      token: "import-1",
      rows: [
        {
          index: 0,
          name: "导入样例",
          modelId: "new",
          protocol: "openai-chat",
          baseUrl: "https://example.com",
          hasApiKey: true,
          duplicate: true,
        },
      ],
    });
    render(<App />);
    await screen.findByText("我的模型");
    await userEvent.click(screen.getByRole("button", { name: "导入链接" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "模型链接" }),
      "power-switch://model/import?v=1&data=test",
    );
    await userEvent.click(screen.getByRole("button", { name: "预览导入" }));
    await screen.findByText("导入样例");
    expect(api.importConfirm).not.toHaveBeenCalled();
    expect(api.apply).not.toHaveBeenCalled();
    expect(
      screen.getByRole("checkbox", { name: "更新重复项" }),
    ).not.toBeChecked();
  });
  it("shares without a key unless explicitly requested", async () => {
    vi.mocked(api.share).mockResolvedValue(
      "power-switch://model/import?v=1&data=safe",
    );
    render(<App />);
    await screen.findByText("我的模型");
    await userEvent.click(
      screen.getByRole("button", { name: "更多操作 我的模型" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "分享 我的模型" }),
    );
    await waitFor(() => expect(api.share).toHaveBeenCalledWith("1", false));
    await userEvent.click(
      screen.getByRole("checkbox", { name: /包含 API Key/ }),
    );
    await waitFor(() => expect(api.share).toHaveBeenCalledWith("1", true));
  });
});

describe("provider model selector", () => {
  it("places a required API Key before model ID and blocks empty-key fetches in both forms", async () => {
    for (const initial of [newModel(), { ...sample, apiKey: "" }]) {
      const { container, unmount } = render(
        <ModelForm
          initial={initial}
          onSave={vi.fn()}
          onCancel={vi.fn()}
          busy={false}
        />,
      );
      const key = screen.getByLabelText(/API Key/) as HTMLInputElement;
      const select = screen.getByRole("combobox", { name: "模型 ID" });
      expect(key.required).toBe(true);
      expect(
        key.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        screen.getByRole("button", {
          name: initial.id ? "刷新模型清单" : "获取模型清单",
        }),
      ).toBeDisabled();
      expect(screen.getByRole("button", { name: "测试模型" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "保存模型" })).toBeDisabled();
      expect(container).toHaveTextContent("请先填写 API Key");
      unmount();
    }
    expect(api.listModels).not.toHaveBeenCalled();
  });

  it("uses a platform name and only accepts an ID returned by the provider when adding", async () => {
    vi.mocked(api.listModels).mockResolvedValueOnce([
      "platform-model",
      "platform-model-mini",
    ]);
    const save = vi.fn();
    const user = userEvent.setup();
    render(
      <ModelForm
        initial={newModel()}
        onSave={save}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getByRole("textbox", { name: "平台名称" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "模型 ID" })).toBeNull();
    const select = screen.getByRole("combobox", { name: "模型 ID" });
    expect(select).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "平台名称" }),
      "winwin",
    );
    await user.type(
      screen.getByRole("textbox", { name: /API 地址/ }),
      "https://api.example.com/v1",
    );
    await user.type(screen.getByLabelText(/API Key/), "test-key");
    await user.click(screen.getByRole("button", { name: "获取模型清单" }));
    expect(
      await screen.findByRole("option", { name: "platform-model" }),
    ).toBeInTheDocument();
    expect(api.listModels).toHaveBeenCalledWith({
      protocol: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
    });
    await user.selectOptions(select, "platform-model");
    await user.click(screen.getByRole("button", { name: "测试模型" }));
    const saved = {
      ...newModel(),
      name: "winwin · platform-model",
      baseUrl: "https://api.example.com/v1",
      modelId: "platform-model",
      apiKey: "test-key",
    };
    expect(api.testModel).toHaveBeenCalledWith(saved);
    await user.click(screen.getByRole("button", { name: "保存模型" }));
    expect(save).toHaveBeenCalledWith(saved, successfulTest);
  });

  it("loads platform IDs and requires selecting an available model", async () => {
    vi.mocked(api.listModels).mockResolvedValueOnce(["platform-model"]);
    render(
      <ModelForm
        initial={sample}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    const select = screen.getByRole("combobox", { name: "模型 ID" });
    expect(select).toBeDisabled();
    await screen.findByRole("option", { name: "platform-model" });
    expect(api.listModels).toHaveBeenCalledWith({
      protocol: sample.protocol,
      baseUrl: sample.baseUrl,
      apiKey: sample.apiKey,
    });
    expect(screen.getByRole("button", { name: "测试模型" })).toBeDisabled();
    await userEvent.selectOptions(select, "platform-model");
    await userEvent.click(screen.getByRole("button", { name: "测试模型" }));
    expect(api.testModel).toHaveBeenCalledWith({
      ...sample,
      modelId: "platform-model",
    });
    expect(screen.getByRole("button", { name: "保存模型" })).toBeEnabled();
  });

  it("keeps selection unavailable on failure and supports explicit retry", async () => {
    vi.mocked(api.listModels).mockRejectedValueOnce(
      "获取模型清单失败（HTTP 401）",
    );
    render(
      <ModelForm
        initial={sample}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    await screen.findByText("获取模型清单失败（HTTP 401）");
    expect(screen.getByRole("combobox", { name: "模型 ID" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "测试模型" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "刷新模型清单" }));
    expect(screen.getByRole("combobox", { name: "模型 ID" })).toHaveValue(
      "test-model",
    );
  });

  it("discards a stale catalog after connection edits", async () => {
    let resolve!: (ids: string[]) => void;
    vi.mocked(api.listModels).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(
      <ModelForm
        initial={sample}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    await userEvent.type(screen.getByDisplayValue("secret-test-key"), "-new");
    await act(async () => resolve(["stale-model"]));
    expect(
      screen.queryByRole("option", { name: "stale-model" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "测试模型" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "刷新模型清单" }));
    expect(api.listModels).toHaveBeenLastCalledWith({
      protocol: sample.protocol,
      baseUrl: sample.baseUrl,
      apiKey: "secret-test-key-new",
    });
    expect(screen.getByRole("combobox", { name: "模型 ID" })).toHaveValue("");
  });
});

describe("simplified library navigation", () => {
  it("clears both the search and Agent filter from the no-results state", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("我的模型");
    await user.type(
      screen.getByRole("textbox", { name: "搜索模型" }),
      "absent",
    );
    await user.click(screen.getByRole("button", { name: "Codex" }));
    expect(
      screen.getByRole("heading", { name: "没有找到匹配的模型" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByRole("textbox", { name: "搜索模型" })).toHaveValue("");
    expect(screen.getByRole("button", { name: /全部模型/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("我的模型")).toBeInTheDocument();
  });

  it("shows a durable load error and retries without confusing it with an empty library", async () => {
    let completeRetry!: (value: AppData) => void;
    vi.mocked(api.data)
      .mockRejectedValueOnce(new Error("读取失败"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeRetry = resolve;
          }),
      );
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("读取失败");
    expect(screen.queryByText("从你的第一个模型开始")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新加载" }));
    expect(screen.getByRole("status")).toHaveTextContent("正在打开模型库");
    expect(
      screen.queryByRole("button", { name: "重新加载" }),
    ).not.toBeInTheDocument();
    await act(async () => completeRetry(structuredClone(data)));
    expect(screen.getByText("我的模型")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.data).toHaveBeenCalledTimes(2);
  });

  it("keeps destructive actions in More and returns focus after canceling confirmation", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("我的模型");
    const trigger = screen.getByRole("button", { name: "更多操作 我的模型" });
    expect(
      screen.queryByRole("button", { name: "删除 我的模型" }),
    ).not.toBeInTheDocument();
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "删除 我的模型" }));
    expect(
      screen.getByRole("dialog", { name: "删除模型" }),
    ).toBeInTheDocument();
    expect(api.delete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(api.delete).not.toHaveBeenCalled();
  });
});
