"""Refine OCR boxes around compact, near-uniform watermark backplates.

Only inspect a bounded neighbourhood of each text box. A component must enclose
the text and end inside that neighbourhood; the page background is not a badge.
"""
import math
from collections import defaultdict
from PIL import Image, ImageChops, ImageDraw


def padded_box(box, size, padding):
    x, y, w, h = (box[k] for k in ('x', 'y', 'width', 'height'))
    return (max(0, math.floor(x - padding)), max(0, math.floor(y - padding)),
            min(size[0], math.ceil(x + w + padding)), min(size[1], math.ceil(y + h + padding)))


def badge_bounds(image, box):
    x, y, w, h = (box[k] for k in ('x', 'y', 'width', 'height'))
    if h < 5 or w < 5 or abs(box.get('angle', 0)) > 10:
        return None
    search = padded_box(box, image.size, h * 1.5)
    crop = image.crop(search).convert('RGB')
    scale = min(1, 48 / h, 512 / crop.width)
    crop = crop.resize((max(1, round(crop.width * scale)), max(1, round(crop.height * scale))))
    sx, sy = crop.width / (search[2] - search[0]), crop.height / (search[3] - search[1])
    left, top = (x - search[0]) * sx, (y - search[1]) * sy
    right, bottom = left + w * sx, top + h * sy
    if bottom - top < 5:
        return None

    # Sample the text perimeter and the narrow ring outside it. Repeated colours
    # there are likely a badge fill; no brand names or platform templates needed.
    seeds = defaultdict(list)
    for offset in (0, .15, .35):
        dx, dy = h * sx * offset, h * sy * offset
        for fraction in (.15, .35, .5, .65, .85):
            for px, py in ((left + (right-left)*fraction, top-dy),
                           (left + (right-left)*fraction, bottom+dy),
                           (left-dx, top+(bottom-top)*fraction),
                           (right+dx, top+(bottom-top)*fraction)):
                point = (min(crop.width-1, max(0, round(px))), min(crop.height-1, max(0, round(py))))
                colour = crop.getpixel(point)
                seeds[tuple(c // 16 for c in colour)].append(point)

    best = None
    for points in sorted(seeds.values(), key=len, reverse=True)[:12]:
        seed = points[len(points)//2]
        colour = crop.getpixel(seed)
        diff = ImageChops.difference(crop, Image.new('RGB', crop.size, colour))
        r, g, b = diff.split()
        distance = ImageChops.lighter(ImageChops.lighter(r, g), b)
        component = distance.point(lambda v: 255 if v <= 22 else 0)
        ImageDraw.floodfill(component, seed, 128)
        component = component.point(lambda v: 255 if v == 128 else 0)
        bounds = component.getbbox()
        if not bounds:
            continue
        l, t, r, b = bounds
        # Reject colours that run into the search boundary, except where a badge
        # is clipped by one of the actual image edges.
        if ((l == 0 and search[0] > 0) or (t == 0 and search[1] > 0) or
                (r == crop.width and search[2] < image.width) or
                (b == crop.height and search[3] < image.height)):
            continue
        if l > left+1 or t > top+1 or r < right-1 or b < bottom-1:
            continue
        cw, ch = r-l, b-t
        if cw > (w + 2*h)*sx or ch > 2.5*h*sy:
            continue
        # The background must extend on both axes, and occupy enough of the
        # enclosing rectangle to reject isolated letters, lines and texture.
        if cw < (w + .15*h)*sx or ch < 1.15*h*sy:
            continue
        area = cw * ch
        coverage = component.histogram()[255] / area
        if coverage < .45:
            continue
        if best is None or area > best[0]:
            best = (area, (search[0] + l/sx, search[1] + t/sy,
                           search[0] + r/sx, search[1] + b/sy))
    return best[1] if best else None


def refine_boxes(image, boxes, protected=(), strict=False):
    refined = []
    for box in boxes:
        pad = 2 if strict else max(2, math.ceil(box['height'] * .08))
        bounds = padded_box(box, image.size, pad)
        badge = None if strict else badge_bounds(image, box)
        if badge:
            # Cover antialiasing and the thin outline beyond the flat component.
            outline = max(2, math.ceil(box['height'] * .08))
            l, t, r, b = badge
            expanded = padded_box({'x': l, 'y': t, 'width': r-l, 'height': b-t}, image.size, outline)
            expanded = (min(bounds[0], expanded[0]), min(bounds[1], expanded[1]),
                        max(bounds[2], expanded[2]), max(bounds[3], expanded[3]))
            # Do not absorb neighbouring OCR text outside this original box.
            def intersects(a, other):
                return (a[0] < other['x']+other['width'] and a[2] > other['x'] and
                        a[1] < other['y']+other['height'] and a[3] > other['y'])
            original = padded_box(box, image.size, 0)
            if not any(intersects(expanded, other) and not intersects(original, other) for other in protected):
                bounds = expanded
        l, t, r, b = bounds
        refined.append({'x': l, 'y': t, 'width': r-l, 'height': b-t})
    return refined
