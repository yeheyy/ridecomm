// PM2 process manager config — keeps RideComm running 24/7 on VPS
module.exports = {
  apps: [{
    name:        'ridecomm',
    script:      'server.js',
    instances:   1,
    autorestart: true,
    watch:       false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV:     'production',
      PORT_HTTP:    9000,
      PORT_HTTPS:   9443,
      TRUST_PROXY:  'true',
      NO_BUILTIN_SSL: 'true',  // let nginx/Caddy handle SSL
    },
    env_local: {
      NODE_ENV:       'development',
      PORT_HTTP:      9000,
      PORT_HTTPS:     9443,
      NO_BUILTIN_SSL: 'false', // use built-in SSL for local hotspot
    },
    error_file:  './logs/err.log',
    out_file:    './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
