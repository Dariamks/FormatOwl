"""Use PDF rendering modes, not character count, to distinguish ink from OCR layers.

PDFium exposes the actual text render mode (PDF 32000 modes 3/7 paint no ink).
The original page stays untouched; only extraction excludes invisible text.
"""
from pypdfium2 import raw


def visible_chars(page, pdfium_page):
    text = pdfium_page.get_textpage()
    try:
        visible = []; hidden = 0
        for index in range(text.count_chars()):
            obj = raw.FPDFText_GetTextObject(text, index)
            if not obj: continue  # Generated line breaks have no PDF object.
            if raw.FPDFTextObj_GetTextRenderMode(obj) in (3, 7):
                hidden += 1
                continue
            left, bottom, right, top = text.get_charbox(index)
            visible.append((text.get_text_range(index, 1), left, page.height-top, right, page.height-bottom))
        if not hidden: return page.chars, False
        if not visible: return [], True
        chars = [c for c in page.chars if any(
            c['text'] == v[0] and abs(c['x0']-v[1]) < max(3, c['width']*.5)
            and min(c['bottom'],v[4])-max(c['top'],v[2]) > 0
            for v in visible)]
        return chars, True
    finally:
        text.close()
