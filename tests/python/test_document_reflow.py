import copy, json, sys
from pathlib import Path
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'apps/worker/python'))
from translate_file import block
from pdf_reflow import render, font_name
from pdf_structure import adapt_structure
from structured_inlines import extract_inline, write_inline


def document(tmp_path):
 from reportlab.pdfgen import canvas
 from PIL import Image
 source=tmp_path/'source.pdf';c=canvas.Canvas(str(source),pagesize=(400,500));c.drawString(30,450,'Original');c.save()
 Image.new('RGB',(400,500),'white').save(tmp_path/'original.png')
 return source,{'format':'pdf','layoutVersion':3,'sourceLanguage':'en','targetLanguage':'en','pages':[{'index':0,'width':400,'height':500,'scale':1,'originalFile':'original.png'}],'blocks':[]}


def text(ident,value,**extra):
 b=block(value,0,box={'x':30,'y':30,'width':300,'height':18,'angle':0});b.update(id=ident,translatedText=value,**extra);b['style']['fontSize']=11;return b


def bounds(result):
 for p in result['pages']:
  for r in p['regions']:
   b=r['box'];assert b['x']>=0 and b['y']>=0
   assert b['x']+b['width']<=p['width']+.1 and b['y']+b['height']<=p['height']+.1


def test_long_paragraph_continuations_and_bilingual(tmp_path):
 from pypdf import PdfReader
 source,data=document(tmp_path);data['blocks']=[text('a','A full sentence must wrap without shrinking. '*110)]
 before=copy.deepcopy(data);result=render(data,tmp_path,tmp_path/'preview.pdf');assert data==before
 assert len(result['pages'])>2;bounds(result)
 assert all(p['regions'][0]['id']=='a' and p['sourcePage']==0 for p in result['pages'])
 exported=render(data,tmp_path,tmp_path/'download.pdf')
 assert result==exported and (tmp_path/'preview.pdf').read_bytes()==(tmp_path/'download.pdf').read_bytes()
 render(data,tmp_path,tmp_path/'dual.pdf',source,'bilingual')
 assert len(PdfReader(tmp_path/'dual.pdf').pages)==len(result['pages'])+1
 assert 'Original' in PdfReader(tmp_path/'dual.pdf').pages[0].extract_text()


@pytest.mark.parametrize('sample',['中文内容，标题和正文。','Readable English body.','日本語の文章。','한국어 문장입니다.','Texte français accentué.','Deutscher Text Größe.','Texto español mañana.','Texto português ação.','Testo italiano leggibile.','Русский текст документа.','هذا نص عربي واضح للقراءة.'])
def test_eleven_languages_and_searchable_text(tmp_path,sample):
 import pdfplumber
 _,data=document(tmp_path);data['blocks']=[text('body',sample*8)]
 result=render(data,tmp_path,tmp_path/'languages.pdf');bounds(result)
 with pdfplumber.open(tmp_path/'languages.pdf') as pdf:
  chars=[c for p in pdf.pages for c in p.chars if c['size']>=10]
  assert len(chars)>20
  assert all(c['size']>=10 for c in chars)
  assert not any(c['text']=='\x00' for c in chars)


def test_font_faces_are_distinct():
 from reportlab.pdfbase import pdfmetrics
 for family in ['serif','sans']:
  regular=pdfmetrics.getFont(font_name('body',{'fontFamily':family}))
  bold=pdfmetrics.getFont(font_name('heading',{'fontFamily':family,'bold':True}))
  assert regular.face.name!=bold.face.name


def test_cross_page_table_repeats_headers_and_preserves_cells(tmp_path):
 from pypdf import PdfReader
 _,data=document(tmp_path)
 for row in range(35):
  for col in range(2):
   b=text(f'cell-{row}-{col}',f'Cell {row}-{col}. '+('Long translated sentence. '*8 if row else 'Header'))
   b['table']={'id':'table','row':row,'column':col,'rows':35,'columns':2,'rowSpan':1,'columnSpan':1,'header':row==0};data['blocks'].append(b)
 result=render(data,tmp_path,tmp_path/'table.pdf');bounds(result);assert len(result['pages'])>2
 seen={r['id'] for p in result['pages'] for r in p['regions']};assert seen=={b['id'] for b in data['blocks']}
 assert all('Header' in p.extract_text() for p in PdfReader(tmp_path/'table.pdf').pages)


def test_upgrade_preserves_edits_ids_and_formula_aliases(tmp_path):
 source,data=document(tmp_path);a=text('a','Saved English translation.');a['sourceText']='原文';a['layoutEdited']=True;a['style']['fontSize']=17
 symbol=text('symbol','x²');symbol.update(keepOriginal=True,translatedText='',kind='formula')
 symbol['box']=symbol['originalBox']={'x':150,'y':110,'width':30,'height':20,'angle':0}
 data['blocks']=[a,symbol]
 items=[{'ref':'p0','label':'text','page':0,'text':'原文','box':a['box']},{'ref':'p1','label':'formula','page':0,'text':'x²','box':symbol['box']}]
 upgraded=adapt_structure(data,{'items':items,'engine':'fixture'},str(source),True)
 byid={b['id']:b for b in upgraded['blocks']};assert {'a','symbol'}<=byid.keys()
 assert byid['a']['translatedText']==a['translatedText'] and byid['a']['style']==a['style']
 assert byid['symbol']['figureId']
 result=render(upgraded,tmp_path,tmp_path/'upgrade.pdf')
 assert 'symbol' in {i for p in result['pages'] for r in p['regions'] for i in r['memberIds']}


def test_fresh_structure_protects_repeated_variables_at_their_own_positions(tmp_path):
 source,data=document(tmp_path)
 for i,(value,x,kind) in enumerate([('Compare v with',30,'text'),('v',150,'formula'),('and',180,'text'),('v',230,'formula')]):
  b=block(value,i,box={'x':x,'y':30,'width':90 if i==0 else 15,'height':18,'angle':0},kind=kind)
  data['blocks'].append(b)
 before=copy.deepcopy(data)
 parsed={'engine':'fixture','items':[{'ref':'p0','label':'text','page':0,'text':'Compare v with v and v','box':{'x':30,'y':30,'width':300,'height':18}}]}
 result=adapt_structure(data,parsed,str(source))
 assert data==before
 assert len(result['blocks'])==1
 b=result['blocks'][0];spans=b['inline']
 assert ''.join(s['text'] for s in spans)==b['sourceText']=='Compare v with v and v'
 assert spans[0]['text']=='Compare v with ' and not spans[0].get('protected')
 protected=[s for s in spans if s.get('protected')]
 assert [s['text'] for s in protected]==['v','v']
 assert [s['box']['x'] for s in protected]==[150,230]


def test_ooxml_and_epub_marked_slots_keep_objects_and_links():
 from lxml import etree
 for fmt,xml in [('docx','<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:hyperlink w:anchor="a"><w:r><w:t>Link</w:t></w:r></w:hyperlink><m:oMath><m:r><m:t>x²</m:t></m:r></m:oMath></w:p>'),('epub','<p>Hello <strong>bold</strong> <a href="chapter2.xhtml">link</a> <math><mi>x</mi></math></p>')]:
  root=etree.fromstring(xml);spans=extract_inline(root,fmt)
  b={'inline':spans,'translatedInline':[{'id':s['id'],'text':'Translated '+s['id']} for s in spans if not s.get('protected')]}
  write_inline(root,fmt,b,'translated');out=etree.tostring(root).decode()
  assert 'Translated' in out
  assert ('w:hyperlink' in out and 'x&#178;' in out) if fmt=='docx' else ('href="chapter2.xhtml"' in out and '<mi>x</mi>' in out)
  b['translatedInline']=[]
  with pytest.raises(ValueError,match='INLINE_MARKERS_INVALID'):write_inline(root,fmt,b,'translated')


def test_docling_native_scanned_and_mixed_local_pipeline(tmp_path):
 from PIL import Image,ImageDraw,ImageFont
 from reportlab.pdfgen import canvas
 from translate_file import extract
 from pdf_structure import structure_pdf
 # A single document covers native columns, a scan, and native text over a scan.
 source=tmp_path/'mixed.pdf';scan=tmp_path/'scan.png'
 im=Image.new('RGB',(400,500),'white');draw=ImageDraw.Draw(im)
 font=ImageFont.truetype('apps/worker/assets/NotoSerif-Regular.ttf',18)
 draw.text((30,110),'Saved OCR sentence.',font=font,fill='black');im.save(scan)
 c=canvas.Canvas(str(source),pagesize=(400,500))
 c.drawString(30,450,'Contract heading');c.drawString(30,415,'Left column clause.');c.drawString(230,415,'Right column clause.');c.showPage()
 c.drawImage(str(scan),0,0,width=400,height=500);c.showPage()
 c.drawImage(str(scan),0,0,width=400,height=500);c.drawString(30,450,'Native heading');c.save()
 data=extract({'source':str(source),'format':'pdf','folder':str(tmp_path),'sourceLanguage':'en','targetLanguage':'zh'})
 for page in [1,2]:
  scale=data['pages'][page]['scale'];b=text(f'ocr-{page}','Saved OCR sentence.');b.update(page=page,translatedText='',raster=True)
  b['box']=b['originalBox']={'x':30*scale,'y':110*scale,'width':230*scale,'height':25*scale,'angle':0}
  data['blocks'].append(b)
 data=structure_pdf({'data':data,'source':str(source),'folder':str(tmp_path)})
 assert data['layoutVersion']==3 and data['layoutEngine'].startswith('docling-')
 for page in [1,2]:
  source_text=' '.join(b['sourceText'] for b in data['blocks'] if b['page']==page and b['kind']!='figure')
  assert source_text.count('Saved OCR sentence.')==1
 assert any('Native heading' in b['sourceText'] for b in data['blocks'])
 assert any('Left column' in b['sourceText'] for b in data['blocks'])
 assert any('Right column' in b['sourceText'] for b in data['blocks'])
 assert not any('Saved OCR sentence.' in b['sourceText'] for b in data['blocks'] if b['page']==0)
 assert not any('Native heading' in b['sourceText'] for b in data['blocks'] if b['page']!=2)


def test_nested_epub_parent_text_is_not_lost_or_duplicated():
 from lxml import etree
 from translate_file import epub_nodes
 root=etree.fromstring('<body><ul><li>Parent <strong>emphasis</strong><ul><li>Child</li></ul> tail</li></ul></body>')
 nodes=epub_nodes(root,True)
 values=[''.join(s['text'] for s in extract_inline(n,'epub')).strip() for n in nodes]
 assert values==['Parent emphasis tail','Child']
 assert [''.join(n.itertext()) for n in epub_nodes(root)]==['Child'] # legacy locators


@pytest.mark.parametrize('encoding',['utf-8','utf-8-sig','utf-16'])
def test_txt_preserves_encoding_and_paragraph_separators(tmp_path,encoding):
 from translate_file import extract,structured_export
 src=tmp_path/'text.txt';src.write_bytes('First paragraph.\r\n\r\nSecond paragraph.'.encode(encoding))
 data=extract({'source':str(src),'format':'txt','folder':str(tmp_path),'sourceLanguage':'en','targetLanguage':'zh'})
 for i,b in enumerate(data['blocks']):b['translatedText']=f'第{i+1}段。'
 out=tmp_path/'translated.txt';structured_export(data,src,out,'translated')
 result=out.read_bytes();assert result.decode(encoding)=='第1段。\r\n\r\n第2段。'
 if encoding=='utf-8-sig':assert result.startswith(b'\xef\xbb\xbf')
 if encoding=='utf-16':assert result.startswith(b'\xff\xfe')


def test_plain_text_correction_keeps_formula_once_at_its_anchor():
 from lxml import etree
 root=etree.fromstring('<p>Original <math><mi>x</mi></math> ending.</p>')
 write_inline(root,'epub',{'translatedText':'Translated x ending.'},'translated')
 assert ''.join(root.itertext())=='Translated x ending.'
 assert root.find('math/mi').text=='x'
