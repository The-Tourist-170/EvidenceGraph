/**
 * @extends {Error}
 */
export class AppError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, { code = "INTERNAL_ERROR", cause } = {}) {
    super(message, { cause });
    this.name = "AppError";
    this.code = code;
  }
}

export const logger = {
  info(message, fields = {}) {
    console.info(
      JSON.stringify({
        level: "info",
        message,
        ...fields,
        time: new Date().toISOString(),
      }),
    );
  },
  error(message, fields = {}) {
    console.error(
      JSON.stringify({
        level: "error",
        message,
        ...fields,
        time: new Date().toISOString(),
      }),
    );
  },
};
