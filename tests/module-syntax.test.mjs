import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 抽取 index.html 中的某个 <script> 块。
 * @param {string} idAttr 形如 ' id="kinematics"'；传空串则匹配 <script type="module">
 */
function extractScript(html, openTagPattern) {
  const re = new RegExp(`<script ${openTagPattern}>([\\s\\S]*?)<\\/script>`);
  const m = html.match(re);
  assert.ok(m, `index.html 中找不到 <script ${openTagPattern}> 块`);
  return m[1];
}

/**
 * 全篇唯一检查「模块脚本能否通过解析」的测试。
 *
 * 为什么需要它：单测只抽取 <script id="kinematics"> 块，模块脚本的语法错误
 * 对它们完全不可见 —— 曾因此把 `Identifier 's' has already been declared`
 * 这类重名错误送进浏览器，页面直接白屏、__debug 未定义，而 npm test 依然是绿的。
 * 模块脚本 ~500 行且所有编辑都挤在同一个作用域里，重名是最容易犯的错。
 */
test('index.html 的模块脚本语法正确（能通过 node --check）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const src = extractScript(html, 'type="module"');

  const tmp = path.join(os.tmpdir(), `3dmoto-module-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(tmp, src, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (err) {
    const detail = (err.stderr || Buffer.from('')).toString().trim() || err.message;
    assert.fail('模块脚本存在语法错误：\n' + detail);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('模块脚本不含重复的顶层 const 声明', () => {
  // node --check 能抓到同一作用域内的重复 const，但只在同一块级作用域里。
  // 这条额外扫描函数体内的重复声明，给出更直白的报错。
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const src = extractScript(html, 'type="module"');

  // 按 `function name(...) {` … 行首 `}` 粗切函数体（本项目统一缩进，够用）
  const lines = src.split('\n');
  const bodies = [];
  let cur = null, depth = 0;
  for (const line of lines) {
    if (cur === null) {
      const m = line.match(/^\s*(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*\{/);
      if (m) { cur = { start: line.match(/\S/).index, lines: [line] }; depth = 1; }
    } else {
      cur.lines.push(line);
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (depth <= 0) { bodies.push(cur); cur = null; }
    }
  }

  const problems = [];
  for (const b of bodies) {
    const seen = new Map();
    for (const line of b.lines) {
      const m = line.match(/^(\s*)const\s+([A-Za-z_$][\w$]*)\s*=/);
      if (!m) continue;
      const depthKey = m[1].length;       // 同缩进视为同层，粗略但够用
      const key = depthKey + ':' + m[2];
      if (seen.has(key)) problems.push(`重复声明 const ${m[2]}`);
      seen.set(key, true);
    }
  }
  assert.deepEqual([...new Set(problems)], [], '同一函数内出现重复的 const 声明');
});
