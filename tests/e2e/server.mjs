process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.RADAR_SERVER_ENABLED = '0';
for (const key of [
  'DATABASE_URL',
  'DATABASE_PRIVATE_URL',
  'MAINTENANCE_API_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_CONTEXT_MODEL',
]) delete process.env[key];

await import('../../server.js');
