module.exports = {
  apps: [
    {
      name: "polymaker",
      script: "dist/index.cjs",
      cwd: "/home/polymaker/app",
      env: {
        NODE_ENV: "production",
        PORT: 5000,
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      restart_delay: 5000,
      max_restarts: 10,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "/var/log/polymaker/error.log",
      out_file: "/var/log/polymaker/out.log",
      merge_logs: true,
    },
  ],
};
