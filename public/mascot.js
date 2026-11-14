/**
 * EDGE — Art-Directed 60FPS Visual Mascot & Futuristic Dubai Stage Engine
 * Aesthetic Direction: "Gilded Mirage — Futuristic Dubai 2071"
 * Inspired by the Museum of the Future torus, Islamic Mashrabiya sacred geometry,
 * and 24K Burj Gold acoustic resonance.
 */

export class EdgeMascotVisualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = 'IDLE'; // 'IDLE' | 'LISTENING' | 'SILENT_APPROVAL' | 'INTERRUPT_SPEAKING'
    this.time = 0;
    this.audioEnergy = 0;
    this.targetEnergy = 0;
    this.interruptFlash = 0;
    this.silentPulse = 0;
    this.analyser = null;
    this.freqData = null;

    // Atmospheric desert gold dust particles
    this.particles = [];
    this.stars = [];
    this.initParticles();

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();

    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  initParticles() {
    this.particles = Array.from({ length: 68 }, () => ({
      angle: Math.random() * Math.PI * 2,
      radius: 60 + Math.random() * 190,
      speed: (0.002 + Math.random() * 0.006) * (Math.random() > 0.5 ? 1 : -1),
      size: 1 + Math.random() * 2.4,
      alpha: 0.2 + Math.random() * 0.65,
      driftY: (Math.random() - 0.5) * 0.4,
      hueOffset: Math.random() * 16 - 8
    }));

    this.stars = Array.from({ length: 55 }, () => ({
      x: Math.random(),
      y: Math.random() * 0.65,
      size: 0.6 + Math.random() * 1.5,
      phase: Math.random() * Math.PI * 2,
      speed: 0.015 + Math.random() * 0.03
    }));
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width || 800;
    this.height = rect.height || 520;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setState(newState) {
    if (this.state !== newState) {
      this.state = newState;
      if (newState === 'INTERRUPT_SPEAKING') {
        this.interruptFlash = 1.0;
      } else if (newState === 'SILENT_APPROVAL') {
        this.silentPulse = 1.0;
      }
    }
  }

  connectAnalyser(analyserNode) {
    this.analyser = analyserNode;
    if (analyserNode) {
      this.freqData = new Uint8Array(analyserNode.frequencyBinCount);
    }
  }

  setSimulatedEnergy(level) {
    this.targetEnergy = Math.max(0, Math.min(1, level));
  }

  drawMashrabiyaStar(cx, cy, radius, points, rotation, strokeStyle, lineWidth = 1.2) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    ctx.beginPath();
    const step = (Math.PI * 2) / (points * 2);
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? radius : radius * 0.72;
      const a = i * step;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
    ctx.restore();
  }

  drawCalligraphicTorus(cx, cy, baseR, energy, palette) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(cx, cy);

    // Museum of the Future inspired elliptical torus rings
    const rings = 5;
    for (let i = 0; i < rings; i++) {
      const progress = i / (rings - 1);
      const tilt = this.time * (0.35 + i * 0.08) + i * 0.55;
      const rx = baseR * (0.86 + progress * 0.34) + energy * 18 * Math.sin(this.time * 4 + i);
      const ry = baseR * (0.52 + progress * 0.28) + energy * 14 * Math.cos(this.time * 3 + i);

      ctx.save();
      ctx.rotate(tilt);
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.strokeStyle = palette.ringStroke(0.18 + (1 - progress) * 0.38);
      ctx.lineWidth = i === 0 ? 2.2 : 1.15;
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  drawFrequencyCrown(cx, cy, baseR, energy, palette) {
    const ctx = this.ctx;
    const segments = 64;
    ctx.save();
    ctx.translate(cx, cy);

    ctx.beginPath();
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      let binVal = 0;
      if (this.analyser && this.freqData) {
        const idx = i % Math.min(32, this.freqData.length);
        binVal = this.freqData[idx] / 255;
      } else {
        binVal =
          energy *
          (0.45 +
            0.35 * Math.sin(angle * 6 + this.time * 9) +
            0.2 * Math.cos(angle * 10 - this.time * 6));
      }

      const spike = binVal * (this.state === 'INTERRUPT_SPEAKING' ? 42 : 20);
      const r = baseR + spike;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = palette.crownStroke;
    ctx.lineWidth = this.state === 'INTERRUPT_SPEAKING' ? 2.4 : 1.5;
    ctx.shadowColor = palette.glow;
    ctx.shadowBlur = this.state === 'INTERRUPT_SPEAKING' ? 24 : 12;
    ctx.stroke();
    ctx.restore();
  }

  drawCoreFalconEye(cx, cy, coreR, energy, palette) {
    const ctx = this.ctx;
    ctx.save();

    // Radial core glow
    const grad = ctx.createRadialGradient(cx, cy, coreR * 0.1, cx, cy, coreR * 2.1);
    grad.addColorStop(0, palette.coreInner);
    grad.addColorStop(0.45, palette.coreMid);
    grad.addColorStop(1, 'hsla(35, 80%, 50%, 0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 2.1, 0, Math.PI * 2);
    ctx.fill();

    // Inner metallic torus aperture (Museum of the Future void)
    ctx.save();
    ctx.translate(cx, cy);
    const pulseScale = 1 + energy * 0.22 + Math.sin(this.time * 2.6) * 0.03;
    ctx.scale(pulseScale, pulseScale);

    // Outer gold bezel
    ctx.beginPath();
    ctx.ellipse(0, 0, coreR * 0.78, coreR * 0.54, -0.22, 0, Math.PI * 2);
    ctx.strokeStyle = palette.coreStroke;
    ctx.lineWidth = 2.6;
    ctx.stroke();

    // Inner void eye
    ctx.beginPath();
    ctx.ellipse(0, 0, coreR * 0.44, coreR * 0.27, -0.22, 0, Math.PI * 2);
    ctx.fillStyle = 'hsl(225, 32%, 6%)';
    ctx.fill();
    ctx.strokeStyle = palette.crownStroke;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // Voice waveform filament inside the torus void
    ctx.beginPath();
    const waveWidth = coreR * 0.68;
    for (let x = -waveWidth / 2; x <= waveWidth / 2; x += 2) {
      const norm = x / (waveWidth / 2);
      const envelope = Math.cos(norm * (Math.PI / 2));
      const amp =
        (4 + energy * 24) *
        envelope *
        Math.sin(norm * 8 + this.time * (this.state === 'INTERRUPT_SPEAKING' ? 16 : 6));
      if (x === -waveWidth / 2) ctx.moveTo(x, amp);
      else ctx.lineTo(x, amp);
    }
    ctx.strokeStyle = palette.coreInner;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.restore();
    ctx.restore();
  }

  drawDubaiSkyline(width, height, palette) {
    const ctx = this.ctx;
    const horizonY = height - 118;

    // Warm desert dusk atmospheric horizon glow
    const skyGlow = ctx.createLinearGradient(0, horizonY - 150, 0, height);
    skyGlow.addColorStop(0, 'hsla(38, 82%, 52%, 0)');
    skyGlow.addColorStop(0.55, palette.horizonMist);
    skyGlow.addColorStop(1, 'hsla(225, 32%, 5%, 0.96)');
    ctx.fillStyle = skyGlow;
    ctx.fillRect(0, horizonY - 150, width, height - (horizonY - 150));

    ctx.save();
    ctx.strokeStyle = palette.skylineLine;
    ctx.fillStyle = 'hsla(225, 32%, 5%, 0.92)';
    ctx.lineWidth = 1.25;

    // Architectural silhouette path featuring Burj Khalifa, Museum of the Future, Dubai Frame, Burj Al Arab
    const bkx = width * 0.5; // Burj Khalifa aligned beneath Edge core as architectural axis
    const scale = Math.min(0.95, Math.max(0.62, width / 1200));

    ctx.beginPath();
    ctx.moveTo(0, horizonY);
    ctx.lineTo(0, horizonY - 22 * scale);

    // Left Marina towers
    const leftTowers = [
      [0.05, 42],
      [0.08, 68],
      [0.11, 54],
      [0.14, 88],
      [0.17, 62]
    ];
    for (const [rx, h] of leftTowers) {
      const tx = width * rx;
      ctx.lineTo(tx - 10 * scale, horizonY - h * scale * 0.4);
      ctx.lineTo(tx - 10 * scale, horizonY - h * scale);
      ctx.lineTo(tx + 10 * scale, horizonY - h * scale);
      ctx.lineTo(tx + 10 * scale, horizonY - h * scale * 0.35);
    }

    // Burj Al Arab sail silhouette at ~0.24
    const baaX = width * 0.24;
    ctx.lineTo(baaX - 18 * scale, horizonY - 24 * scale);
    ctx.lineTo(baaX - 12 * scale, horizonY - 105 * scale);
    ctx.quadraticCurveTo(
      baaX + 24 * scale,
      horizonY - 72 * scale,
      baaX + 10 * scale,
      horizonY - 22 * scale
    );

    // Emirates Towers twin angled peaks at ~0.34
    const etX = width * 0.34;
    ctx.lineTo(etX - 24 * scale, horizonY - 28 * scale);
    ctx.lineTo(etX - 24 * scale, horizonY - 96 * scale);
    ctx.lineTo(etX - 8 * scale, horizonY - 80 * scale);
    ctx.lineTo(etX - 8 * scale, horizonY - 28 * scale);
    ctx.lineTo(etX + 4 * scale, horizonY - 28 * scale);
    ctx.lineTo(etX + 4 * scale, horizonY - 78 * scale);
    ctx.lineTo(etX + 18 * scale, horizonY - 90 * scale);
    ctx.lineTo(etX + 18 * scale, horizonY - 26 * scale);

    // Downtown stepped ascent toward Burj Khalifa at 0.50
    ctx.lineTo(bkx - 52 * scale, horizonY - 35 * scale);
    ctx.lineTo(bkx - 52 * scale, horizonY - 64 * scale);
    ctx.lineTo(bkx - 36 * scale, horizonY - 64 * scale);
    ctx.lineTo(bkx - 36 * scale, horizonY - 40 * scale);

    // Burj Khalifa iconic tiered spire
    ctx.lineTo(bkx - 20 * scale, horizonY - 40 * scale);
    ctx.lineTo(bkx - 18 * scale, horizonY - 74 * scale);
    ctx.lineTo(bkx - 13 * scale, horizonY - 74 * scale);
    ctx.lineTo(bkx - 11 * scale, horizonY - 112 * scale);
    ctx.lineTo(bkx - 7 * scale, horizonY - 112 * scale);
    ctx.lineTo(bkx - 5 * scale, horizonY - 150 * scale);
    ctx.lineTo(bkx - 2 * scale, horizonY - 184 * scale);
    ctx.lineTo(bkx, horizonY - 225 * scale); // Spire tip
    ctx.lineTo(bkx + 2 * scale, horizonY - 184 * scale);
    ctx.lineTo(bkx + 5 * scale, horizonY - 142 * scale);
    ctx.lineTo(bkx + 8 * scale, horizonY - 142 * scale);
    ctx.lineTo(bkx + 10 * scale, horizonY - 102 * scale);
    ctx.lineTo(bkx + 15 * scale, horizonY - 102 * scale);
    ctx.lineTo(bkx + 17 * scale, horizonY - 64 * scale);
    ctx.lineTo(bkx + 22 * scale, horizonY - 36 * scale);

    // Dubai Frame at ~0.76
    const dfX = width * 0.76;
    ctx.lineTo(dfX - 24 * scale, horizonY - 26 * scale);
    ctx.lineTo(dfX - 24 * scale, horizonY - 98 * scale);
    ctx.lineTo(dfX + 24 * scale, horizonY - 98 * scale);
    ctx.lineTo(dfX + 24 * scale, horizonY - 26 * scale);

    // Right DIFC / Creek skyline
    const rightTowers = [
      [0.85, 76],
      [0.89, 58],
      [0.93, 84],
      [0.97, 46]
    ];
    for (const [rx, h] of rightTowers) {
      const tx = width * rx;
      ctx.lineTo(tx - 11 * scale, horizonY - h * scale * 0.35);
      ctx.lineTo(tx - 11 * scale, horizonY - h * scale);
      ctx.lineTo(tx + 11 * scale, horizonY - h * scale);
      ctx.lineTo(tx + 11 * scale, horizonY - h * scale * 0.3);
    }

    ctx.lineTo(width, horizonY - 20 * scale);
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Museum of the Future torus silhouette at ~0.64
    const motfX = width * 0.64;
    const motfY = horizonY - 52 * scale;
    ctx.beginPath();
    ctx.ellipse(motfX, motfY, 32 * scale, 21 * scale, -0.1, 0, Math.PI * 2);
    ctx.fillStyle = 'hsla(225, 30%, 6%, 0.94)';
    ctx.fill();
    ctx.strokeStyle = palette.skylineLine;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(motfX, motfY, 15 * scale, 9 * scale, -0.1, 0, Math.PI * 2);
    ctx.strokeStyle = palette.skylineAccent;
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // Burj Khalifa pinnacle beacon pulse
    const beaconAlpha = 0.55 + 0.45 * Math.sin(this.time * 4);
    ctx.beginPath();
    ctx.arc(bkx, horizonY - 225 * scale, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(42, 95%, 72%, ${beaconAlpha})`;
    ctx.shadowColor = 'hsla(42, 95%, 65%, 0.9)';
    ctx.shadowBlur = 14;
    ctx.fill();

    ctx.restore();
  }

  getPalette() {
    if (this.state === 'INTERRUPT_SPEAKING') {
      return {
        coreInner: 'hsla(16, 96%, 64%, 0.95)',
        coreMid: 'hsla(34, 95%, 54%, 0.45)',
        coreStroke: 'hsla(24, 96%, 68%, 0.95)',
        crownStroke: 'hsla(14, 92%, 62%, 0.95)',
        glow: 'hsla(14, 95%, 58%, 0.85)',
        ringStroke: (a) => `hsla(22, 92%, 62%, ${a})`,
        octagramStroke: 'hsla(38, 92%, 66%, 0.48)',
        horizonMist: 'hsla(16, 75%, 32%, 0.25)',
        skylineLine: 'hsla(28, 88%, 58%, 0.55)',
        skylineAccent: 'hsla(16, 92%, 62%, 0.7)'
      };
    }

    if (this.state === 'SILENT_APPROVAL') {
      return {
        coreInner: 'hsla(160, 75%, 56%, 0.88)',
        coreMid: 'hsla(42, 82%, 55%, 0.28)',
        coreStroke: 'hsla(160, 70%, 60%, 0.88)',
        crownStroke: 'hsla(42, 85%, 64%, 0.8)',
        glow: 'hsla(160, 75%, 50%, 0.6)',
        ringStroke: (a) => `hsla(158, 65%, 55%, ${a})`,
        octagramStroke: 'hsla(42, 78%, 60%, 0.34)',
        horizonMist: 'hsla(160, 50%, 22%, 0.16)',
        skylineLine: 'hsla(42, 68%, 52%, 0.42)',
        skylineAccent: 'hsla(160, 70%, 55%, 0.55)'
      };
    }

    if (this.state === 'LISTENING') {
      return {
        coreInner: 'hsla(42, 95%, 68%, 0.92)',
        coreMid: 'hsla(36, 88%, 52%, 0.34)',
        coreStroke: 'hsla(42, 90%, 66%, 0.9)',
        crownStroke: 'hsla(38, 92%, 64%, 0.88)',
        glow: 'hsla(40, 92%, 58%, 0.65)',
        ringStroke: (a) => `hsla(42, 88%, 62%, ${a})`,
        octagramStroke: 'hsla(42, 82%, 62%, 0.38)',
        horizonMist: 'hsla(36, 72%, 26%, 0.22)',
        skylineLine: 'hsla(42, 72%, 54%, 0.48)',
        skylineAccent: 'hsla(42, 88%, 64%, 0.65)'
      };
    }

    // IDLE
    return {
      coreInner: 'hsla(42, 86%, 64%, 0.82)',
      coreMid: 'hsla(35, 76%, 46%, 0.22)',
      coreStroke: 'hsla(42, 78%, 58%, 0.78)',
      crownStroke: 'hsla(40, 75%, 58%, 0.68)',
      glow: 'hsla(40, 82%, 54%, 0.45)',
      ringStroke: (a) => `hsla(40, 75%, 58%, ${a * 0.85})`,
      octagramStroke: 'hsla(40, 68%, 55%, 0.26)',
      horizonMist: 'hsla(34, 62%, 20%, 0.18)',
      skylineLine: 'hsla(40, 58%, 46%, 0.38)',
      skylineAccent: 'hsla(42, 75%, 56%, 0.5)'
    };
  }

  animate() {
    this.time += 0.016;
    const ctx = this.ctx;
    const { width, height } = this;

    // Sample live audio analyser if connected
    if (this.analyser && this.freqData) {
      this.analyser.getByteFrequencyData(this.freqData);
      let sum = 0;
      const count = Math.min(40, this.freqData.length);
      for (let i = 0; i < count; i++) sum += this.freqData[i];
      const liveLevel = sum / (count * 255);
      this.targetEnergy = Math.max(liveLevel, this.targetEnergy * 0.92);
    } else if (this.state === 'INTERRUPT_SPEAKING') {
      // Expressive speech cadence simulation when Web Speech / buffer plays
      this.targetEnergy =
        0.45 +
        0.35 * Math.abs(Math.sin(this.time * 11)) * Math.cos(this.time * 4.3);
    } else if (this.state === 'LISTENING') {
      this.targetEnergy = Math.max(this.targetEnergy * 0.9, 0.14 + 0.06 * Math.sin(this.time * 4));
    } else {
      this.targetEnergy *= 0.88;
    }

    this.audioEnergy += (this.targetEnergy - this.audioEnergy) * 0.18;
    this.interruptFlash *= 0.93;
    this.silentPulse *= 0.95;

    ctx.clearRect(0, 0, width, height);

    const palette = this.getPalette();
    const cx = width * 0.5;
    const cy = height * 0.355;
    const baseR = Math.min(width, height) * 0.195;

    // 1. Subtle desert night stars
    for (const st of this.stars) {
      const twinkle = 0.25 + 0.55 * Math.sin(this.time * st.speed * 30 + st.phase);
      ctx.fillStyle = `hsla(42, 70%, 82%, ${twinkle * 0.55})`;
      ctx.beginPath();
      ctx.arc(st.x * width, st.y * height, st.size, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2. Interrupt shockwave ring when Edge cuts in mid-sentence
    if (this.interruptFlash > 0.02) {
      const shockR = baseR * (1.1 + (1 - this.interruptFlash) * 1.9);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, shockR, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(16, 95%, 62%, ${this.interruptFlash * 0.75})`;
      ctx.lineWidth = 3.5 * this.interruptFlash;
      ctx.stroke();
      ctx.restore();
    }

    // 3. Silent approval golden-emerald ripple when opinion/truth verified
    if (this.silentPulse > 0.02) {
      const nodR = baseR * (1.0 + (1 - this.silentPulse) * 1.35);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, nodR, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(160, 75%, 56%, ${this.silentPulse * 0.65})`;
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.restore();
    }

    // 4. Outer Sacred Geometry Mashrabiya Octagrams
    this.drawMashrabiyaStar(
      cx,
      cy,
      baseR * 1.34 + this.audioEnergy * 14,
      8,
      this.time * 0.12,
      palette.octagramStroke,
      1.1
    );
    this.drawMashrabiyaStar(
      cx,
      cy,
      baseR * 1.14 + this.audioEnergy * 10,
      8,
      -this.time * 0.18,
      palette.octagramStroke,
      1.0
    );

    // 5. Calligraphic Torus Orbits
    this.drawCalligraphicTorus(cx, cy, baseR * 0.9, this.audioEnergy, palette);

    // 6. Audio-Reactive Frequency Crown
    this.drawFrequencyCrown(cx, cy, baseR * 0.82, this.audioEnergy, palette);

    // 7. Central Edge Falcon-Torus Core
    this.drawCoreFalconEye(cx, cy, baseR * 0.64, this.audioEnergy, palette);

    // 8. Orbiting Desert Gold Dust Particles
    for (const p of this.particles) {
      p.angle += p.speed * (1 + this.audioEnergy * 2.8);
      const r = p.radius * (baseR / 115) + this.audioEnergy * 22;
      const px = cx + Math.cos(p.angle) * r;
      const py = cy + Math.sin(p.angle) * (r * 0.68);
      const hue = this.state === 'INTERRUPT_SPEAKING' ? 18 + p.hueOffset : 42 + p.hueOffset;
      ctx.fillStyle = `hsla(${hue}, 88%, 68%, ${p.alpha})`;
      ctx.beginPath();
      ctx.arc(px, py, p.size, 0, Math.PI * 2);
      ctx.fill();
    }

    // 9. Modern Dubai Architectural Skyline Horizon
    this.drawDubaiSkyline(width, height, palette);

    requestAnimationFrame(this.animate);
  }
}
