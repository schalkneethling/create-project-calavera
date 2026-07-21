import { styledValues } from "./text.js";

export const logger = {
  debug(...args) {
    console.info(...styledValues("white", args));
  },
  error(...args) {
    console.error(...styledValues("red", args));
  },
  warn(...args) {
    console.warn(...styledValues("yellow", args));
  },
  info(...args) {
    console.info(...styledValues("cyan", args));
  },
  success(...args) {
    console.info(...styledValues("green", args));
  },
};
