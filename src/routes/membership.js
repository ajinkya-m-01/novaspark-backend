import { Router } from 'express';
import { supabase } from '../supabase.js';
import { route,validate,checked,empty,userLimiter } from '../lib/user-panel.js';
import { sum,units,decimal } from '../lib/amounts.js';
const router=Router();router.use(userLimiter(60,60_000));
router.get('/',route(async(req,res)=>{
 validate(empty,req.query);
 const [tiersResult,positionsResult]=await Promise.all([supabase.from('membership_tiers').select('*').order('min_tokens',{ascending:true}),supabase.from('staking_positions').select('amount').eq('user_id',req.user.id).eq('status','active')]);
 const tiers=checked(tiersResult).data??[];const stakedBalance=sum(checked(positionsResult).data??[]);const balance=units(stakedBalance);
 const currentTier=tiers.filter(t=>units(t.min_tokens)<=balance).at(-1)??null;
 const next=tiers.find(t=>units(t.min_tokens)>balance);
 res.json({ok:true,tiers,currentTier,stakedBalance,nextTier:next?{name:next.name,min_tokens:next.min_tokens,tokensNeeded:decimal(units(next.min_tokens)-balance)}:null});
}));
export default router;
