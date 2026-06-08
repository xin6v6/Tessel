import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SkillRegistry, parseSkillMd } from "../src/skills/registry.ts";
import { readBindings, writeBindings } from "../src/skills/bindings.ts";
import { SkillContext } from "../src/skills/context.ts";
import {
  resolveAgentSkills,
  renderSkillMenu,
  selectSkills,
  renderSkillBodies,
  buildSystemPrompt,
} from "../src/skills/inject.ts";

// 每个测试用独立临时目录当 skills/ 真相源,互不干扰。
let dir: string;

function writeSkillFile(name: string, description: string, body: string): void {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tessel-skills-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseSkillMd", () => {
  it("parses frontmatter and body", () => {
    const r = parseSkillMd("---\nname: foo\ndescription: 一行描述\n---\n\n正文内容");
    expect(r).toEqual({ description: "一行描述", body: "正文内容" });
  });
  it("returns null when no frontmatter", () => {
    expect(parseSkillMd("just text")).toBeNull();
  });
  it("returns null when description missing", () => {
    expect(parseSkillMd("---\nname: foo\n---\n\nbody")).toBeNull();
  });
  it("strips wrapping quotes on values", () => {
    const r = parseSkillMd('---\nname: foo\ndescription: "带引号"\n---\nbody');
    expect(r?.description).toBe("带引号");
  });
});

describe("SkillRegistry load", () => {
  it("loads valid skills, skips invalid", () => {
    writeSkillFile("code-review", "审查代码改动", "审核指令正文");
    writeSkillFile("commit-msg", "生成提交信息", "提交指令正文");
    // 缺 description 的坏 skill —— 应被跳过,不拖垮加载
    fs.mkdirSync(path.join(dir, "broken"));
    fs.writeFileSync(path.join(dir, "broken", "SKILL.md"), "---\nname: broken\n---\nno desc");

    const reg = new SkillRegistry(dir).load();
    const names = reg.list().map((s) => s.name).sort();
    expect(names).toEqual(["code-review", "commit-msg"]);
    expect(reg.has("broken")).toBe(false);
  });

  it("empty when dir missing", () => {
    const reg = new SkillRegistry(path.join(dir, "nope")).load();
    expect(reg.list()).toEqual([]);
  });
});

describe("SkillRegistry CRUD", () => {
  it("create / update / remove round-trips to disk", () => {
    const reg = new SkillRegistry(dir);
    reg.load();

    reg.create("foo", "描述甲", "正文甲");
    expect(reg.get("foo")?.description).toBe("描述甲");
    // 重新 load 验证落盘
    expect(new SkillRegistry(dir).load().get("foo")?.body).toBe("正文甲");

    reg.update("foo", { description: "描述乙" });
    expect(reg.get("foo")?.description).toBe("描述乙");
    expect(reg.get("foo")?.body).toBe("正文甲"); // 未传 body 保留

    reg.remove("foo");
    expect(reg.has("foo")).toBe(false);
    expect(fs.existsSync(path.join(dir, "foo"))).toBe(false);
  });

  it("rejects duplicate / invalid names", () => {
    const reg = new SkillRegistry(dir).load();
    reg.create("foo", "d", "b");
    expect(() => reg.create("foo", "d", "b")).toThrow();
    expect(() => reg.create("Foo", "d", "b")).toThrow(); // 非 kebab-case
    expect(() => reg.update("missing", { body: "x" })).toThrow();
  });
});

describe("bindings", () => {
  it("write then read round-trips", () => {
    writeBindings(dir, { supervisor: ["a"], slack: ["b", "c"] });
    expect(readBindings(dir)).toEqual({ supervisor: ["a"], slack: ["b", "c"] });
  });
  it("missing file -> empty map", () => {
    expect(readBindings(dir)).toEqual({});
  });
});

// ── 硬规则核心:skill 必须绑定到 agent ───────────────────────────────────────
describe("binding boundary (hard rule)", () => {
  beforeEach(() => {
    writeSkillFile("code-review", "审查代码改动 review", "审核正文");
    writeSkillFile("commit-msg", "生成提交信息 commit", "提交正文");
  });

  it("resolveAgentSkills only returns bound skills", () => {
    const reg = new SkillRegistry(dir).load();
    const bindings = { slack: ["code-review"] }; // slack 只绑了 code-review
    const got = resolveAgentSkills("slack", reg, bindings).map((s) => s.name);
    expect(got).toEqual(["code-review"]);
  });

  it("unbound agent sees no skills (empty menu, no hit)", () => {
    const reg = new SkillRegistry(dir).load();
    const bindings = { slack: ["code-review"] };
    // web 没在 bindings 里 → 既无 menu 也命不中,哪怕输入里有关键词
    expect(renderSkillMenu("web", reg, bindings)).toBe("");
    expect(selectSkills("web", "帮我审查代码改动", reg, bindings)).toEqual([]);
  });

  it("an agent cannot hit a skill bound to another agent", () => {
    const reg = new SkillRegistry(dir).load();
    const bindings = { slack: ["code-review"], supervisor: ["commit-msg"] };
    // 输入同时含两个 skill 的关键词,但 slack 只能命中自己绑定的 code-review
    const hit = selectSkills("slack", "审查代码改动并生成提交信息", reg, bindings).map((s) => s.name);
    expect(hit).toEqual(["code-review"]);
  });

  it("binding to a nonexistent skill is silently filtered", () => {
    const reg = new SkillRegistry(dir).load();
    const bindings = { slack: ["code-review", "ghost"] }; // ghost 不存在
    expect(resolveAgentSkills("slack", reg, bindings).map((s) => s.name)).toEqual(["code-review"]);
  });
});

describe("selective injection (no pollution)", () => {
  beforeEach(() => {
    writeSkillFile("code-review", "审查代码改动 review", "审核正文指令");
  });

  it("no hit -> system prompt is just the base", () => {
    const reg = new SkillRegistry(dir).load();
    const bindings = { slack: ["code-review"] };
    const sp = buildSystemPrompt({ agentName: "slack", base: "你是助手", userInput: "今天天气怎么样", registry: reg, bindings });
    // menu 仍在(常驻),但没有正文注入
    expect(sp).toContain("你是助手");
    expect(sp).not.toContain("审核正文指令");
  });

  it("hit -> body injected this turn", () => {
    const reg = new SkillRegistry(dir).load();
    const bindings = { slack: ["code-review"] };
    const sp = buildSystemPrompt({ agentName: "slack", base: "你是助手", userInput: "帮我审查代码", registry: reg, bindings });
    expect(sp).toContain("审核正文指令");
  });

  it("renderSkillBodies empty for no skills", () => {
    expect(renderSkillBodies([])).toBe("");
  });
});

// ── SkillContext:P2 节点用的注入句柄,端到端契约 ────────────────────────────
describe("SkillContext (node-level injection)", () => {
  beforeEach(() => {
    writeSkillFile("code-review", "审查代码改动 review", "审核正文指令");
    writeBindings(dir, { slack: ["code-review"] });
  });

  it("promptFor injects body on hit for bound agent", () => {
    const ctx = new SkillContext(new SkillRegistry(dir).load());
    const sp = ctx.promptFor("slack", "你是 Slack 助手", "帮我审查代码改动");
    expect(sp).toContain("你是 Slack 助手");
    expect(sp).toContain("审核正文指令");
  });

  it("promptFor returns base only for unbound agent (no pollution)", () => {
    const ctx = new SkillContext(new SkillRegistry(dir).load());
    // web 没绑定任何 skill → 即使输入含关键词也不注入
    const sp = ctx.promptFor("web", "你是 Web 助手", "帮我审查代码改动");
    expect(sp).toBe("你是 Web 助手");
  });

  it("reload picks up newly written skills", () => {
    const ctx = new SkillContext(new SkillRegistry(dir).load());
    writeSkillFile("commit-msg", "生成提交信息 commit", "提交正文");
    writeBindings(dir, { slack: ["code-review", "commit-msg"] });
    ctx.reload();
    const sp = ctx.promptFor("slack", "base", "帮我生成提交信息");
    expect(sp).toContain("提交正文");
  });
});

// ── P4:workflow stage 级 skill 注入语义(配方级、无条件、缺失跳过) ──────────
describe("workflow stage skill injection (recipe-level)", () => {
  it("resolves declared skills to bodies; skips missing without error", () => {
    writeSkillFile("code-review", "审查代码", "审核员指令");
    const reg = new SkillRegistry(dir).load();
    // 模拟 runStageTaskFor 的注入:stage.skills = ["code-review","ghost"]
    const declared = ["code-review", "ghost"];
    const resolved = declared.map((n) => reg.get(n)).filter((s): s is NonNullable<typeof s> => Boolean(s));
    const missing = declared.filter((n) => !reg.has(n));
    expect(resolved.map((s) => s.name)).toEqual(["code-review"]);
    expect(missing).toEqual(["ghost"]); // 缺失被识别(节点里会记日志跳过)
    expect(renderSkillBodies(resolved)).toContain("审核员指令");
  });

  it("no declared skills -> no injection block", () => {
    const reg = new SkillRegistry(dir).load();
    const resolved = ([] as string[]).map((n) => reg.get(n)).filter((s): s is NonNullable<typeof s> => Boolean(s));
    expect(renderSkillBodies(resolved)).toBe("");
  });
});
