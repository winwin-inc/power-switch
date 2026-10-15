import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { diffConfigLines } from "../config-diff";
import { ConfigDiff } from "../ConfigDiff";

describe("redacted config line differences", () => {
  it.each([
    ["same\ntext", "same\ntext", [], []],
    ["a\nc", "a\nb\nc", [], [1]],
    ["a\nb\nc", "a\nc", [1], []],
    ["a\nold\nkeep\nx\nz", "a\nnew\nkeep\ny\nz", [1, 3], [1, 3]],
    ["a\na\nb", "a\nb", [1], []],
    ["", "new", [], [0]],
    ["old", "", [0], []],
    ["", "", [], []],
    ["a", "a\n", [], [1]],
  ])(
    "marks additions and removals for %j → %j",
    (before, after, removed, added) => {
      const diff = diffConfigLines(before, after);
      expect(
        diff.before.flatMap((line, i) => (line.changed ? [i] : [])),
      ).toEqual(removed);
      expect(
        diff.after.flatMap((line, i) => (line.changed ? [i] : [])),
      ).toEqual(added);
      expect(diff.before.map((line) => line.text).join("\n")).toBe(before);
      expect(diff.after.map((line) => line.text).join("\n")).toBe(after);
    },
  );

  it("renders red/green change classes while keeping unchanged and redacted text intact", () => {
    render(
      <ConfigDiff
        before={'{\n  "model": "old",\n  "key": "••••••••"\n}'}
        after={'{\n  "model": "new",\n  "key": "••••••••"\n}'}
      />,
    );
    expect(
      screen.getByText('"model": "old",').closest(".diff-line"),
    ).toHaveClass("diff-line-removed");
    expect(
      screen.getByText('"model": "new",').closest(".diff-line"),
    ).toHaveClass("diff-line-added");
    for (const unchanged of screen.getAllByText('"key": "••••••••"')) {
      expect(unchanged.closest(".diff-line")).toHaveAttribute(
        "class",
        "diff-line",
      );
    }
    expect(screen.getByLabelText("变更前配置")).toBeInTheDocument();
    expect(screen.getByLabelText("变更后配置")).toBeInTheDocument();
  });

  it("keeps very large replacements readable without quadratic allocation", () => {
    const before = Array.from({ length: 2100 }, (_, i) => `old ${i}`).join(
      "\n",
    );
    const after = Array.from({ length: 2100 }, (_, i) => `new ${i}`).join("\n");
    const diff = diffConfigLines(before, after);
    expect(diff.before.every((line) => line.changed)).toBe(true);
    expect(diff.after.every((line) => line.changed)).toBe(true);
    expect(diff.after).toHaveLength(2100);
  });

  it("preserves unchanged interior lines even when a large file changes at both ends", () => {
    const middle = Array.from({ length: 2100 }, (_, i) => `keep ${i}`).join(
      "\n",
    );
    const diff = diffConfigLines(
      `old\n${middle}\nold end`,
      `new\n${middle}\nnew end`,
    );
    expect(
      diff.before.filter((line) => line.changed).map((line) => line.text),
    ).toEqual(["old", "old end"]);
    expect(
      diff.after.filter((line) => line.changed).map((line) => line.text),
    ).toEqual(["new", "new end"]);
  });
});
