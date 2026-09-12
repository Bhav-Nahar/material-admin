"""Put the benchmark's own tile back into the benchmark's own kitchen, and compare."""
import base64, json, subprocess, sys, cv2, numpy as np, os

ROOT = "/Users/nahar/MyProject/Project Material/Website/material-admin"
SP = os.path.dirname(os.path.abspath(__file__))
PY = f"{ROOT}/.venv-cv/bin/python"

# 1. flat swatch out of the studio shot (3.webp) - the tile face, rectified
tile = cv2.imread(f"{ROOT}/3.webp")
src = np.float32([[103, 44], [497, 93], [497, 497], [103, 533]])
dst = np.float32([[0, 0], [800, 0], [800, 800], [0, 800]])
swatch = cv2.warpPerspective(tile, cv2.getPerspectiveTransform(src, dst), (800, 800))
cv2.imwrite(f"{SP}/swatch.png", swatch)

b64 = lambda im: base64.b64encode(cv2.imencode(".png", im)[1]).decode()
req = {
    "room": base64.b64encode(open(f"{ROOT}/7.webp", "rb").read()).decode(),
    "swatch": b64(swatch),
    "quad": [[0, 347], [505, 327], [600, 600], [0, 600]],
    "mask": [[0, 347], [512, 328], [600, 478], [600, 600], [0, 600]],
    "across": 4, "down": 7, "grout": 2,
    "shade": 0.85, "grit": 0.25, "ao": 0.22,
    "gloss": float(sys.argv[1]) if len(sys.argv) > 1 else 0.30,
    "seed": 7,
}
p = subprocess.run([PY, f"{ROOT}/lib/productImages/roomwarp.py"],
                   input=json.dumps(req), capture_output=True, text=True)
if p.returncode:
    sys.exit(p.stderr[-2000:])
r = json.loads(p.stdout)
assert r["ok"], r.get("reason")
scene = cv2.imdecode(np.frombuffer(base64.b64decode(r["scene"]), np.uint8), 1)
tag = sys.argv[1] if len(sys.argv) > 1 else "0.30"
cv2.imwrite(f"{SP}/scene-gloss{tag}.png", scene)

room = cv2.imread(f"{ROOT}/7.webp")
cv2.imwrite(f"{SP}/side-by-side-{tag}.png", np.hstack([room, scene]))
print(r["output"], "gloss", tag)
