export class MediaError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
