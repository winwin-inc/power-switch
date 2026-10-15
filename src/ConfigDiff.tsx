import { useMemo } from "react";
import { diffConfigLines, type ConfigDiffLine } from "./config-diff";

/** Render escaped config text with line numbers and change markers alongside theme-aware colors. */
function DiffSide({
  lines,
  side,
}: {
  lines: ConfigDiffLine[];
  side: "before" | "after";
}) {
  return (
    <div>
      <span className={`diff-label ${side === "after" ? "after" : ""}`}>
        {side === "before" ? "变更前" : "变更后"}
      </span>
      <pre
        className="config-diff"
        aria-label={side === "before" ? "变更前配置" : "变更后配置"}
      >
        {lines.map((line, index) => (
          <span
            className={`diff-line${line.changed ? ` diff-line-${side === "before" ? "removed" : "added"}` : ""}`}
            key={index}
          >
            <span className="diff-line-number" aria-hidden="true">
              {index + 1}
            </span>
            <span className="diff-line-marker" aria-hidden="true">
              {line.changed ? (side === "before" ? "−" : "+") : " "}
            </span>
            <span className="diff-line-text">{line.text || "\u00a0"}</span>
          </span>
        ))}
      </pre>
    </div>
  );
}

/** Highlight only changed lines in the already-redacted preview without altering the write payload. */
export function ConfigDiff({
  before,
  after,
}: {
  before: string;
  after: string;
}) {
  const lines = useMemo(() => diffConfigLines(before, after), [before, after]);
  return (
    <div className="diff-grid">
      <DiffSide lines={lines.before} side="before" />
      <DiffSide lines={lines.after} side="after" />
    </div>
  );
}
