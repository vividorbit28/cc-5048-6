/* 多面展墙投影映射 - 向量与几何基础 (UMD, 零依赖) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MPM = Object.assign(root.MPM || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }
  function length(a) { return Math.hypot(a[0], a[1], a[2]); }
  function normalize(a) {
    const l = length(a) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  }
  function lerp(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* 右手系正交基: forward 指向画面/墙面, x 右, y 上, 视线沿 -z 方向 (相机约定) */
  function basis(forward, upHint) {
    const z = normalize(scale(forward, -1)); // 相机后方
    const u = upHint || [0, 1, 0];
    let x = cross(u, z);
    if (length(x) < 1e-8) x = cross([0, 0, 1], z);
    x = normalize(x);
    const y = cross(z, x);
    return { x, y, z };
  }

  return { add, sub, scale, dot, cross, length, normalize, lerp, clamp, basis };
});
