import { ensureStorageBuckets } from '../src/lib/storage.js';
await ensureStorageBuckets();
console.log('Private KYC and support buckets configured.');
