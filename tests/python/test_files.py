import importlib.util
from pathlib import Path
import json
import pytest
from PIL import Image, ImageSequence
from pypdf import PdfReader
import pikepdf
import pillow_heif

ROOT=Path(__file__).resolve().parents[2]
FIXTURES=ROOT/'.data/fixtures'
CHECKS=ROOT/'.data/processor-checks'
spec=importlib.util.spec_from_file_location('process_file',ROOT/'apps/worker/python/process_file.py')
processor=importlib.util.module_from_spec(spec)
spec.loader.exec_module(processor)

@pytest.mark.parametrize('name',['animated.gif','animated.webp'])
@pytest.mark.parametrize('preset',['light','balanced','strong'])
def test_animation_timing_transparency(name,preset):
    source=Image.open(FIXTURES/name)
    result=Image.open(CHECKS/f'{name}-{preset}'/f'output.{name.split(".")[-1]}')
    assert source.n_frames==result.n_frames
    assert source.info['loop']==result.info['loop']
    # WebP delay becomes available after decoding the frame.
    def frames(image):
        output=[]
        for frame in ImageSequence.Iterator(image):
            rgba=frame.convert('RGBA')
            output.append((frame.info.get('duration'),rgba.getpixel((0,0))[3]))
        return output
    assert frames(source)==frames(result)

@pytest.mark.parametrize('preset',['light','balanced','strong'])
def test_transparent_background(preset):
    result=Image.open(CHECKS/f'transparent.png-{preset}'/'output.png').convert('RGBA')
    assert result.getpixel((0,0))[3]==0
    assert result.getpixel((200,200))[3]>0

@pytest.mark.parametrize('preset',['light','balanced','strong'])
def test_pdf_semantics(preset):
    source=PdfReader(FIXTURES/'document.pdf')
    result=PdfReader(CHECKS/f'document.pdf-{preset}'/'output.pdf')
    assert [p.extract_text() for p in source.pages]==[p.extract_text() for p in result.pages]
    assert [list(p.mediabox) for p in source.pages]==[list(p.mediabox) for p in result.pages]
    assert source.outline[0]['/Title']==result.outline[0]['/Title']
    assert source.get_fields()['customer']['/V']==result.get_fields()['customer']['/V']
    for a,b in zip(source.pages,result.pages):
        def links(page):return [o.get_object().get('/A',{}).get('/URI') for o in page.get('/Annots',[])]
        assert links(a)==links(b)

@pytest.mark.parametrize('name,code',[('encrypted.pdf','PDF_ENCRYPTED'),('signed.pdf','PDF_SIGNED'),('broken.pdf','INVALID_PDF')])
def test_pdf_rejection(name,code,tmp_path):
    with pytest.raises(processor.ProcessingError,match=code):
        processor.pdf_compress(FIXTURES/name,tmp_path/'out.pdf','balanced')

def test_rotation():
    output=Image.open(CHECKS/'oriented.jpg-strong/output.jpg')
    assert output.size==(480,640)
    assert output.getexif().get(274,1)==1

def test_heic_format():
    source=pillow_heif.open_heif(FIXTURES/'photo.heic')
    result=pillow_heif.open_heif(CHECKS/'photo.heic-balanced/output.heic')
    assert source.size==result.size
    assert result.info['bit_depth']==source.info['bit_depth']
    assert result.mimetype=='image/heic'

def test_heic_primary_relationship(tmp_path):
    heif=pillow_heif.from_pillow(Image.new('RGB',(100,80),'red'))
    heif.add_from_pillow(Image.new('RGB',(60,40),'blue'))
    source=tmp_path/'multi.heic';output=tmp_path/'output.heic'
    heif.save(source,quality=95,primary_index=1)
    processor.heic_compress(source,output,'strong',tmp_path)
    a,b=pillow_heif.open_heif(source),pillow_heif.open_heif(output)
    assert len(a)==len(b)==2
    assert a.primary_index==b.primary_index
    assert a.size==b.size

def test_50_mib_pdf(tmp_path):
    source=FIXTURES/'large.pdf'
    with pikepdf.Pdf.new() as pdf:
        page=pdf.add_blank_page(page_size=(600,800))
        image=pdf.make_stream(bytes([210])*49_000_000)
        image.Type=pikepdf.Name.XObject;image.Subtype=pikepdf.Name.Image
        image.Width=7000;image.Height=7000;image.BitsPerComponent=8;image.ColorSpace=pikepdf.Name.DeviceGray
        page.Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=image))
        page.Contents=pdf.make_stream(b'q 600 0 0 800 0 0 cm /Im0 Do Q')
        pdf.save(source,compress_streams=False)
    with source.open('ab') as file:file.write(b' '*(50*1024**2-source.stat().st_size))
    assert source.stat().st_size==50*1024**2
    result=processor.pdf_compress(source,tmp_path/'output.pdf','balanced')
    assert result['media']['pages']==1
    assert (tmp_path/'output.pdf').stat().st_size<source.stat().st_size
