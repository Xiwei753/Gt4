// SPDX-License-Identifier: GPL-3.0-only
// 纯 JS ZIP 读取器（中央目录 + inflate），无 HarmonyOS 依赖。
// 刻意写成无类型标注的纯 JS：tests/zip_inflate.test.mjs 直接复制为 .mjs
// 在 Node 中验证 inflate 与中央目录解析，保证手机侧 EPUB 解包逻辑可测试。
//
// 安全边界：
//   - 拒绝 '..' 与绝对路径（ZIP 路径穿越）
//   - 限制解压后总大小（防 zip bomb），由构造参数 maxOutputBytes 控制
//   - 不支持 ZIP64（超大 EPUB 需要时明确报错，不静默失败）
//   - 校验 CRC-32

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27,
  31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3,
  3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289,
  16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
  9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const FIXED_LIT_LENGTHS = new Array(288);
for (let i = 0; i <= 143; i++) FIXED_LIT_LENGTHS[i] = 8;
for (let i = 144; i <= 255; i++) FIXED_LIT_LENGTHS[i] = 9;
for (let i = 256; i <= 279; i++) FIXED_LIT_LENGTHS[i] = 7;
for (let i = 280; i <= 287; i++) FIXED_LIT_LENGTHS[i] = 8;
const FIXED_DIST_LENGTHS = new Array(32).fill(5);

function BitReader(data, pos) {
  this.data = data;
  this.pos = pos;
  this.buf = 0;
  this.cnt = 0;
}
BitReader.prototype.getBits = function (n) {
  while (this.cnt < n) {
    if (this.pos >= this.data.length) throw new Error('unexpected end of data');
    this.buf |= this.data[this.pos++] << this.cnt;
    this.cnt += 8;
  }
  const v = this.buf & ((1 << n) - 1);
  this.buf >>>= n;
  this.cnt -= n;
  return v;
};
BitReader.prototype.alignToByte = function () {
  const skip = this.cnt & 7;
  this.buf >>>= skip;
  this.cnt -= skip;
};

function buildHuffman(lengths) {
  let maxLen = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i] > maxLen) maxLen = lengths[i];
  }
  const counts = new Array(maxLen + 1).fill(0);
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i] > 0) counts[lengths[i]]++;
  }
  const nextCode = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let l = 1; l <= maxLen; l++) {
    code = (code + counts[l - 1]) << 1;
    nextCode[l] = code;
  }
  const table = new Map();
  for (let sym = 0; sym < lengths.length; sym++) {
    const l = lengths[sym];
    if (l === 0) continue;
    table.set((l << 16) | nextCode[l], sym);
    nextCode[l]++;
  }
  return {
    decode: function (br) {
      let acc = 0;
      for (let l = 1; l <= maxLen; l++) {
        acc = (acc << 1) | br.getBits(1);
        const sym = table.get((l << 16) | acc);
        if (sym !== undefined) return sym;
      }
      throw new Error('bad huffman code');
    }
  };
}

function inflateBlock(br, litHuff, distHuff, out, maxOutput) {
  for (;;) {
    const sym = litHuff.decode(br);
    if (sym === 256) return;
    if (sym < 256) {
      out.push(sym);
      if (out.length > maxOutput) throw new Error('zip bomb: output exceeds limit');
      continue;
    }
    const li = sym - 257;
    if (li < 0 || li >= LENGTH_BASE.length) throw new Error('bad length symbol');
    const len = LENGTH_BASE[li] +
      (LENGTH_EXTRA[li] ? br.getBits(LENGTH_EXTRA[li]) : 0);
    const dsym = distHuff.decode(br);
    if (dsym < 0 || dsym >= DIST_BASE.length) throw new Error('bad distance symbol');
    const dist = DIST_BASE[dsym] +
      (DIST_EXTRA[dsym] ? br.getBits(DIST_EXTRA[dsym]) : 0);
    if (dist > out.length) throw new Error('distance too far back');
    for (let k = 0; k < len; k++) {
      out.push(out[out.length - dist]);
      if (out.length > maxOutput) throw new Error('zip bomb: output exceeds limit');
    }
  }
}

export function inflateRaw(data, maxOutput) {
  const br = new BitReader(data, 0);
  const out = [];
  let finalBlock = false;
  while (!finalBlock) {
    finalBlock = br.getBits(1) === 1;
    const type = br.getBits(2);
    if (type === 0) {
      br.alignToByte();
      const len = br.getBits(16);
      const nlen = br.getBits(16);
      if ((len ^ 0xffff) !== nlen) throw new Error('stored block length mismatch');
      for (let i = 0; i < len; i++) {
        out.push(br.getBits(8));
        if (out.length > maxOutput) throw new Error('zip bomb: output exceeds limit');
      }
    } else if (type === 1) {
      inflateBlock(br, buildHuffman(FIXED_LIT_LENGTHS),
        buildHuffman(FIXED_DIST_LENGTHS), out, maxOutput);
    } else if (type === 2) {
      const hlit = br.getBits(5) + 257;
      const hdist = br.getBits(5) + 1;
      const hclen = br.getBits(4) + 4;
      const clLengths = new Array(19).fill(0);
      for (let i = 0; i < hclen; i++) clLengths[CL_ORDER[i]] = br.getBits(3);
      const clHuff = buildHuffman(clLengths);
      const all = new Array(hlit + hdist);
      let i = 0;
      while (i < all.length) {
        const sym = clHuff.decode(br);
        if (sym < 16) {
          all[i++] = sym;
        } else if (sym === 16) {
          if (i === 0) throw new Error('repeat code with no previous length');
          const prev = all[i - 1];
          const rep = 3 + br.getBits(2);
          for (let r = 0; r < rep && i < all.length; r++) all[i++] = prev;
        } else if (sym === 17) {
          const rep = 3 + br.getBits(3);
          for (let r = 0; r < rep && i < all.length; r++) all[i++] = 0;
        } else {
          const rep = 11 + br.getBits(7);
          for (let r = 0; r < rep && i < all.length; r++) all[i++] = 0;
        }
      }
      inflateBlock(br, buildHuffman(all.slice(0, hlit)),
        buildHuffman(all.slice(hlit)), out, maxOutput);
    } else {
      throw new Error('reserved deflate block type');
    }
  }
  return new Uint8Array(out);
}

const CRC_TABLE = (function () {
  const table = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, crc = 0) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function utf8Decode(bytes) {
  let s = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) { s += String.fromCharCode(b0); i += 1; continue; }
    let width = 0;
    if (b0 >= 0xf0) width = 4;
    else if (b0 >= 0xe0) width = 3;
    else width = 2;
    if (i + width > bytes.length) { s += '�'; return s; }
    const b1 = bytes[i + 1], b2 = bytes[i + 2], b3 = bytes[i + 3];
    let code = width === 2 ? ((b0 & 31) << 6) | (b1 & 63) :
      width === 3 ? ((b0 & 15) << 12) | ((b1 & 63) << 6) | (b2 & 63) :
      ((b0 & 7) << 18) | ((b1 & 63) << 12) | ((b2 & 63) << 6) | (b3 & 63);
    if (code <= 0xffff) s += String.fromCharCode(code);
    else {
      const pair = code - 0x10000;
      s += String.fromCharCode(0xd800 + (pair >> 10), 0xdc00 + (pair & 1023));
    }
    i += width;
  }
  return s;
}

function safeEntryName(name) {
  if (name.length === 0) throw new Error('empty entry name');
  if (name[0] === '/') throw new Error('absolute path in zip: ' + name);
  const parts = name.split('/');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '..') throw new Error('path traversal in zip: ' + name);
  }
  return name;
}

function readU16(data, pos) {
  return data[pos] | (data[pos + 1] << 8);
}
function readU32(data, pos) {
  return (data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) |
    (data[pos + 3] << 24)) >>> 0;
}

// 本文件必须保持**纯 JS**（不含 TS 专有语法）：
// tests/zip_inflate.test.mjs 会把它原样复制成 .mjs 直接交给 Node 跑。
// 因此实例的类型接口声明在 EpubImportService.ts 里，不放在这里。
export function ZipReader(data, maxOutputBytes) {
  this.data = data;
  this.maxOutput = maxOutputBytes === undefined ? 64 * 1024 * 1024 : maxOutputBytes;
  this.entries = [];
  this.byName = new Map();
  this.parseCentralDirectory();
}

ZipReader.prototype.parseCentralDirectory = function () {
  const data = this.data;
  const scanStart = Math.max(0, data.length - 22 - 65536);
  let eocd = -1;
  for (let i = data.length - 22; i >= scanStart; i--) {
    if (readU32(data, i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: EOCD not found');
  const total = readU16(data, eocd + 10);
  const cdSize = readU32(data, eocd + 12);
  const cdOffset = readU32(data, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('zip64 archives are not supported');
  }
  let pos = cdOffset;
  for (let n = 0; n < total; n++) {
    if (readU32(data, pos) !== CDH_SIG) throw new Error('bad central directory');
    const method = readU16(data, pos + 10);
    const crc = readU32(data, pos + 16);
    const compSize = readU32(data, pos + 20);
    const uncompSize = readU32(data, pos + 24);
    const nameLen = readU16(data, pos + 28);
    const extraLen = readU16(data, pos + 30);
    const commentLen = readU16(data, pos + 32);
    const localOffset = readU32(data, pos + 42);
    const name = utf8Decode(data.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const entry = {
      name: safeEntryName(name),
      method, crc, compSize, uncompSize, localOffset
    };
    this.entries.push(entry);
    this.byName.set(entry.name, entry);
  }
};

ZipReader.prototype.has = function (name) {
  return this.byName.has(name);
};

ZipReader.prototype.names = function () {
  const out = [];
  for (let i = 0; i < this.entries.length; i++) out.push(this.entries[i].name);
  return out;
};

ZipReader.prototype.read = function (name) {
  const entry = this.byName.get(name);
  if (!entry) throw new Error('entry not found: ' + name);
  const data = this.data;
  const lo = entry.localOffset;
  if (readU32(data, lo) !== LFH_SIG) throw new Error('bad local file header');
  const nameLen = readU16(data, lo + 26);
  const extraLen = readU16(data, lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  let raw;
  if (entry.method === 0) {
    raw = data.subarray(dataStart, dataStart + entry.uncompSize);
  } else if (entry.method === 8) {
    const comp = data.subarray(dataStart, dataStart + entry.compSize);
    // 硬上限：声明大小（uncompSize）来自压缩包本身，不可信，
    // 不能用来放宽防护；解压后再用 size 检查兜底。
    raw = inflateRaw(comp, this.maxOutput);
  } else {
    throw new Error('unsupported compression method ' + entry.method +
      ' for ' + name);
  }
  if (raw.length !== entry.uncompSize) {
    throw new Error('size mismatch for ' + name + ': expected ' +
      entry.uncompSize + ', got ' + raw.length);
  }
  const actual = crc32(raw);
  if (actual !== entry.crc) {
    throw new Error('crc32 mismatch for ' + name);
  }
  return raw;
};

ZipReader.prototype.readText = function (name) {
  return utf8Decode(this.read(name));
};
