/**
 * 7-segment readouts (patterns: .bm-seg__digit, ghost + value).
 * Mirrors the pattern demo in src/patterns/page.ts.
 */

/**
 * Fixed-width string for 7-seg slots: optional leading spaces, then sign (space or `-`)
 * and `abs.toFixed(2)`, so switching between negative and positive values does not change layout.
 */
export function formatSegSignedFixed2(value: number, totalWidth = 6): string {
  const sign = value < 0 ? "-" : " ";
  const body = Math.abs(value).toFixed(2);
  return (sign + body).padStart(totalWidth, " ");
}

function makeDigit(): HTMLElement {
  const d = document.createElement("span");
  d.className = "bm-seg__digit";
  d.setAttribute("aria-hidden", "true");
  const ghost = document.createElement("span");
  ghost.className = "bm-seg__ghost";
  const value = document.createElement("span");
  value.className = "bm-seg__value";
  d.appendChild(ghost);
  d.appendChild(value);
  return d;
}

function paintDigit(digit: HTMLElement, ch: string, dpOn: boolean): void {
  digit.dataset.dp = dpOn ? "true" : "false";
  const ghost = digit.querySelector<HTMLElement>(".bm-seg__ghost");
  const value = digit.querySelector<HTMLElement>(".bm-seg__value");
  if (ch === " ") {
    digit.dataset.value = "";
    digit.classList.add("bm-seg__digit--blank");
    if (ghost) ghost.textContent = "8";
    if (value) value.textContent = "";
    return;
  }
  digit.dataset.value = ch;
  digit.classList.remove("bm-seg__digit--blank");
  if (ghost) ghost.textContent = dpOn ? "8." : "8";
  if (value) value.textContent = dpOn ? `${ch}.` : ch;
}

function parseSegChars(raw: string): Array<{ ch: string; dp: boolean }> {
  const items: Array<{ ch: string; dp: boolean }> = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "." && items.length > 0 && /[0-9]/.test(items[items.length - 1].ch)) {
      items[items.length - 1].dp = true;
      continue;
    }
    items.push({ ch: c, dp: false });
  }
  return items;
}

/** Fill a [data-seg-slots] container with skewed bm-seg__digit glyphs for plain text (numbers, minus, dots, hex letters like F). */
export function populateSegSlots(container: HTMLElement, raw: string): void {
  const items = parseSegChars(raw);

  container.replaceChildren(
    ...items.map(({ ch, dp }) => {
      const d = makeDigit();
      paintDigit(d, ch, dp);
      return d;
    }),
  );
}
