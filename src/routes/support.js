import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Resend } from 'resend';
import { config } from '../config.js';
import { supabase } from '../supabase.js';
import { route,validate,checked,fail,empty,idParams,pagination,userLimiter } from '../lib/user-panel.js';
import { supportUpload,supportBucket,upload,cleanup,signedAttachments } from '../lib/storage.js';
import { faqs } from '../data/faq.js';
const router=Router(); router.use(userLimiter(20,60*60_000));
const categories=['wallet_login','buying','staking','referrals','account','other'];
const listSchema=z.object({...pagination,status:z.enum(['open','in_progress','resolved','closed']).optional()}).strict();
const createSchema=z.object({subject:z.string().trim().min(3).max(200),category:z.enum(categories),message:z.string().trim().min(10).max(10000),txHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/).or(z.literal('')).optional()}).strict();
async function owned(req){ const {id}=validate(idParams,req.params); const {data}=checked(await supabase.from('support_tickets').select('*').eq('id',id).eq('user_id',req.user.id).maybeSingle()); if(!data) fail(404,'Ticket not found'); return data; }
async function files(req,tid,paths){const attachments=[];for(const file of Object.values(req.files??{}).flat()){ const item=await upload(supportBucket,`${req.user.id}/${tid}`,file); paths.push(item.url); attachments.push(item); }return attachments;}
router.get('/faq',route(async(req,res)=>{validate(empty,req.query);res.json({ok:true,faqs});}));
router.get('/tickets',route(async(req,res)=>{
 const {page,limit,status}=validate(listSchema,req.query);
 let q=supabase.from('support_tickets').select('*',{count:'exact'}).eq('user_id',req.user.id).order('updated_at',{ascending:false}).range((page-1)*limit,page*limit-1);if(status)q=q.eq('status',status);
 const {data:tickets,count}=checked(await q);
 const ids=(tickets??[]).map(t=>t.id);
 const messages=ids.length?checked(await supabase.from('support_messages').select('ticket_id,created_at').in('ticket_id',ids).eq('is_internal',false)).data:[];
 res.json({ok:true,tickets:(tickets??[]).map(t=>{const m=messages.filter(m=>m.ticket_id===t.id);return {...t,message_count:m.length,last_reply:m.map(m=>m.created_at).sort().at(-1)??null};}),total:count??0,page,totalPages:Math.ceil((count??0)/limit)});
}));
router.get('/tickets/:id',route(async(req,res)=>{
 validate(empty,req.query);const ticket=await owned(req);
 const {data}=checked(await supabase.from('support_messages').select('*, profiles!support_messages_sender_id_fkey(display_name)').eq('ticket_id',ticket.id).eq('is_internal',false).order('created_at',{ascending:true}));
 const messages=await Promise.all((data??[]).map(async m=>({...m,sender_name:m.profiles?.display_name??(m.sender_id===req.user.id?'You':'Support'),is_support:m.sender_id!==req.user.id,attachments:await signedAttachments(m.attachments??[])})));
 res.json({ok:true,ticket:{...ticket,messages}});
}));
router.post('/tickets',supportUpload,route(async(req,res)=>{
 const payload=validate(createSchema,req.body);
 const {count}=checked(await supabase.from('support_tickets').select('id',{count:'exact',head:true}).eq('user_id',req.user.id).in('status',['open','in_progress']));if(count>=5)fail(429,'Too many open tickets');
 const tid=randomUUID(),paths=[];
 try{payload.attachments=await files(req,tid,paths);checked(await supabase.rpc('user_panel_ticket_create',{uid:req.user.id,tid,payload}));}catch(e){await cleanup(supportBucket,paths);throw e;}
 // Ticket is durable even if the external email provider is temporarily unavailable.
 let emailSent=false;
 if(config.ADMIN_EMAIL){try{const result=await new Resend(config.RESEND_API_KEY).emails.send({from:config.EMAIL_FROM,to:config.ADMIN_EMAIL,subject:`New support ticket: ${payload.subject}`,text:`Ticket ${tid}\n${payload.message}`});if(result.error)throw result.error;emailSent=true;}catch(e){console.error('Ticket email failed:',e.message);}}
 res.status(201).json({ok:true,ticketId:tid,emailSent});
}));
router.post('/tickets/:id/reply',supportUpload,route(async(req,res)=>{
 const payload=validate(z.object({message:z.string().trim().min(2).max(10000)}).strict(),req.body);const ticket=await owned(req);if(ticket.status==='closed')fail(409,'This ticket is closed');const paths=[];
 try{payload.attachments=await files(req,ticket.id,paths);const {data:messageId}=checked(await supabase.rpc('user_panel_ticket_reply',{uid:req.user.id,tid:ticket.id,payload}));res.status(201).json({ok:true,messageId});}catch(e){await cleanup(supportBucket,paths);throw e;}
}));
router.patch('/tickets/:id/resolve',route(async(req,res)=>{
 validate(empty,req.body);const ticket=await owned(req);if(!['open','in_progress'].includes(ticket.status))fail(409,'Ticket is not open');
 const {data}=checked(await supabase.from('support_tickets').update({status:'resolved',updated_at:new Date().toISOString()}).eq('id',ticket.id).eq('user_id',req.user.id).in('status',['open','in_progress']).select('id').maybeSingle());if(!data)fail(409,'Ticket status changed');res.json({ok:true});
}));
export default router;
