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

  console.log('\n界面测试: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
