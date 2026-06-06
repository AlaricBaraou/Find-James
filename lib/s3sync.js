'use strict';

// Optional S3-compatible durability mirror (Fly Tigris, or any S3 bucket).
// The local volume is the working copy; this keeps an off-box durable copy and
// restores it when the volume is empty (new machine / hardware loss / region move).
//
// Enabled automatically when BUCKET_NAME + AWS credentials are present.

const fs = require('fs');
const path = require('path');

let client = null;
let Bucket = null;
let S3 = null;

function enabled() {
  return Boolean(client);
}

function init() {
  if (!process.env.BUCKET_NAME || !process.env.AWS_ACCESS_KEY_ID) return false;
  try {
    S3 = require('@aws-sdk/client-s3');
  } catch (e) {
    console.error('s3sync: @aws-sdk/client-s3 missing:', e.message);
    return false;
  }
  Bucket = process.env.BUCKET_NAME;
  client = new S3.S3Client({
    region: process.env.AWS_REGION || 'auto',
    endpoint: process.env.AWS_ENDPOINT_URL_S3 || undefined,
    forcePathStyle: false,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  console.log('s3sync: enabled (bucket ' + Bucket + ')');
  return true;
}

async function putBuffer(key, buf) {
  if (!client) return;
  await client.send(new S3.PutObjectCommand({ Bucket, Key: key, Body: buf }));
}

async function putFile(key, absPath) {
  if (!client) return;
  if (!fs.existsSync(absPath)) return;
  await client.send(new S3.PutObjectCommand({ Bucket, Key: key, Body: fs.readFileSync(absPath) }));
}

async function del(key) {
  if (!client) return;
  try {
    await client.send(new S3.DeleteObjectCommand({ Bucket, Key: key }));
  } catch (_) {
    /* already gone */
  }
}

async function getToFile(key, absPath) {
  if (!client) return false;
  const out = await client.send(new S3.GetObjectCommand({ Bucket, Key: key }));
  const body = Buffer.from(await out.Body.transformToByteArray());
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, body);
  return true;
}

// Pull every object into destDir, preserving key paths. Used when the local
// volume is empty. Returns the number of objects restored.
async function restoreAll(destDir) {
  if (!client) return 0;
  let count = 0;
  let token;
  do {
    const out = await client.send(new S3.ListObjectsV2Command({ Bucket, ContinuationToken: token }));
    for (const obj of out.Contents || []) {
      await getToFile(obj.Key, path.join(destDir, obj.Key));
      count++;
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return count;
}

module.exports = { init, enabled, putBuffer, putFile, del, getToFile, restoreAll };
