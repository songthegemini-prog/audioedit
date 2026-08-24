import { afterEach, describe, expect, it, vi } from "vitest";

import { releaseOutsideTextFocus } from "./transcript";

/** The one behaviour worth pinning here: which element keeps focus.
 *
 * The bug (reported 2026-08-24, "ctrl z ยังกดไม่ได้"): the global Ctrl+Z
 * handler bails when an INPUT/TEXTAREA has focus, because there Ctrl+Z belongs
 * to the text. Clicking a transcript word does NOT move focus — a <span> is
 * not focusable — and dropping a marker auto-focuses its note box. So from the
 * first marker onwards, every Ctrl+Z in the app was swallowed by a field the
 * user had stopped typing in, with nothing on screen to explain it.
 */
function stubDom(active: { tagName: string; blur: () => void } | null, contained: boolean) {
  const keep = {
    contains: () => contained,
  } as unknown as HTMLElement;
  vi.stubGlobal("document", { activeElement: active });
  return keep;
}

describe("releaseOutsideTextFocus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("blurs a text field that is no longer where the user is working", () => {
    const blur = vi.fn();
    const keep = stubDom({ tagName: "INPUT", blur }, false);

    releaseOutsideTextFocus(keep);

    expect(blur).toHaveBeenCalledOnce();
  });

  it("blurs a textarea too, not just inputs", () => {
    const blur = vi.fn();
    const keep = stubDom({ tagName: "TEXTAREA", blur }, false);

    releaseOutsideTextFocus(keep);

    expect(blur).toHaveBeenCalledOnce();
  });

  it("NEVER blurs an editor inside the transcript — that would commit the edit", () => {
    // The transcript's own token/segment boxes commit on blur. Stealing focus
    // from them on a stray click would silently apply a half-typed correction.
    const blur = vi.fn();
    const keep = stubDom({ tagName: "INPUT", blur }, true); // inside `keep`

    releaseOutsideTextFocus(keep);

    expect(blur).not.toHaveBeenCalled();
  });

  it("leaves non-text elements alone", () => {
    const blur = vi.fn();
    const keep = stubDom({ tagName: "BUTTON", blur }, false);

    releaseOutsideTextFocus(keep);

    expect(blur).not.toHaveBeenCalled();
  });

  it("does nothing when nothing has focus", () => {
    const keep = stubDom(null, false);

    expect(() => releaseOutsideTextFocus(keep)).not.toThrow();
  });
});
