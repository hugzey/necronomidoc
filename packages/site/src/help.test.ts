import { describe, expect, it } from "vitest";
import { HELP_NAV, helpIdFromPath, isActiveNavEntry } from "./help-nav.js";
import { helpPageIds, pageTitle, resolveHelpLink } from "./help.js";

describe("help handbook", () => {
  it("every nav entry names a bundled docs page", () => {
    const missing = HELP_NAV.flatMap((s) => s.pages)
      .filter((p) => !helpPageIds.has(p.id))
      .map((p) => p.id);
    expect(missing).toEqual([]);
  });

  it("normalizes pathnames to page ids consistently (index, trailing slash)", () => {
    expect(helpIdFromPath("/help")).toBe("README");
    expect(helpIdFromPath("/help/")).toBe("README");
    expect(helpIdFromPath("/help/usage")).toBe("usage");
    expect(helpIdFromPath("/help/usage/")).toBe("usage");
    expect(helpIdFromPath("/help/deploy/ec2")).toBe("deploy/ec2");
  });

  it("directory-index nav entries claim their subtree", () => {
    expect(isActiveNavEntry("decisions/README", "decisions/0014-auth-baseline")).toBe(true);
    expect(isActiveNavEntry("decisions/README", "decisions/README")).toBe(true);
    expect(isActiveNavEntry("usage", "usage")).toBe(true);
    expect(isActiveNavEntry("usage", "usage2")).toBe(false);
  });

  it("resolves same-dir, cross-dir, fragment, and directory links", () => {
    expect(resolveHelpLink("README", "usage.md")).toBe("/help/usage");
    expect(resolveHelpLink("deploy/ec2", "smoke-test.md")).toBe("/help/deploy/smoke-test");
    expect(resolveHelpLink("deploy/on-prem", "../decisions/0014-auth-baseline.md")).toBe(
      "/help/decisions/0014-auth-baseline",
    );
    expect(resolveHelpLink("usage", "enrichment.md#choosing-a-provider")).toBe(
      "/help/enrichment#choosing-a-provider",
    );
    expect(resolveHelpLink("README", "decisions/")).toBe("/help/decisions/README");
    expect(resolveHelpLink("decisions/0005-doc-ui-framework", "0010-daisyui-component-base.md")).toBe(
      "/help/decisions/0010-daisyui-component-base",
    );
  });

  it("declines external URLs, anchors, and unknown pages", () => {
    expect(resolveHelpLink("usage", "https://example.com/x.md")).toBeUndefined();
    expect(resolveHelpLink("usage", "//cdn.example.com/x")).toBeUndefined();
    expect(resolveHelpLink("usage", "#anchor")).toBeUndefined();
    expect(resolveHelpLink("usage", "does-not-exist.md")).toBeUndefined();
  });

  it("declines links that escape the docs tree instead of aliasing them", () => {
    // ../README.md from a top-level page is the *repo* README, not docs/README.md.
    expect(resolveHelpLink("usage", "../README.md")).toBeUndefined();
    expect(resolveHelpLink("deploy/ec2", "../../deploy/necronomidoc.service")).toBeUndefined();
  });

  it("does not throw on a literal % in a link target", () => {
    expect(resolveHelpLink("usage", "results-100%.md")).toBeUndefined();
  });

  it("extracts titles fence-aware", () => {
    expect(pageTitle("# Real title\n\nbody", "x")).toBe("Real title");
    expect(pageTitle("```bash\n# not a title\n```\n# Real title\n", "x")).toBe("Real title");
    expect(pageTitle("no heading at all", "fallback-id")).toBe("fallback-id");
  });
});
