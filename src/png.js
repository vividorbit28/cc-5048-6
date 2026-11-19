/* 零依赖 PNG 编码器: RGBA8 -> PNG 字节, 内置固定哈夫曼 deflate (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MPM = Object.assign(root.MPM || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function adler32(bytes) {
    let a = 1, b = 0;
    for (let i = 0; i < bytes.length; i++) {
      a = (a + bytes[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  /* 位写出器, LSB 优先 */
  function BitWriter() { this.bytes = []; this.acc = 0; this.nbits = 0; }
  BitWriter.prototype.write = function (value, nbits) {
    this.acc |= value << this.nbits;
    this.nbits += nbits;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  };
  BitWriter.prototype.flush = function () {
    if (this.nbits > 0) {
      this.bytes.push(this.acc & 0xff);
      this.acc = 0;
      this.nbits = 0;
    }
  };

  /* 固定哈夫曼 deflate (RFC1951), 单块 final, 无滑动窗口压缩, 数据较小时完全合法 */
  function deflateFixed(data) {
    const bw = new BitWriter();
    bw.write(1, 1); // BFINAL
    bw.write(1, 2); // BTYPE=01 fixed Huffman
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v <= 143) {
        bw.write(reverseBits(0x30 + v, 8), 8);
      } else {
        bw.write(reverseBits(0x190 + (v - 144), 9), 9);
      }
    }
    bw.write(reverseBits(0, 7), 7); // EOB symbol 256
    bw.flush();
    return new Uint8Array(bw.bytes);
  }

  function reverseBits(v, n) {
    let r = 0;
    for (let i = 0; i < n; i++) { r = (r << 1) | (v & 1); v >>= 1; }
    return r;
  }

  function u32be(v) { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }

  function chunk(type, data) {
    const len = u32be(data.length);
    const typeBytes = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
    const body = new Uint8Array(typeBytes.length + data.length);
    body.set(typeBytes, 0);
    body.set(data, typeBytes.length);
    const crc = u32be(crc32(body));
    const out = new Uint8Array(len.length + body.length + crc.length);
    out.set(len, 0);
    out.set(body, len.length);
    out.set(crc, len.length + body.length);
    return out;
  }

  function concat(arrs) {
    let n = 0;
    for (const a of arrs) n += a.length;
    const out = new Uint8Array(n);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  }

  /* rgba: Uint8ClampedArray/Uint8Array, filter 0 逐行, zlib 包装 (CMF/FLG + deflate + adler) */
  function encodePNG(width, height, rgba) {
    const raw = new Uint8Array((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (width * 4 + 1)] = 0;
      raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
    }
    const comp = deflateFixed(raw);
    const zlib = new Uint8Array(comp.length + 6);
    zlib[0] = 0x78; zlib[1] = 0x01;
    zlib.set(comp, 2);
    const adler = adler32(raw);
    zlib[zlib.length - 4] = (adler >>> 24) & 255;
    zlib[zlib.length - 3] = (adler >>> 16) & 255;
    zlib[zlib.length - 2] = (adler >>> 8) & 255;
    zlib[zlib.length - 1] = adler & 255;

    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = new Uint8Array([
      ...u32be(width), ...u32be(height),
      8,   // bit depth
      6,   // color type RGBA
      0, 0, 0
    ]);
    return concat([
      sig,
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib),
      chunk('IEND', new Uint8Array(0))
    ]);
  }

  return { encodePNG, crc32, adler32 };
});
