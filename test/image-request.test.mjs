import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_SCREENSHOT_BYTES, validateScreenshotRequest } from '../image-request.mjs';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString('base64');

test('image request accepts in-memory JPEG and PNG payloads', () => {
  assert.deepEqual(validateScreenshotRequest({ image: jpeg, mimeType: 'image/jpeg' }), {
    image: jpeg,
    mimeType: 'image/jpeg',
    byteLength: 4
  });
  assert.deepEqual(validateScreenshotRequest({ image: png, mimeType: 'image/png' }), {
    image: png,
    mimeType: 'image/png',
    byteLength: 9
  });
});

test('image request rejects invalid, mismatched, and oversized image data', () => {
  assert.throws(() => validateScreenshotRequest({ image: 'not base64', mimeType: 'image/jpeg' }), /valid base64/);
  assert.throws(() => validateScreenshotRequest({ image: png, mimeType: 'image/jpeg' }), /does not match/);
  assert.throws(() => validateScreenshotRequest({ image: jpeg, mimeType: 'image/gif' }), /JPEG or PNG/);

  const oversizedJPEG = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.alloc(MAX_SCREENSHOT_BYTES - 2)
  ]).toString('base64');
  assert.throws(
    () => validateScreenshotRequest({ image: oversizedJPEG, mimeType: 'image/jpeg' }),
    (error) => error.statusCode === 413 && /byte limit/.test(error.message)
  );
});
