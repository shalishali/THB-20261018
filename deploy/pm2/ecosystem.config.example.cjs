// PM2 生产部署示例。安全相关环境变量（对应 .env.example 与 README 部署建议）：
//   NODE_ENV=production           —— 首启 seed 会生成随机管理员密码（不再使用 admin/admin）
//   ADMIN_INITIAL_PASSWORD=...    —— 可选：显式注入初始管理员密码，免翻日志
//   CORS_ORIGINS=...              —— 必配：前端来源白名单（逗号分隔），不配则拒绝启动
//   CONFIG_ENCRYPTION_KEY=...     —— 必配：AI API Key 落库加密密钥（任意长随机字符串），不配则拒绝启动
// 也可把这些变量写进 server/.env（dotenv 会加载，优先级：.env 先于进程 env 合并）。
module.exports = {
  apps: [
    {
      name: 'openbidkit-yibiao-web',
      cwd: '/opt/openbidkit-yibiao-web/server',
      script: './node_modules/.bin/tsx',
      args: 'src/index.ts',
      interpreter: 'none',
      // 任务锁/SSE/验证码/限流/配置缓存都是进程内内存态：必须单实例 fork，禁止 cluster 或 pm2 reload。
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '3000',
        YIBIAO_DATA_DIR: '/opt/openbidkit-yibiao-web/data',
        // CORS_ORIGINS: 'https://yibiao.example.com',
        // CONFIG_ENCRYPTION_KEY: 'generate-with-openssl-rand-hex-32',
        // ADMIN_INITIAL_PASSWORD: 'change-me-or-read-from-first-boot-log',
      },
      max_memory_restart: '2G',
      autorestart: true,
      time: true,
    },
  ],
};
