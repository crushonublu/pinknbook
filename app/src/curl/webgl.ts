/**
 * Cylinder deformation adapted from XBPageCurl.
 * Copyright (C) 2011 xissburg, http://xissburg.com
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import type { Curl } from "./geometry";
import { drawCurl, type Scene } from "./render";

export interface CurlRenderer {
  setScene(scene: Scene): void;
  draw(curl: Curl): void;
  clear(): void;
  destroy(): void;
}

export class CanvasCurlRenderer implements CurlRenderer {
  private scene!: Scene;
  constructor(private ctx: CanvasRenderingContext2D) {}
  setScene(scene: Scene) { this.scene = scene; }
  draw(curl: Curl) { drawCurl(this.ctx, this.scene, curl); }
  clear() {}
  destroy() {}
}

const vertex = `
attribute vec2 position;
uniform vec2 size, viewport, grab, direction;
uniform float axis, radius, spine, mirror, mode;
varying vec2 uv, sheet;
varying float normalZ;
void main() {
  vec2 p = position * size;
  uv = position;
  sheet = p;
  float z = 0.0;
  normalZ = 1.0;
  if (mode == 1.0) {
    float n = dot(p - grab, direction);
    float d = axis - n;
    float r = max(radius, 0.0001);
    if (d > 0.0) {
      float angle = min(d / r, 3.14159265359);
      float mapped = axis - r * sin(angle);
      z = r * (1.0 - cos(angle));
      normalZ = cos(angle);
      if (d >= 3.14159265359 * r) mapped = axis + d - 3.14159265359 * r;
      p += direction * (mapped - n);
    }
  } else if (mode == 2.0) p.x -= size.x;
  vec2 screen = vec2(spine + mirror * p.x, p.y);
  gl_Position = vec4(screen.x / viewport.x * 2.0 - 1.0,
                     1.0 - screen.y / viewport.y * 2.0,
                     0.8 - z / (size.x * 2.0) - (mode == 1.0 ? 0.01 : 0.0), 1.0);
}`;
const fragment = `
precision mediump float;
uniform sampler2D page;
uniform vec2 size, grab, direction;
uniform float axis, radius, mode, dark, strength, rollEdge;
varying vec2 uv, sheet;
varying float normalZ;
void main() {
  vec3 color = texture2D(page, uv).rgb;
  if (mode == 1.0) {
    float shade = 1.0 - abs(normalZ);
    color *= 1.0 - 0.34 * shade;
    color += vec3(dark * (0.10 * shade + 0.06 * step(normalZ, 0.0) * strength));
  } else if (mode == 0.0) {
    float n = dot(sheet - grab, direction);
    float edge = rollEdge;
    float width = max(1.0, 0.105 * size.x + 1.2 * radius);
    float shadow = (1.0 - smoothstep(0.0, width, edge - n)) * step(n, edge);
    // Invert the flat mirrored part to find its paper edges for contact shading.
    float sourceN = 2.0 * axis - 3.14159265359 * radius - n;
    vec2 source = sheet + direction * (sourceN - n);
    float border = min(min(source.x, size.x-source.x), min(source.y, size.y-source.y));
    float contact = (1.0-smoothstep(0.0, max(1.0, size.x*.012), abs(border)))
      * step(-size.x*.012, border) * step(sourceN, axis-3.14159265359*radius);
    float shade = max(0.30 * shadow, 0.20 * contact) * strength;
    color = color * (1.0 - shade * (1.0-dark)) + vec3(shade * dark * .25);
  }
  gl_FragColor = vec4(color, 1.0);
}`;

/** Persistent GPU canvas. The original 2D canvas remains the loss-safe backup.
 * Texture uploads and mesh construction occur once per scene, never per frame. */
export class WebGLCurlRenderer implements CurlRenderer {
  private canvas = document.createElement("canvas");
  private gl: WebGLRenderingContext;
  private program!: WebGLProgram;
  private vertices!: WebGLBuffer;
  private indices!: WebGLBuffer;
  private position = 0;
  private textures: WebGLTexture[] = [];
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private count = 0;
  private meshW = 0;
  private meshH = 0;
  private scene: Scene | null = null;
  private last: Curl | null = null;
  private failed = false;
  private turnFailed = false;
  private dark = 0;
  constructor(private fallback: CanvasCurlRenderer, private base: HTMLCanvasElement) {
    const gl = this.canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) throw new Error("WebGL unavailable");
    this.gl = gl;
    this.canvas.className = "curl-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.style.display = "none";
    try { this.init(); } catch (e) { this.dispose(); throw e; }
    base.after(this.canvas);
    this.canvas.addEventListener("webglcontextlost", this.lost);
    this.canvas.addEventListener("webglcontextrestored", this.restored);
  }
  private lost = (event: Event) => {
    event.preventDefault();
    this.failed = this.turnFailed = true;
    this.clear();
    if (this.last) this.fallback.draw(this.last);
  };
  private restored = () => {
    // Keep this turn on 2D; only a new scene may select GPU again.
    try { this.init(); this.failed = false; } catch { this.dispose(); this.failed = true; }
  };
  private init() {
    const gl = this.gl;
    const compile = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error(log ?? "curl shader");
      }
      return s;
    };
    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision ? "highp" : "mediump";
    const vs = compile(gl.VERTEX_SHADER, "precision " + precision + " float;\n" + vertex);
    let fs: WebGLShader;
    try { fs = compile(gl.FRAGMENT_SHADER, fragment.replace("precision mediump float;", "precision " + precision + " float;")); } catch (e) { gl.deleteShader(vs); throw e; }
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vs); gl.attachShader(this.program, fs); gl.linkProgram(this.program);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error("curl link");
    this.position = gl.getAttribLocation(this.program, "position");
    for (const name of ["size", "viewport", "grab", "direction", "axis", "radius", "spine", "mirror", "mode", "dark", "strength", "rollEdge", "page"])
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    this.vertices = gl.createBuffer()!; this.indices = gl.createBuffer()!;
    this.meshW = this.meshH = 0;
    this.textures = [];
    for (let i = 0; i < 4; i++) {
      const tex = gl.createTexture()!; this.textures.push(tex);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
  }
  setScene(s: Scene) {
    this.fallback.setScene(s);
    if (this.scene === s) return;
    this.scene = s; this.last = null;
    this.turnFailed = this.failed;
    if (this.turnFailed) return;
    const gl = this.gl;
    try {
      this.canvas.width = this.base.width; this.canvas.height = this.base.height;
      // Parse CSS paper once per turn, including hex and named colors.
      const sample = document.createElement("canvas").getContext("2d")!;
      sample.fillStyle = s.paper; sample.fillRect(0, 0, 1, 1);
      const rgb = sample.getImageData(0, 0, 1, 1).data;
      this.dark = (rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722)/255 < .35 ? 1 : 0;
      const sources = [s.front, s.back, s.under, s.opposite];
      for (let i = 0; i < sources.length; i++) if (sources[i]) {
        gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sources[i] as HTMLCanvasElement);
      }
      if (gl.getError() !== gl.NO_ERROR) throw new Error("curl texture upload");
      if (s.W !== this.meshW || s.H !== this.meshH) {
        const nx = s.W > s.H ? 48 : 32, ny = s.H >= s.W ? 48 : 32;
        const points = new Float32Array((nx+1)*(ny+1)*2);
        let k = 0;
        for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) { points[k++] = x/nx; points[k++] = y/ny; }
        const elements = new Uint16Array(nx*ny*6+6);
        // First six indices form a flat quad; the rest form the deformable grid.
        elements.set([0,nx,ny*(nx+1),nx,(ny+1)*(nx+1)-1,ny*(nx+1)]);
        k = 6;
        for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
          const a = y*(nx+1)+x, b = a+nx+1;
          elements[k++]=a; elements[k++]=a+1; elements[k++]=b;
          elements[k++]=a+1; elements[k++]=b+1; elements[k++]=b;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices); gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, elements, gl.STATIC_DRAW);
        this.count = elements.length; this.meshW=s.W; this.meshH=s.H;
      }
    } catch { this.turnFailed = true; this.clear(); }
  }
  draw(c: Curl) {
    this.last = c;
    if (this.turnFailed || this.failed || this.gl.isContextLost()) { this.clear(); this.fallback.draw(c); return; }
    const s = this.scene!, gl = this.gl, u = this.uniforms;
    gl.useProgram(this.program);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0,0,0,0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertices); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices);
    gl.enableVertexAttribArray(this.position); gl.vertexAttribPointer(this.position,2,gl.FLOAT,false,0,0);
    gl.uniform2f(u.size,s.W,s.H); gl.uniform2f(u.viewport,this.canvas.width/s.dpr,this.canvas.height/s.dpr);
    gl.uniform2f(u.grab,c.G.x,c.G.y); gl.uniform2f(u.direction,c.u.x,c.u.y);
    gl.uniform1f(u.axis,c.a <= .5 ? -100000 : c.a); gl.uniform1f(u.radius,c.R);
    // Minimum corner projection without allocating maxRolled's corner array.
    const minN = -c.G.x*c.u.x-c.G.y*c.u.y + Math.min(0,s.W*c.u.x) + Math.min(0,s.H*c.u.y);
    const rolled = Math.min(c.a-minN,Math.PI*c.R);
    gl.uniform1f(u.rollEdge,c.a-c.R*Math.sin(Math.min(rolled/Math.max(c.R,1e-6),Math.PI/2)));
    gl.uniform1f(u.spine,s.spine); gl.uniform1f(u.mirror,s.m); gl.uniform1f(u.dark,this.dark);
    gl.uniform1f(u.strength,Math.min(1,c.a/(.04*s.W))*Math.min(1,Math.hypot(c.F.x+c.G.x,c.F.y-c.G.y)/(.3*s.W)));
    gl.uniform1i(u.page,0); gl.activeTexture(gl.TEXTURE0);
    // Match Canvas' spine clip, including diagonally lifted sheets.
    gl.enable(gl.SCISSOR_TEST);
    const left = s.spread ? s.spine-s.W : s.spine;
    const right = s.spread ? s.spine+s.W : s.spine+2*s.W;
    const clipLeft = Math.max(0,Math.round(left*s.dpr));
    gl.scissor(clipLeft,0,Math.max(0,Math.round(right*s.dpr)-clipLeft),this.canvas.height);
    gl.disable(gl.CULL_FACE);
    if (s.spread && s.opposite) this.pass(3,2);
    this.pass(2,0);
    gl.enable(gl.CULL_FACE); gl.frontFace(s.m === 1 ? gl.CW : gl.CCW);
    gl.cullFace(gl.BACK); this.pass(0,1);
    gl.cullFace(gl.FRONT); this.pass(1,1);
    gl.disable(gl.SCISSOR_TEST);
    if (this.canvas.style.display !== "block") {
      this.canvas.style.display = "block";
      this.base.style.visibility = "hidden";
    }
  }
  private pass(texture: number, mode: number) {
    const gl = this.gl;
    gl.uniform1f(this.uniforms.mode,mode); gl.bindTexture(gl.TEXTURE_2D,this.textures[texture]);
    gl.drawElements(gl.TRIANGLES,mode === 1 ? this.count : 6,gl.UNSIGNED_SHORT,mode === 1 ? 12 : 0);
  }
  clear() { this.canvas.style.display = "none"; this.base.style.visibility = ""; }
  private dispose() {
    const gl = this.gl;
    for (const texture of this.textures) gl.deleteTexture(texture);
    if (this.vertices) gl.deleteBuffer(this.vertices);
    if (this.indices) gl.deleteBuffer(this.indices);
    if (this.program) gl.deleteProgram(this.program);
  }
  destroy() {
    this.clear(); this.canvas.removeEventListener("webglcontextlost",this.lost);
    this.canvas.removeEventListener("webglcontextrestored",this.restored);
    this.dispose(); this.canvas.remove();
  }
}
