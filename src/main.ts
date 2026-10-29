import { createApplication } from './bootstrap';
import { ConfigurationError, loadConfig } from './infrastructure/config/environment';
import { JsonLogger } from './infrastructure/observability/json-logger';

try {
  const config = loadConfig();
  const app = await createApplication(config);
  await app.listen(config.port, config.host);
} catch (error: unknown) {
  const logger = new JsonLogger();
  logger.write('error', error instanceof ConfigurationError ? error.message : 'application_start_failed');
  process.exitCode = 1;
}
