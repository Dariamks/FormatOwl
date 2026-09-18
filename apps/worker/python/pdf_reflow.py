"""Readable PDF pagination. Source coordinates are immutable; output positions are a manifest."""
import copy
import json
import os
import subprocess
import re
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.pdfgen.textobject import PDFTextObject
from reportlab.lib.rl_accel import fp_str
from reportlab.platypus import BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, PageBreak, Image, LongTable, TableStyle
from pdf_flow import compose_page, furniture

ASSETS = Path(__file__).resolve().parent.parent / 'assets'
ENGINE = 'filemorph-reflow-4'


class ReflowTextObject(PDFTextObject):
    def setRise(self, rise):
        # ReportLab 5.0.1 shaping can set a glyph offset with an empty operator
        # buffer. Scope the fix to this renderer rather than patching the library.
        command=f'{fp_str(rise)} Ts'
        if self._code and self._code[-1].endswith(' Ts'):
            self._y += self._rise
            self._code[-1]=command
        else:self._code.append(command)
        self._rise=rise
        self._y-=rise


class ReflowCanvas(Canvas):
    def beginText(self, x=0, y=0, direction=None):
        return ReflowTextObject(self,x,y,direction=direction)


def font_name(text, style):
    if re.search('[\u0600-\u08ff]', text): family = 'NotoSansArabic'
    elif re.search('[\uac00-\ud7af]', text): family = 'NotoSansKR'
    elif re.search('[\u3040-\u30ff]', text): family = 'NotoSansJP'
    elif re.search('[\u2460-\u24ff\u2e80-\u9fff\uff00-\uffef]', text): family = 'NotoSansSC'
    else: family = 'NotoSerif' if style.get('fontFamily', 'serif') == 'serif' else 'NotoSans'
    variant = 'BoldItalic' if style.get('bold') and style.get('italic') else 'Bold' if style.get('bold') else 'Italic' if style.get('italic') else 'Regular'
    path = ASSETS / f'{family}-{variant}.ttf'
    if not path.exists() and style.get('bold'):path = ASSETS / f'{family}-Bold.ttf'
    if not path.exists(): path = ASSETS / f'{family}-Regular.ttf'
    if not path.exists(): raise ValueError('FONT_UNAVAILABLE')
    name = path.stem
    if name not in pdfmetrics.getRegisteredFontNames(): pdfmetrics.registerFont(TTFont(name, str(path)))
    return name


def markup(text, style):
    # Choose a font per script so embedded Latin, Cyrillic and Arabic remain searchable.
    parts = re.split(r'([\u0600-\u08ff]+|[\u2460-\u24ff\u2e80-\u9fff\uff00-\uffef]+|[\uac00-\ud7af]+)', text)
    return ''.join(f'<font name="{font_name(p, style)}">{escape(p).replace(chr(10), "<br/>")}</font>' for p in parts if p)


class TrackedParagraph(Paragraph):
    def split(self, availWidth, availHeight):
        parts = super().split(availWidth, availHeight)
        for part in parts:
            part.block_id = self.block_id
            part.member_ids = self.member_ids
            part.manifest = self.manifest
        return parts

    def drawOn(self, canvas, x, y, _sW=0):
        super().drawOn(canvas, x, y, _sW)
        ax, ay = canvas.absolutePosition(x, y)
        self.manifest[-1]['regions'].append({'id': self.block_id, 'memberIds': self.member_ids, 'box': {
            'x': ax, 'y': canvas._pagesize[1] - ay - self.height,
            'width': self.width, 'height': self.height, 'angle': 0}})


class TrackedImage(Image):
    def drawOn(self, canvas, x, y, _sW=0):
        super().drawOn(canvas, x, y, _sW)
        ax, ay = canvas.absolutePosition(x + (_sW / 2 if self.hAlign == 'CENTER' else 0), y)
        top = canvas._pagesize[1] - ay - self.drawHeight
        for anchor in self.anchors:
            b = anchor['box']; crop = self.source_box
            self.manifest[-1]['regions'].append({'id': anchor['id'], 'memberIds': anchor['memberIds'], 'box': {
                'x': ax+(b['x']-crop['x'])*self.drawWidth/crop['width'],
                'y': top+(b['y']-crop['y'])*self.drawHeight/crop['height'],
                'width': b['width']*self.drawWidth/crop['width'],
                'height': b['height']*self.drawHeight/crop['height'], 'angle': 0}})


def paragraph(block, page, manifest, folder, max_width):
    style = block['style']; scale = page.get('scale', 1)
    size = max(10, min(32, style['fontSize'] / scale))
    if block['kind'] == 'heading' and not block.get('layoutEdited'): size = max(14, size)
    text = block['sourceText'] if block.get('keepOriginal') else block.get('translatedText') or block['sourceText']
    rtl = bool(re.search('[\u0600-\u08ff]', text))
    ps = ParagraphStyle('body', fontName=font_name(text, style), fontSize=size, leading=size*1.4,
        spaceAfter=size*.5, alignment=2 if rtl or style.get('align') == 'right' else 1 if style.get('align') == 'center' else 0,
        textColor=colors.HexColor(style['color']), wordWrap='RTL' if rtl else 'CJK' if re.search('[\u2e80-\u9fff\uff00-\uffef\uac00-\ud7af]', text) and not any(s.get('math') or s.get('box') for s in block.get('inline',[])) else None,
        splitLongWords=1, allowWidows=0, allowOrphans=0, shaping=not bool(re.search('[\u2e80-\u9fff]',text)),
        keepWithNext=block['kind'] == 'heading' or block.get('_keepWithNext', False))
    content = markup(text, style)
    math_assets = page.get('_mathAssets',{})
    if block.get('_scriptInserts'):
        pieces=[];cursor=0
        for insertion in sorted(block['_scriptInserts'],key=lambda i:i['offset']):
            offset=insertion['offset'];tag='sub' if insertion['script']=='subscript' else 'super'
            pieces.extend([markup(text[cursor:offset],style),f'<{tag}>'+markup(insertion['text'],style)+f'</{tag}>']);cursor=offset
        pieces.append(markup(text[cursor:],style));content=''.join(pieces)
    spans = block.get('inline', [])
    translated = {s['id']: s['text'] for s in block.get('translatedInline', [])}
    if spans and (block.get('keepOriginal') or translated):
        chunks = []
        for span in spans:
            if span.get('math'):
                asset=math_assets[span['math']]
                width=size*asset['width'];height=size*asset['height']
                factor=min(1,max_width/max(1,width))
                chunks.append(f'<img src="{escape(str(Path(folder)/asset["file"]))}" width="{width*factor}" height="{height*factor}" valign="{-size*asset["depth"]*factor}"/>')
            elif span.get('protected') and span.get('box') and page.get('originalFile'):
                from PIL import Image as PILImage
                box = span['box']; path = Path(folder) / f"inline-{block['id']}-{span['id']}.png"
                with PILImage.open(Path(folder)/page['originalFile']) as image:
                    image.crop((box['x'], box['y'], box['x']+box['width'], box['y']+box['height'])).save(path)
                height = min(size*1.5, box['height']/scale)
                width = min(max_width, height*box['width']/box['height'])
                chunks.append(f'<img src="{escape(str(path))}" width="{width}" height="{height}" valign="middle"/>')
            else:
                value = span['text'] if block.get('keepOriginal') or span.get('protected') else translated.get(span['id'], span['text'])
                chunk = markup(value, {**style, **{k:span[k] for k in ('bold','italic') if k in span}})
                if span.get('superscript'): chunk = '<super>'+chunk+'</super>'
                if span.get('subscript'): chunk = '<sub>'+chunk+'</sub>'
                chunks.append(chunk)
        content = ''.join(chunks)
    if not block.get('keepOriginal') and not block.get('translatedText'):
        content = markup('[Awaiting translation] ', {**style, 'bold':True}) + content
    p = TrackedParagraph(content or '&#160;', ps)
    p.block_id = block['id']; p.member_ids = block.get('memberIds',[block['id']]); p.manifest = manifest
    return p


def image_block(block, page, folder, manifest, width, height):
    from PIL import Image as PILImage
    box = block.get('originalBox') or block.get('box')
    if not box or not page.get('originalFile'): return None
    path = Path(folder)/f"figure-{block['id']}.png"
    with PILImage.open(Path(folder)/page['originalFile']) as image:
        image.crop((box['x'],box['y'],box['x']+box['width'],box['y']+box['height'])).save(path)
    scale = min(1/page.get('scale',1), width/box['width'], height/box['height'])
    item = TrackedImage(str(path), width=box['width']*scale, height=box['height']*scale, hAlign='CENTER')
    item.block_id=block['id'];item.member_ids=block.get('memberIds',[block['id']]);item.manifest=manifest
    item.source_box=box
    item.anchors=block.get('_anchorBoxes',[{'id':block['id'],'memberIds':item.member_ids,'box':box}])
    return item


def render(data, folder, output, source=None, mode='translated'):
    """Paginate each source page into one or more target pages, retaining exact block anchors."""
    from pypdf import PdfReader, PdfWriter
    folder=Path(folder); output=Path(output); writer=PdfWriter(); manifest=[]; review=set()
    data=copy.deepcopy(data)
    formulas=sorted({s['math'] for b in data['blocks'] if not b.get('hidden') and b['kind'] not in ('figure','formula') for s in b.get('inline',[]) if s.get('math')})
    assets={}
    if formulas:
        params=folder/'math-input.json';result=folder/'math-result.json'
        params.write_text(json.dumps({'formulas':formulas,'folder':str(folder.resolve()),'result':str(result.resolve())}))
        subprocess.run([os.environ.get('NODE_PATH_EXECUTABLE','node'),str(Path(__file__).with_name('render_math.mjs')),str(params)],check=True,timeout=60,capture_output=True)
        assets=json.loads(result.read_text())
    for page in data['pages']:page['_mathAssets']=assets
    original=PdfReader(source) if source and mode=='bilingual' else None
    roles=furniture(data)
    for page in data['pages']:
        scale=page.get('scale',1); width=page['width']/scale; height=page['height']/scale
        margin=min(42,width*.07,height*.07); usable=width-2*margin
        local=[]
        def on_page(canvas, doc):
            local.append({'index':len(manifest)+len(local),'sourcePage':page['index'],'width':width,'height':height,'regions':[]})
            canvas.saveState();canvas.setFont('Helvetica',8);canvas.setFillColor(colors.HexColor('#8b929a'))
            canvas.drawCentredString(width/2,margin/2,f"{len(manifest)+len(local)}")
            canvas.restoreState()
        target=folder/f"reflow-{page['index']}.pdf"
        doc=BaseDocTemplate(str(target),pagesize=(width,height),leftMargin=margin,rightMargin=margin,topMargin=margin,bottomMargin=margin,invariant=1)
        doc.addPageTemplates(PageTemplate(id='reading',frames=[Frame(margin,margin,usable,height-2*margin,leftPadding=0,rightPadding=0,topPadding=0,bottomPadding=0)],onPage=on_page))
        story=[]; handled_tables=set()
        blocks=sorted([b for b in data['blocks'] if b['page']==page['index'] and not b.get('hidden')],key=lambda b:b.get('order', data['blocks'].index(b)))
        # Collect review state before aliases are composed into shared visuals.
        review.update(b['id'] for b in blocks if b.get('review') or (not b.get('keepOriginal') and not b.get('translatedText')))
        blocks=compose_page(blocks,roles)
        for block in blocks:
            review.update([block['id']] if block.get('review') or (not block.get('keepOriginal') and not block.get('translatedText')) else [])
            if block.get('figureId'):continue
            if block['kind'] in ('figure','formula'):
                item=image_block(block,page,folder,local,usable,height-2*margin-12)
                if item: story += [item,Spacer(1,8)]
                if block['kind']=='figure':
                    for caption in block.get('_figureCaptions',[block] if block.get('translatedText') else []):
                        story.append(paragraph({**caption,'kind':'caption','keepOriginal':False},page,local,folder,usable))
                continue
            table=block.get('table')
            if table:
                if table['id'] in handled_tables:continue
                handled_tables.add(table['id'])
                cells=[b for b in blocks if b.get('table',{}).get('id')==table['id']]
                rows=[['' for _ in range(table['columns'])] for _ in range(table['rows'])];spans=[];headers=set()
                for cell in cells:
                    t=cell['table'];r,c=t['row'],t['column'];cell=copy.deepcopy(cell);cell['style']['fontSize']=max(10*scale,cell['style']['fontSize'])
                    value=paragraph(cell,page,local,folder,usable/table['columns'])
                    if rows[r][c]=='':rows[r][c]=[value]
                    else:rows[r][c].append(value)
                    if t['header']:headers.add(r)
                    if t['rowSpan']>1 or t['columnSpan']>1:spans.append(('SPAN',(c,r),(c+t['columnSpan']-1,r+t['rowSpan']-1)))
                repeated=0
                while repeated in headers:repeated+=1
                item=LongTable(rows,colWidths=[usable/table['columns']]*table['columns'],repeatRows=repeated,splitByRow=1,splitInRow=1,hAlign='LEFT')
                item.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),('GRID',(0,0),(-1,-1),.4,colors.HexColor('#b7bec8')),('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6),*spans]))
                story += [item,Spacer(1,10)]
            else: story.append(paragraph(block,page,local,folder,usable))
        if not story:
            # Blank/undeciphered pages remain visible; never invent text.
            full={'id':f"page-{page['index']}",'box':{'x':0,'y':0,'width':page['width'],'height':page['height']}}
            item=image_block(full,page,folder,local,usable,height-2*margin-12)
            story=[item] if item else [Spacer(1,1)]
        doc.build(story,canvasmaker=ReflowCanvas)
        if original:writer.add_page(original.pages[page['index']])
        for rendered in PdfReader(target).pages:writer.add_page(rendered)
        manifest.extend(local)
        if len(manifest)>500:raise ValueError('DOCUMENT_LIMIT')
    writer.write(output)
    return {'overflow':[],'format':'pdf','regions':[],'pages':manifest,'review':sorted(review),'engine':ENGINE}
