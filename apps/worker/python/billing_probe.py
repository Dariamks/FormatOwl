"""Read-only, bounded metadata/text-count probe. Never performs OCR or model calls."""
import json, sys, zipfile, re
from pathlib import Path
from defusedxml import ElementTree as ET
from pypdf import PdfReader
from PIL import Image
import pillow_heif
pillow_heif.register_heif_opener()
Image.MAX_IMAGE_PIXELS = 100_000_000
path, name = Path(sys.argv[1]), sys.argv[2]
ext = Path(name).suffix.lower()
facts = {'bytes':path.stat().st_size, 'source':'worker-probe-v1'}
if ext == '.pdf':
    reader = PdfReader(path)
    if reader.is_encrypted: raise ValueError('Encrypted PDF')
    if len(reader.pages)>1000: raise ValueError('Too many pages')
    texts = [p.extract_text() or '' for p in reader.pages]
    facts.update(pages=len(texts), characters=sum(len(t) for t in texts), scanPages=sum(not t.strip() for t in texts))
elif ext in ('.docx','.pptx','.epub'):
    count=0; pages=0
    with zipfile.ZipFile(path) as z:
        if sum(f.file_size for f in z.infolist())>64*1024*1024: raise ValueError('Expanded document too large')
        for f in z.infolist():
            if ext=='.docx' and f.filename!='word/document.xml': continue
            if ext=='.pptx' and not re.match(r'ppt/slides/slide\d+\.xml$',f.filename): continue
            if ext=='.epub' and not f.filename.endswith(('.html','.xhtml')): continue
            root=ET.fromstring(z.read(f))
            count+=sum(len(t) for t in root.itertext()); pages+=1
    facts.update(characters=count,pages=pages,scanPages=0)
    if ext=='.docx': facts['warnings']=['DOCX pagination requires rendered production calibration']
elif ext in ('.txt','.srt','.vtt','.ass'):
    data=path.read_bytes()
    if len(data)>50*1024*1024: raise ValueError('Text too large')
    facts.update(characters=len(data.decode('utf-8',errors='replace')),pages=1,scanPages=0)
elif ext=='.svg':
    root=ET.fromstring(path.read_bytes());texts=list(root.itertext())
    facts.update(characters=sum(len(t) for t in texts),pages=1,scanPages=1,width=2048,height=2048,imagePixels=2048*2048)
    facts['warnings']=['SVG raster size estimated; rendering is metered separately']
else:
    with Image.open(path) as im:
        frames=getattr(im,'n_frames',1)
        if frames>500 or im.width*im.height*frames>250_000_000: raise ValueError('Too many pixels')
        facts.update(width=im.width,height=im.height,frames=frames,imagePixels=im.width*im.height*frames,pages=1,scanPages=1)
print(json.dumps(facts))
