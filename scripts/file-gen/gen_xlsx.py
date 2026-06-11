#!/usr/bin/env python3
"""
gen_xlsx.py — 生成 .xlsx 文件
用法：python3 gen_xlsx.py '<JSON>'

JSON 格式：
{
  "output": "output.xlsx",
  "sheets": [
    {
      "name": "Sheet1",              // 可选，sheet 名
      "headers": ["列A", "列B"],     // 可选，表头行
      "rows": [                      // 数据行
        ["值1", "值2"],
        [1, 2]
      ],
      "column_widths": [20, 15]      // 可选，每列宽度（字符数）
    }
  ]
}
"""
import sys
import json
from pathlib import Path
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

HEADER_FILL = PatternFill("solid", fgColor="4472C4")
HEADER_FONT = Font(bold=True, color="FFFFFF")

def main():
    if len(sys.argv) < 2:
        print("用法: python3 gen_xlsx.py '<JSON>'", file=sys.stderr)
        sys.exit(1)

    data = json.loads(sys.argv[1])
    output_path = Path(data["output"])
    output_path.parent.mkdir(parents=True, exist_ok=True)

    wb = openpyxl.Workbook()
    wb.remove(wb.active)  # 删除默认 sheet

    for sheet_def in data.get("sheets", []):
        ws = wb.create_sheet(sheet_def.get("name", "Sheet"))
        row_idx = 1

        headers = sheet_def.get("headers", [])
        if headers:
            for col, header in enumerate(headers, 1):
                cell = ws.cell(row=row_idx, column=col, value=header)
                cell.font = HEADER_FONT
                cell.fill = HEADER_FILL
                cell.alignment = Alignment(horizontal="center")
            row_idx += 1

        for row in sheet_def.get("rows", []):
            for col, value in enumerate(row, 1):
                ws.cell(row=row_idx, column=col, value=value)
            row_idx += 1

        widths = sheet_def.get("column_widths", [])
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = w

    wb.save(str(output_path))
    print(str(output_path.resolve()))

if __name__ == "__main__":
    main()
