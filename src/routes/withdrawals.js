import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { route,validate,checked,fail,empty,idParams,pagination,userLimiter } from '../lib/user-panel.js';
import { sum,units } from '../lib/amounts.js';
const router=Router();router.use(userLimiter(5,60*60_000));
const listSchema=z.object({...pagination,status:z.enum(['pending','approved','rejected','processed','cancelled']).optional()}).strict();
export const withdrawalSchema=z.object({amount:z.string().regex(/^\d{1,18}(\.\d{1,18})?$/).refine(v=>{try{return units(v)>=10n**16n;}catch{return false;}},'Minimum withdrawal is 0.01'),symbol:z.string().trim().min(1).max(20),walletAddress:z.string().regex(/^0x[0-9a-fA-F]{40}$/,'Invalid wallet address'),note:z.string().trim().max(200).optional()}).strict();
router.get('/',route(async(req,res)=>{
 const {page,limit,status}=validate(listSchema,req.query);
 let q=supabase.from('withdrawal_requests').select('*',{count:'exact'}).eq('user_id',req.user.id).order('created_at',{ascending:false}).range((page-1)*limit,page*limit-1);if(status)q=q.eq('status',status);
 const {data:withdrawals,count}=checked(await q);
 const {data:all}=checked(await supabase.from('withdrawal_requests').select('amount,status').eq('user_id',req.user.id));
 const {data:profile}=checked(await supabase.from('profiles').select('kyc_status').eq('id',req.user.id).single());
 res.json({ok:true,withdrawals:withdrawals??[],total:count??0,page,totalPages:Math.ceil((count??0)/limit),summary:{totalWithdrawn:sum((all??[]).filter(r=>r.status==='processed')),pendingAmount:sum((all??[]).filter(r=>r.status==='pending')),hasPending:(all??[]).some(r=>r.status==='pending'),kycApproved:profile.kyc_status==='approved'}});
}));
router.post('/',route(async(req,res)=>{const payload=validate(withdrawalSchema,req.body);const {data:withdrawalId}=checked(await supabase.rpc('user_panel_withdrawal_create',{uid:req.user.id,payload}));res.status(201).json({ok:true,withdrawalId});}));
router.delete('/:id',route(async(req,res)=>{const {id}=validate(idParams,req.params);validate(empty,req.query);const {data}=checked(await supabase.from('withdrawal_requests').update({status:'cancelled'}).eq('id',id).eq('user_id',req.user.id).eq('status','pending').select('id').maybeSingle());if(!data)fail(409,'Only your pending withdrawals can be cancelled');res.json({ok:true});}));
export default router;
