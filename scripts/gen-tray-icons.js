// One-off script: generates the template tray-icon PNGs (D3 - hand-built
// placeholder, tracked for real design-asset replacement as task #46/#20b).
// No image-processing dependency added to package.json for a build-time-only
// script - PNG is simple enough to encode directly with zlib (already in
// Node core) + a standard CRC32 table.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = chunk('IHDR', ihdrData);

  // Raw scanlines: 1 filter-type byte (None) + width*4 RGBA bytes, per row.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: None
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = chunk('IDAT', zlib.deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

// Bracket-mark glyph (open "[" with a shortened bottom arm - matches the
// brand Logo path's proportions: top bar, full left side, partial bottom
// bar), rasterized as black fill on transparent - macOS template-image
// convention (black = shape, alpha = coverage/anti-alias, color ignored and
// re-tinted by the OS for light/dark menu bars).
function drawBracket(size, black) {
  const buf = Buffer.alloc(size * size * 4); // transparent by default
  const strokeW = Math.max(1, Math.round(size * 0.145));
  const inset = Math.round(size * 0.2);
  const bottomArmLen = Math.round(size * 0.42);

  function setPixel(x, y, alpha) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = black ? 0 : 255;
    buf[i + 1] = black ? 0 : 255;
    buf[i + 2] = black ? 0 : 255;
    buf[i + 3] = alpha;
  }
  function fillRect(x0, y0, x1, y1) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        setPixel(x, y, 255);
      }
    }
  }

  // Top bar (full width of the bracket)
  fillRect(inset, inset, size - inset, inset + strokeW);
  // Left bar (full height)
  fillRect(inset, inset, inset + strokeW, size - inset);
  // Bottom bar (shortened, per the brand mark's asymmetric bracket)
  fillRect(inset, size - inset - strokeW, inset + bottomArmLen, size - inset);

  return buf;
}

// Windows tray icons are NOT auto-tinted (no template-image concept), so a
// pure-black glyph is invisible on a dark taskbar - confirmed via grok
// review + OpenWhispr's real Windows icon (separate colored .ico, never
// reusing the macOS template asset). Colored fill + a white halo (drawn
// first, slightly dilated) keeps it visible on both light and dark
// taskbars without needing per-theme detection.
function drawBracketColored(size, hexColor) {
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);
  const buf = Buffer.alloc(size * size * 4);
  const strokeW = Math.max(1, Math.round(size * 0.145));
  const inset = Math.round(size * 0.2);
  const bottomArmLen = Math.round(size * 0.42);
  const halo = Math.max(1, Math.round(size * 0.09));

  function fillRect(x0, y0, x1, y1, rr, gg, bb) {
    for (let y = Math.max(0, y0); y < Math.min(size, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(size, x1); x++) {
        const i = (y * size + x) * 4;
        buf[i] = rr;
        buf[i + 1] = gg;
        buf[i + 2] = bb;
        buf[i + 3] = 255;
      }
    }
  }
  function bracket(inset_, strokeW_, bottomArmLen_, rr, gg, bb) {
    fillRect(inset_, inset_, size - inset_, inset_ + strokeW_, rr, gg, bb);
    fillRect(inset_, inset_, inset_ + strokeW_, size - inset_, rr, gg, bb);
    fillRect(inset_, size - inset_ - strokeW_, inset_ + bottomArmLen_, size - inset_, rr, gg, bb);
  }
  // White halo first (dilated), then the real color on top - simple fixed
  // 2-layer contrast outline, not true edge-detection dilation, but enough
  // at 16-32px tray sizes.
  bracket(inset - halo, strokeW + halo * 2, bottomArmLen + halo, 255, 255, 255);
  bracket(inset, strokeW, bottomArmLen, r, g, b);
  return buf;
}

function drawRedDot(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.32;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= r) {
        const i = (y * size + x) * 4;
        buf[i] = 0xed;
        buf[i + 1] = 0x29;
        buf[i + 2] = 0x29;
        buf[i + 3] = 255;
      }
    }
  }
  return buf;
}

const outDir = path.join(__dirname, '..', 'src', 'assets');

// Template bracket icon: 22pt canvas per spec, @1x/@2x/@3x.
for (const [suffix, size] of [['', 22], ['@2x', 44], ['@3x', 66]]) {
  const buf = drawBracket(size, true);
  fs.writeFileSync(path.join(outDir, `tray-icon-template${suffix}.png`), encodePng(size, size, buf));
}

// Non-template red-dot recording variant (color is the point - not tinted).
for (const [suffix, size] of [['', 22], ['@2x', 44], ['@3x', 66]]) {
  const buf = drawRedDot(size);
  fs.writeFileSync(path.join(outDir, `tray-icon-recording${suffix}.png`), encodePng(size, size, buf));
}

// Windows/Linux tray icon: standard system-tray sizes (16/32px), colored +
// haloed (see drawBracketColored) since there's no OS auto-tint there.
for (const [suffix, size] of [['', 16], ['@2x', 32]]) {
  const buf = drawBracketColored(size, '#038FF8');
  fs.writeFileSync(path.join(outDir, `tray-icon-win${suffix}.png`), encodePng(size, size, buf));
}

console.log('Wrote tray-icon-template.png (+@2x/@3x), tray-icon-recording.png (+@2x/@3x), and tray-icon-win.png (+@2x) to', outDir);
