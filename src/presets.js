/* 预设场景与渲染配置 (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MPM = Object.assign(root.MPM || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const QUALITY = {
    draft: { pjWidth: 280, camWidth: 420 },
    standard: { pjWidth: 420, camWidth: 640 },
    fine: { pjWidth: 600, camWidth: 900 }
  };

  const FEATHER = { left: 0.14, right: 0.14, bottom: 0.1, top: 0.1 };

  function pjAspect(width) {
    return { width, height: Math.round(width * 3 / 4) };
  }
  function camAspect(width) {
    return { width, height: Math.round(width * 0.75) };
  }

  /* 默认: 三面折墙, 相邻投影在墙角两侧形成重叠带; PJ3 存在安装位置偏差 */
  function foldedWalls(pjWidth, camWidth, misaligned) {
    const p = pjAspect(pjWidth), c = camAspect(camWidth);
    const corners = [[-6, 0], [-2, 0], [2, 0.6], [6, 0]];
    const height = 3;
    const projectors = [
      {
        id: 'pj1', name: '投影机 1', fovY: 50,
        pos: [-4, 1.7, 3.6], target: [-2.6, 1.5, 0.15],
        gain: 1, rgb: [1, 1, 1], feather: Object.assign({}, FEATHER)
      },
      {
        id: 'pj2', name: '投影机 2', fovY: 50,
        pos: [0, 1.7, 4.2], target: [0, 1.5, 0.35],
        gain: 1, rgb: [1, 1, 1], feather: Object.assign({}, FEATHER)
      },
      {
        id: 'pj3', name: '投影机 3(偏差)', fovY: 50,
        // 正确位姿: pos [4,1.7,3.4], target [2.6,1.5,0.2]; 偏差机横向/纵深/俯仰均明显错位
        pos: misaligned === false ? [4, 1.7, 3.4] : [5.6, 1.3, 2.2],
        target: misaligned === false ? [2.6, 1.5, 0.2] : [3.2, 2.0, 0.6],
        gain: 1, rgb: [1, 1, 1], feather: Object.assign({}, FEATHER)
      }
    ].map((s) => Object.assign(s, p));

    const camera = Object.assign({
      id: 'cam', name: '模拟相机', fovY: 50,
      pos: [0, 1.6, 7.5], target: [0, 1.45, 0.2], up: [0, 1, 0]
    }, c);

    return {
      id: 'folded',
      name: '折角三墙 · 重叠融合(含位置偏差)',
      corners, height, projectors, camera,
      deviated: misaligned !== false ? 'pj3' : null,
      correctPoses: {
        pj3: { pos: [4, 1.7, 3.4], target: [2.6, 1.5, 0.2] }
      }
    };
  }

  /* L 形墙角: 两台机分别覆盖两面墙, 检查墙角处连续内容是否对齐 */
  function lCorner(pjWidth, camWidth) {
    const p = pjAspect(pjWidth), c = camAspect(camWidth);
    const corners = [[-4, 0], [0, 0], [0, 4]];
    const height = 3;
    const projectors = [
      {
        id: 'pj1', name: '投影机 1', fovY: 62,
        pos: [-2.2, 1.6, 3.4], target: [-2.0, 1.5, 0.2],
        gain: 1, rgb: [1, 1, 1], feather: Object.assign({}, FEATHER)
      },
      {
        // wall1 法线朝 -x (折线内侧), 投影机必须位于 x<0 一侧, 否则只能打到墙面背面
        id: 'pj2', name: '投影机 2', fovY: 62,
        pos: [-3.4, 1.6, 2.2], target: [-0.2, 1.5, 2.0],
        gain: 1, rgb: [1, 1, 1], feather: Object.assign({}, FEATHER)
      }
    ].map((s) => Object.assign(s, p));
    const camera = Object.assign({
      id: 'cam', name: '模拟相机', fovY: 62,
      pos: [-3.4, 1.9, 5.8], target: [-0.9, 1.4, 1.1], up: [0, 1, 0]
    }, c);
    return { id: 'lcorner', name: 'L 形墙角 · 墙角连续性', corners, height, projectors, camera, deviated: null };
  }

  /* 平面双机: 宽幅平面墙, 两台投影机大范围重叠, 专门检查接缝亮度 */
  function flatDual(pjWidth, camWidth) {
    const p = pjAspect(pjWidth), c = camAspect(camWidth);
    const corners = [[-6, 0], [6, 0]];
    const height = 3;
    const projectors = [
      {
        id: 'pj1', name: '投影机 1', fovY: 56,
        pos: [-2.6, 1.7, 4.6], target: [-1.7, 1.5, 0],
        gain: 1, rgb: [1, 1, 1], feather: Object.assign({}, FEATHER)
      },
      {
        id: 'pj2', name: '投影机 2', fovY: 56,
        pos: [2.6, 1.7, 4.6], target: [1.7, 1.5, 0],
        gain: 1, rgb: [1, 1, 1], feather: Object.assign({}, FEATHER)
      }
    ].map((s) => Object.assign(s, p));
    const camera = Object.assign({
      id: 'cam', name: '模拟相机', fovY: 40,
      pos: [0, 1.7, 9.5], target: [0, 1.5, 0], up: [0, 1, 0]
    }, c);
    return { id: 'flat', name: '平面双机 · 接缝亮度', corners, height, projectors, camera, deviated: null };
  }

  function getPreset(id, quality) {
    const q = QUALITY[quality] || QUALITY.standard;
    if (id === 'lcorner') return lCorner(q.pjWidth, q.camWidth);
    if (id === 'flat') return flatDual(q.pjWidth, q.camWidth);
    return foldedWalls(q.pjWidth, q.camWidth, true);
  }

  return { QUALITY, getPreset, foldedWalls, lCorner, flatDual, FEATHER };
});
