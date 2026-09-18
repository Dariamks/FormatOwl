"""Adapt Docling's structure to stable FormatOwl blocks and preserve old corrected documents."""
import copy, hashlib, json, os, re, statistics, subprocess
from pathlib import Path


def overlap(a,b):
    area=max(0,min(a['x']+a['width'],b['x']+b['width'])-max(a['x'],b['x']))*max(0,min(a['y']+a['height'],b['y']+b['height'])-max(a['y'],b['y']))
    return area/max(1,min(a['width']*a['height'],b['width']*b['height']))


def source_style(item, chars, page, members=()):
    box=item['box'];scale=page.get('scale',1)
    matched=[c for c in chars if box['x']/scale-1<=c['x0']<=box['x']/scale+box['width']/scale and box['y']/scale-2<=c['top']<= (box['y']+box['height'])/scale]
    styled=[c for c in matched if c['text'].strip()]
    def dominant(pattern):
        return sum(bool(re.search(pattern,c['fontname'],re.I)) for c in styled)>len(styled)*.6
    ocr_lines=[m for m in members if m.get('raster') and m.get('box') and m['sourceText'].strip()]
    # OCR line height measures the visible ink; invisible PDF font sizes do not.
    heights=[(m.get('originalBox') or m['box'])['height'] for m in ocr_lines if not re.search(r'\\[([]',m['sourceText']) and len(m['sourceText'])>3]
    if not heights:heights=[(m.get('originalBox') or m['box'])['height'] for m in ocr_lines]
    size=statistics.median(c['size'] for c in matched)*scale if matched else statistics.median(heights)*.7 if heights else 11*scale
    if ocr_lines and not matched and item['label'] not in ('title','section_header'):
        size=page.get('ocrFontSize',size)
    centered=abs(box['x']+box['width']/2-page['width']/2)<page['width']*(.07 if item['label'] in ('title','section_header','caption') else .02)
    return {'fontSize':max(8,min(96,size)),'color':'#111111','align':'center' if centered and item['label']!='list_item' and (item['label'] in ('title','section_header') or box['width']<page['width']*.7) else 'left',
        'fontFamily':'sans' if dominant('sans|arial|helvetica|黑体|heiti') else 'serif','bold':dominant('bold|black|hei|heiti') or item['label'] in ('title','section_header'),'italic':dominant('italic|oblique')}


def structure_pdf(payload):
    import pdfplumber
    from translate_file import block
    data=copy.deepcopy(payload['data']);folder=Path(payload['folder']);root=Path(__file__).resolve().parents[3]
    python=Path(os.environ.get('DOCLING_PYTHON_PATH',root/'.data/docling-venv/bin/python'))
    if not python.exists():raise ValueError('DOCUMENT_ENGINE_UNAVAILABLE')
    params=folder/'docling-input.json';result=folder/'docling-output.json'
    params.write_text(json.dumps({'data':data,'source':payload['source'],'result':str(result)},ensure_ascii=False))
    completed=subprocess.run([str(python),str(Path(__file__).with_name('docling_bridge.py')),str(params)],capture_output=True,text=True,timeout=540)
    if completed.returncode:
        print(completed.stderr[-2000:],file=__import__('sys').stderr)
        raise ValueError('DOCUMENT_STRUCTURE_FAILED')
    structured=adapt_structure(data, json.loads(result.read_text()), payload['source'], payload.get('preserve',False))
    from pdf_visual_regions import complete_figure_rows
    complete_figure_rows(structured['blocks'],structured['pages'],folder)
    return structured


def adapt_structure(data, parsed, source, preserve=False):
    import pdfplumber
    from translate_file import block
    data=copy.deepcopy(data);items=copy.deepcopy(parsed['items']);old=data['blocks']
    preserve=preserve or any(b.get('translatedText') or b.get('layoutEdited') for b in old)
    for page in data['pages']:
        lines=[b for b in old if b['page']==page['index'] and b.get('raster') and b.get('box') and len(b['sourceText'])>12 and not re.search(r'\\[a-zA-Z]|[_^]',b['sourceText'])]
        if lines:page['ocrFontSize']=statistics.median((b.get('originalBox') or b['box'])['height'] for b in lines)*.7
    output=[];covered=set();old_by_id={b['id']:b for b in old}
    detected_figures={'d-'+hashlib.sha256((str(i['page'])+i['ref']).encode()).hexdigest()[:18] for i in items if i['label'] in ('picture','formula')}
    import pypdfium2 as pdfium
    from pdf_text_layer import visible_chars
    with pdfplumber.open(source) as pdf, pdfium.PdfDocument(source) as rendered:
        page_chars=[visible_chars(p,rendered[i])[0] for i,p in enumerate(pdf.pages)]
        for order,item in enumerate(items):
            page=data['pages'][item['page']];kind={'title':'heading','section_header':'heading','list_item':'list','caption':'caption','picture':'figure','formula':'formula','table':'table'}.get(item['label'],'text')
            members=[b for b in old if b['page']==item['page'] and b.get('box') and overlap(b.get('originalBox') or b['box'],item['box'])>.6]
            if kind not in ('figure','formula'):members=[b for b in members if b['kind']!='figure']
            # Order fragments on the same baseline by x (closing brackets often
            # have a slightly higher baseline than their question).
            members.sort(key=lambda b:(round(((b.get('originalBox') or b['box'])['y']-item['box']['y'])/max(8,(b.get('originalBox') or b['box'])['height'])),(b.get('originalBox') or b['box'])['x']))
            style=source_style(item,page_chars[item['page']],page,members)
            if preserve and kind not in ('figure','formula'):
                for n,b in enumerate(members):
                    if b['id'] in covered:continue
                    covered.add(b['id']);b['order']=order+n/max(1,len(members));b['structureId']=item['ref']
                    if item['label'] in ('page_header','page_footer'):b['layoutRole']=item['label'].removeprefix('page_')
                    if not b.get('layoutEdited'):b['style']={**style,'fontSize':b['style']['fontSize']}
                    if kind in ('heading','caption','list') and b['kind']!='formula':b['kind']=kind
                    if kind=='table' and item.get('cells'):
                        matches=[c for c in item['cells'] if overlap(b.get('originalBox') or b['box'],c['box'])>.6]
                        if len(matches)==1:
                            cell=matches[0];b['table']={k:cell[k] for k in ('row','column','rowSpan','columnSpan','header','rows','columns')};b['table']['id']=item['ref']
                        elif 'STRUCTURE_REVIEW' not in b['review']:b['review'].append('STRUCTURE_REVIEW')
                    output.append(b)
                continue
            ident='d-'+hashlib.sha256((str(item['page'])+item['ref']).encode()).hexdigest()[:18]
            if kind=='table' and item.get('cells'):
                for n,cell in enumerate(item['cells']):
                    b=block(cell['text'],0,item['page'],'table',cell['box']);b.update(id=f'{ident}-{n}',order=order+n/max(1,len(item['cells'])),raster=False,style=style,
                        table={k:cell[k] for k in ('row','column','rowSpan','columnSpan','header','rows','columns')})
                    b['table']['id']=ident;output.append(b)
            else:
                if not item['text'].strip() and kind not in ('figure','formula'):continue
                b=copy.deepcopy(old_by_id[ident]) if preserve and ident in old_by_id else block(item['text'],0,item['page'],kind,item['box'])
                if ident in old_by_id:covered.add(ident)
                b.update(id=ident,order=order,raster=False,keepOriginal=kind in ('figure','formula'))
                if not b.get('layoutEdited'):b['style']=style
                b.pop('figureId',None)
                if item['label'] in ('page_header','page_footer'):b['layoutRole']=item['label'].removeprefix('page_')
                # Docling list text excludes the marker; retain the exact printed number.
                if item.get('marker') and not b['sourceText'].startswith(item['marker']):b['sourceText']=item['marker']+' '+b['sourceText']
                if kind not in ('figure','formula'):
                    content_members=[m for m in members if m['id'] not in covered]
                    if content_members:
                        b['sourceText']=' '.join(m['sourceText'] for m in content_members).strip() or b['sourceText']
                    b['review']=list({r for m in members for r in m.get('review',[]) if r not in ('TEXT_OVERFLOW','BACKGROUND_REVIEW')})
                    protected_inlines(b,content_members)
                    native_inline_styles(b,page_chars[item['page']],page)
                    math_inlines(b)
                    if any(m.get('raster') for m in content_members):
                        b['raster']=True
                        # Pure formula/option lines retain their original pixels.
                        if not re.search(r'[\u4e00-\u9fff]|[A-Za-z]{3}', ''.join(s['text'] for s in b.get('inline',[{'text':b['sourceText']}]) if not s.get('protected'))) and (re.search(r'\d|[=α-ωΑ-Ω]',b['sourceText']) or any(s.get('math') for s in b.get('inline',[]))):
                            b['kind']='formula';b['keepOriginal']=True
                if kind=='figure':b['review']=['FIGURE_REVIEW']
                if kind in ('figure','formula') and preserve:
                    # Existing text stays separately editable; only pure symbol fragments
                    # are incorporated into the preserved visual object.
                    for m in members:
                        if m['id']==ident:covered.add(ident);continue
                        if m['id'] in detected_figures:continue
                        if m['id'] in covered:continue
                        if m.get('keepOriginal') and not m.get('layoutEdited') and (not m.get('translatedText') or m['translatedText'].strip()==m['sourceText'].strip()):
                            m['figureId']=ident;m['order']=order;covered.add(m['id']);output.append(m)
                    b['review']=['FIGURE_REVIEW'] if kind=='figure' else []
                output.append(b)
            if not preserve:
                if kind=='figure':
                    # Natural language inside a diagram is translated as a separate
                    # caption, while the original diagram remains untouched.
                    for m in members:
                        if m['id'] not in covered and not m.get('keepOriginal') and re.search(r'[\u4e00-\u9fff]|[A-Za-z]{4}',m['sourceText']) and not re.fullmatch(r'[A-Z\s]+',m['sourceText'].strip()):
                            m['kind']='caption';m['order']=order+.01;output.append(m)
                covered.update(b['id'] for b in members)
        # Never silently discard native/OCR content that the layout detector missed.
        for b in old:
            if b['id'] in covered:continue
            if b.get('hidden'):output.append(b);continue
            b['order']=next((i+.9 for i,item in enumerate(items) if item['page']==b['page'] and item['box']['y']>b.get('box',{}).get('y',0)),len(items)+b['page'])
            if b.get('raster'):math_inlines(b)
            if 'STRUCTURE_REVIEW' not in b['review']:b['review'].append('STRUCTURE_REVIEW')
            output.append(b)
        attach_scripts(output,pdf.pages,data['pages'])
    for b in output:
        b['review']=[r for r in b.get('review',[]) if r not in ('TEXT_OVERFLOW','BACKGROUND_REVIEW')]
    if len(output)>20000:raise ValueError('TRANSLATION_LIMIT')
    data.update(blocks=output,layoutVersion=3,layoutEngine=parsed['engine'])
    return data


def attach_scripts(blocks,pdf_pages,pages):
    """Recover detached sub/superscripts only when geometry and token counts agree."""
    for child in blocks:
        child.pop('attachment',None)
        if child.get('hidden') or child.get('figureId') or child.get('layoutEdited'):continue
        value=child['sourceText'].strip()
        if not re.fullmatch(r'[\dA-Za-z+−-]{1,4}',value) or not child.get('box'):continue
        if pages[child['page']].get('textSource')=='ocr':continue
        page=pages[child['page']];scale=page.get('scale',1);box=child.get('originalBox') or child['box'];chars=pdf_pages[child['page']].chars
        inside=[c for c in chars if abs(c['x0']-box['x']/scale)<2 and abs(c['top']-box['y']/scale)<2 and c['text']==value[0]]
        if not inside:continue
        small=inside[0]
        nearby=[c for c in chars if re.fullmatch(r'[A-Za-zα-ωΑ-Ω]',c['text']) and -1<=small['x0']-c['x1']<c['size']*.4 and c['size']>small['size']*1.2 and abs(c['top']-small['top'])<c['size']*.8]
        if not nearby:continue
        base=min(nearby,key=lambda c:abs(small['x0']-c['x1']))
        parents=[b for b in blocks if b['id']!=child['id'] and b['page']==child['page'] and b['kind'] not in ('figure','formula') and b.get('box') and not b.get('hidden') and not b.get('figureId') and (b.get('originalBox') or b['box'])['x']/scale-1<=base['x0']<=(b.get('originalBox') or b['box'])['x']/scale+(b.get('originalBox') or b['box'])['width']/scale and (b.get('originalBox') or b['box'])['y']/scale-1<=base['top']<=(b.get('originalBox') or b['box'])['y']/scale+(b.get('originalBox') or b['box'])['height']/scale]
        if not parents:continue
        parent=min(parents,key=lambda b:(b.get('originalBox') or b['box'])['width']*(b.get('originalBox') or b['box'])['height']);pbox=parent.get('originalBox') or parent['box'];token=base['text']
        pattern=r'(?<![A-Za-z])'+re.escape(token)+r'(?![A-Za-z])'
        count=len(list(re.finditer(pattern,parent['sourceText'])))
        occurrences=[c for c in chars if c['text']==token and c['size']>small['size']*1.2 and pbox['x']/scale-1<=c['x0']<=(pbox['x']+pbox['width'])/scale and pbox['y']/scale-1<=c['top']<=(pbox['y']+pbox['height'])/scale]
        if not count or len(occurrences)!=count or base not in occurrences:continue
        script='subscript' if small['top']>base['top']+base['size']*.12 else 'superscript' if small['top']<base['top']-base['size']*.12 else None
        if script:child['attachment']={'parentId':parent['id'],'token':token,'occurrence':occurrences.index(base),'count':count,'script':script}


def protected_inlines(block,members):
    """Protect recognized formula fragments; uncertain graphics remain original images."""
    text=block['sourceText'];ranges=[];cursor=0
    for m in members:
        # Match every source fragment in reading order. Repeated variables must
        # use their own occurrence, not the first identical token in the prose.
        value=m['sourceText'].strip()
        if not value:continue
        start=text.find(value,cursor)
        if start<0:continue
        cursor=start+len(value)
        if m.get('kind')!='formula' and not m.get('keepOriginal'):continue
        if not re.search(r'[\w=+×÷√∑∫]',value):continue
        ranges.append((start,cursor,m))
    if not ranges:return
    spans=[];cursor=0
    for start,end,m in sorted(ranges,key=lambda r:(r[0],r[1])):
        if start<cursor:continue
        if start>cursor:spans.append({'text':text[cursor:start]})
        spans.append({'text':text[start:end],'protected':True,'box':m.get('originalBox') or m['box']});cursor=end
    if cursor<len(text):spans.append({'text':text[cursor:]})
    block['inline']=[{'id':f's{i}',**s} for i,s in enumerate(spans)]


def math_inlines(block):
    """Parse explicit OCR math delimiters and bare TeX runs into protected nodes."""
    text=block['sourceText']
    if block.get('inline') and any(s.get('box') for s in block['inline']):return
    explicit=list(re.finditer(r'\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|(?<!\\)\$([^$\n]+)\$',text))
    # Commands/superscripts outside delimiters occur in native OCR output too.
    # Only a contiguous math alphabet is admitted; natural-language text is never
    # passed to TeX or heuristically rewritten into mathematical expressions.
    ranges=[(m.start(),m.end(),next(v for v in m.groups() if v is not None)) for m in explicit]
    for m in re.finditer(r'[A-Za-z0-9\\{}_^=+*/. ,:;()<>!\-−α-ωΑ-Ω°]+',text):
        if not re.search(r'\\[A-Za-z]+|[A-Za-z0-9}][_^]',m.group()):continue
        if any(m.start()<end and m.end()>start for start,end,_ in ranges):continue
        lead=len(m.group())-len(m.group().lstrip());tail=len(m.group().rstrip())
        ranges.append((m.start()+lead,m.start()+tail,m.group().strip()))
    if not ranges:return
    spans=[];cursor=0
    for start,end,tex in sorted(ranges):
        if start>cursor:spans.append({'text':text[cursor:start]})
        spans.append({'text':text[start:end], 'math':tex, 'protected':True});cursor=end
    if cursor<len(text):spans.append({'text':text[cursor:]})
    block['inline']=[{'id':f's{i}',**s} for i,s in enumerate(spans)]


def native_inline_styles(block, chars, page):
    """Map native font runs to source characters before translation changes their length."""
    if not chars or block.get('inline'):return
    box=block['box'];scale=page.get('scale',1);text=block['sourceText'];cursor=0;styles={}
    selected=[c for c in chars if box['x']/scale-1<=c['x0']<=(box['x']+box['width'])/scale and box['y']/scale-2<=c['top']<=(box['y']+box['height'])/scale]
    for c in selected:
        value=c['text'];start=text.find(value,cursor)
        if start<0 or start-cursor>24:continue
        names=c['fontname'].lower()
        flags={'bold':bool(re.search('bold|black|heiti',names)) or block['kind']=='heading','italic':bool(re.search('italic|oblique',names))}
        for i in range(start,start+len(value)):styles[i]=flags
        cursor=start+len(value)
    if len({tuple(s.values()) for s in styles.values()})<=1:return
    spans=[]
    for i,char in enumerate(text):
        flags=styles.get(i,styles.get(i-1,{}))
        if spans and all(spans[-1].get(k)==v for k,v in flags.items()):spans[-1]['text']+=char
        else:spans.append({'text':char,**flags})
    block['inline']=[{'id':f's{i}',**s} for i,s in enumerate(spans)]
