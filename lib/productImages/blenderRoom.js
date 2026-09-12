'use strict';

/**
 * blenderRoom.js — Node's side of the Cycles PDP renderer.
 *
 * This was once the expensive half of a pair: roomScene.js projected a tile onto a
 * PHOTOGRAPH of a room in 50 ms with no GPU, and this path traced it properly in
 * minutes. The composite was removed — its output was not good enough — so this is
 * now the only room shot there is, and a box without Blender produces none.
 *
 * WHAT THIS FILE IS FOR, given that render_room.py does the work:
 *
 *   1. finding Blender, and finding out whether its GPU actually renders
 *   2. keeping renders from eating the box, because two Cycles jobs on 16 GB of
 *      shared memory is one Cycles job and a swap storm
 *   3. jobs, not requests — see the note on the queue below
 *   4. preparing the swatch, which is the one piece of image work that belongs in
 *      Node because sharp is already here
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');

const { parseSizeLabel } = require('./imageComposer');

const SCRIPT = path.join(__dirname, 'render_room.py');
const TEMPLATES = path.join(__dirname, 'templates');
const DEFAULT_TEMPLATE = 'greybox_kitchen';

// Where Blender usually lives. BLENDER_PATH wins over all of them.
const BLENDER_CANDIDATES = [
  process.env.BLENDER_PATH,
  '/Applications/Blender.app/Contents/MacOS/Blender',
  '/opt/homebrew/bin/blender',
  '/usr/local/bin/blender',
  '/usr/bin/blender',
  '/snap/bin/blender',
].filter(Boolean);

function resolveBlender() {
  const found = BLENDER_CANDIDATES.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
  if (found) return found;
  const err = new Error(
    'no Blender found. Install it (macOS: brew install --cask blender) or set ' +
      `BLENDER_PATH (looked in: ${BLENDER_CANDIDATES.join(', ')}). The 2D templates ` +
      'and the room composite need none of this.',
  );
  err.code = 'no_blender';
  throw err;
}

/* ── the swatch ────────────────────────────────────────────────────────────────
   Two jobs, both learned from roomwarp.py rather than guessed.

   THE INSET IS NOT COSMETIC. A rectified swatch is only as tight as the quad
   someone clicked, and a two-pixel sliver of studio backdrop along one edge lands
   in the grout of every joint on the floor — measured on the benchmark tile as a
   tan line running the length of the macro shot, before this was here. Cheaper to
   lose 1.5% of a texture that repeats than to demand pixel-perfect marking.

   The resize is a memory decision. Cycles holds every texture uncompressed: a 5906px
   swatch is 100 MB of VRAM on a box with 16 GB shared between CPU and GPU, and the
   macro camera cannot resolve past about 2K across a single tile anyway. */
const SWATCH_PX = 2048;
const SWATCH_INSET = 1 / 66;
const GROUT_TONE = 0.88;

async function prepareSwatch(b64, dir) {
  const raw = Buffer.from(String(b64).replace(/^data:[^,]+,/, ''), 'base64');
  const img = sharp(raw, { limitInputPixels: 512e6 });
  const { width, height } = await img.metadata();
  if (!width || !height) {
    const err = new Error('the swatch is not an image this can read');
    err.code = 'bad_swatch';
    throw err;
  }

  const cut = Math.max(1, Math.round(Math.min(width, height) * SWATCH_INSET));
  const out = path.join(dir, 'swatch.png');
  const prepared = img
    .extract({ left: cut, top: cut, width: width - cut * 2, height: height - cut * 2 })
    .resize(SWATCH_PX, SWATCH_PX, { fit: 'fill' });
  await prepared.clone().png({ compressionLevel: 6 }).toFile(out);

  // Grout read off the tile, after the inset — so the studio backdrop cannot drag it.
  // A shade darker than the tile's own average is a grout line on every tile in the
  // catalogue; a fixed grey draws a black grid on pale marble and disappears on
  // charcoal. Same conclusion roomwarp.py reached, same factor.
  const { channels } = await prepared.clone().stats();
  const hex = channels.slice(0, 3)
    .map((c) => Math.round(Math.min(255, Math.max(0, c.mean * GROUT_TONE)))
      .toString(16).padStart(2, '0'))
    .join('');
  return { path: out, source: `${width}x${height}`, grout: `#${hex}` };
}

/* ── the GPU probe ────────────────────────────────────────────────────────────
   Cycles' GPU backends do not fail, they HANG. Measured on this machine: Metal
   reports `Apple M4 (GPU - 10 cores)` from `get_devices()`, accepts the device, and
   then sits at 0.3% CPU inside `bpy.ops.render.render` forever, because a process
   with no window-server session cannot get a Metal queue. The same frame renders on
   the CPU in 4.9 seconds.

   That is a nasty failure to meet in production: the job's own timeout would have to
   be minutes long to accommodate a legitimate hero render, so a hung GPU would stall
   for minutes and then report a timeout that looks like a slow scene.

   So: probe once per process with a frame small enough that anything but a hang
   finishes, and cache the verdict. 90 seconds because a first Metal or OptiX run
   legitimately spends up to a minute compiling kernels, and paying that once is the
   entire point of caching the answer. */
const PROBE_TIMEOUT_MS = 90000;
const PROBE_SCRIPT = `
import bpy, sys
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
for backend in ('METAL', 'OPTIX', 'CUDA', 'HIP', 'ONEAPI'):
    try:
        prefs.compute_device_type = backend
    except TypeError:
        continue
    prefs.get_devices()
    if not [d for d in prefs.devices if d.type == backend]:
        continue
    for d in prefs.devices:
        d.use = d.type in (backend, 'CPU')
    scene.cycles.device = 'GPU'
    scene.cycles.samples = 1
    scene.render.resolution_x = scene.render.resolution_y = 32
    scene.render.filepath = sys.argv[-1]
    bpy.ops.render.render(write_still=True)
    print('PROBE_OK ' + backend)
    break
else:
    print('PROBE_NONE')
`;

let gpuVerdict = null;

async function probeGpu(blender) {
  if (gpuVerdict) return gpuVerdict;
  if (process.env.BLENDER_DEVICE) {
    gpuVerdict = { usable: process.env.BLENDER_DEVICE.toLowerCase() !== 'cpu', why: 'BLENDER_DEVICE' };
    return gpuVerdict;
  }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'md-gpuprobe-'));
  const script = path.join(dir, 'probe.py');
  await fsp.writeFile(script, PROBE_SCRIPT);

  const result = await new Promise((resolve) => {
    const proc = spawn(blender, ['-b', '-noaudio', '-P', script, '--', path.join(dir, 'p.png')],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ usable: false, why: 'the GPU accepted the job and then hung — no render in 90s' });
    }, PROBE_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', () => {});
    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ usable: false, why: 'could not start Blender for the probe' });
    });
    proc.on('close', () => {
      clearTimeout(timer);
      const m = out.match(/PROBE_OK (\w+)/);
      if (m) return resolve({ usable: true, why: `${m[1]} rendered a test frame` });
      resolve({ usable: false, why: out.includes('PROBE_NONE') ? 'no GPU device reported' : 'the probe render failed' });
    });
  });

  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  gpuVerdict = result;
  return result;
}

/* ── the queue ────────────────────────────────────────────────────────────────
   Renders are minutes, not milliseconds, and that is not a tuning problem — it is
   what path tracing an interior costs. Two consequences, both structural:

   ONE AT A TIME. Cycles sizes its working set to the machine; two of them on 16 GB
   of shared CPU/GPU memory do not run twice as slowly, they swap. Raise
   BLENDER_CONCURRENCY on a box with headroom and its own GPU.

   JOBS, NOT REQUESTS. A three-shot pack is well past any proxy's idle timeout, so
   the route hands back an id immediately and the caller polls. Held in memory: this
   is a single-process admin tool, and a restart losing a queue of renders costs a
   re-click. The moment there are two processes it wants a real queue, and that is
   when to add one, not now. */
const CONCURRENCY = Math.max(1, Number(process.env.BLENDER_CONCURRENCY) || 1);
const JOB_TTL_MS = 6 * 60 * 60 * 1000;

const jobs = new Map();
const waiting = [];
let running = 0;

/* Live Blender children, so they can be killed when this process goes.
   ORPHANED RENDERS ARE A REAL FAILURE, not tidiness. `npm run dev` is
   `node --watch`, so any edit to a lib file restarts the server — and a restart used
   to wipe the in-memory job registry while leaving Cycles running. Measured: an
   abandoned render at 681% CPU for eight minutes, invisible to the API that started
   it, competing with every job queued after it. A renderer that outlives its own
   bookkeeping is worse than one that fails. */
const children = new Set();

function killChildren(signal = 'SIGTERM') {
  for (const proc of children) {
    try { proc.kill(signal); } catch { /* already gone */ }
  }
  children.clear();
}

// 'exit' covers a clean stop; the signals cover --watch restarts and Ctrl-C, where
// the default handler would otherwise take the parent down and leave the child.
process.once('exit', () => killChildren('SIGKILL'));
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.once(sig, () => {
    killChildren('SIGKILL');
    process.exit(0);
  });
}

function pump() {
  while (running < CONCURRENCY && waiting.length) {
    const task = waiting.shift();
    running += 1;
    task().finally(() => { running -= 1; pump(); });
  }
}

function sweep() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) {
      jobs.delete(id);
      if (job.dir) fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/* ── specs ────────────────────────────────────────────────────────────────────── */
const SHOTS = ['hero_wide', 'sheen_grazing', 'macro_detail'];

// Samples per shot, not one number for all three. sheen_grazing is the expensive one
// and not by a little: a grazing specular reflection is the slowest thing in a path
// tracer to converge, because the lobe the rays have to find is narrow. macro_detail
// is nearly free by comparison — a few tiles, one light, no indirect to speak of.
const SAMPLES = { hero_wide: 200, sheen_grazing: 320, macro_detail: 128 };

const DEFAULTS = {
  widthMm: 600,
  heightMm: 600,
  thicknessMm: 10,
  groutMm: 3,
  groutColor: null,
  finish: 'matte',
  lighting: 1,
  hero: 'scene',
  pattern: 'straight',
  resolution: 2048,
  seed: 7,
  roomTemplate: DEFAULT_TEMPLATE,
};

/**
 * Every .blend sitting in templates/, by the name it is listed under.
 *
 * The contract this file makes to whoever buys a scene is "drop it in the folder and
 * it works", so the matching has to survive the filenames a downloaded scene actually
 * arrives with — spaces, capitals, a version suffix. The request is still sanitised
 * (a template name reaching the filesystem is a path-traversal surface), but so is
 * every candidate, and the comparison happens between the two sanitised forms. That
 * way `Modern Kitchen v2.blend` answers to `modern-kitchen-v2` and to what the
 * listing prints, rather than being visible but unreachable.
 */
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function listTemplates() {
  if (!fs.existsSync(TEMPLATES)) return [];
  return fs.readdirSync(TEMPLATES)
    .filter((f) => f.toLowerCase().endsWith('.blend'))
    .map((f) => ({ name: f.replace(/\.blend$/i, ''), file: path.join(TEMPLATES, f) }));
}

function templatePath(name) {
  const wanted = slug(name || DEFAULT_TEMPLATE);
  const available = listTemplates();
  const hit = available.find((t) => slug(t.name) === wanted);
  if (hit) return hit.file;

  const err = new Error(
    available.length
      ? `no room template matching ${JSON.stringify(String(name))}. `
        + `Have: ${available.map((t) => t.name).join(', ')}`
      : 'no room templates yet. Drop a .blend in lib/productImages/templates/, or '
        + 'build the grey box with: npm run blender:bootstrap',
  );
  err.code = 'no_template';
  throw err;
}

/**
 * @param {object} req
 * @param {string} req.swatch        base64 tile photo, ideally already rectified
 * @param {string} [req.sizeLabel]   '1200 x 600 mm' — parsed by imageComposer
 * @param {number} [req.widthMm]     overrides sizeLabel
 * @param {number} [req.heightMm]
 * @param {string} [req.finish]      key into render_room.py's FINISH_PRESETS
 * @param {string} [req.pattern]     straight | stagger_half | stagger_third
 * @param {number} [req.groutMm]
 * @param {string} [req.groutColor]  '#404040'
 * @param {string} [req.roomTemplate]
 * @param {number} [req.resolution]  square, per shot
 * @param {string[]} [req.shots]
 * @returns {{id: string}}  poll it with jobStatus()
 */
function enqueue(req = {}) {
  // Validate the REQUEST before checking the box's capabilities. The other order
  // reports "no Blender installed" for a request that was malformed anyway, which
  // sends whoever is debugging it off to install a renderer they did not need.
  if (!req.swatch) {
    const err = new Error('swatch (base64) is required');
    err.code = 'no_photo';
    throw err;
  }
  const shots = (Array.isArray(req.shots) ? req.shots : SHOTS).filter((s) => SHOTS.includes(s));
  if (!shots.length) {
    const err = new Error(`shots must name some of: ${SHOTS.join(', ')}`);
    err.code = 'bad_shots';
    throw err;
  }

  const blender = resolveBlender();
  const template = templatePath(req.roomTemplate);

  // sizeLabel is the field the catalogue actually carries, so it wins unless a caller
  // states millimetres outright. Same parser the 2D templates use — one place where
  // '1200 x 600 mm' is turned into numbers, not two.
  const dims = req.sizeLabel ? parseSizeLabel(req.sizeLabel) : null;
  const spec = {
    ...DEFAULTS,
    ...(dims ? { widthMm: dims.widthMm, heightMm: dims.heightMm } : {}),
    ...Object.fromEntries(Object.entries(req).filter(([, v]) => v !== undefined && v !== null)),
  };
  const id = crypto.randomUUID();
  const job = {
    id,
    state: 'queued',
    shots,
    queuedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    log: [],
  };
  jobs.set(id, job);
  sweep();
  // How many are in front of it. A bare 'queued' with no number is the state this
  // reported for three minutes while an earlier render held the single slot, and
  // there was no way to tell that from a hang.
  job.position = waiting.length + running;

  waiting.push(async () => {
    job.state = 'rendering';
    job.startedAt = Date.now();
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'md-room-'));
    job.dir = dir;
    try {
      const swatch = await prepareSwatch(spec.swatch, dir);
      const gpu = await probeGpu(blender);
      job.log.push(`gpu: ${gpu.why}`);
      if (!spec.groutColor) job.log.push(`grout read off the tile: ${swatch.grout}`);

      const payload = {
        swatch: swatch.path,
        out_dir: dir,
        width_mm: Number(spec.widthMm),
        height_mm: Number(spec.heightMm),
        thickness_mm: Number(spec.thicknessMm),
        grout_mm: Number(spec.groutMm),
        // An explicit colour wins; otherwise the one read off this swatch.
        grout_color: spec.groutColor || swatch.grout,
        finish: spec.finish,
        pattern: spec.pattern,
        resolution: Number(spec.resolution),
        // The per-shot table, unless a caller overrode it for the whole pack.
        samples: Number(spec.samples) || Math.max(...shots.map((s) => SAMPLES[s])),
        seed: Number(spec.seed),
        // Scene overrides. Every one of these defaults to leaving the .blend exactly
        // as its artist made it — the engine never writes to the file, so a bought
        // scene cannot be damaged by a render.
        lighting: Number(spec.lighting) || 1,
        ambient: Number(spec.ambient) || 1,
        hero: spec.hero === 'auto' ? 'auto' : 'scene',
        exposure: Number.isFinite(Number(spec.exposure)) ? Number(spec.exposure) : null,
        device: gpu.usable ? 'auto' : 'cpu',
        shots,
      };
      await fsp.writeFile(path.join(dir, 'payload.json'), JSON.stringify(payload, null, 2));

      await runBlender(blender, template, path.join(dir, 'payload.json'), job);

      const result = JSON.parse(await fsp.readFile(path.join(dir, 'result.json'), 'utf8'));
      job.shotFiles = result.shots;
      job.device = result.device;
      job.tiles = result.tiles;
      job.blender = result.blender;
      job.swatchSource = swatch.source;
      job.state = 'done';
    } catch (err) {
      job.state = 'failed';
      job.reason = err.message;
      job.code = err.code || 'render_failed';
    } finally {
      job.finishedAt = Date.now();
    }
  });
  pump();

  return { id, queued: job.position };
}

// A hero render legitimately takes minutes; this is the ceiling past which something
// is wrong rather than slow. Scales with the pack, because three shots is three times
// the work and one timeout for both would either be too tight or meaningless.
const PER_SHOT_TIMEOUT_MS = 12 * 60 * 1000;

function runBlender(blender, template, payload, job) {
  return new Promise((resolve, reject) => {
    const proc = spawn(blender, [
      '-b', template,
      // Blender opens an audio device otherwise and complains on a headless box.
      '-noaudio',
      '-P', SCRIPT,
      '--', '--payload', payload,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    children.add(proc);
    let errText = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, PER_SHOT_TIMEOUT_MS * job.shots.length);

    proc.stdout.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        // The script's own lines are the progress the UI wants; Cycles' per-tile
        // spam is not, and there is a great deal of it.
        const m = line.match(/\[render_room\] (.+)/);
        if (m) {
          job.log.push(m[1]);
          if (m[1].startsWith('rendering ')) job.current = m[1].split(' ')[1];
        }
      }
    });
    proc.stderr.on('data', (d) => { errText += d; });

    proc.on('error', (e) => {
      clearTimeout(timer);
      children.delete(proc);
      const err = new Error(`could not run Blender: ${e.message}`);
      err.code = 'no_blender';
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      children.delete(proc);
      if (killed) {
        const err = new Error('the render was killed for running too long');
        err.code = 'render_timeout';
        return reject(err);
      }
      if (code !== 0) {
        // Blender puts Python tracebacks on stdout and its own errors on stderr, and
        // the useful line is almost always the last non-empty one.
        const tail = errText.trim().split('\n').filter(Boolean).slice(-3).join(' / ');
        const err = new Error(`Blender exited ${code}: ${tail.slice(0, 400)}`);
        err.code = 'render_failed';
        return reject(err);
      }
      resolve();
    });
  });
}

/**
 * @param {string} id
 * @param {boolean} [withImages]  read the PNGs off disk as base64. Only worth doing
 *   once the job is done, and only if the caller actually wants the bytes rather
 *   than to know whether it finished.
 */
async function jobStatus(id, withImages = false) {
  const job = jobs.get(id);
  if (!job) return null;

  const out = {
    ok: job.state === 'done',
    id: job.id,
    state: job.state,
    // Recomputed, not the value from queue time: things in front of it finish.
    ahead: job.state === 'queued' ? Math.max(0, waiting.length + running - 1) : 0,
    shots: job.shots,
    current: job.current || null,
    device: job.device || null,
    tiles: job.tiles ?? null,
    blender: job.blender || null,
    reason: job.reason || null,
    code: job.code || null,
    ms: job.finishedAt && job.startedAt ? job.finishedAt - job.startedAt : null,
    queuedMs: job.startedAt ? job.startedAt - job.queuedAt : Date.now() - job.queuedAt,
    log: job.log.slice(-12),
  };

  if (withImages && job.state === 'done' && job.shotFiles) {
    out.images = {};
    for (const [shot, file] of Object.entries(job.shotFiles)) {
      // JPEG for the response: three 2048px PNGs is ~30 MB of base64 in one JSON
      // body, and a PDP gallery serves JPEG anyway.
      const buf = await sharp(file).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
      out.images[shot] = `data:image/jpeg;base64,${buf.toString('base64')}`;
    }
  }
  return out;
}

/** Every job this process knows about, newest first. For the admin's job list. */
function listJobs() {
  return [...jobs.values()]
    .sort((a, b) => b.queuedAt - a.queuedAt)
    .map((j) => ({
      id: j.id,
      state: j.state,
      current: j.current || null,
      shots: j.shots,
      ms: j.finishedAt && j.startedAt ? j.finishedAt - j.startedAt : null,
      queuedAt: new Date(j.queuedAt).toISOString(),
      reason: j.reason || null,
    }));
}

/** For the route's capability check, and for a clear error before anything is queued. */
async function engineStatus() {
  const out = { blender: null, gpu: null, templates: [], concurrency: CONCURRENCY };
  try {
    const bin = resolveBlender();
    out.blender = bin;
    out.gpu = await probeGpu(bin);
  } catch (err) {
    out.reason = err.message;
    out.code = err.code;
    return out;
  }
  out.templates = listTemplates().map((t) => t.name);
  return out;
}

module.exports = {
  enqueue,
  listTemplates,
  jobStatus,
  listJobs,
  engineStatus,
  resolveBlender,
  prepareSwatch,
  SHOTS,
  SAMPLES,
  DEFAULTS,
};
