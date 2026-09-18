"""Bounded, offline file extraction and rendering. Cloud calls live in the worker."""
import sys, json, re, math, zipfile, os, hashlib, shutil, tempfile, subprocess
from pathlib import Path, PurePosixPath
from io import BytesIO
from xml.sax.saxutils import escape
from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageChops, ImageStat
from lxml import etree
from translation_layout import paragraph_blocks,expand_regions,render_data
from structured_inlines import extract_inline,write_inline,EPUB_BLOCKS

if sys.platform=='darwin':
    os.environ.setdefault('DYLD_FALLBACK_LIBRARY_PATH','/opt/homebrew/lib:/usr/local/lib:/usr/lib')

ASSETS=Path(__file__).resolve().parent.parent/'assets'
MAX_CHARACTERS=100000
MAX_PAGES=100
Image.MAX_IMAGE_PIXELS=100000000
NS={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main','x':'http://www.w3.org/1999/xhtml','opf':'http://www.idpf.org/2007/opf'}
PARSER=etree.XMLParser(resolve_entities=False,no_network=True,load_dtd=False,huge_tree=False)

def read_xml(raw):
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper(): raise ValueError('UNSAFE_DOCUMENT')
    return etree.fromstring(raw,PARSER)

def safe_zip(path):
    z=zipfile.ZipFile(path)
    infos=z.infolist()
    if len(infos)>10000 or sum(i.file_size for i in infos)>300*1024**2: raise ValueError('DOCUMENT_LIMIT')
    names=set()
    for i in infos:
        p=PurePosixPath(i.filename)
        if i.filename in names or p.is_absolute() or '..' in p.parts or '\\' in i.filename or i.flag_bits&1 or i.file_size>100*1024**2 or i.file_size>max(1,i.compress_size)*1000: raise ValueError('UNSAFE_DOCUMENT')
        names.add(i.filename)
    return z

def block(text,index,page=0,kind='text',box=None,locator=None):
    size=max(8,min(48,(box or {}).get('height',20)*.7))
    return {'id':f'b{index}','sourceText':text,'translatedText':'','page':page,'kind':kind,'style':{'fontSize':size,'color':'#111111','align':'left'},'review':[],'stale':False,'keepOriginal':kind=='formula',**({'box':box,'originalBox':dict(box)} if box else {}),**({'locator':locator} if locator else {})}

def formula_fragment(text,font=''):
    if re.search(r'[\u4e00-\u9fff]{3}|[A-Za-z]{4}',text):return False
    return bool(re.search(r'[=∑∫√\ue000-\uf8ff]',text) or re.search(r'math|symbol|mtextra|cmsy|cmex|cmmi',font,re.I)
        or re.fullmatch(r'\s*[A-Za-z]{1,3}\s*',text)
        or (len(text)<30 and re.search(r'\d',text) and re.search(r'[A-Za-zα-ωΑ-Ω]',text)))

def font_path(text):
    if re.search('[\u0600-\u08ff]',text): name='NotoSansArabic-Regular.ttf'
    elif re.search('[\uac00-\ud7af]',text): name='NotoSansKR-Regular.ttf'
    elif re.search('[\u3040-\u30ff]',text): name='NotoSansJP-Regular.ttf'
    else: name='NotoSansSC-Regular.ttf'
    p=ASSETS/name
    if not p.exists(): raise ValueError('FONT_UNAVAILABLE')
    return str(p)

def direction(text): return 'rtl' if re.search('[\u0600-\u08ff]',text) else 'ltr'

def image_input(path,fmt):
    if fmt=='svg':
        root=read_xml(Path(path).read_bytes())
        for node in root.iter():
            if etree.QName(node).localname in ('script','foreignObject','animate','animateTransform','set'): raise ValueError('UNSAFE_DOCUMENT')
            for key,value in node.attrib.items():
                if etree.QName(key).localname.lower().startswith('on') or ('href' in key and not value.startswith('#')) or re.search(r'url\(\s*(?!#)',value): raise ValueError('UNSAFE_DOCUMENT')
            if node.text and re.search(r'@import|url\(\s*(?!#)',node.text): raise ValueError('UNSAFE_DOCUMENT')
        import cairosvg
        png=cairosvg.svg2png(bytestring=etree.tostring(root),unsafe=False)
        image=Image.open(BytesIO(png))
    else: image=Image.open(path)
    if image.width*image.height>100000000 or getattr(image,'n_frames',1)!=1: raise ValueError('IMAGE_LIMIT')
    return ImageOps.exif_transpose(image).convert('RGBA')

def extract(payload):
    source,fmt,folder=payload['source'],payload['format'],Path(payload['folder'])
    folder.mkdir(parents=True,exist_ok=True)
    pages=[];blocks=[]
    if fmt in ('jpg','jpeg','png','webp','svg'):
        im=image_input(source,fmt);im.save(folder/'page-0.png')
        pages=[{'index':0,'width':im.width,'height':im.height,'title':'1','originalFile':'page-0.png','backgroundFile':'page-0.png','needsOcr':True}]
    elif fmt=='pdf':
        import pdfplumber, pypdfium2 as pdfium
        from pypdf import PdfReader,PdfWriter
        r=PdfReader(source)
        if r.is_encrypted: raise ValueError('ENCRYPTED_PDF')
        if len(r.pages)>MAX_PAGES: raise ValueError('DOCUMENT_LIMIT')
        if any('/Sig' in str(f.get('/FT','')) for f in (r.get_fields() or {}).values()): raise ValueError('SIGNED_PDF')
        w=PdfWriter(clone_from=r);w.remove_text();w.write(folder/'background.pdf')
        original=pdfium.PdfDocument(source);background=pdfium.PdfDocument(str(folder/'background.pdf'))
        with pdfplumber.open(source) as pdf:
            for index,p in enumerate(pdf.pages):
                scale=2
                im=original[index].render(scale=scale).to_pil().convert('RGBA');im.save(folder/f'page-{index}.png')
                bg=background[index].render(scale=scale).to_pil().convert('RGBA');bg.save(folder/f'background-{index}.png')
                from pdf_text_layer import visible_chars
                chars, hidden_text = visible_chars(p, original[index])
                visible_ids = {id(c) for c in chars}
                text_page = p.filter(lambda o: o.get('object_type') != 'char' or id(o) in visible_ids)
                words=text_page.extract_words(x_tolerance=3,y_tolerance=3,keep_blank_chars=False,extra_attrs=['size','fontname'])
                cells=[]
                try:
                    for table in p.find_tables():
                        cells.extend(c for c in table.cells if c)
                except Exception:pass
                cell_words={}
                regular=[]
                for word in words:
                    cell=next((i for i,c in enumerate(cells) if c[0]<=word['x0'] and c[2]>=word['x1'] and c[1]<=word['top'] and c[3]>=word['bottom']),None)
                    if cell is None:regular.append(word)
                    else:cell_words.setdefault(cell,[]).append(word)
                for cell,items in cell_words.items():
                    x,y,r,bottom=cells[cell];text=' '.join(v['text'] for v in items)
                    box={'x':x*scale+3,'y':y*scale+3,'width':max(2,(r-x)*scale-6),'height':max(4,(bottom-y)*scale-6),'angle':0}
                    b=block(text,len(blocks),index,'table',box);b['style']['fontSize']=sorted(v['size'] for v in items)[len(items)//2]*scale;b['raster']=False;blocks.append(b)
                lines=[]
                for word in regular:
                    line=next((line for line in reversed(lines[-5:]) if abs(line['top']-word['top'])<3 and word['x0']-line['x1']<max(18,word['size']*2) and word['x0']>=line['x0']),None)
                    if line:
                        line['text']+=' '+word['text'];line['x1']=word['x1'];line['bottom']=max(line['bottom'],word['bottom'])
                    else: lines.append(dict(word))
                for line in lines:
                    text=line['text'].strip()
                    if not text: continue
                    box={'x':max(0,line['x0']*scale),'y':max(0,line['top']*scale),'width':min(im.width-line['x0']*scale,max(2,(line['x1']-line['x0'])*scale)),'height':min(im.height-line['top']*scale,max(4,(line['bottom']-line['top'])*scale*1.2)),'angle':0}
                    kind='formula' if formula_fragment(text,line.get('fontname','')) else 'text'
                    b=block(text,len(blocks),index,kind,box);b['style']['fontSize']=line['size']*scale;b['raster']=False;blocks.append(b)
                image_area=sum(max(0,i['x1']-i['x0'])*max(0,i['bottom']-i['top']) for i in p.images)
                obstacles=[]
                for figure in [*p.images,*p.curves,*p.rects]:
                    if figure['x1']-figure['x0']>3 and figure['bottom']-figure['top']>3 and (figure['x1']-figure['x0'])*(figure['bottom']-figure['top'])<p.width*p.height*.8:
                        obstacles.append({'x':figure['x0']*scale,'y':figure['top']*scale,'width':(figure['x1']-figure['x0'])*scale,'height':(figure['bottom']-figure['top'])*scale})
                pages.append({'index':index,'width':im.width,'height':im.height,'title':str(index+1),'originalFile':f'page-{index}.png','backgroundFile':f'background-{index}.png','scale':scale,'obstacles':obstacles,'textSource':'ocr' if not chars else 'mixed' if hidden_text else 'native','needsOcr':not words or hidden_text or image_area>p.width*p.height*.15})
        blocks=paragraph_blocks(blocks)
        for b in blocks:b.pop('memberIds',None)
        blocks=expand_regions(blocks,pages)
    elif fmt=='txt':
        raw=Path(source).read_bytes()
        try: text=raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            try:text=raw.decode('utf-16')
            except UnicodeDecodeError: raise ValueError('TEXT_ENCODING')
        if '\x00' in text: raise ValueError('TEXT_ENCODING')
        for i,part in enumerate(re.split(r'(\r?\n(?:[ \t]*\r?\n)+)',text)):
            if part.strip():blocks.append(block(part,len(blocks),locator={'part':'text','index':i}))
        pages=[{'index':0,'width':800,'height':1000,'title':'Text'}]
    elif fmt=='docx':
        with safe_zip(source) as z:
            if 'word/document.xml' not in z.namelist(): raise ValueError('INVALID_DOCUMENT')
            for name in z.namelist():
                if name.endswith('.rels'):
                    root=read_xml(z.read(name))
                    # Links remain links; externally linked media must never be fetched.
                    if any(n.get('TargetMode')=='External' and not n.get('Type','').endswith('/hyperlink') for n in root):raise ValueError('UNSAFE_DOCUMENT')
            for name in sorted(z.namelist(),key=lambda n:(n!='word/document.xml',n)):
                if not re.fullmatch(r'word/(document|header\d+|footer\d+|footnotes|endnotes)\.xml',name):continue
                root=read_xml(z.read(name))
                for index,p in enumerate(root.xpath('//w:p',namespaces=NS)):
                    texts=p.xpath('.//w:t[not(ancestor::w:del)]',namespaces=NS)
                    text=''.join(s['text'] for s in extract_inline(p,'docx'))
                    if not text.strip():continue
                    style=p.find('w:pPr/w:pStyle',NS)
                    kind='heading' if style is not None and 'heading' in str(style.get('{'+NS['w']+'}val')).lower() else 'table' if p.xpath('ancestor::w:tc',namespaces=NS) else 'text'
                    b=block(text,len(blocks),kind=kind,locator={'part':name,'index':index})
                    b['inline']=extract_inline(p,'docx');blocks.append(b)
        pages=[{'index':0,'width':800,'height':1000,'title':'Document'}]
    elif fmt=='epub':
        with safe_zip(source) as z:
            if 'META-INF/encryption.xml' in z.namelist(): raise ValueError('ENCRYPTED_DOCUMENT')
            container=read_xml(z.read('META-INF/container.xml'))
            opf=container.xpath('//*[local-name()="rootfile"]')[0].get('full-path')
            root=read_xml(z.read(opf));base=PurePosixPath(opf).parent
            manifest={n.get('id'):n.get('href') for n in root.xpath('//opf:manifest/opf:item',namespaces=NS)}
            spine=[n.get('idref') for n in root.xpath('//opf:spine/opf:itemref',namespaces=NS)]
            if len(spine)>MAX_PAGES:raise ValueError('DOCUMENT_LIMIT')
            for page,ident in enumerate(spine):
                name=str(base/manifest[ident])
                if '..' in PurePosixPath(name).parts:raise ValueError('UNSAFE_DOCUMENT')
                root=read_xml(z.read(name))
                if root.xpath('//*[local-name()="script"]'):raise ValueError('UNSAFE_DOCUMENT')
                title=root.xpath('//*[local-name()="title"]/text()')
                pages.append({'index':page,'width':800,'height':1000,'title':title[0] if title else f'Chapter {page+1}'})
                for index,node in enumerate(epub_nodes(root,True)):
                    text=''.join(s['text'] for s in extract_inline(node,'epub')).strip()
                    if text:
                        b=block(text,len(blocks),page,'heading' if etree.QName(node).localname.startswith('h') else 'text',locator={'part':name,'index':index})
                        b['inline']=extract_inline(node,'epub');blocks.append(b)
    else:raise ValueError('UNSUPPORTED_FORMAT')
    if sum(len(b['sourceText']) for b in blocks)>MAX_CHARACTERS or len(blocks)>20000:raise ValueError('TRANSLATION_LIMIT')
    return {'extractionVersion':2,'layoutVersion':2,'inlineVersion':1,'format':fmt,'pages':pages,'blocks':blocks,'sourceLanguage':payload['sourceLanguage'],'targetLanguage':payload['targetLanguage']}

def epub_nodes(root, structured=False):
    if structured:return [n for n in root.iter() if isinstance(n.tag,str) and etree.QName(n).localname in EPUB_BLOCKS and any(s['text'].strip() for s in extract_inline(n,'epub'))]
    tags=['p','h1','h2','h3','h4','h5','h6','li','td','th','figcaption','blockquote','dt','dd']
    # Only leaf blocks: nested lists/tables must not be translated twice.
    return [n for n in root.iter() if isinstance(n.tag,str) and etree.QName(n).localname in tags and not any(isinstance(c.tag,str) and etree.QName(c).localname in tags for c in n.iterdescendants())]

def content(b,mode):
    if b.get('keepOriginal') or mode=='original':return b['sourceText']
    if mode=='bilingual':return b['sourceText']+'\n'+b['translatedText']
    return b['translatedText']

def wrap_text(text,font,width):
    draw=ImageDraw.Draw(Image.new('RGB',(1,1)));out=[]
    for paragraph in text.split('\n'):
        tokens=re.findall(r'\S+\s*|\s+',paragraph) if not re.search('[\u2e80-\u9fff\uac00-\ud7af]',paragraph) else list(paragraph)
        current=''
        for token in tokens:
            if draw.textlength(current+token,font=font,direction=direction(text))<=width:current+=token;continue
            if current:out.append(current.rstrip());current=''
            for char in token:
                if draw.textlength(current+char,font=font,direction=direction(text))>width and current:out.append(current);current=''
                current+=char
        out.append(current.rstrip())
    return out

def layout(b,text):
    box=b['box'];size=b['style']['fontSize'];minimum=max(4,min(size,size*.65))
    while True:
        font=ImageFont.truetype(font_path(text),max(1,round(size)),layout_engine=ImageFont.Layout.RAQM)
        lines=wrap_text(text,font,max(1,box['width']-2));height=len(lines)*size*1.25
        if height<=box['height'] or size<=minimum:break
        size=max(minimum,size-1)
    return lines,font,size,height>box['height']+.1

def region_mask(size,box):
    mask=Image.new('L',size,0);cx=box['x']+box['width']/2;cy=box['y']+box['height']/2;angle=math.radians(box.get('angle',0));cos,sin=math.cos(angle),math.sin(angle)
    points=[(cx+x*cos-y*sin,cy+x*sin+y*cos) for x,y in [(-box['width']/2,-box['height']/2),(box['width']/2,-box['height']/2),(box['width']/2,box['height']/2),(-box['width']/2,box['height']/2)]]
    ImageDraw.Draw(mask).polygon(points,fill=255)
    return mask

def flat_background(original,box):
    """Only replace verified flat text patches; textured/photo regions use the AI repair."""
    if abs(box.get('angle',0))>1:return None
    x,y=math.floor(box['x']),math.floor(box['y']);right=math.ceil(box['x']+box['width']);bottom=math.ceil(box['y']+box['height'])
    if x<0 or y<0 or right>original.width or bottom>original.height or right-x<6 or bottom-y<6:return None
    crop=original.crop((x,y,right,bottom)).convert('RGB');w,h=crop.size
    edges=[crop.crop(r) for r in [(0,0,w,2),(0,h-2,w,h),(0,2,2,h-2),(w-2,2,w,h-2)]]
    colours={}
    for edge in edges:
        for count,colour in edge.getcolors(edge.width*edge.height):colours[colour]=colours.get(colour,0)+count
    base=max(colours,key=colours.get)
    near=lambda v:max(abs(v[i]-base[i]) for i in range(3))<=6
    if sum(count for colour,count in colours.items() if near(colour))/sum(colours.values())<.995:return None
    if sum(count for count,colour in crop.getcolors(w*h) if near(colour))/(w*h)<.5:return None
    return base

def image_render(data,folder,page_index,mode):
    page=data['pages'][page_index];original=Image.open(folder/page['originalFile']).convert('RGBA')
    if mode=='original':return original,[]
    image=Image.open(folder/page['backgroundFile']).convert('RGBA');errors=[]
    for b in data['blocks']:
        if b['page']!=page_index or not b.get('box'):continue
        if b.get('keepOriginal') or b.get('hidden') or not b.get('translatedText'):
            image.paste(original,(0,0),region_mask(image.size,b.get('originalBox',b['box'])));continue
        source_box=b.get('originalBox',b['box']);flat=flat_background(original,source_box)
        if flat is not None:image.paste((*flat,255),(0,0,image.width,image.height),region_mask(image.size,source_box))
        text=content(b,mode);lines,font,size,overflow=layout(b,text)
        if overflow:
            errors.extend(b.get('memberIds',[b['id']]));image.paste(original,(0,0),region_mask(image.size,b.get('originalBox',b['box'])));continue
        box=b['box'];layer=Image.new('RGBA',(max(1,math.ceil(box['width'])),max(1,math.ceil(box['height']))));draw=ImageDraw.Draw(layer)
        align=b['style'].get('align','left');align='right' if direction(text)=='rtl' else align
        for index,line in enumerate(lines):
            x=layer.width if align=='right' else layer.width/2 if align=='center' else 0
            anchor='rt' if align=='right' else 'mt' if align=='center' else 'lt'
            draw.text((x,index*size*1.25),line,font=font,fill=b['style']['color'],anchor=anchor,direction=direction(text))
        rotated=layer.rotate(-box.get('angle',0),resample=Image.Resampling.BICUBIC,expand=True)
        image.alpha_composite(rotated,(round(box['x']+(box['width']-rotated.width)/2),round(box['y']+(box['height']-rotated.height)/2)))
    # Retain source alpha, including transparent pixels in repaired regions.
    image.putalpha(original.getchannel('A'))
    return image,errors

def restore_region(payload):
    image=Image.open(payload['background']).convert('RGBA');orig=Image.open(payload['original']).convert('RGBA');patch=Image.open(payload['patch']).convert('RGBA')
    crop=payload['crop'];box=payload['box']
    if 'inputWidth' in crop:
        patch=patch.resize((crop['inputWidth'],crop['inputHeight']),Image.Resampling.LANCZOS)
        patch=patch.crop((crop['offsetX'],crop['offsetY'],crop['offsetX']+crop['width'],crop['offsetY']+crop['height']))
    else:patch=patch.resize((crop['width'],crop['height']),Image.Resampling.LANCZOS)
    layer=image.copy();layer.paste(patch,(crop['x'],crop['y']))
    flat=flat_background(orig,box)
    if flat is not None:layer.paste((*flat,255),(0,0,layer.width,layer.height),region_mask(layer.size,box))
    image.paste(layer,(0,0),region_mask(image.size,box));image.putalpha(orig.getchannel('A'));image.save(payload['output'])
    return {'file':Path(payload['output']).name}

def background_collision(background,b,draw_height):
    """Native PDF formulas and figures survive text removal. Never paint across them.

    Check the area actually occupied by the laid-out paragraph. A small inset keeps
    cell borders out of the check; a uniform page/cell colour is not foreground ink.
    Raster/OCR pages have repaired backgrounds and use the image review workflow.
    """
    if b.get('raster') is not False:return False
    box=b['box'];pad=2
    crop=background.crop((math.floor(box['x']+pad),math.floor(box['y']+pad),
        math.ceil(box['x']+box['width']-pad),math.ceil(box['y']+min(box['height'],draw_height)-pad))).convert('RGB') if box['width']>pad*2 and min(box['height'],draw_height)>pad*2 else None
    if crop is None:return False
    base=tuple(ImageStat.Stat(crop).median)
    mask=ImageChops.difference(crop,Image.new('RGB',crop.size,base)).convert('L').point(lambda v:255 if v>48 else 0)
    bounds=mask.getbbox()
    if not bounds or bounds[2]-bounds[0]<=2 or bounds[3]-bounds[1]<=2:return False
    return mask.histogram()[255]>max(10,b['style']['fontSize']*.5)

def pdf_render(data,folder,output,mode):
    data=render_data(data)
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import Paragraph
    from reportlab.lib.styles import ParagraphStyle
    c=canvas.Canvas(str(output));errors=[]
    for p in data['pages']:
        scale=p.get('scale',1);width,height=p['width']/scale,p['height']/scale;c.setPageSize((width,height))
        if mode in ('original','bilingual'):
            c.drawImage(str(folder/p['originalFile']),0,0,width,height);c.showPage()
            if mode=='original':continue
        bg=Image.open(folder/p['backgroundFile']).convert('RGBA');original_background=bg.copy();orig=Image.open(folder/p['originalFile']).convert('RGBA')
        for b in data['blocks']:
            if b['page']!=p['index'] or not b.get('box'):continue
            if b.get('keepOriginal') or b.get('hidden') or not b.get('translatedText'):
                    bg.paste(orig,(0,0),region_mask(bg.size,b.get('originalBox',b['box'])))
        c.drawImage(ImageReader(bg),0,0,width,height,mask='auto')
        for b in data['blocks']:
            if b['page']!=p['index'] or b.get('keepOriginal') or b.get('hidden') or not b.get('translatedText') or not b.get('box'):continue
            text=b['translatedText'];box=b['box'];name=Path(font_path(text)).stem
            if b.get('raster') is False and box['width']<b['style']['fontSize']*3 and text.strip()!=b['sourceText'].strip() and re.search(r'[A-Za-z]{4}',text):
                errors.extend(b.get('memberIds',[b['id']]));restore_pdf_block(c,orig,b,scale,height);continue
            if direction(text)=='rtl':
                lines,font,size,overflow=layout(b,text)
                if overflow or background_collision(original_background,b,len(lines)*size*1.25):
                    errors.extend(b.get('memberIds',[b['id']]));restore_pdf_block(c,orig,b,scale,height);continue
                layer=Image.new('RGBA',(max(1,math.ceil(box['width'])),max(1,math.ceil(box['height']))));draw=ImageDraw.Draw(layer)
                for index,line in enumerate(lines):draw.text((layer.width,index*size*1.25),line,font=font,fill=b['style']['color'],anchor='ra',direction='rtl')
                c.saveState();c.translate(box['x']/scale,height-box['y']/scale);c.rotate(-box.get('angle',0))
                c.drawImage(ImageReader(layer),0,-box['height']/scale,box['width']/scale,box['height']/scale,mask='auto')
                if name not in pdfmetrics.getRegisteredFontNames():pdfmetrics.registerFont(TTFont(name,font_path(text)))
                c._code.append('/Span << /ActualText <FEFF'+text.encode('utf-16-be').hex().upper()+'> >> BDC')
                obj=c.beginText(0,-size/scale);obj.setFont(name,size/scale);obj.setTextRenderMode(3);obj.textOut(text);c.drawText(obj);c._code.append('EMC');c.restoreState();continue
            if name not in pdfmetrics.getRegisteredFontNames():pdfmetrics.registerFont(TTFont(name,font_path(text)))
            size=b['style']['fontSize']/scale;minimum=max(4/scale,size*.65)
            while True:
                style=ParagraphStyle('translated',fontName=name,fontSize=size,leading=size*1.25,wordWrap='RTL' if direction(text)=='rtl' else 'CJK',alignment=2 if direction(text)=='rtl' or b['style'].get('align')=='right' else 1 if b['style'].get('align')=='center' else 0,textColor=b['style']['color'],shaping=True)
                paragraph=Paragraph(escape(text).replace('\n','<br/>'),style);pw,ph=paragraph.wrap(box['width']/scale,box['height']/scale)
                if ph<=box['height']/scale or size<=minimum:break
                size=max(minimum,size-1/scale)
            if ph>box['height']/scale+.01 or background_collision(original_background,b,ph*scale):
                errors.extend(b.get('memberIds',[b['id']]));restore_pdf_block(c,orig,b,scale,height);continue
            c.saveState();c.translate(box['x']/scale,height-box['y']/scale);c.rotate(-box.get('angle',0));paragraph.drawOn(c,0,-ph);c.restoreState()
        c.showPage()
    c.save()
    return errors

def restore_pdf_block(canvas,original,b,scale,page_height):
    from reportlab.lib.utils import ImageReader
    box=b.get('originalBox',b['box']);crop=original.crop((box['x'],box['y'],box['x']+box['width'],box['y']+box['height']))
    canvas.drawImage(ImageReader(crop),box['x']/scale,page_height-(box['y']+box['height'])/scale,box['width']/scale,box['height']/scale,mask='auto')

def preview_page(payload):
    import copy,pypdfium2 as pdfium
    data=copy.deepcopy(payload['data']);page=payload['page'];folder=Path(payload['folder']);output=Path(payload['output'])
    data['blocks']=[b for b in data['blocks'] if b['page']==page]
    if data['format']=='pdf':
        # Preserve page indices for lookup while rendering only the requested page.
        prepared=render_data(data);p=prepared['pages'][page];p['index']=0
        prepared['pages']=[p]
        for b in prepared['blocks']:b['page']=0
        prepared['layoutVersion']=2
        pdf=output.with_suffix('.pdf');errors=pdf_render(prepared,folder,pdf,'translated')
        doc=pdfium.PdfDocument(str(pdf));doc[0].render(scale=p.get('scale',1)).to_pil().save(output)
    else:
        prepared=data;im,errors=image_render(data,folder,page,'translated');im.save(output)
    return {'overflow':errors,'regions':[{'id':b['id'],'memberIds':b.get('memberIds',[b['id']]),'box':b['box']} for b in prepared['blocks'] if b.get('box')]}

def structured_export(data,source,output,mode):
    fmt=data['format']
    if fmt=='txt':
        raw=Path(source).read_bytes();original=raw.decode('utf-8-sig') if not raw.startswith((b'\xff\xfe',b'\xfe\xff')) else raw.decode('utf-16')
        parts=re.split(r'(\r?\n(?:[ \t]*\r?\n)+)',original)
        for b in data['blocks']:parts[b['locator']['index']]=content(b,mode)
        encoding='utf-16' if raw.startswith((b'\xff\xfe',b'\xfe\xff')) else 'utf-8-sig' if raw.startswith(b'\xef\xbb\xbf') else 'utf-8'
        Path(output).write_bytes(''.join(parts).encode(encoding));return
    with safe_zip(source) as z,zipfile.ZipFile(output,'w') as out:
        groups={}
        for b in data['blocks']:groups.setdefault(b['locator']['part'],[]).append(b)
        for info in z.infolist():
            raw=z.read(info.filename)
            if info.filename in groups:
                root=read_xml(raw)
                if fmt=='docx':
                    nodes=root.xpath('//w:p',namespaces=NS)
                    for b in groups[info.filename]:
                        p=nodes[b['locator']['index']];target=p
                        if mode=='bilingual' and not b.get('keepOriginal'):
                            import copy
                            target=copy.deepcopy(p);p.addnext(target)
                        write_inline(target,'docx',b,'translated' if mode=='bilingual' else mode)
                        if direction(content(b,mode))=='rtl':
                            pr=target.find('w:pPr',NS)
                            if pr is None:pr=etree.Element('{'+NS['w']+'}pPr');target.insert(0,pr)
                            etree.SubElement(pr,'{'+NS['w']+'}bidi')
                else:
                    nodes=epub_nodes(root,bool(data.get('inlineVersion')))
                    for b in groups[info.filename]:
                        n=nodes[b['locator']['index']]
                        if mode=='bilingual' and not b.get('keepOriginal'):
                            import copy
                            target=copy.deepcopy(n)
                            write_inline(target,'epub',b,'translated')
                            # A bilingual parent must not clone its nested list/table
                            # again: those blocks each receive their own translation.
                            for child in list(target.iterdescendants()):
                                if not isinstance(child.tag,str) or etree.QName(child).localname not in EPUB_BLOCKS:continue
                                parent=child.getparent()
                                if parent is None:continue
                                tail=child.tail or '';previous=child.getprevious()
                                if previous is None:parent.text=(parent.text or '')+tail
                                else:previous.tail=(previous.tail or '')+tail
                                parent.remove(child)
                            if etree.QName(n).localname in ('body','div','section','article'):
                                target.tag='{'+etree.QName(n).namespace+'}p' if etree.QName(n).namespace else 'p';n.append(target)
                            else:n.addnext(target)
                        else:target=n
                        if mode!='bilingual' or b.get('keepOriginal'):write_inline(target,'epub',b,mode)
                        target.set('dir',direction(content(b,mode)))
                raw=etree.tostring(root,xml_declaration=True,encoding='UTF-8')
            out.writestr(info,raw)

def export(payload):
    data=payload['data'];folder=Path(payload['folder']);output=Path(payload['output']);options=payload['options'];fmt=options['format'];mode=options['mode']
    if data['format'] in ('docx','epub','txt'):
        structured_export(data,payload['source'],output,mode);return {'overflow':[]}
    if data['format']=='pdf':
        if mode=='original':shutil.copyfile(payload['source'],output);return {'overflow':[]}
        if data.get('layoutVersion',0)>=3:
            from pdf_reflow import render
            return render(data,folder,output,payload['source'],mode)
        errors=pdf_render(data,folder,output,'translated')
        if mode=='bilingual' and not errors:
            from pypdf import PdfReader,PdfWriter
            source=PdfReader(payload['source']);translated=PdfReader(output);writer=PdfWriter()
            for i,page in enumerate(source.pages):writer.add_page(page);writer.add_page(translated.pages[i])
            writer.write(output)
        return {'overflow':errors}
    if fmt=='txt':output.write_text('\n\n'.join(content(b,mode) for b in data['blocks'] if not b.get('hidden')),encoding='utf-8');return {'overflow':[]}
    im,errors=image_render(data,folder,0,mode)
    if fmt=='jpg':
        bg=Image.new('RGB',im.size,'white');bg.paste(im,mask=im.getchannel('A'));bg.save(output,quality=95)
    elif fmt=='webp':im.save(output,format='WEBP',lossless=True)
    else:im.save(output,format='PNG')
    return {'overflow':errors}

def tiles(payload):
    im=Image.open(payload['source']);folder=Path(payload['folder']);result=[]
    if im.width*im.height<=8388608 and max(im.size)<=4096:
        im.save(folder/'tile-0-0.png')
        return {'tiles':[{'file':'tile-0-0.png','x':0,'y':0,'width':im.width,'height':im.height}]}
    # Overlap protects text crossing tile boundaries. Ownership is resolved in the worker.
    size=1600;overlap=160
    for y in range(0,im.height,size-overlap):
        for x in range(0,im.width,size-overlap):
            w,h=min(size,im.width-x),min(size,im.height-y);name=f'tile-{x}-{y}.png';im.crop((x,y,x+w,y+h)).save(folder/name)
            result.append({'file':name,'x':x,'y':y,'width':w,'height':h})
    return {'tiles':result}

def ocr_layout(payload):
    original=Image.open(payload['source']).convert('RGB');blocks=payload['blocks']
    for b in blocks:
        box=b['box']
        if abs(box.get('angle',0))<2:box['angle']=0;b['originalBox']['angle']=0
        crop=original.crop((box['x'],box['y'],box['x']+box['width'],box['y']+box['height']))
        base=tuple(ImageStat.Stat(crop).median)
        colours=[(count,colour) for count,colour in crop.getcolors(crop.width*crop.height) if max(abs(v-base[i]) for i,v in enumerate(colour))>45]
        if colours:b['style']['color']='#' + ''.join(f'{v:02x}' for v in max(colours,key=lambda c:c[0])[1])
    grouped=paragraph_blocks(blocks)
    for b in grouped:
        b.pop('memberIds',None)
        box=b['box'];pad=max(4,min(16,math.ceil(b['style']['fontSize']*.25)));x=max(0,box['x']-pad);y=max(0,box['y']-pad)
        padded={**box,'x':x,'y':y,'width':min(original.width-x,box['x']+box['width']+pad-x),'height':min(original.height-y,box['y']+box['height']+pad-y)}
        # Only enlarge the source cleanup region when it cannot touch another text region.
        from translation_layout import intersects
        if any(other['id']!=b['id'] and intersects(padded,other['box']) for other in grouped):
            padded=dict(box)
        b['originalBox']=padded
        b['localRepair']=flat_background(original,padded) is not None
        if b['localRepair']:
            b['style']['fontSize']=min(96,b['style']['fontSize']*1.25)
            box['height']=min(padded['y']+padded['height']-box['y'],max(box['height'],b['style']['fontSize']*1.25))
    return {'blocks':grouped}

def main(payload):
    action=payload['action']
    if action=='extract':return extract(payload)
    if action=='structure-pdf':
        from pdf_structure import structure_pdf
        return structure_pdf(payload)
    if action=='reflow':
        from pdf_reflow import render
        return render(payload['data'],payload['folder'],payload['output'],payload.get('source'))
    if action=='export':return export(payload)
    if action=='preview':return preview_page(payload)
    if action=='mindmap':
        graph=payload['map'];im=Image.new('RGB',(math.ceil(graph['width']),math.ceil(graph['height'])),'#f8faf6');draw=ImageDraw.Draw(im)
        nodes={n['id']:n for n in graph['nodes']}
        for n in nodes.values():
            if n['parentId']:
                p=nodes[n['parentId']];x=p['x']+p['width'];y=p['y']+p['height']/2;ny=n['y']+n['height']/2
                draw.line([(x,y),(x+22,y),(n['x']-22,ny),(n['x'],ny)],fill='#a3b295',width=2)
        for n in nodes.values():
            draw.rounded_rectangle((n['x'],n['y'],n['x']+n['width'],n['y']+n['height']),radius=12,fill='#ffffff' if n['parentId'] else '#edf3e7',outline='#bdcbb2')
            for i,line in enumerate(n['lines']):
                font=ImageFont.truetype(font_path(line),16,layout_engine=ImageFont.Layout.RAQM)
                draw.text((n['x']+14,n['y']+12+i*22),line,font=font,fill='#293526',direction=direction(line))
        im.save(payload['output']);return {}
    if action=='compose':return restore_region(payload)
    if action=='tiles':return tiles(payload)
    if action=='ocr-layout':return ocr_layout(payload)
    if action=='check-preview':
        from pypdf import PdfReader
        pages=len(PdfReader(payload['source']).pages)
        if pages>MAX_PAGES:raise ValueError('DOCUMENT_LIMIT')
        return {'pages':pages}
    if action=='flat-repair':
        original=Image.open(payload['source']).convert('RGB');colour=flat_background(original,payload['box'])
        if colour is None:return {'local':False}
        patch=Image.open(payload['crop']).convert('RGB');Image.new('RGB',patch.size,colour).save(payload['output'])
        return {'local':True}
    if action=='crop':
        im=Image.open(payload['source']);box=payload['box'];rect=region_mask(im.size,box).getbbox()
        if not rect:raise ValueError('INVALID_REGION')
        pad=max(24,round(box['height']*.5));x=max(0,rect[0]-pad);y=max(0,rect[1]-pad);w=min(im.width,rect[2]+pad)-x;h=min(im.height,rect[3]+pad)-y
        if payload.get('legacy'):
            return {'x':x,'y':y,'width':w,'height':h}
        # Include enough surrounding pixels for the provider's aspect ratio bounds.
        wide=min(im.width,max(w,384,h/8));high=min(im.height,max(h,384,w/8))
        x=max(0,min(im.width-wide,x-(wide-w)/2));y=max(0,min(im.height-high,y-(high-h)/2));x,y,w,h=map(lambda v:int(round(v)),(x,y,wide,high))
        patch=im.crop((x,y,x+w,y+h)).convert('RGB');iw=max(w,math.ceil(h/8));ih=max(h,math.ceil(w/8));ox=(iw-w)//2;oy=(ih-h)//2
        if iw!=w or ih!=h:
            padded=Image.new('RGB',(iw,ih),patch.getpixel((0,0)));padded.paste(patch,(ox,oy));patch=padded
        patch.save(payload['output']);return {'x':x,'y':y,'width':w,'height':h,'inputWidth':iw,'inputHeight':ih,'offsetX':ox,'offsetY':oy}
    if action=='check':
        from PIL import features
        import pdfplumber,pypdfium2,uharfbuzz,cairosvg
        return {'complexText':features.check('raqm'),'documentRendering':bool(shutil.which(os.environ.get('SOFFICE_PATH','soffice')))}
    raise ValueError('INVALID_REQUEST')

if __name__=='__main__':
    try:
        payload=json.loads(Path(sys.argv[1]).read_text());result=main(payload)
        Path(payload['result']).write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')
    except Exception as e:
        print(str(e)[:500],file=sys.stderr);sys.exit(1)
