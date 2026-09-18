import sys, json
from PIL import Image, ImageOps, ImageCms
import pillow_heif
try:
    heif = pillow_heif.open_heif(sys.argv[1], convert_hdr_to_8bit=True)
    if len(heif)>100 or sum(i.size[0]*i.size[1] for i in heif)>250_000_000:
        raise ValueError('IMAGE_LIMIT')
    item=heif[heif.primary_index]
    if item.size[0]*item.size[1]>100_000_000: raise ValueError('IMAGE_LIMIT')
    image=item.to_pillow()
    image=ImageOps.exif_transpose(image)
    icc=image.info.get('icc_profile')
    if icc:
        from io import BytesIO
        image=ImageCms.profileToProfile(image,ImageCms.ImageCmsProfile(BytesIO(icc)),ImageCms.createProfile('sRGB'),outputMode='RGBA' if 'A' in image.getbands() else 'RGB')
    image.info.pop('exif',None)
    image.save(sys.argv[2],format='PNG')
    print(json.dumps({'pages':len(heif)}))
except Exception as e:
    print('FM_ERROR:'+('IMAGE_LIMIT' if str(e)=='IMAGE_LIMIT' else 'INVALID_IMAGE'))
    sys.exit(1)
