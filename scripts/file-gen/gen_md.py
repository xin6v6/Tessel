#!/usr/bin/env python3
"""
gen_md.py — 生成 .md 文件
用法：python3 gen_md.py '<JSON>'

JSON 格式：
{
  "output": "output.md",
  "sections": [
    { "heading": "标题", "level": 1 },
    { "text": "段落文字" },
    { "bullets": ["条目1", "条目2"] },
    { "numbered": ["步骤1", "步骤2"] },
    { "code": "print('hello')", "lang": "python" },
    { "table": { "headers": ["列A","列B"], "rows": [["1","2"]] } },
    { "hr": true },
    { "raw": "任意 markdown 原文" }
  ]
}
"""
import sys
import json
from pathlib import Path

def section_to_md(section: dict) -> str:
    if "heading" in section:
        level = section.get("level", 1)
        return f"{'#' * level} {section['heading']}\n"
    if "text" in section:
        return f"{section['text']}\n"
    if "bullets" in section:
        return "\n".join(f"- {item}" for item in section["bullets"]) + "\n"
    if "numbered" in section:
        return "\n".join(f"{i+1}. {item}" for i, item in enumerate(section["numbered"])) + "\n"
    if "code" in section:
        lang = section.get("lang", "")
        return f"```{lang}\n{section['code']}\n```\n"
    if "table" in section:
        tbl = section["table"]
        headers = tbl.get("headers", [])
        rows = tbl.get("rows", [])
        lines = []
        if headers:
            lines.append("| " + " | ".join(headers) + " |")
            lines.append("| " + " | ".join("---" for _ in headers) + " |")
        for row in rows:
            lines.append("| " + " | ".join(str(c) for c in row) + " |")
        return "\n".join(lines) + "\n"
    if "hr" in section:
        return "---\n"
    if "raw" in section:
        return section["raw"] + "\n"
    return ""

def main():
    if len(sys.argv) < 2:
        print("用法: python3 gen_md.py '<JSON>'", file=sys.stderr)
        sys.exit(1)

    data = json.loads(sys.argv[1])
    output_path = Path(data["output"])
    output_path.parent.mkdir(parents=True, exist_ok=True)

    parts = []
    for section in data.get("sections", []):
        md = section_to_md(section)
        if md:
            parts.append(md)

    output_path.write_text("\n".join(parts), encoding="utf-8")
    print(str(output_path.resolve()))

if __name__ == "__main__":
    main()
