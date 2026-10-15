export interface ConfigDiffLine {
  text: string;
  changed: boolean;
}

/** Compute one LCS boundary in linear memory, traversing backwards for the right half. */
function commonLengths(left: string[], right: string[], reverse = false) {
  const lengths = new Uint32Array(right.length + 1);
  for (let i = 0; i < left.length; i += 1) {
    let diagonal = 0;
    for (let j = 0; j < right.length; j += 1) {
      const previous = lengths[j + 1];
      const a = left[reverse ? left.length - i - 1 : i];
      const b = right[reverse ? right.length - j - 1 : j];
      lengths[j + 1] = a === b ? diagonal + 1 : Math.max(previous, lengths[j]);
      diagonal = previous;
    }
  }
  return lengths;
}

/** Split large comparisons using Hirschberg's LCS algorithm so unchanged interior lines stay neutral. */
function markCommonLines(left: ConfigDiffLine[], right: ConfigDiffLine[]) {
  if (!left.length || !right.length) return;
  if (left.length === 1) {
    const match = right.find((line) => line.text === left[0].text);
    if (match) left[0].changed = match.changed = false;
    return;
  }
  const middle = Math.floor(left.length / 2);
  const oldText = left.map((line) => line.text);
  const newText = right.map((line) => line.text);
  const prefix = commonLengths(oldText.slice(0, middle), newText);
  const suffix = commonLengths(oldText.slice(middle), newText, true);
  let split = 0;
  for (let i = 1; i <= right.length; i += 1) {
    if (
      prefix[i] + suffix[right.length - i] >
      prefix[split] + suffix[right.length - split]
    )
      split = i;
  }
  markCommonLines(left.slice(0, middle), right.slice(0, split));
  markCommonLines(left.slice(middle), right.slice(split));
}

/** Compare redacted config lines, preserving unchanged runs and bounding large-preview memory. */
export function diffConfigLines(before: string, after: string) {
  const left = before === "" ? [] : before.split("\n");
  const right = after === "" ? [] : after.split("\n");
  const oldLines: ConfigDiffLine[] = left.map((text) => ({
    text,
    changed: true,
  }));
  const newLines: ConfigDiffLine[] = right.map((text) => ({
    text,
    changed: true,
  }));
  let start = 0;
  let oldEnd = left.length;
  let newEnd = right.length;
  while (start < oldEnd && start < newEnd && left[start] === right[start]) {
    oldLines[start].changed = newLines[start].changed = false;
    start += 1;
  }
  while (
    oldEnd > start &&
    newEnd > start &&
    left[oldEnd - 1] === right[newEnd - 1]
  ) {
    oldLines[--oldEnd].changed = newLines[--newEnd].changed = false;
  }
  const rows = oldEnd - start;
  const columns = newEnd - start;
  // Keep ordinary previews fast while avoiding a quadratic allocation for large files.
  if (rows && columns && (rows + 1) * (columns + 1) <= 4_000_000) {
    const width = columns + 1;
    const lengths = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i -= 1) {
      for (let j = columns - 1; j >= 0; j -= 1) {
        lengths[i * width + j] =
          left[start + i] === right[start + j]
            ? lengths[(i + 1) * width + j + 1] + 1
            : Math.max(
                lengths[(i + 1) * width + j],
                lengths[i * width + j + 1],
              );
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < columns) {
      if (left[start + i] === right[start + j]) {
        oldLines[start + i++].changed = newLines[start + j++].changed = false;
      } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
        i += 1;
      } else {
        j += 1;
      }
    }
  } else if (rows && columns) {
    markCommonLines(
      oldLines.slice(start, oldEnd),
      newLines.slice(start, newEnd),
    );
  }
  return { before: oldLines, after: newLines };
}
