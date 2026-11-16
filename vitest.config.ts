import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // 默认跑 Node 环境；auth 的用例需要 window / localStorage / postMessage，
    // 在文件头用 `// @vitest-environment happy-dom` 单独切换。
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts']
    }
  }
});
