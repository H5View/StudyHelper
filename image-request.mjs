export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

export function validateScreenshotRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createImageRequestError('A JSON screenshot request is required.');
  }

  const { image, mimeType } = body;
  if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') {
    throw createImageRequestError('Screenshot format must be JPEG or PNG.');
  }
  if (typeof image !== 'string' || image.length === 0 || image.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
    throw createImageRequestError('A valid base64 screenshot is required.');
  }

  const bytes = Buffer.from(image, 'base64');
  if (bytes.length === 0) {
    throw createImageRequestError('A valid base64 screenshot is required.');
  }
  if (bytes.length > MAX_SCREENSHOT_BYTES) {
    throw createImageRequestError(`Screenshot exceeds the ${MAX_SCREENSHOT_BYTES}-byte limit.`, 413);
  }

  const isJPEG = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPNG = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if ((mimeType === 'image/jpeg' && !isJPEG) || (mimeType === 'image/png' && !isPNG)) {
    throw createImageRequestError('Screenshot data does not match its declared format.');
  }

  return { image, mimeType, byteLength: bytes.length };
}

function createImageRequestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}
