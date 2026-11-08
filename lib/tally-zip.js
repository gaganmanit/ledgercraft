import * as compression from 'node:zlib';
const { inflateRawSync } = compression;

const LIMIT = 64 * 1024 * 1024;
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function checksum(bytes) {
  if (typeof compression.crc32 === 'function') return compression.crc32(bytes);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
function utf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('ZIP entry names must use UTF-8'); }
}

// Read in memory; no archive path is ever written or opened on the filesystem.
export function readTallyZip(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 22 || bytes.length > 40 * 1024 * 1024) throw new Error('Choose a complete ZIP/XLSX of at most 40 MB');
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
  if (end < Math.max(0, bytes.length - 65557)) throw new Error('ZIP directory is missing or truncated');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count === 65535 || size === 0xffffffff || offset === 0xffffffff) throw new Error('Split and ZIP64 archives are not supported');
  if (!count || count > 2048 || offset + size !== end) throw new Error('ZIP directory exceeds the supported bounds');
  let cursor = offset, total = 0;
  const entries = new Map(), spans = [];
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20), length = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), disk = bytes.readUInt16LE(cursor + 34);
    const local = bytes.readUInt32LE(cursor + 42), entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > end || disk || length === 0xffffffff || compressed === 0xffffffff || local === 0xffffffff) throw new Error('Invalid or unsupported ZIP entry');
    const name = utf8(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (!name || name.length > 500 || /[\\\x00-\x1f]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some(part => part === '..' || part === '.')) throw new Error('Unsafe ZIP entry path');
    if (entries.has(name) || [...entries.keys()].some(key => key.toLowerCase() === name.toLowerCase())) throw new Error('Duplicate ZIP entry name');
    if (flags & ~0x080e || flags & 1 || ![0, 8].includes(method)) throw new Error('Encrypted or unsupported ZIP compression is not accepted');
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    if ((mode & 0xf000) === 0xa000) throw new Error('ZIP symbolic links are not accepted');
    total += length;
    if (length > 16 * 1024 * 1024 || total > LIMIT) throw new Error('ZIP expanded content exceeds the supported limit');
    if (local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP local entry is missing');
    const localNameLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), start = local + 30 + localNameLength + localExtra;
    if (bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || utf8(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name || start + compressed > offset) throw new Error('ZIP local and directory entries disagree');
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== length)) throw new Error('ZIP local sizes or checksum disagree');
    if (spans.some(([from, to]) => local < to && start + compressed > from)) throw new Error('Overlapping ZIP entries are not accepted');
    spans.push([local, start + compressed]);
    const packed = bytes.subarray(start, start + compressed);
    let content;
    try { content = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: Math.max(1, length) }); }
    catch { throw new Error('ZIP entry cannot be decompressed within its declared bounds'); }
    if (content.length !== length || checksum(content) !== crc) throw new Error('ZIP entry checksum or expanded size is invalid');
    entries.set(name, content);
    cursor = entryEnd;
  }
  if (cursor !== offset + size) throw new Error('ZIP directory length is invalid');
  return entries;
}
