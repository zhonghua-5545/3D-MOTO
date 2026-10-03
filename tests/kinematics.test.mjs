import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKIN } from './extract.mjs';

const KIN = loadKIN();
const { CONFIG, pistonPosition } = KIN;
const R = CONFIG.crankRadius;
const L = CONFIG.rodLength;

test('上止点：θ = 0 时活塞销位于 r + l', () => {
  assert.ok(Math.abs(pistonPosition(0) - (R + L)) < 1e-12,
    `期望 ${R + L}，实际 ${pistonPosition(0)}`);
});

test('下止点：θ = 180° 时活塞销位于 l − r', () => {
  assert.ok(Math.abs(pistonPosition(Math.PI) - (L - R)) < 1e-12,
    `期望 ${L - R}，实际 ${pistonPosition(Math.PI)}`);
});

test('活塞位移对 360° 周期对称', () => {
  for (let d = 0; d < 360; d += 7) {
    const a = pistonPosition(d * Math.PI / 180);
    const b = pistonPosition((d + 360) * Math.PI / 180);
    assert.ok(Math.abs(a - b) < 1e-9, `θ=${d}° 与 θ=${d + 360}° 位移不一致`);
  }
});

test('活塞始终在气缸物理行程范围内', () => {
  for (let d = 0; d < 720; d += 3) {
    const s = pistonPosition(d * Math.PI / 180);
    assert.ok(s >= L - R - 1e-9 && s <= L + R + 1e-9, `θ=${d}° 位移 ${s} 越界`);
  }
});
