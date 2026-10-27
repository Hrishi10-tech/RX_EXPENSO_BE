/** Lists the entry names of a ZIP by reading its central directory; enough to check the §8.3 layout in tests. */
export function zipEntries(buf: Buffer): string[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  let count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) {
    // ZIP64: the locator sits right before the classic end record.
    const loc = eocd - 20;
    const rec = Number(buf.readBigUInt64LE(loc + 8));
    count = Number(buf.readBigUInt64LE(rec + 32));
    p = Number(buf.readBigUInt64LE(rec + 48));
  }
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const n = buf.readUInt16LE(p + 28), x = buf.readUInt16LE(p + 30), c = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + n));
    p += 46 + n + x + c;
  }
  return names;
}
