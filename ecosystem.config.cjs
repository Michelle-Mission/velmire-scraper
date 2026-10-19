module.exports = {
  apps: [
    {
      name: "velmire-api",
      script: "dist/api/index.js",
      cwd: __dirname,
      env: { NODE_ENV: "production", LOG_LEVEL: "info" },
      max_memory_restart: "220M",
      autorestart: true,
    },
  ],
};
