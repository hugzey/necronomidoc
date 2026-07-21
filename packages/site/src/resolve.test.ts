import { describe, expect, it } from "vitest";
import { subsystemForFile } from "./resolve.js";

type S = { id: string; dirs: string[]; entryPoints?: string[] };

describe("subsystemForFile", () => {
  const subs: S[] = [
    { id: "ui", dirs: ["src/components"], entryPoints: ["src/App.tsx"] },
    { id: "state", dirs: ["src/hooks"] },
    { id: "root", dirs: [] },
  ];

  it("claims a file by longest matching dirs prefix", () => {
    expect(subsystemForFile("src/hooks/useCounter.ts", subs)?.id).toBe("state");
    expect(subsystemForFile("src/components/Button.tsx", subs)?.id).toBe("ui");
  });

  it("claims an entry-point file that sits outside the subsystem's dirs", () => {
    // src/App.tsx is ui's entry point but under no subsystem's dirs.
    expect(subsystemForFile("src/App.tsx", subs)?.id).toBe("ui");
  });

  it("prefers a nested dir over a broader one", () => {
    const nested: S[] = [
      { id: "broad", dirs: ["src"] },
      { id: "narrow", dirs: ["src/api"] },
    ];
    expect(subsystemForFile("src/api/client.ts", nested)?.id).toBe("narrow");
  });

  it("lets a dir-less subsystem own repo-root files only", () => {
    expect(subsystemForFile("README.md", subs)?.id).toBe("root");
    expect(subsystemForFile("src/hooks/x.ts", subs)?.id).toBe("state");
  });

  it("supports exact-path ownership (container-root loose files)", () => {
    const exact: S[] = [
      { id: "packages", dirs: ["packages/tsconfig.json"] },
      { id: "mcp", dirs: ["packages/mcp"] },
    ];
    expect(subsystemForFile("packages/tsconfig.json", exact)?.id).toBe("packages");
    // The loose-file group must NOT claim files under a sibling package.
    expect(subsystemForFile("packages/mcp/index.ts", exact)?.id).toBe("mcp");
  });

  it("returns undefined when nothing claims the path", () => {
    expect(subsystemForFile("docs/guide.md", subs.slice(0, 2))).toBeUndefined();
  });
});
