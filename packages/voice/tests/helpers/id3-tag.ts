/** An ID3v2.4 tag with `size` payload bytes (synchsafe), optionally with a footer. */
export function id3Tag(size: number, footer = false): Buffer {
  const header = Buffer.from([
    0x49, 0x44, 0x33, 4, 0, footer ? 0x10 : 0,
    (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f,
  ]);
  const parts = [header, Buffer.alloc(size, 0x20)];
  if (footer) parts.push(Buffer.from([0x33, 0x44, 0x49, 4, 0, 0x10, 0, 0, 0, 0]));
  return Buffer.concat(parts);
}
