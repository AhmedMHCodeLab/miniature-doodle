"""Add PowerPoint-native motion to a pptxgenjs deck: slide transitions (Morph with a
fade fallback, or fade) and click-to-reveal builds. Also repairs one pptxgenjs defect:
a text box made of several runs gets a <a:pPr> before every run, which the schema
forbids (only one, first in the paragraph); the extra copies are removed.

pptxgenjs cannot write transitions or animation timing, so build-deck.js writes
interactions.json next to the deck and this script patches the slide XML in place.

    python3 interactions.py deck.pptx interactions.json

interactions.json:
    {"slides": [{"index": 3, "transition": "morph", "duration": 1200,
                 "builds": [{"effect": "fade", "shapes": ["name-a", "name-b"], "stagger": 80}]}]}

Shapes are matched by the name pptxgenjs writes from `objectName`. Each build is one
click: its first shape starts on the click, the rest start with it, staggered.
"""

import html
import json
import re
import sys
import zipfile

NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
NS_P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
NS_P159 = 'http://schemas.microsoft.com/office/powerpoint/2015/09/main'

# presetID / presetSubtype pairs PowerPoint itself writes for these entrance effects.
EFFECTS = {
    'fade': (10, 0, 'fade'),
    'wipe-up': (22, 4, 'wipe(down)'),      # reveals from the bottom edge upwards
    'wipe-right': (22, 8, 'wipe(left)'),   # reveals from the left edge rightwards
}


def transition_xml(kind, duration):
    if kind == 'morph':
        return (
            f'<mc:AlternateContent xmlns:mc="{NS_MC}">'
            f'<mc:Choice xmlns:p159="{NS_P159}" Requires="p159">'
            f'<p:transition spd="slow" p14:dur="{duration}"><p159:morph option="byObject"/></p:transition>'
            '</mc:Choice><mc:Fallback>'
            '<p:transition spd="slow"><p:fade/></p:transition>'
            '</mc:Fallback></mc:AlternateContent>'
        )
    if kind == 'fade':
        return '<p:transition spd="med"><p:fade/></p:transition>'
    raise ValueError(f'unknown transition {kind}')


def timing_xml(steps, kinds):
    """steps: list of (effect, [(spid, delay_ms)]), one click per step.
    kinds: spid -> 'text' | 'shape' | 'pic', used for the build list."""
    counter = [0]

    def nid():
        counter[0] += 1
        return counter[0]

    root, seq = nid(), nid()
    pars = []
    animated = []
    for effect, shapes in steps:
        preset, subtype, flt = EFFECTS[effect]
        outer, inner = nid(), nid()
        effects = []
        for k, (spid, delay) in enumerate(shapes):
            ce, cset, canim = nid(), nid(), nid()
            node = 'clickEffect' if k == 0 else 'withEffect'
            effects.append(
                f'<p:par><p:cTn id="{ce}" presetID="{preset}" presetClass="entr" presetSubtype="{subtype}" '
                f'fill="hold" grpId="0" nodeType="{node}"><p:stCondLst><p:cond delay="{delay}"/></p:stCondLst>'
                '<p:childTnLst>'
                f'<p:set><p:cBhvr><p:cTn id="{cset}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/>'
                f'</p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl><p:attrNameLst>'
                '<p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr>'
                '<p:to><p:strVal val="visible"/></p:to></p:set>'
                f'<p:animEffect transition="in" filter="{flt}"><p:cBhvr><p:cTn id="{canim}" dur="500"/>'
                f'<p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:animEffect>'
                '</p:childTnLst></p:cTn></p:par>'
            )
            animated.append(spid)
        pars.append(
            f'<p:par><p:cTn id="{outer}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst>'
            f'<p:childTnLst><p:par><p:cTn id="{inner}" fill="hold"><p:stCondLst><p:cond delay="0"/>'
            f'</p:stCondLst><p:childTnLst>{"".join(effects)}</p:childTnLst></p:cTn></p:par>'
            '</p:childTnLst></p:cTn></p:par>'
        )
    return (
        '<p:timing><p:tnLst><p:par>'
        f'<p:cTn id="{root}" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>'
        f'<p:seq concurrent="1" nextAc="seek"><p:cTn id="{seq}" dur="indefinite" nodeType="mainSeq">'
        f'<p:childTnLst>{"".join(pars)}</p:childTnLst></p:cTn>'
        '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>'
        '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>'
        '</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>'
        f'{build_list(animated, kinds)}</p:timing>'
    ), animated


def build_list(spids, kinds):
    # PowerPoint lists every animated shape here; pictures have no build entry.
    items = []
    for spid in dict.fromkeys(spids):
        if kinds[spid] == 'text':
            items.append(f'<p:bldP spid="{spid}" grpId="0"/>')
        elif kinds[spid] == 'shape':
            items.append(f'<p:bldP spid="{spid}" grpId="0" animBg="1"/>')
    return f'<p:bldLst>{"".join(items)}</p:bldLst>' if items else ''


def patch_slide(xml, spec):
    names, kinds = {}, {}
    for m in re.finditer(r'<p:(sp|pic|cxnSp)><p:nv\w+><p:cNvPr id="(\d+)" name="([^"]*)"', xml):
        name, spid = html.unescape(m.group(3)), int(m.group(2))
        if name in names:
            raise ValueError(f'slide {spec["index"]}: shape name {name!r} is not unique')
        names[name] = spid
        if m.group(1) == 'pic':
            kinds[spid] = 'pic'
        else:
            body = xml[m.end():xml.find('</p:nvSpPr>', m.end()) + 1]
            kinds[spid] = 'text' if 'txBox="1"' in body else 'shape'

    tail = ''
    if spec.get('transition'):
        tail += transition_xml(spec['transition'], spec.get('duration', 1200))
    builds = spec.get('builds') or []
    if builds:
        steps = []
        for b in builds:
            missing = [n for n in b['shapes'] if n not in names]
            if missing:
                raise ValueError(f'slide {spec["index"]}: no shape named {missing}')
            stagger = b.get('stagger', 0)
            steps.append((b.get('effect', 'fade'), [(names[n], i * stagger) for i, n in enumerate(b['shapes'])]))
        timing, _ = timing_xml(steps, kinds)
        tail += timing
    if not tail:
        return xml
    if '<p:transition' in xml or '<p:timing' in xml:
        raise ValueError(f'slide {spec["index"]} already has a transition or timing')
    # Declare the namespaces the transition uses on the slide root.
    if 'xmlns:p14=' not in xml:
        xml = xml.replace('<p:sld ', f'<p:sld xmlns:p14="{NS_P14}" ', 1)
    # <p:transition> and <p:timing> follow <p:clrMapOvr> and close the slide.
    return xml.replace('</p:sld>', tail + '</p:sld>', 1)


def dedupe_ppr(xml):
    # Keep a paragraph's first <a:pPr> and move it to the front; drop the others.
    def fix(m):
        para = m.group(0)
        pprs = re.findall(r'<a:pPr\b[^>]*?(?:/>|>.*?</a:pPr>)', para)
        if len(pprs) <= 1 and para.startswith('<a:p><a:pPr'):
            return para
        if not pprs:
            return para
        body = re.sub(r'<a:pPr\b[^>]*?(?:/>|>.*?</a:pPr>)', '', para[len('<a:p>'):])
        return '<a:p>' + pprs[0] + body
    return re.sub(r'<a:p>.*?</a:p>', fix, xml, flags=re.S)


def main(deck, spec_path):
    spec = json.load(open(spec_path))
    by_index = {s['index']: s for s in spec['slides']}
    src = zipfile.ZipFile(deck)
    items = [(i, src.read(i.filename)) for i in src.infolist()]
    src.close()
    out = zipfile.ZipFile(deck, 'w', zipfile.ZIP_DEFLATED)
    for info, data in items:
        m = re.fullmatch(r'ppt/slides/slide(\d+)\.xml', info.filename)
        if m:
            xml = dedupe_ppr(data.decode('utf-8'))
            if int(m.group(1)) in by_index:
                xml = patch_slide(xml, by_index[int(m.group(1))])
            data = xml.encode('utf-8')
        out.writestr(info, data)
    out.close()
    print(f'patched {len(by_index)} slides')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
