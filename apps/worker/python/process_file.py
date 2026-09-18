"""Bounded, local-only PDF/HEIC processing. JSON file in, JSON line out."""
import io
import json
import os
import shutil
import sys
import warnings
from pathlib import Path

from PIL import Image
import pikepdf
import pillow_heif

Image.MAX_IMAGE_PIXELS = 100_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)

class ProcessingError(Exception):
    pass

def progress(value):
    print(json.dumps({'progress': value}), flush=True)

def pdf_compress(source, output, preset):
    try:
        pdf = pikepdf.open(source)
    except pikepdf.PasswordError:
        raise ProcessingError('PDF_ENCRYPTED')
    except pikepdf.PdfError:
        raise ProcessingError('INVALID_PDF')
    with pdf:
        if pdf.is_encrypted:
            raise ProcessingError('PDF_ENCRYPTED')
        if not 0 < len(pdf.pages) <= 1000:
            raise ProcessingError('PDF_PAGE_LIMIT')
        for obj in pdf.objects:
            if isinstance(obj, pikepdf.Dictionary) and (obj.get('/FT') == '/Sig' or obj.get('/Type') == '/Sig'):
                raise ProcessingError('PDF_SIGNED')
        optimized, skipped = 0, 0
        visited = set()
        longest, quality = {'light': (0, 100), 'balanced': (2560, 80), 'strong': (1600, 60)}[preset]
        def resources(res, depth=0):
            nonlocal optimized, skipped
            if depth > 40:
                raise ProcessingError('INVALID_PDF')
            if not res:
                return
            for obj in res.get('/XObject', {}).values():
                key = obj.objgen
                if key in visited:
                    continue
                visited.add(key)
                if obj.get('/Subtype') == '/Form':
                    resources(obj.get('/Resources'), depth+1)
                elif obj.get('/Subtype') == '/Image' and preset != 'light':
                    if (obj.get('/ColorSpace') not in ['/DeviceRGB', '/DeviceGray'] or
                        int(obj.get('/BitsPerComponent', 0)) != 8 or
                        any(k in obj for k in ['/SMask','/Mask','/ImageMask','/Decode','/Alternates'])):
                        skipped += 1
                        continue
                    width, height = int(obj.get('/Width',0)), int(obj.get('/Height',0))
                    if width <= 0 or height <= 0 or width*height > Image.MAX_IMAGE_PIXELS:
                        raise ProcessingError('IMAGE_LIMIT')
                    try:
                        image = pikepdf.PdfImage(obj).as_pil_image()
                        image.load()
                        if image.mode not in ['RGB','L']:
                            skipped += 1
                            continue
                        image.thumbnail((longest,longest), Image.Resampling.LANCZOS)
                        data = io.BytesIO()
                        image.save(data, format='JPEG', quality=quality, optimize=True)
                        if len(data.getvalue()) < len(obj.read_raw_bytes()):
                            obj.write(data.getvalue(), filter=pikepdf.Name.DCTDecode)
                            if '/DecodeParms' in obj: del obj['/DecodeParms']
                            obj.Width, obj.Height = image.size
                            obj.ColorSpace = pikepdf.Name.DeviceGray if image.mode=='L' else pikepdf.Name.DeviceRGB
                            obj.BitsPerComponent=8
                            optimized += 1
                    except (NotImplementedError, pikepdf.PdfError, OSError, ValueError):
                        skipped += 1
        for index, page in enumerate(pdf.pages):
            resources(page.obj.get('/Resources'))
            progress(10 + round(75*(index+1)/len(pdf.pages)))
        pages = len(pdf.pages)
        pdf.save(output, compress_streams=True, recompress_flate=True, object_stream_mode=pikepdf.ObjectStreamMode.generate)
    with pikepdf.open(output) as verified:
        if len(verified.pages) != pages:
            raise ProcessingError('INVALID_OUTPUT')
        if verified.check_pdf_syntax():
            raise ProcessingError('INVALID_OUTPUT')
    note = 'PARTIAL_OPTIMIZATION' if skipped else None
    if os.path.getsize(output) >= os.path.getsize(source):
        shutil.copyfile(source, output)
        note = 'UNCHANGED'
    return {'media': {'kind':'pdf','pages':pages,'optimizedImages':optimized,'skippedImages':skipped},'note':note}

def heic_compress(source, output, preset, folder):
    heif = pillow_heif.open_heif(source, convert_hdr_to_8bit=False)
    total = 0
    for image in heif:
        width,height=image.size
        total += width*height
        if width*height > Image.MAX_IMAGE_PIXELS or total>250_000_000 or len(heif)>100:
            raise ProcessingError('IMAGE_LIMIT')
    primary = heif.primary_index
    original_preview = str(Path(folder)/'original.jpg')
    preview = str(Path(folder)/'preview.jpg')
    def save_preview(file, target):
        im=pillow_heif.open_heif(file,convert_hdr_to_8bit=True).to_pillow()
        im.thumbnail((1600,1600), Image.Resampling.LANCZOS)
        im.convert('RGB').save(target,quality=88,icc_profile=im.info.get('icc_profile'))
    save_preview(source,original_preview)
    # Auxiliary depth / HDR gain maps cannot all be round-tripped by the Pillow API.
    special=any(im.info.get('aux') or im.info.get('depth_images') for im in heif)
    if special:
        shutil.copyfile(source,output)
    else:
        heif.save(output,quality={'light':85,'balanced':65,'strong':45}[preset],save_all=True,primary_index=primary)
    result=pillow_heif.open_heif(output,convert_hdr_to_8bit=False)
    if len(result)!=len(heif) or result.size != heif.size:
        raise ProcessingError('INVALID_OUTPUT')
    note=None
    if special or os.path.getsize(output)>=os.path.getsize(source):
        shutil.copyfile(source,output)
        note='UNCHANGED'
    save_preview(output,preview)
    return {'media':{'kind':'image','width':heif.size[0],'height':heif.size[1],'format':'heic','pages':len(heif),'hasAlpha':heif.has_alpha},'note':note,'inputPreview':original_preview,'outputPreview':preview}

def main():
    data=json.loads(Path(sys.argv[1]).read_text())
    source,output,preset=data['source'],data['output'],data['preset']
    try:
        if data['tool']=='pdf-compressor':
            result=pdf_compress(source,output,preset)
        else:
            result=heic_compress(source,output,preset,str(Path(output).parent))
        print(json.dumps(result),flush=True)
    except Exception as exc:
        code=str(exc) if isinstance(exc,ProcessingError) else ('INVALID_PDF' if data['tool']=='pdf-compressor' else 'INVALID_IMAGE')
        print(json.dumps({'error':code}),flush=True)
        print(type(exc).__name__+': '+str(exc),file=sys.stderr)
        sys.exit(1)

if __name__=='__main__': main()
