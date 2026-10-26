import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Brand } from "../Brand";

/** 可在测试中切换的系统媒体查询，使用真实事件监听语义。 */
function motionQuery() {
  return Object.assign(new EventTarget(), {
    matches: false,
    media: "(prefers-reduced-motion: reduce)",
  });
}

let query: ReturnType<typeof motionQuery>;

beforeEach(() => {
  vi.useFakeTimers();
  query = motionQuery();
  vi.spyOn(window, "matchMedia").mockReturnValue(query as MediaQueryList);
});
afterEach(() => vi.useRealTimers());

/** 渲染真实品牌入口，保留可验证的导航回调与主图标节点。 */
function renderBrand() {
  const onNavigate = vi.fn();
  const view = render(<Brand onNavigate={onNavigate} />);
  const link = screen.getByRole("link", { name: "power-switch，返回模型库" });
  const icon = view.container.querySelector(
    ".brand-mark img",
  ) as HTMLImageElement;
  return { ...view, link, icon, onNavigate };
}

/** JSDOM 不运行 CSS 时间线，显式派发浏览器在主动画结束时提供的事件。 */
function animationEnds(target: Element, name = "brand-switch-pop") {
  const event = new Event("animationend", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: name });
  fireEvent(target, event);
}

describe("brand power-on choreography", () => {
  it("finishes a full sequence after a short hover and allows replay", () => {
    const { link, icon } = renderBrand();
    fireEvent.mouseEnter(link);
    fireEvent.mouseLeave(link);
    act(() => vi.advanceTimersByTime(1000));
    expect(link).toHaveAttribute("data-motion", "running");
    animationEnds(icon, "unrelated-animation");
    expect(link).toHaveAttribute("data-motion", "running");
    animationEnds(icon);
    expect(link).toHaveAttribute("data-motion", "idle");
    fireEvent.mouseEnter(link);
    expect(link).toHaveAttribute("data-motion", "running");
  });

  it("does not restart or extend playback when the pointer rapidly reenters", () => {
    const { link } = renderBrand();
    fireEvent.mouseEnter(link);
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.mouseLeave(link);
    fireEvent.mouseEnter(link);
    act(() => vi.advanceTimersByTime(1000));
    expect(link).toHaveAttribute("data-motion", "idle");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("supports keyboard focus and never blocks brand navigation", () => {
    const { link, onNavigate } = renderBrand();
    fireEvent.focus(link);
    expect(link).toHaveAttribute("data-motion", "running");
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(link).toHaveAccessibleName("power-switch，返回模型库");
    expect(link.querySelector(".brand-name")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("keeps reduced-motion hover and focus static while navigation still works", () => {
    query.matches = true;
    const { link, onNavigate } = renderBrand();
    fireEvent.mouseEnter(link);
    fireEvent.focus(link);
    fireEvent.click(link);
    expect(link).toHaveAttribute("data-motion", "idle");
    expect(vi.getTimerCount()).toBe(0);
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it("stops immediately when the system enables reduced motion and waits for a new interaction", () => {
    const { link } = renderBrand();
    fireEvent.mouseEnter(link);
    act(() => {
      query.matches = true;
      query.dispatchEvent(new Event("change"));
    });
    expect(link).toHaveAttribute("data-motion", "idle");
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      query.matches = false;
      query.dispatchEvent(new Event("change"));
    });
    expect(link).toHaveAttribute("data-motion", "idle");
    fireEvent.mouseLeave(link);
    fireEvent.mouseEnter(link);
    expect(link).toHaveAttribute("data-motion", "running");
  });

  it("cleans up its fallback timer and system preference subscription on unmount", () => {
    const unsubscribe = vi.spyOn(query, "removeEventListener");
    const { link, unmount } = renderBrand();
    fireEvent.mouseEnter(link);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
