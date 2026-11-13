import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Terrain } from './terrain';
import { Rocks } from './rocks';
import { Clock, Sun, utcToEt, fmtJST, jstDate, MISSION_T0, MISSION_T1, initialMissionMs } from './time';
import { getJSON, loadGravity, loadSc, scAtG, GRADE_LABEL, GRADE_LABEL_EN, HeightMap, loadRegistry, url, Gravity, ScTable } from './data';
import { sampleGravity } from './gravity';
import { buildThermalTable, sampleThermal, ThermalTable } from './thermal';
import { V3, v3, geoToBody, bodyToGeo, bodyToThree, fmtLat, fmtLon, R_MEAN, DEG, hash2, surfDist } from './geo';
import { launch, advance, bodyOf, velBodyOf, isEscape, altitude, Orbit, OMEGA_763 } from './physics';
import { skyFor, applySky, Layer, PAPER } from './sky';
import { setRegistry, credit, mark } from './credits';
import { t, lang } from './i18n';
import { Hud, Hint, Card, Viewer, Intro, tierText, Mode, esc } from './ui';
import { nearby, World, Poi } from './search';
import { Sound } from './audio';
import { exportSession, Session } from './archive';
import { MascotReplay, MascotData, SITE, T_SEP, T_END, T_TRAJ_END } from './mascot';
import { Library } from './library';
import { TimeSlider } from './timeslider';
import { buildEvents, EventUi, nextEvent, fmtCountdown, REvent, FOLDER_NOTE, SCI_MS } from './events';
import { SpaceButton } from './spacebtn';
import { MiniMap } from './minimap';
import { Annotator, featureCard, placesListHtml } from './annot';
import { prepare, FeatureFile, PFeature, regionsAt } from './features_core';
import { SpaceFlight, ASCEND_S, TIME_COMPRESS } from './space';
import './mobile.css';

const $ = (id: string) => document.getElementById(id)!;
const canvas = $('gl') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 6000); scene.add(camera);
const hud = new Hud(), hint = new Hint(), card = new Card(), viewer = new Viewer(), sound = new Sound(); const library = new Library();
function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

// ---------------- state
let layer: Layer = 'walk'; let mode: Mode = 1;
const EYE = 1.5, DRIVE_SPEED = 8, DRIVE_BOOST = 16, DRIVE_ACCEL = 12, DRIVE_BRAKE = 18, TURN_RATE = 1.2, GROUND_LAUNCH = 9;
const MAX_DRIVE_SLOPE = 55, MAX_DRIVE_STEP = 0.4, DRIVE_SUBSTEP = 0.2, JUMP_V = 0.30;
const P = { dir: geoToBody(4.3, 206.47, 1) as V3, fwd: [0, 0, 1] as V3, pitch: 0, stand: 0, dip: 0 };
let orbit: Orbit | null = null; let pastMode = false;
let sp: SpaceFlight | null = null; let camXf: { q0: THREE.Quaternion; t: number; dur: number } | null = null; let spFxT = 0;
const isTouch = matchMedia('(pointer:coarse)').matches; const mqCompact = matchMedia('(pointer:coarse), (max-width:640px)');
const spLook = { yaw: 0, pitch: 0, t: 0 };   // 宇宙モードの見回し（ドラッグ）。位置は動かさず視線だけ回す
const pad = { up: false, down: false };      // 上昇/降下ボタン（タッチ端末のみ表示）
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const keys = new Set<string>(); let lastInput = performance.now(); const used = new Set<string>(); const hintShown: Record<string, number> = {};
const session: Session = { callsign: '', start: new Date().toISOString(), track: [], inspected: new Set() };
let world: World; let G763!: Gravity, G340!: Gravity, G: Gravity; let sc!: ScTable; let sun!: Sun; let hm!: HeightMap; let terrain!: Terrain; let rocks!: Rocks; let mascot!: MascotReplay;
let timeline: any; const clock = new Clock(initialMissionMs()); let ready = false; let rotation: any;
let sunLight!: THREE.DirectionalLight; let burst!: THREE.Points; let scMesh: THREE.Object3D | null = null; let scDot!: THREE.Mesh; let starPts!: THREE.Points; let sunDot!: THREE.Mesh; let sunGlow!: THREE.Sprite; let shadow!: THREE.Mesh; let markers!: THREE.Group; let mascotMarker!: THREE.Mesh; let craterMark: THREE.Group | null = null;
let earthDot!: THREE.Mesh; let earthHalo!: THREE.Mesh;
let craterDir: V3 = [0, 0, 1]; let craterSnap: number | null = null;
let nearHits: ReturnType<typeof nearby> = []; let mascotImg: HTMLImageElement | null = null; let mascotImgId = '';
let events: REvent[] = []; let eventUi!: EventUi; let slider!: TimeSlider; let minimap!: MiniMap;
let annot: Annotator | null = null; let annotOn = true; let lastInside = '';   // 地名・イベント注釈（視界内ラベル＋地形の色付け）
let bgK = 1; let skyWhite = 1;            // P1-4: 空の白さ 0..1（1=白い空/歩行の昼, 0=星空）1.5秒で線形遷移
let compress = 1;            // P1-4: 弾道飛行の無操作時間圧縮（演出E）

function tr(p: V3) { const q = bodyToThree(p); return new THREE.Vector3(q[0], q[1], q[2]); }
function lookAt(from: V3, fwd: V3, up: V3, pitch: number) {
  const f = v3.norm(v3.sub(fwd, v3.mul(up, v3.dot(fwd, up)))); const r = v3.cross(f, up); const fp = v3.add(v3.mul(f, Math.cos(pitch)), v3.mul(up, Math.sin(pitch)));
  camera.position.copy(tr(from)); camera.up.copy(tr(up)); camera.lookAt(tr(v3.add(from, fp)));
}

// ---------------- ground (§4.2): rocks -> displacement patch -> collision mesh -> heightmap, highest wins
function groundAt(dir: V3): number { const base = terrain.groundRadius(dir); const pr = terrain.patchRadius(dir); const rt = rocks.topAt(v3.mul(dir, base)); return Math.max(base, pr ?? -Infinity, rt); }
function upAt(dir: V3, lat: number, lon: number): V3 { const g = sampleGravity(G, lat, lon); return v3.norm(v3.mul(g.g, -1)); }

// ---------------- init
async function boot() {
  Intro.line('2018-03-01');
  // 読み込み中は白い点ではなく、リュウグウ（そろばん玉型・赤道の尾根）が読み込みとともに大きくなる
  const ry = document.createElement('div'); ry.className = 'ryugu-load'; ry.setAttribute('aria-hidden', 'true');
  // 実際の形状モデル（49k面, 赤道方向からの輪郭を点群のメッシュから抽出）。回転はしない。
  ry.innerHTML = '<svg viewBox="-100 -100 200 200" aria-hidden="true"><path d="M-3.1 91.4 L-6.5 91.4 L-9.9 90.0 L-10.7 87.9 L-11.0 85.7 L-13.3 84.7 L-15.7 82.0 L-21.7 77.4 L-23.4 77.4 L-25.6 78.4 L-28.7 78.1 L-29.7 76.0 L-36.2 73.1 L-45.7 71.9 L-46.6 71.6 L-49.0 69.7 L-52.7 69.4 L-54.2 67.9 L-55.0 65.2 L-57.9 62.3 L-58.1 61.4 L-64.4 53.6 L-70.7 44.9 L-79.8 31.4 L-80.6 29.7 L-84.4 26.6 L-84.2 23.9 L-86.2 20.9 L-88.0 20.3 L-89.3 15.9 L-92.3 12.7 L-94.3 11.8 L-94.3 10.4 L-95.5 6.3 L-98.9 0.2 L-100.1 -3.9 L-99.9 -6.8 L-99.2 -8.5 L-93.4 -19.6 L-91.7 -22.0 L-90.7 -25.4 L-88.9 -26.2 L-88.0 -28.0 L-86.4 -29.5 L-86.4 -30.7 L-85.4 -32.4 L-84.9 -34.8 L-83.7 -37.0 L-80.7 -38.8 L-78.5 -41.2 L-76.8 -42.1 L-75.2 -44.0 L-74.2 -46.3 L-70.3 -47.9 L-65.0 -53.0 L-58.7 -56.9 L-54.1 -61.0 L-48.8 -64.6 L-45.9 -66.1 L-39.9 -70.7 L-38.5 -72.5 L-36.7 -74.3 L-33.8 -76.2 L-29.0 -81.5 L-27.3 -82.2 L-22.2 -86.8 L-19.3 -88.0 L-15.5 -90.5 L-11.6 -93.8 L-9.2 -94.6 L-6.5 -94.6 L-5.8 -95.0 L-2.7 -94.8 L2.2 -92.4 L9.2 -90.5 L13.0 -90.5 L17.1 -89.5 L25.6 -89.7 L30.7 -86.8 L31.4 -85.6 L38.2 -83.2 L42.3 -81.0 L42.9 -80.0 L45.3 -78.0 L46.0 -76.3 L48.6 -73.8 L51.4 -71.9 L53.1 -69.9 L58.9 -65.3 L62.2 -61.4 L62.2 -57.7 L63.0 -56.9 L64.5 -56.4 L66.1 -54.3 L66.8 -51.2 L69.0 -47.8 L69.9 -44.7 L76.9 -36.0 L82.2 -30.2 L83.7 -27.3 L86.1 -24.9 L88.3 -21.0 L90.5 -19.6 L92.1 -15.0 L97.5 -6.8 L98.9 -2.2 L99.6 7.7 L100.1 8.5 L98.8 11.2 L96.6 11.7 L94.8 13.3 L93.8 15.5 L92.9 16.2 L92.4 17.9 L89.5 21.5 L88.5 23.7 L85.9 27.1 L83.2 31.6 L81.0 33.6 L80.6 34.8 L77.7 38.2 L77.7 40.6 L75.6 42.4 L73.7 43.1 L67.1 50.1 L64.7 51.1 L63.3 52.5 L62.3 52.5 L61.6 53.7 L59.4 55.0 L57.0 57.6 L55.6 58.3 L52.2 61.2 L51.4 61.2 L48.6 64.4 L45.9 66.1 L44.7 66.1 L42.0 68.2 L38.0 72.5 L37.1 77.8 L35.3 79.6 L31.2 80.3 L29.5 81.3 L28.0 83.0 L25.8 83.5 L22.5 85.4 L19.3 86.4 L15.9 88.0 L9.9 88.5 L9.2 89.0 L7.5 89.0 L5.6 90.2 L-0.5 90.7 L-3.1 91.4 Z" fill="#6f6b66" stroke="rgba(248,250,252,.18)" stroke-width=".8" stroke-linejoin="round"/></svg>';
  $('intro').appendChild(ry);
  const bump = (px: number) => { ry.style.setProperty('--grow', String(Math.min(1, 0.06 + px / 34))); };
  bump(4);
  const [reg, rot, sunT, hmap, g763, g340, scT, tl, poi, ev, locmap, samples, mis, mis_c, gal, l2c, geo, mascam, mara, mag, mpos, sp] = await Promise.all([
    loadRegistry(), getJSON('data/rotation.json'), getJSON('data/sun_table.json'), HeightMap.load(), loadGravity('763'), loadGravity('340'), loadSc(), getJSON('data/timeline.json'),
    getJSON('data/poi_master.json'), getJSON('data/event_asset_links.json'), getJSON('data/image_location_map.json'), getJSON('data/samples_metadata.json'),
    getJSON('data/edu/mission_scenarios.json'), getJSON('data/edu/misconceptions.json'),
    getJSON('data/gallery_manifest.json'), getJSON('data/l2c_manifest.json'), getJSON('data/image_geometry.json'), getJSON('data/mascam_manifest.json'),
    getJSON('data/mara.json'), getJSON('data/mag.json'), getJSON('data/mascot_position.json'), getJSON('data/ryugu_surface_points.json')]);
  bump(10);
  setRegistry(reg); rotation = rot; sun = new Sun(sunT, rot); hm = hmap; G763 = g763; G340 = g340; G = G763; sc = scT; timeline = tl;
  clock.tMax = MISSION_T1; clock.set(TD1_MS - 10 * 60e3);   // P1-1: 滞在期間に限定し、最後に訪れた時刻（なければ到着日）から再開
  const evMap = new Map<string, any>(); for (const e of locmap.event_level_map) evMap.set(e.gallery_folder, e);
  const gl = gal.images.map((g: any) => { const e = evMap.get(g.folder); return { id: g.id, folder: g.folder, lat: e?.target_latitude_deg ?? null, lon: e?.target_longitude_deg ?? null, date: e?.date_utc ?? '', event: e?.event ?? '' }; });
  const geoMap = new Map<string, any>(geo.images.map((x: any) => [x.file, x])); const l2cs = l2c.images.map((x: any) => { const g = geoMap.get(x.id); return { ...x, lat: g?.center_lat, lon: g?.center_lon }; });
  const iauPois = (sp.iau_named_features ?? []).filter((f: any) => !poi.poi.some((p: any) => (p.name_en ?? '').toLowerCase().includes(f.name.toLowerCase()) || (p.name_ja ?? '').includes(f.name))).map((f: any) => ({
    id: 'iau_' + f.name.toLowerCase().replace(/[^a-z]/g, ''), type: 'iau_feature', name_ja: f.name, name_en: f.name,
    lat: f.latitude_deg, lon: f.longitude_deg, latitude_deg: f.latitude_deg, longitude_deg: f.longitude_deg,
    description: `${f.type === 'Crater' ? 'クレーター' : f.type === 'Dorsum' ? '尾根(ドルスム)' : f.type === 'Fossa' ? '溝(フォッサ)' : f.type === 'Saxum' ? '岩塊(サクスム)' : f.type}　直径/長さ ${f.diameter_km}km　(IAU承認 ${f.approved})`,
    accuracy: `IAU公認の地形名（USGS Gazetteer）。座標は度単位の概略位置。`, nickname: '',
    sources: [{ label: 'USGS Astrogeology: Ryugu Nomenclature', url: 'https://planetarynames.wr.usgs.gov/SearchResults?Target=Ryugu' }] }));
  world = { pois: [...poi.poi.map((p: any) => ({ ...p, lat: p.latitude_deg, lon: p.longitude_deg })), ...iauPois], events: ev.events, gallery: gl, l2c: l2cs, samples };
  (world as any).missions = mis.scenarios; (world as any).misc = mis_c.misconceptions;
  terrain = new Terrain(renderer); await terrain.init(hm); scene.add(terrain.group);
  rocks = new Rocks(hm, terrain.shade); scene.add(rocks.group);
  mascot = new MascotReplay({ pos: mpos, imgs: mascam.images, mara, mag } as MascotData);
  library.init().then(() => library.attach(l2cs, mascam.images, samples, sp)).catch(e => console.warn('library', e));
  buildExtras(); buildDust(); bump(30);
  const loader = new GLTFLoader(); try { const gl2 = await loader.loadAsync(url('assets/hayabusa2_spacecraft.glb')); scMesh = gl2.scene; scMesh.visible = false; scene.add(scMesh); } catch (e) { console.warn('glb', e); }
  // P1-2: イベント（時刻は現地太陽時12時、TD1は公表接地時刻）
  events = buildEvents(ev, locmap, world.pois, sun, TD1_MS, MISSION_T0, MISSION_T1);
  eventUi = new EventUi(card, viewer, events, gl, {
    goTo: goToEvent,
    openGallery: (folders, e2) => eventUi.openGalleryFolders(folders, e2),
    enterTd1: () => enterTd1(), enterMascot: () => enterMascot(),
  });
  slider = new TimeSlider();
  slider.onSet = ms => { clock.set(ms); clock.running = true; used.add('time'); activity(); };
  slider.onMarkerClick = id => { eventUi.detail(id); };
  slider.setMarkers(events.filter(e => e.inRange).map(e => ({ id: e.id, ms: e.ms, label: e.title })));
  // イベントに紐付かない観測運用フォルダ（データを使い切る: P1-6）
  const evFolders = new Set(events.flatMap(e => e.gallery));
  const otherMap: Record<string, string> = ev.other_gallery_mappings ?? {};
  const allFolders: string[] = [...new Set(gl.map((g: any) => String(g.folder)))] as string[];
  eventUi.extras = allFolders.filter((f: string) => !evFolders.has(f)).sort().map((f: string) => {
    const m = evMap.get(f);
    return { folder: f, date: m?.date_utc ?? `${f.slice(3, 7)}-${f.slice(7, 9)}-${f.slice(9, 11)}`, label: m?.event ?? otherMap[f] ?? (lang === 'ja' ? '観測運用' : 'observation ops') };
  });
  // P2-2: 3Dミニマップ
  minimap = new MiniMap(renderer, card, hm, world.pois, {
    teleport: (lat, lon) => teleport(lat, lon),
    openEventFor: (poiId) => { const e = events.find(x => x.poiIds.includes(poiId)); if (e) eventUi.detail(e.id); else { const p = world.pois.find(x => x.id === poiId); if (p) openPoi(p as Poi); } },
    openPoi: (poiId) => { const p = world.pois.find(x => x.id === poiId); if (p) openPoi(p as Poi); },
  }, { lat: () => bodyToGeo(P.dir).lat, lon: () => bodyToGeo(P.dir).lon, fwd: () => P.fwd, sunDir: () => sunNow().dir, tex: () => (terrain.mat?.uniforms?.map?.value as THREE.Texture) ?? undefined, bg: () => bgColor });
  // 地名・イベント注釈: features.json（点群で位置を検証済み）。無くてもサイトは動く。
  try {
    const ff = await getJSON<FeatureFile>('data/features.json');
    annot = new Annotator(ff.features.map(prepare), { radiusAt: d => { const g = bodyToGeo(d); return hm.radius(g.lat, g.lon); }, open: id => openFeature(id) });
    try { annotOn = localStorage.getItem('ryugu_annot') !== '0'; } catch { /* ignore */ }
    $('b-map').classList.toggle('active', annotOn); $('b-map').setAttribute('aria-pressed', String(annotOn));
  } catch (e) { console.warn('features', e); }
  ready = true; $('intro').querySelectorAll('.line').forEach(() => 0);
}

function buildExtras() {
  // star field: varied size / brightness / colour temperature, round soft points (was: uniform 1.6 px white dots)
  const sg = new THREE.BufferGeometry(); const N = 2600; const a = new Float32Array(N * 3), sz = new Float32Array(N), br = new Float32Array(N), cl = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const u = hash2(i, 1, 99) * 2 - 1, p = hash2(i, 2, 99) * Math.PI * 2, s = Math.sqrt(1 - u * u);
    a[i * 3] = s * Math.cos(p) * 4000; a[i * 3 + 1] = u * 4000; a[i * 3 + 2] = s * Math.sin(p) * 4000;
    const m = Math.pow(hash2(i, 3, 99), 3.2);                 // few bright, many faint
    sz[i] = 0.8 + m * 2.6; br[i] = 0.18 + 0.82 * m;
    const tp = hash2(i, 4, 99), w = hash2(i, 5, 99) * 0.55;   // slight colour-temperature spread
    if (tp < 0.5) { cl[i * 3] = 1 - 0.18 * w; cl[i * 3 + 1] = 1 - 0.05 * w; cl[i * 3 + 2] = 1; }
    else { cl[i * 3] = 1; cl[i * 3 + 1] = 1 - 0.10 * w; cl[i * 3 + 2] = 1 - 0.22 * w; }
  }
  sg.setAttribute('position', new THREE.BufferAttribute(a, 3)); sg.setAttribute('size', new THREE.BufferAttribute(sz, 1)); sg.setAttribute('bri', new THREE.BufferAttribute(br, 1)); sg.setAttribute('tint', new THREE.BufferAttribute(cl, 3));
  starPts = new THREE.Points(sg, new THREE.ShaderMaterial({
    uniforms: { uPr: { value: Math.min(devicePixelRatio, 2) }, uFade: { value: 0 } },
    vertexShader: `attribute float size; attribute float bri; attribute vec3 tint; uniform float uPr; varying float vB; varying vec3 vT;
      void main(){ vB=bri; vT=tint; gl_PointSize=size*uPr; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `precision highp float; varying float vB; varying vec3 vT; uniform float uFade;
      void main(){ float d=length(gl_PointCoord-0.5); float al=smoothstep(0.5,0.12,d)*vB*uFade; gl_FragColor=vec4(vT*al,al); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false
  })); scene.add(starPts);
  sunDot = new THREE.Mesh(new THREE.SphereGeometry(14, 12, 8), new THREE.MeshBasicMaterial({ color: 0xFFF6E8 })); scene.add(sunDot);
  // sun glare (additive sprite) — visible whenever the sky is black and the sun is above the local horizon
  const gc = document.createElement('canvas'); gc.width = gc.height = 256; const g2 = gc.getContext('2d')!;
  const grd = g2.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, 'rgba(255,250,240,1)'); grd.addColorStop(0.12, 'rgba(255,246,228,0.55)'); grd.addColorStop(0.35, 'rgba(255,240,210,0.16)'); grd.addColorStop(1, 'rgba(255,240,210,0)');
  g2.fillStyle = grd; g2.fillRect(0, 0, 256, 256);
  sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(gc), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })); sunGlow.scale.set(900, 900, 1); scene.add(sunGlow);
  // P2-1: 地球の点（黒い空で実際の方向に。輝度は演出E）
  earthDot = new THREE.Mesh(new THREE.SphereGeometry(5, 10, 8), new THREE.MeshBasicMaterial({ color: 0xBFD8F0 })); earthDot.visible = false; scene.add(earthDot);
  earthHalo = new THREE.Mesh(new THREE.SphereGeometry(13, 10, 8), new THREE.MeshBasicMaterial({ color: 0x9FC7E8, transparent: true, opacity: 0.28 })); earthHalo.visible = false; scene.add(earthHalo);
  shadow = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24), new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false })); scene.add(shadow);
  scDot = new THREE.Mesh(new THREE.SphereGeometry(1.2, 6, 4), new THREE.MeshBasicMaterial({ color: 0xE8A33D })); scDot.visible = false; scene.add(scDot);
  sunLight = new THREE.DirectionalLight(0xffffff, 3.2); scene.add(sunLight);   // spacecraft only (terrain/rocks use their own N.L shader; no ambient anywhere)
  const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(90 * 3), 3));
  burst = new THREE.Points(bg, new THREE.PointsMaterial({ color: 0x9a948c, size: 3, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false })); burst.frustumCulled = false; burst.visible = false; scene.add(burst);
  markers = new THREE.Group(); scene.add(markers);
  const mat = new THREE.MeshBasicMaterial({ color: 0xE8A33D, transparent: true, opacity: 0.85 });
  for (const p of world.pois) if (p.lat != null && p.lon != null) { const base = hm.radius(p.lat, p.lon); const d = geoToBody(p.lat, p.lon, 1);
    const line = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 6, 6), mat); const pos = tr(v3.mul(d, base + 3)); line.position.copy(pos); line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tr(d).normalize()); line.userData.poi = p.id; markers.add(line); }
  mascotMarker = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), mat); mascotMarker.visible = false; scene.add(mascotMarker);
  const r = hm.radius(SITE.lat, SITE.lon); mascotMarker.position.copy(tr(geoToBody(SITE.lat, SITE.lon, r + 0.15)));
  // SCI人工クレーターの印（演出E）: 地形モデルにクレーターは無いので、衝突(2019-04-05)以降は
  // その位置に琥珀の円（直径14.5m相当）を表示して「この地下に人工クレーター」を伝える。
  const sciP = world.pois.find((p: any) => p.id === 'sci_crater');
  if (sciP?.lat != null && sciP.lon != null) {
    craterDir = geoToBody(sciP.lat, sciP.lon, 1);
    craterMark = new THREE.Group();
    craterMark.add(new THREE.Mesh(new THREE.RingGeometry(6.4, 7.4, 64), new THREE.MeshBasicMaterial({ color: 0xE8A33D, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false })));
    craterMark.add(new THREE.Mesh(new THREE.CircleGeometry(6.6, 64), new THREE.MeshBasicMaterial({ color: 0x14110d, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })));
    craterMark.position.copy(tr(v3.mul(craterDir, hm.radius(sciP.lat, sciP.lon) + 0.06)));
    craterMark.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tr(craterDir).normalize());
    craterMark.renderOrder = 1;
    scene.add(craterMark);
  }
  // mission markers (§4.10): the markers ARE the mission. First one appears at the player's feet once the callsign is assigned.
  const missions: any[] = (world as any).missions || []; if (missions[0]) for (const id of missions[0].route_pois) { const p = world.pois.find(x => x.id === id); if (p && p.lat != null) {
    const m2 = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), mat); m2.position.copy(tr(geoToBody(p.lat, p.lon!, hm.radius(p.lat, p.lon!) + 0.4))); markers.add(m2); } }
  buildJet();
}

// ---------------- sim step
function sunNow() { const et = utcToEt(clock.ms); return { et, ...sun.sunBody(et) }; }
function eyeUp(dir: V3) { const g = bodyToGeo(dir); return upAt(dir, g.lat, g.lon); }
function moveOnSurface(dist: number, side: number): V3 {
  const up = v3.norm(P.dir); const fwd = v3.norm(v3.sub(P.fwd, v3.mul(up, v3.dot(P.fwd, up)))); const right = v3.cross(fwd, up);
  const mv = v3.add(v3.mul(fwd, dist), v3.mul(right, side)); const nd = v3.norm(v3.add(P.dir, v3.mul(mv, 1 / Math.max(300, ground0()))));
  return nd;
}
const ground0 = () => R_MEAN;
function slopeFactor(deg: number) { return deg <= 25 ? 1 : deg >= MAX_DRIVE_SLOPE ? 0 : 1 - 0.8 * (deg - 25) / (MAX_DRIVE_SLOPE - 25); }

/** 乗り物の挙動（見た目用）: 操舵・アクセル・車体の傾き/ピッチ/揺れ/視野角のなめらかな状態 */
const drv = { throttle: 0, steer: 0, roll: 0, pitch: 0, accel: 0, fov: 70, lastSpeed: 0, rough: 0, lastStand: 0 };
let dashing = false; let driveSpeed = 0; let flightTarget = 0;
let farHinted = false;
/** P1-3: 発射速度を局所脱出速度の75%にクランプ（どこから跳んでも脱出軌道に入らない） */
function launchClamp(velB: V3): V3 {
  // 慣性系で判定: |v_body + ω×r| <= 0.75·v_esc(点質量)。地表系だけで切ると自転の接線速度(~0.1 m/s)で赤道東向きが脱出域に入る。
  const posB = v3.mul(P.dir, groundAt(P.dir) + 0.02); const gm = G.meta.gm_effective_m3s2; const om = 2 * Math.PI / (G.meta.period_h * 3600);
  const cap = 0.75 * Math.sqrt(2 * gm / v3.len(posB)); const u = v3.cross([0, 0, om] as V3, posB);
  if (v3.len(v3.add(velB, u)) <= cap) return velB;
  const a = v3.dot(velB, velB), b = 2 * v3.dot(velB, u), c = v3.dot(u, u) - cap * cap; if (a < 1e-12) return velB;
  const disc = b * b - 4 * a * c; if (c > 0 || disc < 0) return [0, 0, 0];
  const k = Math.max(0, Math.min(1, (-b + Math.sqrt(disc)) / (2 * a))); return v3.mul(velB, k);
}
let flightStartMs = 0; let flightStartDir: V3 = [0, 0, 1];
function startPhysics(velB: V3, why: string) {
  const g0 = groundAt(P.dir); const posB = v3.mul(P.dir, g0 + 0.02); const et = utcToEt(clock.ms);
  flightStartMs = clock.ms; flightStartDir = v3.norm(P.dir);
  orbit = launch(posB, velB, et, G.meta.gm_effective_m3s2, 2 * Math.PI / (G.meta.period_h * 3600)); layer = 'ballistic'; used.add('phys'); driveSpeed = 0; farHinted = false;
  hud.announce(why);
  hint.show(isTouch ? '飛行中 — 左スティック:進む / 右ドラッグ:向き / ▲▼:上昇・降下 / 右上スイッチ:地表へ' : '飛行中 — 右上のスイッチで地表へ / WASD: 進む / 矢印: 向き', false, 7000);
}
/** return to the surface from ballistic flight / orbit (presentation shortcut; the sub-player point) */
function returnToSurface() {
  if (layer === 'space') {
    const d = sp ? v3.norm(sp.dir) : v3.norm(P.dir);
    P.dir = d; P.stand = groundAt(d); sp = null; camXf = null; orbit = null; layer = 'walk'; P.dip = 0.2; compress = 1;
    hint.show('地表に戻りました（演出）', false, 3000); return;
  }
  if (layer !== 'ballistic' && layer !== 'orbit') return;
  const d = v3.norm(orbit ? bodyOf(orbit) : P.dir);
  P.dir = d; P.stand = groundAt(d); orbit = null; layer = 'walk'; P.dip = 0.2;
  hint.show('地表に戻りました（演出）', false, 3000);
}
function stepWalk(dt: number) {
  const g = bodyToGeo(P.dir); const gs = sampleGravity(G, g.lat, g.lon);
  let throttle = 0, steer = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) throttle += 1; if (keys.has('KeyS') || keys.has('ArrowDown')) throttle -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) steer += 1; if (keys.has('KeyA') || keys.has('ArrowLeft')) steer -= 1;
  if (joy.active) { throttle += -joy.y; steer += joy.x; }
  throttle = Math.max(-1, Math.min(1, throttle)); steer = Math.max(-1, Math.min(1, steer));
  drv.throttle = throttle; drv.steer = steer;
  dashing = (keys.has('ShiftLeft') || keys.has('ShiftRight')) && throttle > 0 && !keys.has('Space');
  if (joy.active && -joy.y > 0.85) dashing = true;
  const targetSpeed = throttle * (dashing ? DRIVE_BOOST : DRIVE_SPEED) * slopeFactor(gs.slope);
  const speedDelta = targetSpeed - driveSpeed, speedStep = (Math.abs(targetSpeed) < Math.abs(driveSpeed) || Math.sign(targetSpeed) !== Math.sign(driveSpeed) ? DRIVE_BRAKE : DRIVE_ACCEL) * dt;
  driveSpeed += Math.sign(speedDelta) * Math.min(Math.abs(speedDelta), speedStep);
  if (Math.abs(driveSpeed) < 0.03) driveSpeed = 0;
  if (Math.abs(driveSpeed) > 0.03 && steer !== 0) {
    const up = v3.norm(P.dir), speedTurn = 0.25 + 0.75 * Math.min(1, Math.abs(driveSpeed) / DRIVE_SPEED);
    const yaw = -steer * Math.sign(driveSpeed) * TURN_RATE * speedTurn * dt, c = Math.cos(yaw), s = Math.sin(yaw);
    P.fwd = v3.norm(v3.add(v3.mul(P.fwd, c), v3.mul(v3.cross(up, P.fwd), s)));
  }
  if (Math.abs(driveSpeed) > 0.03) {
    used.add('walk'); const distance = driveSpeed * dt, steps = Math.max(1, Math.ceil(Math.abs(distance) / DRIVE_SUBSTEP)), ds = distance / steps;
    for (let i = 0; i < steps; i++) {
      const nd = moveOnSurface(ds, 0), ng = groundAt(nd), rise = ng - P.stand, ngp = bodyToGeo(nd), ns = sampleGravity(G, ngp.lat, ngp.lon);
      if (rise > MAX_DRIVE_STEP || ns.slope >= MAX_DRIVE_SLOPE) { driveSpeed = 0; break; }
      if (rise < -1.0) {
        if (dashing) { P.dir = nd; P.stand = ng; startPhysics(launchClamp(v3.mul(v3.norm(v3.sub(P.fwd, v3.mul(P.dir, v3.dot(P.fwd, P.dir)))), driveSpeed)), 'cliff'); return; }
        driveSpeed = 0; break;
      }
      P.dir = nd; P.stand = ng; P.fwd = v3.norm(v3.sub(P.fwd, v3.mul(P.dir, v3.dot(P.fwd, P.dir))));
      if (Math.floor(performance.now() / 500) !== stepTick) { stepTick = Math.floor(performance.now() / 500); if (Math.abs(driveSpeed) < 3) sound.step(140 + Math.min(400, ns.slope * 22)); }
    }
  }
  // 足元の高さを地面に合わせる（段差を降りるときは素早く追従）
  { const tg = groundAt(P.dir); if (P.stand > tg) P.stand = Math.max(tg, P.stand - Math.max(2, (P.stand - tg) * 8) * dt); else P.stand = tg; }
  P.dip = Math.max(0, P.dip - dt * 1.2);
}
let stepTick = 0;
const inFlight = () => layer === 'ballistic' || layer === 'orbit' || layer === 'space';
/** 宇宙モード開始: 局所地表の上空200mまで上昇し、リュウグウの方を向いて静止する */
function startSpace() {
  if (layer !== 'walk') return;
  const dir = v3.norm(P.dir); const fwd = v3.norm(v3.sub(P.fwd, v3.mul(dir, v3.dot(P.fwd, dir))));
  sp = new SpaceFlight(dir, fwd, P.stand + EYE - P.dip, groundAt);
  camXf = { q0: camera.quaternion.clone(), t: 0, dur: ASCEND_S };   // 歩行視点から滑らかに向き直る
  orbit = null; layer = 'space'; driveSpeed = 0; used.add('phys'); spFxT = 0;
  hud.announce('宇宙モード');
  hint.show(isTouch ? '宇宙モード — 左スティック:周回 / 右ドラッグ:見回す / ▲▼:上昇・降下 / 右上スイッチ:地表へ' : '宇宙モード — 上空200mまで上昇します。Space:遠ざかる / C:近づく・着地 / WASD・矢印:球面を周回 / ドラッグ:見回す / 右上のスイッチ:最寄りの地表へ', false, 9000);
}
function stepSpace(dt: number) {
  if (!sp) { layer = 'walk'; return; }
  let x = 0, y = 0;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1; if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) y += 1; if (keys.has('KeyS') || keys.has('ArrowDown')) y -= 1;
  if (joy.active) { x += joy.x; y += -joy.y; }
  const hit = sp.step(dt, { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)), out: keys.has('Space') || pad.up, inward: keys.has('KeyC') || pad.down }, groundAt, G.meta.gm_effective_m3s2, EYE);
  P.dir = sp.dir;
  if (sp.fx) { spFxT -= dt; if (spFxT <= 0) { spFxT = 0.12; jetFX(sp.fx); if (sound.on) sound.thrust(); } }
  if (hit) landFromSpace();
}
/** 着地（Cキー・重力による自動着地・スイッチ帰還のどれでも）: 地上モードに戻す。右上のボタンは layer に追従して自動で地上表示に変わる */
function landFromSpace() {
  if (!sp) return; const d = v3.norm(sp.dir); const u = sp.up; const v = sp.touch;
  camXf = { q0: camera.quaternion.clone(), t: 0, dur: 1.2 };
  P.dir = d; P.stand = groundAt(d); P.fwd = v3.norm(v3.sub(u, v3.mul(d, v3.dot(u, d)))); P.pitch = 0; P.dip = 0.2; driveSpeed = 0;
  layer = 'walk'; orbit = null; sp = null; compress = 1;
  kickDust(v3.mul(d, P.stand), d, Math.max(0.08, Math.min(1.2, v * 0.3)));
  hint.show('着地しました — 地上モードに戻ります', false, 4000);
}

/** P3-1: 宇宙空間の自由飛行 — 矢印キーでヨー・ピッチ（WASDは微推力のまま） */
function steerFlight(dt: number) {
  const up = v3.norm(P.dir);
  const yaw = (keys.has('ArrowLeft') ? 1 : 0) - (keys.has('ArrowRight') ? 1 : 0);
  if (yaw) { const a = -yaw * 0.9 * dt; const f = v3.norm(v3.sub(P.fwd, v3.mul(up, v3.dot(P.fwd, up)))); const r = v3.cross(up, f); P.fwd = v3.norm(v3.add(v3.mul(f, Math.cos(a)), v3.mul(r, Math.sin(a)))); }
  if (keys.has('ArrowUp')) P.pitch = Math.min(1.4, P.pitch + 0.7 * dt);
  if (keys.has('ArrowDown')) P.pitch = Math.max(-1.4, P.pitch - 0.7 * dt);
}

function stepFlight(et: number, dt: number, dtReal = dt) {
  if (!orbit) return; const surf = (b: V3) => groundAt(b);
  { // thrust (E): WASD=前後左右 / Space=上 / C=下。視線方向へ。Δv は実時間 1 秒あたり 0.05 m/s（圧縮に依存しない）
    const th = 0.05; let tx = 0, ty = 0, tz = 0; if (keys.has('KeyW')) ty += 1; if (keys.has('KeyS')) ty -= 1; if (keys.has('KeyD')) tx += 1; if (keys.has('KeyA')) tx -= 1; if (keys.has('Space') || pad.up) tz += 1; if (keys.has('KeyC') || pad.down) tz -= 1;
    if (joy.active) { tx += joy.x; ty += -joy.y; } tx = Math.max(-1, Math.min(1, tx)); ty = Math.max(-1, Math.min(1, ty));
    if (tx || ty || tz) { const b = bodyOf(orbit); const up = v3.norm(b); const fw = v3.norm(v3.sub(P.fwd, v3.mul(up, v3.dot(P.fwd, up)))); const rt = v3.cross(fw, up);
      const fp = v3.add(v3.mul(fw, Math.cos(P.pitch)), v3.mul(up, Math.sin(P.pitch))); const vu = v3.cross(rt, fp);
      const ab = v3.add(v3.add(v3.mul(fp, ty * th), v3.mul(rt, tx * th)), v3.mul(vu, tz * th)); const a = -orbit.omega * (orbit.t - orbit.t0), c = Math.cos(-a), sn = Math.sin(-a); const ai: V3 = [c * ab[0] - sn * ab[1], sn * ab[0] + c * ab[1], ab[2]]; orbit.v = v3.add(orbit.v, v3.mul(ai, dtReal));
      jetFX(ai); if (sound.on) sound.thrust(); }
  }
  steerFlight(dt);
  // 時計が T1 で止まっていても実時間では進める（P1-1 の端処理）
  const etT = Math.max(et, orbit.t + dt);
  const hit = advance(orbit, etT, surf); const b = bodyOf(orbit); P.dir = v3.norm(b);
  layer = isEscape(orbit) ? 'orbit' : 'ballistic';
  if (!farHinted && v3.len(b) - groundAt(v3.norm(b)) > 1500) { farHinted = true; hint.show('高度が上がっています — 右上のスイッチで地表に戻れます', false, 6000); }
  if (hit && orbit.landed) {
    const vB = velBodyOf(orbit); const spd = v3.len(vB);
    P.stand = groundAt(P.dir); orbit = null; layer = 'walk'; P.dip = 0.2;
    kickDust(v3.mul(P.dir, P.stand), v3.norm(P.dir), Math.max(0.08, Math.min(1.2, spd)));
    landingReport();
  }
}

/** 着地報告（演出）: 低重力ジャンプの「時間の暴力」を物語に変える。
 *  跳んでいる間にリュウグウが自転し、着地点が移動したことを1行で伝える。 */
function landingReport() {
  const durS = (clock.ms - flightStartMs) / 1000;
  if (durS < 90) return;   // 短いホップでは出さない
  const om = 2 * Math.PI / (G.meta.period_h * 3600);
  const rotDeg = om * durS / DEG;
  const g0 = bodyToGeo(flightStartDir), g1 = bodyToGeo(P.dir);
  const dist = surfDist(g0.lat, g0.lon, g1.lat, g1.lon);
  const h = Math.floor(durS / 3600), m = Math.round((durS % 3600) / 60);
  hint.show(`着地 — 飛行時間 ${h ? h + '時間' : ''}${m}分。その間にリュウグウは約${rotDeg.toFixed(0)}°自転し、あなたは${dist.toFixed(0)}m先に降り立ちました（時間圧縮は演出E）`, false, 9000);
}
// ---------------- thruster jet (E, 演出): 噴射と逆向きに短命な粒子
let jet!: THREE.Points; let jetT = -1; const JET_N = 40; let jetP: Float32Array; let jetV: Float32Array;
function buildJet() {
  const g = new THREE.BufferGeometry(); jetP = new Float32Array(JET_N * 3); jetV = new Float32Array(JET_N * 3);
  g.setAttribute('position', new THREE.BufferAttribute(jetP, 3));
  jet = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xF0F0EB, size: 2.5, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false }));
  jet.frustumCulled = false; jet.visible = false; scene.add(jet);
}
function jetFX(accBody: V3) {
  if (!jet) return;
  const eye = camera.position; const ad = tr(v3.norm(v3.mul(accBody, -1)));   // 噴射は加速と逆方向
  for (let i = 0; i < JET_N; i++) {
    jetP[i * 3] = eye.x + (hash2(i, 1, 55) - 0.5) * 0.6; jetP[i * 3 + 1] = eye.y + (hash2(i, 2, 55) - 0.5) * 0.6; jetP[i * 3 + 2] = eye.z + (hash2(i, 3, 55) - 0.5) * 0.6;
    const sp = 0.6 + hash2(i, 4, 55) * 1.2;
    jetV[i * 3] = ad.x * sp; jetV[i * 3 + 1] = ad.y * sp; jetV[i * 3 + 2] = ad.z * sp;
  }
  jetT = 0; jet.visible = true;
}
function stepJet(dt: number) {
  if (jetT < 0 || !jet) return; jetT += dt;
  for (let i = 0; i < JET_N * 3; i++) jetP[i] += jetV[i] * dt;
  (jet.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  (jet.material as THREE.PointsMaterial).opacity = Math.max(0, 0.7 * (1 - jetT / 0.9));
  if (jetT > 0.9) { jetT = -1; jet.visible = false; }
}

// ---------------- landing dust (E, 演出): low-gravity ballistic puffs — on Ryugu, kicked regolith flies for metres
const DUST_N = 90; const DUST_G = 0.00013;   // ~ local surface gravity (mm/s² class)
let dust!: THREE.Points; let dustT = -1; let dustP: Float32Array; let dustV: Float32Array; let dustUp: V3 = [0, 0, 1];
function buildDust() {
  const g = new THREE.BufferGeometry(); dustP = new Float32Array(DUST_N * 3); dustV = new Float32Array(DUST_N * 3);
  g.setAttribute('position', new THREE.BufferAttribute(dustP, 3));
  dust = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8d857c, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false }));
  dust.frustumCulled = false; dust.visible = false; scene.add(dust);
}
function kickDust(pBody: V3, up: V3, speed: number) {
  if (!dust) return; dustUp = v3.norm(up);
  const e1 = v3.norm(v3.cross(dustUp, [0, 0, 1])), e2 = v3.cross(dustUp, e1);
  const pT = bodyToThree(pBody); const uT = bodyToThree(dustUp); const t1 = bodyToThree(e1), t2 = bodyToThree(e2);
  for (let i = 0; i < DUST_N; i++) {
    const az = hash2(i, 1, 77) * Math.PI * 2, sp = (0.15 + hash2(i, 2, 77) * 0.85) * speed, vu = (0.05 + hash2(i, 3, 77) * 0.6) * speed;
    dustP[i * 3] = pT[0]; dustP[i * 3 + 1] = pT[1]; dustP[i * 3 + 2] = pT[2];
    dustV[i * 3] = t1[0] * Math.cos(az) * sp + t2[0] * Math.sin(az) * sp + uT[0] * vu;
    dustV[i * 3 + 1] = t1[1] * Math.cos(az) * sp + t2[1] * Math.sin(az) * sp + uT[1] * vu;
    dustV[i * 3 + 2] = t1[2] * Math.cos(az) * sp + t2[2] * Math.sin(az) * sp + uT[2] * vu;
  }
  dustT = 0; dust.visible = true;
}
function stepDust(dt: number) {
  if (dustT < 0 || !dust) return; dustT += dt;
  const u = bodyToThree(dustUp);
  for (let i = 0; i < DUST_N; i++) {
    dustV[i * 3] -= u[0] * DUST_G * dt; dustV[i * 3 + 1] -= u[1] * DUST_G * dt; dustV[i * 3 + 2] -= u[2] * DUST_G * dt;
    dustP[i * 3] += dustV[i * 3] * dt; dustP[i * 3 + 1] += dustV[i * 3 + 1] * dt; dustP[i * 3 + 2] += dustV[i * 3 + 2] * dt;
  }
  (dust.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  (dust.material as THREE.PointsMaterial).opacity = Math.max(0, 0.5 * (1 - dustT / 7));
  if (dustT > 7) { dustT = -1; dust.visible = false; }
}

// ---------------- 乗り物の乗り心地（カメラのバンク・ピッチ・揺れ・視野角。walk 層のみ）
let thermTab: ThermalTable | null = null; let groundK: number | null = null;
const nearestDec = (tj: any, sl: number): number => tj.subsolar_lat_deg.reduce((b: number, v: number) => Math.abs(v - sl) < Math.abs(b - sl) ? v : b, tj.subsolar_lat_deg[0]);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const cockpit = (() => {
  const d = document.createElement('div'); d.id = 'cockpit'; d.setAttribute('aria-hidden', 'true');
  d.innerHTML = '<div class="dash"><div class="gauge"><b id="ck-v">0.0</b><small>m/s</small></div><div class="bars"><div class="bar st"><i id="ck-st"></i></div><div class="bar th"><i id="ck-th"></i></div></div><div class="place" id="ck-pl"><small>いまいる場所</small><b id="ck-pn">—</b><small id="ck-tk"></small></div></div>';
  document.body.appendChild(d); return d;
})();
const ckTk = document.getElementById('ck-tk')!;
const ckPl = document.getElementById('ck-pl')!, ckPn = document.getElementById('ck-pn')!;
const ckV = document.getElementById('ck-v')!, ckSt = document.getElementById('ck-st')!, ckTh = document.getElementById('ck-th')!;
function vehicleCamera(dt: number) {
  const on = layer === 'walk'; cockpit.classList.toggle('on', on);
  const k = (rate: number) => 1 - Math.exp(-rate * dt);
  if (!on) { if (Math.abs(camera.fov - 70) > 0.01) { camera.fov = 70; camera.updateProjectionMatrix(); } drv.roll = drv.pitch = drv.accel = 0; drv.lastSpeed = driveSpeed; return; }
  const sf = Math.min(1.4, Math.abs(driveSpeed) / DRIVE_SPEED);
  const acc = dt > 0 ? (driveSpeed - drv.lastSpeed) / dt : 0; drv.lastSpeed = driveSpeed;
  drv.accel += (acc - drv.accel) * k(6);
  const mv = reduceMotion ? 0.25 : 1;
  const tRoll = -drv.steer * Math.min(1, sf) * 0.075 * mv * Math.sign(driveSpeed || 1);   // カーブの内側へ傾く
  const tPitch = -Math.max(-1, Math.min(1, drv.accel / DRIVE_ACCEL)) * 0.035 * mv;        // 加速でノーズ上げ、制動でノーズ下げ
  drv.roll += (tRoll - drv.roll) * k(5); drv.pitch += (tPitch - drv.pitch) * k(5);
  // 路面の凹凸: 足元の高さの変化で細かく揺れる
  const dh = P.stand - drv.lastStand; drv.lastStand = P.stand; drv.rough += (Math.min(1, Math.abs(dh) * 4) - drv.rough) * k(8);
  const t = performance.now() / 1000;
  const shake = sf * (0.0025 + 0.006 * drv.rough) * mv;
  camera.rotateZ(drv.roll + Math.sin(t * 17) * shake); camera.rotateX(drv.pitch + Math.sin(t * 23 + 1.3) * shake);
  const tFov = 70 + 14 * Math.min(1, Math.abs(driveSpeed) / DRIVE_BOOST) * mv;
  drv.fov += (tFov - drv.fov) * k(4); if (Math.abs(camera.fov - drv.fov) > 0.02) { camera.fov = drv.fov; camera.updateProjectionMatrix(); }
  // ダッシュボード
  ckV.textContent = Math.abs(driveSpeed).toFixed(1); (ckSt as HTMLElement).style.transform = `translateX(${(drv.steer * 50).toFixed(1)}%)`;
  (ckTh as HTMLElement).style.transform = `scaleX(${Math.max(0, Math.min(1, Math.abs(driveSpeed) / DRIVE_BOOST)).toFixed(3)})`;
  { const tx = groundK == null ? '' : `地表 約${Math.round(groundK - 273.15)}°C（モデル*）`; if (ckTk.textContent !== tx) ckTk.textContent = tx; }
  cockpit.classList.toggle('boost', dashing);
}

// ---------------- frame
let prev = performance.now(); let wheelAccum = 0; const bgColor = new THREE.Color(); const cBlack = new THREE.Color(0x000000); const cPaper = new THREE.Color(PAPER);
function frame(now: number) {
  td1Bar.classList.toggle('on', layer === 'td1');
  requestAnimationFrame(frame); const dtRaw = Math.min(5, (now - prev) / 1000); const dt = Math.min(0.1, dtRaw); prev = now; if (!ready) return;
  // P1-4: 弾道飛行中の無操作時間圧縮（演出E）。入力があれば実時間に戻る。
  const flying = layer === 'ballistic' || layer === 'orbit';
  const held = pad.up || pad.down || joy.active || ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].some(k => keys.has(k));
  const idle = flying && !held && performance.now() - lastInput > 2000;
  // 滑らかに ×1 → ×500（約3秒）。操作したら素早く ×1 に戻る（演出E）
  compress = idle ? Math.min(500, Math.max(1, compress) * Math.pow(10, dt)) : Math.max(1, compress * Math.pow(0.004, dt)); if (compress < 1.02) compress = 1;
  if (layer === 'space') compress = sp && sp.captured ? TIME_COMPRESS : 1;   // 自動着地中だけ時間圧縮（演出E）
  const dtSim = dt * compress;
  // time: real time unless in MASCOT replay (flight follows the clock; compression above fast-forwards it)
  // （時計はdtRaw: 低fps環境でも実時間どおりに進む。物理の積分はキャップ済みのdtSim）
  if (layer !== 'mascot') clock.tick(dtRaw * compress);
  if (layer === 'td1') { if (clock.ms > TD1_B) { clock.set(TD1_B); clock.running = false; } else if (clock.ms < TD1_A) clock.set(TD1_A); }
  const S = sunNow();
  if (layer === 'walk') { stepWalk(dt); } else if (layer === 'ballistic' || layer === 'orbit') stepFlight(S.et, dtSim, dt);
  else if (layer === 'space') { stepSpace(dt); }
  else if (layer === 'mascot') { mascotStep(dt); }
  const gp = bodyToGeo(P.dir);
  // MASCOTリプレイ中は高解像度パッチをMASCOTサイトに張る（プレイヤー位置基準だと粗い全球メッシュが剥き出しになる）
  const focus = layer === 'mascot' ? SITE : gp;
  terrain.updatePatch(focus.lat, focus.lon); rocks.update(focus.lat, focus.lon, (d, rb) => terrain.dispAt(d, rb)); rocks.setSun(S.dir);
  // camera
  let eyeB: V3; const upV = layer === 'ballistic' || layer === 'orbit' || layer === 'walk' ? eyeUp(P.dir) : v3.norm(P.dir);
  if (layer === 'ballistic' || layer === 'orbit') { eyeB = orbit ? bodyOf(orbit) : v3.mul(P.dir, groundAt(P.dir) + EYE); }
  else if (layer === 'space' && sp) { eyeB = v3.mul(sp.dir, sp.rad); }
  else if (layer === 'mascot') { eyeB = mascotEye(); }
  else { const h = P.stand + EYE - P.dip; eyeB = v3.mul(P.dir, h); }
  if (layer !== 'space' && (spLook.yaw || spLook.pitch)) spLook.yaw = spLook.pitch = 0;
  if (layer === 'space' && sp) {   // 基準はリュウグウ中心を見る向き。ドラッグはそこからの見回しで、球面上の位置は動かさない
    if (!drag && touchLook < 0 && performance.now() - spLook.t > 2500 && (spLook.yaw || spLook.pitch)) {   // 離して2.5秒後に滑らかに正面へ戻る
      const k = 1 - Math.exp(-dt / 0.35); spLook.yaw = wrapPi(spLook.yaw); spLook.yaw -= spLook.yaw * k; spLook.pitch -= spLook.pitch * k;
      if (Math.abs(spLook.yaw) + Math.abs(spLook.pitch) < 1e-3) spLook.yaw = spLook.pitch = 0;
    }
    camera.position.copy(tr(eyeB!)); camera.up.copy(tr(sp.up)); camera.lookAt(0, 0, 0);
    if (spLook.yaw || spLook.pitch) { camera.rotateY(spLook.yaw); camera.rotateX(spLook.pitch); }
  }
  else lookAt(eyeB!, P.fwd, upV, P.pitch);
  vehicleCamera(dt);
  if (layer === 'mascot') { const q = mascot.posTopo(); if (q && Math.hypot(q[0], q[1], q[2]) > 1.2) { const rS = hm.radius(SITE.lat, SITE.lon); camera.lookAt(tr(v3.mul(geoToBody(SITE.lat, SITE.lon, 1), rS))); } }   // 降下・バウンド中はMASCOTが向かう着陸点を見る
  if (camXf) { camXf.t += dt; const s = Math.min(1, camXf.t / camXf.dur), e = s * s * (3 - 2 * s); const qT = camera.quaternion.clone(); camera.quaternion.copy(camXf.q0).slerp(qT, e); if (s >= 1) camXf = null; }
  const cp = camera.position.clone();
  // 遠方まで見えるように near/far と背景天球を距離に比例させる（はやぶさ2のHP=約20kmを視界に入れる）
  { const rC = v3.len(eyeB!); const fl = layer === 'ballistic' || layer === 'orbit' || layer === 'space'; const far = Math.max(6000, (rC + 600) * 1.6, fl ? 50000 : 0); const near = layer === 'space' ? Math.max(0.05, Math.min(40, (rC - groundAt(P.dir)) * 0.01)) : fl ? Math.min(40, Math.max(0.3, (rC - 520) * 0.004)) : 0.05;
    if (Math.abs(camera.far - far) > 1 || Math.abs(camera.near - near) > 1e-3) { camera.far = far; camera.near = near; camera.updateProjectionMatrix(); } bgK = far / 6000; }
  // sky (single source of truth) — P1-4: 白⇔黒を1.5秒で線形フェード（星・太陽グロー・地球の点も連動）
  const sElev = v3.dot(S.dir, upV); const mascotDay = layer === 'mascot' && !mascot.isNight();
  const sky = skyFor(layer, sElev, mascotDay);
  const target = sky.white ? 1 : 0;
  if (skyWhite < target) skyWhite = Math.min(target, skyWhite + dt / 1.5);
  else if (skyWhite > target) skyWhite = Math.max(target, skyWhite - dt / 1.5);
  applySky({ white: skyWhite > 0.5 });
  scene.background = bgColor.lerpColors(cBlack, cPaper, skyWhite);
  (starPts.material as THREE.ShaderMaterial).uniforms.uFade.value = 1 - skyWhite;
  starPts.visible = skyWhite < 0.995; starPts.position.copy(cp); starPts.scale.setScalar(bgK);
  const dark = skyWhite < 0.5;
  const sunVis = dark && sElev > 0.02; sunDot.visible = sunVis; sunGlow.visible = sunVis;
  (sunGlow.material as THREE.SpriteMaterial).opacity = 1 - skyWhite;
  sunDot.position.copy(cp).addScaledVector(tr(S.dir), 3500 * bgK); sunGlow.position.copy(sunDot.position); sunDot.scale.setScalar(bgK); sunGlow.scale.set(900 * bgK, 900 * bgK, 1);
  // P2-1: 地球の点（黒い空で実際の方向・距離に）
  const eB = sun.earthBody(S.et);
  const eVis = dark && layer !== 'mascot';
  earthDot.visible = eVis; earthHalo.visible = eVis;
  if (eVis) { const ep = cp.clone().addScaledVector(tr(eB.dir), 4000 * bgK); earthDot.position.copy(ep); earthHalo.position.copy(ep); earthDot.scale.setScalar(bgK); earthHalo.scale.setScalar(bgK); }
  terrain.setSun(S.dir, cp);
  // 夜側の色と地表温度: 温度モデル(D)の表を、太陽直下緯度に最も近い格子（-8/0/+8°）で用意する（格子が変わった時だけ作り直す）
  { const tj = library.data?.temp; const sl = Math.asin(Math.max(-1, Math.min(1, S.dir[2]))) / DEG;
    if (tj && (!thermTab || thermTab.decDeg !== nearestDec(tj, sl))) { try { thermTab = buildThermalTable(tj, sl); terrain.setThermal(thermTab); } catch (e) { console.warn('thermal', e); thermTab = null; } }
    groundK = thermTab && layer === 'walk' ? sampleThermal(thermTab, bodyToGeo(P.dir).lat, sun.localTime(S.et, bodyToGeo(P.dir).lon, S.dir)) : null; }
  // player shadow (E): along the sun direction from the player's feet
  const showShadow = layer === 'walk' && sElev > 0.03; shadow.visible = showShadow;
  if (showShadow) { const gr = P.stand; const sd = v3.norm(v3.sub(S.dir, v3.mul(v3.norm(P.dir), v3.dot(S.dir, v3.norm(P.dir))))); const len = Math.min(25, 1.7 / Math.tan(Math.asin(Math.min(1, sElev)))); const c0 = v3.add(v3.mul(P.dir, gr + 0.05), v3.mul(sd, -len / 2));
    shadow.position.copy(tr(c0)); const nT = tr(v3.norm(P.dir)); shadow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nT); const away = tr(sd).negate(); const ang = Math.atan2(away.dot(new THREE.Vector3(0, 1, 0).cross(nT)), away.dot(new THREE.Vector3(1, 0, 0)));
    shadow.rotateZ(ang); shadow.scale.set(len / 1, 0.5 / 0.5, 1); }
  if (craterMark) {   // 人工クレーターの印（衝突後のみ）。地形メッシュの実測地面に密着させる
    craterMark.visible = clock.ms >= SCI_MS;
    if (clock.ms >= SCI_MS && performance.now() - (craterSnap ?? 0) > 2000) { craterSnap = performance.now();
      const gr = groundAt(craterDir); craterMark.position.copy(tr(v3.mul(craterDir, gr + 0.12))); }
  }
  spacecraft(S.et, gp);
  sunLight.position.copy(tr(S.dir).multiplyScalar(100)); sunLight.target.position.copy(cp);
  stepDust(dt); stepJet(dt);
  if (layer === 'td1') { if (scInfo) camera.lookAt(tr(scInfo.p)); else { camera.lookAt(camera.position.clone().add(tr(v3.norm(P.dir)).multiplyScalar(10))); } }
  td1Burst(); td1Caption();
  featureFrame(eyeB!);
  nearHits = layer === 'walk' ? nearby(world, gp.lat, gp.lon, clock.ms) : [];
  hudUpdate(S, gp, upV, eB); hints(); renderer.render(scene, camera);
  updateLocator(); minimap.render(dt);   // P2-2: メイン描画後に追描画
  // P1-1: スライダー同期・飛行中は無効化
  slider.sync(clock.ms); slider.setEnabled(layer === 'walk');
  spaceBtn.sync(layer === 'walk' ? 'ground' : inFlight() ? 'space' : null);
  { const fl = inFlight(); document.body.classList.toggle('flying', fl);
    if (!fl && (pad.up || pad.down)) { pad.up = pad.down = false; flightPad.querySelectorAll('button.on').forEach(b => b.classList.remove('on')); } }
  if (layer === 'walk' && now - lastTrack > 5000) { lastTrack = now; session.track.push({ t: new Date(clock.ms).toISOString(), lat: gp.lat, lon: gp.lon, layer }); try { localStorage.setItem('ryugu_t', String(clock.ms)); } catch { /* ignore */ } }
    // 磁場ドローン: MASCOTサイト近傍では実MAGデータの磁場強度、それ以外は背景値（E: 音響化）
  const nearMascot = surfDist(gp.lat, gp.lon, SITE.lat, SITE.lon) < 200;
  const bMag = nearMascot ? (mascot.magNow() ?? 10) : 10;
  if (sound.on) sound.field(bMag);
}
let lastTrack = 0;

function spacecraft(et: number, gp: { lat: number; lon: number }) {
  const r = layer === 'mascot' ? null : scAtG(sc, et); scDot.visible = false; if (scMesh) scMesh.visible = false; scInfo = null;
  if (!r) return; const p = r.p; const eyeP = (layer === 'space' && sp) ? v3.mul(sp.dir, sp.rad) : (orbit && (layer === 'ballistic' || layer === 'orbit')) ? bodyOf(orbit) : v3.mul(P.dir, groundAt(P.dir) + EYE); const dist = v3.len(v3.sub(p, eyeP)); const pg = bodyToGeo(p);
  scInfo = { alt: v3.len(p) - hm.radius(pg.lat, pg.lon), dist, lat: pg.lat, lon: pg.lon, grade: r.grade, p };
  if (scMesh && dist < 2500) { scMesh.visible = true; scMesh.position.copy(tr(p)); scMesh.scale.setScalar(1);
    // attitude: NO CK kernels -> approximation (D). Model -Z (sampler horn) points at the surface,
    // model +Y (solar-panel axis) is rolled toward the Sun so the sunlit side faces the camera when possible.
    const d = tr(v3.norm(p));                                  // 天体中心から探査機方向（=模型+Zの向き先）
    const s3 = tr(sunNow().dir);                               // 太陽方向（body系→three系）
    let y = s3.clone().addScaledVector(d, -s3.dot(d));         // 太陽方向を-Z軸(＝d)に垂直な平面へ射影
    if (y.lengthSq() < 1e-6) y = new THREE.Vector3(0, 1, 0).addScaledVector(d, -d.y);   // 太陽が真下/真上の特別な場合
    y.normalize();
    const z = d.clone();
    const x = new THREE.Vector3().crossVectors(y, z).normalize();
    scMesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)); }
  else { scDot.visible = true; scDot.position.copy(tr(p)); scDot.scale.setScalar(Math.max(1, dist / 110)); }
}
const loc = (() => { const d = document.createElement('div'); d.id = 'hp-loc'; d.style.cssText = 'position:fixed;left:0;top:0;display:none;z-index:5;pointer-events:none;color:#E8A33D;font:600 12px "Share Tech Mono","Noto Sans JP",monospace;text-shadow:0 1px 3px #000';
  d.innerHTML = '<div id="hp-ring" style="position:absolute;left:-17px;top:-17px;width:34px;height:34px;border:2px solid #E8A33D;border-radius:50%"></div><div id="hp-arr" style="position:absolute;left:-12px;top:-14px;font-size:24px;display:none">➤</div><span id="hp-txt" style="position:absolute;left:24px;top:-9px;white-space:nowrap"></span>'; document.body.appendChild(d); return d; })();
const locRing = loc.querySelector('#hp-ring') as HTMLElement, locArr = loc.querySelector('#hp-arr') as HTMLElement, locTxt = loc.querySelector('#hp-txt') as HTMLElement;
/** 飛行中、はやぶさ2の方向を画面に示す: 視界内ならリング、視界外なら画面端の矢印（演出E。位置データは観測/SPICE由来） */
function updateLocator() {
  if (!inFlight() || !scInfo) { loc.style.display = 'none'; return; }
  const v = tr(scInfo.p).project(camera); let x = v.x, y = v.y; const behind = v.z > 1; if (behind) { x = -x; y = -y; }
  const on = !behind && Math.abs(x) < 0.94 && Math.abs(y) < 0.9; const m = Math.max(Math.abs(x) / 0.94, Math.abs(y) / 0.9, 1e-6);
  const sx = on ? x : x / m * 0.94, sy = on ? y : y / m * 0.9; loc.style.display = 'block';
  loc.style.transform = `translate(${((sx + 1) / 2 * innerWidth).toFixed(0)}px,${((1 - sy) / 2 * innerHeight).toFixed(0)}px)`;
  locRing.style.display = on ? 'block' : 'none'; locArr.style.display = on ? 'none' : 'block'; if (!on) locArr.style.transform = `rotate(${Math.atan2(-sy, sx)}rad)`;
  const d = scInfo.dist; locTxt.style.left = on ? '24px' : (sx > 0.5 ? '-110px' : '24px'); locTxt.textContent = `はやぶさ2 ${d >= 1000 ? (d / 1000).toFixed(1) + 'km' : d.toFixed(0) + 'm'}`;
}
let scInfo: { alt: number; dist: number; lat: number; lon: number; grade: number; p: V3 } | null = null;
const compass = (from: { lat: number; lon: number }, to: { lat: number; lon: number }) => { const y = Math.sin((to.lon - from.lon) * DEG) * Math.cos(to.lat * DEG), x = Math.cos(from.lat * DEG) * Math.sin(to.lat * DEG) - Math.sin(from.lat * DEG) * Math.cos(to.lat * DEG) * Math.cos((to.lon - from.lon) * DEG); const b = (Math.atan2(y, x) / DEG + 360) % 360; return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(b / 45) % 8]; };
/** 視線方向に対する相対方位（度。0=正面, 90=右）— 地球・はやぶさ2方向矢印用 */
function relBearing(dirBody: V3, up: V3, fwd: V3): number {
  let north = v3.norm(v3.sub([0, 0, 1], v3.mul(up, up[2])));
  if (v3.len(north) < 1e-6) north = v3.norm(v3.sub(fwd, v3.mul(up, v3.dot(fwd, up))));
  const east = v3.cross(north, up);
  const azD = Math.atan2(v3.dot(dirBody, east), v3.dot(dirBody, north));
  const fh = v3.norm(v3.sub(fwd, v3.mul(up, v3.dot(fwd, up))));
  const azF = Math.atan2(v3.dot(fh, east), v3.dot(fh, north));
  return (azD - azF) / DEG;
}
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
const arrowChar = (deg: number) => ARROWS[((Math.round(deg / 45) % 8) + 8) % 8];

function hudUpdate(S: { et: number; dir: V3; au: number }, gp: { lat: number; lon: number; r: number }, up: V3, eB: { dir: V3; au: number }) {
  const T = t();
  if (layer === 'td1') {
    const gl = scInfo ? (lang === 'ja' ? GRADE_LABEL : GRADE_LABEL_EN)[scInfo.grade] : ''; const atTd = Math.abs(clock.ms - TD1_MS) < 500;
    hud.set(0, fmtJST(clock.ms).replace(' JST', ':' + String(new Date(clock.ms).getUTCSeconds()).padStart(2, '0') + ' JST') + (atTd ? ' — 公表接地時刻' : ''));
    hud.set(1, scInfo ? `はやぶさ2 高度 ${scInfo.alt >= 100 ? (scInfo.alt >= 1000 ? (scInfo.alt / 1000).toFixed(2) + 'km' : scInfo.alt.toFixed(0) + 'm') : scInfo.alt.toFixed(1) + 'm'}（地表面から・機体中心）　${compass(gp, scInfo)}  [${gl}]` : `はやぶさ2 ${T.no_data}`);
    hud.set(2, `位置:SPK欠損を航法点・公表アンカー等から補完（根拠A–Dを表示）　姿勢:降下方向に合わせた近似${mark('D')}（CKなし）　Space:再生　E:終了`); hud.set(3, ''); return; }
  if (layer === 'mascot') {
    const jst = fmtJST(mascot.t) + ''; hud.set(0, jst.replace(' JST', ':' + String(new Date(mascot.t).getUTCSeconds()).padStart(2, '0') + ' JST')); hud.set(1, mascot.position());
    const mc = library.data?.temp?.mara_comparison; const diffs = mc ? mc.model_K_lat20_ti300.map((m: number, i: number) => m - mc.mara_K[i]) : [];
    const cmp = diffs.length ? `　1D熱伝導モデル${mark('D')}は+${Math.min(...diffs).toFixed(0)}〜+${Math.max(...diffs).toFixed(0)}K高い` : '';
    const pos = mascot.posTopo(); const tk = mascot.tempK(); if (mascot.phase() === 'end') hud.set(2, T.mascot_end); else if (pos && mascot.phase() !== 'surface') { hud.set(2, `高度 ${pos[2].toFixed(1)}m`); } else hud.set(2, tk != null ? `岩温度 ${tk.toFixed(1)}K（MARA BP8-12）${cmp}` : ''); hud.set(3, ''); return; }
  // P1-2: 日時 + 次イベントまでのカウントダウン
  let l0 = fmtJST(clock.ms);
  const todayEv = events.find(e => jstDate(e.ms) === jstDate(clock.ms));
  const nx = nextEvent(events, clock.ms);
  if (todayEv) l0 += ` — 本日: ${todayEv.title}`;
  else if (nx) l0 += ` — 次: ${nx.title}まで ${fmtCountdown(clock.ms, nx)}`;
  else l0 += ` — 滞在期間の最終日（${fmtJST(MISSION_T1).slice(0, 10)}出発）`;
  hud.set(0, l0);
  // 標高=位置の動径距離−平均半径448.8m。歩行は地面、飛行は機体中心の位置を使う（局所地表からの高度ではない）。
  const posR = layer === 'walk' ? P.stand : (layer === 'space' && sp) ? sp.rad : (orbit ? v3.len(bodyOf(orbit)) : hm.radius(gp.lat, gp.lon));
  const elev = posR - R_MEAN; const inF = annot && annotOn && layer === 'walk' ? annot.whereAmI(v3.norm(P.dir))[0] : undefined;
  const ll = `${fmtLat(gp.lat)} ${fmtLon(gp.lon)}  ${T.elev} ${Math.round(elev)}m` ; hud.set(1, ll);
  { const nm = inF ? inF.short_ja : '—'; if (ckPn.textContent !== nm) ckPn.textContent = nm; ckPl.classList.toggle('in', !!inF); }
  let l3: string; if ((layer === 'ballistic' || layer === 'orbit') && orbit) { const a = altitude(orbit, groundAt); const spd = v3.len(velBodyOf(orbit));
    const elS = Math.max(0, (clock.ms - flightStartMs) / 1000); const elTxt = elS >= 3600 ? `${Math.floor(elS / 3600)}時間${Math.round((elS % 3600) / 60)}分` : elS >= 60 ? `${Math.round(elS / 60)}分` : `${Math.round(elS)}秒`;
    l3 = `${layer === 'orbit' ? T.esc_orbit : T.ballistic} ${a > 1000 ? (a / 1000).toFixed(1) + 'km' : a.toFixed(0) + 'm'} 速度（リュウグウ固定系） ${(spd * 100).toFixed(1)}cm/s 飛行${elTxt}（${T.pm}${mark('D')}）`;
    if (compress > 1.5) l3 += ` 時間圧縮×${Math.round(compress)}（演出E）`; }
  else if (layer === 'space' && sp) {
    const alt = sp.rad - groundAt(sp.dir); const at = alt >= 1000 ? (alt / 1000).toFixed(2) + 'km' : alt.toFixed(0) + 'm';
    const st = sp.phase === 'ascend' ? '上昇中' : sp.phase === 'return' ? '最寄りの地表へ帰還中' : sp.captured ? '重力に捕まりました — 自動着地' : '自由飛行';
    l3 = mqCompact.matches ? `${st}  高度 ${at}  ${sp.speed.toFixed(1)}m/s${sp.captured ? `  ×${TIME_COMPRESS}` : ''}` : `宇宙モード ${st}  高度 ${at}（地表から） 中心から ${sp.rad.toFixed(0)}m  速度 ${sp.speed.toFixed(1)}m/s${sp.captured ? `  時間圧縮×${TIME_COMPRESS}（演出E）` : ''}`;
  }
  else { const gs = sampleGravity(G, gp.lat, gp.lon); l3 = `${T.gravity} ${(gs.gmag * 1000).toFixed(2)}mm/s²  ${T.escape} ${(gs.esc * 100).toFixed(0)}cm/s${mark('D')}${G === G340 ? '  [3.40h]' : ''}`; }
  if (layer === 'walk' && Math.abs(driveSpeed) > 0.1) l3 += `  車両風走行 ${Math.abs(driveSpeed).toFixed(1)}m/s（演出E）`;
  if (scInfo) { const gl = (lang === 'ja' ? GRADE_LABEL : GRADE_LABEL_EN)[scInfo.grade]; l3 += `  はやぶさ2高度 ${scInfo.alt > 1000 ? (scInfo.alt / 1000).toFixed(1) + 'km' : scInfo.alt.toFixed(0) + 'm'}（地表面から・機体中心） ${arrowChar(relBearing(scInfo.p, up, P.fwd))} [${gl}]`; }
  else if (clock.ms >= Date.UTC(2018, 5, 27) && clock.ms <= Date.UTC(2019, 10, 19)) l3 += `  はやぶさ2 ${T.no_data}（遠方観測・退避運用中）`;
  hud.set(2, l3);
  // P2-1: 地球の方位・仰角・距離（歩行層で常時。矢印は視線方向からの相対角度）
  if (layer === 'walk') {
    const eElev = Math.asin(Math.max(-1, Math.min(1, v3.dot(eB.dir, up)))) / DEG;
    const km = eB.au * 149597870.7;
    hud.setHtml(3, `地球 ${arrowChar(relBearing(eB.dir, up, P.fwd))} 仰角${eElev.toFixed(0)}°  ${eB.au.toFixed(2)}AU（${(km / 1e4).toFixed(0)}万km）`);
  } else if (layer === 'space') hud.set(3, isTouch ? '左スティック:周回　右ドラッグ:見回す　▲▼:上昇・降下　右上スイッチ:地表へ' : 'Space:遠ざかる　C:近づく・着地　WASD/矢印:球面を周回　ドラッグ:見回す　右上のスイッチ:最寄りの地表へ戻る');
  else hud.set(3, '');
}

// ---------------- idle hints (§5.3.1): flight-control comms, only unused features, max 3 times each
const HINT_ORDER: [string, number][] = [['time', 0], ['inspect', 1], ['phys', 3], ['dash', 4], ['misc', 5]];
function hints() {
  if (card.isOpen || viewer.isOpen || minimap?.open || mode < 0) { return; }
  // P1-5: 視点リプレイ地点の近くでは発見性を補強
  if (layer === 'walk' && (nearHits.some(h => h.id === 'td1') || nearHits.some(h => h.id === 'mascot_landing')) && performance.now() - (hintShown['replay'] ?? 0) > 45000) {
    hintShown['replay'] = performance.now(); hint.show('E: この場所の視点を体験（TD1降下 / MASCOT リプレイ）'); lastInput = performance.now() - 15000; return;
  }
  if (annot && annotOn && layer === 'walk' && !used.has('annot') && (hintShown['annot'] ?? 0) < 2 && (annot.visibleIds.length || annot.guideIds.length) && performance.now() - lastInput > 12000) {
    hintShown['annot'] = (hintShown['annot'] ?? 0) + 1; hint.show('視界の名前をタップ/クリックで、由来とそこで起きたことが開きます（地面を直接タップでも可）。N: 表示切替 / L: 地名リスト'); lastInput = performance.now() - 8000; return;
  }
  if (performance.now() - lastInput < 25000 || layer !== 'walk') { return; }
  for (const [k, i] of HINT_ORDER) { if (used.has(k) || (hintShown[k] ?? 0) >= 3) continue; const text = (k === 'inspect' && !nearHits.length) ? null : t().idle[i]; if (!text) continue;
    hint.show(`${session.callsign} — ${text}`); hintShown[k] = (hintShown[k] ?? 0) + 1; lastInput = performance.now() - 15000; return; }
}
function activity(kind?: string) { lastInput = performance.now(); hint.hide(); if (kind) used.add(kind); }

// ---------------- interaction
const joy = { active: false, x: 0, y: 0 };
function interact() {
  if (card.isOpen) { if (mascotPoi) { enterMascot(); } else card.hide(); return; }
  if (viewer.isOpen) { viewer.close(); return; }
  const h = nearHits[0]; if (!h) return; used.add('inspect');
  if (h.kind === 'poi') openPoi(h.ref as Poi);
  else if (h.kind === 'gallery') { const g = world.gallery.filter(x => x.folder === h.ref.folder); viewer.open(g.map(x => ({ src: url(`assets/gallery/${x.folder}/${x.id}`), caption: `${FOLDER_NOTE[x.folder] ?? x.event}（${x.date}）`, kind: 'gallery' as const })), Math.max(0, g.findIndex(x => x.id === h.id))); session.inspected.add(h.id); }
  else if (h.kind === 'l2c') { const l = world.l2c.filter(x => x.lat != null); viewer.open(l.map(x => ({ src: url(x.jpg), caption: `ONC l2c ${x.id}`, kind: 'onc' as const })), Math.max(0, l.findIndex(x => x.id === h.id))); session.inspected.add(h.id); }
}
let mascotPoi = false;
function openPoi(p: Poi) {
  session.inspected.add(p.id); const body = mode === 0 ? `${p.nickname ? `<p>${esc(p.nickname)}</p>` : ''}<p>${esc(p.education_hook ?? p.description)}</p>` : mode === 1 ? `<p>${esc(p.description)}</p>` : `<p>${esc(p.description)}</p><p>${esc(p.accuracy ?? '')}</p>`;
  const refs = (mode === 2 && p.sources) ? '<p>' + p.sources.map((s: any) => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>` : esc(s.label)).join(' / ') + '</p>' : '';
  mascotPoi = p.id === 'mascot_landing'; let extra = '';
  if (p.id === 'td1') extra = `<p><a href="#" id="td1go">${esc(t().td1_enter)}</a></p>`; if (mascotPoi) extra = `<p><a href="#" id="mgo">${esc(t().mascot_enter)}</a>　(E)</p>`;
  const chamber = p.id === 'td1' ? 'A' : 'C';
  const parts = (p.id === 'td1' || p.id === 'td2') ? (world.samples?.samples ?? []).filter((s: any) => s.chamber === chamber) : [];
  const samp = (p.id === 'td1' || p.id === 'td2') ? `<p>試料: チャンバー${chamber}（${esc((world.samples?.chambers ?? []).find((c: any) => c.chamber === chamber)?.note ?? '')}）</p>${parts.length ? `<p>配布粒子: ${parts.map((s: any) => `<a href="#" class="smp" data-id="${esc(s.id)}">${esc(s.id)}</a>`).join(' ')}</p>` : ''}` : '';
  card.show(p.name_ja, body + refs + samp + extra, 'poi', p.sources?.[0]?.label);
  document.getElementById('mgo')?.addEventListener('click', e => { e.preventDefault(); enterMascot(); }); document.getElementById('td1go')?.addEventListener('click', e => { e.preventDefault(); enterTd1(); });
  card.node.querySelectorAll('a.smp').forEach(a => a.addEventListener('click', e => { e.preventDefault(); library.showSample({ viewer, card, lat: () => bodyToGeo(P.dir).lat, localHour: () => libLocalHour(), subsolarLat: () => libSubsolarLat() }, (a as HTMLElement).dataset.id!); }));
}
// ---------------- 地名・イベント注釈（走行中の視界に地図を投影）
/** 毎フレーム: 地形の色付け（シェーダ）と視界内ラベルを更新。ラベルは歩行・飛行のみ、色付けはMASCOT視点以外。 */
function featureFrame(eyeB: V3) {
  if (!annot) return;
  terrain.setFeatures(annotOn && layer !== 'mascot' ? annot.shaderItems(clock.ms) : []);
  const labels = annotOn && (layer === 'walk' || layer === 'ballistic' || layer === 'orbit');
  annot.update(camera, clock.ms, labels, eyeB, layer === 'walk');
  if (labels && layer === 'walk') {   // 地物の中に入った／出たを支援技術にも伝える
    const ins = annot.whereAmI(v3.norm(P.dir)); const key = ins.map(p => p.id).join(',');
    if (key !== lastInside) { lastInside = key; if (ins[0]) hud.announce(`${ins[0].name_ja} の中に入りました`); }
  }
}
function openFeature(id: string) {
  if (!annot) return; const p = annot.find(id); if (!p) return;
  session.inspected.add('feat_' + id); used.add('inspect'); used.add('annot');
  const { title, html } = featureCard(p, { nowMs: clock.ms, mode, evTitle: eid => events.find(e => e.id === eid)?.title, canTravel: true });
  card.show(title, html, 'poi', p.sources[0]?.label); card.node.classList.add('lib');
  annot.select(id);   // 視界内なら色付けの縁を強調（約9秒）
  card.node.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const el = b as HTMLElement; if (el.dataset.act === 'go') goToFeature(p); else if (el.dataset.act === 'ev' && el.dataset.ev) eventUi.detail(el.dataset.ev);
  }));
}
/** 地物の手前（南側）に立って、その方を向く（演出E）。時刻は動かさない。 */
function goToFeature(p: PFeature) {
  card.hide(); viewer.close(); minimap?.hideModal(); driveSpeed = 0;
  if (layer === 'ballistic' || layer === 'orbit') returnToSurface();
  if (layer === 'mascot') exitMascot(); if (layer === 'td1') exitTd1();
  if (!p.placed || p.lat == null) return;
  const center: V3 = p.shape === 'band' ? geoToBody(0, 180, 1) : p.dir; const cg = bodyToGeo(center);
  const dM = Math.max(45, p.angR * R_MEAN * 1.8);
  const stand = geoToBody(Math.max(-85, Math.min(85, cg.lat - dM / R_MEAN / DEG)), cg.lon, 1);
  P.dir = stand; P.stand = groundAt(P.dir); orbit = null; layer = 'walk'; P.dip = 0.2; P.pitch = 0.05;
  P.fwd = v3.norm(v3.sub(center, v3.mul(stand, v3.dot(center, stand))));
  annot?.select(p.id, 12000); hint.show(`${p.short_ja} の手前 ${Math.round(dM)}m（演出E）`, false, 5000); activity();
}
function openPlaces() {
  if (!annot) { hint.show('地名データを読み込み中…', false, 2000); return; }
  const here = bodyToGeo(P.dir); const ins = new Set(annot.whereAmI(v3.norm(P.dir)).map(p => p.id));
  used.add('annot'); card.show('地名・出来事リスト', placesListHtml(annot.feats, here, ins), 'poi'); card.node.classList.add('lib');
  card.node.querySelectorAll('[data-feat]').forEach(b => b.addEventListener('click', () => openFeature((b as HTMLElement).dataset.feat!)));
}
function toggleAnnot() {
  annotOn = !annotOn; $('b-map').classList.toggle('active', annotOn); $('b-map').setAttribute('aria-pressed', String(annotOn)); try { localStorage.setItem('ryugu_annot', annotOn ? '1' : '0'); } catch { /* ignore */ }
  hint.show(annotOn ? '地名ガイド ON — 視界に入った地形に名前と色が重なります（Nで切替・Lで一覧）' : '地名ガイド OFF（Nで戻せます）', false, 4000);
}
/** 地面のタップ/クリック: 指した場所が地名・地点の範囲内ならその説明を開く（遠いほど当たりを広げる） */
function tapAt(cx: number, cy: number) {
  if (!annot || !annotOn || !ready || card.isOpen || viewer.isOpen || minimap?.open || layer === 'mascot' || layer === 'td1') return;
  const hit = terrain.pickDir(camera, new THREE.Vector2(cx / innerWidth * 2 - 1, -(cy / innerHeight) * 2 + 1)); if (!hit) return;
  const list = regionsAt(annot.feats, hit.dir, Math.max(6, hit.dist * 0.01));
  if (list.length) openFeature(list[0].id);
}

// ---------------- data archive (§4.13): G key / archive button — every dataset reachable
function libLocalHour() { const S = sunNow(); return sun.localTime(S.et, bodyToGeo(P.dir).lon, S.dir); }
function libSubsolarLat() { const S = sunNow(); return Math.asin(Math.max(-1, Math.min(1, S.dir[2]))) / DEG; }
function openLibrary() {
  if (!library.data) { hint.show('データ書庫を読み込み中…', false, 2000); return; }
  used.add('misc'); library.open({ viewer, card, lat: () => bodyToGeo(P.dir).lat, localHour: libLocalHour, subsolarLat: libSubsolarLat });
}
card.onClose = () => { mascotPoi = false; library.close(); card.node.classList.remove('lib'); };

// ---------------- P1-2: イベントへの時間・場所移動（演出E）
const ARRIVE_NOTE: Record<string, string> = {
  sci_impact: '銅弾が約2km/sで地表に叩き込まれた瞬間です。クレーターはこの地点にできました（琥珀の円）',
  sci_crater_found: '人工クレーター(直径14.5m・深さ1.7m)の確認 — 琥珀の円がその位置。地下物質が掘り出されました',
  td2: '人工クレーターの縁への着陸 — 世界初の「2回目の着陸」で地下の試料を採取',
};
function goToEvent(ev: REvent) {
  card.hide(); viewer.close(); minimap?.hideModal();
  driveSpeed = 0;
  if (inFlight()) returnToSurface();
  if (layer === 'mascot') exitMascot();
  if (layer === 'td1') exitTd1();
  clock.running = true; clock.set(ev.ms);
  if (ev.lat != null) {
    P.dir = geoToBody(ev.lat, ev.lon!, 1); P.stand = groundAt(P.dir); orbit = null; layer = 'walk'; P.dip = 0.2;
    const up = v3.norm(P.dir); const sh = v3.sub(sunNow().dir, v3.mul(up, v3.dot(sunNow().dir, up)));
    if (v3.len(sh) > 1e-4) P.fwd = v3.norm(sh);   // 現地の昼側を向く
    P.pitch = 0.1;
    hint.show(`${ev.title} — ${fmtJST(ev.ms)}${ARRIVE_NOTE[ev.id] ? '　' + ARRIVE_NOTE[ev.id] : ''}（時刻・場所の移動は演出E）`, false, 8000);
  } else hint.show(`${ev.title} — ${fmtJST(ev.ms)}（時刻移動は演出E）`, false, 6000);
  used.add('time'); activity();
}
/** P2-2: ミニマップからの瞬間移動（演出E） */
function teleport(lat: number, lon: number) {
  driveSpeed = 0;
  if (inFlight()) returnToSurface();
  if (layer === 'mascot') exitMascot();
  if (layer === 'td1') exitTd1();
  P.dir = geoToBody(lat, lon, 1); P.stand = groundAt(P.dir); orbit = null; layer = 'walk'; P.dip = 0.2;
  hint.show(`${fmtLat(lat)} ${fmtLon(lon)} へ移動しました（演出E）`, false, 4000);
  activity();
}

function enterMascot() {
  card.hide(); driveSpeed = 0; sp = null; orbit = null; layer = 'mascot'; mascot.enter(); clock.running = false; P.pitch = -0.25; mascotEnded = false; document.body.classList.add('mascot-on'); buildMascotPanel();
  hint.show('MASCOT着陸機の記録を再生しています。ドラッグで見回せます。Space: 一時停止 / ⏮⏭: 前後の撮影 / E: 終了', false, 9000);
}
/** MASCOT再生パネル: 何を見ているか・操作（再生/停止・速度・撮影間ジャンプ・スクラブ・終了）を画面上に常時表示（タッチ対応） */
let mrp: HTMLElement | null = null;
function buildMascotPanel() {
  mrp?.remove(); mrp = document.createElement('div'); mrp.id = 'mrp'; mrp.setAttribute('role', 'group'); mrp.setAttribute('aria-label', 'MASCOT記録再生');
  mrp.innerHTML = `<div class="mrt"><b>MASCOT着陸機の視点（記録の再生）</b><span>2018-10-03 分離 → 降下 → 着地 → 17時間の観測。位置・画像・温度は実データ、視線の向きは近似</span><button id="mr-x" type="button">✕ 終了して地表へ</button></div>
    <div class="mrc"><button id="mr-prev" type="button" aria-label="前の撮影へ">⏮</button><button id="mr-play" type="button" aria-label="一時停止">❚❚</button><button id="mr-next" type="button" aria-label="次の撮影へ">⏭</button><button id="mr-spd" type="button" aria-label="再生速度">×1</button>
    <input id="mr-rng" type="range" min="0" max="10000" value="0" aria-label="再生位置"><span id="mr-t"></span></div>
    <div class="mrl"><span style="flex:3">降下・バウンド（約23分）</span><span style="flex:7">静止後の観測: 昼と夜（約16時間44分）</span></div>`;
  document.body.appendChild(mrp);
  const $$ = (id: string) => mrp!.querySelector('#' + id) as HTMLElement;
  $$('mr-x').addEventListener('click', exitMascot); $$('mr-play').addEventListener('click', () => { mascot.playing = !mascot.playing; if (mascot.finished) { mascot.t = T_SEP; mascotEnded = false; mascot.playing = true; } });
  $$('mr-prev').addEventListener('click', () => mascot.seekImage(-1)); $$('mr-next').addEventListener('click', () => mascot.seekImage(1));
  $$('mr-spd').addEventListener('click', () => { const L = [1, 2, 4, 0.5]; mascot.mult = L[(L.indexOf(mascot.mult) + 1) % L.length]; });
  ($$('mr-rng') as HTMLInputElement).addEventListener('input', e => { mascot.t = MascotReplay.fromBar(+(e.target as HTMLInputElement).value / 10000); mascotEnded = false; });
}
function updateMascotPanel() {
  if (!mrp) return; const q = (id: string) => mrp!.querySelector('#' + id) as HTMLElement;
  const rng = q('mr-rng') as HTMLInputElement; if (document.activeElement !== rng) rng.value = String(Math.round(mascot.toBar() * 10000));
  const play = q('mr-play'); const lab = mascot.playing && !mascot.finished ? '❚❚' : '▶'; if (play.textContent !== lab) { play.textContent = lab; play.setAttribute('aria-label', lab === '▶' ? '再生' : '一時停止'); }
  q('mr-spd').textContent = `×${mascot.mult}`; const el = (mascot.t - T_SEP) / 1000; const m = Math.floor(el / 60), h = Math.floor(m / 60);
  q('mr-t').textContent = `分離から ${h > 0 ? h + '時間' : ''}${String(m % 60).padStart(2, '0')}分`;
}
/** MASCOTの目の位置: 降下・バウンド中は実際のSPK軌道（着陸点基準のTOPO座標。x=北, y=西, z=上と仮定。方位は近似D）、静止後は着陸点の地面 */
function mascotEye(): V3 {
  const rS = hm.radius(SITE.lat, SITE.lon); const up = geoToBody(SITE.lat, SITE.lon, 1); const q = mascot.posTopo();
  if (!q) return v3.mul(up, rS + 0.15);
  const east = v3.norm(v3.cross([0, 0, 1], up)), north = v3.cross(up, east);
  return v3.add(v3.mul(up, rS + Math.max(0, q[2]) + 0.15), v3.add(v3.mul(east, -q[1]), v3.mul(north, q[0])));
}
const TD1_MS = Date.UTC(2019, 1, 21, 22, 29, 10), TD1_A = Date.UTC(2019, 1, 20, 23, 17, 48), TD1_B = Date.UTC(2019, 1, 22, 3, 0, 0);
const TD1_SITE = { lat: 4.3, lon: 206.47 };
function enterTd1() {
  card.hide(); driveSpeed = 0; layer = 'td1'; orbit = null; sp = null; P.dir = geoToBody(TD1_SITE.lat, TD1_SITE.lon, 1); P.stand = groundAt(P.dir);
  clock.running = false; clock.set(Date.UTC(2019, 1, 21, 22, 19, 0)); hint.show('下のバーで再生・±10秒・終了　22:29:10 UTC（07:29:10 JST）が公表接地時刻', false, 7000); used.add('time');
}
function exitTd1() { layer = 'walk'; clock.running = true; clock.set(Math.max(TD1_MS, Math.min(TD1_B, clock.ms))); burst.visible = false; P.stand = groundAt(P.dir); }
/** P1演出: TD1リプレイの実況キャプション — カウントダウン→接触→離陸の各段階を1行で伝える。
 *  データは公表値（接触 22:29:10 UTC、弾丸発射・試料採取、その後上昇）。表示は演出。 */
const td1CapEl = (() => { const d = document.createElement('div'); d.id = 'td1cap'; document.body.appendChild(d); return d; })();
let td1CapStage = -1;
// TD1リプレイの操作バー（タッチ端末でもホイール/Space/E なしで操作・終了できる）
const td1Bar = (() => {
  const d = document.createElement('div'); d.id = 'td1bar';
  d.innerHTML = '<button type="button" data-a="back" aria-label="10秒戻る">−10s</button><button type="button" data-a="play" aria-label="再生/一時停止">▶／❚❚</button><button type="button" data-a="fwd" aria-label="10秒進む">+10s</button><button type="button" data-a="exit" aria-label="リプレイを終了">終了 ✕</button>';
  d.addEventListener('click', e => { const a = (e.target as HTMLElement).closest('button')?.dataset.a; if (!a) return; activity();
    if (a === 'play') clock.running = !clock.running;
    else if (a === 'exit') exitTd1();
    else { clock.running = false; clock.jump(a === 'fwd' ? 10e3 : -10e3); clock.set(Math.max(TD1_A, Math.min(TD1_B, clock.ms))); } });
  document.body.appendChild(d); return d;
})();

function td1Caption() {
  if (layer !== 'td1') { if (td1CapStage >= 0) { td1CapEl.classList.remove('on'); td1CapStage = -1; } return; }
  const dts = (clock.ms - TD1_MS) / 1000;
  let stage = -1, html = '';
  if (dts < -60) { stage = 0; }
  else if (dts < 0) { stage = 1; html = `接地まで <b>${Math.max(1, Math.ceil(-dts))}</b> 秒 — 高度を下げています`; }
  else if (dts < 2) { stage = 2; html = `<b>22:29:10 UTC — 公表接地時刻。</b>接触・弾丸発射・試料採取を再生`; }
  else if (dts < 30) { stage = 3; html = `次の公表位置アンカー（22:29:40 UTC）まで — 軌跡は再構成・補間表示`; }
  else if (dts < 60) { stage = 4; html = `<b>22:29:40 UTC — 公表位置アンカー。</b>探査機は上昇中`; }
  if (stage !== td1CapStage) { td1CapStage = stage; if (html) { td1CapEl.innerHTML = html; td1CapEl.classList.add('on'); } else td1CapEl.classList.remove('on'); }
}
/** touchdown projectile burst (minimal particles, deterministic). t = seconds since 22:29:10 UTC. Effect only; not data. */
function td1Burst() {
  const dts = (clock.ms - TD1_MS) / 1000; if (layer !== 'td1' || dts < 0 || dts > 8) { burst.visible = false; return; }
  const up = v3.norm(P.dir), base = v3.mul(up, groundAt(P.dir) + 0.05), pa = (burst.geometry.getAttribute('position') as THREE.BufferAttribute);
  const e1 = v3.norm(v3.cross(up, [0, 0, 1])), e2 = v3.cross(up, e1);
  for (let i = 0; i < pa.count; i++) { const az = hash2(i, 1, 41) * Math.PI * 2, sp = 0.15 + hash2(i, 2, 41) * 0.5, vu = 0.1 + hash2(i, 3, 41) * 0.4;
    const q = v3.add(base, v3.add(v3.mul(v3.add(v3.mul(e1, Math.cos(az)), v3.mul(e2, Math.sin(az))), sp * dts), v3.mul(up, vu * dts - 0.5 * 0.0002 * dts * dts))); const th = bodyToThree(q); pa.setXYZ(i, th[0], th[1], th[2]); }
  pa.needsUpdate = true; burst.visible = true; (burst.material as THREE.PointsMaterial).opacity = Math.max(0, 0.9 * (1 - dts / 8));
}
function exitMascot() { mrp?.remove(); mrp = null; document.body.classList.remove('mascot-on'); document.getElementById('mascot-pip')?.remove(); mascot.exit(); layer = 'walk'; clock.running = true; clock.set(Math.max(T_SEP, Math.min(T_END, mascot.t))); P.dir = geoToBody(SITE.lat, SITE.lon, 1); P.stand = groundAt(P.dir); P.pitch = 0; mascotMarker.visible = true; mascotImg = null; mascotImgId = ''; }
function mascotStep(dt: number) {
  mascot.advance(dt); updateMascotPanel();
  const im = mascot.imageAt(); const id = im?.img.id ?? '';
  if (id !== mascotImgId) { mascotImgId = id; document.getElementById('mascot-pip')?.remove(); mascotImg = null;
    if (im) { const w = document.createElement('div'); w.id = 'mascot-pip'; const e = new Image(); e.src = url(im.img.png); e.alt = `MASCAM ${im.img.id}`; const c = document.createElement('div'); c.className = 'cap'; w.appendChild(e); w.appendChild(c); document.body.appendChild(w); requestAnimationFrame(() => w.classList.add('on')); mascotImg = e; }
  }
  const pip = document.getElementById('mascot-pip'); if (pip && im) {
    const ph = im.img.phase === 'Descent' ? '降下中' : '着地後'; const led = im.img.led && im.img.led !== 'NONE' ? '赤外LEDで照らした夜の撮影' : '太陽光での撮影';
    const age = im.ageS > 120 ? `　（${Math.round(im.ageS / 60)}分前の画像）` : '';
    (pip.querySelector('.cap') as HTMLElement).textContent = `MASCAMのカメラ画像 ${ph}・${led}${age}　${credit('mascam')}`; }
  if (mascot.finished && !mascotEnded) { mascotEnded = true; mascotEndCard(); }
}
let mascotEnded = false;
/** MASCOT運用終了のまとめ（演出ではなくデータの要約）: 17時間07分の成果を3行で遺す */
function mascotEndCard() {
  const nImg = mascot.d.imgs.length;
  card.show('MASCOT — 17時間07分の運用を終了', `
    <p>2018-10-04 04:04 JST、電池が尽き、10kgの着陸機は静かになった。リュウグウの夜を2回越えた17時間07分で、MASCOTが遺したもの:</p>
    <p>• <b>磁場を測った</b> — 磁場はほぼ検出されず、リュウグウが磁場を持たない古い・原始的な天体である証拠となった（MAG）</p>
    <p>• <b>温度を測り続けた</b> — 岩の表面温度を終夜記録。昼と夜では約120Kも変わる（MARA）</p>
    <p>• <b>${nImg}枚の地表の写真</b> — 夜は赤外LED照明で撮影した（MASCAM）</p>
    <p class="lnote">画像・温度・位置・磁場はすべて実データ（DLR/CNES/JAXA）。Eキーで地表に戻ります</p>`, 'mascam');
}

// ---------------- input
addEventListener('keydown', e => {
  if (!ready) return; activity(); if (e.key === 'Escape' && !viewer.isOpen) {   // Esc: ビューア → カード → 全体図 → リプレイ の順に1つずつ閉じる
    if (card.isOpen) { card.hide(); return; } if (minimap?.open) { minimap.hideModal(); return; }
    if (layer === 'mascot') { exitMascot(); return; } if (layer === 'td1') { exitTd1(); return; }
  }
  if (minimap?.open && e.code === 'KeyE') { minimap.hideModal(); return; }
  if (viewer.isOpen) { viewer.handleKey(e); if (e.code === 'KeyE') viewer.close(); return; }
  keys.add(e.code);
  if (e.code === 'KeyE') { if (layer === 'mascot') { exitMascot(); } else if (layer === 'td1') { exitTd1(); } else interact(); }
  if (layer === 'mascot') { if (e.code === 'Space') { e.preventDefault(); mascot.playing = !mascot.playing; } else if (e.code === 'ArrowRight') mascot.seekImage(1); else if (e.code === 'ArrowLeft') mascot.seekImage(-1); if (e.code !== 'KeyE') return; }
  if (e.code === 'Space' && layer === 'td1') { e.preventDefault(); clock.running = !clock.running; return; }
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'KeyP') { G = G === G340 ? G763 : G340; hint.show(G === G340 ? '過去モード: 自転周期 3.40h（重力表 3.40h）' : '現在: 自転周期 7.63h', false, 3000); }
  if (e.code === 'KeyR') recordNow(); if (e.code === 'KeyB') toggleSound(); if (e.code === 'KeyG') openLibrary();
  if (e.code === 'KeyV') eventUi.openList();   // イベントメニュー（Vキー）
  if (e.code === 'KeyN') toggleAnnot(); if (e.code === 'KeyL') openPlaces();   // 地名ガイド（N: 表示切替 / L: 地名・出来事リスト）
  if (e.shiftKey && e.code === 'KeyW') used.add('dash');
});
addEventListener('keyup', e => keys.delete(e.code)); addEventListener('blur', () => keys.clear());
let drag = false, lx = 0, ly = 0;
canvas.addEventListener('mousedown', e => { drag = true; lx = e.clientX; ly = e.clientY; activity(); });
addEventListener('mouseup', () => { drag = false; spLook.t = performance.now(); });
addEventListener('mousemove', e => { if (!drag) return; look(e.clientX - lx, e.clientY - ly); lx = e.clientX; ly = e.clientY; });
function look(dx: number, dy: number) { if (layer === 'space') { spLook.yaw = wrapPi(spLook.yaw - dx * 0.004); spLook.pitch = Math.max(-1.5, Math.min(1.5, spLook.pitch - dy * 0.004)); spLook.t = performance.now(); return; } const up = v3.norm(P.dir); const a = -dx * 0.004; const f = v3.norm(v3.sub(P.fwd, v3.mul(up, v3.dot(P.fwd, up)))); const r = v3.cross(up, f); P.fwd = v3.norm(v3.add(v3.mul(f, Math.cos(a)), v3.mul(r, Math.sin(a)))); P.pitch = Math.max(-1.4, Math.min(1.4, P.pitch - dy * 0.004)); }
// ホイール: 時間移動は廃止（P1-1）。MASCOT スクラブと TD1 リプレイのみ残す。
canvas.addEventListener('wheel', e => { e.preventDefault(); activity();
  if (layer === 'mascot') { return; }   // 時間は再生パネルで操作（ホイールでは動かさない）
  if (layer === 'td1') { clock.running = false; clock.jump(Math.sign(e.deltaY) * -1 * (e.shiftKey ? 60e3 : 10e3)); clock.set(Math.max(TD1_A, Math.min(TD1_B, clock.ms))); return; }
}, { passive: false });
// touch (passive:false so we can preventDefault — skill: threejs touch events)
const stick = $('stick'), knob = $('knob'); let touchLook = -1, tlx = 0, tly = 0;
// ---- タッチ操作: 左半分 = 浮動バーチャルスティック（触れた場所が中心になる）/ 右半分 = 見回し
const JOY_R = 56, JOY_DEAD = 0.12; let joyTouch = -1, jcx = 0, jcy = 0;
function joyAt(x: number, y: number) {
  let dx = (x - jcx) / JOY_R, dy = (y - jcy) / JOY_R; const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
  const m = Math.hypot(dx, dy); const k = m < JOY_DEAD ? 0 : (m - JOY_DEAD) / (1 - JOY_DEAD) / m;   // 不感帯を除いて0〜1に再スケール
  joy.x = dx * k; joy.y = dy * k; knob.style.transform = `translate(${dx * JOY_R}px,${dy * JOY_R}px)`;
}
function joyEnd() { joyTouch = -1; joy.active = false; joy.x = joy.y = 0; knob.style.transform = ''; stick.classList.remove('on'); }
canvas.addEventListener('touchstart', e => { e.preventDefault(); activity();
  for (const tt of Array.from(e.changedTouches)) {
    if (tt.clientX > innerWidth / 2) { if (touchLook < 0) { touchLook = tt.identifier; tlx = tt.clientX; tly = tt.clientY; } }
    else if (joyTouch < 0 && (layer === 'walk' || inFlight())) {
      joyTouch = tt.identifier; jcx = Math.max(60, Math.min(innerWidth - 60, tt.clientX)); jcy = Math.max(60, Math.min(innerHeight - 60, tt.clientY)); joy.active = true; joy.x = joy.y = 0;   // 枠は画面からはみ出さない位置に
      stick.style.left = (jcx - 55) + 'px'; stick.style.top = (jcy - 55) + 'px'; stick.style.bottom = 'auto'; stick.classList.add('on');
    }
  } }, { passive: false });
canvas.addEventListener('touchmove', e => { e.preventDefault(); for (const tt of Array.from(e.changedTouches)) {
  if (tt.identifier === touchLook) { look(tt.clientX - tlx, tt.clientY - tly); tlx = tt.clientX; tly = tt.clientY; }
  else if (tt.identifier === joyTouch) joyAt(tt.clientX, tt.clientY); } }, { passive: false });
const touchDone = (e: TouchEvent) => { for (const tt of Array.from(e.changedTouches)) { if (tt.identifier === touchLook) { touchLook = -1; spLook.t = performance.now(); } if (tt.identifier === joyTouch) joyEnd(); } };
canvas.addEventListener('touchend', touchDone); canvas.addEventListener('touchcancel', touchDone);
canvas.addEventListener('click', e => { if ((e as any).pointerType === 'touch' || matchMedia('(pointer:coarse)').matches) { if (nearHits.length || card.isOpen || viewer.isOpen) interact(); } });
// 地面のタップ/クリックで地名を調べる（視点操作のドラッグと区別: 5〜10px未満の移動・短時間のみ）
let mdX = 0, mdY = 0; canvas.addEventListener('mousedown', e => { mdX = e.clientX; mdY = e.clientY; });
canvas.addEventListener('click', e => { if (Math.hypot(e.clientX - mdX, e.clientY - mdY) < 5) tapAt(e.clientX, e.clientY); });
const tapStart = new Map<number, { x: number; y: number; t: number }>();
canvas.addEventListener('touchstart', e => { for (const tt of Array.from(e.changedTouches)) tapStart.set(tt.identifier, { x: tt.clientX, y: tt.clientY, t: performance.now() }); }, { passive: true });
canvas.addEventListener('touchend', e => { for (const tt of Array.from(e.changedTouches)) { const s0 = tapStart.get(tt.identifier); tapStart.delete(tt.identifier);
  if (s0 && Math.hypot(tt.clientX - s0.x, tt.clientY - s0.y) < 10 && performance.now() - s0.t < 500) tapAt(tt.clientX, tt.clientY); } });
canvas.addEventListener('touchcancel', e => { for (const tt of Array.from(e.changedTouches)) tapStart.delete(tt.identifier); });
// 宇宙への脱出（ジャンプ）と帰還は、このボタンだけで行う（キー操作・離陸モードは廃止）
const spaceBtn = new SpaceButton($('spacebtn') as HTMLButtonElement, () => { activity(); if (layer === 'walk') startSpace(); else if (layer === 'space') { if (sp) { sp.beginReturn(groundAt, EYE); hint.show('最寄りの地表へ戻ります…', false, 2500); } } else returnToSurface(); });
// 上昇/降下ボタン（タッチ端末の宇宙モード・弾道飛行中のみCSSで表示）。押している間だけ有効
const flightPad = (() => {
  const d = document.createElement('div'); d.id = 'flightpad'; d.setAttribute('role', 'group'); d.setAttribute('aria-label', '上昇・降下');
  d.innerHTML = '<button type="button" data-k="up" aria-label="上昇（遠ざかる）"><span>▲</span><small>上昇</small></button><button type="button" data-k="down" aria-label="降下（近づく・着地）"><span>▼</span><small>降下</small></button>';
  d.querySelectorAll('button').forEach(b => {
    const k = (b as HTMLElement).dataset.k as 'up' | 'down';
    const set = (v: boolean) => { pad[k] = v; b.classList.toggle('on', v); if (v) activity(); };
    b.addEventListener('pointerdown', e => { e.preventDefault(); try { (b as HTMLElement).setPointerCapture((e as PointerEvent).pointerId); } catch { /* ignore */ } set(true); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, () => set(false));
    b.addEventListener('contextmenu', e => e.preventDefault());
  });
  document.body.appendChild(d); return d;
})();
// モバイルのHUDは2行に省略表示。タップで全文を開閉（CSS: #hud.open）
$('hud').addEventListener('click', () => { $('hud').classList.toggle('open'); activity(); });
$('viewer').addEventListener('click', e => { if (e.target === $('viewer')) viewer.close(); });
$('b-sound').addEventListener('click', toggleSound); $('b-rec').addEventListener('click', recordNow); $('b-lib').addEventListener('click', openLibrary);
$('b-ev').addEventListener('click', () => { activity(); eventUi.openList(); });
$('b-map').addEventListener('click', () => { activity(); toggleAnnot(); }); $('b-places').addEventListener('click', () => { activity(); openPlaces(); });
function toggleSound() { const on = sound.toggle(); $('b-sound').classList.toggle('active', on); if (on) hint.show(t().sound_on, false, 4000); }
function recordNow() { exportSession(session); hint.show(t().rec_saved, false, 2500); }
// モード切替は一時廃止（setMode / changeMode は将来の再開用に残さず削除。mode は常に 1）

// ---------------- start-up
(async function main() {
  frameStart();
  try { await boot(); } catch (e) { Intro.line('データの読み込みに失敗しました: ' + String(e) + '（npm run precompute を実行しましたか？）'); return; }
  mode = 1;   // モード切替は一時廃止（説明の長さ等は常に標準）
  // callsign + landing
  let n = 0; try { n = +(localStorage.getItem('ryugu_cs') ?? (Math.floor(hash2(Date.now() % 100000, 1, 5) * 9000) + 1000)); localStorage.setItem('ryugu_cs', String(n)); } catch { n = 4242; }
  session.callsign = `HYB2-WALK-${String(n).padStart(4, '0')}`; const T = t(); const g0 = bodyToGeo(P.dir); const up0 = eyeUp(P.dir);
  P.fwd = v3.norm(v3.cross(up0, [1, 0, 0])); P.stand = groundAt(P.dir); Intro.line(T.callsign_fmt(session.callsign, 5)); await new Promise(r => setTimeout(r, 1400)); Intro.off();
  hint.show(matchMedia('(pointer:coarse)').matches ? T.hint_keys_touch : T.hint_keys, true, 20000); setTimeout(() => hint.show(T.m01, true, 10000), 20500);
  lastInput = performance.now(); window.setTimeout(welcome, 10000);
})();
/** 起動直後の入口: 10秒間は最小HUDだけを見せ、その後に2つの主導線だけを出す。 */
function welcome() {
  card.node.classList.add('welcome');
  card.show('どこから始めますか', `<p class="welcome-lede">2019-02-22 07:29 JST — タッチダウンの10分前</p>
    <div class="eva"><button id="w-td1" class="hot" type="button">▶ TD1を見る</button><button id="w-walk" type="button">地表を歩く</button></div>`, undefined);
  $('w-td1').addEventListener('click', () => { card.hide(); enterTd1(); }); $('w-walk').addEventListener('click', () => card.hide());
}
function frameStart() { requestAnimationFrame(frame); }
// debugging / acceptance hooks (read-only state)
(window as any).__ryugu = { get layer() { return layer; }, get orbit() { return orbit; }, get pois() { return world.pois.map((p: any) => p.id); }, get near() { return nearHits.map((h: any) => h.kind + ':' + h.id); }, get sunDir() { return terrain.mat?.uniforms?.sunDir?.value?.toArray?.() ?? null; }, get camPos() { return camera.position.toArray(); }, get camDir() { const t = new THREE.Vector3(); camera.getWorldDirection(t); return t.toArray(); }, setPast(on: boolean) { G = on ? G340 : G763; }, get past() { return G === G340; }, get patch() { return { half: terrain.patchHalf, lat: terrain.pLat, lon: terrain.pLon }; }, get mat() { const pm = (terrain as any).patchMat; return { useD: terrain.mat?.uniforms?.useD?.value, dmap: terrain.mat?.uniforms?.dmap?.value?.uuid ?? null, dmapImg: terrain.mat?.uniforms?.dmap?.value?.image?.width + 'x' + terrain.mat?.uniforms?.dmap?.value?.image?.height, useDpatch: pm?.uniforms?.useD?.value, dmapPatch: pm?.uniforms?.dmap?.value?.uuid ?? null, dmapPatchSame: pm?.uniforms?.dmap?.value === terrain.mat?.uniforms?.dmap?.value, patchVisible: terrain.patch?.visible, patchVerts: terrain.patch?.geometry?.getAttribute('position')?.count }; }, setD(on: boolean) { terrain.mat.uniforms.useD.value = on ? 1 : 0; (terrain as any).patchMat.uniforms.useD.value = on ? 1 : 0; }, setPatch(v: boolean) { terrain.patch.visible = v; }, setMesh(v: boolean) { terrain.mesh.visible = v; }, get events() { return events.map(e => e.id); }, get annot() { return annot ? { on: annotOn, n: annot.feats.length, visible: annot.visibleIds, guide: annot.guideIds, inside: annot.whereAmI(v3.norm(P.dir)).map(p => p.id) } : null; }, get clockMs() { return clock.ms; }, get minimap() { const mm: any = minimap; return { open: mm?.open, mesh: !!mm?.mesh, tex: !!mm?.mat?.uniforms?.map?.value, cam: mm ? mm.camera.position.toArray() : null, fc: mm?.frameCount, canvas: mm ? [renderer.domElement.clientWidth, renderer.domElement.clientHeight, renderer.domElement.width, renderer.domElement.height] : null, meshPos: mm?.mesh ? mm.mesh.position.toArray() : null, meshScale: mm?.mesh ? mm.mesh.scale.toArray() : null, bs: mm?.mesh ? (mm.mesh.geometry.boundingSphere ? [mm.mesh.geometry.boundingSphere.center.toArray(), mm.mesh.geometry.boundingSphere.radius] : null) : null, inScene: mm ? !!mm.scene : false, nKids: mm ? mm.scene.children.length : 0 }; } };
