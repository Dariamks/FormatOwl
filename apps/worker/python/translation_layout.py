"""Conservative paragraph grouping and collision-bounded text regions."""
import copy, re, statistics

def intersects(a,b,pad=0):
    return a['x'] < b['x']+b['width']+pad and a['x']+a['width']+pad > b['x'] and a['y'] < b['y']+b['height']+pad and a['y']+a['height']+pad > b['y']

def starts_item(text):
    return bool(re.match(r'\s*(?:[A-HＡ-Ｈ][.．、)]|\d+[.．、)]|[一二三四五六七八九十]+[、．]|[（(]\d+[)）]|[•●▪])',text))

def join_lines(a,b):
    # PDF extraction adds spaces between CJK glyph runs; never add one between CJK lines.
    sep='' if re.search(r'[\u2e80-\u9fff]$',a) and re.match(r'[\u2e80-\u9fff]',b) else ' '
    return a.rstrip()+sep+b.lstrip()

def edited(b):
    return b.get('layoutEdited') or (b.get('originalBox') and b.get('box')!=b['originalBox'])

def paragraph_blocks(blocks):
    """Keep source IDs as members when grouping legacy line blocks for rendering."""
    out=[]
    for block in sorted(blocks,key=lambda b:(b['page'],round((b.get('box') or {}).get('y',0)/3),(b.get('box') or {}).get('x',0))):
        b=copy.deepcopy(block);b.setdefault('memberIds',[b['id']])
        if not b.get('box') or b.get('keepOriginal') or edited(b) or b.get('kind') not in ('text',):out.append(b);continue
        box=b['box'];size=b['style']['fontSize'];match=None
        for p in reversed(out[-12:]):
            a=p.get('box')
            if not a or p['page']!=b['page'] or p.get('kind')!='text' or p.get('keepOriginal') or edited(p) or p.get('raster')!=b.get('raster'):continue
            gap=box['y']-a['y']-a['height']
            same_left=abs(a['x']-box['x'])<size*1.5
            continuation=not starts_item(b['sourceText']) and a['width']>size*12
            compatible=abs(p['style']['fontSize']-size)<max(2,size*.22)
            if same_left and continuation and compatible and -size*.15<=gap<=size*.9:
                # Do not group a completed legacy translation with an unfinished line.
                if bool(p.get('translatedText'))!=bool(b.get('translatedText')):continue
                match=p;break
        if match:
            a=match['box'];right=max(a['x']+a['width'],box['x']+box['width']);bottom=box['y']+box['height']
            a['x']=min(a['x'],box['x']);a['width']=right-a['x'];a['height']=bottom-a['y']
            match['originalBox']=dict(a);match['sourceText']=join_lines(match['sourceText'],b['sourceText'])
            match['translatedText']=join_lines(match.get('translatedText',''),b.get('translatedText','')).strip()
            match['memberIds']+=b['memberIds']
        else:out.append(b)
    return out

def expand_regions(blocks,pages):
    """Expand into whitespace only; exclude other text, figures and table cells."""
    out=copy.deepcopy(blocks)
    for b in out:
        box=b.get('box')
        if not box or edited(b) or b.get('raster') is not False or b.get('keepOriginal') or b.get('kind')=='table' or box.get('angle',0):continue
        page=pages[b['page']];size=b['style']['fontSize'];pad=max(3,size*.2)
        # Earlier expansions are obstacles too, so two neighbouring paragraphs cannot
        # both claim the same originally empty space.
        obstacles=[x['box'] for x in out if x.get('box') and x['page']==b['page'] and x['id']!=b['id']]+page.get('obstacles',[])
        right=page['width']-max(12,box['x']*.5)
        for o in obstacles:
            if o['x']>=box['x']+box['width']-1 and o['y']<box['y']+box['height'] and o['y']+o['height']>box['y']:
                right=min(right,o['x']-pad)
        width=max(box['width'],right-box['x'])
        bottom=min(page['height']-12,box['y']+max(box['height'],size*8))
        for o in obstacles:
            if o['y']>=box['y']+box['height']-1 and o['x']<box['x']+width and o['x']+o['width']>box['x']:
                bottom=min(bottom,o['y']-pad)
        box['width']=width;box['height']=max(box['height'],bottom-box['y'])
    return out

def render_data(data):
    result=copy.deepcopy(data)
    if data['format']=='pdf':
        if data.get('layoutVersion',1)<2:result['blocks']=paragraph_blocks(result['blocks'])
        # Explicitly edited boxes stay authoritative; expansion is done at extraction.
        if data.get('layoutVersion',1)<2:result['blocks']=expand_regions(result['blocks'],result['pages'])
    return result
