'use strict';

/**
 * rectify.js — Node's side of the OpenCV rectifier.
 *
 * Undoing a camera's perspective needs a homography: a four-point mapping that lets
 * parallel lines converge. sharp has affine only, which is why the studio warp had to
 * be hand-written a column at a time, and why this one step reaches outside Node
 * rather than being folded into imageComposer.
 *
 * The Python does the vision; this does process management and speaks the same
 * base64-in / base64-out contract as every other function in this directory, so a
 * caller cannot tell which language did the work.
 *
 * ponytail: a spawn per call, not a resident worker. Rectifying happens once per
 * PHOTO, by a human who just picked a file — interpreter startup is ~200ms against a
 * a person deciding what to upload next. A pool would be the right answer for a bulk
 * import of a supplier's whole folder, and that is when to build one.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, 'rectify.py');

// The project venv, then whatever python is on PATH. PYTHON_BIN overrides both.
const PYTHON_CANDIDATES = [
  process.env.PYTHON_BIN,
  path.join(__dirname, '..', '..', '.venv-cv', 'bin', 'python'),
].filter(Boolean);

function resolvePython() {
  const found = PYTHON_CANDIDATES.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
  if (found) return found;
  const err = new Error(
    'no Python with OpenCV found. Create it with: python3 -m venv .venv-cv && ' +
      './.venv-cv/bin/pip install opencv-python-headless numpy — or set PYTHON_BIN. ' +
      'Nothing else in this service needs Python.',
  );
  err.code = 'no_python';
  throw err;
}

const MAX_OUTPUT = 64 * 1024 * 1024; // two PNGs of a large photo, with room to spare
const TIMEOUT_MS = 30000;

/**
 * @param {string} b64          the photo
 * @param {object} [opts]
 * @param {string} [opts.sizeLabel]  gives the target aspect, so a 1200x600 plank
 *   rectifies to 2:1 rather than to whatever shape the camera happened to see
 * @param {number} [opts.max]        longest edge of the output
 * @returns {Promise<{ok, reason?, confidence?, quad?, source?, output?, rectified?, overlay?}>}
 */
async function rectify(b64, { sizeLabel, max } = {}) {
  if (!b64) {
    const err = new Error('photo (base64) is required');
    err.code = 'no_photo';
    throw err;
  }

  const { parseSizeLabel } = require('./imageComposer');
  const dims = parseSizeLabel(sizeLabel);

  const args = [SCRIPT];
  if (dims) args.push('--aspect', `${dims.widthMm}:${dims.heightMm}`);
  if (max) args.push('--max', String(Math.round(max)));

  const python = resolvePython();

  return new Promise((resolve, reject) => {
    const proc = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let errText = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, TIMEOUT_MS);

    proc.stdout.on('data', (d) => {
      out += d;
      // A runaway child must not take the service's memory with it.
      if (out.length > MAX_OUTPUT) {
        killed = true;
        proc.kill('SIGKILL');
      }
    });
    proc.stderr.on('data', (d) => { errText += d; });

    proc.on('error', (e) => {
      clearTimeout(timer);
      const err = new Error(`could not run the rectifier: ${e.message}`);
      err.code = 'no_python';
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        const err = new Error('the rectifier was killed — photo too large, or it hung');
        err.code = 'rectify_failed';
        return reject(err);
      }
      if (code !== 0) {
        const err = new Error(`rectifier exited ${code}: ${errText.trim().slice(0, 300)}`);
        err.code = 'rectify_failed';
        return reject(err);
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        const err = new Error(`rectifier returned no JSON: ${out.slice(0, 200)}`);
        err.code = 'rectify_failed';
        reject(err);
      }
    });

    proc.stdin.end(Buffer.from(b64, 'base64'));
  });
}

module.exports = { rectify, resolvePython };
