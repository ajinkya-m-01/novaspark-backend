import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { route, validate, checked, fail, empty, userLimiter } from '../lib/user-panel.js';
import { kycUpload, kycBucket, upload, cleanup } from '../lib/storage.js';
const router = Router();
router.use(userLimiter(10, 15 * 60_000));
export const kycSchema = z.object({ fullName: z.string().trim().min(3).max(200), dateOfBirth: z.iso.date().refine(value => { const cutoff = new Date(); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 18); return value <= cutoff.toISOString().slice(0,10); }, 'You must be at least 18 years old'), country: z.string().trim().min(2).max(100), documentType: z.enum(['passport','national_id','driving_license']), documentNumber: z.string().trim().min(3).max(100), address: z.string().trim().max(1000).optional() }).strict();
router.get('/status', route(async (req,res) => {
 validate(empty,req.query);
 const { data } = checked(await supabase.from('kyc_submissions').select('*').eq('user_id',req.user.id).order('created_at',{ascending:false}).limit(1).maybeSingle());
 res.json({ok:true,submission:data ? { id:data.id,status:data.status,rejection_reason:data.reason,full_name:data.full_name,date_of_birth:data.date_of_birth,country:data.country ?? data.country_iso2,document_type:data.document_type,document_number:data.document_number,address:data.address,submitted_at:data.submitted_at,reviewed_at:data.reviewed_at } : null});
}));
router.post('/submit',kycUpload,route(async (req,res) => {
 const payload=validate(kycSchema,req.body);
 for (const name of ['documentFront','documentBack','selfie']) if(!req.files?.[name]?.[0]?.size) fail(400,`${name} is required (JPG/PNG; PDF allowed for documents)`);
 const { data: existing } = checked(await supabase.from('kyc_submissions').select('id').eq('user_id',req.user.id).in('status',['pending','approved']).limit(1).maybeSingle());
 if(existing) fail(409,'KYC already submitted');
 const paths=[];
 try {
  for(const [field,key] of [['documentFront','front'],['documentBack','back'],['selfie','selfie']]) { const file=await upload(kycBucket,req.user.id,req.files[field][0],key); paths.push(file.url); payload[key]=file.url; }
  const {data:submissionId}=checked(await supabase.rpc('user_panel_kyc_submit',{uid:req.user.id,payload}));
  res.status(201).json({ok:true,submissionId});
 } catch(error) { await cleanup(kycBucket,paths); throw error; }
}));
router.post('/reset',route(async(req,res)=>{
 validate(empty,req.body);
 const {data}=checked(await supabase.rpc('user_panel_kyc_reset',{uid:req.user.id}));
 await cleanup(kycBucket,(data??[]).filter(Boolean)); res.json({ok:true});
}));
export default router;
