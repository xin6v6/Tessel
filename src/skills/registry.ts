import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../observability/logger.ts";
import { isValidSkillName, type Skill } from "./types.ts";
import { BINDINGS_FILE } from "./bindings.ts";

const logger = createLogger("skill-registry");

// ────────────────────────────────────────────────────────────────────────────
// SkillRegistry —— 扫 skills/ 目录、解析 SKILL.md、内存索引、CRUD、热重载。
//
// 真相源是文件：每个 skill 一个子目录 + SKILL.md(frontmatter + 正文)。
// 运行时与 UI 共用同一个 registry 实例 → CRUD 改完即时生效。
//
// 容错：单个 SKILL.md 解析失败【跳过该 skill 并记日志】，不拖垮整个加载。
// frontmatter 只认 name / description 两个标量字段，自带极简解析器，不引依赖。
// ────────────────────────────────────────────────────────────────────────────

/** 默认 skill 目录：项目根 skills/。可由 SKILLS_DIR env 覆盖。 */
export function defaultSkillsDir(): string {
  return process.env.SKILLS_DIR ?? path.resolve("skills");
}

/**
 * 解析 SKILL.md 文本 → { description, body }。
 *
 * 期望格式：
 *   ---
 *   name: foo
 *   description: 一行描述
 *   ---
 *   正文……
 *
 * frontmatter 用极简行解析（key: value），value 取冒号后整行去空白。
 * 没有 frontmatter 或缺 description → 返回 null（调用方跳过该 skill）。
 */
export function parseSkillMd(text: string): { description: string; body: string } | null {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!fmMatch) return null;

  const [, frontmatter, body] = fmMatch;
  const fields: Record<string, string> = {};
  for (const line of frontmatter!.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // 去掉可选的包裹引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) fields[key] = value;
  }

  const description = fields.description ?? "";
  if (!description) return null; // 没有触发描述的 skill 无法命中，视为无效

  return { description, body: (body ?? "").trim() };
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? defaultSkillsDir();
  }

  /** skill 目录绝对路径。 */
  skillsDir(): string {
    return this.dir;
  }

  /** 扫目录重建内存索引。目录不存在 → 空索引（不报错）。 */
  load(): this {
    this.skills.clear();
    let entries: fs.Dirent[];
    try {
      if (!fs.existsSync(this.dir)) {
        logger.info({ dir: this.dir }, "skills 目录不存在，空索引");
        return this;
      }
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch (err) {
      logger.warn({ dir: this.dir, err: err instanceof Error ? err.message : String(err) }, "读 skills 目录失败");
      return this;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue; // 跳过 _bindings.json 等文件
      const name = entry.name;
      if (name === BINDINGS_FILE) continue;
      if (!isValidSkillName(name)) {
        logger.warn({ name }, "skill 目录名非法（需 kebab-case），跳过");
        continue;
      }
      const mdPath = path.join(this.dir, name, "SKILL.md");
      try {
        if (!fs.existsSync(mdPath)) continue;
        const parsed = parseSkillMd(fs.readFileSync(mdPath, "utf8"));
        if (!parsed) {
          logger.warn({ name, mdPath }, "SKILL.md 缺 frontmatter / description，跳过");
          continue;
        }
        this.skills.set(name, { name, description: parsed.description, body: parsed.body });
      } catch (err) {
        logger.warn({ name, err: err instanceof Error ? err.message : String(err) }, "解析 skill 失败，跳过");
      }
    }

    logger.info({ dir: this.dir, count: this.skills.size }, "skills 已加载");
    return this;
  }

  /** 全部 skill。 */
  list(): Skill[] {
    return [...this.skills.values()];
  }

  /** 取单个 skill。 */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  /** 新建 skill：写 skills/<name>/SKILL.md 并更新内存。name 已存在则抛错。 */
  create(name: string, description: string, body: string): Skill {
    if (!isValidSkillName(name)) throw new Error(`非法 skill 名：${name}（需 kebab-case，1~64 字符）`);
    if (this.skills.has(name)) throw new Error(`skill 已存在：${name}`);
    if (!description.trim()) throw new Error("description 不能为空");
    return this.writeSkill(name, description, body);
  }

  /** 更新 skill：传入的字段覆盖，未传保留。name 不存在则抛错。 */
  update(name: string, patch: { description?: string; body?: string }): Skill {
    const cur = this.skills.get(name);
    if (!cur) throw new Error(`skill 不存在：${name}`);
    const description = patch.description !== undefined ? patch.description : cur.description;
    const body = patch.body !== undefined ? patch.body : cur.body;
    if (!description.trim()) throw new Error("description 不能为空");
    return this.writeSkill(name, description, body);
  }

  /** 删除 skill：移除目录并更新内存。 */
  remove(name: string): void {
    if (!this.skills.has(name)) throw new Error(`skill 不存在：${name}`);
    const skillDir = path.join(this.dir, name);
    fs.rmSync(skillDir, { recursive: true, force: true });
    this.skills.delete(name);
    logger.info({ name }, "skill 已删除");
  }

  /** 写 SKILL.md（create/update 共用），更新内存索引并返回。 */
  private writeSkill(name: string, description: string, body: string): Skill {
    const skillDir = path.join(this.dir, name);
    fs.mkdirSync(skillDir, { recursive: true });
    // description 单行：去掉换行避免破坏 frontmatter。
    const safeDesc = description.replace(/\r?\n/g, " ").trim();
    const content = `---\nname: ${name}\ndescription: ${safeDesc}\n---\n\n${body.trim()}\n`;
    const mdPath = path.join(skillDir, "SKILL.md");
    const tmp = `${mdPath}.tmp`;
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, mdPath);
    const skill: Skill = { name, description: safeDesc, body: body.trim() };
    this.skills.set(name, skill);
    logger.info({ name }, "skill 已写入");
    return skill;
  }
}
