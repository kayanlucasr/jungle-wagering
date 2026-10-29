import { loadConfig } from './src/infrastructure/config/environment';
import { ormOptions } from './src/infrastructure/persistence/orm-options';

export default ormOptions(loadConfig());
