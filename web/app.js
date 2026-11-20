/* 主应用: 状态管理、实时渲染、控件绑定、导出与异常提示 */
(function (root) {
  'use strict';
  const M = root.MPM;
  const $ = (id) => document.getElementById(id);

  const App = {
    state: null,
    renderer: new M.Renderer(),
    result: null,
    selectedPJ: 0,
    pattern: 'grid-gradient',
    gamma: 2.2,
    blendGamma: 1,
    quality: 'standard',
    renderTimer: null,
    editor: null,
    audio: new M.SpatialAudio(),
    lockedPixel: -1,
    referenceFrame: null
  };

  /* ---------- 初始化与状态 ---------- */
  function loadPreset(id, quality) {
    const preset = M.getPreset(id, quality);
    App.state = {
      presetId: id,
      corners: preset.corners.map((c) => c.slice()),
      height: preset.height,
      projectors: preset.projectors.map((p) => {
        const copy = JSON.parse(JSON.stringify(p));
        // 控件直接读写 state, 这里补齐与 createProjector 一致的默认融合/遮罩/调光字段
        copy.maskCrop = Object.assign({ left: 0, right: 0, bottom: 0, top: 0 }, copy.maskCrop || {});
        if (copy.dim == null) copy.dim = 1;
        if (copy.signal == null) copy.signal = true;
        copy.feather = Object.assign({ left: 0.12, right: 0.12, bottom: 0.12, top: 0.12 }, copy.feather || {});
        return copy;
      }),
      camera: JSON.parse(JSON.stringify(preset.camera)),
      deviated: preset.deviated,
      correctPoses: preset.correctPoses ? JSON.parse(JSON.stringify(preset.correctPoses)) : null
    };
    App.selectedPJ = 0;
    App.lockedPixel = -1;
    App.referenceFrame = null;
    App.renderer.signature = '';
  }

  function buildScene() {
    return M.buildScene(App.state.corners, App.state.height);
  }
  function buildViews() {
    const pjs = App.state.projectors.map(M.createProjector);
    const cam = M.createCamera(App.state.camera);
    return { pjs, cam };
  }

  /* ---------- 渲染调度 ---------- */
  function scheduleRender(immediate) {
    clearTimeout(App.renderTimer);
    setStatus('计算中…');
    const run = () => {
      const t0 = performance.now();
      try {
        const scene = buildScene();
        const { pjs, cam } = buildViews();
        M.validateScene(scene).concat(M.validateProjectors(scene, pjs));
        App.result = App.renderer.renderAll({
          scene, projectors: pjs, camera: cam,
          pattern: App.pattern, gamma: App.gamma, blendGamma: App.blendGamma
        });
        App.scene = scene; App.pjs = pjs; App.cam = cam;
        hideError();
        present(t0);
      } catch (e) {
        showError(e.message);
        setStatus('几何异常, 已暂停渲染');
      }
    };
    if (immediate) run();
    else App.renderTimer = setTimeout(run, 60);
  }

  /* ---------- 结果呈现 ---------- */
  function present(t0) {
    drawProjectorCards();
    drawComposite();
    drawWarpGrids();
    drawSeamChart();
    updateStats();
    updateClipStatus();
    updateProbePanel();
    App.editor.draw(App.result);
    syncFormValues();
    $('perfText').textContent = '渲染耗时 ' + Math.round(performance.now() - t0) + ' ms';
    setStatus('就绪');
  }

  function blit(canvas, rgba, w, h) {
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = new ImageData(new Uint8ClampedArray(rgba), w, h);
    ctx.putImageData(img, 0, 0);
  }

  function drawProjectorCards() {
    const wrap = $('pjOutputs');
    wrap.innerHTML = '';
    App.pjs.forEach((pj, k) => {
      const out = App.result.pjOutputs[k];
      const card = document.createElement('div');
      card.className = 'pj-card' + (App.state.deviated === pj.id ? ' deviated' : '');
      const cv = document.createElement('canvas');
      blit(cv, out.rgba, pj.width, pj.height);
      const title = document.createElement('h3');
      title.innerHTML = '<span>' + pj.name + '</span><span>' + pj.width + '×' + pj.height + '</span>';
      const meta = document.createElement('div');
      meta.className = 'pj-meta';
      const clip = countClip(out);
      meta.innerHTML = '<span>命中率 ' + pct(App.result.pjGeo[k].coverage) + '</span>' +
        '<span>' + (clip ? '裁剪 ' + clip + ' px' : '无裁剪') + '</span>';
      card.append(title, cv, meta);
      wrap.appendChild(card);
    });
  }

  function drawComposite() {
    const cv = $('compositeCanvas');
    const out = App.result.composite;
    blit(cv, out.rgba, App.cam.width, App.cam.height);
    if (App.lockedPixel >= 0) {
      const ctx = cv.getContext('2d');
      const x = App.lockedPixel % App.cam.width;
      const y = Math.floor(App.lockedPixel / App.cam.width);
      ctx.strokeStyle = '#ffd23f';
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 5, y - 5, 10, 10);
      ctx.beginPath();
      ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y);
      ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8);
      ctx.stroke();
    }
  }

  function drawWarpGrids() {
    const wrap = $('warpGridWrap');
    wrap.innerHTML = '';
    App.pjs.forEach((pj, k) => {
      const warp = M.renderWarpedGrid(pj, App.result.pjGeo[k], App.gamma);
      const cv = document.createElement('canvas');
      blit(cv, warp.rgba, pj.width, pj.height);
      wrap.appendChild(cv);
    });
  }

  function drawSeamChart() {
    const cv = $('seamCanvas');
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    const rows = App.result.composite.stats.seamRows;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (i / 4) * cv.height;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.width, y); ctx.stroke();
    }
    ctx.strokeStyle = '#f5a623';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let started = false;
    rows.forEach((e, y) => {
      const x = (y / rows.length) * cv.width;
      const yy = cv.height - Math.min(1, e * 4) * cv.height;
      if (!started) { ctx.moveTo(x, yy); started = true; } else ctx.lineTo(x, yy);
    });
    ctx.stroke();
    ctx.fillStyle = '#8b97a7';
    ctx.font = '10px sans-serif';
    ctx.fillText('重叠带逐行重建误差 (线性光, ×4 放大)', 6, 13);
  }

  function updateStats() {
    const s = App.result.composite.stats;
    const regWarn = s.misRegPx > 1.5;
    const regBad = s.misRegPx > 4;
    const covWarn = s.coverage < 0.98;
    const items = [
      ['墙面覆盖率', pct(s.coverage), covWarn ? 'warn' : 'good'],
      ['未覆盖像素', s.uncovered + ' / ' + s.wallPixels, s.uncovered ? 'warn' : 'good'],
      ['重叠融合像素', s.overlapPixels, ''],
      ['平均重建误差', s.meanError.toFixed(4), s.meanError > 0.03 ? 'warn' : 'good'],
      ['接缝区误差', s.seamError.toFixed(4), s.seamError > 0.03 ? 'warn' : 'good'],
      ['标定残差(px)', s.misRegPx.toFixed(2), regBad ? 'bad' : regWarn ? 'warn' : 'good'],
      ['最大残差(px)', s.misRegPxMax.toFixed(2), regBad ? 'bad' : ''],
      ['融合 gamma', App.blendGamma.toFixed(2), ''],
      ['显示 gamma', App.gamma.toFixed(2), '']
    ];
    $('statsBox').innerHTML = items.map(([k, v, cls]) =>
      '<div class="stat ' + cls + '"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('');
  }

  function updateClipStatus() {
    const pj = App.pjs[App.selectedPJ];
    const out = App.result.pjOutputs[App.selectedPJ];
    const n = countClip(out);
    const el = $('clipStatus');
    if (n === 0) {
      el.className = 'clip-status good';
      el.textContent = pj.name + ': 无通道裁剪, 颜色补偿在显示范围内';
    } else {
      el.className = 'clip-status bad';
      el.textContent = pj.name + ': ' + n + ' 个像素发生裁剪, 请降低增益/通道补偿, 否则高光处会丢失细节';
    }
  }

  function countClip(out) {
    let n = 0;
    for (let i = 0; i < out.clip.length; i += 3) {
      if (out.clip[i] || out.clip[i + 1] || out.clip[i + 2]) n++;
    }
    return n;
  }

  /* ---------- 表单同步 ---------- */
  function syncFormValues() {
    $('wallHeight').value = App.state.height;
    const pj = App.state.projectors[App.selectedPJ];
    $('pjSelect').innerHTML = App.state.projectors.map((p, i) =>
      '<option value="' + i + '"' + (i === App.selectedPJ ? ' selected' : '') + '>' + p.name + '</option>').join('');
    $('pjPosX').value = pj.pos[0]; $('pjPosY').value = pj.pos[1]; $('pjPosZ').value = pj.pos[2];
    $('pjTgtX').value = pj.target[0]; $('pjTgtY').value = pj.target[1]; $('pjTgtZ').value = pj.target[2];
    $('pjFov').value = pj.fovY; $('pjGain').value = pj.gain;
    $('pjR').value = pj.rgb[0]; $('pjG').value = pj.rgb[1]; $('pjB').value = pj.rgb[2];
    $('pjDim').value = pj.dim; $('pjDimVal').textContent = Number(pj.dim).toFixed(2);
    $('pjSignal').checked = pj.signal !== false;
    const mc = pj.maskCrop;
    $('mLeft').value = mc.left; $('mRight').value = mc.right;
    $('mBottom').value = mc.bottom; $('mTop').value = mc.top;
    $('fLeft').value = pj.feather.left; $('fRight').value = pj.feather.right;
    $('fBottom').value = pj.feather.bottom; $('fTop').value = pj.feather.top;
    const cam = App.state.camera;
    $('camPosX').value = cam.pos[0]; $('camPosY').value = cam.pos[1]; $('camPosZ').value = cam.pos[2];
    $('camTgtX').value = cam.target[0]; $('camTgtY').value = cam.target[1]; $('camTgtZ').value = cam.target[2];
    $('camFov').value = cam.fovY;
    $('cornerList').innerHTML = App.state.corners.map((c, i) =>
      '<div class="corner-item"><b>角点 ' + i + '</b><div class="vals">x=' + c[0].toFixed(2) + ' m, z=' + c[1].toFixed(2) + ' m</div></div>').join('');
  }

  /* ---------- 控件绑定 ---------- */
  function bindControls() {
    $('presetSelect').addEventListener('change', (e) => {
      loadPreset(e.target.value, App.quality);
      App.editor.state = App.state;
      scheduleRender(true);
    });
    $('qualitySelect').addEventListener('change', (e) => {
      App.quality = e.target.value;
      loadPreset($('presetSelect').value, App.quality);
      App.editor.state = App.state;
      scheduleRender(true);
    });
    $('resetBtn').addEventListener('click', () => {
      loadPreset(App.state.presetId, App.quality);
      App.editor.state = App.state;
      scheduleRender(true);
    });
    $('correctBtn').addEventListener('click', () => {
      if (!App.state.correctPoses) { showError('当前场景没有需要校正的偏差投影机'); return; }
      for (const pj of App.state.projectors) {
        const fix = App.state.correctPoses[pj.id];
        if (fix) { pj.pos = fix.pos.slice(); pj.target = fix.target.slice(); }
      }
      App.state.deviated = null;
      scheduleRender();
    });

    // Tabs
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.tab-body').forEach((x) => x.classList.add('hidden'));
      t.classList.add('active');
      $('tab-' + t.dataset.tab).classList.remove('hidden');
    }));

    $('wallHeight').addEventListener('input', (e) => {
      App.state.height = parseFloat(e.target.value) || 0;
      scheduleRender();
    });

    $('pjSelect').addEventListener('change', (e) => {
      App.selectedPJ = parseInt(e.target.value, 10);
      syncFormValues(); updateClipStatus();
    });

    bindNumber('pjPosX', (pj, v) => pj.pos[0] = v);
    bindNumber('pjPosY', (pj, v) => pj.pos[1] = v);
    bindNumber('pjPosZ', (pj, v) => pj.pos[2] = v);
    bindNumber('pjTgtX', (pj, v) => pj.target[0] = v);
    bindNumber('pjTgtY', (pj, v) => pj.target[1] = v);
    bindNumber('pjTgtZ', (pj, v) => pj.target[2] = v);
    bindNumber('pjFov', (pj, v) => pj.fovY = v);
    bindNumber('pjGain', (pj, v) => pj.gain = v);
    bindNumber('pjR', (pj, v) => pj.rgb[0] = v);
    bindNumber('pjG', (pj, v) => pj.rgb[1] = v);
    bindNumber('pjB', (pj, v) => pj.rgb[2] = v);

    $('pjDim').addEventListener('input', (e) => {
      const pj = App.state.projectors[App.selectedPJ];
      pj.dim = Math.max(0, Math.min(1, parseFloat(e.target.value) || 0));
      $('pjDimVal').textContent = pj.dim.toFixed(2);
      scheduleRender();
    });
    $('pjSignal').addEventListener('change', (e) => {
      App.state.projectors[App.selectedPJ].signal = e.target.checked;
      scheduleRender();
    });
    bindMask('mLeft', 'left'); bindMask('mRight', 'right');
    bindMask('mBottom', 'bottom'); bindMask('mTop', 'top');

    bindFeather('fLeft', 'left'); bindFeather('fRight', 'right');
    bindFeather('fBottom', 'bottom'); bindFeather('fTop', 'top');

    $('blendGamma').addEventListener('input', (e) => {
      App.blendGamma = parseFloat(e.target.value);
      $('blendGammaVal').textContent = App.blendGamma.toFixed(2);
      scheduleRender();
    });
    $('gammaRange').addEventListener('input', (e) => {
      App.gamma = parseFloat(e.target.value);
      $('gammaVal').textContent = App.gamma.toFixed(2);
      scheduleRender();
    });
    $('patternSelect').addEventListener('change', (e) => {
      App.pattern = e.target.value;
      scheduleRender();
    });

    ['camPosX', 'camPosY', 'camPosZ', 'camTgtX', 'camTgtY', 'camTgtZ', 'camFov'].forEach((id) => {
      $(id).addEventListener('input', () => {
        const cam = App.state.camera;
        cam.pos[0] = num('camPosX'); cam.pos[1] = num('camPosY'); cam.pos[2] = num('camPosZ');
        cam.target[0] = num('camTgtX'); cam.target[1] = num('camTgtY'); cam.target[2] = num('camTgtZ');
        cam.fovY = num('camFov');
        scheduleRender();
      });
    });

    $('audioBtn').addEventListener('click', (e) => {
      try {
        App.audio.toggle(e.target);
      } catch (err) { showError(err.message); }
    });
    $('compositeCanvas').addEventListener('mousemove', onCompositeMove);
    $('compositeCanvas').addEventListener('mouseleave', () => App.audio.update(0.5, 0, false));

    bindProbe();
    bindExports();
  }

  function bindNumber(id, apply) {
    $(id).addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isNaN(v)) return;
      apply(App.state.projectors[App.selectedPJ], v);
      scheduleRender();
    });
  }
  function bindFeather(id, key) {
    $(id).addEventListener('input', (e) => {
      const v = Math.max(0, Math.min(0.45, parseFloat(e.target.value) || 0));
      App.state.projectors.forEach((pj) => { pj.feather[key] = v; });
      scheduleRender();
    });
  }
  // 遮罩裁边只作用于当前选中机 (各机覆盖关系独立), 属几何量, 改动会使几何缓存失效
  function bindMask(id, key) {
    $(id).addEventListener('input', (e) => {
      const v = Math.max(0, Math.min(0.5, parseFloat(e.target.value) || 0));
      App.state.projectors[App.selectedPJ].maskCrop[key] = v;
      scheduleRender();
    });
  }
  function num(id) { return parseFloat($(id).value) || 0; }

  function onCompositeMove(e) {
    if (!App.audio.active || !App.result) return;
    const cv = $('compositeCanvas');
    const r = cv.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width;
    const ny = (e.clientY - r.top) / r.height;
    const px = Math.floor(nx * App.cam.width);
    const py = Math.floor(ny * App.cam.height);
    const i = (py * App.cam.width + px) * 4;
    const inside = App.result.composite.rgba[i + 3] === 255;
    const lin = App.result.composite.lin;
    const lum = inside ? (lin[i] * 0.2126 + lin[i + 1] * 0.7152 + lin[i + 2] * 0.0722) : 0;
    App.audio.update(nx, lum, inside);
  }

  function eventToPixel(e) {
    const cv = $('compositeCanvas');
    const r = cv.getBoundingClientRect();
    const px = Math.floor(((e.clientX - r.left) / r.width) * App.cam.width);
    const py = Math.floor(((e.clientY - r.top) / r.height) * App.cam.height);
    return Math.max(0, Math.min(App.cam.width * App.cam.height - 1, py * App.cam.width + px));
  }

  /* 锁定墙上一点, 逐机读出遮盖、几何权重、归一分母、份额、调光与最终亮度 */
  function updateProbePanel() {
    const box = $('probeBox');
    if (App.lockedPixel < 0 || !App.result) { box.classList.add('hidden'); return; }
    const i = App.lockedPixel;
    const probe = M.probeAtPixel(App.result.composite, App.pjs, i);
    const py = Math.floor(i / App.cam.width), px = i % App.cam.width;
    $('probePos').textContent = '锁定像素 (' + px + ',' + py + ') · 有效贡献机 ' +
      probe.contributors + ' 台 · 归一分母 ' + probe.denominator.toFixed(4);
    const lum = (v) => (v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722).toFixed(4);
    const rows = probe.projectors.map((r) =>
      '<tr>' +
      '<td>' + r.name + '</td>' +
      '<td class="' + (r.covered ? 'good' : 'bad') + '">' + (r.covered ? '覆盖' : '被遮') + '</td>' +
      '<td class="' + (r.signalOn ? 'good' : 'bad') + '">' + (r.signalOn ? '通' : '断') + '</td>' +
      '<td>' + r.weight.toFixed(3) + '</td>' +
      '<td>' + r.denominator.toFixed(3) + '</td>' +
      '<td>' + r.share.toFixed(4) + '</td>' +
      '<td>' + Number(r.dim).toFixed(2) + '</td>' +
      '<td>' + lum(r.contribution) + '</td>' +
      '</tr>').join('');
    box.innerHTML =
      '<table class="probe-table"><thead><tr>' +
      '<th>投影机</th><th>遮盖</th><th>信号</th><th>几何权重</th><th>归一分母</th>' +
      '<th>份额</th><th>调光</th><th>份额线性贡献(乘dim前)</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="probe-final">最终线性亮度 ' + probe.final.map((v) => v.toFixed(4)).join(', ') +
      ' ｜ 线性参考 ' + probe.reference.map((v) => v.toFixed(4)).join(', ') +
      (probe.contributors === 0 ? ' ｜ <span class="bad">该墙点无投影可达 (与混合误差分别定位)</span>' : '') +
      '</div>';
    box.classList.remove('hidden');
  }

  /* 在相机帧里找满足贡献机数量的墙点; nearPixel 给定时优先取其邻近像素 */
  function findPixelByCount(want, nearPixel) {
    const count = App.result.composite.probe.count;
    const W = App.cam.width;
    if (nearPixel >= 0) {
      for (let d = 1; d <= 16; d++) {
        for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
          const j = nearPixel + dy * W + dx;
          if (j >= 0 && j < count.length && count[j] === want) return j;
        }
      }
    }
    for (let i = 0; i < count.length; i++) if (count[i] === want) return i;
    return -1;
  }

  function bindProbe() {
    $('compositeCanvas').addEventListener('click', (e) => {
      App.lockedPixel = eventToPixel(e);
      updateProbePanel();
    });
    $('probeLockBtn').addEventListener('click', () => {
      if (App.lockedPixel < 0) App.lockedPixel = findPixelByCount(3);
      updateProbePanel();
    });
    $('probeCornerBtn').addEventListener('click', () => {
      // 墙角被遮住的采样点: 0 路有效贡献 (投影根本照不到)
      App.lockedPixel = findPixelByCount(0, App.lockedPixel);
      updateProbePanel();
    });
    $('probeThreeBtn').addEventListener('click', () => {
      // 被遮点附近恰有三路贡献的对照点
      App.lockedPixel = findPixelByCount(3, App.lockedPixel);
      updateProbePanel();
    });
    $('frameBaseBtn').addEventListener('click', () => {
      // 深拷贝线性帧, 避免后续渲染复用同一缓冲
      const c = App.result.composite;
      App.referenceFrame = {
        lin: c.lin.slice(), rgba: c.rgba.slice(),
        probe: { count: c.probe.count.slice() }
      };
      $('frameDiffOut').textContent = '已存参考帧 (线性光)';
    });
    $('frameDiffBtn').addEventListener('click', () => {
      if (!App.referenceFrame) { $('frameDiffOut').textContent = '请先存参考帧'; return; }
      const d = M.diffLinearFrames(App.referenceFrame, App.result.composite, true);
      $('frameDiffOut').textContent =
        '成员变化像素 ' + d.changedMembership + ' ｜ 帧差 max ' + d.maxDiff.toFixed(5) +
        ' ｜ 单机覆盖区受影响 ' + d.soleCoverageChanged + '/' + d.soleCoverageTotal;
    });
  }

  /* ---------- 导出 ---------- */
  function bindExports() {
    $('exportMeshBtn').addEventListener('click', () => {
      const pj = App.pjs[App.selectedPJ];
      const mesh = M.buildCalibrationMesh(App.scene, pj, 12, 8);
      downloadJSON(pj.id + '-calibration.json', mesh);
    });
    $('exportWarpBtn').addEventListener('click', () => {
      const pj = App.pjs[App.selectedPJ];
      const warp = M.renderWarpedGrid(pj, App.result.pjGeo[App.selectedPJ], App.gamma);
      downloadPNG(pj.id + '-warp-grid.png', pj.width, pj.height, warp.rgba);
    });
    $('exportPJBtn').addEventListener('click', () => {
      const pj = App.pjs[App.selectedPJ];
      const out = App.result.pjOutputs[App.selectedPJ];
      downloadPNG(pj.id + '-output.png', pj.width, pj.height, out.rgba);
    });
    $('exportCompositeBtn').addEventListener('click', () => {
      downloadPNG('composite.png', App.cam.width, App.cam.height, App.result.composite.rgba);
    });
    $('exportReportBtn').addEventListener('click', () => {
      const s = App.result.composite.stats;
      const report = {
        preset: App.state.presetId,
        quality: App.quality,
        pattern: App.pattern,
        gamma: App.gamma,
        blendGamma: App.blendGamma,
        projectors: App.pjs.map((pj, k) => ({
          id: pj.id, name: pj.name,
          pos: pj.pos, target: pj.target, fovY: pj.fovY,
          gain: pj.gain, rgb: pj.rgb, feather: pj.feather,
          dim: pj.dim, signal: pj.signal !== false, maskCrop: pj.maskCrop,
          coverage: App.result.pjGeo[k].coverage,
          clippedPixels: countClip(App.result.pjOutputs[k])
        })),
        composite: {
          coverage: s.coverage, uncoveredPixels: s.uncovered, wallPixels: s.wallPixels,
          overlapPixels: s.overlapPixels, meanErrorLinear: s.meanError,
          seamErrorLinear: s.seamError, misRegPx: s.misRegPx, misRegPxMax: s.misRegPxMax
        }
      };
      downloadJSON('projection-report.json', report);
    });
  }

  function downloadJSON(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    triggerDownload(URL.createObjectURL(blob), name);
  }
  function downloadPNG(name, w, h, rgba) {
    const bytes = M.encodePNG(w, h, rgba);
    const blob = new Blob([bytes], { type: 'image/png' });
    triggerDownload(URL.createObjectURL(blob), name);
  }
  function triggerDownload(url, name) {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- 提示 ---------- */
  function showError(msg) {
    const el = $('errorBanner');
    el.textContent = '展墙投影异常: ' + msg;
    el.classList.remove('hidden');
  }
  function hideError() { $('errorBanner').classList.add('hidden'); }
  function setStatus(t) { $('statusText').textContent = t; }
  function pct(v) { return (v * 100).toFixed(1) + '%'; }

  /* ---------- 启动 ---------- */
  App.boot = function () {
    App.quality = $('qualitySelect').value;
    loadPreset($('presetSelect').value, App.quality);
    App.editor = new M.TopDownEditor($('editorCanvas'), App.state, () => scheduleRender());
    bindControls();
    scheduleRender(true);
  };

  root.MPM.App = App;
  App.scheduleRender = scheduleRender;
  App.updateProbePanel = updateProbePanel;
  window.addEventListener('DOMContentLoaded', App.boot);
})(window);
