#!/usr/bin/env node
/* 界面层自动测试 (jsdom): 验证控件交互、异常提示、导出与状态同步。
   渲染核心的数值正确性由 `npm run selftest` 覆盖。jsdom 仅为开发依赖。 */
'use strict';

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  console.error('请先安装开发依赖: npm install jsdom --save-dev');
  process.exit(2);
}
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'file://' + path.join(root, 'index.html'),
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;
global.window = window;
global.document = window.document;
global.performance = { now: () => Date.now() };
window.performance = global.performance;
window.ImageData = class ImageData {
  constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
};
window.HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy({}, {
    get(t, prop) {
      if (prop === 'canvas') return { width: 0, height: 0 };
      return () => {};
    },
    set() { return true; }
  });
};
const downloads = [];
window.URL.createObjectURL = () => 'blob:stub';
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
window.requestAnimationFrame = (cb) => setTimeout(cb, 0);

for (const rel of [
  'src/vecmath.js', 'src/scene.js', 'src/projector.js', 'src/content.js',
  'src/png.js', 'src/render.js', 'src/presets.js', 'web/audio.js',
  'web/editor.js', 'web/app.js'
]) {
  window.eval(fs.readFileSync(path.join(root, rel), 'utf8'));
}

const M = window.MPM;
const $ = (id) => window.document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));

(async () => {
  await wait(250);
  const App = M.App;
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log('  PASS ' + name); }
    else { fail++; console.error('  FAIL ' + name + (detail ? ' -> ' + detail : '')); }
  };

  check('应用启动并完成首次渲染', !!App.result);
  check('默认三台投影机输出', window.document.querySelectorAll('#pjOutputs canvas').length === 3);
  check('三张校正扭曲网格', window.document.querySelectorAll('#warpGridWrap canvas').length === 3);
  check('初始无异常横幅', $('errorBanner').classList.contains('hidden'));
  check('偏差场景统计含警告级别', /warn|bad/.test($('statsBox').innerHTML));

  $('correctBtn').click();
  await wait(200);
  check('一键校正后偏差卡片消失', !window.document.querySelector('.pj-card.deviated'));
  check('校正后标定残差 < 1 像素', App.result.composite.stats.misRegPx < 1,
    App.result.composite.stats.misRegPx.toFixed(3));

  $('presetSelect').value = 'lcorner'; fire($('presetSelect'), 'change'); await wait(200);
  check('L 形预设两台机', window.document.querySelectorAll('#pjOutputs canvas').length === 2);
  check('L 形三个共享角点', window.document.querySelectorAll('.corner-item').length === 3);

  $('presetSelect').value = 'flat'; fire($('presetSelect'), 'change'); await wait(200);
  check('平面双机存在重叠融合像素', App.result.composite.stats.overlapPixels > 5000);

  $('patternSelect').value = 'checker'; fire($('patternSelect'), 'change'); await wait(200);
  check('切换测试图案无异常', $('errorBanner').classList.contains('hidden'));
  $('gammaRange').value = '2.6'; fire($('gammaRange'), 'input'); await wait(200);
  check('显示 gamma 可调', $('gammaVal').textContent === '2.60');
  $('blendGamma').value = '1.4'; fire($('blendGamma'), 'input'); await wait(200);
  check('融合曲线指数可调', $('blendGammaVal').textContent === '1.40');

  $('pjSelect').value = '0'; fire($('pjSelect'), 'change');
  $('pjGain').value = '1.3'; fire($('pjGain'), 'input'); await wait(250);
  check('过补偿触发裁剪提示', /裁剪/.test($('clipStatus').textContent));
  $('pjGain').value = '1'; fire($('pjGain'), 'input'); await wait(250);
  check('补偿恢复后裁剪消失', /无通道裁剪/.test($('clipStatus').textContent));

  $('fLeft').value = '0.3'; fire($('fLeft'), 'input'); await wait(250);
  check('羽化带同步到全部投影机', App.state.projectors.every((p) => Math.abs(p.feather.left - 0.3) < 1e-9));

  $('presetSelect').value = 'folded'; fire($('presetSelect'), 'change'); await wait(250);
  const ed = App.editor;
  const before = App.state.corners[1].slice();
  const handle = ed._handles().find((h) => h.kind === 'corner' && h.index === 1);
  ed.drag = handle;
  ed._applyDrag(handle, ed._toWorld(handle.x + 40, handle.y - 30));
  App.scheduleRender();
  await wait(250);
  check('俯视拖动改变角点几何', App.state.corners[1][0] !== before[0] || App.state.corners[1][1] !== before[1]);
  check('拖动后渲染保持正常', $('errorBanner').classList.contains('hidden'));

  App.state.corners[1] = App.state.corners[0].slice();
  fire($('wallHeight'), 'input');
  await wait(250);
  check('零长度墙由界面提示异常', !$('errorBanner').classList.contains('hidden') && /零/.test($('errorBanner').textContent));

  $('resetBtn').click();
  await wait(300);
  check('恢复预设后异常消失', $('errorBanner').classList.contains('hidden'));
  check('恢复后三台投影机', window.document.querySelectorAll('#pjOutputs canvas').length === 3);

  $('exportPJBtn').click(); $('exportMeshBtn').click();
  $('exportCompositeBtn').click(); $('exportReportBtn').click();
  await wait(150);
  check('四类导出均触发下载', downloads.length === 4, JSON.stringify(downloads));

  const mesh = M.buildCalibrationMesh(App.scene, App.pjs[0], 12, 8);
  check('校正网格含真实投影像素映射', mesh.points.length > 100 && mesh.points.some((p) => p.inView && p.pixel));

  const png = M.encodePNG(4, 4, new Uint8ClampedArray(64).fill(200));
  check('浏览器侧 PNG 编码可用', png[0] === 137 && png[1] === 80);

  // ---- 新功能: 调暗 / 切断信号 / 遮罩裁边 / 探针 / 帧比较 (在线性平场上验证) ----
  $('presetSelect').value = 'folded'; fire($('presetSelect'), 'change'); await wait(250);
  $('correctBtn').click(); await wait(250);
  $('patternSelect').value = 'flat'; fire($('patternSelect'), 'change'); await wait(250);

  // 找一个三路公共覆盖像素
  const probe0 = App.result.composite.probe;
  let lockIdx = -1;
  for (let i = 0; i < probe0.count.length; i++) {
    if (probe0.count[i] === 3) { lockIdx = i; break; }
  }
  check('平场场景存在三路覆盖点', lockIdx >= 0);
  App.lockedPixel = lockIdx;
  App.updateProbePanel();
  check('探针面板已显示', !$('probeBox').classList.contains('hidden'));
  const baseProbe = M.probeAtPixel(App.result.composite, App.pjs, lockIdx);
  check('探针逐机给出遮盖/分母/份额', baseProbe.projectors.length === 3 &&
    baseProbe.projectors.every((r) => r.covered && r.denominator > 0 && r.share >= 0));

  // 调暗一路: 份额与分母不变, 最终亮度下降, 设备仍有非零输出
  const shareBefore = baseProbe.projectors.map((r) => r.share);
  const lumBefore = baseProbe.final[0];
  $('pjSelect').value = '0'; fire($('pjSelect'), 'change');
  $('pjDim').value = '0.4'; fire($('pjDim'), 'input'); await wait(250);
  const dimProbe = M.probeAtPixel(App.result.composite, App.pjs, lockIdx);
  check('调暗不改份额与分母', dimProbe.projectors.every((r, k) =>
    Math.abs(r.share - shareBefore[k]) < 1e-9 &&
    Math.abs(r.denominator - baseProbe.denominator) < 1e-9));
  // 该点 pj0 份额可能较小, 用与份额成正比的期望衰减量做容差, 而不是固定绝对阈值
  const expectedDrop = lumBefore * shareBefore[0] * 0.6;
  check('调暗使最终亮度按份额下降',
    Math.abs((lumBefore - dimProbe.final[0]) - expectedDrop) < 0.005,
    'drop=' + (lumBefore - dimProbe.final[0]).toFixed(5) + ' expect~' + expectedDrop.toFixed(5));
  check('调暗机仍输出非零线性光',
    App.result.pjOutputs[0].lin.some((v, c) => c % 4 < 3 && v > 0));
  check('调暗不改变覆盖成员数', App.result.composite.probe.count[lockIdx] === 3);

  // 切断同一路信号: 该路份额 0, 其余重新归一到 1, 平场仍还原 0.5
  $('pjSignal').checked = false; fire($('pjSignal'), 'change'); await wait(250);
  const offProbe = M.probeAtPixel(App.result.composite, App.pjs, lockIdx);
  check('切断信号机份额为 0', offProbe.projectors[0].share === 0 && offProbe.projectors[0].signalOn === false);
  check('剩余机份额重新归一',
    Math.abs(offProbe.projectors.slice(1).reduce((a, r) => a + r.share, 0) - 1) < 1e-6);
  check('切断后平场仍无暗带', Math.abs(offProbe.final[0] - 0.5) < 1e-6);
  check('切断信号机输出全黑',
    App.result.pjOutputs[0].lin.every((v, c) => c % 4 === 3 || v === 0));
  // 重新接通 -> 回到与调暗态一致 (成员恢复)
  $('pjSignal').checked = true; fire($('pjSignal'), 'change'); await wait(250);
  const reProbe = M.probeAtPixel(App.result.composite, App.pjs, lockIdx);
  check('信号重新接通后成员恢复为 3', App.result.composite.probe.count[lockIdx] === 3 &&
    Math.abs(reProbe.final[0] - dimProbe.final[0]) < 1e-9);
  $('pjDim').value = '1'; fire($('pjDim'), 'input'); await wait(250);

  // 遮罩裁边: 几何性遮盖, 把原本可达的墙点变成无覆盖 (uncovered 增加); 几何缓存应失效重算
  const uncovBefore = App.result.composite.stats.uncovered;
  $('mLeft').value = '0.3'; fire($('mLeft'), 'input'); await wait(250);
  check('遮罩裁边产生新的无覆盖墙点',
    App.result.composite.stats.uncovered > uncovBefore,
    App.result.composite.stats.uncovered + ' vs ' + uncovBefore);
  // 在被遮区域取点: 探针应能读到某机 covered=false / 权重 0
  let maskedPixel = -1;
  const pm = App.result.composite.probe;
  const K = pm.K;
  outer:
  for (let i = 0; i < pm.count.length; i++) {
    for (let k = 0; k < K; k++) {
      if (pm.mask[i * K + k] === 0 && pm.signal[i * K + k] === 1) { maskedPixel = i; break outer; }
    }
  }
  check('探针可读出被遮机 covered=false', maskedPixel >= 0 &&
    M.probeAtPixel(App.result.composite, App.pjs, maskedPixel).projectors.some((r) => !r.covered));
  $('mLeft').value = '0'; fire($('mLeft'), 'input'); await wait(250);

  // 帧比较: 存基准 -> 调暗 ->  touchedOnly 帧差成员数为 0 (调暗不改覆盖), 但像素亮度有差
  $('frameBaseBtn').click();
  check('参考帧已存储', !!App.referenceFrame);
  $('pjDim').value = '0.3'; fire($('pjDim'), 'input'); await wait(250);
  $('frameDiffBtn').click(); await wait(50);
  const dimDiffText = $('frameDiffOut').textContent;
  check('调暗帧差: 成员变化为 0 且单机覆盖区不受影响',
    /成员变化像素 0/.test(dimDiffText) && /单机覆盖区受影响 0\//.test(dimDiffText), dimDiffText);
  // 切断信号: 成员变化 > 0, 单机覆盖区仍不受影响
  $('pjDim').value = '1'; fire($('pjDim'), 'input'); await wait(250);
  $('pjSignal').checked = false; fire($('pjSignal'), 'change'); await wait(250);
  $('frameDiffBtn').click(); await wait(50);
  const offDiffText = $('frameDiffOut').textContent;
  check('切断帧差: 成员变化 > 0 且单机覆盖区不受影响',
    /成员变化像素 [1-9]/.test(offDiffText) && /单机覆盖区受影响 0\//.test(offDiffText), offDiffText);
  $('pjSignal').checked = true; fire($('pjSignal'), 'change'); await wait(250);

  // 墙角被遮点 / 邻近三路点定位按钮
  $('probeCornerBtn').click(); await wait(50);
  const cornerIdx = App.lockedPixel;
  check('墙角定位到 0 贡献被遮点', cornerIdx >= 0 && App.result.composite.probe.count[cornerIdx] === 0);
  $('probeThreeBtn').click(); await wait(50);
  check('邻近定位到三路贡献点', App.lockedPixel >= 0 &&
    App.result.composite.probe.count[App.lockedPixel] === 3);

  // 新图案可选且无异常
  $('patternSelect').value = 'steps'; fire($('patternSelect'), 'change'); await wait(250);
  check('阶梯灰图案可渲染', $('errorBanner').classList.contains('hidden'));
  $('patternSelect').value = 'flat'; fire($('patternSelect'), 'change'); await wait(250);

  console.log('\n界面测试: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
