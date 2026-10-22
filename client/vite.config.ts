import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// dev 预览营销首页：/landing 直出仓库根 landing/index.html。
// 生产环境中该页面由 nginx 在域名根（/）提供，与应用（/app）分离——见 deploy/nginx 示例。
// 这里只为本地开发提供预览入口，不参与构建产物。
function devLandingPreview(): Plugin {
  const landingFile = path.resolve(fileURLToPath(new URL('../landing/index.html', import.meta.url)));
  return {
    name: 'dev-landing-preview',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/landing', (req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (url === '/' || url === '' || url === '/index.html') {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          fs.createReadStream(landingFile).pipe(res);
          return;
        }
        next();
      });
    },
  };
}

// dev 修 .md 帮助文档乱码：vite 对 public 下的 .md 回 text/markdown 且不带 charset，
// 中文 Windows 浏览器按 GBK 猜编码即乱码。这里拦下 /docs/*.md，以 text/plain;charset=utf-8 直出。
function devDocsCharset(): Plugin {
  const publicRoot = path.resolve(fileURLToPath(new URL('./public', import.meta.url)));
  return {
    name: 'dev-docs-charset',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url || '').split('?')[0]);
        if (!url.startsWith('/docs/') || !/\.md$/i.test(url)) return next();
        const relative = path.normalize(url).replace(/^([.][.][/\\])+/, '');
        const filePath = path.join(publicRoot, relative);
        if (!filePath.startsWith(publicRoot)) return next();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        fs.createReadStream(filePath).pipe(res);
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  base: './',
  // 生产构建固定走同源 /api：部署由 Nginx 反代。
  // 不能依赖构建机环境变量——CI/代理环境可能注入本地路径，曾导致生产包把
  // VITE_API_BASE_URL 编译成 Windows 绝对路径，登录验证码请求全部发错地址。
  define:
    command === 'build'
      ? { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') }
      : undefined,
  plugins: [react(), devLandingPreview(), devDocsCharset()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // 编辑器/工具做原子写入时会在源码目录留下临时文件与临时目录；watch 到被锁定的临时文件
    // 会让 dev server 直接抛 EBUSY 退出。忽略掉这些中间产物。
    watch: { ignored: ['**/*.tmpdir/**', '**/*.tmp'] },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // 拆 vendor 便于缓存：业务页已按路由 lazy，vendor 单独成块后
    // 发版只让业务 chunk 失效，React/Radix/TanStack 等长缓存。
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-radix': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-popover',
            '@radix-ui/react-switch',
            '@radix-ui/react-toast',
            '@radix-ui/react-tooltip',
          ],
          'vendor-query': ['@tanstack/react-query'],
          'vendor-markdown': ['markdown-it', 'markdown-it-cjk-friendly', 'markdown-it-task-lists'],
        },
      },
    },
  },
}));
