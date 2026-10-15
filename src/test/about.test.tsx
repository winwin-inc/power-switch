import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import { AboutPage } from "../AboutPage";
import { openAboutLink } from "../about-api";

vi.mock("../api", () => ({ isDesktop: false }));
vi.mock("../about-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../about-api")>()),
  openAboutLink: vi.fn(),
}));

it("offers safe browser tabs for project links and disables native update checking in the demo", () => {
  const check = vi.fn();
  render(
    <AboutPage
      settings={{ autoUpdate: true, receiveRc: false }}
      busy={false}
      isStoreBuild={false}
      updateState={{ kind: "idle" }}
      onUpdateSave={vi.fn()}
      onCheckUpdate={check}
      onShowUpdate={vi.fn()}
      onError={vi.fn()}
    />,
  );
  const card = screen.getByRole("region", { name: "power-switch" });
  expect(screen.getAllByRole("region")).toHaveLength(1);
  expect(card).toContainElement(
    screen.getByRole("switch", { name: "启动时检查更新" }),
  );
  expect(card).toContainElement(
    screen.getByRole("switch", { name: "测试计划" }),
  );
  expect(
    screen.getByRole("switch", { name: "测试计划" }),
  ).toHaveAccessibleDescription("接收 RC 预发布版本。");
  expect(screen.getByText(`v${packageJson.version}`)).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "软件更新" })).toBeNull();
  expect(
    screen.queryByText(/仅检查版本|下载安装始终需要你确认|不会自动下载/),
  ).toBeNull();
  for (const [name, url] of [
    ["GitHub", "https://github.com/winwin-inc/power-switch"],
    [
      "更新日志",
      `https://github.com/winwin-inc/power-switch/releases/tag/v${packageJson.version}`,
    ],
  ]) {
    const link = screen.getByRole("link", { name });
    expect(card).toContainElement(link);
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    // Observe whether the React handler preserves native browser navigation without opening a real tab.
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    let preventedByApp = true;
    const stopNavigation = (event: Event) => {
      preventedByApp = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", stopNavigation, { once: true });
    fireEvent(link, click);
    expect(preventedByApp).toBe(false);
  }
  expect(openAboutLink).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "检查更新" })).toBeDisabled();
  expect(check).not.toHaveBeenCalled();
});
