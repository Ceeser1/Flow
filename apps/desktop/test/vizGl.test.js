'use strict';

// The visualizers' shared WebGL (renderer/app/viz/gl.js): a visualizer's
// programs compiled ahead in the canvas it will open in (stage), and, in a
// browser that cannot compile in the background, its canvas kept with its
// programs when it closes (lose). Against a WebGL that only counts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app', 'viz', 'gl.js'), 'utf8');

/** VizGL in a page of its own whose canvases have a counting WebGL 2; parallel: whether it compiles in the background. */
function page({ parallel }) {
  const canvases = [];
  const makeGl = (canvas, opts) => {
    const real = {
      canvas,
      opts,
      lost: false,
      linked: [],
      made: { Texture: 0, Buffer: 0 },
      deleted: { Texture: 0, Buffer: 0 },
      getExtension(name) {
        if (name === 'KHR_parallel_shader_compile') return parallel ? { COMPLETION_STATUS_KHR: 'completion' } : null;
        if (name === 'WEBGL_lose_context') return { loseContext: () => { real.lost = true; } };
        return null;
      },
      isContextLost: () => real.lost,
      createShader: (type) => ({ type }),
      shaderSource(shader, text) {
        shader.text = text;
      },
      createProgram: () => ({ shaders: [] }),
      attachShader(program, shader) {
        program.shaders.push(shader);
      },
      linkProgram(program) {
        real.linked.push(program);
      },
      // Compiled and linked, whenever asked; no uniforms; any other question: 16.
      getProgramParameter: (program, what) => (what === 'ACTIVE_UNIFORMS' ? 0 : true),
      getShaderParameter: () => true,
      getParameter: () => 16,
      createTexture() {
        real.made.Texture += 1;
        return { texture: real.made.Texture };
      },
      deleteTexture() {
        real.deleted.Texture += 1;
      },
      createBuffer() {
        real.made.Buffer += 1;
        return { buffer: real.made.Buffer };
      },
      deleteBuffer() {
        real.deleted.Buffer += 1;
      },
    };
    // Anything else: a constant is its own name, a call does nothing.
    return new Proxy(real, {
      get(target, name) {
        if (name in target) return target[name];
        if (typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name)) return name;
        return () => null;
      },
    });
  };
  const document = {
    createElement() {
      const canvas = {
        width: 300,
        height: 150,
        gl: null,
        getContext(kind, opts) {
          if (kind !== 'webgl2') return null;
          if (!canvas.gl) canvas.gl = makeGl(canvas, opts);
          return canvas.gl;
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  const timers = [];
  const context = vm.createContext({
    document,
    console,
    setInterval: (fn) => timers.push(fn),
    clearInterval: (id) => {
      timers[id - 1] = null;
    },
  });
  vm.runInContext(`${SOURCE}\nthis.VizGL = VizGL;`, context);
  return { VizGL: context.VizGL, document, canvases, tick: () => timers.forEach((fn) => fn && fn()) };
}

/** A visualizer's create(canvas): a context with options of its own, two programs, a texture and a buffer. */
function visualizer(VizGL, got = {}) {
  return (canvas) => {
    const gl = VizGL.context(canvas, { antialias: true });
    got.first = VizGL.program(gl, 'vertex', 'first');
    got.second = VizGL.programLater(gl, 'vertex', 'second');
    gl.createTexture();
    gl.createBuffer();
    return {
      gl,
      destroy() {
        VizGL.lose(gl);
      },
    };
  };
}

test('stage: the programs are started in the canvas the visualizer then opens in, and none is compiled twice', () => {
  const { VizGL, canvases, tick } = page({ parallel: true });
  const made = VizGL.stage(visualizer(VizGL));
  assert.ok(made && made.canvas);
  const gl = made.canvas.getContext('webgl2');
  // Its context was made with the visualizer's own options, and both its programs are compiling in it.
  assert.equal(gl.opts.antialias, true);
  assert.equal(gl.linked.length, 2);
  // The throwaway canvas the programs were noted on compiled nothing and is gone.
  const scratch = canvases.find((c) => c !== made.canvas && c.gl && c.gl.opts && c.gl.opts.antialias);
  assert.equal(scratch.gl.linked.length, 0);
  assert.equal(scratch.gl.lost, true);
  tick();

  // Opening it: the same two programs, nothing compiled again.
  const got = {};
  const scene = visualizer(VizGL, got)(made.canvas);
  assert.equal(scene.gl, gl);
  assert.equal(gl.linked.length, 2);
  assert.equal(got.first.p, gl.linked[0]);
  assert.equal(got.second.ready(), true);
  assert.equal(got.second.done().p, gl.linked[1]);
  // Each is handed out once: the same shaders asked for again are compiled anew, as are others.
  VizGL.program(gl, 'vertex', 'first');
  VizGL.program(gl, 'vertex', 'third');
  assert.equal(gl.linked.length, 4);
  // Where the browser keeps programs itself, a visualizer done drops its context.
  scene.destroy();
  assert.equal(gl.lost, true);
  assert.equal(VizGL.kept(made.canvas), false);
});

test('stage: one not wanted after all is dropped', () => {
  const { VizGL } = page({ parallel: true });
  const made = VizGL.stage(visualizer(VizGL));
  made.drop();
  assert.equal(made.canvas.getContext('webgl2').lost, true);
});

test('stage: nothing where the browser cannot compile in the background (it would hold the picture up just the same)', () => {
  const { VizGL } = page({ parallel: false });
  assert.equal(VizGL.background(), false);
  assert.equal(VizGL.stage(visualizer(VizGL)), null);
});

test('lose: where the browser cannot compile in the background, the canvas is kept with its programs and emptied of the rest', () => {
  const { VizGL, document } = page({ parallel: false });
  const canvas = document.createElement('canvas');
  const scene = visualizer(VizGL)(canvas);
  const gl = scene.gl;
  assert.equal(gl.linked.length, 2);
  canvas.width = 1920;
  canvas.height = 1080;
  assert.equal(VizGL.kept(canvas), false);

  scene.destroy();
  assert.equal(gl.lost, false);
  assert.deepEqual({ ...gl.deleted }, { Texture: 1, Buffer: 1 });
  assert.deepEqual([canvas.width, canvas.height], [300, 150]);
  assert.equal(VizGL.kept(canvas), true);

  // Its next time in the same canvas: the programs it had, none compiled again.
  const got = {};
  const again = visualizer(VizGL, got)(canvas);
  assert.equal(gl.linked.length, 2);
  assert.equal(got.first.p, gl.linked[0]);
  assert.equal(got.second.done().p, gl.linked[1]);
  // What it deleted itself is not deleted a second time.
  gl.deleteTexture(gl.createTexture());
  again.destroy();
  assert.deepEqual({ ...gl.deleted }, { Texture: 3, Buffer: 2 });
  assert.equal(VizGL.kept(canvas), true);

  // Another visualizer in the same canvas compiles its own, and both keep theirs in it.
  const other = VizGL.context(canvas, { antialias: true });
  assert.equal(other, gl);
  const third = VizGL.program(gl, 'vertex', 'third');
  assert.equal(gl.linked.length, 3);
  VizGL.lose(gl);
  const back = {};
  visualizer(VizGL, back)(canvas);
  assert.equal(VizGL.program(gl, 'vertex', 'third').p, third.p);
  assert.equal(back.first.p, gl.linked[0]);
  assert.equal(gl.linked.length, 3);
  VizGL.lose(gl);

  // Given up: gone for good.
  VizGL.drop(canvas);
  assert.equal(gl.lost, true);
  assert.equal(VizGL.kept(canvas), false);
});

test('key: the options a canvas is kept under, the usual ones left out or not', () => {
  const { VizGL } = page({ parallel: false });
  assert.equal(VizGL.key(true), VizGL.key({}));
  assert.equal(VizGL.key({ antialias: false }), VizGL.key({}));
  assert.notEqual(VizGL.key({ antialias: true }), VizGL.key({}));
  assert.notEqual(VizGL.key({ antialias: true }), VizGL.key({ antialias: true, depth: true }));
});
