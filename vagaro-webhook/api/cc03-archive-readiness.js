// Temporary CC-03 check: metadata only, never return credentials or repository contents.
export default async function handler(req,res) {
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
