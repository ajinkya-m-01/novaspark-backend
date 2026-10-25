import { z } from 'zod';
import rateLimit from 'express-rate-limit';
export const empty = z.object({}).strict();
export const idParams = z.object({ id: z.string().uuid() });
export const pagination = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(10) };
export const userLimiter = (limit, windowMs) => rateLimit({ windowMs, limit, keyGenerator: req => req.user.id, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please try again later.' } });
export function validate(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw Object.assign(new Error('Invalid input'), { status: 400, fields: Object.fromEntries(result.error.issues.map(i => [i.path.join('.'), i.message])) });
  return result.data;
}
export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
export function checked(result) {
  if (result.error) {
    const messages = { KYC_DUPLICATE: [409, 'KYC already submitted'], KYC_RESET: [409, 'Only rejected or resubmit submissions can be reset'], OPEN_TICKET_LIMIT: [429, 'Too many open tickets'], TICKET_CLOSED: [409, 'This ticket is closed'], TICKET_STATE: [409, 'Ticket is not open'], NOT_FOUND: [404, 'Not found'], KYC_REQUIRED: [403, 'KYC verification required before withdrawal'], WITHDRAWAL_PENDING: [409, 'You already have a pending withdrawal request'], WITHDRAWAL_STATE: [409, 'Only pending withdrawals can be cancelled'] };
    const match = messages[result.error.message];
    if (match) fail(...match);
    if (result.error.code === '23505') fail(409, 'Request already exists');
    throw result.error;
  }
  return result;
}
export const route = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
