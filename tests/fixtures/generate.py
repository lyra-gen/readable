"""Builds the extraction test fixtures in tests/fixtures/files from content.json.

Run on macOS with scripts/make-fixtures.sh, which supplies the tools: the
Python from Readable's managed Docling install (python-docx, python-pptx,
openpyxl, odfdo, Pillow, pillow-heif), headless Chrome for text-layer PDFs,
`say` for speech, `sips` for HEIC, the managed ffmpeg for audio and video,
and LibreOffice for the old binary Office files (.doc, .xls, .ppt and their
templates), saved from the .docx/.xlsx/.pptx built here.
The iWork files (iwork-en.*) are not built here: they are Docling's own test
files (tests/data in docling-project/docling, MIT licence).
The outputs are committed, so tests never need these tools.
"""

import html
import json
import os
import random
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "files")
CONTENT = json.load(open(os.path.join(HERE, "content.json"), encoding="utf-8"))
CHROME = os.environ["CHROME"]
FFMPEG = os.environ["FFMPEG"]
SOFFICE = os.environ.get("SOFFICE", "/Applications/LibreOffice.app/Contents/MacOS/soffice")
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
VOICES = {"en": "Samantha", "ru": "Milena"}


def out(name):
    return os.path.join(OUT, name)


def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def text_file(lang, c):
    with open(out(f"text-{lang}.txt"), "w", encoding="utf-8") as f:
        f.write("\n\n".join([c["title"], *c["lines"]]) + "\n")


def html_page(c, two_pages=False):
    rows = "".join(
        "<tr>" + "".join(f"<{'th' if i == 0 else 'td'}>{html.escape(cell)}</{'th' if i == 0 else 'td'}>" for cell in row) + "</tr>"
        for i, row in enumerate(c["table"])
    )
    second = (
        f'<h2 style="page-break-before: always">{html.escape(c["page2"][0])}</h2><p>{html.escape(c["page2"][1])}</p>' if two_pages else ""
    )
    body = "".join(f"<p>{html.escape(line)}</p>" for line in c["lines"])
    return (
        '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial;margin:48px}'
        "table{border-collapse:collapse}td,th{border:1px solid #333;padding:6px 14px}</style></head>"
        f"<body><h1>{html.escape(c['title'])}</h1>{body}<table>{rows}</table>{second}</body></html>"
    )


def web_page(lang, c):
    with open(out(f"web-{lang}.html"), "w", encoding="utf-8") as f:
        f.write(html_page(c))


def print_pdf(html_text, name):
    with tempfile.TemporaryDirectory() as tmp:
        page = os.path.join(tmp, "page.html")
        with open(page, "w", encoding="utf-8") as f:
            f.write(html_text)
        run(
            CHROME,
            "--headless=new",
            "--disable-gpu",
            "--no-pdf-header-footer",
            f"--user-data-dir={os.path.join(tmp, 'profile')}",
            f"--print-to-pdf={out(name)}",
            f"file://{page}",
        )


def pdf_text(lang, c):
    print_pdf(html_page(c, two_pages=True), f"pdf-text-{lang}.pdf")


def pdf_long(lang, c):
    """pdf-text-en.pdf six times over: twelve pages, more than one page chunk, for resuming."""
    if lang != "en":
        return
    import pypdfium2

    source = pypdfium2.PdfDocument(out("pdf-text-en.pdf"))
    long = pypdfium2.PdfDocument.new()
    for _ in range(6):
        long.import_pages(source)
    long.save(out("pdf-long-en.pdf"))


def render_page(c, width=1240, height=1754, scale=1.0):
    """A white A4-ish page with the title, lines and a ruled table, as a scanner would see it."""
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    title = ImageFont.truetype(FONT_BOLD, int(56 * scale))
    body = ImageFont.truetype(FONT, int(36 * scale))
    y = int(120 * scale)
    draw.text((100, y), c["title"], fill="black", font=title)
    y += int(110 * scale)
    for line in c["lines"]:
        draw.text((100, y), line, fill="black", font=body)
        y += int(64 * scale)
    y += int(40 * scale)
    col = int(260 * scale)
    row_h = int(64 * scale)
    for r, row in enumerate(c["table"]):
        for i, cell in enumerate(row):
            x = 100 + i * col
            draw.rectangle([x, y, x + col, y + row_h], outline="black", width=2)
            draw.text((x + 16, y + 14), cell, fill="black", font=body)
        y += row_h
    return image


def pdf_scan(lang, c):
    render_page(c).save(out(f"pdf-scan-{lang}.pdf"), "PDF", resolution=150)


def screenshot(lang, c):
    """An app window: title bar, sidebar, and the content as UI text."""
    image = Image.new("RGB", (1440, 900), "#f5f5f7")
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, 1440, 52], fill="#e3e3e6")
    for i, colour in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
        draw.ellipse([20 + i * 26, 18, 36 + i * 26, 34], fill=colour)
    draw.rectangle([0, 52, 300, 900], fill="#ececef")
    small = ImageFont.truetype(FONT, 24)
    for i, item in enumerate(c["table"][1:] + [c["table"][0]]):
        draw.text((32, 90 + i * 48), item[0], fill="#333", font=small)
    draw.text((360, 100), c["title"], fill="#111", font=ImageFont.truetype(FONT_BOLD, 44))
    for i, line in enumerate(c["lines"]):
        draw.text((360, 190 + i * 56), line, fill="#222", font=ImageFont.truetype(FONT, 30))
    image.save(out(f"screenshot-{lang}.png"))


def photo(lang, c):
    """Text on a paper-coloured page, slightly rotated, noisy and JPEG-compressed, like a phone photo."""
    random.seed(lang)
    page = render_page(c, scale=0.9).convert("RGB")
    page = Image.blend(page, Image.new("RGB", page.size, "#efe6d2"), 0.25)
    page = page.rotate(1.5, expand=True, fillcolor="#8a7f6d", resample=Image.BICUBIC)
    noise = Image.effect_noise(page.size, 18).convert("RGB")
    page = Image.blend(page, noise, 0.06).filter(ImageFilter.GaussianBlur(0.6))
    page.save(out(f"photo-{lang}.jpg"), quality=72)


def heic(lang):
    run("sips", "-s", "format", "heic", out(f"photo-{lang}.jpg"), "--out", out(f"photo-{lang}.heic"))


def docx(lang, c):
    from docx import Document

    document = Document()
    document.add_heading(c["title"], level=1)
    for line in c["lines"]:
        document.add_paragraph(line)
    table = document.add_table(rows=len(c["table"]), cols=len(c["table"][0]))
    table.style = "Table Grid"
    for r, row in enumerate(c["table"]):
        for i, cell in enumerate(row):
            table.cell(r, i).text = cell
    document.save(out(f"doc-{lang}.docx"))


def pptx(lang, c):
    from pptx import Presentation
    from pptx.util import Inches

    deck = Presentation()
    slide = deck.slides.add_slide(deck.slide_layouts[1])
    slide.shapes.title.text = c["title"]
    slide.placeholders[1].text = "\n".join(c["lines"])
    second = deck.slides.add_slide(deck.slide_layouts[5])
    second.shapes.title.text = c["page2"][0]
    rows, cols = len(c["table"]), len(c["table"][0])
    shape = second.shapes.add_table(rows, cols, Inches(1), Inches(2), Inches(6), Inches(2))
    for r, row in enumerate(c["table"]):
        for i, cell in enumerate(row):
            shape.table.cell(r, i).text = cell
    deck.save(out(f"slides-{lang}.pptx"))


def xlsx(lang, c):
    from openpyxl import Workbook

    book = Workbook()
    sheet = book.active
    sheet.title = "Data"
    sheet.append([c["title"]])
    for line in c["lines"]:
        sheet.append([line])
    sheet.append([])
    for row in c["table"]:
        sheet.append([int(v) if v.isdigit() else v for v in row])
    book.save(out(f"sheet-{lang}.xlsx"))


def opendocument(lang, c):
    from odfdo import Document, DrawPage, Frame, Header, Paragraph, Table

    rows = [[int(v) if v.isdigit() else v for v in row] for row in c["table"]]

    def table(name, values):
        t = Table(name, width=max(len(r) for r in values), height=len(values))
        t.set_values([r + [None] * (t.width - len(r)) for r in values])
        return t

    text = Document("text")
    text.body.clear()
    text.body.append(Header(1, c["title"]))
    for line in c["lines"]:
        text.body.append(Paragraph(line))
    text.body.append(table("Table", rows))
    text.save(out(f"doc-{lang}.odt"))

    sheet = Document("spreadsheet")
    sheet.body.clear()
    sheet.body.append(table("Data", [[c["title"]], *[[line] for line in c["lines"]], [None], *rows]))
    sheet.save(out(f"sheet-{lang}.ods"))

    deck = Document("presentation")
    deck.body.clear()
    first = DrawPage("p1")
    first.append(Frame.text_frame([c["title"], *c["lines"]], size=("24cm", "14cm"), position=("2cm", "2cm")))
    second = DrawPage("p2")
    second.append(Frame.text_frame(c["page2"], size=("24cm", "14cm"), position=("2cm", "2cm")))
    deck.body.append(first)
    deck.body.append(second)
    deck.save(out(f"slides-{lang}.odp"))


# Old binary Office formats: extension -> (LibreOffice filter, the modern file it is saved from)
LEGACY = {
    "doc": ("MS Word 97", "doc-{lang}.docx"),
    "dot": ("MS Word 97 Vorlage", "doc-{lang}.docx"),
    "xls": ("MS Excel 97", "sheet-{lang}.xlsx"),
    "xlt": ("MS Excel 97 Vorlage/Template", "sheet-{lang}.xlsx"),
    "ppt": ("MS PowerPoint 97", "slides-{lang}.pptx"),
    "pot": ("MS PowerPoint 97 Vorlage", "slides-{lang}.pptx"),
    "pps": ("MS PowerPoint 97 AutoPlay", "slides-{lang}.pptx"),
}
# Templates in English only; the formats themselves in both languages, since old files store text in code pages
LEGACY_LANGS = {"doc": ("en", "ru"), "xls": ("en", "ru"), "ppt": ("en", "ru"), "dot": ("en",), "xlt": ("en",), "pot": ("en",), "pps": ("en",)}
LEGACY_STEM = {"doc": "doc", "dot": "doc", "xls": "sheet", "xlt": "sheet", "ppt": "slides", "pot": "slides", "pps": "slides"}


def legacy(lang, c):
    for ext, (filter_name, source) in LEGACY.items():
        if lang not in LEGACY_LANGS[ext]:
            continue
        with tempfile.TemporaryDirectory() as tmp:
            run(
                SOFFICE, f"-env:UserInstallation=file://{tmp}/profile", "--headless", "--norestore",
                "--convert-to", f"{ext}:{filter_name}", "--outdir", tmp, out(source.format(lang=lang)),
            )
            produced = os.path.join(tmp, os.path.splitext(source.format(lang=lang))[0] + f".{ext}")
            os.replace(produced, out(f"{LEGACY_STEM[ext]}-{lang}.{ext}"))


def speech(lang, c):
    with tempfile.TemporaryDirectory() as tmp:
        aiff = os.path.join(tmp, "speech.aiff")
        run("say", "-v", VOICES[lang], "-o", aiff, c["speech"])
        run(FFMPEG, "-y", "-i", aiff, "-ac", "1", "-ar", "22050", "-b:a", "48k", out(f"audio-{lang}.mp3"))
        if lang == "en":
            # A second container: AAC in .m4a, the iPhone voice-memo format
            run(FFMPEG, "-y", "-i", aiff, "-ac", "1", "-c:a", "aac", "-b:a", "48k", out("audio-en.m4a"))
        run(
            FFMPEG, "-y", "-f", "lavfi", "-i", "color=c=0x2b3a55:s=640x360:r=15", "-i", aiff,
            "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "48k", out(f"video-{lang}.mp4"),
        )


def invoice_ru():
    """A Russian invoice as a scanned page: numbers in a table and a total, for picture descriptions."""
    image = Image.new("RGB", (1240, 900), "white")
    draw = ImageDraw.Draw(image)
    bold = ImageFont.truetype(FONT_BOLD, 40)
    body = ImageFont.truetype(FONT, 30)
    draw.text((80, 70), "Счёт на оплату № 1047 от 14 октября 2026 г.", fill="black", font=bold)
    draw.text((80, 140), "Поставщик: ООО «Северный ветер», г. Самара", fill="black", font=body)
    draw.text((80, 185), "Покупатель: АО «Сибирские сети»", fill="black", font=body)
    rows = [("Товар", "Кол-во", "Сумма, руб."), ("Бумага офисная А4", "40 пачек", "12 400"), ("Картридж для принтера", "6 шт.", "21 600")]
    y = 270
    widths = [560, 220, 260]
    for r, row in enumerate(rows):
        x = 80
        for i, cell in enumerate(row):
            draw.rectangle([x, y, x + widths[i], y + 64], outline="black", width=2)
            draw.text((x + 14, y + 16), cell, fill="black", font=bold if r == 0 else body)
            x += widths[i]
        y += 64
    draw.text((80, y + 50), "Итого к оплате: 34 000 руб.", fill="black", font=bold)
    draw.text((80, y + 110), "НДС не облагается.", fill="black", font=body)
    image.save(out("invoice-ru.png"))


def main():
    os.makedirs(OUT, exist_ok=True)
    only = set(sys.argv[1:])
    for lang, c in CONTENT.items():
        for build in (text_file, web_page, pdf_text, pdf_long, pdf_scan, screenshot, photo, docx, pptx, xlsx, legacy, opendocument, speech):
            if only and build.__name__ not in only:
                continue
            build(lang, c)
        if lang == "ru" and (not only or "invoice_ru" in only):
            invoice_ru()
        if not only or "heic" in only:
            if lang == "en":
                heic(lang)
    for name in sorted(os.listdir(OUT)):
        print(f"{os.path.getsize(out(name)):>9}  {name}")


if __name__ == "__main__":
    main()
