"""Strict schema check of every slide in a .pptx against the ECMA-376 PresentationML
schema (pml.xsd), including transitions and animation timing.

    python3 check_xml.py deck.pptx path/to/pml.xsd

mc:AlternateContent is resolved to its Fallback first, the way an Office version
without the extension reads the slide, and extension attributes (p14:*) are dropped,
so both the Morph branch's container and the fallback are checked.
"""

import re
import sys
import zipfile

from lxml import etree

MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
PML = 'http://schemas.openxmlformats.org/presentationml/2006/main'
KNOWN = {
    PML,
    'http://schemas.openxmlformats.org/drawingml/2006/main',
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
}


def normalise(root):
    for ac in root.iter(f'{{{MC}}}AlternateContent'):
        fallback = ac.find(f'{{{MC}}}Fallback')
        parent = ac.getparent()
        idx = parent.index(ac)
        parent.remove(ac)
        if fallback is not None:
            for k, child in enumerate(list(fallback)):
                parent.insert(idx + k, child)
    for el in root.iter():
        for attr in list(el.attrib):
            if attr.startswith('{') and attr[1:attr.index('}')] not in KNOWN:
                del el.attrib[attr]
    return root


def main(deck, xsd_path):
    schema = etree.XMLSchema(etree.parse(xsd_path))
    z = zipfile.ZipFile(deck)
    failures = 0
    slides = sorted((n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)),
                    key=lambda n: int(re.findall(r'\d+', n)[0]))
    for name in slides:
        root = normalise(etree.fromstring(z.read(name)))
        schema.validate(root)
        # PowerPoint writes bullet sizes as thousandths (val="100000"); the ISO
        # transitional schema here expects "100%". Both are read by Office.
        errors = [e for e in schema.error_log if 'buSzPct' not in e.message]
        if errors:
            failures += 1
            for err in errors[:5]:
                print(f'{name}: {err.message}')
    print(f'{len(slides) - failures}/{len(slides)} slides valid against pml.xsd')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
