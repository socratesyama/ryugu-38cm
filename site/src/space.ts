// 宇宙モード（演出E）— 右上のスイッチで入り、リュウグウ上空200mまで上昇して静止。
//   Space: 遠ざかる / C: 近づく / WASD・矢印: 「中心からの距離」を半径とする球面上を周回
//   （タッチ端末は左スティックで周回、▲▼ボタンで上昇・降下。ドラッグは位置を動かさず視線だけを動かす＝main.ts側の見回し）
//   一定の高さ(30m)より近づくと重力に捕まり、自動で着地する。
// 操作を分かりやすくするための演出で、探査機の運動の再現ではない。ただし重力は実際の点質量GM/r²を使い、
// 本当は十数分かかる降下を「時間圧縮×60」で見せる（重力加速度を60²倍にして実時間で積分するのと等価）。
import { V3, v3 } from './geo';

export const SPACE_ALT = 200;       // 宇宙モードに入ったとき静止する、局所地表からの高度(m)
export const ASCEND_S = 6;          // 上昇にかける時間(s)
export const RETURN_S = 1.5;        // スイッチで最寄りの地表へ戻るときの時間(s)
export const CAPTURE_ALT = 30;      // これより低いと重力に捕まって自動着地(m)
export const TIME_COMPRESS = 60;    // 自動着地中の時間圧縮（演出E）
export const MAX_RAD = 30000;       // 中心からの最大距離(m)
const GRAV_BOOST = TIME_COMPRESS * TIME_COMPRESS;
const LAT_V = 20, RAD_V = 20;       // 高度200mでの横・縦の巡航速度(m/s)。高度に比例して速くなる（従来の微推力の約30倍）
const BRAKE_UP = 3.0;               // 捕獲圏内で逆噴射したときの加速度(m/s²)

export type SpacePhase = 'ascend' | 'free' | 'return';
/** x: 画面の右(+)/左(-)  y: 画面の上(+)/下(-)  各-1..1 */
export interface SpaceInput { x: number; y: number; out: boolean; inward: boolean; }

const ease = (s: number) => s <= 0 ? 0 : s >= 1 ? 1 : s * s * (3 - 2 * s);
const dease = (s: number) => s <= 0 || s >= 1 ? 0 : 6 * s * (1 - s);
function rot(p: V3, a: V3, th: number): V3 {   // axis(単位ベクトル)まわりに th 回す
  const c = Math.cos(th), s = Math.sin(th);
  return v3.add(v3.add(v3.mul(p, c), v3.mul(v3.cross(a, p), s)), v3.mul(a, v3.dot(a, p) * (1 - c)));
}

export class SpaceFlight {
  dir: V3;              // 中心から機体への単位ベクトル（天体固定系）
  up: V3;               // 画面の上方向（dirに垂直。球面移動のたびに一緒に回す＝極でも破綻しない）
  rad: number;          // 中心からの距離(m)
  vr = 0;               // 動径速度(m/s, 外向きが正)
  vLat = 0;             // 横方向の速さ(m/s, 表示用)
  phase: SpacePhase = 'ascend';
  captured = false;     // 重力に捕まっている（自動着地中）
  touch = 0;            // 着地した瞬間の速さ(m/s)
  fx: V3 | null = null; // 直近フレームの加速方向（噴射演出用）
  private wx = 0; private wy = 0; private t = 0; private r0: number; private r1: number;
  constructor(dir: V3, fwd: V3, rad0: number, ground: (d: V3) => number) {
    this.dir = v3.norm(dir);
    let u = v3.sub(fwd, v3.mul(this.dir, v3.dot(fwd, this.dir)));
    if (v3.len(u) < 0.5) u = v3.sub([0, 0, 1], v3.mul(this.dir, this.dir[2]));
    if (v3.len(u) < 0.5) u = v3.sub([1, 0, 0], v3.mul(this.dir, this.dir[0]));
    this.up = v3.norm(u);
    this.rad = rad0; this.r0 = rad0; this.r1 = ground(this.dir) + SPACE_ALT;
  }
  get speed() { return Math.hypot(this.vr, this.vLat); }
  /** 今いる場所の真下の地表へ RETURN_S 秒でゆっくり戻る（飛び立った位置ではない） */
  beginReturn(ground: (d: V3) => number, eye: number) {
    if (this.phase === 'return') return;
    this.phase = 'return'; this.t = 0; this.r0 = this.rad; this.r1 = ground(this.dir) + eye;
    this.wx = this.wy = 0; this.vr = 0; this.vLat = 0; this.captured = false;
  }
  private fixUp() { this.up = v3.norm(v3.sub(this.up, v3.mul(this.dir, v3.dot(this.up, this.dir)))); }
  /** dt秒進める。着地したら true（this.touch に着地速度）。ground=局所地表半径(m)、gm=GM、eye=目の高さ(m) */
  step(dt: number, inp: SpaceInput, ground: (d: V3) => number, gm: number, eye: number): boolean {
    this.fx = null; this.touch = 0;
    if (this.phase === 'ascend') {
      this.t += dt; const s = Math.min(1, this.t / ASCEND_S);
      this.rad = this.r0 + (this.r1 - this.r0) * ease(s); this.vr = (this.r1 - this.r0) * dease(s) / ASCEND_S; this.vLat = 0;
      this.fx = s < 0.5 ? this.dir : v3.mul(this.dir, -1);
      if (s >= 1) { this.phase = 'free'; this.vr = 0; this.fx = null; }
      return false;
    }
    if (this.phase === 'return') {
      this.t += dt; const s = Math.min(1, this.t / RETURN_S);
      this.rad = this.r0 + (this.r1 - this.r0) * ease(s); this.vr = (this.r1 - this.r0) * dease(s) / RETURN_S;
      this.fx = this.r1 < this.r0 ? v3.mul(this.dir, -1) : this.dir;
      if (s >= 1) { this.rad = this.r1; this.vr = 0; this.touch = 0.3; return true; }
      return false;
    }
    // ---- 自由飛行
    const alt0 = this.rad - ground(this.dir);
    let mx = inp.x, my = inp.y; const ml = Math.hypot(mx, my); if (ml > 1) { mx /= ml; my /= ml; }
    const a = 1 - Math.exp(-dt / 0.35); this.wx += (mx - this.wx) * a; this.wy += (my - this.wy) * a;
    const wl = Math.hypot(this.wx, this.wy); this.vLat = LAT_V * Math.max(0.1, alt0 / SPACE_ALT) * wl;
    if (wl > 1e-3) {
      const right = v3.cross(this.up, this.dir); const vt = v3.add(v3.mul(right, this.wx), v3.mul(this.up, this.wy));
      const axis = v3.norm(v3.cross(this.dir, vt)); const ang = this.vLat * dt / this.rad;
      this.dir = v3.norm(rot(this.dir, axis, ang)); this.up = rot(this.up, axis, ang); this.fixUp();
      if (wl > 0.2) this.fx = v3.norm(vt);
    }
    const alt = this.rad - ground(this.dir);
    if (alt < CAPTURE_ALT) {   // 重力に捕まる: 自動着地。Spaceの逆噴射でだけ脱出できる
      this.captured = true;
      const g = gm / (this.rad * this.rad) * GRAV_BOOST;
      this.vr += (-g + (inp.out ? BRAKE_UP : 0)) * dt;
      const lim = -(0.6 + 0.12 * Math.max(0, alt));   // 降下速度は高さに応じて頭打ち（地面では約0.6m/s）
      if (this.vr < lim) this.vr += (lim - this.vr) * (1 - Math.exp(-dt / 0.5));
      if (inp.out) this.fx = this.dir;
    } else {
      this.captured = false;
      const k = Math.max(1, alt / SPACE_ALT); const vOut = RAD_V * k, vIn = Math.min(RAD_V * k, 0.35 * alt);
      const target = (inp.out ? vOut : 0) - (inp.inward ? vIn : 0);
      this.vr += (target - this.vr) * (1 - Math.exp(-dt / 0.7));
      if (inp.out && !inp.inward) this.fx = this.dir; else if (inp.inward && !inp.out) this.fx = v3.mul(this.dir, -1);
    }
    this.rad += this.vr * dt;
    if (this.rad > MAX_RAD) { this.rad = MAX_RAD; this.vr = Math.min(0, this.vr); }
    if (this.rad <= ground(this.dir) + eye) { this.touch = Math.max(0, -this.vr); this.rad = ground(this.dir) + eye; this.vr = 0; return true; }
    return false;
  }
}
