# TASK SPECIFICATION: Headless Blender (Cycles) E-Commerce PDP Shot Engine

## 1. Objective
Replace the 2D planar homography composite (`lib/productImages/roomScene.js` / `roomwarp.py`) with an automated **Headless Blender Cycles 3D engine**.

The engine must take a single flat tile/swatch photo and real-world SKU specifications (e.g., `1200 x 600 mm`, `Carving Matte`), procedurally generate a photorealistic room with physical grout, chamfered bevels, and micro-surface relief, and render a high-resolution **PDP 3-Shot Media Pack** (Hero Wide, Grazing Sheen, Macro Detail) for an e-commerce Product Detail Page media gallery.

*(Note: Direct Shopify API upload is out of scope for now. The pipeline should save images to disk and return them as base64/files).*

---

## 2. Technical Stack & Repository Integration
* **Backend:** Node.js (Fastify) in `material-admin`.
* **3D Engine:** Blender 4.x+ headless CLI (`blender -b -P`) with Cycles Path-Tracing.
* **Existing Helpers to Leverage:**
  * `lib/productImages/rectify.js`: Rectifies perspective distortion on smartphone-shot swatches.
  * `lib/productImages/imageComposer.js`: `parseSizeLabel()` for extracting millimeter dimensions (`widthMm`, `heightMm`, unit).
* **New Files to Implement:**
  1. `lib/productImages/blenderRoom.js`: Node.js wrapper to locate Blender binary, queue jobs, pass payloads, and return rendered images.
  2. `lib/productImages/render_room.py`: Standalone Python script executed inside Blender's embedded Python runtime (`bpy`).
  3. `lib/productImages/templates/`: Master `.blend` scene directory.
* **Endpoint:**
  * `routes/products.js`: Expose `POST /api/products/images/room-blender`.

---

## 3. Core Requirements

### A. Pre-Processing & Swatch Rectification
Merchants frequently upload swatches taken at an angle:
* Integrate with `lib/productImages/rectify.js`: If an unrectified photo is provided, run 4-corner perspective rectification first so the texture entering Blender is planar and square.

### B. Procedural Floor Geometry & Laying Patterns
Real floors are rarely laid in a basic square grid. Rectangular slabs and planks look artificial without stagger:
In `render_room.py`, build a procedural shader / UV mapping node group supporting:
1. **Laying Patterns (`pattern`)**:
   * `straight`: Standard grid (ideal for square slabs: $800 \times 800$, $1200 \times 1200$).
   * `stagger_third`: $1/3$ running bond offset (standard for large-format rectangular slabs).
   * `stagger_half`: $1/2$ subway / brick-bond offset.
   * `herringbone`: $90^\circ$ interlocking weave (for wood/narrow planks).
2. **Real Metric Grout Channels**:
   * Calculate exact tile spacing using real millimeters: `groutMm` (default $3\text{ mm}$).
   * The grout channel must be recessed in the height/bump map, shaded with a matte, non-specular grout material (roughness $0.95$, customizable color `#3A3A3A` or median swatch tone).
3. **Chamfer & Micro-Bevel**:
   * Add a $1.5\text{ mm}$ curved bevel ramp at each tile edge feeding the Normal/Bump input. Under grazing light, the glaze must curve softly into the grout rather than cutting off as a hard computer edge.

### C. Swatch PBR Synthesis (From a Single Flat Photo)
Merchants only upload **one RGB image**. The Blender shader must synthesize the remaining PBR channels procedurally:
* **Micro-Surface Relief (Bump)**: High-pass / luminance filter of the swatch feeding a low-strength Bump node (strength $0.08 - 0.15$) so stone veining, wood grain, or ceramic pores catch directional highlights.
* **Finish & Roughness Calibration**: Map product finish directly:
  ```python
  FINISH_PRESETS = {
      "matte": {"roughness": 0.62, "clearcoat": 0.0, "clearcoat_roughness": 0.0},
      "carving matte": {"roughness": 0.58, "bump_boost": 1.4, "clearcoat": 0.0},
      "satin": {"roughness": 0.40, "clearcoat": 0.1, "clearcoat_roughness": 0.2},
      "glossy": {"roughness": 0.20, "clearcoat": 0.8, "clearcoat_roughness": 0.08},
      "high gloss": {"roughness": 0.08, "clearcoat": 1.0, "clearcoat_roughness": 0.03},
      "polished": {"roughness": 0.08, "clearcoat": 1.0, "clearcoat_roughness": 0.02}
  }
  ```

### D. The 3-Camera PDP Rig
The script must cycle through 3 pre-calibrated cameras and output 3 distinct, catalog-ready frames:
1. **`hero_wide` (Context)**: Eye-level architectural perspective showing the full room (kitchen/living) to show real-world scale against cabinets, tables, and walls.
2. **`sheen_grazing` (Finish Proof)**: Low-angle $40^\circ$ camera pointed towards the primary light source to display surface reflectivity, glaze quality, and ambient bounce.
3. **`macro_detail` (Zoom Proof)**: An $80^\circ$ macro close-up framing 4 intersecting tiles, highlighting grout joint depth, chamfers, and high-res texture clarity for a 4× zoom viewer.

### E. Hardware Acceleration & Concurrency
* **Cycles Acceleration**:
  * macOS: Enable `CYCLES_METAL` with Apple Silicon GPU.
  * Linux/Windows: Enable `CUDA` or `OPTIX`.
  * Fallback to CPU if no GPU device is active.
* **Concurrency Control**: Blender rendering is compute-intensive. Wrap executions in a semaphore/queue (max 1–2 concurrent renders) to prevent system overload.

---

## 4. Input & Output Contract

### Fastify Route: `POST /api/products/images/room-blender`
**Request Payload:**
```json
{
  "swatch": "data:image/jpeg;base64,...",
  "sizeLabel": "1200 x 600 mm",
  "finish": "polished",
  "pattern": "stagger_third",
  "groutMm": 3,
  "groutColor": "#404040",
  "roomTemplate": "modern_kitchen"
}
```

**Response Payload:**
```json
{
  "ok": true,
  "shots": {
    "hero_wide": "data:image/jpeg;base64,...",
    "sheen_grazing": "data:image/jpeg;base64,...",
    "macro_detail": "data:image/jpeg;base64,..."
  },
  "ms": 4250,
  "device": "Apple M-Series (Metal)"
}
```

---

## 5. Bootstrap Mode (Self-Generating Template)
If `lib/productImages/templates/` is empty on first run, `render_room.py` must include a `--bootstrap` flag that procedurally builds and saves `modern_kitchen.blend`:
* Floor plane with subdivision and `Floor_Target` material.
* Clean minimalist walls and baseboards.
* A floating kitchen island mesh casting realistic contact shadows.
* Realistic lighting: Large rectangular area emitter (simulating a patio window) + warm ceiling downlights ($3000\text{K}$) + low-intensity HDRI ambient fill.
* The 3-camera rig locked and aligned to the focal points.
