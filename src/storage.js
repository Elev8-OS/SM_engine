import fs from 'node:fs/promises';
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

/** Upload a file and return a presigned GET URL (max 7 days, an S3 limit). */
export async function uploadFile(file, key, contentType) {
  const Body = await fs.readFile(file);
  await s3().send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body, ContentType: contentType }));
  const url = await getSignedUrl(s3(), new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }), { expiresIn: 7 * 24 * 3600 });
  return url;
}
