// VERSION 文件是发版本的唯一事实来源（与 Go SDK 保持一致）。
// package.json 的 version 只是它的投影：release.yml 会用 VERSION 覆盖它。
// 这个脚本防止两者漂移——漂移意味着「tag 发的是 A 版本、npm 上装的是 B 版本」。
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const base = new URL('../', import.meta.url);
const version = readFileSync(new URL('VERSION', base), 'utf8').trim();
const pkg = JSON.parse(readFileSync(new URL('package.json', base), 'utf8'));

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

if (!SEMVER.test(version)) {
  console.error('❌ VERSION 不是合法的语义化版本：' + JSON.stringify(version));
  process.exit(1);
}

if (pkg.version !== version) {
  console.error(
    `❌ 版本不一致：VERSION=${version}，package.json=${pkg.version}\n` +
      '   把 package.json 的 version 改成与 VERSION 一致（发布时 release.yml 会自动同步）。'
  );
  process.exit(1);
}

console.log(`✅ 版本一致：${version}`);
