#!/usr/bin/env node
/* 命令行辅助: 无头渲染投影机输出与模拟相机合成, 导出 PNG / 校正网格 / 报告。
   图形界面 index.html 是主要入口, CLI 仅用于批量导出与自动验证。 */
'use strict';

const fs = require('fs');
const path = require('path');
const V = require('../src/vecmath.js');
const Scene = require('../src/scene.js');
const Proj = require('../src/projector.js');
const { Renderer, buildCalibrationMesh, renderWarpedGrid } = require('../src/render.js');
const { encodePNG } = require('../src/png.js');
const { getPreset, QUALITY } = require('../src/presets.js');

function parseArgs(argv) {
  const args = { _: [], number: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

function usage() {
  return [
    '用法: node cli/mpm-cli.js --preset <folded|lcorner|flat> --out <目录> [选项]',
    '选项:',
    '  --preset <id>       场景预设 (默认 folded)',
    '  --out <dir>         输出目录 (默认 ./mpm-out)',
    '  --quality <q>       draft|standard|fine (默认 standard)',
    '  --pattern <p>       grid-gradient|grid|gradient|checker',
    '  --gamma <g>         显示编码 gamma (默认 2.2)',
    '  --aligned           使用校正后的投影机位姿 (仅 folded 预设)',
    '  --mesh-cols <n>     校正网格列数 (默认 12)',
    '  --mesh-rows <n>     校正网格行数 (默认 8)',
    '  --selftest          运行内置数值自检后退出',
    '  --help              显示本帮助'
  ].join('\n');
}

function writePNG(file, width, height, rgba) {
  fs.writeFileSync(file, Buffer.from(encodePNG(width, height, rgba)));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }

  if (args.selftest) return selftest();

  const presetId = args.preset || 'folded';
  const quality = QUALITY[args.quality] ? args.quality : 'standard';
  const pattern = args.pattern || 'grid-gradient';
  const gamma = args.gamma ? parseFloat(args.gamma) : 2.2;
  const outDir = path.resolve(args.out || 'mpm-out');
  const aligned = !!args.aligned;
  const meshCols = parseInt(args['mesh-cols'] || '12', 10);
  const meshRows = parseInt(args['mesh-rows'] || '8', 10);

  if (!['folded', 'lcorner', 'flat'].includes(presetId)) {
    console.error('错误: 未知预设 "' + presetId + '"');
    process.exit(2);
  }
  if (!(gamma > 0)) {
    console.error('错误: gamma 必须为正数');
    process.exit(2);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const preset = getPreset(presetId, quality);
  if (aligned && preset.correctPoses) {
    for (const pj of preset.projectors) {
      const fix = preset.correctPoses[pj.id];
      if (fix) Proj.setPose(pj, fix.pos, fix.target);
    }
    preset.deviated = null;
  }

  const scene = Scene.buildScene(preset.corners, preset.height);
  const projectors = preset.projectors.map(Proj.createProjector);
  const camera = Proj.createCamera(preset.camera);

  const renderer = new Renderer();
  let result;
  try {
    result = renderer.renderAll({ scene, projectors, camera, pattern, gamma, blendGamma: 1 });
  } catch (e) {
    console.error('渲染失败: ' + e.message);
    process.exit(1);
  }

  projectors.forEach((pj, k) => {
    const out = result.pjOutputs[k];
    writePNG(path.join(outDir, pj.id + '-output.png'), pj.width, pj.height, out.rgba);
    const warp = renderWarpedGrid(pj, result.pjGeo[k], gamma);
    writePNG(path.join(outDir, pj.id + '-warp-grid.png'), pj.width, pj.height, warp.rgba);
    const mesh = buildCalibrationMesh(scene, pj, meshCols, meshRows);
    fs.writeFileSync(path.join(outDir, pj.id + '-calibration.json'), JSON.stringify(mesh, null, 2));
  });
  writePNG(path.join(outDir, 'composite.png'), camera.width, camera.height, result.composite.rgba);

  const s = result.composite.stats;
  const report = {
    preset: presetId, quality, pattern, gamma, aligned,
    walls: scene.walls.length,
    projectors: projectors.map((p, k) => ({
      id: p.id, name: p.name,
      coverage: Number(result.pjGeo[k].coverage.toFixed(4)),
      clippedPixels: countClip(result.pjOutputs[k])
    })),
    composite: {
      coverage: Number(s.coverage.toFixed(4)),
      uncoveredPixels: s.uncovered,
      wallPixels: s.wallPixels,
      overlapPixels: s.overlapPixels,
      meanErrorLinear: Number(s.meanError.toFixed(5)),
      seamErrorLinear: Number(s.seamError.toFixed(5)),
      maxErrorLinear: Number(s.maxError.toFixed(5)),
      misRegPx: Number(s.misRegPx.toFixed(3)),
      misRegPxMax: Number(s.misRegPxMax.toFixed(3))
    },
    deviatedProjector: preset.deviated || null
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log('已导出到 ' + outDir);
  console.log(JSON.stringify(report.composite, null, 2));
  if (preset.deviated) {
    console.warn('提示: 投影机 ' + preset.deviated + ' 处于偏差位姿, 可在图形界面拖动标定或使用 --aligned 对照');
  }
}

function countClip(out) {
  let n = 0;
  for (let i = 0; i < out.clip.length; i += 3) {
    if (out.clip[i] || out.clip[i + 1] || out.clip[i + 2]) n++;
  }
  return n;
}

/* 数值自检: 验证几何往返、融合归一化、线性叠加不超亮、遮挡剔除 */
function selftest() {
  const preset = getPreset('folded', 'draft');
  const scene = Scene.buildScene(preset.corners, preset.height);
  let failures = 0;
  function check(name, cond, detail) {
    if (cond) console.log('  PASS ' + name);
    else { failures++; console.error('  FAIL ' + name + (detail ? ' -> ' + detail : '')); }
  }

  // 1. UV 往返
  const p = Scene.worldFromUV(scene, 1, 0.3, 0.7);
  const uv = Scene.uvFromWorld(scene, 1, p);
  check('墙面 UV 往返', Math.abs(uv.u - 0.3) < 1e-9 && Math.abs(uv.v - 0.7) < 1e-9);

  // 2. 内容坐标在墙角连续
  const c0 = Scene.contentUV(scene, 0, 1, 0.5);
  const c1 = Scene.contentUV(scene, 1, 0, 0.5);
  check('墙角内容坐标连续', Math.abs(c0.cu - c1.cu) < 1e-9 && Math.abs(c0.cv - c1.cv) < 1e-9);

  // 2b. 遮挡/背面剔除: 墙面法线背面的点不可见, 法线正面近距离点可见
  const w0 = scene.walls[0];
  const mid = [
    w0.p0[0] + w0.uAxis[0] * w0.len * 0.5,
    1.5,
    w0.p0[2] + w0.uAxis[2] * w0.len * 0.5
  ];
  const nearEye = [
    mid[0] + w0.normal[0] * 1.2, 1.5, mid[2] + w0.normal[2] * 1.2
  ];
  const backPoint = [mid[0] - w0.normal[0] * 1.2, 1.5, mid[2] - w0.normal[2] * 1.2];
  check('墙面背面点被遮挡剔除', Scene.isVisible(scene, nearEye, backPoint) === false);
  const frontPoint = mid; // 墙面中点本身
  check('墙面正面点可见', Scene.isVisible(scene, nearEye, frontPoint) === true);

  // 3. 投影机像素射线 -> 命中 -> 反投影像素 往返
  const pj = Proj.createProjector(preset.projectors[0]);
  const ray = Proj.rayForPixel(pj, pj.width / 2 | 0, pj.height / 2 | 0);
  const hit = Scene.raycastWall(scene, ray.origin, ray.dir);
  check('中心射线命中墙面', !!hit);
  if (hit) {
    const back = Proj.projectPoint(pj, hit.point);
    const px = Proj.ndcToPixel(pj, back.ndcX, back.ndcY);
    check('反投影像素往返', Math.hypot(px.x - pj.width / 2, px.y - pj.height / 2) < 1.5,
      JSON.stringify(px));
  }

  // 4. 融合权重在 [0,1] 且羽化带外为 1, 画面边缘为 0
  check('边缘权重范围', Proj.edgeWeight(pj, -1, 0) === 0 &&
    Proj.edgeWeight(pj, 1, 0) === 0 && Proj.edgeWeight(pj, 0.5, 0.5) === 1 &&
    Proj.edgeWeight(pj, 0.99, 0.5) < 1);

  // 5. 完整渲染: 合成线性亮度不超过参考+容差, 平均误差小 (对齐后)
  for (const p2 of preset.projectors) {
    const fix = preset.correctPoses[p2.id];
    if (fix) Proj.setPose(p2, fix.pos, fix.target);
  }
  const projectors = preset.projectors.map(Proj.createProjector);
  const camera = Proj.createCamera(preset.camera);
  const renderer = new Renderer();
  // 亮度/融合数值检查使用平滑渐变 (格线用于目视检查错位, 其高对比边缘的有限分辨率误差不纳入)
  const r = renderer.renderAll({ scene, projectors, camera, pattern: 'gradient', gamma: 2.2, blendGamma: 1 });
  const st = r.composite.stats;
  check('墙面口径合成覆盖率 > 95%', st.coverage > 0.95, st.coverage.toFixed(3));
  check('对齐后平均重建误差 < 0.02', st.meanError < 0.02, st.meanError.toFixed(4));
  check('对齐后接缝误差 < 0.02', st.seamError < 0.02, st.seamError.toFixed(4));
  check('存在重叠融合像素', st.overlapPixels > 100, String(st.overlapPixels));
  let overBright = 0;
  for (let i = 0; i < r.composite.lin.length; i += 4) {
    if (r.composite.lin[i + 3] === 0) continue;
    const ri = (i / 4) * 3;
    for (let k = 0; k < 3; k++) {
      if (r.composite.lin[i + k] > r.composite.reference[ri + k] + 0.02) overBright++;
    }
  }
  check('重叠区无叠加过亮', overBright === 0, overBright + ' 通道');

  // 6. 偏差位姿确实产生更大的几何标定残差 (重叠区投影像素错位)
  const devPreset = getPreset('folded', 'draft');
  const devScene = Scene.buildScene(devPreset.corners, devPreset.height);
  const devPJ = devPreset.projectors.map(Proj.createProjector);
  const r2 = new Renderer().renderAll({
    scene: devScene, projectors: devPJ,
    camera: Proj.createCamera(devPreset.camera), pattern: 'gradient', gamma: 2.2, blendGamma: 1
  });
  check('对齐后标定残差 < 1 像素', st.misRegPx < 1, st.misRegPx.toFixed(3) + ' px');
  check('偏差位姿标定残差显著增大', r2.composite.stats.misRegPx > st.misRegPx * 2,
    r2.composite.stats.misRegPx.toFixed(3) + ' vs ' + st.misRegPx.toFixed(3) + ' px');

  // 7. 范围外像素 alpha 标记为 0
  const out0 = r.pjOutputs[0];
  let transparent = 0;
  for (let i = 3; i < out0.rgba.length; i += 4) if (out0.rgba[i] === 0) transparent++;
  check('范围外像素显式透明标记', transparent > 0);

  if (failures) { console.error('\n自检失败: ' + failures + ' 项'); process.exit(1); }
  console.log('\n全部自检通过');
}

main();
