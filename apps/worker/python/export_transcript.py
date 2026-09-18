import sys, json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from translate_file import font_path, direction, wrap_text
from xml.sax.saxutils import escape

def stamp(ms, sep='.'):
    seconds, millis=divmod(ms,1000)
    minutes, sec=divmod(seconds,60)
    hours, minute=divmod(minutes,60)
    return f'{hours:02d}:{minute:02d}:{sec:02d}{sep}{millis:03d}'

def export_transcript(data, options, output):
    output=str(output)
    speakers={s['id']:s['name'] for s in data['speakers']}
    segments=sorted([s for s in data['segments'] if s['text'].strip()], key=lambda s:(s['startMs'],s['endMs']))
    def text(s):
        label=speakers.get(s.get('speakerId'),'') if options['includeSpeakers'] else ''
        return (label+': ' if label else '')+s['text']
    fmt=options['format']
    if fmt in ['srt','vtt']:
        blocks=['WEBVTT\n'] if fmt=='vtt' else []
        for index,s in enumerate(segments,1):
            # Escape markup so editable text is displayed as text, never subtitle commands.
            content=escape('\n'.join(line for line in text(s).splitlines() if line.strip()))
            blocks.append(f"{index}\n{stamp(s['startMs'], ',' if fmt=='srt' else '.')} --> {stamp(s['endMs'], ',' if fmt=='srt' else '.')}\n{content}\n")
        Path(output).write_text('\n'.join(blocks),encoding='utf-8')
        return
    paragraphs=[(f"[{stamp(s['startMs'])}] " if options['includeTimestamps'] else '')+text(s) for s in segments]
    if fmt=='txt':
        Path(output).write_text('\n\n'.join(paragraphs)+'\n',encoding='utf-8')
    elif fmt=='docx':
        from docx import Document
        from docx.oxml.ns import qn
        from docx.oxml import OxmlElement
        document=Document()
        document.styles['Normal'].font.name='Noto Sans SC'
        fonts=document.styles['Normal'].element.get_or_add_rPr().get_or_add_rFonts()
        fonts.set(qn('w:eastAsia'),'Noto Sans SC')
        for p in paragraphs:
            paragraph=document.add_paragraph()
            for index,line in enumerate(p.split('\n')):
                if index:paragraph.add_run().add_break()
                run=paragraph.add_run(line);name=Path(font_path(line)).stem.replace('NotoSans','Noto Sans ').replace('-Regular','')
                run.font.name=name;fonts=run._element.get_or_add_rPr().get_or_add_rFonts()
                for attr in ['eastAsia','cs','ascii','hAnsi']:fonts.set(qn('w:'+attr),name)
                if direction(line)=='rtl':
                    run._element.get_or_add_rPr().append(OxmlElement('w:rtl'));paragraph._p.get_or_add_pPr().append(OxmlElement('w:bidi'))
        document.save(output)
    elif fmt=='pdf':
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Flowable
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib.utils import ImageReader
        from PIL import Image,ImageFont,ImageDraw
        class ArabicLine(Flowable):
            def __init__(self,text,width):
                super().__init__();self.text=text;self.width=width;self.height=18
            def draw(self):
                im=Image.new('RGBA',(round(self.width*3),54));font=ImageFont.truetype(font_path(self.text),30,layout_engine=ImageFont.Layout.RAQM)
                ImageDraw.Draw(im).text((im.width,0),self.text,font=font,fill='black',direction='rtl',anchor='ra')
                self.canv.drawImage(ImageReader(im),0,0,self.width,18,mask='auto')
                name=Path(font_path(self.text)).stem
                if name not in pdfmetrics.getRegisteredFontNames():pdfmetrics.registerFont(TTFont(name,font_path(self.text)))
                self.canv._code.append('/Span << /ActualText <FEFF'+self.text.encode('utf-16-be').hex().upper()+'> >> BDC')
                obj=self.canv.beginText(0,5);obj.setFont(name,10);obj.setTextRenderMode(3);obj.textOut(self.text);self.canv.drawText(obj);self.canv._code.append('EMC')
        flow=[]
        for p in paragraphs:
            for line in p.split('\n'):
                name=Path(font_path(line)).stem
                if name not in pdfmetrics.getRegisteredFontNames():pdfmetrics.registerFont(TTFont(name,font_path(line)))
                if direction(line)=='rtl':
                    font=ImageFont.truetype(font_path(line),30,layout_engine=ImageFont.Layout.RAQM)
                    flow.extend(ArabicLine(text,499) for text in wrap_text(line,font,1497))
                else:
                    style=ParagraphStyle('Transcript',fontName=name,fontSize=10,leading=16,wordWrap='CJK',splitLongWords=True)
                    flow.append(Paragraph(escape(line),style))
            flow.append(Spacer(1,8))
        SimpleDocTemplate(output,title='FormatOwl transcript',leftMargin=42,rightMargin=42,topMargin=42,bottomMargin=42).build(flow)
    else: raise ValueError('Unsupported format')

if __name__=='__main__':
    payload=json.loads(Path(sys.argv[1]).read_text())
    export_transcript(payload['data'],payload['options'],payload['output'])
