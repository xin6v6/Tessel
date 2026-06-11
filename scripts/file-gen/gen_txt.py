#!/usr/bin/env python3
"""
gen_txt.py — 生成纯文本 .txt 文件
用法：python3 gen_txt.py '<JSON>'

JSON 格式：
{
  "output": "output.txt",
  "content": "文件全部内容（直接写入）",
  "encoding": "utf-8"     // 可选，默认 utf-8
}

或者分段格式：
{
  "output": "output.txt",
  "sections": [
    { "heading": "标题", "level": 1 },
    { "text": "段落" },
    { "bullets": ["条目1", "条目2"] },
    { "numbered": ["步骤1", "步骤2"] },
    { "hr": true }
  ]
}
"""
import sys
import json
from pathlib import Path

def section_to_txt(section: dict) -> str:
    if "heading" in section:
        level = section.get("level", 1)
        text = section["heading"]
        underline = ("=" if level == 1 else "-") * len(text)
        return f"{text}\n{underline}\n"
    if "text" in section:
        return section["text"] + "\n"
    if "bullets" in section:
        return "\n".join(f"• {item}" for item in section["bullets"]) + "\n"
    if "numbered" in section:
        return "\n".join(f"{i+1}. {item}" for i, item in enumerate(section["numbered"])) + "\n"
    if "hr" in section:
        return "-" * 40 + "\n"
    return ""

def main():
    if len(sys.argv) < 2:
        print("用法: python3 gen_txt.py '<JSON>'", file=sys.stderr)
        sys.exit(1)

    data = json.loads(sys.argv[1])
    output_path = Path(data["output"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    encoding = data.get("encoding", "utf-8")

    if "content" in data:
        output_path.write_text(data["content"], encoding=encoding)
    else:
        parts = []
        for section in data.get("sections", []):
            txt = section_to_txt(section)
            if txt:
                parts.append(txt)
        output_path.write_text("\n".join(parts), encoding=encoding)

    print(str(output_path.resolve()))

if __name__ == "__main__":
    main()
