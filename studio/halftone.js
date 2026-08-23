"use strict";
/* ==========================================================================
   GLUED — HALFTONE  ·  effect module (Three.js)

   A block-based print-process shader — halftone dots, ordered dithering,
   pixelation and ASCII, each computed per grid cell from the source media's
   luminance, with the cell scale itself varying across the frame (radially,
   diagonally, or along an axis) so the pattern reads as one continuous
   engraving rather than a uniform filter.

   Self-contained module, loaded lazily by switchEffect() in
   thermal_script.js only when this effect is selected — same lazy-load,
   mount()/unmount() contract as every other effect module here. unmount()
   disposes the renderer, geometry/material, textures and video element, and
   removes all of its DOM; nothing survives a switch away from it.
   ========================================================================== */
(function(){
  const THREE_VER = '0.170.0';
  const CDN = `https://cdn.jsdelivr.net/npm/three@${THREE_VER}`;
  let modulePromise = null;
  function ensureImportMap(){
    if(document.querySelector('script[type="importmap"]')) return;
    const s = document.createElement('script');
    s.type = 'importmap';
    s.textContent = JSON.stringify({imports: {three: `${CDN}/build/three.module.js`}});
    document.head.appendChild(s);
  }
  function loadThree(){
    if(!modulePromise){
      ensureImportMap();
      modulePromise = import(`${CDN}/build/three.module.js`);
    }
    return modulePromise;
  }

  const EFFECT_MODES = ['Random Cycle','Clean','Halftone','Dither','Pixelate','ASCII'];
  const SCALE_DIRS = ['Horizontal','Vertical','Radial','Diagonal'];
  const EXPORT_SIZES = {
    '1080x1350':[1080,1350], '1080x1080':[1080,1080], '1920x1080':[1920,1080],
    '1080x1920':[1080,1920], '2160x2700':[2160,2700], '2160x2160':[2160,2160],
    '3840x2160':[3840,2160], '2160x3840':[2160,3840],
  };

  const PRESETS = {
    newsprint: {effectMode:'Halftone', inkColor:'#111111', paperColor:'#f2ede2', contrast:1.1, gamma:1.3, gridX:9, gridY:12, scaleMin:40, scaleMax:420, scaleDirection:'Radial'},
    dither:    {effectMode:'Dither',   inkColor:'#0a0a0a', paperColor:'#ffffff', contrast:1.2, gamma:1.0, gridX:6, gridY:8,  scaleMin:60, scaleMax:260, scaleDirection:'Diagonal'},
    ascii:     {effectMode:'ASCII',    inkColor:'#39ff88', paperColor:'#050505', contrast:1.3, gamma:1.1, gridX:8, gridY:8,  scaleMin:30, scaleMax:60,  scaleDirection:'Vertical'},
    random:    {effectMode:'Random Cycle', inkColor:'#003300', paperColor:'#ccffcc', contrast:0.9, gamma:1.4, gridX:5, gridY:7, scaleMin:50, scaleMax:497, scaleDirection:'Radial'},
  };

  let canvas = null, renderer = null, scene = null, camera = null, mesh = null, material = null;
  let sourceCanvas = null, sctx = null, canvasTexture = null;
  let video = null, videoTexture = null, imageTexture = null, usingCustomMedia = false;
  let currentObjectURL = null;
  let raf = null, onResize = null, container = null;
  let THREENS = null;
  const clockState = {last: 0};
  const state = {
    animate: true, effectMode: 'Random Cycle', effectMix: 2.7,
    mediaType: 'Video',
    gridX: 5, gridY: 7, scaleMin: 50, scaleMax: 497, scaleDirection: 'Radial',
    inkColor: '#003300', paperColor: '#ccffcc', contrast: 0.9, gamma: 1.4,
    animationSpeed: 0.4,
  };
  const sliderCleanup = [];

  const vertexShader = `
    varying vec2 vUv;
    void main(){
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `;

  const fragmentShader = `
    precision highp float;
    varying vec2 vUv;

    uniform vec2 u_resolution;
    uniform float u_time;
    uniform sampler2D u_texture;

    uniform vec2 u_blockCount;
    uniform float u_scaleMin;
    uniform float u_scaleMax;
    uniform int u_scaleDirection;

    uniform vec3 u_inkColor;
    uniform vec3 u_paperColor;

    uniform float u_effectMix;
    uniform float u_contrast;
    uniform float u_gamma;
    uniform bool u_animate;
    uniform int u_effectMode;

    float bayer4(vec2 uv) {
      vec2 p = floor(mod(uv, 4.0));
      int x = int(p.x);
      int y = int(p.y);
      if (y == 0) { if (x == 0) return 0.0/16.0; if (x == 1) return 8.0/16.0; if (x == 2) return 2.0/16.0; return 10.0/16.0; }
      if (y == 1) { if (x == 0) return 12.0/16.0; if (x == 1) return 4.0/16.0; if (x == 2) return 14.0/16.0; return 6.0/16.0; }
      if (y == 2) { if (x == 0) return 3.0/16.0; if (x == 1) return 11.0/16.0; if (x == 2) return 1.0/16.0; return 9.0/16.0; }
      if (x == 0) return 15.0/16.0; if (x == 1) return 7.0/16.0; if (x == 2) return 13.0/16.0; return 5.0/16.0;
    }

    float getLuminance(vec3 color) {
      float l = dot(color, vec3(0.299, 0.587, 0.114));
      l = pow(l, u_gamma);
      l = (l - 0.5) * u_contrast + 0.5;
      return clamp(l, 0.0, 1.0);
    }

    vec3 applyHalftone(vec2 uv, float scale) {
      vec2 grid = uv * scale;
      vec2 p = fract(grid) - 0.5;
      vec2 id = floor(grid) / scale;
      float l = getLuminance(texture2D(u_texture, id).rgb);
      float r = (1.0 - l) * 0.6;
      float dist = length(p);
      float mask = smoothstep(r, r - 0.05, dist);
      return mix(u_paperColor, u_inkColor, mask);
    }

    vec3 applyDither(vec2 uv, float scale) {
      float l = getLuminance(texture2D(u_texture, uv).rgb);
      float threshold = bayer4(gl_FragCoord.xy / (scale * 0.05));
      return l < threshold ? u_inkColor : u_paperColor;
    }

    vec3 applyPixelate(vec2 uv, float scale) {
      vec2 grid = floor(uv * scale) / scale;
      float l = getLuminance(texture2D(u_texture, grid).rgb);
      float q = floor(l * 3.0) / 2.0;
      return mix(u_inkColor, u_paperColor, q);
    }

    float character(int id, vec2 p) {
      vec2 i = floor(p * vec2(3.0, 5.0));
      int bit = int(i.x + (4.0 - i.y) * 3.0);
      int mask = 0;
      if (id == 1) mask = 8192;
      else if (id == 2) mask = 1040;
      else if (id == 3) mask = 9402;
      else if (id == 4) mask = 31727;
      else if (id == 5) mask = 32767;
      float res = 0.0;
      float pow2 = 1.0;
      for(int b = 0; b < 15; b++) {
          if (b == bit) { res = mod(floor(float(mask) / pow2), 2.0); break; }
          pow2 *= 2.0;
      }
      return res;
    }

    vec3 applyASCII(vec2 uv, float scale) {
      float charScale = scale * 0.5;
      vec2 gridRes = vec2(charScale * (u_resolution.x / u_resolution.y) * 1.6, charScale);
      vec2 grid = uv * gridRes;
      vec2 p = fract(grid);
      vec2 id = floor(grid) / gridRes;
      float l = getLuminance(texture2D(u_texture, id).rgb);
      int charId = int(clamp((1.0 - l) * 5.99, 0.0, 5.0));
      float mask = character(charId, p);
      return mix(u_paperColor, u_inkColor, mask);
    }

    void main() {
      vec2 uv = vUv;
      vec2 blockId = floor(uv * u_blockCount);
      vec2 blockUV = fract(uv * u_blockCount);

      float p = 0.0;
      vec2 normBlock = blockId / max(u_blockCount - 1.0, vec2(1.0));
      if (u_scaleDirection == 0) p = normBlock.x;
      else if (u_scaleDirection == 1) p = 1.0 - normBlock.y;
      else if (u_scaleDirection == 2) p = distance(normBlock, vec2(0.5)) * 1.414;
      else p = (normBlock.x + (1.0 - normBlock.y)) * 0.5;

      float scale = mix(u_scaleMin, u_scaleMax, clamp(p, 0.0, 1.0));

      if (u_animate) {
          scale *= 1.0 + 0.15 * sin(u_time * 2.0 + blockId.x * 0.5 + blockId.y * 0.3);
      }

      float effectSeed = fract(sin(dot(blockId, vec2(12.9898, 78.233))) * 43758.5453);
      float effectType = mod(floor(effectSeed * 5.0 + u_effectMix + (u_animate ? u_time * 0.5 : 0.0)), 5.0);

      if (u_effectMode > 0) {
          effectType = float(u_effectMode - 1);
      }

      vec3 color;
      if (effectType < 1.0) {
          color = mix(u_inkColor, u_paperColor, getLuminance(texture2D(u_texture, uv).rgb));
      } else if (effectType < 2.0) {
          color = applyHalftone(uv, scale);
      } else if (effectType < 3.0) {
          color = applyDither(uv, scale);
      } else if (effectType < 4.0) {
          color = applyPixelate(uv, scale);
      } else {
          color = applyASCII(uv, scale);
      }

      gl_FragColor = vec4(color, 1.0);
    }
  `;

  function drawProceduralFrame(t){
    const w = sourceCanvas.width, h = sourceCanvas.height, cx = w/2, cy = h/2;
    sctx.fillStyle = '#000'; sctx.fillRect(0,0,w,h);
    for(let i=0;i<7;i++){
      const a = t*0.0003 + i*(Math.PI*2/7);
      const r = Math.min(w,h)*0.28;
      const x = cx + Math.cos(a)*r*0.6;
      const y = cy + Math.sin(a)*r*0.6;
      const petal = 40 + 30*Math.sin(t*0.001 + i);
      const grad = sctx.createRadialGradient(x,y,0,x,y,petal);
      grad.addColorStop(0, 'rgba(255,255,255,0.95)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      sctx.fillStyle = grad;
      sctx.beginPath(); sctx.arc(x,y,petal,0,Math.PI*2); sctx.fill();
    }
    const grad2 = sctx.createRadialGradient(cx,cy,0,cx,cy,Math.min(w,h)*0.5);
    grad2.addColorStop(0,'rgba(255,255,255,0.6)');
    grad2.addColorStop(1,'rgba(255,255,255,0)');
    sctx.fillStyle = grad2;
    sctx.beginPath(); sctx.arc(cx,cy,Math.min(w,h)*0.5,0,Math.PI*2); sctx.fill();
  }

  function bindSlider(id, valId, onChange, fmt){
    const el = document.getElementById(id), val = document.getElementById(valId);
    if(!el) return;
    const handler = () => {
      const v = parseFloat(el.value);
      if(val) val.textContent = fmt ? fmt(v) : v;
      onChange(v);
    };
    el.addEventListener('input', handler);
    sliderCleanup.push(() => el.removeEventListener('input', handler));
  }
  function bindColor(id, onChange){
    const el = document.getElementById(id);
    if(!el) return;
    const handler = () => onChange(el.value);
    el.addEventListener('input', handler);
    sliderCleanup.push(() => el.removeEventListener('input', handler));
  }
  function bindSelect(id, onChange){
    const el = document.getElementById(id);
    if(!el) return;
    const handler = () => onChange(el.value);
    el.addEventListener('change', handler);
    sliderCleanup.push(() => el.removeEventListener('change', handler));
  }

  function wireTabs(){
    const tabs = [...document.querySelectorAll('#htTabs .tab')];
    const panes = [...document.querySelectorAll('#htPanes .pane')];
    tabs.forEach(btn=>{
      const handler = () => {
        tabs.forEach(t => t.classList.toggle('on', t === btn));
        panes.forEach(p => p.classList.toggle('on', p.dataset.htpane === btn.dataset.httab));
      };
      btn.addEventListener('click', handler);
      sliderCleanup.push(() => btn.removeEventListener('click', handler));
    });
  }

  function refreshUIFromState(){
    const setRange = (id, valId, v, fmt) => {
      const el = document.getElementById(id), val = document.getElementById(valId);
      if(el) el.value = v;
      if(val) val.textContent = fmt ? fmt(v) : v;
    };
    setRange('htGridX','htGridXVal', state.gridX, v=>Math.round(v));
    setRange('htGridY','htGridYVal', state.gridY, v=>Math.round(v));
    setRange('htScaleMin','htScaleMinVal', state.scaleMin, v=>Math.round(v));
    setRange('htScaleMax','htScaleMaxVal', state.scaleMax, v=>Math.round(v));
    setRange('htContrast','htContrastVal', state.contrast, v=>v.toFixed(1));
    setRange('htGamma','htGammaVal', state.gamma, v=>v.toFixed(1));
    setRange('htEffectMix','htEffectMixVal', state.effectMix, v=>v.toFixed(1));
    const inkEl = document.getElementById('htInkColor'); if(inkEl) inkEl.value = state.inkColor;
    const paperEl = document.getElementById('htPaperColor'); if(paperEl) paperEl.value = state.paperColor;
    const modeEl = document.getElementById('htEffectMode'); if(modeEl) modeEl.value = state.effectMode;
    const dirEl = document.getElementById('htScaleDirection'); if(dirEl) dirEl.value = state.scaleDirection;
  }

  function applyPreset(key){
    const p = PRESETS[key];
    if(!p || !material) return;
    Object.assign(state, p);
    material.uniforms.u_effectMode.value = EFFECT_MODES.indexOf(state.effectMode);
    material.uniforms.u_inkColor.value.set(state.inkColor);
    material.uniforms.u_paperColor.value.set(state.paperColor);
    material.uniforms.u_contrast.value = state.contrast;
    material.uniforms.u_gamma.value = state.gamma;
    material.uniforms.u_blockCount.value.set(state.gridX, state.gridY);
    material.uniforms.u_scaleMin.value = state.scaleMin;
    material.uniforms.u_scaleMax.value = state.scaleMax;
    material.uniforms.u_scaleDirection.value = SCALE_DIRS.indexOf(state.scaleDirection);
    refreshUIFromState();
  }

  function wirePresets(){
    const chips = [...document.querySelectorAll('#htPresets .chip')];
    chips.forEach(chip=>{
      const handler = () => {
        chips.forEach(c => c.classList.toggle('on', c === chip));
        applyPreset(chip.dataset.htpreset);
      };
      chip.addEventListener('click', handler);
      sliderCleanup.push(() => chip.removeEventListener('click', handler));
    });
  }

  function loadFile(file){
    if(currentObjectURL){ URL.revokeObjectURL(currentObjectURL); currentObjectURL = null; }
    const url = URL.createObjectURL(file);
    currentObjectURL = url;
    usingCustomMedia = true;
    const isVideo = /^video\//i.test(file.type) || /\.(mp4|mov|m4v|webm)$/i.test(file.name);
    if(isVideo){
      video.src = url; video.play().catch(()=>{});
      state.mediaType = 'Video';
      const sel = document.getElementById('htMediaType'); if(sel) sel.value = 'Video';
      material.uniforms.u_texture.value = videoTexture;
    } else {
      if(imageTexture) imageTexture.dispose();
      imageTexture = new THREENS.TextureLoader().load(url);
      imageTexture.colorSpace = THREENS.SRGBColorSpace;
      state.mediaType = 'Image';
      const sel = document.getElementById('htMediaType'); if(sel) sel.value = 'Image';
      material.uniforms.u_texture.value = imageTexture;
    }
    const label = document.getElementById('htSrcName');
    if(label) label.textContent = file.name;
  }

  function wireSourceControls(){
    const fileInput = document.getElementById('htFile');
    const openBtn = document.getElementById('htOpen');
    if(openBtn && fileInput){
      const openHandler = () => fileInput.click();
      openBtn.addEventListener('click', openHandler);
      sliderCleanup.push(() => openBtn.removeEventListener('click', openHandler));

      const changeHandler = () => {
        const file = fileInput.files && fileInput.files[0];
        if(file) loadFile(file);
        fileInput.value = '';
      };
      fileInput.addEventListener('change', changeHandler);
      sliderCleanup.push(() => fileInput.removeEventListener('change', changeHandler));
    }
    const dropHandler = (e) => {
      e.preventDefault();
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if(file) loadFile(file);
    };
    const overHandler = (e) => e.preventDefault();
    container.addEventListener('dragover', overHandler);
    container.addEventListener('drop', dropHandler);
    sliderCleanup.push(() => { container.removeEventListener('dragover', overHandler); container.removeEventListener('drop', dropHandler); });

    bindSelect('htMediaType', v => {
      state.mediaType = v;
      if(usingCustomMedia){
        material.uniforms.u_texture.value = v === 'Video' ? videoTexture : (imageTexture || canvasTexture);
        if(v === 'Video' && video.src) video.play().catch(()=>{}); else video.pause();
      }
    });
  }

  function wireControls(){
    bindSelect('htEffectMode', v => { state.effectMode = v; material.uniforms.u_effectMode.value = EFFECT_MODES.indexOf(v); });
    bindSlider('htEffectMix', 'htEffectMixVal', v => { state.effectMix = v; material.uniforms.u_effectMix.value = v; }, v=>v.toFixed(1));

    bindSlider('htGridX', 'htGridXVal', v => { state.gridX = v; material.uniforms.u_blockCount.value.setX(v); }, v=>Math.round(v));
    bindSlider('htGridY', 'htGridYVal', v => { state.gridY = v; material.uniforms.u_blockCount.value.setY(v); }, v=>Math.round(v));
    bindSlider('htScaleMin', 'htScaleMinVal', v => { state.scaleMin = v; material.uniforms.u_scaleMin.value = v; }, v=>Math.round(v));
    bindSlider('htScaleMax', 'htScaleMaxVal', v => { state.scaleMax = v; material.uniforms.u_scaleMax.value = v; }, v=>Math.round(v));
    bindSelect('htScaleDirection', v => { state.scaleDirection = v; material.uniforms.u_scaleDirection.value = SCALE_DIRS.indexOf(v); });

    bindColor('htInkColor', v => { state.inkColor = v; material.uniforms.u_inkColor.value.set(v); });
    bindColor('htPaperColor', v => { state.paperColor = v; material.uniforms.u_paperColor.value.set(v); });
    bindSlider('htContrast', 'htContrastVal', v => { state.contrast = v; material.uniforms.u_contrast.value = v; }, v=>v.toFixed(1));
    bindSlider('htGamma', 'htGammaVal', v => { state.gamma = v; material.uniforms.u_gamma.value = v; }, v=>v.toFixed(1));

    bindSlider('htSpeed', 'htSpeedVal', v => { state.animationSpeed = v; }, v=>v.toFixed(1));
    const animBtn = document.getElementById('htAnimate');
    if(animBtn){
      const handler = () => {
        state.animate = !state.animate;
        animBtn.classList.toggle('on', state.animate);
        material.uniforms.u_animate.value = state.animate;
      };
      animBtn.addEventListener('click', handler);
      sliderCleanup.push(() => animBtn.removeEventListener('click', handler));
    }

    const exportBtn = document.getElementById('htExport');
    const sizeSel = document.getElementById('htExportSize');
    if(exportBtn){
      const handler = () => exportPNG(sizeSel ? sizeSel.value : 'window');
      exportBtn.addEventListener('click', handler);
      sliderCleanup.push(() => exportBtn.removeEventListener('click', handler));
    }

    wireTabs();
    wirePresets();
    wireSourceControls();
  }

  function exportPNG(sizeKey){
    const dims = EXPORT_SIZES[sizeKey] || [canvas.width, canvas.height];
    const [w, h] = dims;
    const exportRenderer = new THREENS.WebGLRenderer({antialias:true, preserveDrawingBuffer:true});
    exportRenderer.setSize(w, h, false);
    exportRenderer.outputColorSpace = THREENS.SRGBColorSpace;
    const prevRes = material.uniforms.u_resolution.value.clone();
    material.uniforms.u_resolution.value.set(w, h);
    exportRenderer.render(scene, camera);
    const url = exportRenderer.domElement.toDataURL('image/png');
    material.uniforms.u_resolution.value.copy(prevRes);
    exportRenderer.dispose();
    const link = document.createElement('a');
    link.download = 'halftone.png';
    link.href = url;
    link.click();
  }

  function frame(){
    raf = requestAnimationFrame(frame);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if(w && h && (canvas.width !== Math.round(w*renderer.getPixelRatio()) || canvas.height !== Math.round(h*renderer.getPixelRatio()))){
      renderer.setSize(w, h, false);
      material.uniforms.u_resolution.value.set(w, h);
    }
    if(!usingCustomMedia){
      drawProceduralFrame(performance.now());
      canvasTexture.needsUpdate = true;
    }
    const now = performance.now();
    const dt = clockState.last ? (now - clockState.last) / 1000 : 0;
    clockState.last = now;
    if(state.animate) material.uniforms.u_time.value += dt * state.animationSpeed;
    renderer.render(scene, camera);
  }

  async function mount(el){
    unmount();
    container = el;
    canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    container.appendChild(canvas);
    const myCanvas = canvas;

    const THREE = await loadThree();
    if(canvas !== myCanvas) return;
    THREENS = THREE;

    renderer = new THREE.WebGLRenderer({canvas, alpha:true, antialias:true, preserveDrawingBuffer:true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 512; sourceCanvas.height = 512;
    sctx = sourceCanvas.getContext('2d');
    canvasTexture = new THREE.CanvasTexture(sourceCanvas);
    canvasTexture.colorSpace = THREE.SRGBColorSpace;

    video = document.createElement('video');
    video.loop = true; video.muted = true; video.playsInline = true; video.crossOrigin = 'anonymous';
    videoTexture = new THREE.VideoTexture(video);
    videoTexture.colorSpace = THREE.SRGBColorSpace;

    clockState.last = 0;

    material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader,
      uniforms: {
        u_time: { value: 0 },
        u_resolution: { value: new THREE.Vector2(canvas.clientWidth||1, canvas.clientHeight||1) },
        u_texture: { value: canvasTexture },
        u_blockCount: { value: new THREE.Vector2(state.gridX, state.gridY) },
        u_scaleMin: { value: state.scaleMin },
        u_scaleMax: { value: state.scaleMax },
        u_scaleDirection: { value: SCALE_DIRS.indexOf(state.scaleDirection) },
        u_inkColor: { value: new THREE.Color(state.inkColor) },
        u_paperColor: { value: new THREE.Color(state.paperColor) },
        u_effectMix: { value: state.effectMix },
        u_contrast: { value: state.contrast },
        u_gamma: { value: state.gamma },
        u_animate: { value: state.animate },
        u_effectMode: { value: EFFECT_MODES.indexOf(state.effectMode) },
      },
    });
    mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    scene.add(mesh);

    renderer.setSize(canvas.clientWidth||1, canvas.clientHeight||1, false);

    wireControls();
    onResize = () => {
      if(!canvas.clientWidth || !canvas.clientHeight) return;
      renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
      material.uniforms.u_resolution.value.set(canvas.clientWidth, canvas.clientHeight);
    };
    window.addEventListener('resize', onResize);
    frame();
  }

  function unmount(){
    if(raf){ cancelAnimationFrame(raf); raf = null; }
    if(onResize){ window.removeEventListener('resize', onResize); onResize = null; }
    sliderCleanup.forEach(fn => fn()); sliderCleanup.length = 0;
    if(video){ video.pause(); video.removeAttribute('src'); video.load(); video = null; }
    if(currentObjectURL){ URL.revokeObjectURL(currentObjectURL); currentObjectURL = null; }
    if(videoTexture){ videoTexture.dispose(); videoTexture = null; }
    if(imageTexture){ imageTexture.dispose(); imageTexture = null; }
    if(canvasTexture){ canvasTexture.dispose(); canvasTexture = null; }
    if(mesh){ mesh.geometry.dispose(); mesh = null; }
    if(material){ material.dispose(); material = null; }
    if(renderer){ renderer.dispose(); renderer = null; }
    scene = null; camera = null; sourceCanvas = null; sctx = null; THREENS = null;
    usingCustomMedia = false;
    if(canvas){ canvas.remove(); canvas = null; }
    container = null;
  }

  window.Halftone = { mount, unmount };
})();
