module.exports = {
  apps: [{
    name: 'mundo-porras',
    script: 'server.js',
    watch: ['server.js', 'database.js', 'public'],
    ignore_watch: ['node_modules', '*.db', '*.db-shm', '*.db-wal', '.pm2'],
    watch_options: {
      followSymlinks: false,
    },
    env: {
      SESSION_SECRET: '1ceICwGMHc+NVrq54G1KTXtBgaJxO+YYkzkEqOFbNFjS6hk7TCu3aVfydLrR5EuN',
    },
  }],
};
