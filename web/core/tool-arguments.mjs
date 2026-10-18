/** A caller can correct this request; retrying a source failure is different. */
export class ToolArgumentError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ToolArgumentError';
  }
}
