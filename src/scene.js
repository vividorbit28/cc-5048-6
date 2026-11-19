/* 场景: 多面展墙 (共享角点的折线墙)、墙面内容坐标、射线求交 (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./vecmath.js'));
  } else root.MPM = Object.assign(root.MPM || {}, factory(root.MPM));
})(typeof self !== 'undefined' ? self : this, function (V) {
  'use strict';

  /*
   * corners: 俯视折线上的共享角点 [[x,z], ...] (单位: 米), y=0 为地面
   * height : 墙高
   * 相邻两个角点构成一面墙 wall i = corners[i] -> corners[i+1]
   * 每面墙局部 u: 沿角点方向 0..1, v: 自下而上 0..1
   * 连续内容坐标: contentU 在整段折线上按墙长比例累计
   */
  function buildScene(corners, height) {
    const walls = [];
    let cum = 0;
    for (let i = 0; i < corners.length - 1; i++) {
      const a = corners[i], b = corners[i + 1];
      const p0 = [a[0], 0, a[1]];
      const p1 = [b[0], 0, b[1]];
      const pTop = [b[0], height, b[1]];
      const along = V.sub(p1, p0);
      const wlen = V.length(along);
      const uAxis = V.scale(along, 1 / wlen);
      const yAxis = [0, 1, 0];
      const normal = V.normalize(V.cross(uAxis, yAxis)); // 墙面正面法线
      walls.push({
        index: i,
        p0, p1, pTop,
        uAxis,
        normal,
        len: wlen,
        height,
        contentStart: cum,
        contentEnd: cum + wlen
      });
      cum += wlen;
    }
    return { corners: corners.map((c) => c.slice()), height, walls, totalLen: cum };
  }

  function worldFromUV(scene, wi, u, v) {
    const w = scene.walls[wi];
    const p = V.add(w.p0, V.scale(w.uAxis, u * w.len));
    p[1] = v * w.height;
    return p;
  }

  function uvFromWorld(scene, wi, p) {
    const w = scene.walls[wi];
    const d = V.sub(p, w.p0);
    return {
      u: V.dot(d, w.uAxis) / w.len,
      v: p[1] / w.height
    };
  }

  function contentUV(scene, wi, u, v) {
    const w = scene.walls[wi];
    return {
      cu: (w.contentStart + u * w.len) / scene.totalLen,
      cv: v
    };
  }

  /* 射线与所有墙面求交, 返回最近的正面命中 (背面/自遮挡判定依赖 dot(rayDir, normal)<0) */
  function raycastWall(scene, origin, dir) {
    let best = null;
    for (const w of scene.walls) {
      const denom = V.dot(dir, w.normal);
      if (denom >= -1e-9) continue; // 与墙面平行或打在背面
      const t = V.dot(V.sub(w.p0, origin), w.normal) / denom;
      if (t <= 1e-6) continue;
      const hit = V.add(origin, V.scale(dir, t));
      const d = V.sub(hit, w.p0);
      const u = V.dot(d, w.uAxis) / w.len;
      const v = hit[1] / w.height;
      if (u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) continue;
      if (!best || t < best.t) {
        best = {
          wall: w.index,
          t,
          point: hit,
          u: V.clamp(u, 0, 1),
          v: V.clamp(v, 0, 1)
        };
      }
    }
    return best;
  }

  /* 从某观察点看场景点是否可见 (无其它墙面遮挡); 容差按厘米尺度, 容忍斜射量化 */
  function isVisible(scene, eye, point) {
    const dir = V.normalize(V.sub(point, eye));
    const hit = raycastWall(scene, eye, dir);
    if (!hit) return false;
    return V.length(V.sub(hit.point, point)) < 0.01;
  }

  return { buildScene, worldFromUV, uvFromWorld, contentUV, raycastWall, isVisible };
});
