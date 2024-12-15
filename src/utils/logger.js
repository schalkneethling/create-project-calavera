/* Thanks goes to https://github.com/t3-oss/create-t3-app/blob/main/cli/src/utils/logger.ts */

import chalk from "chalk";

export const logger = {
  debug(...args) {
    console.info(chalk.white(...args));
  },
  error(...args) {
    console.info(chalk.red(...args));
  },
  warn(...args) {
    console.info(chalk.yellow(...args));
  },
  info(...args) {
    console.info(chalk.cyan(...args));
  },
  success(...args) {
    console.info(chalk.green(...args));
  },
};
