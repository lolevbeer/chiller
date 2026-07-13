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
//           dark, bladeMat, and COMP (per-circuit off/on/glow). Shine comes from the baked env
//           panels (k = brightness) plus `sun` and `backlight` (lights the
//           recessed fans); framing = camera fov 28, z 5, .scene height in CSS.
//           Bloom = BLOOM_STRENGTH/RADIUS/THRESHOLD on the composer (0 strength
//           disables it); the threshold is the load-bearing one — see its comment.
//   motion  turntable rate 2π/36 rad/s in frame(); fans 2.5 rev/s at 100 %;
//           drag feel = DRAG; vertical limits = PITCH_MIN/PITCH_MAX.
//   chips   chipAnchors = [chip id, x, y, z] pins each DOM reading to the unit;
//           placeChips() reprojects after every render; .far = anchor faces away.
import * as THREE from "/three.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const host = document.querySelector(".scene");
const noMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); // throws without WebGL — .flat stays on and the chips keep their fallback layout
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); // ponytail: sampled once — a cross-DPR monitor move renders soft until reload
renderer.toneMapping = THREE.ACESFilmicToneMapping;
host.appendChild(renderer.domElement);

const view = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, .1, 50);
// bloom: the cabinet is white powder-coat, so almost every panel sits near full
// luminance — THRESHOLD is what keeps this from turning the whole unit into a
// glowing blob. At .85 only the specular hotspots (the gloss highlights that
// roll off the door skins and the fan hubs) and the compressor emissive glow
// bleed, which is what a camera actually does. STRENGTH is the bleed's
// intensity, RADIUS how far it spreads. Turn STRENGTH to 0 to disable.
const BLOOM_STRENGTH = .3, BLOOM_RADIUS = .4, BLOOM_THRESHOLD = .85;
// the composer draws into an offscreen target, which does NOT inherit the
// canvas's MSAA — without `samples` every edge in the model goes jagged. Half-
// float keeps highlights above 1.0 so the bloom threshold has something to cut.
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1,
  { samples: 4, type: THREE.HalfFloatType })); // size is set by fit()
composer.addPass(new RenderPass(view, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD)); // size is set by fit()
composer.addPass(new OutputPass()); // the composer bypasses the renderer's own output stage — this re-applies ACES tone mapping + sRGB

// frame-filling zoom: pull in until the unit spans ~45 % of the scene width
// (10.7/aspect), floored at 4.4 where the cabinet's apparent height would
// clip instead (~207 units when pitched to the drag limit)
const compactView = matchMedia("(max-width: 760px)");
const fit = () => { const w = host.clientWidth,
  // On compact screens the host also contains the reflowed cards, so its total
  // height is not the canvas height. Give the model a stable landscape viewport.
  h = compactView.matches ? THREE.MathUtils.clamp(w * .58, 220, 420) : host.clientHeight;
  renderer.setSize(w, h); composer.setSize(w, h); camera.aspect = w / h;
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
// satin metal, not a mirror: a near-mirror blade sweeps the env map's bright spots
// past the camera once per revolution, which reads as strobing. The high roughness
// spreads that highlight across the whole sweep and the dimmer base color keeps it
// under the bloom threshold. Metal is pure specular, so inside the cabinet they'd
// go black on the env map alone — `backlight` is what keeps the recessed blades lit.
const bladeMat = M(0x9aa2ad, .55, .55); bladeMat.side = THREE.DoubleSide; // ring-sector blades are planar
// per-circuit identity: A blue, B green — the same pair as --ckt-a/--ckt-b in
// dashboard.html, so a compressor here and its series on the history chart match.
// Each circuit gets an idle (desaturated), running and emissive-glow color; the
// glow reads as lit even in the louver shadow.
const COMP = [
  { off: 0x39505f, on: 0x4a9fe0, glow: 0x1c5f9c }, // A — blue
  { off: 0x3a5546, on: 0x4cb782, glow: 0x1d6f4c }, // B — green
];
const compMat = COMP.map(c => M(c.off, .8, .4)); // per circuit, recolored live

// pitch (outer) → yaw (inner) → unit: same composition as the old CSS transform
const pitchG = new THREE.Group(), yawG = new THREE.Group(), unit = new THREE.Group();
view.add(pitchG); pitchG.add(yawG); yawG.add(unit);
unit.scale.setScalar(.01);
pitchG.rotation.x = 0; // dead-on front view on load — no downward tilt (drag still pitches −30°…80°)

const box = (w, h, d, x, y, z, mat) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); unit.add(m); return m; };

// the louver ladder: one pitch and blade thickness drive both the white door
// slats and the black separator's flat blades, so the openings stay aligned.
const SLAT_Y0 = 55, SLAT_PITCH = 13.55, SLAT_T = 4;
const SLAT_TILT = .4; // rad (~23°) — the shed angle of the white door slats

// cabinet shell — the front is open behind the louvers so the compressors show
box(240, 4, 123, 0, 83, 0, steel);       // top
box(240, 4, 123, 0, -83, 0, dark);       // bottom
box(4, 170, 123, -118, 0, 0, steel);      // end panel, glycol end
box(4, 170, 123, 118, 0, 0, steel);        // control-box end panel
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
// rail up through the top band, stopping ~1 in (2.5 units) short of the top.
// It is NOT a solid bar with painted-on slots — it's built like the real thing:
// two thin side rails with the channel between them left OPEN, louvered by its
// own flat black blades on the door ladder (same pitch and thickness). So the
// openings are real — you see into the cabinet through them — and each spans the
// same height as a door opening (pitch minus blade), lined up row for row.
// The separator overlaps the door bezels in x (rails at x 5…9, bezels at 5…13),
// so it MUST clear them in z or the two solids interpenetrate and z-fight. The
// bezels' front face is at z 61.5; every separator rail therefore sits entirely
// in front of it (0.4 deep at 61.8 → z 61.6…62.0 — no shared plane, no overlap).
// Nearly flush on purpose: 0.5 proud of the doors, just enough to read as a divider.
const SEP_Z = 61.8, SEP_D = .4;
for (const x of [-7, 7]) box(4, 155, SEP_D, x, 4.5, SEP_Z, trim); // the two side rails
{ // the channel is open (louvered) only where the doors have slats; above the top
  // blade and below the bottom one it's solid, like the doors' plain top band and
  // bottom margin — an open gap there would look like a hole in the separator.
  const TOP = 82, BOT = -73;                         // the column's extent
  const hi = SLAT_Y0 + SLAT_T / 2;                   // top edge of the topmost blade
  const lo = -67 - SLAT_T / 2;                       // bottom edge of the lowest one
  box(10, TOP - hi, SEP_D, 0, (TOP + hi) / 2, SEP_Z, trim); // solid above the ladder…
  box(10, lo - BOT, SEP_D, 0, (lo + BOT) / 2, SEP_Z, trim); // …and below it
}
for (let y = SLAT_Y0; y >= -67; y -= SLAT_PITCH) // flat blades, flush with the separator rails
  box(10, SLAT_T, SEP_D, 0, y, SEP_Z, trim);
// flat door bezels flanking each louver stack (photo: white margins before the louvers)
for (const x of [-110, -9, 9, 110]) box(8, 134, 4, x, -6, 59.5, steel);
// The pGD lives on this control box, not on the larger cabinet end panel behind
// it. Keep the mesh so pointer raycasts can bind the modal to the visible control.
const pgdPanel = box(6, 53, 42, 122, 50, 0, M(0xe8ecef, .3, .3)); // control box, right end — upper third of the panel, horizontally centered (end-view drawing)
{ pgdPanel.add(new THREE.LineSegments(new THREE.EdgesGeometry(pgdPanel.geometry), // edge outline so the white box reads on the white panel
    new THREE.LineBasicMaterial({ color: 0x141518 }))); }
unit.add(new THREE.LineSegments( // black edge trim on the cabinet silhouette
  new THREE.EdgesGeometry(new THREE.BoxGeometry(241, 171, 124)),
  new THREE.LineBasicMaterial({ color: 0x141518 })));

{ // louvered doors: 10 tilted slats each, gaps show the compressors — slats
  // span exactly between the door bezels (13..106 from the split, both doors)
  const slats = new THREE.InstancedMesh(new THREE.BoxGeometry(93, SLAT_T, 3), steel, 20); // thin sheet-metal blades — the gap between them carries the look
  const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(SLAT_TILT, 0, 0));
  const one = new THREE.Vector3(1, 1, 1);
  let i = 0;
  for (const x of [-59.5, 59.5]) for (let y = SLAT_Y0; y >= -67; y -= SLAT_PITCH)
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
// radius 4 reads as the real 2 in supply/return on screen (was 7, far too fat).
// ponytail: sized by eye, not by the 0.391 in/unit scale — that math says 2.56,
// which looked too thin; trust the render.
const portGeo = new THREE.CylinderGeometry(4, 4, 14, 16);
for (const y of [-14, -37]) { const p = new THREE.Mesh(portGeo, trim);
  p.rotation.z = Math.PI / 2; p.position.set(-124, y, 15); unit.add(p); }
// glycol reservoir: a tank filling the left third (facing the front) behind the
// left door — same end as its supply/return stubs — full height from the base
// rail to the top skin and full depth to the back panel (the blank rear third),
// plus the filler cap poking through the top skin at the back-left corner of the tank
box(70, 154, 110, -75, 4, -2, M(0x525a64, .55, .45));
const cap = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 6, 12), trim);
cap.position.set(-100, 87, -45); unit.add(cap);

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
  ["chipOut", -142, -6, 15],  // supply stub (−124, −14) — out temp
  ["chipIn",  -142, -46, 15], // return stub (−124, −37) — in temp
  ["chipTop",  30, 96, 0],    // over the top skin — cooling demand
  ["chipRes", -100, 96, -45], // reservoir filler cap — reservoir temp
  // One chip per circuit (low + high side merged — see dashboard.html), each anchored
  // at its own compressor (60, 20 / 60, −44) and carrying the whole loop. Offset out in
  // x and spread in y just far enough that the two tall chips clear the cabinet.
  ["chipA",   134, 40, 42],   // compressor A — the whole circuit A loop
  ["chipB",   134, -58, 42],  // compressor B — the whole circuit B loop
].map(([id, x, y, z]) => { const o = new THREE.Object3D();
  o.position.set(x, y, z); unit.add(o); return [document.getElementById(id), o]; });
const wp = new THREE.Vector3();
const placeChips = () => {
  const w = host.clientWidth, h = host.clientHeight;
  if (compactView.matches) { // CSS lays the cards out beneath the canvas on phones.
    for (const [el] of chipAnchors) {
      el.classList.remove("far"); el.style.left = ""; el.style.top = "";
    }
    return;
  }
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
  composer.render(); placeChips(); // composer, not renderer.render — the bloom passes live in it
};
// tick() (main script) pokes this after each refresh: recolor comps, redraw.
// unit3d is app.js's top-level const — global lexical bindings are visible here.
unit3d.changed = () => {
  compMat.forEach((m, i) => { const on = unit3d.comps[i], c = COMP[i];
    m.color.set(on ? c.on : c.off); m.emissive.set(on ? c.glow : 0x000000); });
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
let dragged = false; // a drag past SLOP is a rotate, not a click — see pointerup
const SLOP = 4;      // px of travel before a press stops counting as a click
host.addEventListener("pointerdown", e => {
  if (compactView.matches && e.target !== renderer.domElement) return;
  auto = false; dragged = false;
  grab = { x: e.clientX, y: e.clientY }; host.setPointerCapture(e.pointerId);
});
host.addEventListener("pointermove", e => {
  if (!grab) return void setPgdHover(e);
  setPgdHover();
  if (Math.abs(e.clientX - grab.x) > SLOP || Math.abs(e.clientY - grab.y) > SLOP) dragged = true;
  yawG.rotation.y += (e.clientX - grab.x) * DRAG;
  pitchG.rotation.x = THREE.MathUtils.clamp( // drag down = look from above, same feel as the old CSS model
    pitchG.rotation.x + (e.clientY - grab.y) * DRAG, PITCH_MIN, PITCH_MAX);
  grab = { x: e.clientX, y: e.clientY };
  if (noMotion) render();
});
host.addEventListener("pointerup", e => {
  const clickedPgd = grab && !dragged && overPgd(e); // a click on the panel, not a rotate that ended there
  grab = null;
  setPgdHover(clickedPgd ? null : e);
  if (clickedPgd) openPgd();
});
host.addEventListener("pointercancel", () => { grab = null; setPgdHover(); });
host.addEventListener("pointerleave", () => setPgdHover());

// The pGD is mounted on the control box of the real cabinet, so that box is the
// way into the controller here too: click it and the display opens. Raycast the
// whole unit and check the first MESH hit — decorative edge lines also raycast,
// but must not mask the visible solid under the pointer.
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let pgdHovered = false, pgdGlow = 0, pgdGlowTarget = 0;
function overPgd(e) {
  const r = renderer.domElement.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  ptr.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObject(unit, true).find(({ object }) => object.isMesh)?.object;
  return hit === pgdPanel;
}
function setPgdHover(e) {
  const hint = document.getElementById("pgdHint"), over = !!e && overPgd(e);
  host.style.cursor = over ? "pointer" : "";
  if (over !== pgdHovered) {
    pgdHovered = over;
    pgdGlowTarget = over ? 1 : 0;
    if (noMotion) { // reduced motion: apply the state without an animated transition
      pgdGlow = pgdGlowTarget;
      pgdPanel.material.emissive.setHex(0x303b85);
      pgdPanel.material.emissiveIntensity = pgdGlow * .8;
      render();
    }
  }
  if (!hint) return;
  hint.classList.toggle("show", over);
  if (over) {
    const r = host.getBoundingClientRect();
    hint.style.left = THREE.MathUtils.clamp(e.clientX - r.left + 12,
      8, r.width - hint.offsetWidth - 8) + "px";
    hint.style.top = THREE.MathUtils.clamp(e.clientY - r.top - hint.offsetHeight - 10,
      8, r.height - hint.offsetHeight - 8) + "px";
  }
}
function openPgd() {
  const dlg = document.getElementById("pgdDialog"), frame = document.getElementById("pgdFrame");
  if (!dlg || !frame) return;
  if (!frame.src && frame.dataset.src) frame.src = frame.dataset.src; // load on first open only
  dlg.showModal();
}
document.getElementById("pgdClose")?.addEventListener("click", () => document.getElementById("pgdDialog")?.close());

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
  // Ease the pGD control-box highlight in and out instead of flashing between
  // states. Exponential easing is frame-rate independent; ~120 ms is responsive
  // while still visibly soft.
  const glowBefore = pgdGlow;
  pgdGlow += (pgdGlowTarget - pgdGlow) * (1 - Math.exp(-dt / .12));
  if (Math.abs(pgdGlowTarget - pgdGlow) < .002) pgdGlow = pgdGlowTarget;
  const glowChanged = Math.abs(pgdGlow - glowBefore) > .0001;
  if (glowChanged) {
    pgdPanel.material.emissive.setHex(0x303b85);
    pgdPanel.material.emissiveIntensity = pgdGlow * .8;
  }
  // ponytail: 100% = 2.5 rev/s is display calibration, not physics — tune to taste
  fans.forEach((f, i) => f.rotation.z -= dt * 2 * Math.PI * 2.5 * fanSpd[i < 2 ? 0 : 1] / 100);
  // nothing moving (turntable stopped, not dragging, fans parked) → identical pixels, skip the draw;
  // data changes still show because unit3d.changed() renders on its own
  if (visible && (auto || grab || fanSpd[0] > .1 || fanSpd[1] > .1 || glowChanged)) render();
  requestAnimationFrame(frame);
}
host.classList.remove("flat"); // the whole module built without throwing — drop the no-3D fallback layout (any throw above leaves it on)
fit(); // .flat changed the host's box; measure the real scene before the first paint
render(); // initial paint — with the turntable off, frame() skips identical frames and nothing else draws the first one
if (!noMotion) requestAnimationFrame(frame); // noMotion: unit3d.changed() and drag redraw as needed
