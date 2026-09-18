"""Compose PDF reading flow from semantic text order and source geometry.

Layout detectors can emit pictures after all the text on a page. Keep their
column-aware text order, but anchor visuals in the same source column and keep
connected illustration panels together. This is a render-only view: saved IDs,
translations and edits are never rewritten by composition.
"""
import copy
import re
import statistics
import unicodedata


def rect(block):
    return block.get('originalBox') or block.get('box') or {}


def right(box):
    return box['x'] + box['width']


def bottom(box):
    return box['y'] + box['height']


def union(boxes):
    x = min(b['x'] for b in boxes); y = min(b['y'] for b in boxes)
    return {'x': x, 'y': y, 'width': max(right(b) for b in boxes)-x,
            'height': max(bottom(b) for b in boxes)-y, 'angle': 0}


def x_overlap(a, b):
    return max(0, min(right(a), right(b))-max(a['x'], b['x'])) / max(1, min(a['width'], b['width']))


def simple_label(block):
    value = unicodedata.normalize('NFKC', block['sourceText']).strip()
    return bool(re.fullmatch(r'(?:[A-Ha-h][.、)]?\s*){1,2}|\([a-hA-H]\)|[甲乙丙丁戊己]', value))


def punctuation(block):
    return bool(re.fullmatch(r'[\s）)\]】。，、：:；;]+', block['sourceText']))


def furniture(data):
    """Only recurring marginal text and explicit page numbers are page furniture."""
    repeated = {}
    for b in data['blocks']:
        box = rect(b); page = data['pages'][b['page']]
        if not box or b['kind'] in ('figure', 'formula', 'table'): continue
        edge = 'header' if bottom(box) < page['height']*.065 else 'footer' if box['y'] > page['height']*.93 else None
        if edge:
            key = (edge, re.sub(r'\d+', '#', re.sub(r'\s+', '', b['sourceText'])))
            repeated.setdefault(key, set()).add(b['page'])
    result = {}
    for b in data['blocks']:
        box = rect(b); page = data['pages'][b['page']]
        role = b.get('layoutRole')
        if not role and box:
            edge = 'header' if bottom(box) < page['height']*.065 else 'footer' if box['y'] > page['height']*.93 else None
            key = (edge, re.sub(r'\d+', '#', re.sub(r'\s+', '', b['sourceText'])))
            page_number = re.fullmatch(r'\s*(?:第\s*\d+\s*页\s*[/／]?\s*共\s*\d+\s*页|(?:Page\s*)?\d+\s*(?:/|of)\s*\d+)\s*', b['sourceText'], re.I)
            if edge and (len(repeated.get(key, set())) >= 2 or page_number): role = edge
        if role: result[b['id']] = role
    return result


def compose_page(source_blocks, roles=None):
    blocks = copy.deepcopy(source_blocks); roles = roles or {}
    by_id = {b['id']: b for b in blocks}
    for b in blocks:
        if b.get('figureId') and b['figureId'] not in by_id:
            b.pop('figureId')
            if 'STRUCTURE_REVIEW' not in b['review']:b['review'].append('STRUCTURE_REVIEW')
    attached=set()
    for b in blocks:
        attachment=b.get('attachment');parent=by_id.get((attachment or {}).get('parentId'))
        if not parent or parent.get('inline') or not parent.get('translatedText'):continue
        pattern=r'(?<![A-Za-z])'+re.escape(attachment['token'])+r'(?![A-Za-z])'
        matches=list(re.finditer(pattern,parent['translatedText']))
        if len(matches)!=attachment['count']:
            if 'STRUCTURE_REVIEW' not in b['review']:b['review'].append('STRUCTURE_REVIEW')
            continue
        offset=matches[attachment['occurrence']].end();value=b['sourceText'].strip()
        if not parent['translatedText'][offset:].startswith(value):
            parent.setdefault('_scriptInserts',[]).append({'offset':offset,'text':value,'script':attachment['script']})
        parent.setdefault('memberIds',[parent['id']]).append(b['id']);attached.add(b['id'])
    blocks=[b for b in blocks if b['id'] not in attached]
    for b in blocks:
        if b['id'] in roles:
            b['layoutRole'] = roles[b['id']]
            if not b.get('layoutEdited'):
                b['style'] = {**b['style'], 'bold': False, 'italic': False, 'color': '#68707c'}
    # Punctuation fragments belong to a paragraph, not to the visual following it.
    combined = []
    for b in blocks:
        if not b.get('figureId') and punctuation(b) and b.get('structureId'):
            parent = next((p for p in reversed(combined) if p.get('structureId') == b['structureId'] and not p.get('figureId') and not punctuation(p)), None)
            if parent:
                token = b.get('translatedText') or b['sourceText']
                if parent.get('translatedText') and not unicodedata.normalize('NFKC', parent['translatedText']).rstrip().endswith(unicodedata.normalize('NFKC', token.strip())):
                    parent['translatedText'] += ' '+token
                parent.setdefault('memberIds', [parent['id']]).append(b['id'])
                continue
        combined.append(b)
    blocks = combined
    figures = [b for b in blocks if b['kind'] in ('figure','formula') and not b.get('figureId') and rect(b)]
    prose = [b for b in blocks if b['kind'] not in ('figure', 'formula') and not b.get('figureId') and not b.get('layoutRole') and not simple_label(b) and not punctuation(b) and rect(b)]
    line = statistics.median([min(rect(b)['height'], 30) for b in prose]) if prose else 20
    # A return to the top in the detector's text reading order identifies a
    # column transition. Short question headings do not define narrow columns.
    gutters=[]
    for previous,current in zip(prose,prose[1:]):
        a=rect(previous);b=rect(current)
        if b['y'] >= a['y']-line*3:continue
        if b['x']-right(a)>line:gutters.append((right(a)+b['x'])/2)
        elif a['x']-right(b)>line:gutters.append((right(b)+a['x'])/2)

    def preceding(visual):
        a = rect(visual)
        def same_column(b):
            other=rect(b)
            return not any((right(a)<g and other['x']>g) or (a['x']>g and right(other)<g) for g in gutters)
        candidates = [b for b in prose if bottom(rect(b)) <= a['y']+line*.25 and same_column(b)]
        return max(candidates, key=lambda b: (bottom(rect(b)), x_overlap(a, rect(b))), default=None)

    owners = {b['id']: preceding(b) for b in figures}
    groups = []
    remaining = list(figures)
    while remaining:
        group = [remaining.pop(0)]
        changed = True
        while changed:
            changed = False
            for candidate in list(remaining):
                owner = owners[group[0]['id']]
                if (owners[candidate['id']] or {}).get('id') != (owner or {}).get('id'): continue
                a = rect(candidate)
                adjacent = any(
                    min(bottom(a), bottom(rect(g))) > max(a['y'], rect(g)['y'])
                    or (x_overlap(a, rect(g)) > .5 and max(a['y']-bottom(rect(g)), rect(g)['y']-bottom(a)) <= line*2)
                    for g in group)
                if not adjacent: continue
                hull = union([a, *[rect(g) for g in group]])
                # Do not crop intervening prose/captions from an unrelated column.
                if any(p is not owner and hull['y'] < rect(p)['y']+rect(p)['height']/2 < bottom(hull) and hull['x'] < rect(p)['x']+rect(p)['width']/2 < right(hull) for p in prose): continue
                group.append(candidate); remaining.remove(candidate); changed = True
        groups.append(group)

    for group in groups:
        root = min(group, key=lambda b: b.get('order', blocks.index(b)))
        boxes = [rect(b) for b in group]; hull = union(boxes)
        members = list(group)
        for b in blocks:
            if b in group or not rect(b): continue
            box = rect(b)
            if simple_label(b) and hull['x']-line*2 <= box['x']+box['width']/2 <= right(hull)+line*2 and hull['y']-line/2 <= box['y']+box['height']/2 <= bottom(hull)+line*1.5:
                members.append(b); boxes.append(box)
        root['_anchorBoxes'] = [{'id': b['id'], 'memberIds': b.get('memberIds', [b['id']]), 'box': dict(rect(b))} for b in members]
        root['_figureCaptions'] = [copy.deepcopy(b) for b in group if b.get('translatedText')]
        root['originalBox'] = union(boxes)
        for b in members:
            if b is not root: b['figureId'] = root['id']
        root['_owner'] = (owners[root['id']] or {}).get('id')

    # Resolve existing formula/figure aliases; preserve individual source anchors.
    for b in blocks:
        if not b.get('figureId'): continue
        parent = by_id.get(b['figureId']); visited = {b['id']}
        while parent and parent.get('figureId') and parent['id'] not in visited:
            visited.add(parent['id']); parent = by_id.get(parent['figureId'])
        if parent and parent['id'] not in visited:
            if '_anchorBoxes' in parent:
                if not any(a['id'] == b['id'] for a in parent['_anchorBoxes']):
                    parent['_anchorBoxes'].append({'id': b['id'], 'memberIds': [b['id']], 'box': dict(rect(b))})
                    parent['originalBox']=union([rect(parent),rect(b)])
            else: parent.setdefault('memberIds', [parent['id']]).append(b['id'])

    roots = [b for b in figures if not b.get('figureId')]
    base = [b for b in blocks if b not in roots and not b.get('figureId') and not b.get('layoutRole')]
    before = {}; after = {}
    for visual in roots:
        owner = visual.get('_owner')
        if owner:
            # Stay after every fragment in the owning paragraph/table.
            parent = by_id[owner]; structure = parent.get('structureId'); table = parent.get('table', {}).get('id')
            siblings = [b for b in base if (structure and b.get('structureId') == structure) or (table and b.get('table', {}).get('id') == table)]
            if siblings: owner = siblings[-1]['id']
            after.setdefault(owner, []).append(visual)
        else:
            candidates = [b for b in prose if rect(b)['y'] >= bottom(rect(visual))-line*.25 and x_overlap(rect(visual), rect(b)) > .2]
            following = min(candidates, key=lambda b: rect(b)['y'], default=None)
            before.setdefault(following['id'] if following else None, []).append(visual)
    result = [b for b in blocks if b.get('layoutRole') == 'header']
    for b in base:
        visuals = before.get(b['id'], [])
        result.extend(sorted(visuals, key=lambda v: (rect(v)['y'], rect(v)['x'])))
        result.append(b)
        visuals = after.get(b['id'], [])
        if visuals: b['_keepWithNext'] = True
        result.extend(sorted(visuals, key=lambda v: (rect(v)['y'], rect(v)['x'])))
    result.extend(before.get(None, []))
    result.extend(b for b in blocks if b.get('layoutRole') == 'footer')
    return result
