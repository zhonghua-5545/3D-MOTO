# 3D 汽车发动机运行动画 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个单文件 `index.html`，双击即在浏览器中呈现一台运转中的直列四缸四冲程发动机，半透明/剖切露出内部活塞、连杆、曲轴、气门的真实运动。

**Architecture:** 单文件 HTML，无构建步骤。运动学用纯函数实现，写在 `<script id="kinematics">` 独立块中（不依赖 DOM 与 Three.js）；该块既可被页面内模块脚本读取，又可被 Node 测试脚本从 HTML 源码中抽取求值——因此测试跑的是**真正交付的那份代码**，不存在副本漂移。Three.js 场景、几何构建、动画循环写在随后的 `<script type="module">` 中，全部姿态都是 `crankAngle` 的纯函数。

**Tech Stack:** Three.js 0.186.1（unpkg CDN + importmap）、原生 ES Module、`node --test`（Node 24，零依赖）。

**Spec:** `docs/superpowers/specs/2026-10-03-3d-engine-animation-design.md`

## Global Constraints

- **交付物必须是单个 `index.html`**，`file://` 双击可开。已实测：`file://` 页面内联 `<script type="module">` 从 unpkg 导入 Three.js + OrbitControls + CSS2DRenderer + RoomEnvironment 全部成功（`three=186, WebGL=true`）。
- **不得引入相对路径的本地 ES 模块**。`file://` 下 Chrome 会以 CORS 拦截 `./foo.js` 形式的导入（origin 为 `null`），但 CDN 的 HTTPS 导入（带 `Access-Control-Allow-Origin: *`）不受影响。这是「单文件」成为硬约束而非风格偏好的根本原因。
- Three.js 版本锁定 `0.186.1`，CDN 基址 `https://unpkg.com/three@0.186.1/`。
- **生产代码零 npm 依赖**；`package.json` 仅供 `node --test` 使用。
- 坐标约定（spec 第 6、7 节）：1 单位 = 1 cm；**Y = 气缸轴**；**Z = 曲轴轴**；曲轴主轴在 `y = 0`；第 i 缸缸心 `z = (i − 1.5) × boreSpacing`。
- 符号约定（spec 第 7.2 节）：曲柄销建在曲轴局部 `(0, +r)`，曲轴 `rotation.z = θ`，故世界坐标 `pin.x = −r·sinθ`。**此符号与旋转方向绑定，不可单独更改。**
- 相位数组（spec 第 8.2 节）：`phase = [360, 540, 180, 0]`（对应缸 1–4），点火顺序 **1-3-4-2**。
- 所有中文注释与 UI 文案使用简体中文。

## Review Focus

以下五类输入/失败模式是 spec 隐含要求、但没有任何一个任务的单元测试能覆盖的——它们最可能让使用者第一次打开就翻车。每条都在拥有该代码的任务里配了对应测试步骤。

1. **网络不可用**（断网、公司防火墙、CDN 被墙）：页面会是一块纯黑，使用者不知道发生了什么。期望：显示明确的中文提示，说明需要联网并给出本地化 Three.js 的操作指引。
2. **浏览器标签页切到后台再切回**：`requestAnimationFrame` 暂停期间累积的 `dt` 会达到数秒，恢复瞬间曲轴角度暴跳、活塞瞬移。期望：`dt` 上限钳制，画面从暂停处平滑继续。
3. **RPM 滑块拖到 0**：期望发动机静止而页面不报错、不产生除零或 NaN，恢复滑块后正常运转。
4. **半透明与剖切同时开启**：期望缸体正确露出内部，不出现内部零件被错误遮挡或缸体变成不透明色块。
5. **窗口尺寸变化（含拖到极窄）**：期望画面比例不失真、不拉伸，HUD 与标签仍可读。

---

### Task 1: 测试通道 + 活塞位移函数

建立「从 `index.html` 抽取运动学块并在 Node 中测试」的通道，并实现运动学地基 `pistonPosition`。

**Files:**
- Create: `package.json`
- Create: `tests/extract.mjs`
- Create: `tests/kinematics.test.mjs`
- Create: `index.html`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `tests/extract.mjs` 导出 `loadKIN(): object` —— 从 `index.html` 抽取 `<script id="kinematics">` 求值后返回 `KIN` 命名空间；抽取失败时抛出 `Error`。
  - `KIN.CONFIG` —— 见下方常量对象。
  - `KIN.pistonPosition(theta: number): number` —— 弧度入参，返回活塞销沿 Y 轴距曲轴中心的距离。

- [ ] **Step 1: 创建 `package.json`**

```json
{
  "name": "3d-moto",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/"
  }
}
```

无 `dependencies` / `devDependencies` —— 测试只用 Node 内置的 `node:test` 与 `node:assert`。

- [ ] **Step 2: 写抽取器 `tests/extract.mjs`**

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 从 index.html 抽取 <script id="kinematics"> 块的源码 */
export function extractKinematicsSource() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/<script id="kinematics">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('index.html 中找不到 <script id="kinematics"> 块');
  return m[1];
}

/** 在 Node 中求值运动学块，返回 KIN 命名空间 */
export function loadKIN() {
  const src = extractKinematicsSource();
  return new Function(`${src}\nreturn KIN;`)();
}
```

- [ ] **Step 3: 写失败的测试 `tests/kinematics.test.mjs`**

```js
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
```

- [ ] **Step 4: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL —— 报 `ENOENT` 找不到 `index.html`（文件尚未创建）。

- [ ] **Step 5: 创建 `index.html` 骨架与运动学块**

此刻只需最小骨架——后续任务会往里填 Three.js 场景。

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>直列四缸发动机 · 运行动画</title>
</head>
<body>
  <div id="app"></div>

  <!--
    运动学块：纯函数，不依赖 DOM 与 Three.js。
    被 Node 测试脚本从本文件源码中抽取求值，因此测试跑的就是交付的这份代码。
    切勿把 Three.js 或 DOM 相关代码放进这个块。
  -->
  <script id="kinematics">
const KIN = (() => {
  const DEG = Math.PI / 180;
  const CYCLE_DEG = 720;

  const CONFIG = {
    cylinders: 4,
    bore: 8.6,            // 缸径
    stroke: 8.6,          // 冲程
    crankRadius: 4.3,     // stroke / 2
    rodLength: 14.3,      // 连杆长度
    boreSpacing: 10.5,    // 缸心距
    pistonHeight: 5.0,
    pistonRadius: 4.25,   // bore/2 略减，留出缸壁间隙
    phase: [360, 540, 180, 0],       // 对应缸 1..4，度
    intake:  { open: 700, duration: 220 },
    exhaust: { open: 520, duration: 220 },
    maxLift: 0.8,
  };

  /** 角度归一到 [0, 720) */
  const wrap720 = (d) => ((d % CYCLE_DEG) + CYCLE_DEG) % CYCLE_DEG;

  /** 活塞销沿 Y 轴距曲轴中心的距离。θ=0 为上止点 */
  function pistonPosition(theta) {
    const r = CONFIG.crankRadius;
    const l = CONFIG.rodLength;
    const s = Math.sin(theta);
    return r * Math.cos(theta) + Math.sqrt(l * l - r * r * s * s);
  }

  return { DEG, CYCLE_DEG, CONFIG, wrap720, pistonPosition };
})();
  </script>
</body>
</html>
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `npm test`
Expected: PASS —— 4 个测试全绿。

- [ ] **Step 7: 用浏览器验证页面可打开**

用 Playwright 打开（MCP 工具限制了 `file:` 协议，需用 `browser_run_code_unsafe`）：

```js
async (page) => {
  await page.goto('file:///E:/demo/3D-moto/index.html', { waitUntil: 'load' });
  return await page.evaluate(() => ({
    title: document.title,
    hasKIN: typeof KIN !== 'undefined',
    tdc: KIN.pistonPosition(0),
  }));
}
```
Expected: `title` 为「直列四缸发动机 · 运行动画」，`hasKIN: true`，`tdc: 18.6`（= 4.3 + 14.3）。
控制台无报错。

- [ ] **Step 8: 提交**

```bash
git add package.json tests/extract.mjs tests/kinematics.test.mjs index.html
git commit -m "feat: 建立运动学测试通道与活塞位移函数

从 index.html 抽取 <script id=\"kinematics\"> 块在 Node 中求值，
测试直接跑交付的那份代码，避免副本漂移。实现活塞位移解析解并验证止点精度。"
```

---

### Task 2: 曲柄销位置与连杆姿态

实现曲柄销坐标与连杆摆角。**这是全篇符号约定最容易出错的地方**——spec 自审时就在这里抓到过 bug：曲柄销 X 符号与曲轴旋转方向必须自洽，否则活塞位置仍然正确（因为它只含 `cosθ` 与 `sin²θ`），但连杆会朝错误方向倾斜，肉眼很难第一眼发现。

**Files:**
- Modify: `index.html`（`<script id="kinematics">` 块）
- Modify: `tests/kinematics.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `KIN.CONFIG`、`KIN.DEG`
- Produces:
  - `KIN.crankPin(theta): { x: number, y: number }` —— 曲柄销在 XY 平面的位置，`θ=0` 时指向 +Y
  - `KIN.rodRotationZ(theta): number` —— 连杆绕 Z 轴的旋转角（弧度），连杆几何沿 +Y 建模、大头在 −Y 端

- [ ] **Step 1: 写失败的测试**

追加到 `tests/kinematics.test.mjs` 末尾：

```js
import { crankPin, rodRotationZ } from './extract.mjs';   // 改为顶部统一导入，见下方说明

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
```

**注意**：把文件顶部已有的 `const { CONFIG, pistonPosition } = KIN;` 改为
`const { CONFIG, pistonPosition, crankPin, rodRotationZ } = KIN;`，不要再写第二个 `import` 语句
（Node 的 ESM 导入必须在文件顶层，重复导入同一模块会报错）。

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL —— `crankPin is not a function`。

- [ ] **Step 3: 在运动学块中实现**

在 `index.html` 的 `pistonPosition` 函数之后插入：

```js
  /**
   * 曲柄销在 XY 平面的位置。
   * 约定：曲柄销建在曲轴局部 (0, +r)，曲轴 rotation.z = θ（逆时针）。
   * 因此绕 Z 逆时针旋转 θ 后，X 分量带负号。
   * 切勿改成 +r·sinθ —— 那会与曲轴旋转方向矛盾，导致连杆朝反侧倾斜。
   */
  function crankPin(theta) {
    const r = CONFIG.crankRadius;
    return { x: -r * Math.sin(theta), y: r * Math.cos(theta) };
  }

  /**
   * 连杆绕 Z 轴的旋转角。
   * 连杆几何沿 +Y 建模（小头在原点，大头在 −Y 端），装配到活塞销后旋转此角。
   * 推导：世界坐标大头→小头 = (−r·sinθ, +√(l²−r²sin²θ))；
   *       局部轴向 (0,+1) 旋转 α 得 (−sinα, cosα)，对应对上即可。
   */
  function rodRotationZ(theta) {
    const r = CONFIG.crankRadius;
    const l = CONFIG.rodLength;
    const s = Math.sin(theta);
    return Math.atan2(r * s, Math.sqrt(l * l - r * r * s * s));
  }
```

并把返回对象改为：

```js
  return { DEG, CYCLE_DEG, CONFIG, wrap720, pistonPosition, crankPin, rodRotationZ };
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test`
Expected: PASS —— 9 个测试全绿。

其中「连杆长度恒定」是关键不变量：它同时约束了 `pistonPosition`、`crankPin` 与符号约定三者是否自洽。若符号写反，这个测试会失败。

- [ ] **Step 5: 提交**

```bash
git add index.html tests/kinematics.test.mjs
git commit -m "feat: 曲柄销位置与连杆姿态

锁定曲柄销 X 负号与曲轴旋转方向的绑定关系，
并以「连杆长度在任意曲轴角下恒为 l」作为三者的自洽性不变量。"
```

---

### Task 3: 气门升程、冲程判定与四缸点火顺序

实现气门升程包络、冲程判定、缸间相位衔接。**这里是 spec 自审抓到第二个 bug 的地方**——升程公式的相位基准若错 360°，进气门会在做功冲程全开。

**Files:**
- Modify: `index.html`（`<script id="kinematics">` 块）
- Modify: `tests/kinematics.test.mjs`

**Interfaces:**
- Consumes: Task 1–2 的 `KIN.CONFIG`、`KIN.wrap720`、`KIN.pistonPosition`
- Produces:
  - `KIN.intakeLift(cycleDeg: number): number` —— 进气门升程，0–1
  - `KIN.exhaustLift(cycleDeg: number): number` —— 排气门升程，0–1
  - `KIN.strokeAt(cycleDeg: number): string` —— 返回 `'进气' | '压缩' | '做功' | '排气'`
  - `KIN.cycleAngle(crankDeg: number, index: number): number` —— 第 index 缸（0 起）的循环角
  - `KIN.firingOrder(): number[]` —— 返回 `[1, 3, 4, 2]`

- [ ] **Step 1: 写失败的测试**

顶部导入行改为：

```js
const { CONFIG, pistonPosition, crankPin, rodRotationZ,
        intakeLift, exhaustLift, strokeAt, cycleAngle, firingOrder, wrap720 } = KIN;
```

追加测试：

```js
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

test('气门重叠角恰为 40°', () => {
  let overlap = 0;
  for (let d = 0; d < 720; d += 1) {
    if (intakeLift(d) > 0 && exhaustLift(d) > 0) overlap++;
  }
  assert.equal(overlap, 41, '700°–740° 重叠 40°，闭区间逐一计数为 41 个采样点');
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL —— `intakeLift is not a function`。

- [ ] **Step 3: 在运动学块中实现**

在 `rodRotationZ` 之后插入：

```js
  /**
   * 气门升程包络（正弦半波，模拟凸轮）。
   * u 为开启窗口内的归一化进度；u ≤ 0 或 u ≥ 1 时精确返回 0，
   * 使「完全关闭」是精确的 0 而非 sin(π) ≈ 1.2e-16。
   */
  function lift(cycleDeg, window) {
    const u = wrap720(cycleDeg - window.open) / window.duration;
    if (u <= 0 || u >= 1) return 0;
    return Math.sin(Math.PI * u);
  }

  /** 进气门：700° 开（上止点前 20°），200° 关（下止点后 20°），峰值 90° */
  const intakeLift = (cycleDeg) => lift(cycleDeg, CONFIG.intake);

  /** 排气门：520° 开（下止点前 20°），740° 关（上止点后 20°），峰值 630° */
  const exhaustLift = (cycleDeg) => lift(cycleDeg, CONFIG.exhaust);

  const STROKES = ['进气', '压缩', '做功', '排气'];

  /** 由循环角判定所处冲程 */
  function strokeAt(cycleDeg) {
    return STROKES[Math.floor(wrap720(cycleDeg) / 180)];
  }

  /** 第 index 缸（0 起）在给定曲轴角下的循环角 */
  function cycleAngle(crankDeg, index) {
    return crankDeg + CONFIG.phase[index];
  }

  /** 由相位反推点火顺序：某缸点火时 crankAngle = 360° − phase_i */
  function firingOrder() {
    return CONFIG.phase
      .map((p, i) => ({ cyl: i + 1, at: wrap720(360 - p) }))
      .sort((a, b) => a.at - b.at)
      .map((f) => f.cyl);
  }
```

返回对象改为：

```js
  return { DEG, CYCLE_DEG, CONFIG, wrap720, pistonPosition, crankPin, rodRotationZ,
           intakeLift, exhaustLift, strokeAt, cycleAngle, firingOrder };
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test`
Expected: PASS —— 17 个测试全绿。

「气门重叠角恰为 40°」这条会同时抓住升程窗口写宽或写窄、以及开闭角度写反的问题。

- [ ] **Step 5: 提交**

```bash
git add index.html tests/kinematics.test.mjs
git commit -m "feat: 气门升程、冲程判定与四缸点火顺序

升程用正弦半波包络，关闭时精确归零。
点火顺序由相位反推验证为 1-3-4-2。"
```

---

### Task 4: 页面骨架与渲染管线

建立 DOM、样式、importmap、离线兜底，以及能渲染出画面的 Three.js 管线。此任务结束时页面上应出现一台**静止**的发动机（几何在 Task 5–6 填充，本任务先渲染一个占位立方体以打通管线）。

**Files:**
- Modify: `index.html`
- Create: `README.md`

**Interfaces:**
- Consumes: Task 1–3 的 `KIN.CONFIG`
- Produces:
  - DOM 元素 id：`#app`（WebGL 容器）、`#labels`（CSS2D 层）、`#hud`、`#panel`、`#boot-error`
  - `showBootError(message)` —— 全局函数，显示离线/加载失败提示
  - 模块脚本内的 `scene`、`camera`、`renderer`、`labelRenderer`、`controls`、`resize()`、`render()`

- [ ] **Step 1: 写离线兜底与样式**

把 `index.html` 的 `<head>` 扩充为（保留已有的 `<title>` 与 kinemaics 块不动）：

```html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>直列四缸发动机 · 运行动画</title>

<script type="importmap">
{
  "imports": {
    "three": "https://unpkg.com/three@0.186.1/build/three.module.js",
    "three/addons/": "https://unpkg.com/three@0.186.1/examples/jsm/"
  }
}
</script>

<style>
  :root {
    --bg: #0d1117;
    --fg: #e6edf3;
    --muted: #8b949e;
    --accent: #58a6ff;
    --panel: rgba(22, 27, 34, 0.88);
    --border: #30363d;
    --intake: #58a6ff;
    --compression: #d29922;
    --power: #f85149;
    --exhaust: #8b949e;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%; overflow: hidden;
    background: var(--bg); color: var(--fg);
    font: 13px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  }
  #app { position: fixed; inset: 0; }
  #labels { position: fixed; inset: 0; pointer-events: none; }
  #labels .label {
    padding: 2px 7px; border-radius: 4px;
    background: rgba(13, 17, 23, 0.82);
    border: 1px solid var(--border);
    color: var(--fg); font-size: 11px; white-space: nowrap;
    transform: translate(-50%, -50%);
  }
  #hud {
    position: fixed; top: 14px; left: 14px;
    display: flex; flex-direction: column; gap: 6px;
    pointer-events: none;
  }
  #hud .row {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 10px; border-radius: 6px;
    background: var(--panel); border: 1px solid var(--border);
    font-variant-numeric: tabular-nums;
  }
  #hud .row .cyl { color: var(--muted); }
  #hud .row .stroke { font-weight: 600; min-width: 3em; }
  #hud .crank { position: fixed; top: 14px; right: 14px;
    padding: 5px 10px; border-radius: 6px;
    background: var(--panel); border: 1px solid var(--border);
    font-variant-numeric: tabular-nums; }
  #panel {
    position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%);
    display: flex; flex-wrap: wrap; align-items: center; gap: 14px;
    padding: 10px 16px; border-radius: 10px;
    background: var(--panel); border: 1px solid var(--border);
    backdrop-filter: blur(6px); max-width: calc(100vw - 28px);
  }
  #panel label { display: flex; align-items: center; gap: 6px; color: var(--muted); }
  #panel .value { color: var(--fg); font-variant-numeric: tabular-nums; min-width: 4.5em; }
  #panel input[type="range"] { width: 130px; accent-color: var(--accent); }
  #panel button {
    padding: 5px 11px; border-radius: 6px; cursor: pointer;
    background: #21262d; color: var(--fg);
    border: 1px solid var(--border); font: inherit;
  }
  #panel button:hover { background: #30363d; border-color: #8b949e; }
  #panel button[aria-pressed="true"] {
    background: var(--accent); border-color: var(--accent); color: #0d1117;
  }
  #boot-error {
    position: fixed; inset: 0; display: flex; z-index: 10;
    align-items: center; justify-content: center;
    background: var(--bg);
  }
  #boot-error .box {
    max-width: 560px; padding: 26px 30px; border-radius: 12px;
    background: var(--panel); border: 1px solid var(--border);
  }
  #boot-error h1 { margin: 0 0 12px; font-size: 17px; color: #f85149; }
  #boot-error p { margin: 0 0 10px; }
  #boot-error code {
    display: block; padding: 9px 12px; border-radius: 6px; overflow-x: auto;
    background: #0d1117; border: 1px solid var(--border);
    color: var(--accent); font-family: Consolas, monospace; font-size: 12px;
  }
</style>
```

- [ ] **Step 2: 写 DOM 骨架与离线兜底脚本**

把 `<body>` 内容（`<script id="kinematics">` 块**保持原样保留**）改为：

```html
<body>
  <div id="app"></div>
  <div id="labels"></div>

  <div id="hud"></div>
  <div class="crank" id="crank-readout">曲轴角 0°</div>

  <div id="panel">
    <label>转速
      <input type="range" id="rpm" min="0" max="4000" step="50" value="900">
      <span class="value" id="rpm-value">900 RPM</span>
    </label>
    <button id="pause" aria-pressed="false">暂停</button>
    <button id="step">单步 +15°</button>
    <button id="cut" aria-pressed="true">剖切</button>
    <button id="ghost" aria-pressed="false">半透明</button>
    <button id="labels-toggle" aria-pressed="true">标签</button>
    <button id="reset">重置视角</button>
  </div>

  <div id="boot-error" hidden>
    <div class="box">
      <h1>无法加载 3D 引擎</h1>
      <p>本页需要从 CDN 加载 Three.js。请检查网络连接后刷新。</p>
      <p id="boot-error-detail"></p>
      <p>若需离线使用：下载 three 的 <code>three.module.js</code> 与 <code>examples/jsm/</code>
         到本文件同目录，并把 importmap 中的地址改为相对路径
         <code>./three/three.module.js</code>。</p>
      <p style="color:#8b949e;margin:0">注意：改成本地相对路径后必须通过 HTTP 服务器访问
         （如 <code>python -m http.server</code>），因为浏览器会以 CORS 拦截
         <code>file://</code> 下的本地模块导入。</p>
    </div>
  </div>

  <script>
    // 离线兜底：必须在模块脚本之前定义为普通脚本，模块脚本失败时才有得调用
    function showBootError(err) {
      const box = document.getElementById('boot-error');
      box.hidden = false;
      document.getElementById('boot-error-detail').textContent =
        (err && err.message) ? ('错误详情：' + err.message) : '';
    }
  </script>

  <!-- <script id="kinematics"> ... 保持 Task 1–3 的内容不变 ... </script> -->

  <script type="module">
    // 内容见下一步
  </script>
</body>
```

- [ ] **Step 3: 写模块脚本——带兜底的导入与渲染管线**

替换空的 `<script type="module">`：

```html
  <script type="module">
    let THREE, OrbitControls, CSS2DRenderer, CSS2DObject, RoomEnvironment;
    try {
      THREE = await import('three');
      ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
      ({ CSS2DRenderer, CSS2DObject } = await import('three/addons/renderers/CSS2DRenderer.js'));
      ({ RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js'));
    } catch (err) {
      showBootError(err);
      throw err;                       // 中止后续初始化，避免满屏级联报错
    }

    const { CONFIG, DEG } = KIN;       // 来自上方 <script id="kinematics"> 的全局词法绑定

    // ---------- 渲染器 ----------
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.localClippingEnabled = true;     // 剖切模式需要
    document.getElementById('app').appendChild(renderer.domElement);

    // ---------- CSS2D 标签层 ----------
    const labelRenderer = new CSS2DRenderer({ element: document.getElementById('labels') });
    labelRenderer.setSize(window.innerWidth, window.innerHeight);

    // ---------- 场景与相机 ----------
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1117);

    const camera = new THREE.PerspectiveCamera(
      42, window.innerWidth / window.innerHeight, 0.5, 400);
    const HOME_POS = new THREE.Vector3(34, 20, 34);
    const HOME_TARGET = new THREE.Vector3(0, 10, 0);
    camera.position.copy(HOME_POS);

    // ---------- 环境光照 ----------
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(24, 40, 26);
    scene.add(keyLight);
    scene.add(new THREE.AmbientLight(0xffffff, 0.28));

    // ---------- 控制器 ----------
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(HOME_TARGET);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 6;
    controls.maxDistance = 160;
    controls.update();

    // ---------- 调试接口 ----------
    // 模块作用域的绑定在 page.evaluate 与控制台里都不可见（模块作用域不是全局作用域），
    // 因此显式挂到 window 上，供端到端断言使用。后续任务会继续往里补字段。
    // 注意：KIN 不需要挂——它在传统 <script> 里以顶层 const 声明，本身就在全局词法环境中。
    window.__debug = { THREE, scene, camera, renderer, controls, KIN };

    // ---------- 尺寸自适应 ----------
    function resize() {
      const w = window.innerWidth, h = window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      labelRenderer.setSize(w, h);
    }
    window.addEventListener('resize', resize);

    // ---------- 临时内容：占位立方体，Task 5–6 会替换为发动机 ----------
    const placeholder = new THREE.Mesh(
      new THREE.BoxGeometry(10, 10, 10),
      new THREE.MeshStandardMaterial({ color: 0x58a6ff, metalness: 0.9, roughness: 0.25 })
    );
    placeholder.position.set(0, 10, 0);
    scene.add(placeholder);

    // ---------- 主循环 ----------
    function render() {
      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    }
    renderer.setAnimationLoop(render);
  </script>
```

- [ ] **Step 4: 在浏览器中验证管线打通**

用 Playwright 打开：

```js
async (page) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto('file:///E:/demo/3D-moto/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(4000);
  const dom = await page.evaluate(() => ({
    bootErrorVisible: !document.getElementById('boot-error').hidden,
    canvasCount: document.querySelectorAll('#app canvas').length,
    panelVisible: !!document.getElementById('panel'),
  }));
  return { errors, ...dom };
}
```
Expected: `errors: []`、`bootErrorVisible: false`、`canvasCount: 1`、`panelVisible: true`。

再截图确认能看到一个金属质感的立方体（而非全黑）。**全黑通常意味着环境贴图或光照没生效，或 WebGL 上下文创建失败。**

- [ ] **Step 5: 验证离线兜底确实会显示**

临时把 importmap 中 `three` 的地址改为一个不存在的域名（例如 `https://unpkg.invalid/...`），
刷新页面，确认出现红色标题「无法加载 3D 引擎」的错误面板而**不是黑屏**。
验证完**务必改回** `https://unpkg.com/three@0.186.1/`。

- [ ] **Step 6: 提交**

```bash
git add index.html
git commit -m "feat: 页面骨架、样式与 Three.js 渲染管线

打通 WebGL 渲染、CSS2D 标签层、环境光照与尺寸自适应，
并加入 CDN 加载失败时的离线提示（避免黑屏）。"
```

---

### Task 5: 零件几何构建器

实现各零件的纯几何构建函数。每个函数返回一个 `THREE.Object3D`，**不涉及运动学**——只负责「长什么样」和「局部原点在哪」。局部原点的选择是后续装配正确性的前提，每个函数都写明了约定。

**Files:**
- Modify: `index.html`（模块脚本）

**Interfaces:**
- Consumes: Task 4 的 `THREE`、`CONFIG`
- Produces（全部在模块脚本作用域内）：
  - `buildCrankshaft(): THREE.Group` —— 局部原点在曲轴轴心，主轴沿 Z。**调用方对其设 `rotation.z`**
  - `buildConnectingRod(): THREE.Group` —— **小头在原点，杆身沿 −Y 延伸至大头**，大头中心在 `(0, −rodLength, 0)`
  - `buildPiston(): THREE.Group` —— **活塞销中心在原点**，活塞体沿 Y 分布
  - `buildCylinderLiner(): THREE.Group` —— 局部原点在缸套底端中心，沿 +Y 向上；
    组上带 `userData.height` 供装配阶段定位缸盖
  - `buildCylinderHead(): THREE.Group` —— 缸盖，含进气门、排气门、火花塞，气门沿 −Y 开启；
    组上带 `userData.height`、`userData.intake`、`userData.exhaust`
  - `buildFlywheel(): THREE.Group` —— 局部原点在轮心，盘面垂直于 Z

- [ ] **Step 1: 写材质表**

在模块脚本的「渲染器」段之前插入。材质集中定义，便于 Task 8 统一切换剖切与半透明：

```js
    // ---------- 材质 ----------
    const MAT = {
      steel: new THREE.MeshStandardMaterial({ color: 0x9aa4b2, metalness: 0.95, roughness: 0.22 }),
      crank: new THREE.MeshStandardMaterial({ color: 0x6f7885, metalness: 0.95, roughness: 0.3 }),
      rod:   new THREE.MeshStandardMaterial({ color: 0xb8c0cc, metalness: 0.9,  roughness: 0.28 }),
      piston:new THREE.MeshStandardMaterial({ color: 0xd8dee9, metalness: 0.85, roughness: 0.38 }),
      ring:  new THREE.MeshStandardMaterial({ color: 0x2b3138, metalness: 0.8,  roughness: 0.5 }),
      valveIn:  new THREE.MeshStandardMaterial({ color: 0x4d9fe8, metalness: 0.9, roughness: 0.25 }),
      valveEx:  new THREE.MeshStandardMaterial({ color: 0xe0704d, metalness: 0.9, roughness: 0.25 }),
      plug:  new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.95, roughness: 0.3 }),
      // 缸体：半透明由 Task 8 控制 opacity/transparent
      glass: new THREE.MeshPhysicalMaterial({
        color: 0x7fa6d0, metalness: 0.0, roughness: 0.08,
        transparent: true, opacity: 0.14, side: THREE.DoubleSide,
        depthWrite: false, transmission: 0.0,
      }),
      head: new THREE.MeshStandardMaterial({ color: 0x59616d, metalness: 0.9, roughness: 0.35 }),
    };
```

- [ ] **Step 2: 写零件构建器**

在材质表之后插入：

```js
    const { bore, crankRadius, rodLength, boreSpacing,
            pistonHeight, pistonRadius } = CONFIG;

    /** 曲轴：主轴 + 每缸曲柄臂 + 曲柄销。局部原点在轴心，主轴沿 Z，曲柄销在 θ=0 时指向 +Y */
    function buildCrankshaft() {
      const g = new THREE.Group();
      const halfLen = (CONFIG.cylinders - 1) * boreSpacing / 2 + boreSpacing * 0.7;

      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(crankRadius * 0.42, crankRadius * 0.42, halfLen * 2, 28),
        MAT.crank);
      shaft.rotation.x = Math.PI / 2;                 // 圆柱默认沿 Y，转到沿 Z
      g.add(shaft);

      for (let i = 0; i < CONFIG.cylinders; i++) {
        const z = (i - (CONFIG.cylinders - 1) / 2) * boreSpacing;
        const ang = CONFIG.phase[i] * DEG;             // 各缸曲柄方向
        // 曲柄臂
        for (const dz of [-0.45, 0.45]) {
          const web = new THREE.Mesh(
            new THREE.BoxGeometry(crankRadius * 1.5, crankRadius * 2.1, 0.75), MAT.crank);
          web.position.set(0, 0, z + dz);
          web.rotation.z = ang;
          // 臂身从轴心伸向销，故把几何沿 +Y 偏移半个半径
          web.translateY(crankRadius * 0.5);
          g.add(web);
        }
        // 曲柄销：本缸相位角 ang 直接算进位置。
        // 曲轴 Group 再叠加 rotation.z = crankAngle 后，销的世界坐标为
        //   (−r·sin(ang + crankAngle), r·cos(ang + crankAngle))
        // 即 cycleAngle 对应的位置。
        // 注意：不可用 rotateOnWorldAxis —— 它只改朝向、不改位置，销会留在 (0, +r) 不动。
        const pin = new THREE.Mesh(
          new THREE.CylinderGeometry(crankRadius * 0.34, crankRadius * 0.34, 1.5, 20), MAT.crank);
        pin.rotation.x = Math.PI / 2;                    // 圆柱默认沿 Y，转到沿 Z
        pin.position.set(-crankRadius * Math.sin(ang), crankRadius * Math.cos(ang), z);
        g.add(pin);
      }
      return g;
    }

    /** 连杆：小头在原点，杆身沿 −Y 延伸到 (0, −rodLength, 0) 处的大头 */
    function buildConnectingRod() {
      const g = new THREE.Group();
      const rodW = crankRadius * 0.34;

      const beam = new THREE.Mesh(
        new THREE.BoxGeometry(rodW, rodLength, rodW * 1.25), MAT.rod);
      beam.position.y = -rodLength / 2;
      g.add(beam);

      const smallEnd = new THREE.Mesh(
        new THREE.TorusGeometry(crankRadius * 0.34, rodW * 0.34, 10, 22), MAT.rod);
      smallEnd.rotation.y = Math.PI / 2;               // 环面垂直于 Z，即销沿 Z
      g.add(smallEnd);

      const bigEnd = new THREE.Mesh(
        new THREE.TorusGeometry(crankRadius * 0.62, rodW * 0.4, 12, 26), MAT.rod);
      bigEnd.rotation.y = Math.PI / 2;
      bigEnd.position.y = -rodLength;
      g.add(bigEnd);

      return g;
    }

    /** 活塞：活塞销中心在原点 */
    function buildPiston() {
      const g = new THREE.Group();

      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(pistonRadius, pistonRadius, pistonHeight, 32), MAT.piston);
      body.position.y = pistonHeight * 0.18;           // 销略偏下，靠近裙部
      g.add(body);

      for (let k = 0; k < 3; k++) {
        const ring = new THREE.Mesh(
          new THREE.CylinderGeometry(pistonRadius * 1.015, pistonRadius * 1.015, 0.22, 32), MAT.ring);
        ring.position.y = pistonHeight * 0.18 + pistonHeight * 0.42 - k * 0.46;
        g.add(ring);
      }

      const wristPin = new THREE.Mesh(
        new THREE.CylinderGeometry(crankRadius * 0.3, crankRadius * 0.3,
                                   pistonRadius * 1.7, 20), MAT.steel);
      wristPin.rotation.x = Math.PI / 2;
      g.add(wristPin);

      return g;
    }

    /** 缸套：原点在底端中心，沿 +Y 向上 */
    function buildCylinderLiner() {
      const height = CONFIG.stroke + pistonHeight + crankRadius * 2.4;
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(bore / 2, bore / 2, height, 36, 1, true), MAT.glass);
      mesh.position.y = height / 2;
      const g = new THREE.Group();
      g.add(mesh);
      g.userData.height = height;
      return g;
    }
    ```

- [ ] **Step 3: 补完缸盖、气门、火花塞、飞轮**

接在上一步之后（`buildCylinderLiner` 之后）：

```js
    /** 缸盖：含两个气门与火花塞。气门几何沿 −Y 为「开启」方向 */
    function buildCylinderHead() {
      const g = new THREE.Group();
      const h = bore * 0.62;

      const shell = new THREE.Mesh(new THREE.BoxGeometry(bore * 1.5, h, bore * 1.5), MAT.head);
      shell.position.y = h / 2;
      g.add(shell);

      /** 单个气门：气门头在局部原点下方，杆沿 +Y 向上 */
      function makeValve(mat) {
        const v = new THREE.Group();
        const head = new THREE.Mesh(
          new THREE.CylinderGeometry(bore * 0.24, bore * 0.20, 0.3, 20), mat);
        v.add(head);
        const stem = new THREE.Mesh(
          new THREE.CylinderGeometry(0.16, 0.16, h * 0.95, 12), mat);
        stem.position.y = h * 0.48;
        v.add(stem);
        return v;
      }

      const intake = makeValve(MAT.valveIn);
      intake.position.set(-bore * 0.3, 0, -bore * 0.24);
      g.add(intake);

      const exhaust = makeValve(MAT.valveEx);
      exhaust.position.set(bore * 0.3, 0, bore * 0.24);
      g.add(exhaust);

      const plug = new THREE.Mesh(
        new THREE.CylinderGeometry(0.38, 0.28, h * 0.9, 14), MAT.plug);
      plug.position.y = h * 0.75;
      g.add(plug);

      g.userData.height = h;
      g.userData.intake = intake;
      g.userData.exhaust = exhaust;
      return g;
    }

    /** 飞轮：原点在轮心，盘面垂直于 Z */
    function buildFlywheel() {
      const g = new THREE.Group();
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(bore * 1.35, bore * 1.35, 0.9, 44), MAT.steel);
      disc.rotation.x = Math.PI / 2;
      g.add(disc);

      const teeth = new THREE.Mesh(
        new THREE.TorusGeometry(bore * 1.38, 0.26, 8, 60), MAT.crank);
      g.add(teeth);
      return g;
    }
```

- [ ] **Step 4: 临时装配验证几何不穿模**

把 Task 4 的占位立方体替换为一次**静态**装配——全部零件放在循环角 0° 的姿态：

```js
    // ---------- 临时静态装配（Task 6 会重构为正式装配） ----------
    const demoCrank = buildCrankshaft();
    scene.add(demoCrank);
    for (let i = 0; i < CONFIG.cylinders; i++) {
      const z = (i - (CONFIG.cylinders - 1) / 2) * boreSpacing;
      const s = KIN.pistonPosition(KIN.cycleAngle(0, i) * DEG);
      const piston = buildPiston();   piston.position.set(0, s, z);  scene.add(piston);
      const rod = buildConnectingRod();
      rod.position.set(0, s, z);
      rod.rotation.z = KIN.rodRotationZ(KIN.cycleAngle(0, i) * DEG);
      scene.add(rod);
      const liner = buildCylinderLiner(); liner.position.set(0, 0, z); scene.add(liner);
      const head = buildCylinderHead();
      head.position.set(0, liner.userData.height, z);                  scene.add(head);
    }
    scene.add(buildFlywheel());
```

- [ ] **Step 5: 浏览器中验证几何正确**

用 Playwright 打开并截图。逐项确认：

```js
async (page) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file:///E:/demo/3D-moto/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(4000);
  return { errors, meshes: await page.evaluate(() => {
    let n = 0; window.__debug.scene.traverse((o) => { if (o.isMesh) n++; }); return n;
  }) };
}
```
Expected: `errors: []`，`meshes` 约 90–120（4 缸 × 约 20 个零件 + 曲轴 + 飞轮）。

截图检查：
- 四个活塞**两两同高**（1&4 一组、2&3 一组）——这是相位 `[360,540,180,0]` 的直接体现
- 连杆两端分别落在曲柄销与活塞销上，**没有悬空或穿出**
- 缸套把活塞包住，长度足够、活塞在任何姿态都不露出顶端

- [ ] **Step 6: 提交**

```bash
git add index.html
git commit -m "feat: 发动机零件几何构建器

曲轴、连杆、活塞、缸套、缸盖（含气门与火花塞）、飞轮。
各构建器的局部原点约定已在注释中写明，供装配阶段依赖。"
```

---

### Task 6: 整机装配与运动学驱动

把零件构建器组装成一台完整的、由 `crankAngle` 驱动的发动机。装配函数返回引用表，供动画循环与 HUD 使用。

**Files:**
- Modify: `index.html`（模块脚本）

**Interfaces:**
- Consumes: Task 5 的全部构建器、Task 1–3 的 `KIN`
- Produces:
  - `buildEngine(): { root, crankshaft, flywheel, units }`，其中 `units` 为长度 = 缸数的数组，
    每个元素 `{ index, z, piston, rod, liner, head, intake, exhaust }`
  - `applyPose(engine, crankDeg): void` —— 把整机姿态设为给定曲轴角，**纯函数式**（不累积状态）
  - `engine` —— 模块级单例

- [ ] **Step 1: 写装配函数**

删除 Task 5 的临时静态装配段，替换为：

```js
    /**
     * 组装整机。返回引用表供动画循环使用。
     * 曲轴单独持有一个 Group 并以 rotation.z 驱动，保证各缸曲柄销刚性一致。
     */
    function buildEngine() {
      const root = new THREE.Group();
      const crankshaft = buildCrankshaft();
      root.add(crankshaft);

      const flywheel = buildFlywheel();
      flywheel.position.z = -((CONFIG.cylinders - 1) * boreSpacing / 2 + boreSpacing * 0.7);
      root.add(flywheel);

      const units = [];
      for (let i = 0; i < CONFIG.cylinders; i++) {
        const z = (i - (CONFIG.cylinders - 1) / 2) * boreSpacing;

        const liner = buildCylinderLiner();
        liner.position.set(0, 0, z);
        root.add(liner);

        // 缸盖坐在缸套顶端
        const head = buildCylinderHead();
        head.position.set(0, liner.userData.height, z);
        root.add(head);

        const piston = buildPiston();
        root.add(piston);

        const rod = buildConnectingRod();
        root.add(rod);

        units.push({
          index: i, z, piston, rod, liner, head,
          intake: head.userData.intake,
          exhaust: head.userData.exhaust,
        });
      }
      return { root, crankshaft, flywheel, units };
    }

    const engine = buildEngine();
    scene.add(engine.root);

    /**
     * 把整机姿态设为给定曲轴角（度）。
     * 全部输出都是 crankDeg 的纯函数——无累积状态，
     * 因此暂停、单步、任意跳转得到的姿态完全一致。
     */
    function applyPose(eng, crankDeg) {
      eng.crankshaft.rotation.z = crankDeg * DEG;
      eng.flywheel.rotation.z = crankDeg * DEG;

      for (const u of eng.units) {
        const cyc = KIN.cycleAngle(crankDeg, u.index);   // 度
        const th = cyc * DEG;

        const s = KIN.pistonPosition(th);
        u.piston.position.set(0, s, u.z);
        u.rod.position.set(0, s, u.z);
        u.rod.rotation.z = KIN.rodRotationZ(th);

        // 气门沿 −Y 开启
        u.intake.position.y = u.head.position.y - KIN.intakeLift(cyc) * CONFIG.maxLift;
        u.exhaust.position.y = u.head.position.y - KIN.exhaustLift(cyc) * CONFIG.maxLift;
      }
    }

    applyPose(engine, 0);

    Object.assign(window.__debug, { engine, applyPose, buildEngine });
```

- [ ] **Step 2: 写动画循环**

把 Task 4 的 `render()` 替换为：

```js
    // ---------- 状态 ----------
    const state = {
      crankDeg: 0,
      rpm: 900,
      paused: false,
      dtClamp: 0.1,      // 秒。标签页切回时防止角度暴跳
    };

    const clock = new THREE.Clock();

    Object.assign(window.__debug, { state, clock });

    function advance(dtSec) {
      if (state.paused || state.rpm <= 0) return;
      const degPerSec = state.rpm * 6;            // 1 RPM = 6 °/s
      const next = state.crankDeg + degPerSec * dtSec;
      state.crankDeg = ((next % KIN.CYCLE_DEG) + KIN.CYCLE_DEG) % KIN.CYCLE_DEG;
    }

    function render() {
      // 上限钳制：标签页切到后台再切回时 getDelta 可能返回数秒
      const dt = Math.min(clock.getDelta(), state.dtClamp);
      advance(dt);
      applyPose(engine, state.crankDeg);
      updateHud();
      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    }

    // updateHud 在 Task 9 实现；先占位以免本任务报错
    function updateHud() {}
    ```

- [ ] **Step 3: 浏览器中验证运动**

```js
async (page) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file:///E:/demo/3D-moto/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(2000);
  const sample = () => page.evaluate(() =>
    window.__debug.engine.units.map((u) => u.piston.position.y));
  const a = await sample();
  await page.waitForTimeout(1500);
  const b = await sample();
  return { errors, before: a, after: b, moved: a.some((v, i) => Math.abs(v - b[i]) > 1e-3) };
}
```
Expected: `errors: []`、`moved: true`。

再验证 `applyPose` 的纯函数性质——同一角度重复施加应得到完全相同姿态：

```js
async (page) => {
  return await page.evaluate(() => {
    const { engine, applyPose } = window.__debug;
    applyPose(engine, 137);
    const first = engine.units.map((u) => u.piston.position.y);
    applyPose(engine, 500);
    applyPose(engine, 137);
    const second = engine.units.map((u) => u.piston.position.y);
    return { identical: first.every((v, i) => v === second[i]) };
  });
}
```
Expected: `identical: true`。**这条很重要**：它保证单步与时间轴跳转不会漂移。

- [ ] **Step 4: 验证 dt 钳制（Review Focus #2）**

```js
async (page) => {
  await page.goto('file:///E:/demo/3D-moto/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  // 模拟标签页切后台：把 clock 的旧时间戳推到 30 秒前，
  // 下一帧 getDelta() 将返回约 30 —— 若无钳制，crankDeg 会瞬跳数万度
  await page.evaluate(() => { window.__debug.clock.oldTime = performance.now() - 30000; });
  const before = await page.evaluate(() => window.__debug.state.crankDeg);
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => window.__debug.state.crankDeg);
  const rpm = await page.evaluate(() => window.__debug.state.rpm);
  return { before, after, jumped: after - before, limit: 0.1 * rpm * 6 };
}
```
Expected: `jumped` 不超过 `limit`（默认 900 RPM 时为 540°）。**若观察到数千度以上的跳跃，说明钳制没生效。**

- [ ] **Step 5: 提交**

```bash
git add index.html
git commit -m "feat: 整机装配与运动学驱动

曲轴单独持有 Group 以 rotation.z 驱动，保证各缸曲柄销刚性一致。
姿态全部是曲轴角的纯函数，暂停/单步/跳转不会产生漂移。"
```

---

### Task 7: 剖切与半透明（Review Focus #4）

实现两条独立的观察路径。**这是最容易出渲染瑕疵的地方**——半透明体与剖切面叠加时容易出现深度排序错乱。

**Files:**
- Modify: `index.html`（模块脚本）

**Interfaces:**
- Consumes: Task 5 的 `MAT.glass`、`MAT.head`；Task 6 的 `engine`
- Produces:
  - `setCut(enabled: boolean): void` —— 切换剖切
  - `setGhost(enabled: boolean): void` —— 切换半透明
  - `cutPlane` —— `THREE.Plane` 实例

- [ ] **Step 1: 实现剖切与半透明**

在 `applyPose` 之后插入：

```js
    // ---------- 剖切与半透明 ----------
    // 沿 X 方向的平面，切掉靠观察者一侧的缸壁
    const cutPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), bore * 0.30);

    const CLIP_NONE = [];
    const CLIP_CUT = [cutPlane];

    let cutOn = true;
    let ghostOn = false;

    /**
     * 四个缸共用同一批材质实例，所以直接改材质即可，无需逐网格遍历。
     * 只有缸套与缸盖外壳需要被剖切/透明化；气门、火花塞保持自身材质不透明。
     */
    function refreshShellMaterials() {
      MAT.glass.clippingPlanes = cutOn ? CLIP_CUT : CLIP_NONE;
      MAT.glass.transparent = true;
      MAT.glass.opacity = ghostOn ? 0.5 : 0.14;
      MAT.glass.depthWrite = false;        // 半透明体不写深度，避免内部零件被错误遮挡
      MAT.glass.needsUpdate = true;

      MAT.head.clippingPlanes = cutOn ? CLIP_CUT : CLIP_NONE;
      MAT.head.transparent = ghostOn;
      MAT.head.opacity = ghostOn ? 0.35 : 1;
      MAT.head.depthWrite = !ghostOn;      // 恢复完全不透明时必须重新写深度
      MAT.head.needsUpdate = true;

      renderer.localClippingEnabled = cutOn;
    }

    function setCut(enabled) { cutOn = enabled; refreshShellMaterials(); }
    function setGhost(enabled) { ghostOn = enabled; refreshShellMaterials(); }

    refreshShellMaterials();

    Object.assign(window.__debug, { setCut, setGhost, cutPlane, MAT });
```

- [ ] **Step 2: 接线到按钮**

在 `render` 之后、`setAnimationLoop` 之前插入。**注意**：Task 4 的这些按钮此刻才有行为。

```js
    const $ = (id) => document.getElementById(id);

    $('cut').addEventListener('click', (e) => {
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(on));
      setCut(on);
    });

    $('ghost').addEventListener('click', (e) => {
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(on));
      setGhost(on);
    });
```

- [ ] **Step 3: 浏览器中验证（Review Focus #4）**

```js
async (page) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file:///E:/demo/3D-moto/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const combos = await page.evaluate(() => {
    const { engine, setCut, setGhost } = window.__debug;
    const out = [];
    for (const cut of [true, false]) {
      for (const ghost of [true, false]) {
        setCut(cut); setGhost(ghost);
        const liner = engine.units[0].liner.children.find((o) => o.isMesh);
        const head  = engine.units[0].head.children.find((o) => o.isMesh);
        out.push({
          cut, ghost,
          linerClips: liner.material.clippingPlanes.length,
          linerTransparent: liner.material.transparent,
          headClips: head.material.clippingPlanes.length,
          headOpaqueWhenNoGhost: ghost ? null : head.material.opacity === 1,
        });
      }
    }
    setCut(true); setGhost(false);
    return out;
  });
  return { errors, combos };
}
```
Expected: `errors: []`；`linerClips` 在 `cut:true` 时为 1、`cut:false` 时为 0；`headOpaqueWhenNoGhost` 恒为 `true`（关闭半透明时缸盖必须恢复完全不透明，否则会看到内部结构错乱叠影）。

截图逐一看四种组合：剖切开启时应能看到缸套被切开、露出里面的活塞与连杆；半透明开启时缸体应呈玻璃质感而内部零件清晰可辨。

- [ ] **Step 4: 提交**

```bash
git add index.html
git commit -m "feat: 剖切与半透明两条观察路径

剖切用 clipping plane，半透明用透明度。
半透明体关闭 depthWrite 以避免内部零件被错误遮挡。"
```

---

### Task 8: 交互控制（Review Focus #3）

接线转速滑块、暂停、单步、重置视角。

**Files:**
- Modify: `index.html`（模块脚本）

**Interfaces:**
- Consumes: Task 6 的 `state`、`applyPose`、`engine`；Task 4 的 `camera`、`controls`、`HOME_POS`、`HOME_TARGET`
- Produces: `setPaused(v: boolean): void`、`stepBy(deg: number): void`、`resetView(): void`

- [ ] **Step 1: 实现控制逻辑**

在剖切接线之后插入：

```js
    function setPaused(v) {
      state.paused = v;
      $('pause').textContent = v ? '播放' : '暂停';
      $('pause').setAttribute('aria-pressed', String(v));
    }

    function stepBy(deg) {
      setPaused(true);
      state.crankDeg = ((state.crankDeg + deg) % KIN.CYCLE_DEG + KIN.CYCLE_DEG) % KIN.CYCLE_DEG;
      applyPose(engine, state.crankDeg);
      updateHud();
    }

    function resetView() {
      camera.position.copy(HOME_POS);
      controls.target.copy(HOME_TARGET);
      controls.update();
    }

    $('rpm').addEventListener('input', (e) => {
      // RPM = 0 是合法输入：等价于静止，不得产生除零或 NaN
      state.rpm = Number(e.target.value) || 0;
      $('rpm-value').textContent = `${state.rpm} RPM`;
    });

    $('pause').addEventListener('click', () => setPaused(!state.paused));
    $('step').addEventListener('click', () => stepBy(15));
    $('reset').addEventListener('click', resetView);

    $('labels-toggle').addEventListener('click', (e) => {
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(on));
      document.getElementById('labels').style.display = on ? '' : 'none';
    });

    // 空格键暂停/播放
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat) { e.preventDefault(); setPaused(!state.paused); }
    });

    Object.assign(window.__debug, { setPaused, stepBy, resetView });
```

- [ ] **Step 2: 浏览器中验证 RPM = 0（Review Focus #3）**

```js
async (page) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file:///E:/demo/3D-moto/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  const setRpm = (v) => page.evaluate((val) => {
    const el = document.getElementById('rpm');
    el.value = String(val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
  const crank = () => page.evaluate(() => window.__debug.state.crankDeg);

  await setRpm(0);                       // 拖到 0
  await page.waitForTimeout(300);
  const atZero = await crank();
  await page.waitForTimeout(900);
  const stillZero = await crank();

  await setRpm(2000);                    // 恢复
  await page.waitForTimeout(600);
  const resumed = await crank();

  const nan = await page.evaluate(() =>
    window.__debug.engine.units.some((u) => !Number.isFinite(u.piston.position.y)));

  return { errors, frozen: atZero === stillZero, resumed: resumed !== stillZero, nan };
}
```
Expected: `errors: []`、`frozen: true`、`resumed: true`、`nan: false`。

- [ ] **Step 3: 验证暂停与单步**

```js
async (page) => {
  await page.goto('file:///E:/demo/3D-moto/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  document.getElementById('pause').click();
  const p0 = await page.evaluate(() => window.__debug.engine.units[0].piston.position.y);
  await page.waitForTimeout(700);
  const p1 = await page.evaluate(() => window.__debug.engine.units[0].piston.position.y);
  document.getElementById('step').click();
  const after = await page.evaluate(() => {
    const { engine, state } = window.__debug;
    const p2 = engine.units[0].piston.position.y;
    const expected = KIN.pistonPosition(KIN.cycleAngle(state.crankDeg, 0) * Math.PI / 180);
    return { p2, expected };
  });
  return { paused: p0 === p1, stepped: after.p2 !== p1,
           posMatchesKinematics: Math.abs(after.p2 - after.expected) < 1e-9 };
}
```
Expected: 三项全 `true`。第三项确认渲染姿态与运动学函数严格一致。

- [ ] **Step 4: 提交**

```bash
git add index.html
git commit -m "feat: 交互控制

转速滑块、暂停/播放、单步、重置视角、标签开关、空格快捷键。
RPM=0 与暂停均不产生除零或 NaN。"
```

---

### Task 9: HUD 与 3D 标签

**Files:**
- Modify: `index.html`（模块脚本）

**Interfaces:**
- Consumes: Task 6 的 `engine`、`state`；Task 4 的 `CSS2DObject`
- Produces: `updateHud(): void`（替换 Task 6 的同名占位函数）、`buildLabels(engine): void`

- [ ] **Step 1: 建 HUD**

把 Task 6 的 `function updateHud() {}` 占位替换为：

```js
    const STROKE_COLOR = { '进气': '#58a6ff', '压缩': '#d29922', '做功': '#f85149', '排气': '#8b949e' };

    const hudRows = engine.units.map((u) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="cyl">缸 ${u.index + 1}</span>
                       <span class="stroke"></span>
                       <span class="angle"></span>`;
      document.getElementById('hud').appendChild(row);
      return { stroke: row.querySelector('.stroke'), angle: row.querySelector('.angle') };
    });

    function updateHud() {
      for (const u of engine.units) {
        const cyc = KIN.cycleAngle(state.crankDeg, u.index);
        const name = KIN.strokeAt(cyc);
        const r = hudRows[u.index];
        r.stroke.textContent = name;
        r.stroke.style.color = STROKE_COLOR[name];
        r.angle.textContent = `${Math.round(KIN.wrap720(cyc))}°`;
      }
      document.getElementById('crank-readout').textContent =
        `曲轴角 ${Math.round(state.crankDeg)}°`;
    }
```

- [ ] **Step 2: 建 3D 标签**

在 `updateHud` 之后插入：

```js
    function buildLabels(eng) {
      /** 在指定局部位置挂一个 CSS2D 标签 */
      function tag(parent, text, pos) {
        const el = document.createElement('div');
        el.className = 'label';
        el.textContent = text;
        const obj = new CSS2DObject(el);
        obj.position.copy(pos);
        parent.add(obj);
        return obj;
      }

      // 曲轴与飞轮
      tag(eng.crankshaft, '曲轴', new THREE.Vector3(0, -CONFIG.crankRadius * 2.4, 0));
      tag(eng.flywheel, '飞轮', new THREE.Vector3(0, CONFIG.bore * 1.5, 0));

      // 只在第一缸标注内部零件，避免四组标签互相压叠
      const u0 = eng.units[0];
      tag(u0.piston, '活塞', new THREE.Vector3(0, CONFIG.pistonHeight * 0.6, 0));
      tag(u0.rod, '连杆', new THREE.Vector3(0, -CONFIG.rodLength * 0.5, 0));
      tag(u0.intake, '进气门', new THREE.Vector3(0, 0.8, 0));
      tag(u0.exhaust, '排气门', new THREE.Vector3(0, 0.8, 0));
    }

    buildLabels(engine);
```

- [ ] **Step 3: 浏览器中验证**

```js
async (page) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file:///E:/demo/3D-moto/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const dom = await page.evaluate(() => ({
    hudRows: document.querySelectorAll('#hud .row').length,
    hudText: [...document.querySelectorAll('#hud .row')].map((r) => r.textContent.trim()),
    crankReadout: document.getElementById('crank-readout').textContent,
    labelCount: document.querySelectorAll('#labels .label').length,
  }));
  return { errors, ...dom };
}
```
Expected: `errors: []`、`hudRows: 4`、`labelCount: 6`（曲轴、飞轮、活塞、连杆、进气门、排气门各一）。

HUD 文本应形如「缸 1 进气 20°」。**逐缸核对冲程互补性**：任意时刻四缸的冲程应恰好是进气/压缩/做功/排气各一个（这是四冲程四缸的必然结果，相位算错时会出现两个缸同冲程）。

- [ ] **Step 4: 验证标签开关**

点击 `#labels-toggle`，确认 `#labels` 的 `display` 变为 `none`，再点回来恢复。

- [ ] **Step 5: 提交**

```bash
git add index.html
git commit -m "feat: HUD 冲程指示与 3D 部件标签

HUD 实时显示各缸所处冲程与循环角，冲程按四色区分。
部件标签用 CSS2DRenderer，可整体开关。"
```

---

### Task 10: 端到端验收与 README

**Files:**
- Modify: `index.html`
- Create: `README.md`

- [ ] **Step 1: 全量单元测试**

Run: `npm test`
Expected: PASS —— 17 个测试全绿。若有任何一项失败，**先修再继续**。

- [ ] **Step 2: 端到端浏览器验收**

```js
async (page) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto('file:///E:/demo/3D-moto/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  const pageFacts = await page.evaluate(() => {
    const { engine, state, scene } = window.__debug;
    let meshes = 0;
    scene.traverse((o) => { if (o.isMesh) meshes++; });
    return {
      bootErrorHidden: document.getElementById('boot-error').hidden,
      meshes,
      tdcExact: Math.abs(KIN.pistonPosition(0)
                - (KIN.CONFIG.crankRadius + KIN.CONFIG.rodLength)) < 1e-12,
      firingOrder: KIN.firingOrder(),
      strokes: engine.units.map((u) => KIN.strokeAt(KIN.cycleAngle(state.crankDeg, u.index))),
    };
  });
  return { errors, ...pageFacts };
}
```
Expected: `errors: []`、`bootErrorHidden: true`、`tdcExact: true`、`firingOrder: [1,3,4,2]`、
`strokes` 为四个**互不相同**的冲程。

- [ ] **Step 3: 逐个复查 Review Focus 五项**

| # | 复查内容 | 通过标准 |
|---|---|---|
| 1 | 把 importmap 指向无效域名后刷新 | 出现「无法加载 3D 引擎」面板，非黑屏。**验完改回** |
| 2 | 模拟切后台（`clock.oldTime` 回推 30s） | 单帧推进不超过 540°，无瞬移 |
| 3 | RPM 拖到 0 再拉回 | 静止无报错，恢复后正常运转，无 NaN |
| 4 | 剖切与半透明四种组合 | 无叠影错乱，缸盖在关闭半透明时恢复完全不透明 |
| 5 | 窗口从 1920×1080 拖到 420×700 | 画面不变形，HUD 与面板仍可读 |

- [ ] **Step 4: 写 `README.md`**

````markdown
# 3D 汽车发动机运行动画

一台运转中的直列四缸四冲程汽油发动机，浏览器中实时呈现内部活塞、连杆、
曲轴与气门的运动。半透明或剖切后可看清缸内工作过程。

## 使用

双击 `index.html` 即可。无需安装、无需构建。

> 需要联网 —— Three.js 从 CDN 加载。断网时会显示明确提示而非黑屏。

## 交互

| 操作 | 说明 |
|---|---|
| 左键拖拽 / 滚轮 / 右键拖拽 | 旋转 / 缩放 / 平移视角 |
| 转速滑块 | 0–4000 RPM |
| 暂停 / 空格 | 停止或恢复曲轴旋转 |
| 单步 +15° | 暂停状态下逐帧推进，便于观察单个冲程 |
| 剖切 | 切开缸壁露出内部 |
| 半透明 | 缸体转为玻璃质感 |
| 标签 | 开关部件名称标注 |
| 重置视角 | 相机回到默认机位 |

## 技术要点

- **运动学是解析解，不是近似**：活塞位移
  `s(θ) = r·cos θ + √(l² − r²sin²θ)`，连杆摆角
  `φ = atan2(r·sin θ, √(l² − r²sin²θ))`。
  参数取真实尺寸：缸径冲程均为 86mm，连杆 143mm，`r/l ≈ 0.30`。
- **姿态是曲轴角的纯函数**，无累积状态。因此暂停、单步、任意跳转得到的
  姿态完全一致，不会有积分漂移。
- **四缸相位** `[360°, 540°, 180°, 0°]`，点火顺序 1-3-4-2，每 180° 点火一次。
- 运动学代码写在 `index.html` 的 `<script id="kinematics">` 块中，被测试脚本
  从 HTML 源码里抽取求值 —— **测试跑的就是交付的那份代码**。

## 开发

```bash
npm test     # 运行运动学单元测试（Node 内置测试器，零依赖）
```

生产代码没有任何 npm 依赖；`package.json` 只用于跑测试。

## 目录

```
index.html                              唯一交付物
tests/                                  运动学单元测试
docs/superpowers/specs/                 设计文档
docs/superpowers/plans/                 实现计划
```
````

- [ ] **Step 5: 提交**

```bash
git add index.html README.md
git commit -m "docs: README 与端到端验收

补充使用说明、交互表与技术要点，完成五项边界情况复查。"
```

---

## 完成标准

全部任务完成后应满足：

- [ ] `npm test` 17 项全绿
- [ ] 双击 `index.html` 能打开并看到运转中的发动机
- [ ] 四缸活塞两两同步（1&4、2&3），动作此起彼伏
- [ ] 连杆两端始终分别咬合在曲柄销与活塞销上，无穿模
- [ ] 剖切与半透明均可正常观察内部
- [ ] HUD 显示四缸冲程且任一时刻互不相同
- [ ] Review Focus 五项全部通过
