// Reading EVE Ref's killmail archives (data.everef.net/killmails/YYYY/killmails-YYYY-MM-DD.tar.bz2)
// without dependencies: a bzip2 decompressor and a tar reader. Node's zlib has no bzip2.
//
// bunzip2 follows the format of the reference implementation (bzip2 1.0.x): per block, Huffman-coded
// MTF/RLE2 symbols, the inverse Burrows–Wheeler transform, then the RLE1 run expansion. Concatenated
// streams (as pbzip2 writes) are read one after another. Block CRCs are not checked: a corrupt
// archive shows up as unparseable JSON instead.

const BLOCK_MAGIC_HI = 0x314159, BLOCK_MAGIC_LO = 0x265359;
const END_MAGIC_HI = 0x177245, END_MAGIC_LO = 0x385090;
const MAX_GROUPS = 6, GROUP_SIZE = 50, MAX_CODE_LEN = 23, MAX_SELECTORS = 18002;

class BitReader {
  constructor(bytes) { this.b = bytes; this.pos = 0; this.buf = 0; this.cnt = 0; }
  bits(n) {   // n ≤ 24
    while (this.cnt < n) {
      if (this.pos >= this.b.length) throw new Error('bzip2: unexpected end of data');
      this.buf = ((this.buf << 8) | this.b[this.pos++]) >>> 0;
      this.cnt += 8;
    }
    this.cnt -= n;
    return (this.buf >>> this.cnt) & ((1 << n) - 1);
  }
  bit() { return this.bits(1); }
  align() { this.cnt -= this.cnt % 8; }
  get done() { return this.cnt < 8 && this.pos >= this.b.length; }
}

// Canonical Huffman decode tables, as the reference's BZ2_hbCreateDecodeTables.
function decodeTable(lengths, alphaSize) {
  let minLen = 32, maxLen = 0;
  for (let i = 0; i < alphaSize; i++) { minLen = Math.min(minLen, lengths[i]); maxLen = Math.max(maxLen, lengths[i]); }
  const perm = new Int32Array(alphaSize), base = new Int32Array(MAX_CODE_LEN + 2), limit = new Int32Array(MAX_CODE_LEN + 2);
  let pp = 0;
  for (let len = minLen; len <= maxLen; len++) for (let j = 0; j < alphaSize; j++) if (lengths[j] === len) perm[pp++] = j;
  for (let i = 0; i < alphaSize; i++) base[lengths[i] + 1]++;
  for (let i = 1; i < base.length; i++) base[i] += base[i - 1];
  let vec = 0;
  for (let i = minLen; i <= maxLen; i++) { vec += base[i + 1] - base[i]; limit[i] = vec - 1; vec <<= 1; }
  for (let i = minLen + 1; i <= maxLen; i++) base[i] = ((limit[i - 1] + 1) << 1) - base[i];
  return { minLen, maxLen, perm, base, limit };
}

function readBlock(br, blockMax, out) {
  br.bits(16); br.bits(16);   // block CRC
  if (br.bit()) throw new Error('bzip2: randomised blocks are not supported');
  const origPtr = br.bits(24);

  // Which byte values occur: 16 ranges of 16.
  const ranges = br.bits(16), seqToUnseq = [];
  for (let i = 0; i < 16; i++) {
    if (!(ranges & (0x8000 >> i))) continue;
    const used = br.bits(16);
    for (let j = 0; j < 16; j++) if (used & (0x8000 >> j)) seqToUnseq.push(i * 16 + j);
  }
  if (!seqToUnseq.length) throw new Error('bzip2: empty symbol map');
  const alphaSize = seqToUnseq.length + 2;

  const nGroups = br.bits(3);
  if (nGroups < 2 || nGroups > MAX_GROUPS) throw new Error('bzip2: bad group count');
  const nSelectors = br.bits(15);
  if (nSelectors < 1) throw new Error('bzip2: no selectors');
  const mtfGroups = Array.from({ length: nGroups }, (_, i) => i);
  const selectors = new Uint8Array(Math.min(nSelectors, MAX_SELECTORS));
  for (let i = 0; i < nSelectors; i++) {
    let j = 0;
    while (br.bit()) if (++j >= nGroups) throw new Error('bzip2: bad selector');
    const g = mtfGroups[j];
    mtfGroups.splice(j, 1); mtfGroups.unshift(g);
    if (i < MAX_SELECTORS) selectors[i] = g;
  }

  const tables = [];
  for (let g = 0; g < nGroups; g++) {
    const lengths = new Uint8Array(alphaSize);
    let len = br.bits(5);
    for (let s = 0; s < alphaSize; s++) {
      for (;;) {
        if (len < 1 || len > 20) throw new Error('bzip2: bad code length');
        if (!br.bit()) break;
        len += br.bit() ? -1 : 1;
      }
      lengths[s] = len;
    }
    tables.push(decodeTable(lengths, alphaSize));
  }

  // Symbols → MTF/RLE2 → the BWT block (bytes in tt's low 8 bits).
  const tt = new Uint32Array(blockMax);
  const counts = new Int32Array(256);
  const mtf = seqToUnseq.slice();
  const EOB = alphaSize - 1;
  let n = 0, run = 0, weight = 1, groupLeft = 0, sel = 0, t = null;
  for (;;) {
    if (groupLeft === 0) {
      if (sel >= selectors.length) throw new Error('bzip2: ran out of selectors');
      t = tables[selectors[sel++]];
      groupLeft = GROUP_SIZE;
    }
    groupLeft--;
    let zn = t.minLen, zvec = br.bits(zn);
    while (zvec > t.limit[zn]) {
      if (++zn > MAX_CODE_LEN) throw new Error('bzip2: bad Huffman code');
      zvec = (zvec << 1) | br.bit();
    }
    const sym = t.perm[zvec - t.base[zn]];
    if (sym <= 1) { run += (sym + 1) * weight; weight <<= 1; continue; }   // RUNA / RUNB
    if (run) {
      if (n + run > blockMax) throw new Error('bzip2: block overflow');
      const b = mtf[0];
      counts[b] += run;
      tt.fill(b, n, n + run);
      n += run; run = 0;
    }
    weight = 1;
    if (sym === EOB) break;
    if (n >= blockMax) throw new Error('bzip2: block overflow');
    const idx = sym - 1, b = mtf[idx];
    mtf.copyWithin(1, 0, idx); mtf[0] = b;
    counts[b]++;
    tt[n++] = b;
  }
  if (origPtr >= n) throw new Error('bzip2: bad origin pointer');

  // Inverse BWT.
  const start = new Int32Array(256);
  for (let i = 1; i < 256; i++) start[i] = start[i - 1] + counts[i - 1];
  for (let i = 0; i < n; i++) { const b = tt[i] & 0xff; tt[start[b]++] |= i << 8; }

  // Walk it, expanding RLE1 runs (4 equal bytes, then a count byte).
  let pos = tt[origPtr] >>> 8, last = -1, same = 0;
  for (let i = 0; i < n; i++) {
    const v = tt[pos];
    const b = v & 0xff;
    pos = v >>> 8;
    if (same === 4) { out.repeat(last, b); same = 0; last = -1; continue; }
    out.push(b);
    if (b === last) same++; else { last = b; same = 1; }
  }
}

// A growable byte buffer.
class Out {
  constructor(size = 1 << 20) { this.buf = new Uint8Array(size); this.len = 0; }
  grow(need) {
    if (this.len + need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + need) size *= 2;
    const b = new Uint8Array(size); b.set(this.buf.subarray(0, this.len)); this.buf = b;
  }
  push(b) { if (this.len === this.buf.length) this.grow(1); this.buf[this.len++] = b; }
  repeat(b, count) { if (!count) return; this.grow(count); this.buf.fill(b, this.len, this.len + count); this.len += count; }
  bytes() { return this.buf.subarray(0, this.len); }
}

/** Decompresses a .bz2 file (one or more concatenated streams). */
export function bunzip2(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const br = new BitReader(bytes);
  const out = new Out(Math.max(1 << 16, bytes.length * 6));
  let streams = 0;
  while (!br.done) {
    if (br.bits(8) !== 0x42 || br.bits(8) !== 0x5a || br.bits(8) !== 0x68) {
      if (streams) break;   // trailing garbage after a complete stream
      throw new Error('bzip2: not a bzip2 file');
    }
    const level = br.bits(8) - 0x30;
    if (level < 1 || level > 9) throw new Error('bzip2: bad block size');
    const blockMax = level * 100000;
    for (;;) {
      const hi = br.bits(24), lo = br.bits(24);
      if (hi === BLOCK_MAGIC_HI && lo === BLOCK_MAGIC_LO) { readBlock(br, blockMax, out); continue; }
      if (hi === END_MAGIC_HI && lo === END_MAGIC_LO) { br.bits(16); br.bits(16); break; }   // stream CRC
      throw new Error('bzip2: bad block header');
    }
    br.align();
    streams++;
  }
  return out.bytes();
}

const text = (b, from, len) => {
  let end = from;
  while (end < from + len && b[end]) end++;
  return Buffer.from(b.buffer, b.byteOffset + from, end - from).toString('utf8');
};

/**
 * The regular files in a tar archive, in order.
 * @param {Uint8Array} tar
 * @param {(name: string, data: Uint8Array) => void} onFile
 */
export function untar(tar, onFile) {
  let off = 0, longName = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every(x => x === 0)) break;
    const size = parseInt(text(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 0x30);
    const prefix = text(h, 345, 155);
    let name = longName ?? (prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100));
    longName = null;
    const data = tar.subarray(off + 512, off + 512 + size);
    if (type === 'L') longName = text(data, 0, size);          // GNU long name for the next entry
    else if (type === 'x') {                                   // pax header: may carry the path
      const m = Buffer.from(data).toString('utf8').match(/^\d+ path=(.*)$/m);
      if (m) longName = m[1];
    } else if (type === '0' || type === '\0' || type === '7') onFile(name, data);
    off += 512 + Math.ceil(size / 512) * 512;
  }
}
