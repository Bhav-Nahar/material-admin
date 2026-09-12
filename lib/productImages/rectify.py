"""
rectify.py — turn a photo of a tile taken at an angle into a flat, square-on swatch.

WHY THIS EXISTS

Every template in imageComposer.js assumes a flat, square-on swatch. Hand it an
angled photo and it silently produces nonsense: the very first real test of this
system pasted a studio render's beige backdrop into the slab and called it a tile.
The conclusion then was "templates need a flat swatch", and nothing enforced it —
so an operator with a phone photo gets garbage and no warning.

sharp cannot fix this. It has affine transforms only, which map rectangles to
parallelograms; undoing a camera's perspective needs a homography, a genuine
four-point mapping. That is one cv2 call, and it is the whole reason for reaching
outside Node here.

CONTRACT
  stdin   raw image bytes
  argv    --aspect W:H   target aspect (from the product's size label), optional
          --max PX       longest edge of the output, default 2000
  stdout  one JSON object:
            { ok, reason, confidence, quad, source, output, rectified, overlay }
          `rectified` and `overlay` are base64 PNG. On ok=false there is no
          `rectified` — a refusal, not a guess.

ON REFUSING

A photo that is ALREADY a flat swatch has no tile outline to find, and that is the
common good case. So "no quad found" is reported as ok=false with a reason, never as
a mangled crop. Returning the photo unchanged would be worse: the caller could not
tell whether anything happened.
"""

import base64
import json
import sys

import cv2
import numpy as np

# A quad smaller than this share of the frame is probably not the product.
MIN_AREA_SHARE = 0.12
# ...and one larger than this is the frame itself, i.e. an already-flat swatch.
MAX_AREA_SHARE = 0.98
# How far from a parallelogram the quad may be before we distrust it.
MIN_CONFIDENCE = 0.35


def order_corners(pts):
    """tl, tr, br, bl — by angle about the centroid, so it holds for any rotation."""
    c = pts.mean(axis=0)
    ang = np.arctan2(pts[:, 1] - c[1], pts[:, 0] - c[0])
    pts = pts[np.argsort(ang)]
    # start at the corner closest to the top-left of the bounding box
    start = int(np.argmin(pts.sum(axis=1)))
    return np.roll(pts, -start, axis=0)


def corners_from_hull(hull):
    """
    Four corners of a convex hull, by pushing outwards along the diagonals.

    approxPolyDP was the obvious tool and it is the wrong one here: a heavily veined
    marble gives Canny thousands of internal edges, the outer boundary comes back
    fragmented, and the approximation almost never lands on exactly four points.
    Extreme points along the diagonals need no such luck — they work off a rough mask.
    """
    pts = hull.reshape(-1, 2).astype(np.float32)
    picks = []
    for dx, dy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):  # tl, tr, br, bl
        picks.append(pts[int(np.argmax(pts[:, 0] * dx + pts[:, 1] * dy))])
    quad = np.array(picks, dtype=np.float32)
    # Degenerate if any two corners coincide — a sliver, not a tile.
    for i in range(4):
        for j in range(i + 1, 4):
            if np.linalg.norm(quad[i] - quad[j]) < 8:
                return None
    return quad


def largest_blob(mask, area):
    """The biggest plausible connected region in a binary mask."""
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8), iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8), iterations=1)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    for c in contours:
        a = cv2.contourArea(c)
        if a < area * MIN_AREA_SHARE or a > area * MAX_AREA_SHARE:
            continue
        if best is None or a > best[0]:
            best = (a, c)
    return best


def find_quad(img):
    """
    The product's four corners.

    PRIMARY: separate the tile from its background by colour. A supplier photo is a
    product on a plain-ish surface, so the frame's border is background almost by
    definition — sample it, and everything far from that colour is the product. This
    survives texture, which is exactly what defeated the edge-detection approach.

    FALLBACK: Canny edges, for a tile whose colour is close to its background but
    whose outline is crisp.
    """
    h, w = img.shape[:2]
    area = h * w
    blur = cv2.bilateralFilter(img, 9, 60, 60)

    # Background colour, from a band around the frame.
    band = max(4, min(h, w) // 40)
    border = np.concatenate([
        blur[:band].reshape(-1, 3), blur[-band:].reshape(-1, 3),
        blur[:, :band].reshape(-1, 3), blur[:, -band:].reshape(-1, 3),
    ])
    bg = np.median(border, axis=0)

    dist = np.linalg.norm(blur.astype(np.float32) - bg, axis=2)
    # Otsu on the distance map, so the cut adapts instead of needing a magic number.
    norm = cv2.normalize(dist, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    _, mask = cv2.threshold(norm, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    found = largest_blob(mask, area)

    if not found:
        grey = cv2.cvtColor(blur, cv2.COLOR_BGR2GRAY)
        for lo, hi in ((30, 90), (50, 150), (75, 200)):
            edges = cv2.dilate(cv2.Canny(grey, lo, hi), np.ones((3, 3), np.uint8), 1)
            found = largest_blob(edges, area)
            if found:
                break

    if not found:
        return None

    a, contour = found
    quad = corners_from_hull(cv2.convexHull(contour))
    return None if quad is None else (a, quad)


def confidence(quad, shape):
    """
    How much this looks like a rectangle seen through a camera.

    Opposite sides of a rectangle stay roughly equal under perspective, so the ratio
    between each opposing pair is the signal. It is a sanity check, not a proof — a
    genuinely trapezoidal object would score well too, which is why the overlay is
    returned for a human to glance at.
    """
    p = order_corners(quad)
    side = [np.linalg.norm(p[i] - p[(i + 1) % 4]) for i in range(4)]
    pair = lambda a, b: min(side[a], side[b]) / max(side[a], side[b], 1e-6)
    balance = (pair(0, 2) + pair(1, 3)) / 2
    share = cv2.contourArea(p.astype(np.float32)) / (shape[0] * shape[1])
    # Bigger in frame is more trustworthy, up to a point.
    return round(float(balance * min(1.0, share / 0.5)), 3)


def target_size(quad, aspect, max_px):
    """Output dimensions: the product's real aspect if we know it, else the quad's."""
    p = order_corners(quad)
    wq = (np.linalg.norm(p[0] - p[1]) + np.linalg.norm(p[3] - p[2])) / 2
    hq = (np.linalg.norm(p[0] - p[3]) + np.linalg.norm(p[1] - p[2])) / 2

    if aspect:
        aw, ah = aspect
        ratio = ah / aw
    else:
        ratio = hq / max(wq, 1e-6)

    # Never upscale past what the quad actually contains — inventing pixels here would
    # just be a bigger blur, the same trap outputSize guards against in the templates.
    w = int(min(max_px, max(wq, hq / max(ratio, 1e-6))))
    h = int(max(1, round(w * ratio)))
    if h > max_px:
        h = max_px
        w = int(round(h / max(ratio, 1e-6)))
    return max(1, w), max(1, h)


def main():
    args = sys.argv[1:]
    aspect = None
    max_px = 2000
    for i, a in enumerate(args):
        if a == '--aspect' and i + 1 < len(args) and ':' in args[i + 1]:
            try:
                aw, ah = (float(x) for x in args[i + 1].split(':'))
                if aw > 0 and ah > 0:
                    aspect = (aw, ah)
            except ValueError:
                pass
        if a == '--max' and i + 1 < len(args):
            try:
                max_px = max(200, min(4000, int(args[i + 1])))
            except ValueError:
                pass

    raw = sys.stdin.buffer.read()
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        print(json.dumps({'ok': False, 'reason': 'could not decode the image'}))
        return

    h, w = img.shape[:2]
    out = {'ok': False, 'source': f'{w}x{h}'}

    found = find_quad(img)
    if not found:
        out['reason'] = (
            'no tile outline found. If the photo is already a flat, square-on swatch '
            'that fills the frame, that is expected and nothing needs rectifying.'
        )
        print(json.dumps(out))
        return

    _, quad = found
    conf = confidence(quad, img.shape)
    p = order_corners(quad)
    out['quad'] = [[round(float(x)), round(float(y))] for x, y in p]
    out['confidence'] = conf

    # The overlay goes back whatever the verdict, so a refusal can still be inspected.
    overlay = img.copy()
    cv2.polylines(overlay, [p.astype(np.int32)], True, (0, 220, 255), max(2, w // 300))
    for x, y in p:
        cv2.circle(overlay, (int(x), int(y)), max(4, w // 150), (0, 90, 255), -1)
    out['overlay'] = base64.b64encode(cv2.imencode('.png', overlay)[1]).decode()

    if conf < MIN_CONFIDENCE:
        out['reason'] = (
            f'found an outline but do not trust it (confidence {conf}). Either the '
            'corners are not the tile — check the overlay — or the photo is already a '
            'flat swatch filling the frame, which lands here too and needs nothing done.'
        )
        print(json.dumps(out))
        return

    tw, th = target_size(quad, aspect, max_px)
    dst = np.array([[0, 0], [tw - 1, 0], [tw - 1, th - 1], [0, th - 1]], dtype=np.float32)
    m = cv2.getPerspectiveTransform(p.astype(np.float32), dst)
    # INTER_CUBIC over LINEAR: the same reason the studio warp uses Catmull-Rom — a
    # linear filter has no negative lobes and cannot hold an edge.
    warped = cv2.warpPerspective(img, m, (tw, th), flags=cv2.INTER_CUBIC)

    out['ok'] = True
    out['output'] = f'{tw}x{th}'
    out['rectified'] = base64.b64encode(cv2.imencode('.png', warped)[1]).decode()
    print(json.dumps(out))


if __name__ == '__main__':
    main()
