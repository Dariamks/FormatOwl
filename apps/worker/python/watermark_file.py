"""Conservative object removal and masked image repair; all I/O runs in the worker.
Never rasterizes a PDF page or round-trips an Office output through LibreOffice.
"""
import sys, json, os, re, math, hashlib, zipfile, tempfile, subprocess, posixpath, shutil
from pathlib import Path
from io import BytesIO
from PIL import Image, ImageDraw, ImageOps, ImageChops, ImageFilter
from lxml import etree
import pikepdf
import pypdfium2 as pdfium
from translate_file import safe_zip, read_xml
from watermark_regions import refine_boxes

Image.MAX_IMAGE_PIXELS = 100_000_000
NS = {'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'p':'http://schemas.openxmlformats.org/presentationml/2006/main',
      'a':'http://schemas.openxmlformats.org/drawingml/2006/main',
      'r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'v':'urn:schemas-microsoft-com:vml','wp':'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
      'mc':'http://schemas.openxmlformats.org/markup-compatibility/2006'}
RID = '{'+NS['r']+'}'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
KEYWORDS = re.compile(r'watermark|draft|confidential|sample|preview|copyright|水印|机密|草稿|样本|内部资料',re.I)

def digest(value): return hashlib.sha256(value if isinstance(value,bytes) else json.dumps(value,sort_keys=True).encode()).hexdigest()[:24]
def image_open(path):
    im=Image.open(path)
    if getattr(im,'n_frames',1)!=1: raise ValueError('UNSUPPORTED_ANIMATION')
    if im.width*im.height>100_000_000: raise ValueError('IMAGE_LIMIT')
    return ImageOps.exif_transpose(im).convert('RGBA')
def save_image(im,path): im.save(path,format='PNG')
def pdf_check(path):
    from pypdf import PdfReader
    reader=PdfReader(path)
    if reader.is_encrypted: raise ValueError('ENCRYPTED_PDF')
    if not 1<=len(reader.pages)<=100: raise ValueError('DOCUMENT_LIMIT')
    if any(str(f.get('/FT',''))=='/Sig' for f in (reader.get_fields() or {}).values()): raise ValueError('SIGNED_PDF')
def render_pdf(path,folder,prefix='page',indices=None):
    pdf=pdfium.PdfDocument(str(path));pdf.init_forms(); pages=[]
    if not 1<=len(pdf)<=100: raise ValueError('DOCUMENT_LIMIT')
    for i in range(len(pdf)) if indices is None else indices:
        page=pdf[i]; w,h=page.get_size(); scale=min(1.5,2000/max(w,h))
        im=page.render(scale=scale,draw_annots=True).to_pil().convert('RGBA'); name=prefix+'-'+str(i)+'.png';save_image(im,folder/name)
        pages.append({'index':i,'width':im.width,'height':im.height,'file':name})
        page.close()
    pdf.close();return pages

def office_preview(source,folder):
    profile=folder/'lo-profile';out=folder/'lo-output';out.mkdir(exist_ok=True);(profile/'user').mkdir(parents=True,exist_ok=True)
    (profile/'user/registrymodifications.xcu').write_text('<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item></oor:items>')
    # Slide indices must include hidden slides; the output OOXML keeps their show flag.
    filt='impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}' if source.suffix=='.pptx' else 'writer_pdf_Export'
    subprocess.run([os.environ.get('SOFFICE_PATH','soffice'),'-env:UserInstallation='+profile.resolve().as_uri(),'--headless','--nologo','--nodefault','--nofirststartwizard','--convert-to','pdf:'+filt,'--outdir',str(out),str(source)],check=True,capture_output=True,timeout=120)
    output=out/(source.stem+'.pdf')
    if not output.exists():raise ValueError('DOCUMENT_PROCESSING_FAILED')
    return output

def diff_box(a,b,page):
    if a.size!=b.size:return None
    diff=ImageChops.difference(a.convert('RGB'),b.convert('RGB'))
    mask=diff.convert('L').point(lambda x:255 if x>8 else 0); box=mask.getbbox()
    if not box:return None
    x,y,r,bot=box
    return {'page':page,'x':x/a.width,'y':y/a.height,'width':(r-x)/a.width,'height':(bot-y)/a.height}

def pdf_instructions(obj): return list(pikepdf.parse_content_stream(obj))
def pdf_stream(pdf,obj,cmd):
    raw=pikepdf.unparse_content_stream(cmd)
    if isinstance(obj,pikepdf.Page): obj.Contents=pdf.make_stream(raw)
    else:obj.write(raw)

def resource_name(resources,prefix):
    name=prefix;index=0
    while name in resources:
        index+=1;name=prefix+'_'+str(index)
    return pikepdf.Name(name)

def pdf_edit_container(pdf,obj,edits,replacements,depth=0,inherited_resources=None):
    if depth>12:raise ValueError('WATERMARK_UNSUPPORTED')
    cmd=pdf_instructions(obj); resources=pikepdf.Dictionary(obj.get('/Resources',inherited_resources or {})); xobjects=pikepdf.Dictionary(resources.get('/XObject',{})); resources.XObject=xobjects;obj.Resources=resources
    remove=set()
    nested={}
    for loc in edits:
        if loc['chain']:nested.setdefault(loc['chain'][0],{'edits':[],'replacements':[]})['edits'].append({**loc,'chain':loc['chain'][1:]})
        elif loc.get('kind')=='text':
            # BT/ET does not save the font, spacing or rendering state. Keep those
            # operators for subsequent text and blank only this object's glyphs.
            for i in range(loc['start'],loc['end']+1):
                c=cmd[i];op=str(c.operator)
                if op in ('Tj','TJ',"'",'"'):
                    args=list(c.operands);args[-1]=pikepdf.Array([]) if op=='TJ' else pikepdf.String(b'')
                    cmd[i]=(args,c.operator)
        else:remove.update(range(loc['start'],loc['end']+1))
    for loc,path in replacements:
        if loc['chain']:nested.setdefault(loc['chain'][0],{'edits':[],'replacements':[]})['replacements'].append(({**loc,'chain':loc['chain'][1:]},path))
        else:
            at=loc['start'];old=xobjects[cmd[at].operands[0]];im=image_open(path).convert('RGB')
            new=pdf.make_stream(im.tobytes());new.Type=pikepdf.Name('/XObject');new.Subtype=pikepdf.Name('/Image');new.Width=im.width;new.Height=im.height;new.ColorSpace=pikepdf.Name('/DeviceRGB');new.BitsPerComponent=8
            # Retain an existing soft mask, which represents original image transparency.
            if '/SMask' in old:new.SMask=old.SMask
            name=resource_name(xobjects,'/FMImage'+str(at));xobjects[name]=new;cmd[at]=([name],pikepdf.Operator('Do'))
    for at,child_edits in nested.items():
        old=xobjects[cmd[at].operands[0]];child=pdf.make_stream(old.read_bytes())
        for key,value in old.items():
            if str(key) not in ('/Length','/Filter','/DecodeParms'):child[key]=value
        pdf_edit_container(pdf,child,child_edits['edits'],child_edits['replacements'],depth+1,resources)
        name=resource_name(xobjects,'/FMForm'+str(at));xobjects[name]=child;cmd[at]=([name],pikepdf.Operator('Do'))
    pdf_stream(pdf,obj,[c for i,c in enumerate(cmd) if i not in remove])

def pdf_font_decoder(source):
    # Use the pinned pypdf CMap implementation, including ToUnicode and CID
    # encodings, instead of interpreting glyph IDs as UTF-8/PDFDocEncoding.
    from pypdf import PdfReader
    from pypdf.generic import IndirectObject
    from pypdf._cmap import get_encoding
    reader=PdfReader(source);cache={}
    def decode(value,font):
        if font is None or not font.objgen[0]:return str(value)
        key=font.objgen
        try:
            if key not in cache:cache[key]=get_encoding(reader.get_object(IndirectObject(*key,reader)))
            encoding,mapping=cache[key];raw=bytes(value)
            text=raw.decode(encoding,'surrogatepass') if isinstance(encoding,str) else ''.join(encoding.get(c,chr(c)) for c in raw)
            return ''.join(mapping.get(c,c) for c in text)
        except (ValueError,KeyError,LookupError,TypeError):return str(value)
    return decode

def pdf_linear(m,n):
    a,b,c,d=map(float,m[:4]);e,f,g,h=map(float,n[:4])
    return (a*e+b*g,a*f+b*h,c*e+d*g,c*f+d*h)

def pdf_text_blocks(cmd,resources,initial=None,decode=None):
    state={'matrix':(1,0,0,1),'font':None,'size':0,'alpha':1,'stroke_alpha':1,'mode':0,**(initial or {})}
    stack=[];marked=[];blocks={};calls={};block=None;tm=(1,0,0,1)
    for i,c in enumerate(cmd):
        op=str(c.operator);args=c.operands
        if op=='q':stack.append(state.copy())
        elif op=='Q':state=stack.pop()
        elif op=='cm':state['matrix']=pdf_linear(args,state['matrix'])
        elif op=='Tf':state['font']=resources.get('/Font',{}).get(args[0]);state['size']=float(args[1])
        elif op=='Tr':state['mode']=int(args[0])
        elif op=='gs':
            gs=resources.get('/ExtGState',{}).get(args[0],{})
            state['alpha']=float(gs.get('/ca',state['alpha']));state['stroke_alpha']=float(gs.get('/CA',state['stroke_alpha']))
        elif op in ('BDC','BMC'):
            props=args[1] if op=='BDC' else None
            if isinstance(props,pikepdf.Name):props=resources.get('/Properties',{}).get(props)
            marked.append(bool(isinstance(props,pikepdf.Dictionary) and props.get('/Subtype')==pikepdf.Name('/Watermark')))
        elif op=='EMC':
            if marked:marked.pop()
        elif op=='Do':calls[i]={**state,'marked':any(marked)}
        elif op=='BT':
            tm=(1,0,0,1);block={'start':i,'text':[],'size':0,'rotated':False,'transparent':False,'clipping':False,'visible':False,'marked':any(marked)}
        elif op=='Tm':tm=tuple(map(float,args[:4]))
        elif block is not None and op in ('Tj','TJ',"'",'"'):
            values=args[-1] if op=='TJ' else [args[-1]]
            block['text'].extend(decode(v,state['font']) if decode else str(v) for v in values if isinstance(v,pikepdf.String))
            matrix=pdf_linear(tm,state['matrix']);size=abs(state['size'])*math.hypot(matrix[2],matrix[3])
            angle=abs(math.degrees(math.atan2(matrix[1],matrix[0])))
            opacity=state['stroke_alpha'] if state['mode'] in (1,5) else max(state['alpha'],state['stroke_alpha']) if state['mode'] in (2,6) else state['alpha']
            block['size']=max(block['size'],size)
            block['rotated'] |= size>=16 and 12<angle<168
            block['transparent'] |= size>=18 and 0<opacity<.9
            block['clipping'] |= state['mode']>=4
            block['visible'] |= state['mode'] not in (3,7) and opacity>0
        elif op=='ET' and block is not None:
            text=''.join(block.pop('text'));block.update(end=i,label=text[:100] or 'PDF text object')
            block['suspect']=block['visible'] and (block['marked'] or bool(KEYWORDS.search(text)) or (len(text.strip())>=3 and (block['rotated'] or block['transparent'] or block['size']>=32)))
            blocks[block['start']]=block;block=None
    return blocks,calls

def pdf_candidates(obj,page,chain=(),depth=0,inherited_resources=None,inherited_state=None,font_decoder=None):
    if depth>12:return []
    cmd=pdf_instructions(obj); result=[];stack=[]; pairs=[]
    for i,c in enumerate(cmd):
        op=str(c.operator)
        if op=='q':stack.append(i)
        elif op=='Q':
            if not stack:return []
            pairs.append((stack.pop(),i))
    if stack:return []
    resources=obj.get('/Resources',inherited_resources or {})
    initial=dict(inherited_state or {})
    if not isinstance(obj,pikepdf.Page) and '/Matrix' in obj:initial['matrix']=pdf_linear(obj.Matrix,initial.get('matrix',(1,0,0,1)))
    blocks,calls=pdf_text_blocks(cmd,resources,initial,font_decoder)
    used=set()
    for start,end in sorted(pairs,key=lambda p:p[1]-p[0]):
        ops=[str(c.operator) for c in cmd[start:end+1]]
        # Only balanced, isolated text; never delete a rectangle of arbitrary page content.
        if ops.count('BT')!=1 or ops.count('ET')!=1 or not any(op in ops for op in ('Tj','TJ',"'",'"')) or any(op in ops for op in ['Do','BI','S','s','f','F','f*','B','B*','b','b*','W','W*','m','l','c','v','y','h','re','n','BMC','BDC','EMC','BX','EX']):continue
        if any(i in used for i in range(start,end+1)):continue
        block=blocks.get(start+ops.index('BT'))
        if not block or not block['suspect']:continue
        raw=pikepdf.unparse_content_stream(cmd[start:end+1]);label=block['label']
        reason='transparent' if block['transparent'] else 'rotated' if block['rotated'] else 'object'
        result.append({'label':label,'reason':reason,'group':digest(raw),'locator':{'page':page,'chain':list(chain),'start':start,'end':end},'raster':False});used.update(range(start,end+1))
    # A text object can share q/Q with unrelated text or drawings. Its glyphs can
    # still be removed independently unless they establish a clipping path.
    for start,block in blocks.items():
        end=block['end']
        if block['suspect'] and not block['clipping'] and not any(n in used for n in range(start,end+1)):
            result.append({'label':block['label'],'reason':'transparent' if block['transparent'] else 'rotated' if block['rotated'] else 'object','group':digest(pikepdf.unparse_content_stream(cmd[start:end+1])),
                           'locator':{'page':page,'chain':list(chain),'start':start,'end':end,'kind':'text'},'raster':False})
    xo=resources.get('/XObject',{})
    for i,c in enumerate(cmd):
        if str(c.operator)!='Do' or i in used:continue
        x=xo.get(c.operands[0]);loc={'page':page,'chain':list(chain),'start':i,'end':i}
        if x is None:continue
        if x.get('/Subtype')==pikepdf.Name('/Image'):
            mask=x.get('/SMask') or x.get('/Mask')
            signature=[digest(x.read_raw_bytes()),int(x.get('/Width',0)),int(x.get('/Height',0)),
                       digest(mask.read_raw_bytes()) if isinstance(mask,pikepdf.Stream) else str(mask),str(x.get('/Decode',''))]
            result.append({'label':'PDF image','reason':'object','group':digest(signature),'locator':loc,'raster':True,'image':x})
        elif x.get('/Subtype')==pikepdf.Name('/Form'):
            if calls.get(i,{}).get('marked'):
                result.append({'label':'PDF watermark object','reason':'object','group':digest(x.read_bytes()),'locator':loc,'raster':False})
            else:result+=pdf_candidates(x,page,(*chain,i),depth+1,resources,calls.get(i),font_decoder)
    return result

def analyze_pdf(source,folder):
    pdf_check(source);pages=render_pdf(source,folder);data={'format':'pdf','pages':pages,'candidates':[],'targets':[],'detected':[],'warnings':['PDF_STRUCTURE_PRESERVED']}
    with pikepdf.open(source) as pdf:
        raw=[];decode=pdf_font_decoder(source)
        for i,page in enumerate(pdf.pages): raw+=pdf_candidates(page,i,font_decoder=decode)
        if len(raw)>500:raise ValueError('WATERMARK_OBJECT_LIMIT')
        for index,c in enumerate(raw):
            loc=c['locator'];i=loc['page'];cid='pdf-'+str(index);boxes=[]
            with pikepdf.open(source) as preview:
                pdf_edit_container(preview,preview.pages[i],[loc],[]);probe=folder/'probe.pdf';preview.save(probe)
            rendered=render_pdf(probe,folder,'probe',[i])[0]
            box=diff_box(image_open(folder/pages[i]['file']),image_open(folder/rendered['file']),i)
            if box:boxes=[box]
            # A normal full-page scanned image is an editable raster target, not a deletion suggestion.
            if c['raster']:
                x=c['image']
                try:
                    # A soft mask prevents safe pixel replacement, but not removal
                    # of this independent Do invocation (e.g. transparent logos).
                    if not (x.get('/ImageMask') or x.get('/Mask') or x.get('/SMask')):
                        if int(x.get('/Width',0))*int(x.get('/Height',0))>100_000_000:raise ValueError('IMAGE_LIMIT')
                        im=pikepdf.PdfImage(x).as_pil_image().convert('RGBA')
                        if im.width*im.height>100_000_000:raise ValueError('IMAGE_LIMIT')
                        file=cid+'.png';save_image(im,folder/file)
                        data['targets'].append({'id':cid,'label':c['label'],'pages':[i],'width':im.width,'height':im.height,'file':file,'strict':True,'locator':loc})
                except (pikepdf.UnsupportedImageTypeError,NotImplementedError):pass
            if not box:continue
            if c['raster'] and box['width']*box['height']>.7:continue
            data['candidates'].append({'id':cid,'label':c['label'],'reason':c['reason'],'pages':[i],'boxes':boxes,'scope':'page '+str(i+1),'group':c['group'],'locator':loc})
    counts={}
    for c in data['candidates']:counts[c['group']]=counts.get(c['group'],0)+1
    for c in data['candidates']:
        if counts[c['group']]>1:c['reason']='repeated'
    return data

def relpath(part):return posixpath.join(posixpath.dirname(part),'_rels',posixpath.basename(part)+'.rels')
def relation_map(raw,part):
    name=relpath(part)
    if name not in raw:return {}
    return {r.get('Id'):posixpath.normpath(posixpath.join(posixpath.dirname(part),r.get('Target',''))) for r in read_xml(raw[name]) if r.get('TargetMode')!='External'}
def office_load(source):
    z=safe_zip(source);raw={i.filename:z.read(i) for i in z.infolist()};z.close()
    for name,b in raw.items():
        if name.lower().endswith(('vbaproject.bin','.exe')) or name.startswith('_xmlsignatures/'):raise ValueError('UNSAFE_DOCUMENT')
        if name.endswith('.rels'):
            for r in read_xml(b):
                if r.get('TargetMode')=='External' and not r.get('Type','').endswith('/hyperlink'):raise ValueError('UNSAFE_DOCUMENT')
    return raw

def write_office(source,raw,output):
    with zipfile.ZipFile(source) as src,zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as dest:
        names=set()
        for info in src.infolist():dest.writestr(info,raw[info.filename]);names.add(info.filename)
        for name,value in raw.items():
            if name not in names:dest.writestr(name,value)

def xml_path(node):
    parts=[]
    while node.getparent() is not None:
        parts.append('*['+str(node.getparent().index(node)+1)+']');node=node.getparent()
    return '/*[1]/'+'/'.join(reversed(parts))

def xml_bytes(root):return etree.tostring(root,xml_declaration=True,encoding='UTF-8',standalone=True)
def office_apply(source,data,selection,patches,output):
    raw=office_load(source);trees={}
    def tree(part):
        if part not in trees:trees[part]=read_xml(raw[part])
        return trees[part]
    # Resolve every locator before deleting nodes, since sibling indexes can shift.
    deletes=[];replaces=[]
    for c in data['candidates']:
        if c['id'] in selection['candidates'] and c.get('locator'):
            loc=c['locator'];nodes=tree(loc['part']).xpath(loc['path'],namespaces=NS)
            if len(nodes)!=1:raise ValueError('WATERMARK_UNSUPPORTED')
            deletes.append(nodes[0])
    for tid,file in patches.items():
        target=next(t for t in data['targets'] if t['id']==tid);loc=target['locator'];nodes=[]
        for path in loc.get('imagePaths',[loc['imagePath']]):
            matches=tree(loc['part']).xpath(path,namespaces=NS)
            if len(matches)!=1:raise ValueError('WATERMARK_UNSUPPORTED')
            nodes.extend(matches)
        replaces.append((loc,nodes,file))
    for loc,nodes,file in replaces:
        part=loc['part'];rp=relpath(part);rels=tree(rp);rid='rIdFM'+digest([loc,file]);media=part.split('/')[0]+'/media/fm-'+digest([loc,file])+'.png'
        etree.SubElement(rels,'{'+REL+'}Relationship',Id=rid,Type=NS['r']+'/image',Target=posixpath.relpath(media,posixpath.dirname(part)))
        for node in nodes:node.set(RID+'embed' if etree.QName(node).localname=='blip' else RID+'id',rid)
        raw[media]=Path(file).read_bytes()
        ct=tree('[Content_Types].xml')
        if not any(n.get('Extension')=='png' for n in ct):etree.SubElement(ct,'{'+CT+'}Default',Extension='png',ContentType='image/png')
    for node in deletes:
        if node.getparent() is not None:node.getparent().remove(node)
    for part,root in trees.items():raw[part]=xml_bytes(root)
    write_office(source,raw,output)

def office_text(node):
    # AlternateContent stores alternative representations of one visual object.
    # Use one branch for its label, but edit the whole container in every consumer.
    if node.tag=='{'+NS['mc']+'}AlternateContent':node=node[0]
    return ' '.join(node.xpath('.//a:t/text() | .//w:t/text() | .//v:textpath/@string',namespaces=NS))

def watermark_group(group):
    shapes=group.xpath('.//p:sp | .//p:pic | .//p:graphicFrame',namespaces=NS)
    texts=[s for s in shapes if office_text(s).strip()];text=office_text(group).strip()
    if not (2<=len(shapes)<=4 and len(texts)==1 and len(text)<=120 and
            (KEYWORDS.search(text) or text in ('小红书','抖音','bilibili')) and
            all(s.tag=='{'+NS['p']+'}sp' for s in shapes)):return False
    def bounds(shape):
        xfrm=shape.find('p:spPr/a:xfrm',NS)
        if xfrm is None:return None
        off=xfrm.find('a:off',NS);ext=xfrm.find('a:ext',NS)
        if off is None or ext is None:return None
        return tuple(int(v) for v in (off.get('x','0'),off.get('y','0'),ext.get('cx','0'),ext.get('cy','0')))
    label=bounds(texts[0])
    if not label or label[2]<=0 or label[3]<=0:return False
    x,y,w,h=label
    for plate in (s for s in shapes if s is not texts[0]):
        box=bounds(plate)
        if not box:return False
        px,py,pw,ph=box
        if not (px<=x and py<=y and px+pw>=x+w and py+ph>=y+h and pw*ph<=4*w*h):return False
    return True

def office_nodes(root,fmt,part):
    nodes=root.xpath('//p:bg | //p:sp | //p:pic',namespaces=NS) if fmt=='pptx' else root.xpath('//w:background | //w:pict/v:shape | //w:pict/v:rect | //w:pict/v:group | //wp:anchor | //wp:inline',namespaces=NS)
    if fmt=='docx' and re.fullmatch(r'word/(header|footer)\d+\.xml',part):
        # Ordinary header/footer prose and fields must not become deletion hints.
        nodes += [n for n in root.findall('w:p',NS) if re.fullmatch(r'\s*(?:CONFIDENTIAL|DRAFT|SAMPLE|PREVIEW|WATERMARK|机密|草稿|样本|内部资料|水印)\s*',office_text(n),re.I)
                  and not n.xpath('.//w:drawing | .//w:pict | .//w:fldChar | .//w:fldSimple',namespaces=NS)]
    result=[];seen=set()
    for node in nodes:
        if fmt=='pptx':
            for parent in node.iterancestors('{'+NS['p']+'}grpSp'):
                # Only combine a short watermark label with its shape backplate;
                # arbitrary groups containing document content remain separate.
                if watermark_group(parent):node=parent
        alternatives=list(node.iterancestors('{'+NS['mc']+'}AlternateContent'))
        if alternatives:node=alternatives[-1]
        if node not in seen:seen.add(node);result.append(node)
    return result

def analyze_office(source,folder):
    raw=office_load(source);fmt=source.suffix[1:];preview=office_preview(source,folder);pages=render_pdf(preview,folder)
    data={'format':fmt,'pages':pages,'candidates':[],'targets':[],'detected':[],'warnings':['OFFICE_PREVIEW_LAYOUT']};scopes={};partpages={};masterlayouts={}
    if fmt=='pptx':
        pres=read_xml(raw['ppt/presentation.xml']);links=relation_map(raw,'ppt/presentation.xml')
        for i,s in enumerate(pres.findall('.//p:sldId',NS)):
            part=links.get(s.get(RID+'id')); chain=[part]
            for _ in range(2):
                parent=next((v for v in relation_map(raw,chain[-1]).values() if '/slideLayouts/' in v or '/slideMasters/' in v),None)
                if parent and parent not in chain:chain.append(parent)
                else:break
            if len(chain)==3:masterlayouts.setdefault(chain[2],set()).add(posixpath.basename(chain[1]).removesuffix('.xml'))
            for p in chain:
                if p:partpages.setdefault(p,[]).append(i)
        parts=list(partpages)
        if len(pres.findall('.//p:sldId',NS))!=len(pages):raise ValueError('WATERMARK_UNSUPPORTED')
        for part in parts:scopes[part]=('master' if '/slideMasters/' in part else 'layout' if '/slideLayouts/' in part else 'slide')+' · '+', '.join(str(i+1) for i in partpages[part])+(' · layouts: '+', '.join(sorted(masterlayouts[part])) if part in masterlayouts else '')
    else:
        parts=[n for n in raw if re.fullmatch(r'word/(document|header\d+|footer\d+)\.xml',n)]
        refs=relation_map(raw,'word/document.xml');root=read_xml(raw['word/document.xml']); inherited={}
        for i,sect in enumerate(root.findall('.//w:sectPr',NS)):
            for ref in sect.findall('w:headerReference',NS)+sect.findall('w:footerReference',NS):inherited[(etree.QName(ref).localname,ref.get('{'+NS['w']+'}type','default'))]=refs.get(ref.get(RID+'id'))
            for (kind,typ),part in inherited.items():
                if part:scopes[part]=scopes.get(part,'')+(' · ' if part in scopes else '')+'section '+str(i+1)+' '+typ+' '+kind.replace('Reference','')
        scopes['word/document.xml']='document'
    for part in parts:
        root=read_xml(raw[part]);images=relation_map(raw,part)
        nodes=office_nodes(root,fmt,part)
        for node in nodes:
            if len(data['candidates'])+len(data['targets'])>=300:raise ValueError('WATERMARK_OBJECT_LIMIT')
            loc={'part':part,'path':xml_path(node)};cid='office-'+digest(loc)
            text=office_text(node)[:120]
            reason='master' if '/slideMasters/' in part or '/slideLayouts/' in part else 'header' if 'header' in part or 'footer' in part else 'rotated' if node.xpath('.//a:xfrm[@rot]',namespaces=NS) else 'object'
            label=text or ('Image' if node.xpath('.//a:blip | .//v:imagedata',namespaces=NS) else 'Shape')
            candidate={'id':cid,'label':label,'reason':reason,'pages':partpages.get(part,list(range(len(pages)))),'boxes':[],'scope':scopes.get(part,'document'),'group':digest([part,text]),'locator':loc}
            editable=node.xpath('.//a:blip[@r:embed] | .//v:imagedata[@r:id]',namespaces=NS)
            alternatives=node.tag=='{'+NS['mc']+'}AlternateContent'
            if len(editable)==1 or (alternatives and editable and all(len(branch.xpath('.//a:blip[@r:embed] | .//v:imagedata[@r:id]',namespaces=NS))==1 for branch in node)):
                image=editable[0];rid=image.get(RID+'embed') or image.get(RID+'id');media=images.get(rid)
                if media and media in raw:
                    try:
                        im=image_open(BytesIO(raw[media]))
                        # Synchronize only equivalent images; unequal fallbacks
                        # need their own coordinate mapping and are not repairable.
                        for other in editable[1:]:
                            alternate=images.get(other.get(RID+'embed') or other.get(RID+'id'))
                            other_im=image_open(BytesIO(raw[alternate])) if alternate in raw else None
                            if other_im is None or other_im.size!=im.size or other_im.tobytes()!=im.tobytes():raise ValueError('WATERMARK_UNSUPPORTED')
                        file=cid+'.png';save_image(im,folder/file)
                        data['targets'].append({'id':cid,'label':label,'pages':candidate['pages'],'width':im.width,'height':im.height,'file':file,'strict':False,'locator':{**loc,'imagePath':xml_path(image),'imagePaths':[xml_path(n) for n in editable]}})
                    except (OSError,ValueError):pass
            if etree.QName(node).localname=='inline' or (alternatives and node.xpath('.//wp:inline',namespaces=NS) and not node.xpath('.//wp:anchor | .//w:pict',namespaces=NS)):continue
            data['candidates'].append(candidate)
    # Exact page/bounds mapping from a rendering difference also handles linked headers,
    # cropped/rotated shapes and inherited masters without guessing page layout.
    for c in data['candidates']:
        probe=folder/('probe.'+fmt)
        office_apply(source,data,{'candidates':[c['id']],'regions':[]},{},probe)
        probe_pdf=office_preview(probe,folder);rendered=render_pdf(probe_pdf,folder,'probe')
        if len(rendered)!=len(pages):c['pages']=[];continue
        for i in c['pages']:
            box=diff_box(image_open(folder/pages[i]['file']),image_open(folder/rendered[i]['file']),i)
            if box:c['boxes'].append(box)
        c['pages']=[b['page'] for b in c['boxes']]
        for t in data['targets']:
            if t['id']==c['id'] and c['pages']:t['pages']=c['pages']
    data['candidates']=[c for c in data['candidates'] if c['pages']]
    # Inline images have no reliable OOXML page number. Replace only the selected
    # reference with a contrasting image to locate it without changing text flow.
    known={c['id'] for c in data['candidates']}
    for target in data['targets']:
        if target['id'] in known:continue
        im=image_open(folder/target['file']);probe_image=ImageChops.invert(im.convert('RGB')).convert('RGBA');probe_image.putalpha(im.getchannel('A'));probe_image.save(folder/'locate-image.png')
        probe=folder/('locate.'+fmt);office_apply(source,data,{'candidates':[],'regions':[]},{target['id']:str(folder/'locate-image.png')},probe)
        rendered=render_pdf(office_preview(probe,folder),folder,'locate');affected=[]
        if len(rendered)!=len(pages):raise ValueError('WATERMARK_UNSUPPORTED')
        for i in range(len(pages)):
            if diff_box(image_open(folder/pages[i]['file']),image_open(folder/rendered[i]['file']),i):affected.append(i)
        target['pages']=affected
    data['targets']=[t for t in data['targets'] if t['pages']]
    return data

def analyze(p):
    source=Path(p['source']);folder=Path(p['folder']);folder.mkdir(exist_ok=True)
    fmt=p['format']
    if fmt=='pdf':return analyze_pdf(source,folder)
    if fmt in ('docx','pptx'):return analyze_office(source,folder)
    im=image_open(source);save_image(im,folder/'image.png')
    return {'format':fmt,'pages':[{'index':0,'width':im.width,'height':im.height,'file':'image.png'}],'targets':[{'id':'image','label':'Image','pages':[0],'width':im.width,'height':im.height,'file':'image.png','strict':False}],'candidates':[],'detected':[],'warnings':[]}

def make_mask(size,regions):
    w,h=size;total=Image.new('L',size,0)
    for r in regions:
        mask=Image.new('L',size,0);draw=ImageDraw.Draw(mask)
        if r['kind']=='rect':
            box=(math.floor(r['x']*w),math.floor(r['y']*h),math.ceil((r['x']+r['width'])*w)-1,math.ceil((r['y']+r['height'])*h)-1);draw.rectangle(box,fill=255)
        for s in r['strokes']:
                radius=max(1,round(s['radius']*min(w,h)));points=[(round(x*w),round(y*h)) for x,y in s['points']];fill=0 if s['erase'] else 255
                if len(points)>1:draw.line(points,fill=fill,width=radius*2,joint='curve')
                for x,y in points:draw.ellipse((x-radius,y-radius,x+radius,y+radius),fill=fill)
        total=ImageChops.lighter(total,mask)
    if not total.getbbox():raise ValueError('WATERMARK_EMPTY')
    return total

def prepare_repair(p):
    orig=image_open(p['source']);mask=make_mask(orig.size,p['regions']);box=mask.getbbox()
    for b in p.get('protected',[]):
        x,y,w,h=b['x'],b['y'],b['width'],b['height'];r=(max(0,math.floor(x)),max(0,math.floor(y)),min(orig.width,math.ceil(x+w)),min(orig.height,math.ceil(y+h)))
        if r[2]>r[0] and r[3]>r[1] and mask.crop(r).getbbox():raise ValueError('WATERMARK_TEXT_OVERLAP')
    pad=max(24,round(max(box[2]-box[0],box[3]-box[1])*.2));crop=(max(0,box[0]-pad),max(0,box[1]-pad),min(orig.width,box[2]+pad),min(orig.height,box[3]+pad))
    mask.save(p['mask']);cropped=orig.crop(crop);small_mask=mask.crop(crop);cropped.thumbnail((2048,2048),Image.Resampling.LANCZOS);small_mask=small_mask.resize(cropped.size,Image.Resampling.NEAREST);cropped.save(p['crop']);small_mask.save(p['cropMask'])
    # Verify all boundary pixels and most unselected pixels before a local solid fill.
    ring=ImageChops.subtract(mask.filter(ImageFilter.MaxFilter(9)),mask);pixels=orig.convert('RGB');counts={}
    for colour,selected in zip(pixels.crop(crop).get_flattened_data(),ring.crop(crop).get_flattened_data()):
        if selected:counts[colour]=counts.get(colour,0)+1
    # A mark surrounded entirely by transparency can be cleared locally. Preserve
    # every alpha value outside the mask; otherwise retain original image alpha.
    alpha=orig.getchannel('A').crop(crop);boundary=ring.crop(crop)
    clear_alpha=bool(boundary.getbbox()) and not ImageChops.multiply(alpha,boundary).getbbox()
    flat=[0,0,0] if clear_alpha else None
    if counts and not clear_alpha:
        base=max(counts,key=counts.get);near=sum(n for colour,n in counts.items() if max(abs(colour[i]-base[i]) for i in range(3))<=3)/sum(counts.values())
        if near>=.999:flat=list(base)
    if flat is not None:
        fixed=Image.new('RGBA',orig.size,tuple(flat)+(0 if clear_alpha else 255,))
        if not clear_alpha:fixed.putalpha(orig.getchannel('A'))
        orig.paste(fixed,(0,0),mask);orig.save(p['output'])
    return {'box':list(crop),'local':flat is not None,'maskHash':digest(mask.tobytes())}

def match_boundary(original,generated,mask):
    """Match low-frequency colour at the selection boundary; never sample hidden content.
    The bounded plane corrects colour drift while retaining generated texture.
    """
    ring=ImageChops.subtract(mask.filter(ImageFilter.MaxFilter(9)),mask)
    coords=[];step=max(1,int(math.sqrt(original.width*original.height/6000)))
    a=original.convert('RGB');b=generated.convert('RGB')
    for y in range(0,a.height,step):
        for x in range(0,a.width,step):
            if ring.getpixel((x,y)):
                coords.append(([1,x/max(1,a.width-1),y/max(1,a.height-1)],tuple(a.getpixel((x,y))[i]-b.getpixel((x,y))[i] for i in range(3))))
    if len(coords)<24:return generated
    matrix=[[sum(v[i]*v[j] for v,_ in coords) for j in range(3)] for i in range(3)]
    channels=[]
    for channel in range(3):
        rows=[matrix[i][:]+[sum(v[i]*d[channel] for v,d in coords)] for i in range(3)]
        for col in range(3):
            pivot=max(range(col,3),key=lambda r:abs(rows[r][col]));rows[col],rows[pivot]=rows[pivot],rows[col]
            if abs(rows[col][col])<1e-8:return generated
            divisor=rows[col][col];rows[col]=[v/divisor for v in rows[col]]
            for r in range(3):
                if r!=col:
                    f=rows[r][col];rows[r]=[rows[r][j]-f*rows[col][j] for j in range(4)]
        c,dx,dy=[row[3] for row in rows];corners=[c,c+dx,c+dy,c+dx+dy]
        if any(abs(v)>64 for v in corners):return generated
        fw,fh=min(256,a.width),min(256,a.height);field=Image.new('L',(fw,fh));field.putdata([round(c+dx*x/max(1,fw-1)+dy*y/max(1,fh-1)+128) for y in range(fh) for x in range(fw)]);field=field.resize(a.size,Image.Resampling.BILINEAR)
        channels.append(ImageChops.add(b.getchannel(channel),field,offset=-128))
    result=Image.merge('RGB',channels).convert('RGBA');result.putalpha(generated.getchannel('A'));return result

def compose(p):
    orig=image_open(p['source']);patch=image_open(p['patch']);mask=Image.open(p['mask']).convert('L');x,y,r,b=p['box']
    patch=patch.resize((r-x,b-y),Image.Resampling.LANCZOS);patch=match_boundary(orig.crop((x,y,r,b)),patch,mask.crop((x,y,r,b)));layer=orig.copy();layer.paste(patch,(x,y));layer.putalpha(orig.getchannel('A'));orig.paste(layer,(0,0),mask);orig.save(p['output']);return {}

def export_file(p):
    source=Path(p['source']);folder=Path(p['folder']);data=p['data'];selected=p['selection'];out=Path(p['output']);patches=p.get('patches',{})
    if data['format']=='pdf':
        with pikepdf.open(source) as pdf:
            for i,page in enumerate(pdf.pages):
                deletes=[c['locator'] for c in data['candidates'] if c['id'] in selected['candidates'] and c.get('locator') and c['locator']['page']==i]
                replacements=[(t['locator'],patches[t['id']]) for t in data['targets'] if t['id'] in patches and t['locator']['page']==i]
                if deletes or replacements:pdf_edit_container(pdf,page,deletes,replacements)
            pdf.save(out)
        pdf_check(out);pages=render_pdf(out,folder,p['prefix'],p.get('pages'))
    elif data['format'] in ('docx','pptx'):
        office_apply(source,data,selected,patches,out);preview=office_preview(out,folder);pages=render_pdf(preview,folder,p['prefix'],p.get('pages'))
    else:
        im=image_open(patches.get('image',source));fmt=p.get('format','png')
        if fmt=='jpg':
            bg=Image.new('RGB',im.size,'white');bg.paste(im,mask=im.getchannel('A'));bg.save(out,format='JPEG',quality=95,subsampling=0)
        elif fmt=='webp':im.save(out,format='WEBP',lossless=True)
        else:im.save(out,format='PNG')
        im=image_open(out);name=p['prefix']+'-0.png';im.save(folder/name);pages=[{'index':0,'file':name,'width':im.width,'height':im.height}]
    return {'pages':pages}

def main(p):
    action=p['action']
    if action=='analyze':return analyze(p)
    if action=='refine-regions':return {'boxes':refine_boxes(image_open(p['source']),p['boxes'],p.get('protected',[]),p.get('strict',False))}
    if action=='prepare-repair':return prepare_repair(p)
    if action=='compose':return compose(p)
    if action=='export':return export_file(p)
    raise ValueError('INVALID_REQUEST')
if __name__=='__main__':
    payload=json.loads(Path(sys.argv[1]).read_text());result=main(payload);Path(payload['result']).write_text(json.dumps(result,ensure_ascii=False))
