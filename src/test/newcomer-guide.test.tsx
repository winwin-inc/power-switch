import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewcomerGuide } from "../NewcomerGuide";

describe("NewcomerGuide motion preferences", () => {
  let reducedMotion = false;
  let motionChanged: (() => void) | undefined;

  beforeEach(() => {
    reducedMotion = false;
    motionChanged = undefined;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        get matches() {
          return reducedMotion;
        },
        addEventListener: (_event: string, listener: () => void) => {
          motionChanged = listener;
        },
        removeEventListener: vi.fn(),
      }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Keep automatic progression off when reduced motion is active at mount. */
  it("starts paused and does not auto-advance with reduced motion enabled", () => {
    reducedMotion = true;
    vi.useFakeTimers();
    render(<NewcomerGuide onClose={vi.fn()} onStart={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: "播放引导动画" }),
    ).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(12_000));
    expect(
      screen.getByRole("heading", { name: "申请 WorkBuddy 密钥" }),
    ).toBeInTheDocument();
    vi.useRealTimers();
  });

  /** Stop the running carousel when the system preference changes during the dialog. */
  it("stops automatic progression when reduced motion becomes enabled", () => {
    vi.useFakeTimers();
    render(<NewcomerGuide onClose={vi.fn()} onStart={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "暂停引导动画" }),
    ).toBeInTheDocument();

    reducedMotion = true;
    act(() => motionChanged?.());
    expect(
      screen.getByRole("button", { name: "播放引导动画" }),
    ).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(12_000));
    expect(
      screen.getByRole("heading", { name: "申请 WorkBuddy 密钥" }),
    ).toBeInTheDocument();
    vi.useRealTimers();
  });

  /** Preserve direct step navigation regardless of the system motion preference. */
  it("keeps manual step navigation available while reduced motion is enabled", async () => {
    reducedMotion = true;
    const user = userEvent.setup();
    render(<NewcomerGuide onClose={vi.fn()} onStart={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(
      screen.getByRole("heading", { name: "在模型库找到它" }),
    ).toBeInTheDocument();
  });
});
