'use strict';
// Minimal ZIP reader for tests: returns { name: Buffer } and checks every CRC.
const zlib = require('zlib');

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Not a ZIP: no end record');
  let count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const info = { zip64: false, unicodeExtra: 0 };
  if (count === 0xffff || p === 0xffffffff) { // ZIP64: the real numbers are in the ZIP64 end record
    if (buf.readUInt32LE(eocd - 20) !== 0x07064b50) throw new Error('ZIP64 locator missing');
    const rec = Number(buf.readBigUInt64LE(eocd - 20 + 8));
    if (buf.readUInt32LE(rec) !== 0x06064b50) throw new Error('ZIP64 end record missing');
    count = Number(buf.readBigUInt64LE(rec + 32));
    p = Number(buf.readBigUInt64LE(rec + 48));
    info.zip64 = true;
  }
  const out = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // central extra fields: ZIP64 (0x0001) replaces any 0xFFFFFFFF value, in the order usize, csize, offset
    let q = p + 46 + nameLen;
    const extraEnd = q + extraLen;
    while (q < extraEnd) {
      const id = buf.readUInt16LE(q);
      const len = buf.readUInt16LE(q + 2);
      if (id === 0x0001) {
        let r = q + 4;
        if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(r)); r += 8; }
        if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(r)); r += 8; }
        if (local === 0xffffffff) { local = Number(buf.readBigUInt64LE(r)); r += 8; }
        info.zip64 = true;
      } else if (id === 0x7075) {
        info.unicodeExtra++;
      }
      q += 4 + len;
    }
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if (data.length !== usize) throw new Error(`Size mismatch for ${name}`);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    out[name] = data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  Object.defineProperty(out, '__info', { value: info, enumerable: false });
  return out;
}

module.exports = { readZip };
