// 投好标 PM2 生产配置示例（touhaobiao.cn）
// 必须先创建 /opt/touhaobiao/server/.env（参考 .env.production.example）。
// 任务锁/SSE/验证码/限流/配置缓存都是单进程内存态：必须单实例 fork，禁止 cluster 或 pm2 reload。
module.exports = {
  apps: [
    {
      name: 'touhaobiao',
      cwd: '/opt/touhaobiao/server',
      script: './node_modules/.bin/tsx',
      args: 'src/index.ts',
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '3000',
      },
      max_memory_restart: '2G',
      autorestart: true,
      kill_timeout: 10000,
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '/opt/touhaobiao/logs/server-out.log',
      error_file: '/opt/touhaobiao/logs/server-error.log',
      merge_logs: true,
    },
  ],
};
