import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MoreActions } from "../ui";

describe("MoreActions keyboard and dismissal", () => {
  it("focuses the pointer trigger and closes when Escape is dispatched from the page", () => {
    render(
      <MoreActions
        label="更多操作 模型"
        actions={[{ label: "复制模型", icon: null, onSelect: vi.fn() }]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "更多操作 模型" });
    fireEvent.click(trigger);
    expect(trigger).toHaveFocus();
    expect(
      screen.getByRole("group", { name: "更多操作 模型" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(
      screen.queryByRole("group", { name: "更多操作 模型" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("opens with the keyboard, reaches actions by Tab, and restores focus with Escape", async () => {
    const user = userEvent.setup();
    const action = vi.fn();
    render(
      <MoreActions
        label="更多操作 模型"
        actions={[{ label: "复制模型", icon: null, onSelect: action }]}
      />,
    );
    await user.tab();
    const trigger = screen.getByRole("button", { name: "更多操作 模型" });
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.tab();
    expect(screen.getByRole("button", { name: "复制模型" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: "复制模型" }),
    ).not.toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });

  it("dismisses on outside click without stealing focus and runs a chosen action once", async () => {
    const user = userEvent.setup();
    const action = vi.fn();
    render(
      <>
        <MoreActions
          label="更多操作 模型"
          actions={[{ label: "复制模型", icon: null, onSelect: action }]}
        />
        <button>外部操作</button>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "更多操作 模型" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "外部操作" }));
    expect(screen.getByRole("button", { name: "外部操作" })).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "复制模型" }));
    expect(action).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
