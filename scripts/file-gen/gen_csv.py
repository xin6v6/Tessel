#!/usr/bin/env python3
"""
gen_csv.py — 生成 .csv 文件
用法：python3 gen_csv.py '<JSON>'

JSON 格式：
{
  "output": "output.csv",
  "headers": ["列A", "列B", "列C"],   // 可选，表头
  "rows": [
    ["值1", "值2", "值3"],
    [1, 2, 3]
  ],
  "encoding": "utf-8-sig"             // 可选，默认 utf-8-sig（Excel 兼容）
}
"""
import sys
import json
import csv
import os
from pathlib import Path

ROOT = Path(os.environ.get("FILE_AGENT_ROOT") or (Path(__file__).parent.parent.parent / "tmp")).resolve()

def safe_output(raw):
    p = (ROOT / raw).resolve() if not Path(raw).is_absolute() else Path(raw).resolve()
    if p != ROOT and not str(p).startswith(str(ROOT) + os.sep):
        print("路径越界：{} 不在允许目录 {} 内".format(raw, ROOT), file=sys.stderr)
        sys.exit(1)
    return p

def main():
    if len(sys.argv) < 2:
        print("用法: python3 gen_csv.py '<JSON>'", file=sys.stderr)
        sys.exit(1)

    data = json.loads(sys.argv[1])
    output_path = safe_output(data["output"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    encoding = data.get("encoding", "utf-8-sig")

    with open(output_path, "w", newline="", encoding=encoding) as f:
        writer = csv.writer(f)
        headers = data.get("headers")
        if headers:
            writer.writerow(headers)
        for row in data.get("rows", []):
            writer.writerow(row)

    print(str(output_path.resolve()))

if __name__ == "__main__":
    main()
