"use strict";
/* ==========================================================================
   GLUED — THERMAL  ·  script

   One scalar field, pushed through one colour ramp:

     source (text | svg | png/jpg | mp4/mov)  ->  2D canvas
     -> ingest   luminance, invert, level
     -> blur     separable gaussian on a mip pyramid
     -> heat     noise domain-warp along the field gradient
     -> fall     exponential directional streak
     -> compose  max of sharp + drip, mapped through a 1D ramp

   Every slider can be driven by its own fbm noise generator, the way a
   Maxon / Blender noise modifier drives a channel.

   Export: WebCodecs H.264 -> MP4, or PNG frames -> QuickTime with alpha.

   CONTENTS
      1. CANVAS & WEBGL CONTEXT
      2. COLOUR RAMPS
      3. SHADERS
      4. GL PROGRAMS, TEXTURES, PYRAMID
      5. PARAMETERS & NOISE MODULATION
      6. SOURCE — TEXT / IMAGE / VIDEO
      7. TIMELINE
      8. RENDER PIPELINE
      9. STAGE BACKGROUND & MAIN LOOP
     10. FILE IMPORT
     11. EXPORT — MP4 / ALPHA MOV
     12. PRESETS
     13. UI — TABS, PARAMS, CONTROLS
     14. STAGE SHORTCUT BUBBLE
     15. THEME MANAGEMENT (DARK/LIGHT)
     16. BOOT
   ========================================================================== */

// ==========================================
// 1. CANVAS & WEBGL CONTEXT
// ==========================================
const cvs = document.getElementById('gl');
const gl  = cvs.getContext('webgl2', {alpha:true, antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true});
if(!gl){ document.querySelector('.stage').innerHTML =
  '<p style="color:#FF6C00;padding:2rem;font:14px Poppins,sans-serif">WebGL2 is not available in this browser.</p>'; }

// ==========================================
// 2. COLOUR RAMPS
// ==========================================
/* ---------- colour ramps ---------- */
const PALETTES = {
  thermal: [[0.000,0,0,0],[0.055,26,12,26],[0.120,58,44,92],[0.190,64,92,186],[0.280,74,148,248],
            [0.390,150,208,253],[0.480,220,240,255],[0.545,252,254,253],[0.615,254,254,152],
            [0.690,250,220,72],[0.775,243,165,57],[0.865,234,51,35],[1.000,236,40,26]],
  ember:   [[0.000,0,0,0],[0.090,24,0,0],[0.185,118,40,12],[0.265,255,140,20],[0.340,232,250,214],
            [0.415,255,208,255],[0.500,255,58,158],[0.610,253,0,0],[1.000,253,0,0]],
  plasma:  [[0.000,0,0,0],[0.100,20,0,40],[0.230,110,0,160],[0.360,214,30,190],[0.480,255,110,120],
            [0.590,255,235,190],[0.700,120,255,235],[0.820,20,170,255],[0.900,60,40,255],[1.000,90,20,255]],
  mono:    [[0.000,0,0,0],[0.250,40,42,48],[0.500,124,128,138],[0.760,226,229,236],[1.000,255,255,255]],
};

function buildLUT(name, hueDeg){
  const stops = PALETTES[name] || PALETTES.thermal;
  const N = 512, data = new Uint8Array(N*4);
  const rad = hueDeg*Math.PI/180, cs = Math.cos(rad), sn = Math.sin(rad);
  const m = [
    0.213+cs*0.787-sn*0.213, 0.715-cs*0.715-sn*0.715, 0.072-cs*0.072+sn*0.928,
    0.213-cs*0.213+sn*0.143, 0.715+cs*0.285+sn*0.140, 0.072-cs*0.072-sn*0.283,
    0.213-cs*0.213-sn*0.787, 0.715-cs*0.715+sn*0.715, 0.072+cs*0.928+sn*0.072];
  let si = 0;
  for(let i=0;i<N;i++){
    const t = i/(N-1);
    while(si < stops.length-2 && t > stops[si+1][0]) si++;
    const a = stops[si], b = stops[si+1];
    const f = Math.min(1, Math.max(0, (t-a[0]) / Math.max(1e-6, b[0]-a[0])));
    const r = a[1]+(b[1]-a[1])*f, g = a[2]+(b[2]-a[2])*f, bl = a[3]+(b[3]-a[3])*f;
    const nr = m[0]*r+m[1]*g+m[2]*bl, ng = m[3]*r+m[4]*g+m[5]*bl, nb = m[6]*r+m[7]*g+m[8]*bl;
    data[i*4+0]=Math.min(255,Math.max(0,nr)); data[i*4+1]=Math.min(255,Math.max(0,ng));
    data[i*4+2]=Math.min(255,Math.max(0,nb)); data[i*4+3]=255;
  }
  return {data, N};
}

// ==========================================
// 3. SHADERS
// ==========================================
/* ---------- shaders ---------- */
const VS = `#version 300 es
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position = vec4(p*2.0-1.0,0.0,1.0); }`;

const FS_INGEST = `#version 300 es
precision highp float;
uniform sampler2D uTex; uniform vec2 uTexel; uniform float uInvert; uniform float uLevel;
out vec4 outColor;
void main(){
  vec3 c = texture(uTex, gl_FragCoord.xy * uTexel).rgb;
  float v = dot(c, vec3(0.2126, 0.7152, 0.0722));
  v = mix(v, 1.0 - v, uInvert);
  v = pow(clamp(v, 0.0, 1.0), uLevel);
  outColor = vec4(vec3(v), 1.0);
}`;

const FS_BLUR = `#version 300 es
precision highp float;
uniform sampler2D uTex; uniform vec2 uTexel; uniform vec2 uDir; uniform float uStep;
out vec4 outColor;
const float O1 = 1.3846153846, O2 = 3.2307692308;
const float W0 = 0.2270270270, W1 = 0.3162162162, W2 = 0.0702702703;
void main(){
  vec2 uv = gl_FragCoord.xy * uTexel;
  vec2 d  = uDir * uTexel * uStep;
  float c = texture(uTex, uv).r * W0;
  c += (texture(uTex, uv + d*O1).r + texture(uTex, uv - d*O1).r) * W1;
  c += (texture(uTex, uv + d*O2).r + texture(uTex, uv - d*O2).r) * W2;
  outColor = vec4(vec3(c), 1.0);
}`;


/* value-noise fbm, shared by the heat warp and the nebula smear */
const GLSL_NOISE = `
float hash(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123); }
float vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f*f*(3.0 - 2.0*f);
  return mix(mix(mix(hash(i+vec3(0,0,0)), hash(i+vec3(1,0,0)), f.x),
                 mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x),
                 mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p){
  float s = 0.0, a = 0.5;
  for(int i=0;i<3;i++){ s += a * vnoise(p); p = p*2.07 + 11.3; a *= 0.5; }
  return s / 0.875;
}
/* Seamless cycle: sample the field drifting forward from here, and the same
   field drifting in from one loop back, then crossfade across the loop. At
   phase 0 and phase 1 both terms land on the identical field, so an exported
   clip repeats with no seam. */
float fbmLoop(vec3 p, vec3 drift, float ph){
  return mix(fbm(p + drift * ph), fbm(p + drift * (ph - 1.0)), ph);
}
`;

/* Convecting fbm noise displaces the field along its own gradient, so the
 * edge advances and retreats in tongues instead of wobbling as a whole.
 * The displacement is windowed to the fringe band — the hot core stays
 * put, like the quiet photosphere under a moving prominence. */
const FS_HEAT = `#version 300 es
precision highp float;
uniform sampler2D uTex; uniform vec2 uTexel; uniform vec2 uAspect;
uniform float uPhase, uHeat, uScale, uFlow, uLick;
out vec4 outColor;
` + GLSL_NOISE + `
void main(){
  vec2 uv = gl_FragCoord.xy * uTexel;
  float v = texture(uTex, uv).r;
  vec2 e = uTexel * 2.0;
  vec2 g = vec2(texture(uTex, uv + vec2(e.x,0.0)).r - texture(uTex, uv - vec2(e.x,0.0)).r,
                texture(uTex, uv + vec2(0.0,e.y)).r - texture(uTex, uv - vec2(0.0,e.y)).r);
  vec2 n = g / (length(g) + 1e-4);
  vec3 base  = vec3(uv * uAspect * uScale, 0.0);
  vec3 drift = vec3(0.0, -uFlow, 0.22);      // travel over one full loop
  float f1 = fbmLoop(base, drift, uPhase) * 2.0 - 1.0;
  float f2 = fbmLoop(base * 1.93 + 19.7, drift, uPhase) * 2.0 - 1.0;
  float band = smoothstep(0.015, 0.28, v) * (1.0 - smoothstep(0.58, 0.98, v));
  vec2 disp = -n * f1 + vec2(f2 * 0.42, -abs(f1) * 0.55);
  float o = texture(uTex, uv + disp * (uHeat * band) * uTexel).r;
  o *= 1.0 + f1 * uLick * band;
  outColor = vec4(vec3(max(o, 0.0)), 1.0);
}`;

/* The fall is a gather along a direction with exponential falloff. Three
 * things turn it into a plume rather than a smear:
 *   uRadiate  bends the gather toward the field's own gradient, so the
 *             trail leaves every edge along its normal — heat coming off
 *             a surface rather than everything sliding one way.
 *   uNebula   perturbs each tap by fbm that GROWS with distance along the
 *             trail, so it is tight at the source and billows as it goes.
 *   uDirFix   the base direction when radiate is 0.
 */
const FS_STREAK = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2  uTexel, uDirFix, uAspect;
uniform float uUnit, uStride, uDecay;
uniform float uRadiate, uNebula, uNebScale, uPhase, uFlowN;
out vec4 outColor;
` + GLSL_NOISE + `
void main(){
  vec2 uv = gl_FragCoord.xy * uTexel;

  vec2 e = uTexel * 2.0;
  vec2 g = vec2(texture(uTex, uv + vec2(e.x,0.0)).r - texture(uTex, uv - vec2(e.x,0.0)).r,
                texture(uTex, uv + vec2(0.0,e.y)).r - texture(uTex, uv - vec2(0.0,e.y)).r);
  vec2 inward = g / (length(g) + 1e-4);          // gather toward the hot interior
  vec2 dir = mix(uDirFix, inward, uRadiate);
  dir = dir / (length(dir) + 1e-5);

  float acc = 0.0, wsum = 0.0;
  for(int j=0;j<4;j++){
    float n = float(j) * uStride;
    float w = pow(uDecay, n);
    float t = n * uUnit;
    vec2 off = dir * t;
    if(uNebula > 0.0){
      vec3 q = vec3((uv + off * uTexel) * uAspect * uNebScale, 0.0);
      vec3 dq = vec3(0.0, -uFlowN, 0.3);
      vec2 turb = vec2(fbmLoop(q, dq, uPhase), fbmLoop(q + 13.7, dq, uPhase)) * 2.0 - 1.0;
      off += turb * (uNebula * t * 0.9);
    }
    acc  += texture(uTex, uv + off * uTexel).r * w;
    wsum += w;
  }
  outColor = vec4(vec3(acc / wsum), 1.0);
}`;

const FS_COMPOSE = `#version 300 es
precision highp float;
uniform sampler2D uField; uniform sampler2D uDrip; uniform sampler2D uLUT;
uniform vec2 uRes; uniform float uGain, uContrast, uGrain, uTime, uBgOpaque, uPhaseC;
uniform float uPulse, uBands, uPulseCycles;
uniform float uFloorOn, uFloorY, uMirror, uRipple, uFrost;
uniform vec3 uBg;
out vec4 outColor;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fieldAt(vec2 p){ return max(texture(uField, p).r, texture(uDrip, p).r); }

/* A mirrored floor spanning the frame. Everything below the horizon samples
   the field reflected back up, compressed with distance so it recedes, rippled
   by loop-safe sines, and blurred further out — the way a reflection loses
   coherence across a wet surface. It only ever adds glow, so on a transparent
   stage the floor itself stays invisible and only the reflection reads. */
float floorEcho(vec2 uv){
  float d = uFloorY - uv.y;
  if(d <= 0.0) return 0.0;
  vec2 ruv = vec2(uv.x, uFloorY + d * (1.0 + d * 2.6));
  if(ruv.y > 1.35) return 0.0;
  if(uRipple > 0.0){
    float rip = sin(uv.x * 37.0 + uPhaseC * 6.2831853 * 2.0) * 0.6
              + sin(uv.x * 83.0 - uPhaseC * 6.2831853 * 3.0) * 0.4;
    ruv.x += rip * uRipple * 0.05 * d;
  }
  float rad = uFrost * (0.002 + d * 0.10);
  float acc = fieldAt(ruv);
  if(rad > 0.0005){
    acc += fieldAt(ruv + vec2( rad,  rad*0.6));
    acc += fieldAt(ruv + vec2(-rad,  rad*0.4));
    acc += fieldAt(ruv + vec2( rad*0.5, -rad));
    acc += fieldAt(ruv + vec2(-rad*0.7, -rad*0.5));
    acc *= 0.2;
  }
  return acc * exp(-d * 3.0) * uMirror;
}

void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float v = fieldAt(uv);
  if(uFloorOn > 0.5) v = max(v, floorEcho(uv));
  v = pow(clamp(v, 0.0, 1.0), uContrast) * uGain;
  v = clamp(v, 0.0, 1.0);
  // travelling bands in field-space: iso-contours of the field hug the
  // artwork, so the colour rings pump outward along its own falloff
  if(uPulse > 0.0){
    float win = smoothstep(0.02, 0.20, v) * (1.0 - smoothstep(0.74, 1.0, v));
    v = clamp(v + sin((v * uBands + uPhaseC * uPulseCycles) * 6.2831853) * 0.5 * uPulse * win, 0.0, 1.0);
  }
  /* Emissive glow, composited the way light behaves: below the knee the colour
     stops getting darker and the opacity falls away instead. Reading the ramp's
     black tail as opaque black painted a hard ring on a light page; reading
     opacity from brightness let dark-but-coloured stretches blend, which turned
     the falloff into a murky wash. Holding the hue constant and fading alpha
     does neither — the tail dissolves cleanly into whatever is behind, and every
     value above the knee is fully opaque and so identical on any backdrop. */
  const float KNEE = 0.20;
  float a = smoothstep(0.0, KNEE, v);
  float dz = (hash(gl_FragCoord.xy * 1.7 + uTime) - 0.5) * 0.0035;   // break LUT stepping
  vec3 col = texture(uLUT, vec2(clamp(max(v, KNEE) + dz, 0.0, 1.0), 0.5)).rgb;
  col = max(col + (hash(gl_FragCoord.xy + uTime) - 0.5) * uGrain * step(0.004, a), 0.0);
  /* The drawing buffer is premultiplied, so the colour has to be scaled by its
     own alpha here. It used to come out right by accident: the ramp faded to
     black exactly as alpha fell away, so col was already ~0 wherever a was.
     Holding the hue constant below the knee breaks that coincidence. */
  vec3 rgb = col * a;
  outColor = vec4(rgb + uBg * (1.0 - a) * uBgOpaque, mix(a, 1.0, uBgOpaque));
}`;

// ==========================================
// 4. GL PROGRAMS, TEXTURES, PYRAMID
// ==========================================
function compile(type, src){
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(vs, fs){
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for(let i=0;i<n;i++){ const info = gl.getActiveUniform(p,i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return {p, u};
}
const progIngest  = program(VS, FS_INGEST);
const progBlur    = program(VS, FS_BLUR);
const progHeat    = program(VS, FS_HEAT);
const progStreak  = program(VS, FS_STREAK);
const progCompose = program(VS, FS_COMPOSE);
const vao = gl.createVertexArray();

/* The field is a single channel that spends most of its range down near zero,
   where 8 bits leaves only a handful of distinct levels. Pushed through a steep
   colour ramp that shows up as hard contour bands — the "low bitrate" look —
   even though nothing is ever compressed. Half float gives the falloff room to
   breathe. */
const FLOAT_FIELD = !!gl.getExtension('EXT_color_buffer_float');
const FIELD_FMT = FLOAT_FIELD
  ? { internal: gl.R16F,  format: gl.RED,  type: gl.HALF_FLOAT }
  : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };

function makeTex(w,h,filter){
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D,0,FIELD_FMT.internal,w,h,0,FIELD_FMT.format,FIELD_FMT.type,null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
function makeFBO(tex){
  const f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return f;
}
const lutTex = gl.createTexture();
let lutKey = '';
function uploadLUT(force){
  const key = state.palette + '|' + Math.round(eff.hue);
  if(!force && key === lutKey) return;
  lutKey = key;
  const {data, N} = buildLUT(state.palette, eff.hue);
  gl.bindTexture(gl.TEXTURE_2D, lutTex);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,N,1,0,gl.RGBA,gl.UNSIGNED_BYTE,data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

const tc  = document.createElement('canvas');
const tcx = tc.getContext('2d');
const srcTex = gl.createTexture();
let W=0, H=0, DPR=1;
const LEVELS = 5;
let pyr = [];
function allocTargets(w,h){
  pyr.forEach(L => [L.a,L.b].forEach(s => { gl.deleteTexture(s.t); gl.deleteFramebuffer(s.f); }));
  pyr = [];
  for(let i=0;i<LEVELS;i++){
    const lw = Math.max(2, w >> i), lh = Math.max(2, h >> i);
    const mk = () => { const t = makeTex(lw,lh,gl.LINEAR); return {t, f: makeFBO(t)}; };
    pyr.push({ w:lw, h:lh, a:mk(), b:mk() });
  }
}

// ==========================================
// 5. PARAMETERS & NOISE MODULATION
// ==========================================
/* ------------------------------------------------------------------ *
 * Parameters, and the noise that can drive them
 *
 * `state` holds what the sliders say. `eff` holds what the renderer
 * actually uses — base value plus that parameter's own fbm noise. Each
 * modulator has amount / speed / seed, like a Maxon noise shader driving
 * a channel.
 * ------------------------------------------------------------------ */
const PARAMS = [
  {key:'size',    label:'Size',    min:0.15, max:2.2, step:0.01,  def:1,    grp:'gBasic', geo:true},
  // the Glued logotype sits at -0.085em, so that is where kerning starts
  {key:'kern',    label:'Kerning', min:-0.22,max:0.30,step:0.001, def:-0.085, grp:'gBasic', geo:true,
                  fmt:v=>(v>0?'+':'')+v.toFixed(3)+'em'},
  {key:'posx',    label:'Position X',min:-1,  max:1,   step:0.005, def:0,    grp:'gBasic', geo:true,
                  fmt:v=>(v>0?'+':'')+v.toFixed(2)},
  {key:'posy',    label:'Position Y',min:-1,  max:1,   step:0.005, def:0,    grp:'gBasic', geo:true,
                  fmt:v=>(v>0?'+':'')+v.toFixed(2)},
  {key:'level',   label:'Level',   min:0.25, max:3,   step:0.01,  def:1,    grp:'gBasic'},
  {key:'hue',     label:'Hue',     min:-180, max:180, step:1,     def:0,    grp:'gBasic', fmt:v=>Math.round(v)+'°'},
  {key:'speed',   label:'Speed',   min:0.2,  max:2.5, step:0.01,  def:1,    grp:'gBasic', noMod:true},
  {key:'bloom',   label:'Bloom',   min:0,    max:2.5, step:0.01,  def:1,    grp:'gGlow'},
  {key:'fall',    label:'Fall',    min:0,    max:1,   step:0.005, def:0,    grp:'gGlow'},
  {key:'falldir', label:'Direction',min:0,   max:360, step:1,     def:90,   grp:'gGlow', fmt:v=>Math.round(v)+'°'},
  {key:'radiate', label:'Radiate', min:0,    max:1,   step:0.005, def:0,    grp:'gGlow'},
  {key:'nebula',  label:'Nebula',  min:0,    max:1,   step:0.005, def:0,    grp:'gGlow'},
  {key:'heat',    label:'Heat',    min:0,    max:1,   step:0.005, def:0.15, grp:'gHeat'},
  {key:'detail',  label:'Detail',  min:0,    max:1,   step:0.005, def:0.45, grp:'gHeat'},
  {key:'flow',    label:'Flow',    min:0,    max:1,   step:0.005, def:0.40, grp:'gHeat'},
  {key:'life',    label:'Life',    min:0,    max:1,   step:0.005, def:0.20, grp:'gHeat'},
  {key:'pulse',   label:'Pulse',   min:0,    max:1,   step:0.005, def:0,    grp:'gHeat'},
  {key:'bands',   label:'Bands',   min:0.5,  max:12,  step:0.1,   def:3,    grp:'gHeat', fmt:v=>v.toFixed(1)},
  {key:'extrude', label:'Extrude', min:0,    max:1,   step:0.005, def:0,    grp:'gForm', geo:true},
  {key:'angle',   label:'Angle',   min:0,    max:360, step:1,     def:45,   grp:'gForm', geo:true, fmt:v=>Math.round(v)+'°'},
  {key:'shade',   label:'Depth',   min:0,    max:1,   step:0.01,  def:0.25, grp:'gForm', geo:true},
  {key:'floory',  label:'Floor Y', min:0,    max:0.9, step:0.005, def:0.3,  grp:'gFloor'},
  {key:'mirror',  label:'Mirror',  min:0,    max:1,   step:0.005, def:0.55, grp:'gFloor'},
  {key:'ripple',  label:'Distort', min:0,    max:1,   step:0.005, def:0.25, grp:'gFloor'},
  {key:'frost',   label:'Frost',   min:0,    max:1,   step:0.005, def:0.35, grp:'gFloor'},
];
const PMAP = {}; PARAMS.forEach(p => PMAP[p.key] = p);

const state = {
  text:'Glued', palette:'thermal', invert:false, loop:true, anim:true, fade:false, floor:false,
  bg:'#000000', transparent:true,
  mod:{},   // key -> {on, amt, spd, seed}
};
PARAMS.forEach(p => {
  state[p.key] = p.def;
  state.mod[p.key] = {on:false, amt:0.35, spd:0.35, seed:Math.round(p.key.length*37 % 97)};
});
const eff = {};
PARAMS.forEach(p => eff[p.key] = p.def);
let fitFS = 200;

/* 1-D value-noise fbm, the JS twin of the shader's noise */
function h1(n){ const s = Math.sin(n*127.1) * 43758.5453123; return s - Math.floor(s); }
function vn1(x){ const i = Math.floor(x), f = x - i, u = f*f*(3-2*f); return h1(i)*(1-u) + h1(i+1)*u; }
function fbm1(x){
  let s = 0, a = 0.5, p = x;
  for(let i=0;i<3;i++){ s += a * vn1(p); p = p*2.03 + 7.7; a *= 0.5; }
  return s / 0.875;
}
function computeEff(clock){
  let geoMoved = false;
  for(const p of PARAMS){
    const m = state.mod[p.key];
    let v = state[p.key];
    if(m.on && !p.noMod && m.amt > 0){
      const freq = 0.04 + m.spd * 1.15;
      const n = fbm1(clock*freq + m.seed*13.7) * 2 - 1;
      v += n * m.amt * (p.max - p.min) * 0.5;
      if(v < p.min) v = p.min; else if(v > p.max) v = p.max;
    }
    if(p.geo && Math.abs(v - eff[p.key]) > (p.max - p.min) * 0.0008) geoMoved = true;
    eff[p.key] = v;
  }
  return geoMoved;
}

// ==========================================
// 6. SOURCE — TEXT / IMAGE / VIDEO
// ==========================================
/* ---------- source: text / image / video ---------- */
// Poppins first so the default word matches the Glued logotype
const FONT_STACK = `Poppins,"Arial Black","Helvetica Neue Black","Archivo Black",Impact,system-ui,sans-serif`;
const source = { kind:'text', el:null, w:0, h:0, name:'', url:null };
const CAN_FILTER = (()=>{ const c=document.createElement('canvas').getContext('2d');
  try{ c.filter='brightness(0.5)'; return c.filter !== 'none'; }catch(e){ return false; } })();

function stampRamp(depthPx, drawOne){
  const th = eff.angle * Math.PI/180, dx = Math.cos(th), dy = Math.sin(th);
  const maxSteps = source.kind === 'video' ? 24 : 64;
  const steps = Math.min(maxSteps, Math.max(2, Math.round(depthPx/2)));
  const nearV = 0.16 + eff.shade * 0.66;
  const farV  = Math.max(0.04, nearV - 0.07);
  tcx.globalCompositeOperation = 'lighten';
  for(let i=steps;i>=1;i--){
    const t = i/steps;
    drawOne(dx*depthPx*t, dy*depthPx*t, farV + (nearV - farV) * (1 - t));
  }
  tcx.globalCompositeOperation = 'source-over';
}

function drawSourceFrame(){
  if(!W) return;
  if(tc.width !== W || tc.height !== H){ tc.width = W; tc.height = H; }
  tcx.setTransform(1,0,0,1,0,0);
  tcx.filter = 'none'; tcx.globalAlpha = 1; tcx.globalCompositeOperation = 'source-over';
  tcx.fillStyle = '#000'; tcx.fillRect(0,0,W,H);
  const room = 1 / (1 + eff.extrude * 0.45);

  if(source.kind === 'text'){
    const str = state.text || ' ';
    const PROBE = 200;
    tcx.letterSpacing = (eff.kern * PROBE) + 'px';
    tcx.font = `900 ${PROBE}px ${FONT_STACK}`;
    const m = tcx.measureText(str);
    const wNat = Math.max(1, m.width);
    const hNat = Math.max(1, (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) || PROBE*0.72);
    const fs = Math.max(4, Math.min((W*0.66*room/wNat)*PROBE, (H*0.46*room/hNat)*PROBE) * eff.size);
    fitFS = fs;
    tcx.letterSpacing = (eff.kern * fs) + 'px';
    tcx.font = `900 ${fs}px ${FONT_STACK}`;
    // textAlign:'center' centers the advance box, which includes the trailing
    // letter-spacing gap — with the logotype's negative kerning that skews the
    // visible glyphs off from the true centre. Measure the real ink bounds at
    // a 'left' anchor instead, and centre on those.
    tcx.textAlign = 'left'; tcx.textBaseline = 'middle';
    const m2 = tcx.measureText(str);
    const aLeft = m2.actualBoundingBoxLeft || 0, aRight = m2.actualBoundingBoxRight || 0;
    const yOff = ((m2.actualBoundingBoxAscent||0) - (m2.actualBoundingBoxDescent||0)) / 2;
    const depthPx = eff.extrude * fs * 0.60;
    const cx = W/2 + eff.posx*W*0.5 - (aRight - aLeft)/2,
          cy = H/2 - eff.posy*H*0.5 + yOff - depthPx*0.35*Math.sin(eff.angle*Math.PI/180);
    if(depthPx > 0.5) stampRamp(depthPx, (ox,oy,v)=>{
      const g = Math.round(255*Math.min(1,v));
      tcx.fillStyle = `rgb(${g},${g},${g})`;
      tcx.fillText(str, cx+ox, cy+oy);
    });
    tcx.globalCompositeOperation = 'lighten';
    tcx.fillStyle = '#fff';
    tcx.fillText(str, cx, cy);
    tcx.globalCompositeOperation = 'source-over';
  } else {
    const el = source.el, bw = source.w, bh = source.h;
    if(!bw || !bh) return;
    const sc = Math.min(W*0.78*room/bw, H*0.72*room/bh) * eff.size;
    const dw = bw*sc, dh = bh*sc;
    fitFS = dh;
    const depthPx = eff.extrude * dh * 0.60;
    const cx = (W-dw)/2 + eff.posx*W*0.5,
          cy = (H-dh)/2 - eff.posy*H*0.5 - depthPx*0.35*Math.sin(eff.angle*Math.PI/180);
    if(depthPx > 0.5) stampRamp(depthPx, (ox,oy,v)=>{
      if(CAN_FILTER) tcx.filter = `brightness(${v.toFixed(3)})`; else tcx.globalAlpha = v;
      try{ tcx.drawImage(el, cx+ox, cy+oy, dw, dh); }catch(e){}
      tcx.filter = 'none'; tcx.globalAlpha = 1;
    });
    tcx.globalCompositeOperation = 'lighten';
    try{ tcx.drawImage(el, cx, cy, dw, dh); }catch(e){}
    tcx.globalCompositeOperation = 'source-over';
  }
  uploadSource();
}

function uploadSource(){
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,tc);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}

function resize(){
  DPR = Math.min(window.devicePixelRatio || 1, 1.75);
  const w = Math.round(cvs.clientWidth  * DPR);
  const h = Math.round(cvs.clientHeight * DPR);
  if(w === W && h === H) return;
  if(!w || !h) return;
  W = w; H = h; cvs.width = W; cvs.height = H;
  allocTargets(W,H);
  drawSourceFrame();
}

// ==========================================
// 7. TIMELINE
// ==========================================
/* ---------- timeline ---------- */
const DUR = 5.0, HOLD = 0.5;
const sstep = (a,b,x)=>{ const t = Math.min(1, Math.max(0,(x-a)/(b-a))); return t*t*(3-2*t); };

function timeline(t, clock){
  // Fade off is the default: the mark is simply lit for the whole cycle, so
  // the loop runs forever with nothing to see at the seam. Everything that
  // moves is driven by t (0..1 across the loop) rather than wall clock, which
  // is what lets the noise close the loop cleanly.
  const fade    = state.fade;
  const settle  = fade ? sstep(0.02, 0.34, t) : 1;
  const release = fade ? sstep(0.68, 1.00, t) : 0;
  const spread  = (1 - settle) + release * 1.25;
  const unit    = Math.max(8, fitFS);
  const blur    = unit * (0.050 + Math.pow(spread, 1.7) * 0.34 * eff.bloom);
  const rise    = fade ? sstep(0.00, 0.16, t) : 1;
  const flash   = fade ? 1.0 + 0.22 * Math.exp(-Math.pow((t-0.34)/0.07, 2)) : 1;
  const decay   = fade ? (1.0 - sstep(0.70, 0.99, t) * 0.92) : 1;
  const fallLen = unit * eff.fall * (1.05 + spread * 0.85) * 2.6;

  // whole numbers of cycles per loop, so the breathing lands where it started
  const TAU = Math.PI * 2;
  const live = 1.0 + eff.life * (0.075*Math.sin(TAU*t) + 0.045*Math.sin(TAU*2*t + 1.7)
                               + 0.030*Math.sin(TAU*3*t + 0.4));
  return {
    blur: blur * (1.0 + eff.life * 0.10 * Math.sin(TAU*t + 2.1)),
    fallLen,
    gain: rise * flash * decay * 1.06 * live,
    contrast: 0.95 + spread*0.25,
    heatAmp: unit * eff.heat * 0.22,
  };
}

/* ---------- passes ---------- */
function pass(prog, srcTexture, dst, lw, lh, dirX, dirY, setup){
  gl.bindFramebuffer(gl.FRAMEBUFFER, dst.f);
  gl.viewport(0,0,lw,lh);
  gl.uniform2f(prog.u.uTexel, 1/lw, 1/lh);
  if(prog.u.uDir) gl.uniform2f(prog.u.uDir, dirX, dirY);
  if(setup) setup();
  gl.bindTexture(gl.TEXTURE_2D, srcTexture);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
function ingest(){
  gl.useProgram(progIngest.p);
  gl.activeTexture(gl.TEXTURE0); gl.uniform1i(progIngest.u.uTex, 0);
  const L = pyr[0];
  pass(progIngest, srcTex, L.b, L.w, L.h, 0, 0, ()=>{
    gl.uniform1f(progIngest.u.uInvert, state.invert ? 1 : 0);
    gl.uniform1f(progIngest.u.uLevel, eff.level);
  });
  return L.b.t;
}
function pickLevel(sigmaPx){
  let lvl = 0;
  while(lvl < LEVELS-1 && sigmaPx / (1 << lvl) > 9.0) lvl++;
  return lvl;
}
function blurField(ingested, sigmaPx, lvl){
  gl.useProgram(progBlur.p);
  gl.activeTexture(gl.TEXTURE0); gl.uniform1i(progBlur.u.uTex, 0);
  const L = pyr[lvl];
  let src = ingested;
  for(let i=1;i<=lvl;i++){
    const D = pyr[i];
    pass(progBlur, src,   D.a, D.w, D.h, 1, 0, ()=>gl.uniform1f(progBlur.u.uStep, 0.5));
    pass(progBlur, D.a.t, D.b, D.w, D.h, 0, 1, ()=>gl.uniform1f(progBlur.u.uStep, 0.5));
    src = D.b.t;
  }
  const sig = Math.max(0.35, sigmaPx / (1 << lvl)), s0 = sig / 8.0;
  let cur = src;
  for(let i=0;i<3;i++){
    const st = s0 * Math.pow(2, i);
    if(st < 0.05) continue;
    pass(progBlur, cur,   L.a, L.w, L.h, 1, 0, ()=>gl.uniform1f(progBlur.u.uStep, st));
    pass(progBlur, L.a.t, L.b, L.w, L.h, 0, 1, ()=>gl.uniform1f(progBlur.u.uStep, st));
    cur = L.b.t;
  }
  return cur;
}
function heatField(field, ampPx, phase, lvl){
  if(eff.heat <= 0.001 || ampPx < 0.2) return field;
  const L = pyr[lvl];
  const dst = (field === L.a.t) ? L.b : L.a;
  gl.useProgram(progHeat.p);
  gl.activeTexture(gl.TEXTURE0); gl.uniform1i(progHeat.u.uTex, 0);
  pass(progHeat, field, dst, L.w, L.h, 0, 0, ()=>{
    gl.uniform2f(progHeat.u.uAspect, L.w/Math.max(1,L.h), 1.0);
    gl.uniform1f(progHeat.u.uPhase, phase);
    gl.uniform1f(progHeat.u.uHeat,  ampPx / (1 << lvl));
    gl.uniform1f(progHeat.u.uScale, 3.0 + eff.detail * 26.0);
    gl.uniform1f(progHeat.u.uFlow,  0.5 + eff.flow * 3.5);   // cells travelled per loop
    gl.uniform1f(progHeat.u.uLick,  0.18 + eff.heat * 0.45);
  });
  return dst.t;
}
function streakField(field, lenPx, srcLvl, phase){
  if(lenPx < 1.0) return field;
  const lvl = Math.min(LEVELS-1, Math.max(srcLvl + 1, 2));
  const L = pyr[lvl];
  gl.useProgram(progBlur.p);
  gl.activeTexture(gl.TEXTURE0); gl.uniform1i(progBlur.u.uTex, 0);
  pass(progBlur, field, L.a, L.w, L.h, 1, 0, ()=>gl.uniform1f(progBlur.u.uStep, 0.5));
  pass(progBlur, L.a.t, L.b, L.w, L.h, 0, 1, ()=>gl.uniform1f(progBlur.u.uStep, 0.5));
  field = L.b.t;

  const lenLvl = lenPx / (1 << lvl);
  // screen angle: 0 = right, 90 = down. The gather runs opposite the trail,
  // and texture v points up the screen, hence the signs.
  const th = eff.falldir * Math.PI/180;
  const dx = -Math.cos(th), dy = Math.sin(th);

  gl.useProgram(progStreak.p);
  gl.activeTexture(gl.TEXTURE0); gl.uniform1i(progStreak.u.uTex, 0);
  gl.uniform1f(progStreak.u.uDecay, 0.936);
  gl.uniform1f(progStreak.u.uUnit, Math.max(0.5, lenLvl / 48));
  gl.uniform2f(progStreak.u.uAspect, L.w/Math.max(1,L.h), 1.0);
  gl.uniform1f(progStreak.u.uRadiate, eff.radiate);
  gl.uniform1f(progStreak.u.uNebula, eff.nebula * 0.55);
  gl.uniform1f(progStreak.u.uNebScale, 2.0 + eff.detail * 14.0);
  gl.uniform1f(progStreak.u.uPhase, phase);
  gl.uniform1f(progStreak.u.uFlowN, 0.4 + eff.flow * 2.6);

  let cur = field, dst = L.a, other = L.b;
  for(let i=0;i<3;i++){
    const stride = Math.pow(4, i);
    pass(progStreak, cur, dst, L.w, L.h, 0, 0, ()=>{
      gl.uniform1f(progStreak.u.uStride, stride);
      gl.uniform2f(progStreak.u.uDirFix, dx, dy);
    });
    cur = dst.t; const sw = dst; dst = other; other = sw;
  }

  // This level is a quarter of the screen or less, so bilinear magnification
  // would otherwise show its lattice. One soft pass before it goes back up.
  {
    gl.useProgram(progBlur.p);
    gl.activeTexture(gl.TEXTURE0); gl.uniform1i(progBlur.u.uTex, 0);
    pass(progBlur, cur,   dst,   L.w, L.h, 1, 0, ()=>gl.uniform1f(progBlur.u.uStep, 1.0));
    pass(progBlur, dst.t, other, L.w, L.h, 0, 1, ()=>gl.uniform1f(progBlur.u.uStep, 1.0));
    cur = other.t;
  }
  return cur;
}

function renderAt(local, clock){
  const geoMoved = computeEff(clock);
  uploadLUT(false);
  if(source.kind === 'video' && source.el && source.el.readyState >= 2) drawSourceFrame();
  else if(geoMoved) drawSourceFrame();
  if(anyModded) refreshReadouts();

  const tl = timeline(local, clock);
  gl.bindVertexArray(vao);
  gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
  const lvl   = pickLevel(tl.blur);
  const ing   = ingest();
  let   field = blurField(ing, tl.blur, lvl);
  field = heatField(field, tl.heatAmp, local, lvl);
  const drip  = streakField(field, tl.fallLen, lvl, local);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0,0,W,H);
  gl.useProgram(progCompose.p);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, field); gl.uniform1i(progCompose.u.uField, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, drip);  gl.uniform1i(progCompose.u.uDrip, 1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, lutTex);gl.uniform1i(progCompose.u.uLUT, 2);
  gl.uniform2f(progCompose.u.uRes, W, H);
  gl.uniform1f(progCompose.u.uGain, tl.gain);
  gl.uniform1f(progCompose.u.uContrast, tl.contrast);
  gl.uniform1f(progCompose.u.uGrain, 0.012);
  gl.uniform1f(progCompose.u.uTime, clock % 10);
  // the pulse only reads as heat, so it rides on the heat amount
  gl.uniform1f(progCompose.u.uPulse, eff.pulse * sstep(0, 0.04, eff.heat));
  gl.uniform1f(progCompose.u.uBands, eff.bands);
  gl.uniform1f(progCompose.u.uPhaseC, local);
  gl.uniform1f(progCompose.u.uPulseCycles, Math.max(1, Math.round(1 + eff.flow * 4)));
  gl.uniform1f(progCompose.u.uFloorOn, state.floor ? 1 : 0);
  gl.uniform1f(progCompose.u.uFloorY, eff.floory);
  gl.uniform1f(progCompose.u.uMirror, eff.mirror);
  gl.uniform1f(progCompose.u.uRipple, eff.ripple);
  gl.uniform1f(progCompose.u.uFrost, eff.frost);
  const bg = bgVec();
  gl.uniform3f(progCompose.u.uBg, bg[0], bg[1], bg[2]);
  gl.uniform1f(progCompose.u.uBgOpaque, bakeBg ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.activeTexture(gl.TEXTURE0);
}

// ==========================================
// 9. STAGE BACKGROUND & MAIN LOOP
// ==========================================
/* Live, the stage's own CSS background does the compositing so a
 * transparent stage really shows the page. Only a flattened export
 * needs the colour baked into the shader. */
let bakeBg = false;
function bgVec(){
  const hex = state.transparent
    ? (getComputedStyle(document.documentElement).getPropertyValue('--background').trim() || '#000000')
    : state.bg;
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if(!m) return [0,0,0];
  return [parseInt(m[1],16)/255, parseInt(m[2],16)/255, parseInt(m[3],16)/255];
}
function applyStageBg(){
  const stage = document.querySelector('.stage');
  stage.style.background = state.transparent ? 'transparent' : state.bg;
  stage.style.borderColor = state.transparent ? 'transparent' : 'var(--hair)';
}

let t0 = performance.now(), playing = true, frozen = 0;
function frame(now){
  requestAnimationFrame(frame);
  if(exporting) return;
  // The effect picker blurs a live WebGL canvas — backdrop-filter re-samples
  // it every frame, so a canvas that's still animating underneath is what
  // makes the blur feel like it lags in. Freezing the render while the
  // modal is open removes the contention and the blur reads as instant —
  // except when a card is live-previewing the effect, which needs it back.
  // Thermal's own loop stays paused while another effect owns the stage —
  // except while a carousel card is live-previewing it, which needs frames
  // regardless of which effect the page is actually showing right now.
  if(activeEffect !== 'thermal' && !livePreviewCard) return;
  if(effectModalOpen && !livePreviewCard) return;
  resize();
  if(!W) return;
  let local;
  if(playing){
    const elapsed = ((now - t0)/1000) * eff.speed;
    local = (!state.loop && elapsed >= DUR) ? 1 : (elapsed % DUR) / DUR;
    frozen = local;
  } else local = frozen;
  renderAt(state.anim ? local : HOLD, now/1000);
}

// ==========================================
// 10. FILE IMPORT
// ==========================================
/* ------------------------------------------------------------------ *
 * File import — SVG, PNG, JPEG, MP4, MOV
 * ------------------------------------------------------------------ */
const MAX_RASTER = 2600;
const RE_HEIC = /\.(heic|heif)$/i;
const RE_MOV  = /\.(mov|qt)$/i;

/* Blink sniffs blob content and ignores the declared type, but Gecko has
   historically gated on it, so a .mov gets re-labelled as video/mp4 on the way
   in. Harmless where it is not needed. */
function objectURLFor(file){
  const isMov = RE_MOV.test(file.name) || file.type === 'video/quicktime';
  return URL.createObjectURL(isMov ? new Blob([file], {type:'video/mp4'}) : file);
}
function readAsDataURL(file){
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload  = () => res(String(fr.result));
    fr.onerror = () => rej(new Error('could not read the file off disk'));
    fr.readAsDataURL(file);
  });
}
/* Read the ISO-BMFF header and name the codec. A .mov that will not play is
   nearly always HEVC or ProRes, and saying which saves a guessing game. */
async function sniffCodec(file){
  try{
    const head = new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer());
    const txt  = new TextDecoder('latin1').decode(head);
    if(/hvc1|hev1|dvh1/.test(txt))            return 'HEVC';
    if(/ap(ch|cn|cs|co|4h|4x)/.test(txt))     return 'ProRes';
    if(/av01/.test(txt))                      return 'AV1';
    if(/avc1|avcC/.test(txt))                 return 'H.264';
    if(/VP8|VP9|webm/.test(txt))              return 'VP8/VP9';
  }catch(e){}
  return null;
}
function isHeicBytes(head){
  const brand = new TextDecoder('latin1').decode(head.subarray(4, 12));
  return /ftyp(heic|heix|hevc|hevx|mif1|msf1)/.test(brand);
}

function prettyKind(file){
  const ext = (file.name.match(/\.([a-z0-9]+)$/i) || [,''])[1].toUpperCase();
  return ext || (file.type || 'unknown');
}

function prepareImage(img){
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const sc = Math.min(1, MAX_RASTER / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw*sc)), h = Math.max(1, Math.round(ih*sc));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', {willReadFrequently:true});
  x.drawImage(img, 0, 0, w, h);
  try{
    const step = Math.max(1, Math.floor(Math.min(w,h)/64));
    const d = x.getImageData(0,0,w,h).data;
    let transparent = 0, sampled = 0;
    for(let y=0;y<h;y+=step) for(let px=0;px<w;px+=step){ sampled++; if(d[(y*w+px)*4+3] < 250) transparent++; }
    if(sampled && transparent/sampled > 0.02){
      // real alpha channel: key off alpha so dark artwork on transparency still lights up
      const out = x.createImageData(w,h);
      for(let i=0;i<d.length;i+=4){ const a = d[i+3]; out.data[i]=out.data[i+1]=out.data[i+2]=a; out.data[i+3]=255; }
      x.putImageData(out, 0, 0);
    }
  }catch(e){}
  return {canvas:c, w, h};
}

function decodeToImage(url){
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload  = () => res(img);
    img.onerror = () => rej(new Error('decode failed'));
    img.src = url;
  });
}

function svgToDataURL(file){
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => {
      let txt = String(fr.result);
      try{                                   // give it a size if it only declares a viewBox
        const doc = new DOMParser().parseFromString(txt, 'image/svg+xml');
        const svg = doc.documentElement;
        if(svg && svg.tagName.toLowerCase() === 'svg'){
          const vb = (svg.getAttribute('viewBox')||'').trim().split(/[\s,]+/).map(Number);
          if((!svg.getAttribute('width') || !svg.getAttribute('height')) && vb.length === 4){
            svg.setAttribute('width', vb[2]); svg.setAttribute('height', vb[3]);
            txt = new XMLSerializer().serializeToString(svg);
          }
        }
      }catch(e){}
      res('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(txt));
    };
    fr.onerror = () => rej(new Error('could not read the SVG'));
    fr.readAsText(file);
  });
}

async function loadImageFile(file){
  const isSVG = /svg/i.test(file.type) || /\.svg$/i.test(file.name);

  // Nothing outside Safari decodes HEIC/HEIF. Catch it by name, and by its
  // header too, so a HEIC that has been renamed .jpg is still reported properly.
  let heic = RE_HEIC.test(file.name) || /heic|heif/i.test(file.type);
  if(!heic && !isSVG){
    try{ heic = isHeicBytes(new Uint8Array(await file.slice(0, 16).arrayBuffer())); }catch(e){}
  }
  if(heic) throw new Error('HEIC can’t be decoded by this browser — export as PNG or JPEG first');

  let img;
  if(isSVG){
    img = await decodeToImage(await svgToDataURL(file));
  } else {
    const url = objectURLFor(file);
    try {
      img = await decodeToImage(url);
    } catch(e){
      // some sandboxes refuse blob: — a data URL always works, just uses more memory
      img = await decodeToImage(await readAsDataURL(file))
              .catch(() => { throw new Error(prettyKind(file) + ' isn’t a format this browser can decode'); });
    } finally { URL.revokeObjectURL(url); }
  }

  // SVGs with no intrinsic size rasterise tiny; scale them up before use
  let el = img;
  if(isSVG && Math.max(img.naturalWidth, img.naturalHeight) < 1200){
    const k = 1200 / Math.max(1, Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth*k); c.height = Math.round(img.naturalHeight*k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    el = c;
  }
  return prepareImage(el);
}

async function loadVideoFile(file){
  const codec = await sniffCodec(file);
  return new Promise((res, rej) => {
    const url = objectURLFor(file);
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    v.onloadeddata = () => { v.play().catch(()=>{}); res({el:v, w:v.videoWidth, h:v.videoHeight, url}); };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error(codec
        ? `this ${prettyKind(file)} is ${codec}, which this browser can’t decode — re-export as H.264`
        : `${prettyKind(file)} isn’t a video format this browser can play`));
    };
    v.src = url;
  });
}

function clearSource(){
  if(source.kind === 'video' && source.el){ try{ source.el.pause(); }catch(e){} }
  if(source.url){ URL.revokeObjectURL(source.url); source.url = null; }
  source.kind = 'text'; source.el = null; source.w = 0; source.h = 0; source.name = '';
  $('txt').style.display = ''; $('srcChip').classList.remove('on', 'err');
  drawSourceFrame();
}
async function acceptFile(file){
  if(!file) return;
  const isVideo = /^video\//i.test(file.type) || /\.(mp4|mov|m4v|webm)$/i.test(file.name);
  try{
    if(isVideo){
      const v = await loadVideoFile(file);
      if(source.url) URL.revokeObjectURL(source.url);
      source.kind='video'; source.el=v.el; source.w=v.w; source.h=v.h; source.url=v.url; source.name=file.name;
      $('srcKind').textContent = 'VIDEO';
      setToggle('bAnim', 'anim', false);
    } else {
      const im = await loadImageFile(file);
      if(source.url){ URL.revokeObjectURL(source.url); source.url = null; }
      source.kind='image'; source.el=im.canvas; source.w=im.w; source.h=im.h; source.name=file.name;
      $('srcKind').textContent = /svg/i.test(file.name) ? 'SVG' : 'IMAGE';
    }
    $('srcName').textContent = file.name;
    $('srcName').title = file.name;
    $('srcChip').classList.remove('err');
    $('srcChip').classList.add('on');
    $('txt').style.display = 'none';
    drawSourceFrame();
    t0 = performance.now(); playing = true;
  }catch(err){
    console.error(err);
    $('srcName').textContent = err.message || 'could not load file';
    $('srcName').title = err.message || '';
    $('srcKind').textContent = 'ERROR';
    $('srcChip').classList.add('on', 'err');
  }
}

// ==========================================
// 11. EXPORT — MP4 / ALPHA MOV
// ==========================================
/* ------------------------------------------------------------------ *
 * Export — frames rendered off the clock, so output is frame-accurate
 *   MP4  WebCodecs H.264 through the ISO-BMFF writer below
 *   MOV  PNG frames in a QuickTime track, which carries real alpha
 * ------------------------------------------------------------------ */
let exporting = false;
const EXPORT_FPS = 30;
const bytes = {
  cat(arrs){ let n=0; for(const a of arrs) n+=a.length;
    const o=new Uint8Array(n); let p=0; for(const a of arrs){ o.set(a,p); p+=a.length; } return o; },
  u32(n){ return new Uint8Array([n>>>24&255, n>>>16&255, n>>>8&255, n&255]); },
  u16(n){ return new Uint8Array([n>>8&255, n&255]); },
  str(s){ const o=new Uint8Array(s.length); for(let i=0;i<s.length;i++) o[i]=s.charCodeAt(i); return o; },
  zero(n){ return new Uint8Array(n); },
};
const B = bytes;
function box(type, ...kids){ const body = B.cat(kids); return B.cat([B.u32(body.length+8), B.str(type), body]); }
function fbox(type, ver, flags, ...kids){
  return box(type, new Uint8Array([ver, flags>>16&255, flags>>8&255, flags&255]), ...kids);
}
const MATRIX = B.cat([B.u32(0x00010000),B.u32(0),B.u32(0),B.u32(0),B.u32(0x00010000),B.u32(0),
                      B.u32(0),B.u32(0),B.u32(0x40000000)]);
/* One writer for both containers. `entry` is the sample description —
 * avc1+avcC for H.264, or a bare 'png ' entry at depth 32 for QuickTime
 * alpha. WebCodecs emits no B-frames, so decode order equals presentation
 * order and no ctts table is required.
 *
 * QuickTime is fussier than MP4 about what a well-formed file contains, so
 * the qt path mirrors what a known-good writer emits: a component-style
 * media handler, the data handler inside minf (its absence alone is enough
 * for AVFoundation to reject the file), an edit list, a wide atom ahead of
 * mdat, and pixel-aspect/field extensions on the sample entry. An
 * all-keyframe track omits stss entirely — in QuickTime that IS the
 * statement that every sample is a sync sample. */
function pascal(str){
  const b = new Uint8Array(str.length + 1);
  b[0] = str.length;
  for(let i=0;i<str.length;i++) b[i+1] = str.charCodeAt(i);
  return b;
}
function qtHandler(kind, sub, name){
  return fbox('hdlr',0,0, B.str(kind), B.str(sub), B.zero(12), pascal(name));
}
function muxISO(samples, entry, w, h, fps, brands, qt){
  const n = samples.length;
  const ftyp = box('ftyp', B.str(brands[0]), B.u32(brands[1]), ...brands[2].map(b=>B.str(b)));
  const wide = qt ? box('wide') : new Uint8Array(0);
  const mdat = box('mdat', B.cat(samples.map(s => s.data)));
  const dataStart = ftyp.length + wide.length + 8;
  const dur = Math.round(n*1000/fps);

  const mvhd = fbox('mvhd',0,0, B.u32(0),B.u32(0),B.u32(1000),B.u32(dur),
                    B.u32(0x00010000), B.u16(0x0100), B.zero(10), MATRIX, B.zero(24), B.u32(2));
  const tkhd = fbox('tkhd',0,3, B.u32(0),B.u32(0),B.u32(1),B.u32(0),B.u32(dur),
                    B.zero(8), B.u16(0), B.u16(0), B.u16(0), B.u16(0), MATRIX, B.u32(w<<16), B.u32(h<<16));
  const edts = qt ? box('edts', fbox('elst',0,0, B.u32(1), B.u32(dur), B.u32(0), B.u32(0x00010000)))
                  : new Uint8Array(0);
  const mdhd = fbox('mdhd',0,0, B.u32(0),B.u32(0),B.u32(fps),B.u32(n), B.u16(0x55c4), B.u16(0));
  const hdlr = qt ? qtHandler('mhlr', 'vide', 'VideoHandler')
                  : fbox('hdlr',0,0, B.u32(0), B.str('vide'), B.zero(12), B.str('VideoHandler\0'));
  const dhlr = qt ? qtHandler('dhlr', 'url ', 'DataHandler') : new Uint8Array(0);

  const stsd = fbox('stsd',0,0, B.u32(1), entry);
  const stts = fbox('stts',0,0, B.u32(1), B.u32(n), B.u32(1));
  const allKey = samples.every(s => s.key);
  const syncs = []; samples.forEach((s,i)=>{ if(s.key) syncs.push(B.u32(i+1)); });
  const stss = (qt && allKey) ? new Uint8Array(0)
                              : fbox('stss',0,0, B.u32(syncs.length), ...syncs);
  const stsc = fbox('stsc',0,0, B.u32(1), B.u32(1), B.u32(n), B.u32(1));
  const stsz = fbox('stsz',0,0, B.u32(0), B.u32(n), ...samples.map(s=>B.u32(s.data.length)));
  const stco = fbox('stco',0,0, B.u32(1), B.u32(dataStart));
  const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
  const dinf = box('dinf', fbox('dref',0,0, B.u32(1), fbox('url ',0,1)));
  const minf = box('minf', fbox('vmhd',0,1, B.u16(0), B.zero(6)), dhlr, dinf, stbl);
  const trak = box('trak', tkhd, edts, box('mdia', mdhd, hdlr, minf));
  return [ftyp, wide, mdat, box('moov', mvhd, trak)];
}
function visualEntry(type, w, h, depth, name, ...extra){
  const compressor = new Uint8Array(32);       // 32-byte Pascal string
  if(name){ compressor[0] = name.length;
    for(let i=0;i<name.length;i++) compressor[i+1] = name.charCodeAt(i); }
  return box(type, B.zero(6), B.u16(1), B.zero(16), B.u16(w), B.u16(h),
             B.u32(0x00480000), B.u32(0x00480000), B.u32(0), B.u16(1), compressor,
             B.u16(depth), new Uint8Array([0xff,0xff]), ...extra);
}

function nalSplit(buf){
  const out = []; let i = 0, start = -1;
  while(i < buf.length - 2){
    if(buf[i]===0 && buf[i+1]===0 && (buf[i+2]===1 || (buf[i+2]===0 && buf[i+3]===1))){
      const sc = buf[i+2]===1 ? 3 : 4;
      if(start >= 0) out.push(buf.subarray(start, i));
      start = i + sc; i += sc;
    } else i++;
  }
  if(start >= 0) out.push(buf.subarray(start, buf.length));
  return out;
}
/* Chrome honours avc:{format:'avc'}; some builds emit Annex-B with no
 * description instead, so convert rather than write an unplayable file. */
function annexBtoAVCC(samples){
  let sps = null, pps = null;
  for(const s of samples){
    const keep = [];
    for(const nal of nalSplit(s.data)){
      const t = nal[0] & 0x1f;
      if(t === 7){ if(!sps) sps = nal; continue; }
      if(t === 8){ if(!pps) pps = nal; continue; }
      keep.push(nal);
    }
    let len = 0; for(const nl of keep) len += nl.length + 4;
    const out = new Uint8Array(len); let p = 0;
    for(const nl of keep){ out.set(B.u32(nl.length), p); out.set(nl, p+4); p += nl.length + 4; }
    s.data = out;
  }
  if(!sps || !pps) return null;
  return B.cat([new Uint8Array([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
                B.u16(sps.length), sps, new Uint8Array([1]), B.u16(pps.length), pps]);
}
/* QuickTime Animation, fourcc 'rle ', 32-bit ARGB.
 *
 * PNG-in-MOV is a legal QuickTime track and ffmpeg and the NLEs all read it,
 * but modern macOS has retired the codec, so Finder and QuickTime Player will
 * not open it. Animation is Apple's own, still decoded natively, lossless, and
 * carries straight alpha — and it happens to suit this material, since large
 * flat transparent regions collapse to a few bytes.
 *
 * Per line: a skip byte (1 = start at x0; we never skip, so nothing depends on
 * how the decoder initialises its buffer), then codes — negative repeats the
 * following pixel -n times, positive copies n literal pixels, and -1 ends the
 * line. A zero byte after the last line ends the frame.
 */
function encodeQTRLE(rgba, w, h){
  const out = new Uint8Array(h * (w * 5 + 8) + 16);
  let o = 6;                                   // leave room for size + flags
  const same = (a, b) => rgba[a] === rgba[b] && rgba[a+1] === rgba[b+1] &&
                         rgba[a+2] === rgba[b+2] && rgba[a+3] === rgba[b+3];
  const putPixel = i => {                      // RGBA in, ARGB out
    out[o++] = rgba[i+3]; out[o++] = rgba[i]; out[o++] = rgba[i+1]; out[o++] = rgba[i+2];
  };
  for(let y=0; y<h; y++){
    const row = y * w * 4;
    out[o++] = 1;                              // skip nothing
    let x = 0;
    while(x < w){
      const p = row + x*4;
      let run = 1;
      while(run < 128 && x + run < w && same(p, p + run*4)) run++;
      if(run >= 2){
        out[o++] = (256 - run) & 0xff;         // -run
        putPixel(p);
        x += run;
      } else {
        // gather literals up to the next run of two or more
        let start = x, n = 0;
        while(x < w && n < 127){
          const q = row + x*4;
          if(x + 1 < w && same(q, q + 4)) break;
          x++; n++;
        }
        out[o++] = n;
        for(let k=0; k<n; k++) putPixel(row + (start+k)*4);
      }
    }
    out[o++] = 0xff;                           // end of line
  }
  out[o++] = 0x00;                             // end of frame
  const dv = new DataView(out.buffer);
  dv.setUint32(0, o, false);                   // frame size includes this field
  dv.setUint16(4, 0x0000, false);              // full frame, no line-range header
  return out.slice(0, o);
}

/* Stored (uncompressed) ZIP. PNGs are already deflated, so there is nothing
   to gain from compressing again, and STORE keeps the writer to a few lines.
   A PNG sequence is the one alpha hand-off every application reads. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for(let i=0;i<256;i++){ let c = i;
    for(let k=0;k<8;k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0; }
  return t;
})();
function crc32(buf){
  let c = 0xFFFFFFFF;
  for(let i=0;i<buf.length;i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files){
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for(const f of files){
    const name = enc.encode(f.name), crc = crc32(f.data), len = f.data.length;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
    lv.setUint16(10, 0, true); lv.setUint16(12, 0x0021, true);   // 1980-01-01, a valid DOS date
    lv.setUint32(14, crc, true); lv.setUint32(18, len, true); lv.setUint32(22, len, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, f.data);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0x0021, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, len, true); cv.setUint32(24, len, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + len;
  }
  const cdSize = central.reduce((n,c)=>n+c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  return [...parts, ...central, end];
}

async function pickCodec(w,h){
  for(const codec of ['avc1.640034','avc1.640028','avc1.4D4032','avc1.42E032','avc1.42E01F']){
    try{
      const r = await VideoEncoder.isConfigSupported({codec, width:w, height:h, bitrate:8e6,
                                                     framerate:EXPORT_FPS, avc:{format:'avc'}});
      if(r.supported) return codec;
    }catch(e){}
  }
  return null;
}
function download(parts, type, name){
  const url = URL.createObjectURL(new Blob(parts, {type}));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 30000);
}
function slug(){
  const base = source.kind === 'text' ? (state.text || 'glued') : source.name.replace(/\.[^.]+$/, '');
  return (base.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'glued');
}
function seek(v, t){
  return new Promise(res => {
    if(Math.abs(v.currentTime - t) < 1e-3) return res();
    const h = () => { v.removeEventListener('seeked', h); res(); };
    v.addEventListener('seeked', h);
    v.currentTime = t;
  });
}
function exportPlan(){
  const sel = $('size').value;
  let ew, eh;
  if(sel === 'window'){ ew = W; eh = H; }
  else { const [a,b] = sel.split('x').map(Number); ew = a; eh = b; }
  ew -= ew & 1; eh -= eh & 1;
  const vid = (source.kind === 'video' && source.el && isFinite(source.el.duration)) ? source.el : null;
  const dur = (vid && !state.anim) ? Math.min(vid.duration, 30) : DUR / eff.speed;
  return { ew, eh, vid, dur, total: Math.max(2, Math.round(dur * EXPORT_FPS)) };
}
async function withExportCanvas(ew, eh, body, bake){
  exporting = true;
  bakeBg = !!bake;
  const wasPlaying = source.kind === 'video' && source.el && !source.el.paused;
  if(wasPlaying) source.el.pause();
  const restoreW = cvs.width, restoreH = cvs.height;
  cvs.width = ew; cvs.height = eh; W = ew; H = eh;
  allocTargets(W, H); drawSourceFrame();
  try { await body(); }
  finally {
    exporting = false; bakeBg = false; W = 0; H = 0;
    cvs.width = restoreW; cvs.height = restoreH;
    if(wasPlaying) source.el.play().catch(()=>{});
  }
}
async function exportMP4(){
  if(exporting) return;
  const btn = $('bMp4'), label = btn.textContent, set = t => btn.textContent = t;
  if(typeof VideoEncoder === 'undefined'){ set('No codec'); setTimeout(()=>set(label),2400); return; }
  const {ew, eh, vid, dur, total} = exportPlan();
  const codec = await pickCodec(ew, eh);
  if(!codec){ set('No H.264'); setTimeout(()=>set(label),2400); return; }
  await withExportCanvas(ew, eh, async () => {
    const samples = []; let avcC = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if(meta && meta.decoderConfig && meta.decoderConfig.description && !avcC)
          avcC = new Uint8Array(meta.decoderConfig.description);
        const buf = new Uint8Array(chunk.byteLength); chunk.copyTo(buf);
        samples.push({data: buf, key: chunk.type === 'key'});
      },
      error: e => console.error(e),
    });
    encoder.configure({ codec, width:ew, height:eh, framerate:EXPORT_FPS,
                        bitrate: Math.min(40e6, Math.round(ew*eh*EXPORT_FPS*0.14)),
                        avc:{format:'avc'}, latencyMode:'quality' });
    try{
      for(let i=0;i<total;i++){
        if(vid && !state.anim) await seek(vid, (i/total)*dur);
        renderAt(state.anim ? i/total : HOLD, i/EXPORT_FPS);
        const vf = new VideoFrame(cvs, {timestamp: Math.round(i*1e6/EXPORT_FPS),
                                        duration: Math.round(1e6/EXPORT_FPS)});
        encoder.encode(vf, {keyFrame: i % 30 === 0});
        vf.close();
        if(i % 3 === 0){ set(Math.round(i/total*100)+'%'); await new Promise(r=>setTimeout(r,0)); }
        if(encoder.encodeQueueSize > 8) await new Promise(r=>setTimeout(r,8));
      }
      set('Mux…');
      await encoder.flush(); encoder.close();
      if(!avcC && samples.length) avcC = annexBtoAVCC(samples);
      if(!avcC) throw new Error('encoder returned no H.264 parameter sets');
      const entry = visualEntry('avc1', ew, eh, 0x0018, null, box('avcC', avcC));
      download(muxISO(samples, entry, ew, eh, EXPORT_FPS, ['isom', 0x200, ['isom','iso2','avc1','mp41']]),
               'video/mp4', `${slug()}-${ew}x${eh}.mp4`);
      set('✓ Saved');
    }catch(err){ console.error(err); set('Failed'); }
    setTimeout(()=>set(label), 2400);
  }, true);            // MP4 has no alpha — flatten onto the stage colour
}
/* H.264 has no alpha channel, so alpha frames are rendered as PNGs. They go
 * out either wrapped in a QuickTime track, or as a numbered sequence in a zip
 * — the sequence is slower to import but there is no codec to argue with. */
async function renderAlphaFrames(setLabel, makeFrame){
  const {ew, eh, vid, dur, total} = exportPlan();
  const enc = document.createElement('canvas'); enc.width = ew; enc.height = eh;
  const ex = enc.getContext('2d');
  const rgba = new Uint8Array(ew*eh*4);
  const img = ex.createImageData(ew, eh);
  const frames = [];
  for(let i=0;i<total;i++){
    if(vid && !state.anim) await seek(vid, (i/total)*dur);
    renderAt(state.anim ? i/total : HOLD, i/EXPORT_FPS);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, ew, eh, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const d = img.data;                      // readPixels is bottom-up
    for(let y=0;y<eh;y++){
      let src = (eh-1-y)*ew*4, o = y*ew*4;
      for(let x=0;x<ew;x++, src+=4, o+=4){
        const r = rgba[src], g = rgba[src+1], b = rgba[src+2], a = rgba[src+3];
        if(a === 0){ d[o]=d[o+1]=d[o+2]=d[o+3]=0; }
        else { const k = 255/a;               // un-premultiply against black
          d[o]=r*k>255?255:r*k; d[o+1]=g*k>255?255:g*k; d[o+2]=b*k>255?255:b*k; d[o+3]=a; }
      }
    }
    frames.push(await makeFrame(img, ex, enc, ew, eh));
    setLabel(Math.round(i/total*100)+'%');
    await new Promise(r=>setTimeout(r,0));
  }
  return {frames, ew, eh};
}

async function exportMOV(){
  if(exporting) return;
  const btn = $('bMov'), label = btn.textContent, set = t => btn.textContent = t;
  const {ew, eh} = exportPlan();
  await withExportCanvas(ew, eh, async () => {
    try{
      const {frames} = await renderAlphaFrames(set, (img, ex, enc, w, h) => encodeQTRLE(img.data, w, h));
      set('Mux…');
      const entry = visualEntry('rle ', ew, eh, 32, 'Animation',
                                box('fiel', new Uint8Array([1, 0])),
                                box('pasp', B.u32(1), B.u32(1)));
      download(muxISO(frames.map(f=>({data:f, key:true})), entry, ew, eh, EXPORT_FPS,
                      ['qt  ', 0x20050300, ['qt  ']], true),
               'video/quicktime', `${slug()}-${ew}x${eh}-alpha.mov`);
      set('✓ Saved');
    }catch(err){ console.error(err); set('Failed'); }
    setTimeout(()=>set(label), 2400);
  });
}

async function exportPNGSeq(){
  if(exporting) return;
  const btn = $('bSeq'), label = btn.textContent, set = t => btn.textContent = t;
  const {ew, eh} = exportPlan();
  await withExportCanvas(ew, eh, async () => {
    try{
      const {frames} = await renderAlphaFrames(set, async (img, ex, enc) => {
        ex.putImageData(img, 0, 0);
        const blob = await new Promise(r => enc.toBlob(r, 'image/png'));
        return new Uint8Array(await blob.arrayBuffer());
      });
      set('Zip…');
      const base = slug();
      const files = frames.map((data, i) => ({ name: `${base}_${String(i+1).padStart(4,'0')}.png`, data }));
      download(zipStore(files), 'application/zip', `${base}-${ew}x${eh}-png-alpha.zip`);
      set('✓ Saved');
    }catch(err){ console.error(err); set('Failed'); }
    setTimeout(()=>set(label), 2400);
  });
}

/* ------------------------------------------------------------------ *
 * Presets
 * ------------------------------------------------------------------ */
const M = (amt, spd, seed) => ({on:true, amt, spd, seed});
const PRESETS = [
  {name:'Chroma',   p:{size:1, kern:-0.05, posx:0, posy:0, level:1, hue:0, speed:2.5,
                       bloom:1.15, fall:.99, falldir:90, radiate:.32, nebula:.99,
                       heat:.99, detail:.99, flow:.99, life:.99, pulse:.1, bands:5.45,
                       extrude:0, angle:43, shade:.32, floory:.29, mirror:.54, ripple:.24, frost:.35},
                    palette:'thermal', fade:false, text:'Thermal', floor:false, transparent:true,
                    mod:{bands:M(.4,.35,90)}},

  {name:'Drip',     p:{size:.85, kern:-0.085, level:1, hue:0, speed:1,
                       bloom:1, fall:.55, falldir:90, radiate:0, nebula:.18,
                       heat:.2, detail:.45, flow:.35, life:.28, pulse:0, bands:3,
                       extrude:0, angle:45, shade:.25}, palette:'thermal', fade:false},

  {name:'Solar',    p:{size:.8, kern:-0.06, level:1, hue:0, speed:.8,
                       bloom:1.45, fall:.42, falldir:90, radiate:.8, nebula:.45,
                       heat:.85, detail:.3, flow:.72, life:.55, pulse:.22, bands:3.5,
                       extrude:0, angle:45, shade:.25}, palette:'thermal', fade:false,
                    mod:{heat:M(.35,.30,4), bloom:M(.22,.18,11), nebula:M(.3,.16,21)}},

  {name:'Monolith', p:{size:.75, kern:-0.085, level:1, hue:0, speed:1,
                       bloom:.7, fall:0, heat:.1, detail:.5, flow:.25, life:.12,
                       extrude:.62, angle:52, shade:.30}, palette:'mono', fade:false},
];

function applyPreset(idx){
  const pr = PRESETS[idx];
  for(const p of PARAMS){
    state[p.key] = pr.p[p.key] !== undefined ? pr.p[p.key] : p.def;
    state.mod[p.key] = Object.assign({on:false, amt:.35, spd:.35, seed:(p.key.length*37)%97},
                                     (pr.mod && pr.mod[p.key]) || {});
    eff[p.key] = state[p.key];
  }
  state.palette = pr.palette;
  state.fade = pr.fade !== false;
  $('pal').value = state.palette;
  setToggle('bFade', 'fade', state.fade);
  if(pr.text !== undefined && source.kind === 'text'){
    state.text = pr.text;
    $('txt').value = pr.text;
  }
  if(pr.floor !== undefined) setToggle('bFloor', 'floor', pr.floor);
  if(pr.transparent !== undefined) state.transparent = pr.transparent;
  $('bTransparent').classList.toggle('on', state.transparent);
  applyStageBg();
  syncControls();
  uploadLUT(true);
  drawSourceFrame();
  document.querySelectorAll('#presets .chip').forEach((c,i)=>c.classList.toggle('on', i===idx));
  t0 = performance.now(); playing = true;
}

// ==========================================
// 13. UI — TABS, PARAMS, CONTROLS
// ==========================================
/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */
function $(id){ return document.getElementById(id); }
let anyModded = false, liveKey = null;
const rowEls = {};

const TABS = [
  {id:'basic', label:'Basic'},  {id:'glow', label:'Glow'}, {id:'heat', label:'Heat'},
  {id:'form', label:'Form'},     {id:'motion', label:'Motion'}, {id:'export', label:'Export'},
];
TABS.forEach((t,i)=>{
  const b = document.createElement('button');
  b.className = 'tab' + (i===0 ? ' on' : ''); b.textContent = t.label; b.dataset.tab = t.id;
  b.addEventListener('click', ()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('on', x === b));
    document.querySelectorAll('.pane').forEach(p=>p.classList.toggle('on', p.dataset.pane === t.id));
    $('panes').scrollTop = 0;
  });
  $('tabs').appendChild(b);
});

function buildParams(){
  for(const p of PARAMS){
    const wrap = document.createElement('div');
    wrap.className = 'p'; wrap.dataset.key = p.key;
    wrap.innerHTML =
      `<div class="p-top"><span class="p-label">${p.label}</span><span class="p-val"></span>` +
      (p.noMod ? '' : `<button class="p-mod" title="Animate with noise">◆</button>`) + `</div>` +
      `<input type="range" class="p-range" min="${p.min}" max="${p.max}" step="${p.step}">` +
      (p.noMod ? '' :
      `<div class="p-noise">
         <label>Amt<input type="range" class="n-amt" min="0" max="1" step="0.01"></label>
         <label>Spd<input type="range" class="n-spd" min="0" max="1" step="0.01"></label>
         <label>Seed<input type="range" class="n-seed" min="0" max="96" step="1"></label>
       </div>`);
    $(p.grp).appendChild(wrap);

    const range = wrap.querySelector('.p-range');
    const fmt = p.fmt || (v=>v.toFixed(2));
    range.addEventListener('input', () => {
      state[p.key] = parseFloat(range.value);
      eff[p.key] = state[p.key];
      wrap.querySelector('.p-val').textContent = fmt(state[p.key]);
      if(p.geo) drawSourceFrame();
      if(p.key === 'hue') uploadLUT(false);
      clearPresetSelection();
    });
    // the readout is only worth showing while the control is in play
    const live = on => { wrap.classList.toggle('live', on); liveKey = on ? p.key : (liveKey === p.key ? null : liveKey); };
    range.addEventListener('pointerdown', ()=>live(true));
    addEventListener('pointerup', ()=>live(false));
    wrap.addEventListener('pointerenter', ()=>{ liveKey = p.key; wrap.querySelector('.p-val').textContent = fmt(eff[p.key]); });
    wrap.addEventListener('pointerleave', ()=>{ if(liveKey === p.key && !wrap.classList.contains('live')) liveKey = null; });

    if(!p.noMod){
      const m = () => state.mod[p.key];
      wrap.querySelector('.p-mod').addEventListener('click', ()=>{
        m().on = !m().on; wrap.classList.toggle('modded', m().on);
        anyModded = PARAMS.some(q => state.mod[q.key].on);
        updateBoil();
        if(!m().on){ eff[p.key] = state[p.key]; if(p.geo) drawSourceFrame(); }
        clearPresetSelection();
      });
      const bind = (cls, field) => {
        const el = wrap.querySelector(cls);
        el.addEventListener('input', ()=>{ m()[field] = parseFloat(el.value); clearPresetSelection(); });
      };
      bind('.n-amt','amt'); bind('.n-spd','spd'); bind('.n-seed','seed');
    }
    rowEls[p.key] = wrap;
  }
}
function syncControls(){
  for(const p of PARAMS){
    const wrap = rowEls[p.key], m = state.mod[p.key];
    wrap.querySelector('.p-range').value = state[p.key];
    wrap.querySelector('.p-val').textContent = (p.fmt || (v=>v.toFixed(2)))(state[p.key]);
    if(!p.noMod){
      wrap.classList.toggle('modded', m.on);
      wrap.querySelector('.n-amt').value = m.amt;
      wrap.querySelector('.n-spd').value = m.spd;
      wrap.querySelector('.n-seed').value = m.seed;
    }
  }
  anyModded = PARAMS.some(q => state.mod[q.key].on);
  updateBoil();
}
/* only the row under the pointer needs a live number */
function refreshReadouts(){
  if(!liveKey) return;
  const p = PMAP[liveKey];
  if(p) rowEls[liveKey].querySelector('.p-val').textContent = (p.fmt || (v=>v.toFixed(2)))(eff[liveKey]);
}
/* Stop-motion twitch for the logomark thumbs. One class on <body> drives
   every modulated slider at once, and the interval is deliberately uneven
   so it reads hand-made rather than mechanical. */
const BOIL_FRAMES = ['', 'boil-b', 'boil-c'];
let boilStep = 0, boilTimer = null;
BOIL_FRAMES.forEach((_, i) => { const im = new Image(); im.src = `../assets/mark_${'abc'[i]}.png`; });

function tickBoil(){
  boilStep = (boilStep + 1) % BOIL_FRAMES.length;
  document.body.classList.remove('boil-b', 'boil-c');
  if(BOIL_FRAMES[boilStep]) document.body.classList.add(BOIL_FRAMES[boilStep]);
  boilTimer = setTimeout(tickBoil, 85 + Math.random() * 95);
}
function updateBoil(){
  if(anyModded && !boilTimer) tickBoil();
  else if(!anyModded && boilTimer){
    clearTimeout(boilTimer); boilTimer = null;
    document.body.classList.remove('boil-b', 'boil-c');
  }
}

function clearPresetSelection(){ document.querySelectorAll('#presets .chip').forEach(c=>c.classList.remove('on')); }
function setToggle(btnId, key, on){ state[key] = on; $(btnId).classList.toggle('on', on); }

PRESETS.forEach((pr,i)=>{
  const b = document.createElement('button');
  b.className = 'chip'; b.textContent = pr.name;
  b.addEventListener('click', ()=>applyPreset(i));
  $('presets').appendChild(b);
});

// ==========================================
// 13B. EFFECT PICKER — 3D ring carousel
// ==========================================
/* Effects are separate tools/pipelines — Thermal (this page) is the first.
   Presets (Chroma, Drip, Solar, Monolith, chosen above via the Preset chips)
   are variations within an effect, not effects themselves.
   V1: ten placeholder slots on a shared placeholder image with throwaway
   names, standing in for real effects until they exist. Swap `thumb` and
   `name` per entry once real ones are built — the ring itself doesn't care. */
const EFFECTS = [
  {name:'Thermal',     thumb:'../assets/effect_thermal.png',     key:'thermal',    live:true},
  {name:'Halftone',    thumb:'../assets/effect_halftone.png',    key:'halftone',  live:true, globalName:'Halftone'},
  {name:'Wobblefish',  thumb:'../assets/effect_placeholder.png', key:'thermal'},
  {name:'Quibble',     thumb:'../assets/effect_placeholder.png', key:'thermal'},
  {name:'Nectarine',   thumb:'../assets/effect_placeholder.png', key:'thermal'},
  {name:'Bagpipe',     thumb:'../assets/effect_placeholder.png', key:'thermal'},
  {name:'Thistle',     thumb:'../assets/effect_placeholder.png', key:'thermal'},
  {name:'Kumquat',     thumb:'../assets/effect_placeholder.png', key:'thermal'},
  {name:'Gizmo',       thumb:'../assets/effect_placeholder.png', key:'thermal'},
  {name:'Ointment',    thumb:'../assets/effect_placeholder.png', key:'thermal'},
  {name:'Waffle',      thumb:'../assets/effect_placeholder.png', key:'thermal'},
];
/* Effect modules load lazily and mutually exclusively — only the active
   one's script/DOM/render-loop exists at a time. See switchEffect() below. */
const EFFECT_SCRIPTS = {halftone: 'halftone.js'};
const loadedScripts = new Set();
let activeEffect = 'thermal';
function loadScriptOnce(src){
  return new Promise((resolve,reject)=>{
    if(loadedScripts.has(src)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = ()=>{ loadedScripts.add(src); resolve(); };
    s.onerror = reject;
    document.body.appendChild(s);
  });
}
async function switchEffect(key){
  if(key === activeEffect) return;
  if(key === 'thermal'){
    if(window.Halftone) window.Halftone.unmount();
    $('halftoneMount').style.display = 'none';
    $('gl').style.display = '';
    $('thermalPanel').style.display = '';
    $('halftonePanel').style.display = 'none';
    activeEffect = 'thermal';
    t0 = performance.now() - (frozen*DUR*1000/eff.speed);
    resize();
  } else if(EFFECT_SCRIPTS[key]){
    await loadScriptOnce(EFFECT_SCRIPTS[key]);
    $('gl').style.display = 'none';
    $('thermalPanel').style.display = 'none';
    $('halftonePanel').style.display = '';
    $('halftoneMount').style.display = '';
    await window.Halftone.mount($('halftoneMount'));
    activeEffect = key;
  }
  const fx = EFFECTS.find(f => f.key === key);
  if(fx){ $('effectTriggerBg').src = fx.thumb; $('effectTriggerBg').alt = fx.name; }
}
const N_FX = EFFECTS.length;
const STEP = 360 / N_FX;

let effectModalOpen = false;
let ringAngle = 0;
let frontIdx = 0;
const fxCards = [];

let tiltX = -8;
let wasDragged = false;

let livePreviewCard = null;
let livePreviewKey = null;
let liveMountToken = 0;
const stageHome = $('gl').parentNode; // where the live canvas normally lives
// Lazy-loaded live effects each own a stage-mount div (e.g. #halftoneMount)
// separate from Thermal's always-on #gl canvas — record each one's home
// parent up front so activateLive/deactivateLive can move it in and out of
// a carousel card the same way Thermal's canvas gets moved.
const liveMountHomes = {};
EFFECTS.forEach(fx=>{
  if(!fx.live || fx.key === 'thermal') return;
  const el = $(fx.key + 'Mount');
  if(el) liveMountHomes[fx.key] = el.parentNode;
});

EFFECTS.forEach((fx,i)=>{
  const card = document.createElement('div');
  card.className = 'effect-card';
  card.innerHTML = `<div class="effect-card-inner"><img src="${fx.thumb}" alt="${fx.name}"><span class="effect-card-label">${fx.name}</span></div>`;
  card.addEventListener('click', ()=>{
    if(wasDragged) return;
    if(i === frontIdx){
      closeEffectModal();
      switchEffect(fx.key);
    } else {
      rotateRingTo(i);
    }
  });
  $('effectCarouselRing').appendChild(card);
  fxCards.push(card);
});

/* The live effect plays in whichever card is currently focal — front and
   centre of the ring — not on hover. Rotating the ring hands it off.
   Thermal's canvas always runs, so its case is just moving the node. Other
   live effects (Halftone) are lazy-loaded modules that normally only run
   while they're the active stage effect — activateLive loads and mounts
   them on demand so browsing the carousel can preview them too.
   Whatever's actually active on the stage is deliberately left alone here:
   the modal's blurred backdrop is a real backdrop-filter on the live page,
   so it keeps showing the active effect (blurred) the whole time you
   browse, regardless of which card is focused up front. */
async function activateLive(i){
  const fx = EFFECTS[i], card = fxCards[i];
  if(!fx || !fx.live || livePreviewCard === card) return;
  if(livePreviewCard) deactivateLive();
  const myToken = ++liveMountToken;
  const inner = card.querySelector('.effect-card-inner');
  card.querySelector('img').style.opacity = '0';
  livePreviewCard = card;
  livePreviewKey = fx.key;
  card.classList.add('live');

  if(fx.key === 'thermal'){
    $('gl').style.display = ''; // it may be hidden if a different effect owns the stage
    inner.insertBefore($('gl'), inner.firstChild);
    return;
  }

  const mountEl = $(fx.key + 'Mount');
  if(!mountEl || !fx.globalName) return;
  if(activeEffect !== fx.key){
    await loadScriptOnce(EFFECT_SCRIPTS[fx.key]);
    if(myToken !== liveMountToken) return; // rotated past it before this landed
    await window[fx.globalName].mount(mountEl);
    if(myToken !== liveMountToken){ window[fx.globalName].unmount(); return; } // rotated away mid-mount
  }
  mountEl.style.display = '';
  inner.insertBefore(mountEl, inner.firstChild);
}
function deactivateLive(){
  if(!livePreviewCard) return;
  const key = livePreviewKey;
  livePreviewCard.querySelector('img').style.opacity = '';
  livePreviewCard.classList.remove('live');
  livePreviewCard = null;
  livePreviewKey = null;
  liveMountToken++; // invalidates any in-flight activateLive() for this card

  if(key === 'thermal'){
    stageHome.insertBefore($('gl'), stageHome.firstChild);
    // Put it back the way switchEffect() left it — hidden if Thermal isn't
    // the effect actually showing on the stage right now.
    $('gl').style.display = activeEffect === 'thermal' ? '' : 'none';
    resize();
    return;
  }

  const fx = EFFECTS.find(f => f.key === key);
  if(!fx) return;
  const mountEl = $(key + 'Mount');
  const home = liveMountHomes[key];
  if(!mountEl || !home) return;
  home.insertBefore(mountEl, home.firstChild);
  if(activeEffect === key){
    mountEl.style.display = '';
  } else {
    mountEl.style.display = 'none';
    if(window[fx.globalName]) window[fx.globalName].unmount();
  }
}

/* Card size matches the window's own aspect ratio, capped so it always
   fits on screen. GAP widens the ring radius past the touching point so
   whitespace shows between cards, like slats around a drum. */
const GAP = 1 + (1.35-1)*0.6;
function layoutRing(){
  const winAR = window.innerWidth / window.innerHeight;
  const cardH = Math.min(window.innerHeight * 0.56, 520) * 0.7;
  const cardW = cardH * winAR;
  const radius = ((cardW/2) / Math.tan(Math.PI / N_FX)) * GAP;
  // Perspective scales with the radius so the front card's zoom stays
  // modest regardless of card count or window shape — a fixed px value
  // would put the ring right up against the camera and blow it up.
  $('effectCarousel3D').style.perspective = (radius*5) + 'px';
  fxCards.forEach((card,i)=>{
    card.style.width = cardW + 'px';
    card.style.height = cardH + 'px';
    card.style.marginLeft = (-cardW/2) + 'px';
    card.style.marginTop = (-cardH/2) + 'px';
    card.dataset.angle = i*STEP;
    card.dataset.radius = radius;
  });
  applyRing();
}
addEventListener('resize', layoutRing);

/* Depth of field: cards facing away from the camera fall out of focus and
   dim, the way a shallow lens would render the far side of a real drum. */
function applyRing(){
  $('effectCarouselRing').style.transform = `rotateZ(-15deg) rotateX(${tiltX}deg) rotateY(${ringAngle}deg)`;
  frontIdx = ((Math.round(-ringAngle/STEP) % N_FX) + N_FX) % N_FX;
  fxCards.forEach((card,i)=>{
    const angle = +card.dataset.angle, radius = +card.dataset.radius;
    card.style.transform = `rotateY(${angle}deg) translateZ(${radius}px)`;
    let diff = (angle + ringAngle) % 360; if(diff > 180) diff -= 360; if(diff < -180) diff += 360;
    const t = Math.max(0, Math.cos(diff * Math.PI/180));
    card.style.opacity = (0.25 + t*0.75).toFixed(2);
    card.style.filter = `brightness(${(0.5 + t*0.5).toFixed(2)}) blur(${((1-t)*6).toFixed(1)}px)`;
    card.style.zIndex = Math.round(t*100);
    card.classList.toggle('active', i === frontIdx);
  });
  if(effectModalOpen){
    if(EFFECTS[frontIdx] && EFFECTS[frontIdx].live) activateLive(frontIdx);
    else deactivateLive();
  }
}
function rotateRingTo(i){
  // The raw target for card i is always -i*STEP, but that's just one of
  // infinitely many angles that put it at the front (any ±360° multiple
  // works too) — picking the raw one means selecting the card just before
  // the front (visually one step left) can compute to the *last* index and
  // spin almost all the way around instead of stepping back once. Nudge
  // the target by whole turns until it's the closest equivalent angle to
  // where the ring already is, so the transition always takes the short way.
  let target = -i*STEP;
  while(target - ringAngle > 180) target -= 360;
  while(target - ringAngle < -180) target += 360;
  ringAngle = target;
  applyRing();
}

$('effectCarousel3D').addEventListener('wheel', e=>{
  e.preventDefault();
  rotateRingTo((frontIdx + (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1) + N_FX) % N_FX);
}, {passive:false});

/* Drag to spin freely on both axes — horizontal drag orbits the ring
   (snaps to the nearest card on release), vertical drag tilts it like a
   trackball (clamped so it never flips past readable). */
(() => {
  const ring = $('effectCarouselRing');
  let dragging = false, startX = 0, startY = 0, startAngle = 0, startTilt = 0, moved = 0;
  const down = (x,y)=>{
    dragging = true; moved = 0;
    startX = x; startY = y; startAngle = ringAngle; startTilt = tiltX;
    ring.style.transition = 'none';
  };
  const move = (x,y)=>{
    if(!dragging) return;
    const dx = x-startX, dy = y-startY;
    moved = Math.max(moved, Math.abs(dx), Math.abs(dy));
    ringAngle = startAngle + dx*0.175;
    tiltX = Math.max(-40, Math.min(40, startTilt - dy*0.125));
    applyRing();
  };
  const up = ()=>{
    if(!dragging) return;
    dragging = false;
    ring.style.transition = '';
    wasDragged = moved > 6;
    if(wasDragged) rotateRingTo(Math.round(-ringAngle/STEP + N_FX*10) % N_FX);
  };
  $('effectCarousel3D').addEventListener('pointerdown', e=>{ down(e.clientX, e.clientY); e.preventDefault(); });
  addEventListener('pointermove', e=> move(e.clientX, e.clientY));
  addEventListener('pointerup', up);
  // Swallow the click a drag gesture trails with — caught here, once,
  // in the capture phase, so it can never race a timer-based reset.
  $('effectCarousel3D').addEventListener('click', e=>{
    if(wasDragged){ e.preventDefault(); e.stopImmediatePropagation(); wasDragged = false; }
  }, true);
  $('effectCarousel3D').style.cursor = 'grab';
})();

(() => {
  const current = EFFECTS[0];
  $('effectTriggerBg').src = current.thumb;
  $('effectTriggerBg').alt = current.name;
})();

// The modal's blurred backdrop is a real backdrop-filter over the live
// page, so it only has something to show if the active effect's own
// canvas is actually still sitting in `.stage` — but activateLive() moves
// that exact canvas into whichever card is focused, including the active
// effect's own card, which would otherwise leave the backdrop blurring
// nothing. #bgMirror stays put in `.stage` for as long as the modal is
// open, continuously redrawn from whatever the active effect's real
// canvas is (wherever it currently sits, moved or not), so the backdrop
// always has a live copy of the active effect to blur.
let mirrorRunning = false;
function activeSourceCanvas(){
  if(activeEffect === 'thermal') return $('gl');
  const mount = $(activeEffect + 'Mount');
  return mount ? mount.querySelector('canvas') : null;
}
function mirrorFrame(){
  if(!effectModalOpen){ mirrorRunning = false; return; }
  // Defensive: whichever lazy effect mounts are just sitting at home (not
  // currently moved into a focused card) should be hidden unless they're
  // the active effect — a stale mount left visible here (e.g. a mid-flight
  // mount()/unmount() race while rapidly spinning the ring) would show
  // through in `.stage` alongside #bgMirror, doubling up in the blurred
  // backdrop. Enforcing it every frame self-heals regardless of how the
  // stale state happened, instead of chasing each possible race.
  Object.keys(liveMountHomes).forEach(key=>{
    if(key === activeEffect) return;
    const el = $(key + 'Mount'), home = liveMountHomes[key];
    if(el && home && el.parentNode === home && el.style.display !== 'none') el.style.display = 'none';
  });
  const mirror = $('bgMirror'), src = activeSourceCanvas();
  if(mirror && src && src.width && src.height){
    const w = mirror.clientWidth, h = mirror.clientHeight;
    if(w && h){
      if(mirror.width !== w) mirror.width = w;
      if(mirror.height !== h) mirror.height = h;
      const ctx = mirror.getContext('2d');
      // Thermal's canvas is transparent wherever the effect isn't painting
      // (the Transparent stage option), so a plain drawImage blends onto
      // whatever pixels are already here rather than replacing them —
      // without clearing first, a previous effect's frame stays visible
      // through the gaps forever. Clear every frame so only the current
      // source ever shows.
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(src, 0, 0, w, h);
    }
  }
  requestAnimationFrame(mirrorFrame);
}

function openEffectModal(){
  effectModalOpen = true;
  $('effectModal').classList.add('on');
  $('effectModal').setAttribute('aria-hidden','false');
  // Always open on the effect actually in use on this page, not wherever
  // a previous browse through the ring happened to leave off.
  tiltX = -8;
  layoutRing();
  rotateRingTo(Math.max(0, EFFECTS.findIndex(fx => fx.key === activeEffect)));
  $('bgMirror').style.display = '';
  if(!mirrorRunning){ mirrorRunning = true; mirrorFrame(); }
}
function closeEffectModal(){
  effectModalOpen = false;
  deactivateLive();
  $('effectModal').classList.remove('on');
  $('effectModal').setAttribute('aria-hidden','true');
  $('bgMirror').style.display = 'none';
  t0 = performance.now() - (frozen*DUR*1000/eff.speed);
}

$('effectTrigger').addEventListener('click', openEffectModal);
$('effectModalScrim').addEventListener('click', closeEffectModal);
$('effectCarousel3D').addEventListener('click', e=>{
  if(wasDragged) return;
  if(!e.target.closest('.effect-card')) closeEffectModal();
});
addEventListener('keydown', e=>{
  if(!effectModalOpen) return;
  if(e.key === 'Escape') closeEffectModal();
  if(e.key === 'ArrowRight') rotateRingTo((frontIdx+1)%N_FX);
  if(e.key === 'ArrowLeft') rotateRingTo((frontIdx-1+N_FX)%N_FX);
});

buildParams();
syncControls();

$('txt').addEventListener('input', e => { state.text = e.target.value; drawSourceFrame(); });
$('pal').addEventListener('change', e => { state.palette = e.target.value; uploadLUT(true); clearPresetSelection(); });
$('bInvert').addEventListener('click', e => { state.invert = !state.invert; e.currentTarget.classList.toggle('on', state.invert); });
$('bAnim').addEventListener('click', ()=> setToggle('bAnim','anim', !state.anim));
$('bFade').addEventListener('click', ()=> setToggle('bFade','fade', !state.fade));
$('bFloor').addEventListener('click', ()=> setToggle('bFloor','floor', !state.floor));
$('bLoop').addEventListener('click', ()=>{ setToggle('bLoop','loop', !state.loop); if(state.loop) t0 = performance.now(); });
$('bReplay').addEventListener('click', replay);
$('bMp4').addEventListener('click', exportMP4);
$('bMov').addEventListener('click', exportMOV);
$('bSeq').addEventListener('click', exportPNGSeq);
$('bOpen').addEventListener('click', ()=> $('file').click());
$('file').addEventListener('change', e=>{ if(e.target.files[0]) acceptFile(e.target.files[0]); e.target.value=''; });
$('srcX').addEventListener('click', clearSource);
$('bgColor').addEventListener('input', e => {
  state.bg = e.target.value;
  if(state.transparent){ state.transparent = false; $('bTransparent').classList.remove('on'); }
  applyStageBg();
});
$('bTransparent').addEventListener('click', e => {
  state.transparent = !state.transparent;
  e.currentTarget.classList.toggle('on', state.transparent);
  applyStageBg();
});

// ==========================================
// 14. STAGE SHORTCUT BUBBLE
// ==========================================
/* ---------- stage HUD ---------- */
const PLAY_D = 'M8 5l11 7-11 7z', PAUSE_D = 'M7 5v14M17 5v14';
function replay(){ t0 = performance.now(); playing = true; setPlayIcon(); }
function setPlayIcon(){ $('hudPlayIcon').setAttribute('d', playing ? PAUSE_D : PLAY_D); }
function togglePlay(){
  playing = !playing;
  if(playing) t0 = performance.now() - frozen*DUR*1000/eff.speed;
  setPlayIcon();
}
function togglePanel(){
  const pn = $('panel');
  pn.style.display = pn.style.display === 'none' ? '' : 'none';
  requestAnimationFrame(()=>{ W = 0; H = 0; });     // force the canvas to re-measure
}
$('hudToggle').addEventListener('click', ()=> $('hud').classList.toggle('open'));
$('hudPlay').addEventListener('click', togglePlay);
$('hudReplay').addEventListener('click', replay);
$('hudPanel').addEventListener('click', togglePanel);
$('hudFile').addEventListener('click', ()=> $('file').click());

let dragDepth = 0;
addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('drop').classList.add('on'); });
addEventListener('dragover',  e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
addEventListener('dragleave', e => { e.preventDefault(); if(--dragDepth <= 0){ dragDepth = 0; $('drop').classList.remove('on'); } });
addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; $('drop').classList.remove('on');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if(f) acceptFile(f);
  else {
    $('srcName').textContent = 'that drop carried no file — drag from Finder, not from a web page';
    $('srcKind').textContent = 'ERROR';
    $('srcChip').classList.add('on', 'err');
  }
});
addEventListener('keydown', e=>{
  if(e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if(e.key === 'h' || e.key === 'H') togglePanel();
  if(e.key === ' '){ e.preventDefault(); togglePlay(); }
  if(e.key === 'r' || e.key === 'R') replay();
});

// ==========================================
// 15. THEME MANAGEMENT (DARK/LIGHT)
// ==========================================
/* ---------- theme — same contract and assets as glued.studio ---------- *
 * The navicon is the switch, as on the home page. updateThemeImages swaps
 * in the other animated webp, and because the src changes the animation
 * replays from the first frame on every toggle — the blobs ripple orange
 * and the sun grows in. Both files are inlined so this works offline. */
/* localStorage throws in sandboxed iframes, so fall back to memory and
   keep working rather than taking the page down with it. */
const themeStore = (() => {
  let memo = null;
  return {
    get(){ try { return localStorage.getItem('site-theme'); } catch(e){ return memo; } },
    set(v){ try { localStorage.setItem('site-theme', v); } catch(e){ memo = v; } }
  };
})();

function updateThemeImages(isDark){
  const theme = isDark ? 'dark' : 'light';
  document.querySelectorAll('.navicon').forEach(el => {
    el.src = `../assets/navicon_${theme}_anim.webp`;
  });
}

function applySavedTheme(){
  const isDark = themeStore.get() !== 'light';
  document.documentElement.classList.toggle('dark-theme', isDark);
  updateThemeImages(isDark);
}

function toggleTheme(){
  const isDark = document.documentElement.classList.toggle('dark-theme');
  themeStore.set(isDark ? 'dark' : 'light');
  updateThemeImages(isDark);
}

$('logoBtn').addEventListener('click', toggleTheme);
$('logoBtn').addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggleTheme(); } });
applySavedTheme();

/* the canvas needs Poppins before it can match the logotype */
if(document.fonts && document.fonts.ready) document.fonts.ready.then(()=>drawSourceFrame());

// ==========================================
// 16. BOOT
// ==========================================
window.__set = v => { playing = false; frozen = v; setPlayIcon(); };
applyPreset(0);
uploadLUT(true);
setPlayIcon();
resize();
requestAnimationFrame(frame);

