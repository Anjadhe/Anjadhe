#!/usr/bin/env python3
"""Generate the OOXML demo fixtures (scripts/demo-files/): the job-sheet
spreadsheet and the baseline resume. Companion to generate-demo-fixtures.js
(which renders the PDFs). Standard-library only — xlsx/docx are just zips
of XML.

    python3 scripts/generate-demo-fixtures.py
"""
import os
import zipfile

OUT = os.path.join(os.path.dirname(__file__), "demo-files")
os.makedirs(OUT, exist_ok=True)


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


# ── jobsheet-week.xlsx ────────────────────────────────────────────────────

ROWS = [
    ["Date", "Site", "Miles", "Materials ($)", "Notes"],
    ["Mon Jul 27", "Lakeline warehouse", 18, 42.50, "Replacement belts, conveyor 2"],
    ["Tue Jul 28", "Mueller office park", 7, 0, "Quarterly inspection only"],
    ["Wed Jul 29", "Lakeline warehouse", 18, 113.20, "Drive motor + fasteners"],
    ["Thu Jul 30", "Round Rock condo", 24, 36.00, "HVAC filters (2)"],
    ["", "", "", "", ""],
    ["TOTAL", "", 67, 191.70, ""],
]


def cell(ref, v):
    if isinstance(v, (int, float)) and v != "":
        return f'<c r="{ref}"><v>{v}</v></c>'
    if v == "":
        return ""
    return f'<c r="{ref}" t="inlineStr"><is><t>{esc(v)}</t></is></c>'


def sheet_xml(rows):
    body = []
    for r, row in enumerate(rows, start=1):
        cells = "".join(cell(f"{chr(65 + c)}{r}", v) for c, v in enumerate(row))
        body.append(f'<row r="{r}">{cells}</row>')
    return ('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f'<sheetData>{"".join(body)}</sheetData></worksheet>')


with zipfile.ZipFile(os.path.join(OUT, "jobsheet-week.xlsx"), "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml",
               '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
               '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
               '<Default Extension="xml" ContentType="application/xml"/>'
               '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
               '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
    z.writestr("_rels/.rels",
               '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    z.writestr("xl/workbook.xml",
               '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
               'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
               '<sheets><sheet name="Week of Jul 27" sheetId="1" r:id="rId1"/></sheets></workbook>')
    z.writestr("xl/_rels/workbook.xml.rels",
               '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
    z.writestr("xl/worksheets/sheet1.xml", sheet_xml(ROWS))
print("  xlsx  jobsheet-week.xlsx")


# ── baseline-resume.docx ──────────────────────────────────────────────────

RESUME = [
    ("h1", "Emily Carter"),
    ("p", "Austin, TX · emily@carterconsulting.example · (512) 555-0184"),
    ("h2", "Summary"),
    ("p", "Product manager with 8 years across B2B SaaS platforms. Ships metrics-driven roadmaps with engineering, design, and data science."),
    ("h2", "Experience"),
    ("h3", "Fernwood Software — Senior Product Manager (2022–present)"),
    ("li", "Own the search and platform roadmap; cut p95 search latency 38%"),
    ("li", "Led a 3-team quarterly release train; 11 consecutive on-time releases"),
    ("li", "Introduced experiment review; 40% of launches now A/B gated"),
    ("h3", "Brightpath Analytics — Product Manager (2018–2022)"),
    ("li", "Shipped public API v2 used by 300+ integrators"),
    ("li", "Partnered with hardware vendors on an edge-gateway integration"),
    ("h2", "Skills"),
    ("p", "Roadmapping, experimentation, SQL, API design, executive communication"),
]


def para(kind, text):
    if kind == "h1":
        rpr, sz = '<w:b/><w:sz w:val="40"/>', ""
    elif kind == "h2":
        rpr, sz = '<w:b/><w:sz w:val="26"/>', ""
    elif kind == "h3":
        rpr, sz = '<w:b/>', ""
    else:
        rpr, sz = "", ""
    bullet = "• " if kind == "li" else ""
    return (f'<w:p><w:r><w:rPr>{rpr}</w:rPr>'
            f'<w:t xml:space="preserve">{bullet}{esc(text)}</w:t></w:r></w:p>')


doc = ('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
       + "".join(para(k, t) for k, t in RESUME) + "</w:body></w:document>")

with zipfile.ZipFile(os.path.join(OUT, "baseline-resume.docx"), "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml",
               '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
               '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
               '<Default Extension="xml" ContentType="application/xml"/>'
               '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr("_rels/.rels",
               '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr("word/document.xml", doc)
print("  docx  baseline-resume.docx")
print("done -> " + OUT)
