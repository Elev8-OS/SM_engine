import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export function storageEnabled() {
  return Boolean(process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
}

let client;
function s3() {
  if (!client) {
    client = new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
    });
  }
  return client;
}

const LOCAL_DIR = path.resolve('out/store');

/** Store a file and return its key. Without S3 (local tests only) it is copied to out/store. */
export async function putFile(file, key, contentType) {
  if (!storageEnabled()) {
    const target = path.join(LOCAL_DIR, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(file, target);
    return key;
  }
  const Body = await fs.readFile(file);
  await s3().send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body, ContentType: contentType }));
  return key;
}

/** Presigned GET URL for a stored key (max 7 days, an S3 limit). */
export async function presign(key, expiresIn = 7 * 24 * 3600) {
  if (!storageEnabled()) return `file://${path.join(LOCAL_DIR, key)}`;
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }), { expiresIn });
}

/** Upload a file and return a presigned GET URL. */
export async function uploadFile(file, key, contentType) {
  await putFile(file, key, contentType);
  return presign(key);
}
