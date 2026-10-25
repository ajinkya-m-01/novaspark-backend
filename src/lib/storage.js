import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { supabase } from '../supabase.js';
import { checked, fail } from './user-panel.js';
export const kycBucket = config.SUPABASE_STORAGE_BUCKET_KYC;
export const supportBucket = config.SUPABASE_STORAGE_BUCKET_SUPPORT;
export const kycUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 3, fields: 7, fieldSize: 5000 }, fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png', ...(file.fieldname === 'selfie' ? [] : ['application/pdf'])].includes(file.mimetype)) }).fields([{ name: 'documentFront', maxCount: 1 }, { name: 'documentBack', maxCount: 1 }, { name: 'selfie', maxCount: 1 }]);
export const supportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 3, fields: 4, fieldSize: 10000 } }).fields([{ name: 'attachments', maxCount: 3 }, { name: 'attachments[]', maxCount: 3 }]);
export async function upload(bucket, prefix, file, label) {
  if (!file || !file.size) fail(400, 'Required file is missing or empty');
  // Use detected signatures for identity documents, not a client supplied MIME type alone.
  if (bucket === kycBucket) {
    const b = file.buffer;
    const valid = file.mimetype === 'image/jpeg' ? b[0] === 255 && b[1] === 216 && b[2] === 255 : file.mimetype === 'image/png' ? b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : b.subarray(0, 5).toString() === '%PDF-';
    if (!valid) fail(400, 'File contents do not match the declared document type');
  }
  const filename = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'attachment';
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' }[file.mimetype];
  const path = `${prefix}/${label ? `${label}-${Date.now()}-${randomUUID()}.${ext}` : `${randomUUID()}-${filename}`}`;
  checked(await supabase.storage.from(bucket).upload(path, file.buffer, { contentType: file.mimetype, upsert: false }));
  return { name: filename, url: path, size: file.size };
}
export async function cleanup(bucket, paths) {
  if (!paths.length) return;
  const { error } = await supabase.storage.from(bucket).remove(paths);
  if (error) console.error('Storage cleanup failed:', error.message);
}
export async function signedAttachments(attachments = []) {
  return Promise.all(attachments.map(async attachment => {
    const { data } = checked(await supabase.storage.from(supportBucket).createSignedUrl(attachment.url, 300, { download: attachment.name }));
    return { ...attachment, url: data.signedUrl };
  }));
}
export async function ensureStorageBuckets() {
  for (const [id, size, types] of [[kycBucket, 8 * 1024 * 1024, ['image/jpeg','image/png','application/pdf']], [supportBucket, 5 * 1024 * 1024, null]]) {
    const options = { public: false, fileSizeLimit: size, allowedMimeTypes: types };
    const { data, error } = await supabase.storage.getBucket(id);
    if (error && !['400','404'].includes(String(error.statusCode)) && !/not found/i.test(error.message)) throw error;
    checked(data ? await supabase.storage.updateBucket(id, options) : await supabase.storage.createBucket(id, options));
  }
}
