export class FileWriteError extends Error {
  constructor(message, options) {
    super(message);
    this.name = "FileWriteError";

    if (options) {
      this.cause = options.cause;
    }

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, FileWriteError);
    }
  }
}
