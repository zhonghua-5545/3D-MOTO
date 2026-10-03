import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKIN } from './extract.mjs';

const KIN = loadKIN();
const { CONFIG, pistonPosition, crankPin, rodRotationZ,
        intakeLift, exhaustLift, strokeAt, cycleAngle, firingOrder, wrap720 } = KIN;
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

test('进气门升程峰值落在进气冲程中点 90°', () => {
  assert.equal(intakeLift(90), 1, '峰值必须在中点；若出现在 450° 附近说明相位基准错了 360°');
  assert.equal(intakeLift(0), Math.sin(Math.PI * 20 / 220), '上止点前 20° 已开启');
  assert.equal(intakeLift(200), 0, '下止点后 20° 关闭');
  assert.equal(intakeLift(300), 0);
});

test('排气门升程峰值落在排气冲程中点 630°', () => {
  assert.equal(exhaustLift(630), 1);
  assert.equal(exhaustLift(520), 0, '下止点前 20° 开启');
  assert.equal(exhaustLift(90), 0);
  assert.equal(exhaustLift(20), 0, '上止点后 20° 关闭（= 下一循环 740°）');
});

test('进排气门在 200°–520° 区间同时关闭', () => {
  for (let d = 200; d <= 520; d += 1) {
    assert.equal(intakeLift(d), 0, `进气门在 ${d}° 未关闭`);
    assert.equal(exhaustLift(d), 0, `排气门在 ${d}° 未关闭`);
  }
});

test('气门重叠角为 40°（整度采样计 39 个点）', () => {
  let overlap = 0;
  for (let d = 0; d < 720; d += 1) {
    if (intakeLift(d) > 0 && exhaustLift(d) > 0) overlap++;
  }
  // 重叠区间是开区间 (700°, 740°)，宽 40°；在 [0,720) 上按整度采样，
  // 落在 (700,720) ∪ [0,20) 共 19 + 20 = 39 个采样点。
  assert.equal(overlap, 39);
});

test('冲程判定边界正确且环绕', () => {
  assert.equal(strokeAt(0), '进气');
  assert.equal(strokeAt(179), '进气');
  assert.equal(strokeAt(180), '压缩');
  assert.equal(strokeAt(359), '压缩');
  assert.equal(strokeAt(360), '做功');
  assert.equal(strokeAt(539), '做功');
  assert.equal(strokeAt(540), '排气');
  assert.equal(strokeAt(719), '排气');
  assert.equal(strokeAt(720), '进气', '环绕回进气');
  assert.equal(strokeAt(-90), '排气', '负角环绕');
});

test('缸间相位衔接：1&4 同步、2&3 同步', () => {
  for (let d = 0; d < 720; d += 5) {
    const th = d * Math.PI / 180;
    const a = pistonPosition(th + CONFIG.phase[0] * Math.PI / 180);
    const b = pistonPosition(th + CONFIG.phase[3] * Math.PI / 180);
    const c = pistonPosition(th + CONFIG.phase[1] * Math.PI / 180);
    const e = pistonPosition(th + CONFIG.phase[2] * Math.PI / 180);
    assert.ok(Math.abs(a - b) < 1e-9, `θ=${d}° 缸1 与缸4 不同步`);
    assert.ok(Math.abs(c - e) < 1e-9, `θ=${d}° 缸2 与缸3 不同步`);
  }
});

test('点火顺序为 1-3-4-2', () => {
  assert.deepEqual(firingOrder(), [1, 3, 4, 2]);
});

test('点火间隔均匀为 180°', () => {
  const gaps = CONFIG.phase.map((p) => wrap720(360 - p)).sort((a, b) => a - b);
  const diffs = gaps.slice(1).map((v, i) => v - gaps[i]);
  assert.deepEqual(diffs, [180, 180, 180]);
});
