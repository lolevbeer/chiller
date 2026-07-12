// --- 3D unit: hand-built three.js model of the cabinet (install-drawing
// proportions: 93.9 W × 66.4 H × 48.2 D in ≈ 240 × 170 × 123 model units,
// group scaled ×0.01). Glossy-white powder-coat PBR — reflections come from a
// tiny hand-built "room" baked into an environment map. Drag to rotate with
// pitch clamp (the 36 s turntable stays wired via `auto`, off by default),
// fans at live speed, compressors light up while running, honors
// prefers-reduced-motion.
//
// TWEAK MAP — geometry is authored in model units (1 unit ≈ 0.391 in),
// origin at the cabinet's center:
//   axes    +x = right when facing the front (the control-box end), +y = up,
//           +z = toward the viewer (the louvered-door face).
//   ranges  x −120…120, y −85…85, z −61.5…61.5. Landmarks: louvers at
//           z 59.5; right door spans x +5…+114 (left door mirrors); base-rail
//           top at y −73; door top band bottom at y 61; back skin at z −59.5.
//   parts   box(w, h, d, x, y, z, material) builds every panel — each call is
//           commented where it's made. Component index (search the name to
//           find its commented block, in build order):
//             cabinet shell    top/bottom/ends/back/base rail — one box() each
//             louvered doors   InstancedMesh slats; count/size/tilt in its block
//             control box      single box(), right end
//             compressors      compGeo = radius/height; zone y in the [y, i]
//                              pairs (i = circuit index into compMat); x/z in
//                              position.set
//             seal badges      badgeGeo + the seal canvas (SVG at /logo.svg)
//             glycol stubs     portGeo = radius/length; supply y −14, return
//                              y −37; x −124 = left end
//             reservoir        the 70×154×110 box + filler-cap cylinder
//             condenser zones  screens = the y loop over PlaneGeometry(148, 69)
//                              (mesh weave in the canvas block above it)
//             fans             bladeGeo/hubGeo; [x, y] spots feed the forEach;
//                              blade size/pitch live there too
//             zone labels      label() sprites, "A"/"B"
//   look    M(color, metalness, roughness) makes each material — steel, trim,
//           dark, bladeMat, COMP_ON/COMP_OFF/COMP_GLOW. Shine comes from the baked env
//           panels (k = brightness) plus `sun` and `backlight` (lights the
//           recessed fans); framing = camera fov 28, z 5, .scene height in CSS.
//   motion  turntable rate 2π/36 rad/s in frame(); fans 2.5 rev/s at 100 %;
//           drag feel = DRAG; vertical limits = PITCH_MIN/PITCH_MAX.
//   chips   chipAnchors = [chip id, x, y, z] pins each DOM reading to the unit;
//           placeChips() reprojects after every render; .far = anchor faces away.
import * as THREE from "/three.js";

const host = document.querySelector(".scene");
const noMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); // throws without WebGL — .flat stays on and the chips keep their fallback layout
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); // ponytail: sampled once — a cross-DPR monitor move renders soft until reload
renderer.toneMapping = THREE.ACESFilmicToneMapping;
host.appendChild(renderer.domElement);

const view = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, .1, 50);
// frame-filling zoom: pull in until the unit spans ~45 % of the scene width
// (10.7/aspect), floored at 4.4 where the cabinet's apparent height would
// clip instead (~207 units when pitched to the drag limit)
const fit = () => { const w = host.clientWidth, h = host.clientHeight;
  renderer.setSize(w, h); camera.aspect = w / h;
  camera.position.z = Math.max(4.4, 10.7 / camera.aspect);
  camera.updateProjectionMatrix(); };
fit(); new ResizeObserver(() => { fit(); unit3d.changed?.(); }).observe(host); // repaint + re-place chips after a resize (setSize clears the buffer)

{ // fake room baked to a reflection map: dim shell + three overbright panels
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.SphereGeometry(20),
    new THREE.MeshBasicMaterial({ color: 0x3d434b, side: THREE.BackSide })));
  const panel = (w, h, x, y, z, rx, ry, k) => { // k > 1 = overbright "light"
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k) }));
    p.position.set(x, y, z); p.rotation.set(rx, ry, 0); env.add(p); };
  panel(12, 6, 0, 14, 0, Math.PI / 2, 0, 6);    // ceiling light bar
  panel(20, 3, -15, 4, 0, 0, Math.PI / 2, 2.5); // long side window
  panel(10, 8, 8, 2, 14, 0, Math.PI, 1.2);      // soft front fill
  const pmrem = new THREE.PMREMGenerator(renderer);
  view.environment = pmrem.fromScene(env).texture;
  pmrem.dispose(); // one-time bake — free the generator's targets and the bake scene
  env.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
}
const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(3, 5, 4);
// back light: no shadows in this scene, so it reaches the recessed fans through
// the screens — without it they render near-black inside the cabinet
const backlight = new THREE.DirectionalLight(0xffffff, 1); backlight.position.set(-3, 4, -5);
view.add(sun, backlight, new THREE.AmbientLight(0xffffff, .25));

const M = (color, metalness, roughness) => new THREE.MeshStandardMaterial({ color, metalness, roughness });
// "steel" is the cabinet skin: glossy white powder-coat like the real panels
// (was brushed steel — name kept, every panel references it)
const steel = M(0xf2f4f6, .08, .2), trim = M(0x16171a, .7, .45), dark = M(0x0d0f13, .2, .85);
// low metalness: metal is all specular, which reads black inside the cabinet —
// diffuse is what makes the recessed blades visible under the backlight
const bladeMat = M(0x9aa3af, .35, .55); bladeMat.side = THREE.DoubleSide; // ring-sector blades are planar
const COMP_OFF = 0x415062, COMP_ON = 0x5f7ba1; // scroll-compressor steel blue, brighter while running
const COMP_GLOW = 0x2560a8; // emissive while running — reads as lit even in the louver shadow
const compMat = [0, 1].map(() => M(COMP_OFF, .8, .4)); // per circuit, recolored live

// pitch (outer) → yaw (inner) → unit: same composition as the old CSS transform
const pitchG = new THREE.Group(), yawG = new THREE.Group(), unit = new THREE.Group();
view.add(pitchG); pitchG.add(yawG); yawG.add(unit);
unit.scale.setScalar(.01);
pitchG.rotation.x = 0; // dead-on front view on load — no downward tilt (drag still pitches −30°…80°)

const box = (w, h, d, x, y, z, mat) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); unit.add(m); return m; };

// cabinet shell — the front is open behind the louvers so the compressors show
box(240, 4, 123, 0, 83, 0, steel);       // top
box(240, 4, 123, 0, -83, 0, dark);       // bottom
for (const x of [-118, 118]) box(4, 170, 123, x, 0, 0, steel); // end panels
// back panel in five pieces, leaving two real openings (x −40…108, y 8…77 /
// −69…0) behind the condenser screens so they actually see through
box(80, 170, 4, -80, 0, -59.5, steel);   // …blank third at the glycol end
box(12, 170, 4, 114, 0, -59.5, steel);   // …sliver at the control-box end
box(148, 8, 4, 34, 81, -59.5, steel);    // …top band
box(148, 8, 4, 34, 4, -59.5, steel);     // …belt between the zones
box(148, 16, 4, 34, -77, -59.5, steel);  // …bottom band
box(244, 12, 127, 0, -79, 0, trim);      // black base rail, slightly proud
box(240, 24, 4, 0, 73, 59.5, steel);     // door frame: top band…
for (const x of [-117.8, 117.8]) for (const z of [-59.3, 59.3]) box(6, 159, 6, x, 6.5, z, trim); // …black corner posts, full height, on all four corners (photo), nudged 0.8/0.3 proud of the skins and 1 above the top so no face is coplanar (z-fighting)…
// …and the black middle column between the doors (photo): runs from the base
// rail up through the top band, stopping ~1 in (2.5 units) short of the top —
// proud of the door plane, with a ladder of recessed slots down its center
box(18, 155, 5, 0, 4.5, 60, trim);
for (let y = 48.2; y >= -60.2; y -= 13.55) box(10, 7, 1, 0, y, 62.3, dark); // slots track the slat gaps
// flat door bezels flanking each louver stack (photo: white margins before the louvers)
for (const x of [-110, -9, 9, 110]) box(8, 134, 4, x, -6, 59.5, steel);
{ const cb = box(6, 53, 42, 122, 50, 0, M(0xe8ecef, .3, .3)); // control box, right end — upper third of the panel, horizontally centered (end-view drawing)
  cb.add(new THREE.LineSegments(new THREE.EdgesGeometry(cb.geometry), // edge outline so the white box reads on the white panel
    new THREE.LineBasicMaterial({ color: 0x141518 }))); }
unit.add(new THREE.LineSegments( // black edge trim on the cabinet silhouette
  new THREE.EdgesGeometry(new THREE.BoxGeometry(241, 171, 124)),
  new THREE.LineBasicMaterial({ color: 0x141518 })));

{ // louvered doors: 10 tilted slats each, gaps show the compressors — slats
  // span exactly between the door bezels (13..106 from the split, both doors)
  const slats = new THREE.InstancedMesh(new THREE.BoxGeometry(93, 8, 3), steel, 20);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(.55, 0, 0));
  const one = new THREE.Vector3(1, 1, 1);
  let i = 0;
  for (const x of [-59.5, 59.5]) for (let y = 55; y >= -67; y -= 13.55)
    slats.setMatrixAt(i++, m.compose(new THREE.Vector3(x, y, 59.5), q, one));
  unit.add(slats);
}
// scroll compressors, steel blue — one per zone (A top, B bottom), stacked at
// the same x just right of the door split, half-height, per the front-view
// drawing. compGeo = radius/height; A at y 20, B at y −44 (the [y, i] pairs,
// i = circuit index into compMat); x/z shared in position.set
const compGeo = new THREE.CylinderGeometry(18, 18, 39, 24);
[[20, 0], [-44, 1]].forEach(([y, i]) => { const c = new THREE.Mesh(compGeo, compMat[i]);
  c.position.set(60, y, 36); unit.add(c); });
// G&D seal on the round door badges, like the real unit: the vendor SVG
// (served at /logo.svg) is drawn white-on-black onto a canvas mapped to each
// badge's front cap. Cylinder-cap UVs transpose the axes (u tracks local z,
// v tracks local x), so the draw is pre-transposed with flipY off — the two
// transposes cancel and the seal lands upright once the cap faces the camera.
const seal = document.createElement("canvas"); seal.width = seal.height = 256;
const sealTex = new THREE.CanvasTexture(seal);
sealTex.colorSpace = THREE.SRGBColorSpace; sealTex.flipY = false;
{ const ctx = seal.getContext("2d");
  ctx.fillStyle = "#0c0d10"; ctx.fillRect(0, 0, 256, 256); // blank black cap until the SVG lands
  ctx.setTransform(0, 1, 1, 0, 0, 0); // swap the axes (see transpose note above)
  const img = new Image();
  img.onload = () => {
    // the SVG's ink is black and the cap needs it white — ctx.filter="invert(1)"
    // only shipped in Safari 18, so recolor via source-in on a scratch canvas
    // (keeps the ink's alpha, turns every inked pixel white) and stamp that on
    const s = Object.assign(document.createElement("canvas"), { width: 256, height: 256 });
    const g = s.getContext("2d");
    g.drawImage(img, 14, 14, 228, 228);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = "#fff"; g.fillRect(0, 0, 256, 256);
    ctx.drawImage(s, 0, 0); // transposed by the transform above, onto the black cap
    sealTex.needsUpdate = true; unit3d.changed?.();
  };
  img.src = "/logo.svg"; }
const sealMat = new THREE.MeshStandardMaterial({ map: sealTex, metalness: .4, roughness: .5 });
const badgeGeo = new THREE.CylinderGeometry(7, 7, 3, 20);
for (const x of [-60, 60]) { const b = new THREE.Mesh(badgeGeo, [trim, sealMat, trim]); // [side, front cap, back cap]
  b.rotation.x = Math.PI / 2; b.position.set(x, 73, 61); unit.add(b); } // round logo badges
// third seal low on the control-box end (photo): face front first, then yaw
// 90° about world Y — a pure yaw keeps the seal upright and un-mirrored
{ const b = new THREE.Mesh(badgeGeo, [trim, sealMat, trim]);
  b.rotation.x = Math.PI / 2; b.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  b.position.set(120.5, -14, 0); unit.add(b); } // centered on the panel, just below mid-height (end-view drawing)
// glycol stubs, left end, supply above return (drawing): y −14 = supply,
// y −37 = return; portGeo = radius/length, x −124 = how far they stick out
const portGeo = new THREE.CylinderGeometry(7, 7, 14, 16);
for (const y of [-14, -37]) { const p = new THREE.Mesh(portGeo, trim);
  p.rotation.z = Math.PI / 2; p.position.set(-124, y, 15); unit.add(p); }
// glycol reservoir: a tank filling the left third (facing the front) behind the
// left door — same end as its supply/return stubs — full height from the base
// rail to the top skin and full depth to the back panel (the blank rear third),
// plus the filler cap poking through the top skin (front-view drawing, top-left)
box(70, 154, 110, -75, 4, -2, M(0x525a64, .55, .45));
const cap = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 6, 12), trim);
cap.position.set(-105, 87, 30); unit.add(cap);

// condenser zones on the BACK, hugging the control-box end (screen-left when
// facing the back, per the rear-view drawing — blank reservoir third at the glycol
// end): one wide see-through mesh screen per zone over a real opening in the
// back skin, top = A, bottom = B, each spanning its fan pair; fans sit inside
// the cabinet just behind their screen, curved-sector blades on a hub
const fans = [], bladeGeo = new THREE.RingGeometry(8, 30, 12, 1, -.55, 1.1),
  hubGeo = new THREE.CylinderGeometry(9, 9, 8, 16);
{ // coil faces: fine mesh tiled from a tiny canvas — a see-through guard screen
  const c = Object.assign(document.createElement("canvas"), { width: 32, height: 32 });
  const g = c.getContext("2d"); g.strokeStyle = "#1a1d22"; g.lineWidth = 6;
  g.strokeRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(44, 20);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy(); // keeps the mesh from smearing at glancing angles
  const screen = new THREE.MeshStandardMaterial({ map: t, transparent: true,
    metalness: .6, roughness: .5, side: THREE.DoubleSide });
  const geo = new THREE.PlaneGeometry(148, 69);
  for (const y of [42.5, -34.5]) { const f = new THREE.Mesh(geo, screen);
    f.position.set(34, y, -60); unit.add(f); }
}
[[71.5, 42.5], [-3.5, 42.5], [71.5, -34.5], [-3.5, -34.5]].forEach(([x, y], n) => {
  const fan = new THREE.Group();
  const hub = new THREE.Mesh(hubGeo, bladeMat);
  hub.rotation.x = Math.PI / 2; fan.add(hub);
  for (let i = 0; i < 5; i++) {
    const arm = new THREE.Group(), b = new THREE.Mesh(bladeGeo, bladeMat);
    b.rotation.x = .4; // blade pitch so spinning blades catch light
    arm.rotation.z = i * 2 * Math.PI / 5; arm.add(b); fan.add(arm);
  }
  fan.position.set(x, y, -53); // inside: blades sweep z −59.1…−46.9, clear of the screen at −60
  fan.rotation.z = THREE.MathUtils.degToRad([0, 90, 45, 135][n]); // staggered so pairs don't spin in lockstep
  unit.add(fan); fans.push(fan);
});

// chips: the page's live readings, pinned to the machine. Each anchor is an
// empty Object3D riding the unit; placeChips() projects it to .scene pixels
// after every render. tick() fills the chips' inner ids like any DOM node —
// no data flows through here, only positions.
const chipAnchors = [ // [chip id, x, y, z (model units)]
  ["chipOut", -168, -2, 15],  // supply stub — out temp, setpoint, supply psi
  ["chipIn",  -168, -54, 15], // return stub — in temp, ΔT
  ["chipTop",  30, 108, 0],   // over the top skin — cooling demand
  ["chipRes", -105, 106, 30], // reservoir filler cap — reservoir temp
  ["chipA",   150, 34, 42],   // compressor A — low side
  ["chipB",   150, -58, 42],  // compressor B — low side
  ["chipAc",   34, 48, -85],  // condenser zone A (back) — high side + fan
  ["chipBc",   34, -40, -85], // condenser zone B (back) — high side + fan
].map(([id, x, y, z]) => { const o = new THREE.Object3D();
  o.position.set(x, y, z); unit.add(o); return [document.getElementById(id), o]; });
const wp = new THREE.Vector3();
const placeChips = () => {
  const w = host.clientWidth, h = host.clientHeight;
  for (const [el, o] of chipAnchors) {
    o.getWorldPosition(wp);
    el.classList.toggle("far", wp.z < -.35); // behind the cabinet's midplane = facing away
    wp.project(camera);
    el.style.left = THREE.MathUtils.clamp((wp.x + 1) / 2 * w, 70, w - 70) + "px"; // clamp: keep chips readable at the edges
    el.style.top = THREE.MathUtils.clamp((1 - wp.y) / 2 * h, 24, h - 24) + "px"; // vertical clamp too — short scenes (phones) push anchors past the strip
  }
};
let dirty = false; // a draw was skipped while offscreen/hidden — repaint once on re-entry
const render = () => { // every draw funnels through here, so the offscreen/hidden gate lives here too
  if (!visible || document.hidden) { dirty = true; return; }
  dirty = false;
  renderer.render(view, camera); placeChips();
};
// tick() (main script) pokes this after each refresh: recolor comps, redraw.
// unit3d is app.js's top-level const — global lexical bindings are visible here.
unit3d.changed = () => {
  compMat.forEach((m, i) => { const on = unit3d.comps[i];
    m.color.set(on ? COMP_ON : COMP_OFF); m.emissive.set(on ? COMP_GLOW : 0x000000); });
  // while the rAF loop is drawing every frame the recolor rides the next frame
  // free — render ourselves only when the loop is idle (or absent: noMotion)
  if (noMotion || !(auto || grab || fanSpd[0] > .1 || fanSpd[1] > .1)) render();
};

// drag to rotate — the auto-turntable is off on load (auto stays wired; flip
// it true to restore the 36 s tour). The group rotations are the only rotation
// state (radians), no shadow copies.
const DRAG = THREE.MathUtils.degToRad(.5); // rad per px of pointer travel
const PITCH_MIN = THREE.MathUtils.degToRad(-30), PITCH_MAX = THREE.MathUtils.degToRad(80);
let auto = false, grab = null; // loads front-facing (yaw 0), tilted by the pitch group only
host.addEventListener("pointerdown", e => {
  auto = false;
  grab = { x: e.clientX, y: e.clientY }; host.setPointerCapture(e.pointerId);
});
host.addEventListener("pointermove", e => {
  if (!grab) return;
  yawG.rotation.y += (e.clientX - grab.x) * DRAG;
  pitchG.rotation.x = THREE.MathUtils.clamp( // drag down = look from above, same feel as the old CSS model
    pitchG.rotation.x + (e.clientY - grab.y) * DRAG, PITCH_MIN, PITCH_MAX);
  grab = { x: e.clientX, y: e.clientY };
  if (noMotion) render();
});
host.addEventListener("pointerup", () => grab = null);
host.addEventListener("pointercancel", () => grab = null);

let visible = true; // skip drawing while scrolled offscreen (model tops the page, so this bites when scrolled past it)
const flush = () => { if (dirty) render(); }; // render() re-checks the gate itself
new IntersectionObserver(([e]) => { visible = e.isIntersecting; flush(); }).observe(host);
document.addEventListener("visibilitychange", flush);
let prev = performance.now();
const fanSpd = [0, 0]; // displayed fan speed % per zone, eased toward unit3d.fans in frame()
function frame(t) {
  const dt = Math.min((t - prev) / 1000, .1); prev = t; // clamp: throttled background tabs
  if (auto) yawG.rotation.y += dt * 2 * Math.PI / 36; // 36 s per revolution
  // ease displayed speed toward the live target (~3 s exponential time constant)
  // so the 5 s refreshes don't snap the blades between speeds
  for (const z of [0, 1]) fanSpd[z] += (unit3d.fans[z] - fanSpd[z]) * Math.min(1, dt / 3);
  // ponytail: 100% = 2.5 rev/s is display calibration, not physics — tune to taste
  fans.forEach((f, i) => f.rotation.z -= dt * 2 * Math.PI * 2.5 * fanSpd[i < 2 ? 0 : 1] / 100);
  // nothing moving (turntable stopped, not dragging, fans parked) → identical pixels, skip the draw;
  // data changes still show because unit3d.changed() renders on its own
  if (visible && (auto || grab || fanSpd[0] > .1 || fanSpd[1] > .1)) render();
  requestAnimationFrame(frame);
}
host.classList.remove("flat"); // the whole module built without throwing — drop the no-3D fallback layout (any throw above leaves it on)
fit(); // .flat changed the host's box; measure the real scene before the first paint
render(); // initial paint — with the turntable off, frame() skips identical frames and nothing else draws the first one
if (!noMotion) requestAnimationFrame(frame); // noMotion: unit3d.changed() and drag redraw as needed
