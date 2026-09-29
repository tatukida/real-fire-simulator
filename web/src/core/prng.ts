/**
 * シード付き PRNG（xoshiro128**）。Python リファレンス（pipeline/reference/prng.py）と同じ列を返す。
 *
 * 仕様（両言語で共通。変更するときは両方を同時に変え、ベクタを再生成すること）:
 *  - シード: 0〜2^32−1 の整数。splitmix32 を 4 回呼んで状態 s0..s3 を作る。
 *      splitmix32: x = (x + 0x9e3779b9) mod 2^32; z = x;
 *                  z = (z ^ (z >>> 16)) * 0x85ebca6b; z = (z ^ (z >>> 13)) * 0xc2b2ae35; z ^= z >>> 16
 *      （乗算は mod 2^32）。4 つとも 0 になった場合は s0 = 1 とする。
 *  - nextUint32: xoshiro128**（Blackman & Vigna）。
 *  - nextFloat: [0, 1) の 53 ビット精度。a = next() >>> 5, b = next() >>> 6 の順に引き、(a·2^26 + b) / 2^53。
 *  - nextInt(n): floor(nextFloat() · n)。0〜n−1。
 *  - nextNormal: Box–Muller（spec.md 7章 決定済み 5）。u1, u2 を nextFloat でこの順に引き、
 *      R = sqrt(−2 ln(1 − u1)), θ = 2π·u2, z0 = R·cos θ, z1 = R·sin θ。z0 を返し、次の呼び出しで z1 を返す。
 */

const U32 = 0x1_0000_0000;
const TWO_POW_26 = 67108864;
const TWO_POW_53 = 9007199254740992;

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export function splitmix32Sequence(seed: number, count: number): number[] {
  let x = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    z = (z ^ (z >>> 16)) >>> 0;
    out.push(z);
  }
  return out;
}

export class Xoshiro128 {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  private spareNormal: number | null = null;

  /** 状態を直接与える（既知ベクタの検証用）。通常は fromSeed を使う。 */
  constructor(state: readonly [number, number, number, number]) {
    [this.s0, this.s1, this.s2, this.s3] = state.map((v) => v >>> 0) as [number, number, number, number];
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  static fromSeed(seed: number): Xoshiro128 {
    if (!Number.isInteger(seed) || seed < 0 || seed >= U32) {
      throw new RangeError(`シードは 0〜${U32 - 1} の整数: ${seed}`);
    }
    const [a, b, c, d] = splitmix32Sequence(seed, 4) as [number, number, number, number];
    return new Xoshiro128([a, b, c, d]);
  }

  nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  nextFloat(): number {
    const a = this.nextUint32() >>> 5;
    const b = this.nextUint32() >>> 6;
    return (a * TWO_POW_26 + b) / TWO_POW_53;
  }

  nextInt(n: number): number {
    return Math.floor(this.nextFloat() * n);
  }

  nextNormal(): number {
    if (this.spareNormal !== null) {
      const z1 = this.spareNormal;
      this.spareNormal = null;
      return z1;
    }
    const u1 = this.nextFloat();
    const u2 = this.nextFloat();
    const r = Math.sqrt(-2 * Math.log(1 - u1));
    const theta = 2 * Math.PI * u2;
    this.spareNormal = r * Math.sin(theta);
    return r * Math.cos(theta);
  }
}
