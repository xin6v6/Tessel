# file-gen 预制脚本

File Agent 可直接调用这些脚本生成文件，无需现场写代码。所有脚本接收一个 JSON 字符串作为第一个参数，输出生成文件的绝对路径。

## 可用脚本

| 脚本 | 生成格式 | 依赖 |
|------|---------|------|
| `gen_docx.py` | Word (.docx) | python-docx |
| `gen_xlsx.py` | Excel (.xlsx) | openpyxl |
| `gen_pdf.py`  | PDF (.pdf)   | fpdf2 |
| `gen_csv.py`  | CSV (.csv)   | 标准库 |
| `gen_md.py`   | Markdown (.md) | 标准库 |
| `gen_txt.py`  | 纯文本 (.txt)  | 标准库 |

## 调用方式

```bash
python3 /path/to/scripts/file-gen/gen_docx.py '<JSON>'
python3 /path/to/scripts/file-gen/gen_xlsx.py '<JSON>'
python3 /path/to/scripts/file-gen/gen_pdf.py  '<JSON>'
python3 /path/to/scripts/file-gen/gen_csv.py  '<JSON>'
python3 /path/to/scripts/file-gen/gen_md.py   '<JSON>'
python3 /path/to/scripts/file-gen/gen_txt.py  '<JSON>'
```

## JSON 结构速查

### gen_docx.py
```json
{
  "output": "tmp/report.docx",
  "title": "文档标题",
  "sections": [
    { "heading": "一级标题", "level": 1 },
    { "text": "普通段落" },
    { "bullets": ["条目1", "条目2"] },
    { "numbered": ["步骤1", "步骤2"] },
    { "code": "def foo(): pass" },
    { "table": { "headers": ["列A","列B"], "rows": [["1","2"]] } }
  ]
}
```

### gen_xlsx.py
```json
{
  "output": "tmp/data.xlsx",
  "sheets": [
    {
      "name": "数据",
      "headers": ["姓名", "分数"],
      "rows": [["张三", 95], ["李四", 87]],
      "column_widths": [20, 10]
    }
  ]
}
```

### gen_pdf.py
```json
{
  "output": "tmp/report.pdf",
  "title": "报告标题",
  "sections": [
    { "heading": "章节", "level": 1 },
    { "text": "内容" },
    { "bullets": ["要点1", "要点2"] },
    { "table": { "headers": ["列A","列B"], "rows": [["1","2"]] } },
    { "pagebreak": true }
  ]
}
```

### gen_csv.py
```json
{
  "output": "tmp/data.csv",
  "headers": ["列A", "列B"],
  "rows": [["值1", "值2"], [1, 2]]
}
```

### gen_md.py / gen_txt.py
```json
{
  "output": "tmp/doc.md",
  "sections": [
    { "heading": "标题", "level": 1 },
    { "text": "段落" },
    { "code": "print('hi')", "lang": "python" },
    { "hr": true },
    { "raw": "任意原始内容" }
  ]
}
```
