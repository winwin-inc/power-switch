import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Modal, ModalFooter, ModelForm } from "../components";
import { api } from "../api";
import { newModel } from "../types";

vi.mock("../api", () => ({
  api: { listModels: vi.fn(), testModel: vi.fn() },
}));

describe("modal footer layout", () => {
  /** Verify portal-based model actions still submit their owning form once. */
  it("submits ModelForm from the fixed footer portal exactly once", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    vi.mocked(api.listModels).mockResolvedValue(["model-1"]);
    vi.mocked(api.testModel).mockResolvedValue({
      message: "测试通过",
      elapsedMs: 50,
      verificationToken: "verified",
    });
    render(
      <Modal title="编辑模型" description="说明" onClose={vi.fn()}>
        <ModelForm
          initial={{
            ...newModel(),
            id: "model-id",
            name: "Existing model",
            baseUrl: "https://api.example.com/v1",
            modelId: "model-1",
            apiKey: "sk-example",
          }}
          onSave={onSave}
          onCancel={vi.fn()}
          busy={false}
        />
      </Modal>,
    );

    const testButton = await screen.findByRole("button", { name: "测试模型" });
    await user.click(testButton);
    const saveButton = await screen.findByRole("button", { name: "保存模型" });
    expect(saveButton.closest("form")).toBeNull();
    expect(saveButton).toHaveAttribute(
      "form",
      document.querySelector(".model-form")?.id,
    );
    await user.click(saveButton);
    expect(onSave).toHaveBeenCalledOnce();
  });

  /** Verify fixed actions remain a sibling of, rather than part of, the scroll area. */
  it("keeps footer actions outside the scrollable body and submits the associated form", () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <Modal title="标题" description="说明" onClose={vi.fn()}>
        <form id="modal-test-form" onSubmit={onSubmit}>
          <label>
            必填项
            <input required aria-label="必填项" defaultValue="有效值" />
          </label>
        </form>
        <ModalFooter>
          <button type="submit" form="modal-test-form">
            保存
          </button>
        </ModalFooter>
      </Modal>,
    );

    const body = document.querySelector(".modal-body");
    const footer = document.querySelector(".modal-footer-slot");
    const save = screen.getByRole("button", { name: "保存" });

    expect(body?.contains(save)).toBe(false);
    expect(footer?.contains(save)).toBe(true);
    expect(save.getAttribute("form")).toBe("modal-test-form");
    fireEvent.click(save);
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
