/* 渲染核心: 真实射线几何 -> 投影机输出像素 -> 模拟相机重建合成 (UMD, 无 DOM 依赖) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./vecmath.js'),
      require('./scene.js'),
      require('./projector.js'),
      require('./content.js')
    );
  } else root.MPM = Object.assign(root.MPM || {}, factory(root.MPM, root.MPM, root.MPM, root.MPM));
})(typeof self !== 'undefined' ? self : this, function (V, S, P, C) {
  'use strict';

  function validateScene(scene) {
    const errs = [];
    if (!scene.walls.length) errs.push('场景中没有墙面');
    for (const w of scene.walls) {
      if (w.len < 1e-4) errs.push('第 ' + (w.index + 1) + ' 面墙长度为零, 请拖开重合角点');
      if (w.height <= 0) errs.push('墙高必须大于 0');
    }
    return errs;
  }

  function validateProjectors(scene, projectors) {
    const errs = [];
    if (!projectors.length) errs.push('没有投影机');
    projectors.forEach((pj) => {
      if (V.length(V.sub(pj.target, pj.pos)) < 1e-4) {
        errs.push('投影机 ' + pj.name + ' 的位置与目标点重合');
      }
    });
    return errs;
  }

  /* ---- 几何通道: 对某台投影机/相机逐像素做真实射线求交, 几何不变时可复用 ---- */
  function buildGeometryBuffer(view, scene) {
    const n = view.width * view.height;
    const wall = new Int8Array(n);
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const weight = new Float32Array(n);
    const cu = new Float32Array(n);
    const visible = new Uint8Array(n);
    let cover = 0;
    for (let py = 0; py < view.height; py++) {
      for (let px = 0; px < view.width; px++) {
        const i = py * view.width + px;
        wall[i] = -1;
        const ray = P.rayForPixel(view, px, py);
        const hit = S.raycastWall(scene, ray.origin, ray.dir);
        if (!hit) continue;
        wall[i] = hit.wall;
        u[i] = hit.u;
        v[i] = hit.v;
        const cuv = S.contentUV(scene, hit.wall, hit.u, hit.v);
        cu[i] = cuv.cu;
        cover++;
        if (view.isCamera) {
          visible[i] = 1;
          weight[i] = 1;
          continue;
        }
        const pr = P.projectPoint(view, hit.point);
        if (!pr.inView) { wall[i] = -1; continue; }
        const wself = P.edgeWeight(view, pr.ndcX, pr.ndcY);
        if (wself <= 0) continue;
        weight[i] = wself;
        visible[i] = 1;
      }
    }
    return { wall, u, v, weight, cu, visible, width: view.width, height: view.height, coverage: cover / n };
  }

  /* 线性 RGBA 缓冲 + 每通道裁剪标记 */
  function makeRGBA(w, h) {
    return { width: w, height: h, lin: new Float32Array(w * h * 4), rgba: new Uint8ClampedArray(w * h * 4), clip: new Uint8Array(w * h * 3) };
  }

  /* ---- 单台投影机输出: 内容在线性光空间采样, 应用通道增益(颜色补偿), 再做显示编码 ---- */
  function renderProjector(pj, geo, scene, pattern, gamma) {
    const out = makeRGBA(pj.width, pj.height);
    const n = pj.width * pj.height;
    const gain = pj.gain;
    const rg = gain * pj.rgb[0], gg = gain * pj.rgb[1], bg = gain * pj.rgb[2];
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (geo.wall[i] < 0 || !geo.visible[i]) {
        // 投影范围外: 黑色输出并显式标记 alpha=0 (界面以蓝灰提示)
        out.rgba[o + 3] = 0;
        continue;
      }
      const lin = C.sampleLinear(geo.cu[i], geo.v[i], pattern);
      // 投影机实际显示图像 = 内容 * 通道增益 (颜色补偿); 融合份额在合成端按墙面点精确加权
      const r = lin[0] * rg, g = lin[1] * gg, b = lin[2] * bg;
      out.lin[o] = r; out.lin[o + 1] = g; out.lin[o + 2] = b; out.lin[o + 3] = 1;
      if (r > 1) out.clip[i * 3] = 1;
      if (g > 1) out.clip[i * 3 + 1] = 1;
      if (b > 1) out.clip[i * 3 + 2] = 1;
      out.rgba[o] = Math.round(C.lin2enc(V.clamp(r, 0, 1), gamma) * 255);
      out.rgba[o + 1] = Math.round(C.lin2enc(V.clamp(g, 0, 1), gamma) * 255);
      out.rgba[o + 2] = Math.round(C.lin2enc(V.clamp(b, 0, 1), gamma) * 255);
      out.rgba[o + 3] = 255;
    }
    out.coverage = geo.coverage;
    return out;
  }

  function sampleProjectorLinear(pjOut, px, py, w, h) {
    px = V.clamp(px, 0, w - 1);
    py = V.clamp(py, 0, h - 1);
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const tx = px - x0, ty = py - y0;
    const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const c = new Float32Array(4);
    const idx = (x, y) => (y * w + x) * 4;
    for (let k = 0; k < 4; k++) {
      const a = pjOut.lin[idx(x0, y0) + k] * (1 - tx) + pjOut.lin[idx(x1, y0) + k] * tx;
      const b = pjOut.lin[idx(x0, y1) + k] * (1 - tx) + pjOut.lin[idx(x1, y1) + k] * tx;
      c[k] = a * (1 - ty) + b * ty;
    }
    return c;
  }

  /*
   * ---- 模拟相机重建 ----
   * 每个相机像素: 射线打墙 -> 反投影到每台投影机 (遮挡剔除) -> 线性光空间直接叠加
   * 投影机端已按 w_k/sum(w) 预补偿, 叠加即还原参考亮度, 接缝不会过亮
   * blendGamma 仅改变羽化权重的显示曲线; 线性光与显示编码的处理空间始终分离
   */
  function renderComposite(cam, camGeo, scene, projectors, pjGeos, pjOutputs, pattern, gamma, blendGamma) {
    blendGamma = blendGamma || 1;
    const out = makeRGBA(cam.width, cam.height);
    const n = cam.width * cam.height;
    const ref = new Float32Array(n * 3);
    const seamRows = new Float32Array(cam.height);
    const seamW = new Float32Array(cam.height);
    let wallPixels = 0, uncovered = 0, errSum = 0, errN = 0;
    let overlapPixels = 0, seamErrSum = 0, maxErr = 0;
    let regSum = 0, regMax = 0;

    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (camGeo.wall[i] < 0) {
        out.rgba[o + 3] = 0;
        continue;
      }
      wallPixels++;
      const refLin = C.sampleLinear(camGeo.cu[i], camGeo.v[i], pattern);
      ref[i * 3] = refLin[0]; ref[i * 3 + 1] = refLin[1]; ref[i * 3 + 2] = refLin[2];

      const acc = [0, 0, 0];
      let contributors = 0;
      const hits = [];
      let wsum = 0;
      for (let k = 0; k < projectors.length; k++) {
        const pj = projectors[k];
        const geo = pjGeos[k];
        // 反投影到投影机并校验其几何缓冲命中同一墙面 (遮挡/超范围剔除)
        const pjHit = projectPointOnWall(pj, scene, geo, camGeo, i);
        if (!pjHit) continue;
        // 在墙面点处精确计算本机羽化权重 (而非取相邻投影机像素), 保证分母一致
        const pr = P.projectPoint(pj, S.worldFromUV(scene, camGeo.wall[i], camGeo.u[i], camGeo.v[i]));
        const wExact = P.edgeWeight(pj, pr.ndcX, pr.ndcY);
        if (wExact <= 0) continue;
        const s = sampleProjectorLinear(pjOutputs[k], pjHit.px, pjHit.py, pj.width, pj.height);
        // 该投影机像素中心射线实际命中的墙面点 (精确浮点), 与相机目标点的世界偏差用于标定残差
        const pjRay = P.rayForPixel(pj, pjHit.px, pjHit.py);
        const pjWallHit = S.raycastWall(scene, pjRay.origin, pjRay.dir);
        const sampledPoint = pjWallHit ? pjWallHit.point : null;
        hits.push({ wExact, s, sampledPoint });
        wsum += wExact;
        contributors++;
      }

      if (contributors === 0) {
        uncovered++;
        out.rgba[o + 3] = 0;
        continue;
      }
      if (contributors > 1) {
        overlapPixels++;
        // 标定残差: 各机像素中心实际命中的世界点与相机目标点之差, 反投到相机像素口径
        const targetPoint = S.worldFromUV(scene, camGeo.wall[i], camGeo.u[i], camGeo.v[i]);
        let regPx = 0;
        for (const h2 of hits) {
          if (!h2.sampledPoint) continue;
          const diff = V.sub(h2.sampledPoint, targetPoint);
          const off = V.add(targetPoint, diff);
          const a = P.projectPoint(cam, targetPoint);
          const b = P.projectPoint(cam, off);
          const pa = P.ndcToPixel(cam, a.ndcX, a.ndcY);
          const pb = P.ndcToPixel(cam, b.ndcX, b.ndcY);
          regPx += Math.hypot(pb.x - pa.x, pb.y - pa.y);
        }
        regPx /= hits.length;
        regSum += regPx;
        regMax = Math.max(regMax, regPx);
      }
      // 归一化加权在线性光空间完成: 份额 w_k/sum(w), 任何重叠点数机之和恒为 1, 接缝不会过亮
      // blendGamma 仅改变融合曲线 (对份额取指数后重新归一), 不改变线性/编码的处理空间
      const rawShares = hits.map((h) => Math.pow(h.wExact / wsum, blendGamma));
      const shareSum = rawShares.reduce((a, b2) => a + b2, 0);
      for (let k2 = 0; k2 < hits.length; k2++) {
        const share = rawShares[k2] / shareSum;
        const h = hits[k2];
        acc[0] += h.s[0] * share;
        acc[1] += h.s[1] * share;
        acc[2] += h.s[2] * share;
      }
      const r = acc[0], g = acc[1], b = acc[2];
      out.lin[o] = r; out.lin[o + 1] = g; out.lin[o + 2] = b; out.lin[o + 3] = 1;
      out.rgba[o] = Math.round(C.lin2enc(V.clamp(r, 0, 1), gamma) * 255);
      out.rgba[o + 1] = Math.round(C.lin2enc(V.clamp(g, 0, 1), gamma) * 255);
      out.rgba[o + 2] = Math.round(C.lin2enc(V.clamp(b, 0, 1), gamma) * 255);
      out.rgba[o + 3] = 255;

      const e = Math.hypot(r - refLin[0], g - refLin[1], b - refLin[2]) / Math.sqrt(3);
      errSum += e; errN++; maxErr = Math.max(maxErr, e);
      if (contributors > 1) {
        seamErrSum += e;
        const py = Math.floor(i / cam.width);
        seamRows[py] += e; seamW[py] += 1;
      }
    }

    for (let y = 0; y < cam.height; y++) if (seamW[y] > 0) seamRows[y] /= seamW[y];
    out.reference = ref;
    out.stats = {
      wallPixels,
      uncovered,
      covered: errN,
      coverage: wallPixels ? errN / wallPixels : 0,
      overlapPixels,
      meanError: errN ? errSum / errN : 1,
      seamError: overlapPixels ? seamErrSum / overlapPixels : 0,
      maxError: maxErr,
      misRegPx: overlapPixels ? regSum / overlapPixels : 0,
      misRegPxMax: regMax,
      seamRows
    };
    return out;
  }

  /* 相机像素对应墙面点 -> 反投影到投影机, 并校验该投影机几何缓冲命中同一墙面 (遮挡剔除) */
  function projectPointOnWall(pj, scene, geo, camGeo, i) {
    const point = S.worldFromUV(scene, camGeo.wall[i], camGeo.u[i], camGeo.v[i]);
    const pr = P.projectPoint(pj, point);
    if (!pr.inView) return null;
    const px = Math.floor((pr.ndcX + 1) * 0.5 * pj.width);
    const py = Math.floor((1 - pr.ndcY) * 0.5 * pj.height);
    if (px < 0 || py < 0 || px >= pj.width || py >= pj.height) return null;
    const gi = py * pj.width + px;
    if (geo.wall[gi] !== camGeo.wall[i]) return null;
    return { ndcX: pr.ndcX, ndcY: pr.ndcY, px, py };
  }

  /* ---- 校正网格: 墙面规则网格点 -> 投影机输出像素, 可导出 JSON ---- */
  function buildCalibrationMesh(scene, pj, cols, rows) {
    const mesh = {
      projector: { id: pj.id, name: pj.name, width: pj.width, height: pj.height },
      grid: { cols, rows },
      points: []
    };
    for (const w of scene.walls) {
      for (let j = 0; j <= rows; j++) {
        for (let i = 0; i <= cols; i++) {
          const u = i / cols, v = j / rows;
          const point = S.worldFromUV(scene, w.index, u, v);
          const pr = P.projectPoint(pj, point);
          const entry = {
            wall: w.index,
            u, v,
            world: point,
            inView: pr.inView,
            pixel: pr.inView ? P.ndcToPixel(pj, pr.ndcX, pr.ndcY) : null
          };
          mesh.points.push(entry);
        }
      }
    }
    return mesh;
  }

  /* 校正网格可视化位图: 把墙面格点按投影几何扭曲绘制 */
  function renderWarpedGrid(pj, geo, gamma) {
    const out = makeRGBA(pj.width, pj.height);
    const n = pj.width * pj.height;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (geo.wall[i] < 0) { out.rgba[o + 3] = 0; continue; }
      const onU = nearGrid(geo.u[i], 0.1) || nearGrid(geo.v[i], 0.1);
      const strong = nearGrid(geo.u[i], 0.5) || nearGrid(geo.v[i], 0.5);
      let lin = onU ? (strong ? [0.95, 0.2, 0.9] : [0.15, 0.9, 0.9]) : [0.07, 0.07, 0.09];
      out.rgba[o] = Math.round(C.lin2enc(lin[0], gamma) * 255);
      out.rgba[o + 1] = Math.round(C.lin2enc(lin[1], gamma) * 255);
      out.rgba[o + 2] = Math.round(C.lin2enc(lin[2], gamma) * 255);
      out.rgba[o + 3] = 255;
    }
    return out;
  }

  function nearGrid(t, step) {
    const f = (t / step) - Math.floor(t / step);
    const w = 0.012 / step;
    return f < w || f > 1 - w;
  }

  function Renderer() {
    this.pjGeo = [];
    this.camGeo = null;
    this.signature = '';
  }

  function geoSignature(scene, views) {
    const parts = [JSON.stringify(scene.corners), scene.height];
    for (const v of views) {
      parts.push(v.id, v.pos.join(','), v.target.join(','), v.fovY, v.width, v.height, JSON.stringify(v.feather));
    }
    return parts.join('|');
  }

  Renderer.prototype.updateGeometry = function (scene, projectors, camera) {
    const sig = geoSignature(scene, projectors.concat([camera]));
    if (sig === this.signature) return false;
    const errs = validateScene(scene).concat(validateProjectors(scene, projectors));
    if (errs.length) throw new Error(errs.join('; '));
    this.pjGeo = projectors.map((pj) => buildGeometryBuffer(pj, scene));
    this.camGeo = buildGeometryBuffer(camera, scene);
    this.signature = sig;
    return true;
  };

  Renderer.prototype.renderAll = function (opts) {
    const { scene, projectors, camera, pattern, gamma, blendGamma } = opts;
    this.updateGeometry(scene, projectors, camera);
    const pjOutputs = projectors.map((pj, k) =>
      renderProjector(pj, this.pjGeo[k], scene, pattern, gamma));
    const composite = renderComposite(
      camera, this.camGeo, scene, projectors, this.pjGeo, pjOutputs,
      pattern, gamma, blendGamma);
    return { pjOutputs, composite, pjGeo: this.pjGeo, camGeo: this.camGeo };
  };

  return {
    Renderer,
    validateScene,
    validateProjectors,
    buildGeometryBuffer,
    renderProjector,
    renderComposite,
    buildCalibrationMesh,
    renderWarpedGrid,
    makeRGBA
  };
});
