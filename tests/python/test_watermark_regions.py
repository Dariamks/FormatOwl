import sys
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageChops

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'apps/worker/python'))
from watermark_regions import refine_boxes
import watermark_file as wm


def scene(colour='#bfc0c3', scale=1, jpeg=False, edge=False):
    image = Image.new('RGB', (360, 260))
    # Texture outside the plate makes accidental growth into the scene visible.
    image.putdata([(25+x//8, 42+y//9, 85+(x*y)%19) for y in range(260) for x in range(360)])
    clean = image.copy()
    draw = ImageDraw.Draw(image)
    plate = (258, 191, 360 if edge else 354, 235)
    draw.rounded_rectangle(plate, radius=21, fill=colour)
    # Dense glyph-like marks, with a known OCR box inside the backplate.
    for x in range(272, 342, 12):
        draw.rectangle((x, 202, x+5, 223), fill='#142743')
        draw.rectangle((x, 209, x+8, 214), fill='#142743')
    box = {'x': 272, 'y': 202, 'width': 69, 'height': 22, 'angle': 0}
    if scale != 1:
        image = image.resize((360*scale, 260*scale))
        clean = clean.resize(image.size)
        box = {k: v*scale if k != 'angle' else v for k, v in box.items()}
    if jpeg:
        stream = BytesIO()
        image.save(stream, format='JPEG', quality=83)
        stream.seek(0)
        image = Image.open(stream).convert('RGB')
    return image, clean, box, tuple(v*scale for v in plate)


@pytest.mark.parametrize('colour', ['#bfc0c3', '#f53f64', '#327ec9'])
@pytest.mark.parametrize('scale,jpeg', [(1, False), (1, True), (4, True)])
def test_encloses_complete_rounded_plate_without_large_background_growth(colour, scale, jpeg):
    image, _, box, plate = scene(colour, scale, jpeg)
    result = refine_boxes(image, [box])[0]
    assert result['x'] <= plate[0] and result['y'] <= plate[1]
    assert result['x'] + result['width'] >= plate[2]
    assert result['y'] + result['height'] >= plate[3]
    assert result['width'] < (plate[2]-plate[0]) + 12*scale
    assert result['height'] < (plate[3]-plate[1]) + 12*scale


@pytest.mark.parametrize('textured', [False, True])
def test_plain_text_does_not_select_surrounding_background(textured):
    image, clean, box, _ = scene()
    image = clean if textured else Image.new('RGB', image.size, '#eeeeee')
    ImageDraw.Draw(image).text((box['x'], box['y']), 'SAMPLE', fill='black')
    result = refine_boxes(image, [box])[0]
    assert result['width'] <= box['width'] + 6
    assert result['height'] <= box['height'] + 6


def test_partial_plate_at_image_edge_is_clamped():
    image, _, box, _ = scene(edge=True)
    result = refine_boxes(image, [box])[0]
    assert result['x'] <= 258
    assert result['x'] + result['width'] == image.width
    assert 0 <= result['y'] < result['y'] + result['height'] <= image.height


def test_does_not_absorb_neighbouring_text():
    image, _, box, _ = scene()
    nearby = {'x': 262, 'y': 201, 'width': 6, 'height': 22}
    result = refine_boxes(image, [box], [box, nearby])[0]
    assert result['x'] > nearby['x'] + nearby['width']


def test_scanned_document_keeps_conservative_text_selection():
    image, _, box, _ = scene()
    result = refine_boxes(image, [box], strict=True)[0]
    assert result == {'x': 270, 'y': 200, 'width': 73, 'height': 26}


def test_repair_mask_contains_whole_plate_and_preserves_outside_pixels(tmp_path):
    image, clean, box, _ = scene()
    bounds = refine_boxes(image, [box])[0]
    region = {'kind': 'rect', 'strokes': [], 'x': bounds['x']/image.width,
              'y': bounds['y']/image.height, 'width': bounds['width']/image.width,
              'height': bounds['height']/image.height}
    mask = wm.make_mask(image.size, [region])
    marks = ImageChops.difference(image, clean)
    outside = Image.new('RGB', image.size)
    outside.paste(marks, mask=ImageChops.invert(mask))
    assert not outside.getbbox(), 'Every plate pixel must be inside the repair mask'
    image.save(tmp_path/'source.png')
    clean.save(tmp_path/'patch.png')
    mask.save(tmp_path/'mask.png')
    wm.compose({'source': tmp_path/'source.png', 'patch': tmp_path/'patch.png',
                'mask': tmp_path/'mask.png', 'box': [0, 0, *image.size], 'output': tmp_path/'out.png'})
    assert not ImageChops.difference(Image.open(tmp_path/'out.png').convert('RGB'), clean).getbbox()
