/**
 * routes/pdf.js — pull every embedded image out of a PDF (catalogues, lookbooks).
 *
 * Registered by index.js under /api/pdf. The work is lib/pdfImages.py (PyMuPDF);
 * this is upload, spawn, and serving the results back to download.
 *
 * Results live in the OS temp dir, one folder per upload, not in the response: a
 * 60-page catalogue is ~40 MB of images, which as base64 JSON would be ~55 MB.
 *
 * ponytail: temp folders older than an hour are swept on each new upload. No job
 * store, no DB — if the process restarts the folders are still there until swept.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const sharp = require('sharp');
const { resolvePython } = require('../lib/productImages/rectify');

const SCRIPT = path.join(__dirname, '..', 'lib', 'pdfImages.py');
const ROOT = path.join(os.tmpdir(), 'material-pdf-images');
const MAX_PDF = 200 * 1024 * 1024;
const KEEP_MS = 60 * 60 * 1000;

// Only these ever reach the filesystem, so a crafted path cannot escape ROOT.
const JOB_RE = /^[0-9a-f-]{36}$/;
const FILE_RE = /^[\w-]+\.(png|jpg|zip)$/;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', zip: 'application/zip' };

/** A PDF's file name → a safe folder / download name: "3 - Livshade.pdf" → "3 - Livshade". */
const safeName = (s, fallback) =>
  String(s || '').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 120) || fallback;

function sweep() {
  for (const d of fs.readdirSync(ROOT)) {
    const p = path.join(ROOT, d);
    if (Date.now() - fs.statSync(p).mtimeMs > KEEP_MS) fs.rmSync(p, { recursive: true, force: true });
  }
}

module.exports = async function (fastify) {
  // Raw PDF body, not base64 JSON: skips a 33% inflation and a 40 MB string decode.
  fastify.addContentTypeParser('application/pdf', { parseAs: 'buffer', bodyLimit: MAX_PDF },
    (req, body, done) => done(null, body));

  /** POST /images?name=<file name> — body is the PDF itself (content-type: application/pdf). */
  fastify.post('/images', { bodyLimit: MAX_PDF }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || req.body.subarray(0, 5).toString() !== '%PDF-') {
      return reply.code(400).send({ success: false, error: 'send a PDF with content-type application/pdf' });
    }

    let python;
    try { python = resolvePython(); } catch (err) {
      return reply.code(503).send({ success: false, error: err.message, code: err.code });
    }

    fs.mkdirSync(ROOT, { recursive: true });
    sweep();
    const job = crypto.randomUUID();
    const dir = path.join(ROOT, job);
    fs.mkdirSync(dir);
    const pdf = path.join(dir, 'source.pdf');
    fs.writeFileSync(pdf, req.body);

    const started = Date.now();
    try {
      const out = await new Promise((resolve, reject) =>
        execFile(python, [SCRIPT, pdf, dir, safeName(req.query.name, 'pdf-images')], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => (err ? reject(new Error(stderr.trim().slice(-300) || err.message)) : resolve(stdout))));
      fs.rmSync(pdf);
      return { success: true, job, ms: Date.now() - started, ...JSON.parse(out) };
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      req.log.error(err);
      return reply.code(502).send({ success: false, error: `extraction failed: ${err.message}` });
    }
  });

  /**
   * GET /images/:job/:file — one image, or all.zip. `?dl=<name>` makes it a download
   * saved as <name> (default: the file's own name).
   * `?thumb=1` is a ≤480px WebP for the grid (keeps transparency); the original is untouched.
   * ponytail: thumbs are made per request, not cached — a page of them is ~1 s of sharp.
   */
  fastify.get('/images/:job/:file', async (req, reply) => {
    const { job, file } = req.params;
    const p = path.join(ROOT, job, file);
    if (!JOB_RE.test(job) || !FILE_RE.test(file) || !fs.existsSync(p)) {
      return reply.code(404).send({ success: false, error: 'not found — extractions are kept for an hour' });
    }
    if (req.query.thumb && !file.endsWith('.zip')) {
      const webp = await sharp(p).resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
      return reply.type('image/webp').header('cache-control', 'private, max-age=3600').send(webp);
    }
    if (req.query.dl) {
      const ext = path.extname(file);
      const as = req.query.dl === '1' ? file : safeName(req.query.dl, 'download') + ext;
      // ASCII fallback + UTF-8 form, so a name with spaces or accents survives every browser.
      reply.header('content-disposition',
        `attachment; filename="${as.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(as)}`);
    }
    return reply.type(TYPES[file.split('.').pop()]).send(fs.createReadStream(p));
  });
};
