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
from pathlib import Path

def main():
    if len(sys.argv) < 2:
        print("用法: python3 gen_csv.py '<JSON>'", file=sys.stderr)
        sys.exit(1)

    data = json.loads(sys.argv[1])
    output_path = Path(data["output"])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    encoding = data.get("encoding", "utf-8-sig")

    with open(output_path, "w", newline="", encoding=encoding) as f:
        writer = csv.writer(f)
        if headers := data.get("headers"):
            writer.writerow(headers)
        for row in data.get("rows", []):
            writer.writerow(row)

    print(str(output_path.resolve()))

if __name__ == "__main__":
    main()
