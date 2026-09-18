import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'apps/worker/python'))
from translate_file import block
from pdf_flow import compose_page, furniture
from pdf_reflow import render
from pdf_structure import adapt_structure, source_style, attach_scripts


def item(ident, value, x, y, width=300, height=20, kind='text', **extra):
    b = block(value, 0, kind=kind, box={'x':x, 'y':y, 'width':width, 'height':height, 'angle':0})
    b.update(id=ident, translatedText=value if kind != 'figure' else '', keepOriginal=kind=='figure')
    b.update(extra)
    b['style']['fontSize'] = 11
    return b


def test_visuals_return_to_their_questions_even_when_detector_appends_them():
    blocks = [item('q1','Question one',30,30),item('a1','Answer one',30,140),item('q2','Question two',30,200),item('a2','Answer two',30,340),
              item('f1','',30,70,180,50,'figure'),item('f2','',30,245,180,70,'figure')]
    before = copy.deepcopy(blocks)
    result = compose_page(blocks)
    assert [b['id'] for b in result] == ['q1','f1','a1','q2','f2','a2']
    assert result[0]['_keepWithNext'] and result[3]['_keepWithNext']
    assert blocks == before


def test_composite_grid_keeps_all_panels_labels_and_individual_anchors(tmp_path):
    from PIL import Image
    Image.new('RGB',(400,500),'white').save(tmp_path/'page.png')
    blocks = [item('q','Question with four options',30,30),
              item('a','',30,80,80,70,'figure'),item('c','',30,175,80,70,'figure'),
              item('footer','Page 1 of 1',180,480,80,10),
              item('bd','',230,80,100,165,'figure'),item('label','A.',15,100,15,15)]
    data = {'pages':[{'index':0,'width':400,'height':500,'scale':1,'originalFile':'page.png'}],'blocks':blocks}
    roles = furniture(data); composed = compose_page(blocks,roles)
    figures = [b for b in composed if b['kind']=='figure']
    assert len(figures)==1
    assert {a['id'] for a in figures[0]['_anchorBoxes']} == {'a','c','bd','label'}
    assert composed[-1]['id']=='footer'
    manifest=render(data,tmp_path,tmp_path/'grid.pdf')
    regions={r['id']:(p['index'],r['box']) for p in manifest['pages'] for r in p['regions']}
    assert regions.keys()=={b['id'] for b in blocks}
    assert regions['q'][0]==regions['a'][0]==regions['c'][0]==regions['bd'][0]
    assert regions['a'][1]['y'] < regions['c'][1]['y']
    assert regions['a'][1]['x'] < regions['bd'][1]['x']
    assert regions['c'][1]['height'] < regions['bd'][1]['height']


def test_column_text_order_and_independent_figures_are_preserved():
    blocks = [item('l1','Left introduction',30,30,140),item('l2','Left conclusion',30,210,140),
              item('r1','Right introduction',230,30,140),item('r2','Right conclusion',230,210,140),
              item('lf','',30,80,140,100,'figure'),item('rf','',230,80,140,100,'figure')]
    result=compose_page(blocks)
    assert [b['id'] for b in result]==['l1','lf','l2','r1','rf','r2']
    assert len([b for b in result if b['kind']=='figure'])==2


def test_short_heading_owns_wide_illustration_row_not_previous_column_option():
    blocks=[item('option','D. Previous option',230,20,120),item('q','New question',30,60,130),
            item('a','',30,100,100,80,'figure'),item('b','',230,100,100,80,'figure')]
    result=compose_page(blocks)
    assert [b['id'] for b in result]==['option','q','a']
    assert {a['id'] for a in result[-1]['_anchorBoxes']}=={'a','b'}


def test_intervening_captions_prevent_unrelated_images_from_merging():
    blocks=[item('intro','Intro',30,20),item('caption','Figure caption',30,160,160,20,'caption'),
            item('a','',30,60,160,80,'figure'),item('b','',30,195,160,80,'figure')]
    assert [b['id'] for b in compose_page(blocks)]==['intro','a','caption','b']


def test_composing_visuals_retains_each_translated_caption():
    blocks=[item('intro','Intro',30,20),item('a','',30,60,100,80,'figure'),item('b','',230,60,100,80,'figure')]
    blocks[1]['translatedText']='First illustration explanation.'
    blocks[2]['translatedText']='Second illustration explanation.'
    group=compose_page(blocks)[1]
    assert [b['translatedText'] for b in group['_figureCaptions']]==['First illustration explanation.','Second illustration explanation.']


def test_orphaned_visual_alias_is_retained_for_review():
    b=item('symbol','V',30,30,10,15,figureId='missing')
    result=compose_page([b])
    assert len(result)==1 and result[0]['id']=='symbol'
    assert not result[0].get('figureId') and 'STRUCTURE_REVIEW' in result[0]['review']


def test_long_leadin_and_large_figure_still_split_without_losing_text(tmp_path):
    from PIL import Image
    from pypdf import PdfReader
    Image.new('RGB',(400,500),'white').save(tmp_path/'page.png')
    blocks=[item('intro','Readable lead-in sentence. '*160,30,20,300,20),item('figure','',30,60,300,430,'figure')]
    data={'pages':[{'index':0,'width':400,'height':500,'scale':1,'originalFile':'page.png'}],'blocks':blocks}
    result=render(data,tmp_path,tmp_path/'long.pdf')
    assert len(result['pages'])>1
    assert ''.join(p.extract_text() for p in PdfReader(tmp_path/'long.pdf').pages).count('Readable')==160
    assert {r['id'] for p in result['pages'] for r in p['regions']}=={'intro','figure'}


def test_repeated_marginal_text_moves_after_body_but_footnotes_remain():
    pages=[{'index':i,'width':400,'height':500} for i in range(2)]
    blocks=[]
    for page in range(2):
        blocks += [item(f'footer{page}','Publisher',30,480,40,8,page=page),item(f'body{page}','Body',30,100,page=page),item(f'note{page}','1. Footnote explanation',30,450,300,15,page=page)]
    roles=furniture({'pages':pages,'blocks':blocks})
    assert roles=={'footer0':'footer','footer1':'footer'}
    assert [b['id'] for b in compose_page(blocks[:3],roles)]==['body0','note0','footer0']


def test_one_italic_variable_does_not_italicize_entire_paragraph():
    chars=[{'text':'a','fontname':'TimesNewRoman','size':11,'x0':30+i*8,'top':30} for i in range(20)]
    chars[5]['fontname']='TimesNewRoman-Italic'
    style=source_style({'box':{'x':30,'y':30,'width':300,'height':20},'label':'text'},chars,{'width':400,'scale':1})
    assert not style['italic'] and not style['bold']


def test_detached_script_attaches_only_to_a_verified_variable_and_translation():
    from types import SimpleNamespace
    parent=item('body','Voltage V is measured',30,30)
    child=item('sub','1',58.99,33,5,9)
    parent['sourceText']='电压 V 的示数'
    chars=[{'text':'V','x0':50,'x1':59,'top':30,'size':12}, {'text':'1','x0':58.99,'x1':64,'top':33,'size':7}]
    blocks=[parent,child];attach_scripts(blocks,[SimpleNamespace(chars=chars)],[{'scale':1}])
    assert child['attachment']['parentId']=='body'
    result=compose_page(blocks)
    assert [b['id'] for b in result]==['body']
    assert result[0]['_scriptInserts']==[{'offset':9,'text':'1','script':'subscript'}]
    assert result[0]['memberIds']==['body','sub']
    parent['translatedText']='The voltage is measured'
    result=compose_page(blocks)
    assert len(result)==2 and 'STRUCTURE_REVIEW' in result[1]['review']


def test_repeated_optimization_does_not_duplicate_figures_or_lose_edits(tmp_path):
    from reportlab.pdfgen import canvas
    source=tmp_path/'source.pdf';c=canvas.Canvas(str(source),pagesize=(400,500));c.drawString(30,450,'Original');c.save()
    data={'format':'pdf','pages':[{'index':0,'width':400,'height':500,'scale':1}], 'blocks':[item('text','Saved translation',30,30)]}
    data['blocks'][0]['layoutEdited']=True
    parsed={'engine':'fixture','items':[{'ref':'p0','label':'text','page':0,'text':'Original','box':{**data['blocks'][0]['box'],'height':200}},
        {'ref':'p1','label':'picture','page':0,'text':'','box':{'x':30,'y':70,'width':100,'height':100}}]}
    first=adapt_structure(data,parsed,str(source),True)
    second=adapt_structure(first,parsed,str(source),True)
    assert len(second['blocks'])==len(first['blocks'])
    assert len({b['id'] for b in second['blocks']})==len(second['blocks'])
    assert [b for b in second['blocks'] if b['id']=='text'][0]['translatedText']=='Saved translation'


def test_preserved_formula_inside_figure_is_not_printed_twice(tmp_path):
    from reportlab.pdfgen import canvas
    source=tmp_path/'source.pdf';c=canvas.Canvas(str(source),pagesize=(400,500));c.drawString(30,450,'Original');c.save()
    symbol=item('symbol','V',50,80,15,20,'formula',keepOriginal=True)
    data={'format':'pdf','pages':[{'index':0,'width':400,'height':500,'scale':1}], 'blocks':[symbol]}
    parsed={'engine':'fixture','items':[{'ref':'p1','label':'picture','page':0,'text':'','box':{'x':30,'y':70,'width':100,'height':100}}]}
    result=adapt_structure(data,parsed,str(source),True)
    saved=next(b for b in result['blocks'] if b['id']=='symbol')
    assert saved['translatedText']=='V' and saved.get('figureId')
    composed=compose_page(result['blocks'])
    assert len(composed)==1 and {a['id'] for a in composed[0]['_anchorBoxes']}=={'symbol',saved['figureId']}


def test_hidden_ocr_layer_is_not_extracted_as_visible_text(tmp_path):
    from PIL import Image, ImageDraw
    from reportlab.pdfgen import canvas
    from translate_file import extract
    png=tmp_path/'scan.png';im=Image.new('RGB',(400,500),'white');ImageDraw.Draw(im).text((30,30),'Visible scan',fill='black');im.save(png)
    source=tmp_path/'ocr.pdf';c=canvas.Canvas(str(source),pagesize=(400,500))
    for visible in [False,True]:
        c.drawImage(str(png),0,0,width=400,height=500)
        c.saveState();t=c.beginText(20,400);t.setTextRenderMode(3);t.setFont('Helvetica',300);t.textOut('CORRUPT');c.drawText(t);c.restoreState()
        if visible:c.setFont('Helvetica',12);c.drawString(30,450,'Visible native heading')
        c.showPage()
    c.save()
    d=extract({'source':str(source),'folder':str(tmp_path),'format':'pdf','sourceLanguage':'en','targetLanguage':'zh'})
    assert d['pages'][0]['textSource']=='ocr' and d['pages'][1]['textSource']=='mixed'
    assert not any('CORRUPT' in b['sourceText'] for b in d['blocks'])
    assert any('Visible native heading' in b['sourceText'] for b in d['blocks'])


def test_ocr_formulas_are_local_nodes_and_render_complete_math(tmp_path):
    from pdf_structure import math_inlines
    from pdf_reflow import render
    import pdfplumber
    from PIL import Image
    b=item('q',r'Equation \(x^{2}+4x+(a+6)=0\) and $y=1$; DE = \frac{1}{4} AD，结束',30,30)
    math_inlines(b)
    assert [s['math'] for s in b['inline'] if s.get('math')]==['x^{2}+4x+(a+6)=0','y=1',r'; DE = \frac{1}{4} AD']
    b['translatedInline']=[{'id':s['id'],'text':s['text']} for s in b['inline'] if not s.get('protected')]
    Image.new('RGB',(400,500),'white').save(tmp_path/'page.png')
    d={'pages':[{'index':0,'width':400,'height':500,'scale':1,'originalFile':'page.png'}],'blocks':[b]}
    render(d,tmp_path,tmp_path/'formula.pdf')
    with pdfplumber.open(tmp_path/'formula.pdf') as p:
        assert len(p.pages[0].images)==3
    assets=__import__('json').loads((tmp_path/'math-result.json').read_text())
    # MathJax 4 can split inline SVG at operators: make sure the entire equation
    # is rendered, not just the first x² fragment.
    assert assets['x^{2}+4x+(a+6)=0']['width']>8


def test_complete_figure_row_keeps_a_panel_missing_from_detector(tmp_path):
    from PIL import Image,ImageDraw
    from pdf_visual_regions import complete_figure_rows
    im=Image.new('RGB',(400,500),'white');draw=ImageDraw.Draw(im)
    blocks=[item('q','Question',20,30)]
    for i in range(4):
        x=30+i*90;draw.rectangle((x,100,x+60,140),outline='black',width=2)
        blocks.append(item(f'label{i}',chr(65+i)+'.',x-15,110,12,15))
        if i<3:blocks.append(item(f'figure{i}','',x,100,60,40,'figure'))
    im.save(tmp_path/'row.png');pages=[{'index':0,'width':400,'height':500,'originalFile':'row.png'}]
    complete_figure_rows(blocks,pages,tmp_path)
    result=compose_page(blocks)
    figures=[b for b in result if b['kind']=='figure']
    assert len(figures)==1
    box=figures[0]['originalBox']
    assert box['x']+box['width']>=360
    assert {a['id'] for a in figures[0]['_anchorBoxes']} >= {'label0','label1','label2','label3'}
