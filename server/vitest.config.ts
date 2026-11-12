import { defineConfig } from 'vitest/config';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = path.join(tmpdir(), `restream-test-${process.pid}`);

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://restream:restream@127.0.0.1:5432/restream_test',
      APP_KEY: '0'.repeat(64),
      UPDATER_ENABLED: 'true',
      UPDATE_REQUEST_DIR: path.join(tmp, 'req'),
      UPDATE_STATUS_DIR: path.join(tmp, 'status'),
      WEB_DIST: path.join(tmp, 'no-web'),
      DATA_DIR: path.join(tmp, 'data'),
      ENV_FILE: path.join(tmp, 'restream.env'),
      WEBHOOKS_ALLOW_LOOPBACK: 'true',
    },
  },
});
