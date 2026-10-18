"""
pdfImages.py — pull the products out of a catalogue PDF, page by page.

Usage: pdfImages.py <in.pdf> <out_dir> [name]   → writes files + all.zip, prints a JSON manifest.
       `name` (the PDF's name) is the zip's top folder: <name>/page-05/page-05_swatch-01.png

Two kinds of product live in a catalogue PDF:

  photo   — an embedded image. Layout does not matter: a PDF stores each picture once
            as an object, so reading objects works for every design. JPEG/PNG are
            written byte-for-byte; transparent cutouts (colour + a separate alpha mask,
            "SMask") are merged into a PNG; CMYK is converted so browsers show it right.
  swatch  — a flat colour drawn as a vector shape (rectangle, arch, …). There is no image
            to extract; the product IS the colour, which the PDF stores exactly, so the
            swatch is written as a solid PNG of that colour at the shape's 300 dpi size.
            Not a page crop: an arch's crop would carry the background in its corners.

Nothing tells a product from decoration, so rules guess, and every item carries `decor`
(a reason, or null) instead of being dropped — the UI hides decor, never loses it:

  - an image placed on REPEAT_PAGES+ pages is a background, not a product
  - a shape is a swatch only if the same size repeats on the page (products come in
    rows, decoration is one-off), it is big, it is not a page background, it is a
    simple outline (not outlined text), and no photo sits on or in it (then it is a
    frame or a card and the photo is the product)

ponytail: rules, not understanding — a lifestyle photo and a product photo look the same
to them. The upgrade is a vision model voting on these same candidates; pixels would
still come from here. Vector art (logos as paths) is not extracted at all.
"""

import hashlib
import json
import os
import sys
import zipfile
from collections import defaultdict

import pymupdf

MIN_SIDE = 64         # px; drops gradient strips / hairlines
REPEAT_PAGES = 3      # an image on this many pages is a background
PREVIEW_W = 1000      # px; page render shown beside its items, to see what was missed
SWATCH_MIN = 0.12     # swatch's short side, as a share of the page's short side
SWATCH_MAX_AREA = 0.6  # bigger than this share of the page is a background panel
SWATCH_DPI = 300
SIZE_TOL = 2          # pt; "same size" for repeated swatches
MAX_SEGMENTS = 20     # arch = 11, rounded rect = 8, outlined text label = 24+


def overlap(a, b):
    """Share of rect a covered by rect b."""
    i = pymupdf.Rect(a) & b
    return 0 if i.is_empty else i.get_area() / a.get_area()


def photos(doc, page, skip, digest_of, pages_of):
    """pages_of counts pages per image CONTENT: catalogues often embed the same
    background as a fresh object on every page, so counting objects misses it."""
    for img in page.get_images(full=True):
        xref, smask, w, h = img[0], img[1], img[2], img[3]
        if xref in skip:
            continue
        if xref in digest_of:
            pages_of[digest_of[xref]].add(page.number)
            continue
        if min(w, h) < MIN_SIDE:
            skip.add(xref)
            continue

        raw = doc.extract_image(xref)
        if not smask and raw["ext"] in ("jpeg", "jpg", "png") and raw["colorspace"] in (1, 3):
            data, ext = raw["image"], "jpg" if raw["ext"] == "jpeg" else raw["ext"]
        else:
            pix = pymupdf.Pixmap(doc, xref)
            if pix.colorspace and pix.colorspace.n not in (1, 3):
                pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            if smask:
                pix = pymupdf.Pixmap(pix, pymupdf.Pixmap(doc, smask))
            data, ext = pix.tobytes("png"), "png"

        digest = digest_of[xref] = hashlib.sha1(data).hexdigest()
        new = digest not in pages_of
        pages_of[digest].add(page.number)
        if not new:
            continue

        rects = page.get_image_rects(xref)
        yield {"kind": "photo", "data": data, "ext": ext, "width": w, "height": h,
               "transparent": bool(smask), "rect": rects[0] if rects else page.rect,
               "digest": digest, "decor": None}


def swatches(page, photo_rects):
    pr = page.rect
    fills, seen = [], set()
    for d in page.get_drawings():
        r = d["rect"] & pr
        key = tuple(round(v) for v in r)
        if not d.get("fill") or r.is_empty or key in seen:  # fill+stroke often drawn twice
            continue
        # A swatch is a simple outline: rectangle 1, rounded rect 8, arch 11 segments.
        # Outlined text and artwork are 24 to hundreds, even when their box looks swatch-sized.
        if len(d["items"]) > MAX_SEGMENTS:
            continue
        seen.add(key)
        if min(r.width, r.height) < SWATCH_MIN * min(pr.width, pr.height):
            continue
        if r.get_area() > SWATCH_MAX_AREA * pr.get_area():
            continue
        # A photo on it (frame behind a photo) or inside it (card with an icon): not a swatch.
        if any(overlap(r, p) > 0.5 or overlap(p, r) > 0.5 for p in photo_rects):
            continue
        fills.append((r, d["fill"]))

    same = lambda a, b: abs(a.width - b.width) <= SIZE_TOL and abs(a.height - b.height) <= SIZE_TOL
    for r, fill in fills:
        if sum(same(r, o) for o, _ in fills) < 2:
            continue
        # ponytail: solid fill colour only — a texture or sheen drawn ON TOP of the shape
        # is not in it. Render the clip instead if a catalogue ever does that.
        rgb = tuple(round(c * 255) for c in (fill * 3 if len(fill) == 1 else fill[:3]))
        w, h = round(r.width * SWATCH_DPI / 72), round(r.height * SWATCH_DPI / 72)
        # Raw samples in one go: Pixmap.set_rect fills per pixel in Python (1.5 s a swatch).
        pix = pymupdf.Pixmap(pymupdf.csRGB, w, h, bytes(rgb) * (w * h), False)
        yield {"kind": "swatch", "data": pix.tobytes("png"), "ext": "png",
               "width": w, "height": h, "transparent": False, "rect": r,
               "colour": "#%02X%02X%02X" % rgb, "decor": None}


def extract(pdf_path, out_dir, folder="pdf-images"):
    doc = pymupdf.open(pdf_path)
    # Alpha masks are images too and get listed alongside the picture they belong to.
    masks = {img[1] for page in doc for img in page.get_images(full=True) if img[1]}
    digest_of, pages_of, items, pages = {}, defaultdict(set), [], []
    file_of = {}  # digest → file, so a repeat on a later page still gets its box

    for page in doc:
        found = list(photos(doc, page, masks, digest_of, pages_of))
        placed = [pymupdf.Rect(r) for img in page.get_images(full=True) for r in page.get_image_rects(img[0])]
        found += swatches(page, placed)
        # Reading order: top-to-bottom, then left-to-right, in 20pt bands.
        found.sort(key=lambda it: (round(it["rect"].y0 / 20), it["rect"].x0))

        for n, it in enumerate(found, 1):
            name = f"page-{page.number + 1:02d}_{it['kind']}-{n:02d}.{it['ext']}"
            with open(os.path.join(out_dir, name), "wb") as f:
                f.write(it["data"])
            meta = {k: v for k, v in it.items() if k not in ("data", "ext", "rect", "file")}
            items.append({"file": name, "page": page.number + 1, "bytes": len(it["data"]), **meta})
            it["file"] = name
            file_of[it.get("digest", name)] = name

        # Where each extracted thing sits on the page, as 0-1 fractions, so the UI can
        # outline it on the page preview. Anything on the preview without a box was missed.
        pr, boxes = page.rect, []
        spots = [(it["file"], it["rect"]) for it in found if it["kind"] == "swatch"]
        for img in page.get_images(full=True):
            f = file_of.get(digest_of.get(img[0]))
            spots += [(f, r) for r in page.get_image_rects(img[0])] if f else []
        for f, r in spots:
            r = pymupdf.Rect(r) & pr
            if not r.is_empty:
                boxes.append({"file": f, "x": r.x0 / pr.width, "y": r.y0 / pr.height,
                              "w": r.width / pr.width, "h": r.height / pr.height})
        preview = f"page-{page.number + 1:02d}.jpg"
        pix = page.get_pixmap(matrix=pymupdf.Matrix(PREVIEW_W / pr.width, PREVIEW_W / pr.width))
        with open(os.path.join(out_dir, preview), "wb") as fh:
            fh.write(pix.tobytes("jpeg", jpg_quality=80))
        pages.append({"page": page.number + 1, "preview": preview, "boxes": boxes})

    for it in items:
        n = len(pages_of[it.pop("digest")]) if "digest" in it else 0
        if n >= REPEAT_PAGES:
            it["decor"] = f"background on {n} pages"

    # Products only: <name>/page-NN/…  Stored, not deflated: already compressed.
    with zipfile.ZipFile(os.path.join(out_dir, "all.zip"), "w", zipfile.ZIP_STORED) as z:
        for it in items:
            if not it["decor"]:
                z.write(os.path.join(out_dir, it["file"]), f"{folder}/page-{it['page']:02d}/{it['file']}")

    return {"pageCount": doc.page_count, "pages": pages, "images": items}


if __name__ == "__main__":
    print(json.dumps(extract(*sys.argv[1:4])))
