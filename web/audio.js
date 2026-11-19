/* 空间音画视窗: 指针在重建画面上的墙面位置驱动立体声像, 局部重建亮度驱动音量 */
(function (root) {
  'use strict';

  function SpatialAudio() {
    this.ctx = null;
    this.osc = null;
    this.gain = null;
    this.panner = null;
    this.active = false;
  }

  SpatialAudio.prototype.toggle = function (btn) {
    if (this.active) {
      this.stop();
      btn.textContent = '开启空间音画视窗';
      return false;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('当前浏览器不支持 Web Audio, 无法开启空间音画视窗');
    this.ctx = new AC();
    this.osc = this.ctx.createOscillator();
    this.osc.type = 'sine';
    this.osc.frequency.value = 330;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    this.panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    this.osc.connect(this.gain);
    if (this.panner) this.gain.connect(this.panner), this.panner.connect(this.ctx.destination);
    else this.gain.connect(this.ctx.destination);
    this.osc.start();
    this.active = true;
    btn.textContent = '关闭空间音画视窗';
    return true;
  };

  /* nx: 画面归一化横向 0..1 (映射到墙面内容位置); linLum: 该位置重建线性亮度 0..1; inside: 是否在墙面上 */
  SpatialAudio.prototype.update = function (nx, linLum, inside) {
    if (!this.active || !this.ctx) return;
    const t = this.ctx.currentTime;
    const pan = Math.max(-1, Math.min(1, nx * 2 - 1));
    if (this.panner) this.panner.pan.setTargetAtTime(pan, t, 0.03);
    // 沿墙位置微调音高, 营造空间移动感
    this.osc.frequency.setTargetAtTime(260 + nx * 220, t, 0.05);
    const target = inside ? 0.02 + linLum * 0.06 : 0;
    this.gain.gain.setTargetAtTime(target, t, 0.06);
  };

  SpatialAudio.prototype.stop = function () {
    if (!this.active) return;
    try { this.osc.stop(); } catch (e) { /* 已停止 */ }
    this.ctx.close();
    this.active = false;
    this.ctx = null;
  };

  root.MPM.SpatialAudio = SpatialAudio;
})(window);
