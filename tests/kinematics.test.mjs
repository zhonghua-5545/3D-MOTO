import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKIN } from './extract.mjs';

const KIN = loadKIN();
const { CONFIG, pistonPosition, crankPin, rodRotationZ } = KIN;
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

test('曲柄销：θ=90° 时位于 −X 侧，与 rotation.z = θ 约定自洽', () => {
  const p = crankPin(Math.PI / 2);
  assert.ok(p.x < 0, `期望 x < 0，实际 ${p.x}。符号写反会使连杆朝错误方向倾斜`);
  assert.ok(Math.abs(p.y) < 1e-12, `期望 y = 0，实际 ${p.y}`);
  assert.ok(Math.abs(p.x + R) < 1e-12, `期望 x = ${-R}，实际 ${p.x}`);
});

test('曲柄销：θ=0 时指向 +Y 且距轴心 r', () => {
  const p = crankPin(0);
  assert.ok(Math.abs(p.x) < 1e-12);
  assert.ok(Math.abs(p.y - R) < 1e-12);
});

test('连杆长度在任意曲轴角下恒定等于 l', () => {
  for (let i = 0; i < 1000; i++) {
    const th = Math.random() * Math.PI * 2;
    const s = pistonPosition(th);
    const p = crankPin(th);
    const dist = Math.hypot(p.x - 0, p.y - s);
    assert.ok(Math.abs(dist - L) < 1e-9, `θ=${th} 处连杆长度 ${dist} 偏离 ${L}`);
  }
});

test('连杆姿态：θ=0 竖直，θ=90° 倾斜 +asin(r/l)', () => {
  assert.ok(Math.abs(rodRotationZ(0)) < 1e-12, `期望 0，实际 ${rodRotationZ(0)}`);
  const expected = Math.asin(R / L);
  assert.ok(Math.abs(rodRotationZ(Math.PI / 2) - expected) < 1e-12,
    `期望 ${expected}，实际 ${rodRotationZ(Math.PI / 2)}`);
});

test('连杆姿态：θ=270° 倾斜 −asin(r/l)（镜像侧）', () => {
  const expected = -Math.asin(R / L);
  assert.ok(Math.abs(rodRotationZ(3 * Math.PI / 2) - expected) < 1e-12);
});
