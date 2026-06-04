import { describe, it, expect, afterEach } from "bun:test";
import { parseRepoMap, repoForChannel } from "../src/workflows/repo-map.ts";

describe("parseRepoMap", () => {
  it("解析多条 channelId:repoPath", () => {
    const m = parseRepoMap("C123:/a/proj1,C456:/b/proj2");
    expect(m.get("C123")).toBe("/a/proj1");
    expect(m.get("C456")).toBe("/b/proj2");
    expect(m.size).toBe(2);
  });

  it("容忍空白与空条目", () => {
    const m = parseRepoMap("  C123 : /a/proj1 , , C456:/b/proj2 ,");
    expect(m.get("C123")).toBe("/a/proj1");
    expect(m.get("C456")).toBe("/b/proj2");
    expect(m.size).toBe(2);
  });

  it("跳过格式错误的条目（无冒号 / 缺值）", () => {
    const m = parseRepoMap("bad-no-colon,C1:/ok,:noChannel,C2:");
    expect(m.get("C1")).toBe("/ok");
    expect(m.size).toBe(1);
  });

  it("空 / undefined → 空 map", () => {
    expect(parseRepoMap(undefined).size).toBe(0);
    expect(parseRepoMap("").size).toBe(0);
  });
});

describe("repoForChannel", () => {
  const prev = process.env.CODING_REPOS;
  afterEach(() => {
    if (prev === undefined) delete process.env.CODING_REPOS;
    else process.env.CODING_REPOS = prev;
  });

  it("按频道命中映射", () => {
    process.env.CODING_REPOS = "C123:/a/proj1,C456:/b/proj2";
    expect(repoForChannel("C123")).toBe("/a/proj1");
    expect(repoForChannel("C456")).toBe("/b/proj2");
  });

  it("未命中 / 无 channel → undefined（调用方回退单一 env）", () => {
    process.env.CODING_REPOS = "C123:/a/proj1";
    expect(repoForChannel("C999")).toBeUndefined();
    expect(repoForChannel(undefined)).toBeUndefined();
  });
});
