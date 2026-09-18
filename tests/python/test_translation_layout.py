import sys,copy
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'apps/worker/python'))
from translation_layout import paragraph_blocks,expand_regions,intersects,render_data
from translate_file import block,extract,export,preview_page

def line(id,text,x,y,width=220,kind='text'):
 b=block(text,0,box={'x':x,'y':y,'width':width,'height':12,'angle':0},kind=kind)
 b.update(id=id,raster=False);b['style']['fontSize']=12
 return b

def test_columns_paragraphs_and_table_boundaries():
 a=line('a','A long opening sentence continues',30,30);b=line('b','on its next line.',30,46)
 c=line('c','The right column stays separate.',310,30);d=line('d','with its own continuation.',310,46)
 t=line('t','Cell',30,75,100,'table')
 blocks=paragraph_blocks([a,c,b,d,t]);assert len(blocks)==3
 assert blocks[0]['memberIds']==['a','b'];assert blocks[1]['memberIds']==['c','d'];assert blocks[2]['kind']=='table'
 expanded=expand_regions(blocks,[{'width':600,'height':800,'obstacles':[{'x':30,'y':100,'width':250,'height':150}]}])
 assert not intersects(expanded[0]['box'],expanded[1]['box']);assert expanded[0]['box']['y']+expanded[0]['box']['height']<75
 # A short upper-right label and a lower-left paragraph must not expand into each other.
 staggered=expand_regions([line('right','Label',400,30,80),line('left','A lower paragraph',30,55,250)],[{'width':600,'height':800}])
 assert not intersects(staggered[0]['box'],staggered[1]['box'])

def test_legacy_ids_and_saved_content_are_immutable():
 a=line('a','Paragraph begins here and continues',30,30);b=line('b','at the next line',30,46)
 a['translatedText']='译文第一行';b['translatedText']='译文第二行'
 data={'format':'pdf','pages':[{'width':600,'height':800}], 'blocks':[a,b]};before=copy.deepcopy(data)
 result=render_data(data);assert data==before;assert result['blocks'][0]['memberIds']==['a','b'];assert '译文第二行' in result['blocks'][0]['translatedText']
 data['layoutVersion']=2;assert render_data(data)['blocks']==data['blocks']

def test_preview_matches_export_rendering(tmp_path):
 from reportlab.pdfgen import canvas
 from PIL import Image,ImageChops
 import pypdfium2 as pdfium
 src=tmp_path/'source.pdf';c=canvas.Canvas(str(src),pagesize=(500,400));c.drawString(40,350,'A document for translation.');c.save()
 data=extract({'source':str(src),'format':'pdf','folder':str(tmp_path),'sourceLanguage':'en','targetLanguage':'zh'})
 for b in data['blocks']:b['translatedText']='这是一份用于翻译的文件。'
 output=tmp_path/'result.pdf';r=export({'data':data,'folder':str(tmp_path),'source':str(src),'output':str(output),'options':{'format':'pdf','mode':'translated'}});assert not r['overflow']
 png=tmp_path/'preview.png';preview_page({'data':data,'page':0,'folder':str(tmp_path),'output':str(png)})
 actual=Image.open(png).convert('RGB');expected=pdfium.PdfDocument(str(output))[0].render(scale=data['pages'][0]['scale']).to_pil().convert('RGB')
 assert actual.size==expected.size;assert ImageChops.difference(actual,expected).getbbox() is None

def test_repair_crop_aspect_and_outside_pixels(tmp_path):
 from PIL import Image,ImageChops
 from translate_file import main,restore_region,region_mask
 for width,height in [(2800,800),(20,1000)]:
  image=Image.new('RGBA',(width,height),(220,240,250,128));source=tmp_path/'original.png';image.save(source)
  box={'x':1,'y':20,'width':width-2,'height':min(height-30,40 if width>100 else 900),'angle':0}
  crop=main({'action':'crop','source':str(source),'box':box,'output':str(tmp_path/'crop.png')});patch=Image.open(tmp_path/'crop.png')
  assert .1<=patch.height/patch.width<=10
  Image.new('RGB',patch.size,'blue').save(tmp_path/'patch.png')
  restore_region({'background':str(source),'original':str(source),'patch':str(tmp_path/'patch.png'),'crop':crop,'box':box,'output':str(tmp_path/'result.png')})
  result=Image.open(tmp_path/'result.png');diff=ImageChops.difference(image,result).convert('RGB');diff.paste((0,0,0),(0,0),region_mask(image.size,box));assert diff.getbbox() is None;assert image.getchannel('A').tobytes()==result.getchannel('A').tobytes()

def test_native_pdf_preserves_inline_formula_ink(tmp_path):
 from PIL import Image,ImageDraw
 from translate_file import pdf_render,background_collision
 b=line('inline','Text around a formula',20,20,200);b['box']['height']=35;b['translatedText']='The translated sentence is longer.'
 image=Image.new('RGB',(300,150),'white');draw=ImageDraw.Draw(image)
 # A vector formula embedded inside the text region remains in the PDF background.
 draw.text((95,25),'x2 + y2',fill='black')
 assert background_collision(image,b,30)
 assert not background_collision(Image.new('RGB',image.size,'#eff4ef'),b,30)
 image.save(tmp_path/'background.png');image.save(tmp_path/'original.png')
 data={'format':'pdf','layoutVersion':2,'pages':[{'index':0,'width':300,'height':150,'scale':1,'originalFile':'original.png','backgroundFile':'background.png'}],'blocks':[b]}
 assert pdf_render(data,tmp_path,tmp_path/'formula.pdf','translated')==['inline']
 b['keepOriginal']=True
 assert not pdf_render(data,tmp_path,tmp_path/'preserved.pdf','translated')
 from translate_file import formula_fragment
 assert formula_fragment('2gh') and formula_fragment('t t t 2t \uf02d') and formula_fragment('x')
 assert not formula_fragment('The height is 2h') and not formula_fragment('位移与时间的比值')
 b['keepOriginal']=False;b['box']['width']=15;b['box']['height']=100;b['sourceText']='2gh';b['translatedText']='2 hours'
 Image.new('RGB',image.size,'white').save(tmp_path/'background.png')
 assert pdf_render(data,tmp_path,tmp_path/'narrow.pdf','translated')==['inline']

def test_ocr_grouping_keeps_full_sentences_and_text_colour(tmp_path):
 from PIL import Image,ImageDraw
 from translate_file import tiles,ocr_layout
 image=Image.new('RGB',(2880,2000),'white');draw=ImageDraw.Draw(image)
 draw.rectangle((20,15,250,70),fill='black');draw.text((32,31),'White button text',fill='white')
 path=tmp_path/'source.png';image.save(path)
 assert len(tiles({'source':str(path),'folder':str(tmp_path)})['tiles'])==1
 a=line('a','A long sentence that continues',30,100);b=line('b','without being split.',30,116)
 a['raster']=b['raster']=True
 button=line('button','White button text',30,30,150);button['raster']=True
 grouped=ocr_layout({'source':str(path),'blocks':[button,a,b]})['blocks']
 assert len(grouped)==2;assert grouped[1]['sourceText'].endswith('without being split.')
 # Antialiasing changes the exact shade, but dark-button text must remain light.
 assert all(int(grouped[0]['style']['color'][i:i+2],16)>=224 for i in (1,3,5))

def test_flat_text_cleanup_is_bounded_and_rejects_texture(tmp_path):
 from PIL import Image,ImageDraw,ImageChops
 from translate_file import flat_background,image_render,region_mask
 original=Image.new('RGBA',(300,150),'white');draw=ImageDraw.Draw(original);draw.text((35,40),'Original label',fill='black')
 box={'x':25,'y':25,'width':150,'height':45,'angle':0}
 assert flat_background(original,box)==(255,255,255)
 b=line('label','Original label',25,25,150);b.update(box=box,originalBox=box,translatedText='译文',raster=True)
 original.save(tmp_path/'original.png')
 data={'pages':[{'originalFile':'original.png','backgroundFile':'original.png'}],'blocks':[b]}
 rendered,errors=image_render(data,tmp_path,0,'translated');assert not errors
 # The old English glyphs are gone even if the model returned the unchanged image.
 assert rendered.crop((80,35,170,60)).convert('RGB').getextrema()==((255,255),(255,255),(255,255))
 diff=ImageChops.difference(original,rendered).convert('RGB');diff.paste((0,0,0),(0,0),region_mask(original.size,box));assert diff.getbbox() is None
 draw.line((25,25,175,25),fill='blue',width=2)
 assert flat_background(original,box) is None
