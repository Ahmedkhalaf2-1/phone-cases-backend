/**
 * PM2 process for the production backend on the VPS.
 *   pm2 start ecosystem.config.js        # first time
 *   ./deploy-backend.sh                  # every deploy after that
 *
 * Exactly ONE instance in fork mode, on purpose: the scheduled jobs
 * (order expiry sweeps, receipt cleanup) are not safe to run more than once
 * concurrently - see docs/DEPLOYMENT.md. Do not switch to cluster mode.
 * Listening address/port come from .env (PORT); Caddy/nginx proxies to it.
 */
module.exports = {
  apps: [
    {
      name: "contrast-backend",
      cwd: __dirname,
      script: "dist/main.js",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
