// PM2 生产部署示例。安全相关环境变量（对应 .env.example 与 README 部署建议）：
//   NODE_ENV=production           —— 首启 seed 会生成随机管理员密码（不再使用 admin/admin）
//   ADMIN_INITIAL_PASSWORD=...    —— 可选：显式注入初始管理员密码，免翻日志
//   CORS_ORIGINS=...              —— 必配：前端来源白名单（逗号分隔），不配则放行任意 Origin
//   CONFIG_ENCRYPTION_KEY=...     —— 建议配：AI API Key 落库加密密钥（任意长随机字符串）
// 也可把这些变量写进 server/.env（dotenv 会加载，优先级：.env 先于进程 env 合并）。
module.exports = {
  apps: [
    {
      name: 'openbidkit-yibiao-web',
      cwd: '/opt/openbidkit-yibiao-web/server',
      script: './node_modules/.bin/tsx',
      args: 'src/index.ts',
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '3000',
        YIBIAO_DATA_DIR: '/opt/openbidkit-yibiao-web/data',
        // CORS_ORIGINS: 'https://yibiao.example.com',
        // CONFIG_ENCRYPTION_KEY: 'change-me-to-a-long-random-string',
        // ADMIN_INITIAL_PASSWORD: 'change-me-or-read-from-first-boot-log',
      },
      max_memory_restart: '2G',
      autorestart: true,
      time: true,
    },
  ],
};
