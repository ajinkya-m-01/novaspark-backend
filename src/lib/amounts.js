// Exact fixed-point arithmetic for database numeric(36,18) values.
const SCALE=10n**18n;
export function units(value){ const [whole,fraction='']=String(value).split('.'); return BigInt(whole)*SCALE+BigInt(fraction.padEnd(18,'0').slice(0,18)); }
export function decimal(value){ return `${value/SCALE}.${(value%SCALE).toString().padStart(18,'0')}`; }
export function sum(rows,field='amount'){return decimal(rows.reduce((total,row)=>total+units(row[field]),0n));}
