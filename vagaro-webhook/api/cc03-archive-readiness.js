// Temporary CC-03 verification: metadata GET and one fixed synthetic POST.
import {createHash} from 'node:crypto';
import {persistEvent} from './vagaro-webhook.js';
const proofHash='f54986f3d6fb4210889b417619d89da11750140b7793178d6368dd90a04a1a9b';
const expires=1792255724752;
const id='cc03-private-archive-proof-20261017';
export default async function handler(req,res) {
 if(req.method==='POST') {
  const supplied=req.headers['x-cc03-proof'];
  if(Date.now()>expires || typeof supplied!=='string' || createHash('sha256').update(supplied).digest('hex')!==proofHash)return res.status(404).json({ready:false});
  try {
   const raw=JSON.stringify({id,type:'cc03-migration-canary',synthetic:true,version:1});
   const result=await persistEvent(id,raw);
   return res.status(200).json({ready:true,private:true,persisted:true,status:result.status});
  }catch{return res.status(503).json({ready:false,persisted:false});}
 }
 if(req.method!=='GET')return res.status(405).json({ready:false});
 res.setHeader('Cache-Control','public, s-maxage=60');
 try {
  if(!process.env.GITHUB_TOKEN)return res.status(200).json({ready:false,reason:'configuration'});
  const response=await fetch('https://api.github.com/repos/bradyeager/yeagers-gym-billing',{
   headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','User-Agent':'cc03-private-archive-readiness'},
   signal:AbortSignal.timeout(4000)
  });
  if(!response.ok)return res.status(200).json({ready:false,reason:'repository_access',status:response.status});
  const data=await response.json();
  const ready=data.private===true && data.permissions?.push===true;
  return res.status(200).json({ready,private:data.private===true,writable:data.permissions?.push===true});
 }catch{return res.status(200).json({ready:false,reason:'unconfirmed'});}
}
