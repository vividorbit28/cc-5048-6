/* 连续视觉内容: 格线/渐变/棋盘测试图, 线性光采样与显示编码分离 (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./vecmath.js'));
  } else root.MPM = Object.assign(root.MPM || {}, factory(root.MPM));
})(typeof self !== 'undefined' ? self : this, function (V) {
  'use strict';

  const PATTERNS = ['grid-gradient', 'grid', 'gradient', 'checker'];

  function lin2enc(c, gamma) {
    return Math.pow(V.clamp(c, 0, 1), 1 / gamma);
  }
  function enc2lin(c, gamma) {
    return Math.pow(V.clamp(c, 0, 1), gamma);
  }

  function frac(x) { return x - Math.floor(x); }

  /* 在内容坐标 (cu,cv) 处采样线性 RGB, 内容在折线墙上按累计长度连续延展 */
  function sampleLinear(cu, cv, pattern) {
    cu = V.clamp(cu, 0, 1);
    cv = V.clamp(cv, 0, 1);
    if (pattern === 'gradient') return gradient(cu, cv);
    if (pattern === 'grid') return grid(cu, cv, false);
    if (pattern === 'checker') return checker(cu, cv);
    return grid(cu, cv, true);
  }

  function gradient(cu, cv) {
    // 横向亮度渐变 + 纵向轻微变化, 全部在线性光空间定义
    const g = 0.08 + 0.84 * cu;
    return [g * (0.75 + 0.25 * cv), g * (0.9 + 0.1 * cv), g];
  }

  function nearLine(t, step, width) {
    return frac(t / step) < width / step;
  }

  function grid(cu, cv, withGradient) {
    const base = withGradient ? gradient(cu, cv) : [0.12, 0.12, 0.14];
    const minor = 0.05, major = 0.2;
    const minorLine = nearLine(cu, minor, 0.0035) || nearLine(cv, minor, 0.0035);
    const majorLine = nearLine(cu, major, 0.008) || nearLine(cv, major, 0.008);
    if (majorLine) return [0.95, 0.15, 0.9];      // 品红粗线
    if (minorLine) return [0.1, 0.95, 0.95];      // 青色细线
    // 角点标记: 内容左右边界与上下中线
    if (cu < 0.004 || cu > 0.996) return [1, 0.85, 0.2];
    return base;
  }

  function checker(cu, cv) {
    const n = 12, m = 8;
    const on = (Math.floor(cu * n) + Math.floor(cv * m)) % 2 === 0;
    return on ? [0.9, 0.9, 0.9] : [0.08, 0.08, 0.08];
  }

  /* 生成一张编码后的 RGBA 位图, 用于内容预览/导出 */
  function renderContentImage(width, height, pattern, gamma) {
    gamma = gamma || 2.2;
    const buf = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cu = (x + 0.5) / width;
        const cv = 1 - (y + 0.5) / height;
        const lin = sampleLinear(cu, cv, pattern);
        const i = (y * width + x) * 4;
        buf[i] = Math.round(lin2enc(lin[0], gamma) * 255);
        buf[i + 1] = Math.round(lin2enc(lin[1], gamma) * 255);
        buf[i + 2] = Math.round(lin2enc(lin[2], gamma) * 255);
        buf[i + 3] = 255;
      }
    }
    return buf;
  }

  return { PATTERNS, sampleLinear, renderContentImage, lin2enc, enc2lin };
});
