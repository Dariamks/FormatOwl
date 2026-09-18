"""Stable inline slots for OOXML and XHTML. No proportional redistribution of translated text."""
from lxml import etree

W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
M='http://schemas.openxmlformats.org/officeDocument/2006/math'
EPUB_BLOCKS={'p','h1','h2','h3','h4','h5','h6','li','td','th','figcaption','blockquote','dt','dd','div','section','article','body','title'}


def slots(node, fmt):
    result=[]
    if fmt=='docx':
        for child in node.iter():
            if child.tag not in ('{'+W+'}t','{'+M+'}t') or any(a.tag=='{'+W+'}del' for a in child.iterancestors()):continue
            if next((a for a in child.iterancestors() if a.tag=='{'+W+'}p'),None) is not node:continue
            run=next((a for a in child.iterancestors() if a.tag=='{'+W+'}r'),None)
            properties=run.find('{'+W+'}rPr') if run is not None else None
            style={'protected':child.tag=='{'+M+'}t'}
            if properties is not None:
                for name,key in [('b','bold'),('i','italic')]:
                    p=properties.find('{'+W+'}'+name)
                    style[key]=p is not None and p.get('{'+W+'}val','true') not in ('0','false','off')
                valign=properties.find('{'+W+'}vertAlign')
                if valign is not None:
                    style['superscript']=valign.get('{'+W+'}val')=='superscript'
                    style['subscript']=valign.get('{'+W+'}val')=='subscript'
            result.append((child,'text',style))
    else:
        def visit(elem, protected=False):
            if not isinstance(elem.tag,str):return
            name=etree.QName(elem).localname
            if elem is not node and name in EPUB_BLOCKS:return
            protected=protected or name in ('math','svg','code','pre')
            ancestors=[etree.QName(a).localname for a in [elem,*elem.iterancestors()] if isinstance(a.tag,str)]
            style={'protected':protected,'bold':any(n in ('b','strong') for n in ancestors),'italic':any(n in ('i','em') for n in ancestors), 'superscript':'sup' in ancestors,'subscript':'sub' in ancestors}
            if elem.text:result.append((elem,'text',style))
            for child in elem:
                visit(child,protected)
                if child.tail:result.append((child,'tail',style))
        visit(node)
    return result


def extract_inline(node,fmt):
    return [{'id':f's{i}','text':getattr(n,attr) or '',**style} for i,(n,attr,style) in enumerate(slots(node,fmt))]


def write_inline(node,fmt,block,mode):
    if mode=='original' or block.get('keepOriginal'):return
    target=slots(node,fmt)
    translated=block.get('translatedInline')
    if translated is not None and block.get('inline'):
        source={s['id']:s for s in block['inline']};values={s['id']:s['text'] for s in translated}
        expected={s['id'] for s in block['inline'] if not s.get('protected')}
        if len(values)!=len(translated) or set(values)!=expected:raise ValueError('INLINE_MARKERS_INVALID')
        for i,(node,attr,_) in enumerate(target):
            span=source.get(f's{i}')
            if span is None:raise ValueError('INLINE_MARKERS_INVALID')
            setattr(node,attr,span['text'] if span.get('protected') else values[span['id']])
    else:
        # Older results and a user's plain-text correction cannot reconstruct semantic
        # emphasis. Keep markup/objects intact and place the complete text in one slot.
        value=block.get('translatedText','')
        # Locate retained formula/code anchors in a plain-text correction. This
        # preserves their surrounding prose without duplicating the native object.
        groups=[]
        for entry in target:
            protected=bool(entry[2].get('protected'))
            if not groups or groups[-1][0]!=protected:groups.append((protected,[]))
            groups[-1][1].append(entry)
        chunks=[];cursor=0;matched=True
        for protected,entries in groups:
            if not protected:continue
            anchor=''.join(getattr(n,a) or '' for n,a,_ in entries)
            at=value.find(anchor,cursor)
            if at<0:matched=False;break
            chunks.append(value[cursor:at]);cursor=at+len(anchor)
        chunks.append(value[cursor:])
        if matched and any(protected for protected,_ in groups):
            index=0;used=set()
            for protected,entries in groups:
                if protected:index+=1;continue
                used.add(index)
                for i,(n,a,_) in enumerate(entries):setattr(n,a,chunks[index] if i==0 else '')
            if any(value.strip() for i,value in enumerate(chunks) if i not in used):raise ValueError('INLINE_MARKERS_INVALID')
        else:
            writable=[(n,a) for n,a,style in target if not style.get('protected')]
            for i,(n,a) in enumerate(writable):setattr(n,a,value if i==0 else '')
    for n,attr,_ in target:
        if fmt=='docx':n.set('{http://www.w3.org/XML/1998/namespace}space','preserve')
