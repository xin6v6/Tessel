#!/usr/bin/env python3
"""
gen_pdf.py — 生成 .pdf 文件（基于 fpdf2，不依赖 LaTeX/pandoc）
用法：python3 gen_pdf.py '<JSON>'

JSON 格式：
{
  "output": "output.pdf",
  "title": "文档标题",               // 可选
  "sections": [
    { "heading": "一级标题", "level": 1 },
    { "text": "段落文字，支持换行" },
    { "bullets": ["条目1", "条目2"] },
    { "table": { "headers": ["列A","列B"], "rows": [["1","2"]] } },
    { "pagebreak": true }
  ]
}

注意：中文需要系统有对应字体。脚本自动查找 macOS/Linux 常见中文字体路径。
"""
import sys
import json
import os
from pathlib import Path
from fpdf import FPDF

ROOT = Path(os.environ.get("FILE_AGENT_ROOT", "tmp")).resolve()

def safe_output(raw):
    p = (ROOT / raw).resolve() if not Path(raw).is_absolute() else Path(raw).resolve()
    if p != ROOT and not str(p).startswith(str(ROOT) + os.sep):
        print("路径越界：{} 不在允许目录 {} 内".format(raw, ROOT), file=sys.stderr)
        sys.exit(1)
    return p

def find_cjk_font() -> str | None:
    # 优先找单文件 .ttf（fpdf2 对 .ttc 有中文字宽计算 bug）
    candidates = [
        "/Library/Fonts/Arial Unicode.ttf",
        "/Library/Fonts/Arial Unicode MS.ttf",
        # Linux
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttf",
        "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttf",
    ]
    # 用户字体目录 ttf
    candidates += list(Path.home().glob("Library/Fonts/*.ttf"))

    for p in candidates:
        if Path(p).exists():
            return str(p)
    return None


class TesPDF(FPDF):
    def __init__(self, font_path: str | None):
        super().__init__()
        self.font_path = font_path
        self.add_page()
        if font_path:
            self.add_font("CJK", "", font_path)
            self.set_font("CJK", size=11)
        else:
            self.set_font("Helvetica", size=11)

    def _mc(self, h: float, text: str):
        """multi_cell 包装：每次调用前重置 x，防止上次调用后 x 跑到右边距导致宽度为 0。"""
        self.set_x(self.l_margin)
        self.multi_cell(0, h, text)

    def use_font(self, size=11, bold=False):
        if self.font_path:
            self.set_font("CJK", size=size)
        else:
            style = "B" if bold else ""
            self.set_font("Helvetica", style=style, size=size)

    def add_heading(self, text: str, level: int = 1):
        sizes = {1: 16, 2: 14, 3: 12}
        self.ln(3)
        self.use_font(size=sizes.get(level, 12), bold=True)
        self._mc(8, text)
        self.use_font()
        self.ln(1)

    def add_paragraph(self, text: str):
        self._mc(7, text)
        self.ln(2)

    def add_bullet(self, item: str, numbered: int = 0):
        prefix = f"{numbered}. " if numbered else "• "
        self._mc(7, f"  {prefix}{item}")

    def add_table(self, headers: list, rows: list):
        self.ln(2)
        col_w = (self.w - self.l_margin - self.r_margin) / max(len(headers), 1)
        self.use_font(size=10, bold=True)
        self.set_x(self.l_margin)
        for h in headers:
            self.cell(col_w, 8, str(h), border=1, align="C")
        self.ln()
        self.use_font(size=10)
        for row in rows:
            self.set_x(self.l_margin)
            for cell_val in row:
                self.cell(col_w, 7, str(cell_val), border=1)
            self.ln()
        self.ln(2)
        self.use_font()


def main():
    if len(sys.argv) < 2:
        print("用法: python3 gen_pdf.py '<JSON>'", file=sys.stderr)
        sys.exit(1)

    data = json.loads(sys.argv[1])
    output_path = safe_output(data["output"])
    output_path.parent.mkdir(parents=True, exist_ok=True)

    font_path = find_cjk_font()
    pdf = TesPDF(font_path)

    title = data.get("title")
    if title:
        pdf.add_heading(title, level=1)

    for section in data.get("sections", []):
        if "pagebreak" in section:
            pdf.add_page()
        elif "heading" in section:
            pdf.add_heading(section["heading"], level=section.get("level", 1))
        elif "text" in section:
            pdf.add_paragraph(section["text"])
        elif "bullets" in section:
            for item in section["bullets"]:
                pdf.add_bullet(item)
            pdf.ln(2)
        elif "numbered" in section:
            for i, item in enumerate(section["numbered"], 1):
                pdf.add_bullet(item, numbered=i)
            pdf.ln(2)
        elif "table" in section:
            tbl = section["table"]
            pdf.add_table(tbl.get("headers", []), tbl.get("rows", []))

    pdf.output(str(output_path))
    print(str(output_path.resolve()))

if __name__ == "__main__":
    main()
