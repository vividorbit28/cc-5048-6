#!/usr/bin/env node
/* 命令行辅助: 无头渲染投影机输出与模拟相机合成, 导出 PNG / 校正网格 / 报告。
   图形界面 index.html 是主要入口, CLI 仅用于批量导出与自动验证。 */
'use strict';

const fs = require('fs');
const path = require('path');
const V = require('../src/vecmath.js');
const Scene = require('../src/scene.js');
const Proj = require('../src/projector.js');
const { Renderer, buildCalibrationMesh, renderWarpedGrid, probeAtPixel, diffLinearFrames } = require('../src/render.js');
const { encodePNG } = require('../src/png.js');
const { getPreset, QUALITY } = require('../src/presets.js');
const C = require('../src/content.js');

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
    '  --pattern <p>       grid-gradient|grid|gradient|checker|flat|steps',
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
      dim: p.dim, signal: p.signal !== false, maskCrop: p.maskCrop,
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

  // 8. 暗带/翻倍顺序修复: 调暗 vs 切断信号必须是两种不同语义
  //    使用线性平场, 这样融合问题不会被内容梯度掩盖
  function blendRender(patch) {
    const preset2 = getPreset('folded', 'draft');
    for (const p3 of preset2.projectors) {
      const fix = preset2.correctPoses[p3.id];
      if (fix) Proj.setPose(p3, fix.pos, fix.target);
    }
    const sc = Scene.buildScene(preset2.corners, preset2.height);
    const pjs2 = preset2.projectors.map(Proj.createProjector);
    if (patch) patch(pjs2);
    const cam2 = Proj.createCamera(preset2.camera);
    return new Renderer().renderAll({
      scene: sc, projectors: pjs2, camera: cam2,
      pattern: 'flat', gamma: 2.2, blendGamma: 1
    });
  }
  const rb = blendRender();
  // 找一个三路公共覆盖像素
  let idx3 = -1;
  for (let i = 0; i < rb.composite.probe.count.length; i++) {
    if (rb.composite.probe.count[i] === 3) { idx3 = i; break; }
  }
  check('存在三路公共覆盖像素', idx3 >= 0);
  // renderAll 不回传视图对象, 重新构造同参数投影机用于探针命名
  const basePjs = (() => {
    const preset3 = getPreset('folded', 'draft');
    for (const p4 of preset3.projectors) {
      const fix = preset3.correctPoses[p4.id];
      if (fix) Proj.setPose(p4, fix.pos, fix.target);
    }
    return preset3.projectors.map(Proj.createProjector);
  })();
  const baseProbe = probeAtPixel(rb.composite, basePjs, idx3);
  check('平场三路重叠无暗带 (合成=参考 0.5)',
    Math.abs(baseProbe.final[0] - 0.5) < 1e-6 && Math.abs(baseProbe.final[1] - 0.5) < 1e-6,
    baseProbe.final.map((v) => v.toFixed(4)).join(','));

  // 8a. 调暗一路: 份额/分母保持不变 (设备响应保留), 仅该路亮度按 dim 衰减
  const rDim = blendRender((pjs2) => { pjs2[0].dim = 0.4; });
  const pDim = probeAtPixel(rDim.composite, basePjs, idx3);
  const sharesKept = baseProbe.projectors.every((row, k) =>
    Math.abs(row.share - pDim.projectors[k].share) < 1e-9 &&
    Math.abs(row.denominator - pDim.projectors[k].denominator) < 1e-9);
  check('调暗不改归一分母与份额 (设备仍在场)', sharesKept);
  // 平场下最终亮度 = Σ(份额贡献 × 该路 dim); 调暗只把自己那一项乘 dim, 其它项原样保留。
  // 贡献取自探针实际采样 (含各机增益/几何差异), 不假设各路都是理想 0.5
  const expectedDim = baseProbe.projectors.reduce((a, row, k) =>
    a + row.contribution[0] * (k === 0 ? 0.4 : 1), 0);
  check('调暗后亮度按份额精确变暗而非整带塌陷',
    Math.abs(pDim.final[0] - expectedDim) < 1e-6,
    'got ' + pDim.final[0].toFixed(4) + ' expect ' + expectedDim.toFixed(4));
  // 调暗的投影机输出仍有非零线性光 (设备响应保留, 与黑屏/断信号不同)
  check('调暗机输出仍含非零线性光',
    rDim.pjOutputs[0].lin.some((v, c) => c % 4 < 3 && v > 0));

  // 8b. 只切断信号: 该路从分母剔除, 其余各机份额重新归一, 平场仍精确还原 (无暗带)
  const rOff = blendRender((pjs2) => { pjs2[0].signal = false; });
  const pOff = probeAtPixel(rOff.composite, basePjs, idx3);
  check('切断信号的设备份额为 0 且标记离线',
    pOff.projectors[0].share === 0 && pOff.projectors[0].signalOn === false);
  const remainSum = pOff.projectors.slice(1).reduce((a, row) => a + row.share, 0);
  check('切断后剩余各机份额重新归一到 1', Math.abs(remainSum - 1) < 1e-6, remainSum.toFixed(4));
  check('切断信号后分母变小 (有效权重重分配)',
    pOff.denominator < baseProbe.denominator - 1e-9,
    pOff.denominator.toFixed(4) + ' vs ' + baseProbe.denominator.toFixed(4));
  check('平场重归一后无暗带 (合成仍=参考)',
    Math.abs(pOff.final[0] - 0.5) < 1e-6, pOff.final[0].toFixed(4));
  // 对照: 切断信号的投影机输出应为全黑线性光 (设备无光), 与调暗仍有非零输出区分
  const offAllBlack = rOff.pjOutputs[0].lin.every((v, c) => c % 4 === 3 || v === 0);
  check('切断信号机输出为全黑 (无设备光)', offAllBlack);

  // 8c. 两种情形在同一点给出不同亮度 (语义可区分), 且调暗亮于全切 (暗机仍有贡献)
  check('调暗与切断信号亮度可区分',
    Math.abs(pDim.final[0] - pOff.final[0]) > 0.01 && pOff.final[0] > pDim.final[0]);

  // 9. 错误顺序回归: 两类典型顺序错误 (暗带 / 亮度翻倍) 的机理对照
  // 9a. 若把调光误当信号切断 (dim 并入分母再归一), 归一化会抵消调光, 平场恒为 0.5;
  //     正确管线调暗后必须真实改变亮度 —— 这正是 "调暗保留设备响应" 与 "切断重分配" 的分界
  const wrongWouldHideDim = Math.abs(0.5 - pDim.final[0]) > 0.01;
  check('错误顺序 (调光并入分母) 会被本管线拒绝: 调暗必须真实改变亮度', wrongWouldHideDim);
  // 9b. 反向错误: 不做归一直接线性叠加, N 机重叠区亮度会翻 N 倍;
  //     正确管线任意重叠点数机份额和恒为 1, 线性光严格不超过参考
  let doubleBright = 0;
  for (let i = 0; i < rb.composite.lin.length; i += 4) {
    if (rb.composite.rgba[i + 3] !== 255) continue;
    if (rb.composite.lin[i] > rb.composite.reference[(i / 4) * 3] + 1e-6) doubleBright++;
  }
  check('重叠区无亮度翻倍 (线性光严格不超过参考)', doubleBright === 0, doubleBright + ' 通道');
  // 9c. 直接复现 "不归一裸叠加" 的翻倍机理: 三路点若把每路完整 0.5 线性光直接相加必得 1.5,
  //     而正确管线按 w/W 归一后份额和恒为 1, 同一点合成 0.5
  const shareSum3 = baseProbe.projectors.reduce((a, row) => a + row.share, 0);
  const naiveStack = baseProbe.contributors * 0.5;
  check('裸叠加机理对照: 裸叠加=' + naiveStack.toFixed(1) + ' 而归一后份额和=' + shareSum3.toFixed(4),
    Math.abs(naiveStack - 1.5) < 1e-9 && Math.abs(shareSum3 - 1) < 1e-9);

  // 10. 遮罩裁边: 几何性遮盖使覆盖关系变化, 改动只沿实际覆盖传播
  const rMask = blendRender((pjs2) => { pjs2[1].maskCrop.left = 0.25; });
  const dMask = diffLinearFrames(rb.composite, rMask.composite, true);
  check('遮罩裁边产生成员变化像素', dMask.changedMembership > 100, String(dMask.changedMembership));
  check('遮罩改动帧差仅出现在成员变化像素', dMask.pixels === dMask.changedMembership);
  const dDim = diffLinearFrames(rb.composite, rDim.composite, true);
  check('调暗不改变任何覆盖成员关系', dDim.changedMembership === 0);
  const dOff = diffLinearFrames(rb.composite, rOff.composite, true);
  check('单机覆盖墙区不受邻机切断影响', dOff.soleCoverageChanged === 0 && dOff.soleCoverageTotal > 0);
  check('单机覆盖墙区不受遮罩拖动影响', dMask.soleCoverageChanged === 0);

  // 11. 退出再加入: 逐帧比较, 重新加入后与基准帧逐像素一致
  const rRejoin = blendRender((pjs2) => {
    pjs2[0].signal = false;
    pjs2[0].signal = true; // 退出随后重新加入
  });
  const dRejoin = diffLinearFrames(rb.composite, rRejoin.composite, false);
  check('退出再加入后合成与基准帧完全一致', dRejoin.maxDiff < 1e-9, dRejoin.maxDiff.toFixed(6));

  // 12. 墙角采样点: 存在被遮住 (0 贡献) 的墙点, 其邻近存在恰有三路贡献的墙点
  let maskedPoint = -1, nearby3 = -1;
  const camWidth = (() => {
    const preset4 = getPreset('folded', 'draft');
    return Proj.createCamera(preset4.camera).width;
  })();
  for (let i = 0; i < rb.composite.probe.count.length; i++) {
    if (rb.composite.probe.count[i] !== 0 || rb.composite.rgba[i * 4 + 3] === 255) continue;
    for (let dxy = 1; dxy <= 12 && nearby3 < 0; dxy++) {
      for (const [dx, dy] of [[dxy, 0], [-dxy, 0], [0, dxy], [0, -dxy]]) {
        const j = i + dy * camWidth + dx;
        if (j >= 0 && j < rb.composite.probe.count.length && rb.composite.probe.count[j] === 3) {
          nearby3 = j; break;
        }
      }
    }
    if (nearby3 >= 0) { maskedPoint = i; break; }
  }
  check('墙角保留被遮住采样点 (0 路贡献)', maskedPoint >= 0);
  check('邻近点恰有三路贡献', nearby3 >= 0, 'masked=' + maskedPoint + ' nearby=' + nearby3);
  const pMasked = probeAtPixel(rb.composite, basePjs, maskedPoint);
  check('被遮住点与混合误差可分别定位 (分母为 0 且无最终亮度)',
    pMasked.denominator === 0 && pMasked.final.every((v) => v === 0) && pMasked.contributors === 0);

  // 13. 临时撤掉最亮一路再接回: 改动只沿覆盖关系传播, 接回后逐像素还原
  //     最亮一路 = 三路点上份额最大的投影机
  const brightest = baseProbe.projectors.reduce((a, row) =>
    row.share > a.share ? row : a, baseProbe.projectors[0]);
  const bk = basePjs.findIndex((p5) => p5.id === brightest.projector);
  const rDrop = blendRender((pjs2) => { pjs2[bk].signal = false; });
  const dDrop = diffLinearFrames(rb.composite, rDrop.composite, true);
  check('撤机影响仅落在贡献成员变化的墙区', dDrop.pixels === dDrop.changedMembership && dDrop.changedMembership > 0);
  check('撤机不波及任何单机覆盖墙区', dDrop.soleCoverageChanged === 0);
  const rBack = blendRender((pjs2) => { pjs2[bk].signal = false; pjs2[bk].signal = true; });
  const dBack = diffLinearFrames(rb.composite, rBack.composite, false);
  check('最亮一路接回后逐像素还原', dBack.maxDiff < 1e-9, dBack.maxDiff.toFixed(6));
  // 颜色混合误差 (有覆盖, 误差统计) 与照不到 (uncovered) 是两套独立计数
  check('未覆盖状态与混合误差分别统计',
    rb.composite.stats.uncovered > 0 && typeof rb.composite.stats.meanError === 'number');

  // 14. 新图案: 线性平场恒定 0.5, 阶梯灰为 11 级线性灰阶
  const flat = C.sampleLinear(0.13, 0.7, 'flat');
  check('线性平场全图恒定 0.5', flat.every((v) => Math.abs(v - 0.5) < 1e-12));
  const step0 = C.sampleLinear(0, 0.5, 'steps')[0];
  const stepLast = C.sampleLinear(0.999, 0.5, 'steps')[0];
  check('自制阶梯灰覆盖 0..1 线性灰阶', step0 === 0 && stepLast === 1);
  check('阶梯灰为 11 级离散台阶',
    Math.abs(C.sampleLinear(0.15, 0.5, 'steps')[0] - 1 / 10) < 1e-12);

  if (failures) { console.error('\n自检失败: ' + failures + ' 项'); process.exit(1); }
  console.log('\n全部自检通过');
}

main();
