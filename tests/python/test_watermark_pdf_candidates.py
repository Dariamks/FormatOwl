import sys
from pathlib import Path

import pikepdf
import pytest
from PIL import Image, ImageDraw, ImageChops
from pypdf import PdfReader
from reportlab.pdfgen import canvas

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'apps/worker/python'))
import watermark_file as wm


def dense_pdf(folder, label='abc'):
    logo=Image.new('RGBA',(106,32));d=ImageDraw.Draw(logo)
    d.rounded_rectangle((60,0,105,20),radius=9,fill=(90,90,90,65))
    d.text((2,21),'SAMPLE 123',fill=(40,40,40,70));logo.save(folder/'logo.png')
    source=folder/'source.pdf';c=canvas.Canvas(str(source),pagesize=(600,800))
    for i in range(3):
        c.drawString(40,760,'KEEP page '+str(i+1))
        c.drawImage(str(folder/'logo.png'),470,10,width=106,height=32,mask='auto')
        c.showPage()
    c.save();dense=folder/'dense.pdf'
    with pikepdf.open(source) as pdf:
        for page in pdf.pages:
            page.Resources.ExtGState=pikepdf.Dictionary(Opaque=pikepdf.Dictionary(ca=1,CA=1))
            # Exporters frequently wrap each formula glyph in q/BT/ET/Q and
            # report a large Tf scaled down by Tm. These are ordinary 12pt glyphs.
            body=b'\n'.join(f'q BT /F1 240 Tf /Opaque gs .05 0 0 .05 {40+(i%30)*16} {720-(i//30)*20} Tm ({label}) Tj ET Q'.encode() for i in range(210))
            page.Contents=pdf.make_stream(body+b'\n'+page.Contents.read_bytes())
        pdf.save(dense)
    return dense


def test_dense_body_does_not_exhaust_watermark_limit_and_masked_logos_are_removable(tmp_path):
    source=dense_pdf(tmp_path)
    data=wm.analyze({'source':source,'format':'pdf','folder':tmp_path})
    assert len(data['pages'])==3
    assert len(data['candidates'])==3
    assert all(c['label']=='PDF image' and c['reason']=='repeated' for c in data['candidates'])
    assert data['targets']==[], 'Soft-masked logos can be deleted, but not repainted'
    out=tmp_path/'out.pdf'
    wm.export_file({'source':source,'folder':tmp_path,'data':data,'selection':{'candidates':[c['id'] for c in data['candidates']],'regions':[]},'output':out,'prefix':'out'})
    before=PdfReader(source);after=PdfReader(out)
    for i in range(3):
        assert before.pages[i].extract_text()==after.pages[i].extract_text()
        a=wm.image_open(tmp_path/f'page-{i}.png');b=wm.image_open(tmp_path/f'out-{i}.png')
        diff=ImageChops.difference(a,b).convert('RGB').getbbox()
        assert diff and diff[0]>=700 and diff[1]>=1130


def test_genuinely_excessive_watermark_candidates_keep_a_specific_limit(tmp_path):
    source=dense_pdf(tmp_path,'SAMPLE')
    with pytest.raises(ValueError,match='WATERMARK_OBJECT_LIMIT'):
        wm.analyze({'source':source,'format':'pdf','folder':tmp_path})


@pytest.mark.parametrize('alpha,size,tm,expected', [
    (1,24,'1 0 0 1',None),
    (.5,24,'1 0 0 1','transparent'),
    (1,24,'.866 .5 -.5 .866','rotated'),
    (1,240,'.05 0 0 .05',None),
])
def test_text_candidates_use_actual_opacity_and_effective_font_size(alpha,size,tm,expected):
    with pikepdf.new() as pdf:
        page=pdf.add_blank_page();page.Resources=pikepdf.Dictionary(ExtGState=pikepdf.Dictionary(Style=pikepdf.Dictionary(ca=alpha,CA=alpha)))
        page.Contents=pdf.make_stream(f'q BT /F1 {size} Tf /Style gs {tm} 50 50 Tm (NOTES) Tj ET Q'.encode())
        candidates=wm.pdf_candidates(page,0)
        if expected:assert len(candidates)==1 and candidates[0]['reason']==expected
        else:assert candidates==[]


def test_cid_watermark_label_uses_font_encoding(tmp_path):
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
    path=tmp_path/'chinese.pdf';c=canvas.Canvas(str(path))
    c.setFont('STSong-Light',12);c.drawString(50,700,'水印');c.drawString(50,670,'保留正文');c.save()
    with pikepdf.open(path) as pdf:
        marks=wm.pdf_candidates(pdf.pages[0],0,font_decoder=wm.pdf_font_decoder(path))
        assert len(marks)==1 and marks[0]['label']=='水印'


def test_images_with_different_soft_masks_are_not_grouped(tmp_path):
    source=dense_pdf(tmp_path)
    with pikepdf.open(source) as pdf:
        one=wm.pdf_candidates(pdf.pages[0],0)[0]
        two=wm.pdf_candidates(pdf.pages[1],1)[0]
        original=two['image'];replacement=pdf.make_stream(original.read_bytes())
        for k,v in original.items():
            if str(k) not in ('/Length','/Filter','/DecodeParms'):replacement[k]=v
        mask=pdf.make_stream(bytes([255])*(106*32));mask.Type=pikepdf.Name('/XObject');mask.Subtype=pikepdf.Name('/Image');mask.Width=106;mask.Height=32;mask.BitsPerComponent=8;mask.ColorSpace=pikepdf.Name('/DeviceGray');replacement.SMask=mask
        cmd=wm.pdf_instructions(pdf.pages[1]);name=cmd[two['locator']['start']].operands[0]
        pdf.pages[1].Resources.XObject[name]=replacement
        changed=wm.pdf_candidates(pdf.pages[1],1)[0]
        assert one['group']!=changed['group']
