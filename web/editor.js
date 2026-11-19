/* 俯视几何编辑器: 墙面折线、投影机/目标/相机拖动手柄、视锥与命中范围绘制 */
(function (root) {
  'use strict';
  const MPM = root.MPM;

  function TopDownEditor(canvas, state, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = state;
    this.onChange = onChange;
    this.drag = null;
    this.hover = null;
    this.padding = 34;
    this.V = {
      sub: MPM.sub, add: MPM.add, scale: MPM.scale, cross: MPM.cross, normalize: MPM.normalize
    };
    this._bind();
  }

  TopDownEditor.prototype._bind = function () {
    const c = this.canvas;
    const getPos = (e) => {
      const r = c.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (c.width / r.width),
        y: (e.clientY - r.top) * (c.height / r.height)
      };
    };
    c.addEventListener('mousedown', (e) => {
      const m = getPos(e);
      this.drag = this._hitTest(m.x, m.y);
      if (this.drag) e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      const r = c.getBoundingClientRect();
      const m = {
        x: (e.clientX - r.left) * (c.width / r.width),
        y: (e.clientY - r.top) * (c.height / r.height)
      };
      if (this.drag) {
        const world = this._toWorld(m.x, m.y);
        this._applyDrag(this.drag, world);
        this.onChange();
      } else {
        this.hover = this._hitTest(m.x, m.y);
        c.style.cursor = this.hover ? 'pointer' : 'crosshair';
      }
    });
    window.addEventListener('mouseup', () => { this.drag = null; });
  };

  TopDownEditor.prototype._bounds = function () {
    const pts = [];
    for (const cn of this.state.corners) pts.push([cn[0], cn[1]]);
    for (const pj of this.state.projectors) {
      pts.push([pj.pos[0], pj.pos[2]], [pj.target[0], pj.target[2]]);
    }
    pts.push([this.state.camera.pos[0], this.state.camera.pos[2]]);
    pts.push([this.state.camera.target[0], this.state.camera.target[2]]);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
    }
    const span = Math.max(maxX - minX, maxZ - minZ, 1) + 2.4;
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    return { minX: cx - span / 2, maxX: cx + span / 2, minZ: cz - span / 2, maxZ: cz + span / 2 };
  };

  TopDownEditor.prototype._toScreen = function (wx, wz) {
    const b = this._bounds();
    const w = this.canvas.width - this.padding * 2;
    const h = this.canvas.height - this.padding * 2;
    return {
      x: this.padding + ((wx - b.minX) / (b.maxX - b.minX)) * w,
      y: this.padding + ((wz - b.minZ) / (b.maxZ - b.minZ)) * h
    };
  };

  TopDownEditor.prototype._toWorld = function (sx, sy) {
    const b = this._bounds();
    const w = this.canvas.width - this.padding * 2;
    const h = this.canvas.height - this.padding * 2;
    return {
      x: b.minX + ((sx - this.padding) / w) * (b.maxX - b.minX),
      z: b.minZ + ((sy - this.padding) / h) * (b.maxZ - b.minZ)
    };
  };

  TopDownEditor.prototype._handles = function () {
    const hs = [];
    this.state.corners.forEach((cn, i) => {
      const s = this._toScreen(cn[0], cn[1]);
      hs.push({ kind: 'corner', index: i, x: s.x, y: s.y, r: 7 });
    });
    this.state.projectors.forEach((pj, i) => {
      const a = this._toScreen(pj.pos[0], pj.pos[2]);
      hs.push({ kind: 'pj', index: i, x: a.x, y: a.y, r: 7 });
      const t = this._toScreen(pj.target[0], pj.target[2]);
      hs.push({ kind: 'aim', index: i, x: t.x, y: t.y, r: 6 });
    });
    const cam = this.state.camera;
    const cp = this._toScreen(cam.pos[0], cam.pos[2]);
    hs.push({ kind: 'cam', x: cp.x, y: cp.y, r: 7 });
    const ct = this._toScreen(cam.target[0], cam.target[2]);
    hs.push({ kind: 'camAim', x: ct.x, y: ct.y, r: 6 });
    return hs;
  };

  TopDownEditor.prototype._hitTest = function (x, y) {
    const hs = this._handles();
    for (let i = hs.length - 1; i >= 0; i--) {
      const h = hs[i];
      if (Math.hypot(h.x - x, h.y - y) <= h.r + 3) return h;
    }
    return null;
  };

  TopDownEditor.prototype._applyDrag = function (h, w) {
    if (h.kind === 'corner') {
      this.state.corners[h.index] = [round(w.x), round(w.z)];
    } else if (h.kind === 'pj') {
      const pj = this.state.projectors[h.index];
      pj.pos[0] = round(w.x); pj.pos[2] = round(w.z);
    } else if (h.kind === 'aim') {
      const pj = this.state.projectors[h.index];
      pj.target[0] = round(w.x); pj.target[2] = round(w.z);
    } else if (h.kind === 'cam') {
      this.state.camera.pos[0] = round(w.x); this.state.camera.pos[2] = round(w.z);
    } else if (h.kind === 'camAim') {
      this.state.camera.target[0] = round(w.x); this.state.camera.target[2] = round(w.z);
    }
  };

  TopDownEditor.prototype.draw = function (rendererData) {
    const ctx = this.ctx;
    const c = this.canvas;
    ctx.clearRect(0, 0, c.width, c.height);
    this._drawGrid();

    // 墙面折线 + 法线
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#9fb4cc';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    this.state.corners.forEach((cn, i) => {
      const s = this._toScreen(cn[0], cn[1]);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.stroke();

    // 投影机视锥
    this.state.projectors.forEach((pj, i) => this._drawFrustum(pj, i, rendererData));
    this._drawFrustum(this.state.camera, -1, null, true);

    // 连线 投影机->目标
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    this.state.projectors.forEach((pj) => {
      const a = this._toScreen(pj.pos[0], pj.pos[2]);
      const b = this._toScreen(pj.target[0], pj.target[2]);
      ctx.strokeStyle = 'rgba(245,166,35,0.7)';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });
    ctx.setLineDash([]);

    // 手柄
    for (const h of this._handles()) this._drawHandle(h);
  };

  TopDownEditor.prototype._drawGrid = function () {
    const ctx = this.ctx, c = this.canvas;
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const x = this.padding + (i / 10) * (c.width - 2 * this.padding);
      const y = this.padding + (i / 10) * (c.height - 2 * this.padding);
      ctx.beginPath(); ctx.moveTo(x, this.padding); ctx.lineTo(x, c.height - this.padding); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(this.padding, y); ctx.lineTo(c.width - this.padding, y); ctx.stroke();
    }
  };

  TopDownEditor.prototype._drawFrustum = function (view, idx, rendererData, isCam) {
    const ctx = this.ctx;
    const V = this.V;
    const forward = V.normalize(V.sub(view.target, view.pos));
    const right = V.normalize(V.cross(forward, [0, 1, 0]));
    const half = Math.tan((view.fovY * Math.PI / 180) / 2) * (view.width / view.height);
    const reach = 9;
    const left = V.add(view.pos, V.scale(V.sub(forward, V.scale(right, half)), reach));
    const rightP = V.add(view.pos, V.scale(V.add(forward, V.scale(right, half)), reach));
    const a = this._toScreen(view.pos[0], view.pos[2]);
    const b = this._toScreen(left[0], left[2]);
    const d = this._toScreen(rightP[0], rightP[2]);
    ctx.fillStyle = isCam ? 'rgba(56,193,114,0.10)' : (idx === 2 && this.state.deviated ? 'rgba(245,166,35,0.14)' : 'rgba(77,163,255,0.12)');
    ctx.strokeStyle = isCam ? 'rgba(56,193,114,0.55)' : 'rgba(77,163,255,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(d.x, d.y); ctx.closePath();
    ctx.fill(); ctx.stroke();
  };

  TopDownEditor.prototype._drawHandle = function (h) {
    const ctx = this.ctx;
    const colors = {
      corner: '#9fb4cc', pj: '#4da3ff', aim: '#f5a623', cam: '#38c172', camAim: '#8fe3b0'
    };
    const hovered = this.hover && this.hover.kind === h.kind &&
      this.hover.index === h.index && this.hover.x === h.x;
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.r + (hovered ? 2 : 0), 0, Math.PI * 2);
    ctx.fillStyle = colors[h.kind] || '#fff';
    ctx.fill();
    ctx.strokeStyle = '#0a0d12';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (h.kind === 'corner') {
      ctx.fillStyle = '#0a0d12';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(h.index), h.x, h.y + 3);
    }
  };

  function round(v) { return Math.round(v * 100) / 100; }

  MPM.TopDownEditor = TopDownEditor;
})(window);
