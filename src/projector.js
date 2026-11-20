/* 虚拟投影机与模拟相机: 针孔模型、像素射线、羽化融合权重 (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./vecmath.js'));
  } else root.MPM = Object.assign(root.MPM || {}, factory(root.MPM));
})(typeof self !== 'undefined' ? self : this, function (V) {
  'use strict';

  /*
   * spec: {
   *   id, name, pos:[x,y,z], target:[x,y,z], up:[...],
   *   fovY: 垂直视场角(度), width, height: 输出像素,
   *   gain: 亮度增益(颜色补偿), rgb:[r,g,b] 通道增益,
   *   feather: {left,right,bottom,top} 四边羽化带占画面比例
   * }
   */
  function createProjector(spec) {
    const fovY = spec.fovY || 40;
    const width = spec.width || 1024;
    const height = spec.height || 768;
    const p = {
      id: spec.id,
      name: spec.name || spec.id || 'PJ',
      pos: spec.pos.slice(),
      target: spec.target.slice(),
      up: (spec.up || [0, 1, 0]).slice(),
      fovY,
      width,
      height,
      gain: spec.gain == null ? 1 : spec.gain,
      rgb: (spec.rgb || [1, 1, 1]).slice(),
      feather: Object.assign({ left: 0.12, right: 0.12, bottom: 0.12, top: 0.12 }, spec.feather || {}),
      // 带裁边的投影遮罩: 画面四边被硬裁掉的比例 (0..0.5), 裁掉区域遮盖 m=0, 属于几何性覆盖损失
      maskCrop: Object.assign({ left: 0, right: 0, bottom: 0, top: 0 }, spec.maskCrop || {}),
      // 调光系数 (线性光): 设备仍在投影, 只是变暗; 必须保留在融合分母里, 不触发权重重归一
      dim: spec.dim == null ? 1 : spec.dim,
      // 信号开关: false = 只切断信号, 该路完全不贡献并从分母剔除, 其余各机按有效权重重新归一
      signal: spec.signal !== false,
      _basis: null
    };
    updateBasis(p);
    return p;
  }

  function updateBasis(p) {
    const forward = V.normalize(V.sub(p.target, p.pos));
    const b = V.basis(forward, p.up);
    const tanHalfY = Math.tan((p.fovY * Math.PI / 180) / 2);
    const tanHalfX = tanHalfY * (p.width / p.height);
    p._basis = b;
    p._forward = forward;
    p._tanHalfX = tanHalfX;
    p._tanHalfY = tanHalfY;
  }

  function setPose(p, pos, target) {
    if (pos) p.pos = pos.slice();
    if (target) p.target = target.slice();
    updateBasis(p);
  }

  /* 像素 (px,py) -> 世界方向射线, 像素中心采样 */
  function rayForPixel(p, px, py) {
    const ndcX = ((px + 0.5) / p.width) * 2 - 1;
    const ndcY = 1 - ((py + 0.5) / p.height) * 2; // 屏幕上方 ndcY=+1
    const b = p._basis;
    let dir = V.scale(b.z, -1);
    dir = V.add(dir, V.scale(b.x, ndcX * p._tanHalfX));
    dir = V.add(dir, V.scale(b.y, ndcY * p._tanHalfY));
    return { origin: p.pos, dir: V.normalize(dir) };
  }

  /* 世界点 -> 投影机归一化设备坐标, inView 表示是否落在画面内 */
  function projectPoint(p, point) {
    const d = V.sub(point, p.pos);
    const b = p._basis;
    const zc = V.dot(d, b.z); // 相机空间 z (画面在前方时为负)
    if (zc >= -1e-9) return { ndcX: 0, ndcY: 0, depth: zc, inView: false };
    const xc = V.dot(d, b.x);
    const yc = V.dot(d, b.y);
    const ndcX = xc / (-zc * p._tanHalfX);
    const ndcY = yc / (-zc * p._tanHalfY);
    return {
      ndcX, ndcY, depth: -zc,
      inView: ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1
    };
  }

  function ndcToPixel(p, ndcX, ndcY) {
    return {
      x: (ndcX + 1) * 0.5 * p.width,
      y: (1 - ndcY) * 0.5 * p.height
    };
  }

  /* 带裁边的投影遮罩: 落在硬裁边内的画面点被完全遮盖 (m=0), 其余为 1。
     遮罩描述覆盖关系, 与描述融合渐变的羽化带相互独立, 二者相乘得到几何权重。 */
  function maskWeight(p, ndcX, ndcY) {
    const fx = (ndcX + 1) * 0.5; // 0..1
    const fy = (ndcY + 1) * 0.5;
    const m = p.maskCrop;
    if (fx < m.left || fx > 1 - m.right || fy < m.bottom || fy > 1 - m.top) return 0;
    return 1;
  }

  /* 边缘羽化: 返回 0..1 线性权重, 羽化带宽度由 projector.feather 控制 */
  function edgeWeight(p, ndcX, ndcY) {
    const fx = (ndcX + 1) * 0.5; // 0..1
    const fy = (ndcY + 1) * 0.5;
    const f = p.feather;
    function ramp(v, edgeLo, edgeHi) {
      if (edgeLo > 0 && v < edgeLo) return V.clamp(v / edgeLo, 0, 1);
      if (edgeHi > 0 && v > 1 - edgeHi) return V.clamp((1 - v) / edgeHi, 0, 1);
      return 1;
    }
    const wx = ramp(fx, f.left, f.right);
    const wy = ramp(fy, f.bottom, f.top);
    return V.clamp(wx * wy, 0, 1);
  }

  /* 几何覆盖权重: 遮罩裁边 × 羽化带。仅描述该点是否/以何份额被本机几何覆盖,
     不含信号开关与调光——后两者属于有效贡献与亮度, 必须在归一化之后分别处理。 */
  function coverageWeight(p, ndcX, ndcY) {
    const m = maskWeight(p, ndcX, ndcY);
    return m === 0 ? 0 : edgeWeight(p, ndcX, ndcY);
  }

  /* 相机即无增益的投影机 */
  function createCamera(spec) {
    const c = createProjector(Object.assign({ gain: 1, rgb: [1, 1, 1], name: spec.name || 'CAM' }, spec));
    c.isCamera = true;
    return c;
  }

  return { createProjector, createCamera, updateBasis, setPose, rayForPixel, projectPoint, ndcToPixel, edgeWeight, maskWeight, coverageWeight };
});
