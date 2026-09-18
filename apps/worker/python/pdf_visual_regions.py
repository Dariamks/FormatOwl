"""Preserve complete illustration rows, including panels missed by layout detection."""
import copy
import re
from PIL import Image


def complete_figure_rows(blocks, pages, folder):
    # Text/figure detectors identify the row; source pixels define its extent.
    # A missing panel must not vanish merely because the detector omitted a box.
    for page in pages:
        figures=[b for b in blocks if b['page']==page['index'] and b['kind']=='figure' and b.get('box')]
        labels=[b for b in blocks if b['page']==page['index'] and re.fullmatch(r'[A-H][.、)]?',b['sourceText'].strip()) and b.get('box')]
        if not page.get('originalFile'):continue
        for anchor in list(figures):
            if anchor.get('figureId'):continue
            box=anchor.get('originalBox') or anchor['box']
            row=[f for f in figures if not f.get('figureId') and abs((f.get('originalBox') or f['box'])['y']-box['y'])<box['height']*.2 and abs((f.get('originalBox') or f['box'])['height']-box['height'])<box['height']*.3]
            row_labels=[b for b in labels if box['y']<=b['box']['y']+b['box']['height']/2<=box['y']+box['height']]
            if len(row)<2 or len(row_labels)<2:continue
            # Do not absorb prose or figures from another column at the same height.
            ymin=min(f['box']['y'] for f in row); ymax=max(f['box']['y']+f['box']['height'] for f in row)
            if any(b['page']==page['index'] and b not in row and b not in row_labels and b['kind'] not in ('figure','formula') and b.get('box') and ymin<b['box']['y']+b['box']['height']/2<ymax for b in blocks):continue
            with Image.open(folder/page['originalFile']) as image:
                # All source ink in this isolated graphic row is retained. This is
                # a crop of the original, not a generated/reconstructed diagram.
                band=image.convert('L').crop((0,int(ymin),image.width,int(ymax+1)))
                ink=band.point(lambda v:255 if v<180 else 0).getbbox()
            if not ink:continue
            x0,y0,x1,y1=ink
            anchor['originalBox']={'x':max(0,x0-2),'y':max(0,ymin+y0-2),'width':min(page['width'],x1+2)-max(0,x0-2),'height':y1-y0+4,'angle':0}
            anchor['box']=dict(anchor['originalBox'])
            for child in row+row_labels:
                if child is not anchor:child['figureId']=anchor['id']
