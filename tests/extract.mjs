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
