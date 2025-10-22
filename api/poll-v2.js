function envAny(...names){for(const n of names){if(process.env[n])return process.env[n]}return""}
function pickId(obj){if(!obj||typeof obj!=="object")return null;const keys=["id","accountId","organizationId","orgId","clientId","companyId","businessId","locationId","profileId"];for(const k of keys){if(obj[k]!=null)return String(obj[k])}return null}
async function tryJSON(url, headers){const r=await fetch(url,{headers,cache:"no-store"});const t=await r.text().catch(()=> "");let j=null;try{j=JSON.parse(t)}catch{}return {ok:r.ok,status:r.status,body:t,j}}
export default async function handler(req,res){
  try{
    if(req.method!=="GET"){res.statusCode=405;res.setHeader("Content-Type","application/json");return res.end(JSON.stringify({ok:false,error:"Method Not Allowed"}))}
    const auth=req.headers.authorization||"";const b=auth.startsWith("Bearer ")?auth.slice(7):"";const cron=envAny("CRON_SECRET");if(!cron||b!==cron){res.statusCode=401;res.setHeader("Content-Type","application/json");return res.end(JSON.stringify({ok:false,error:"Unauthorized"}))}
    const minutes=Math.max(1,parseInt(req.query.minutes||"60",10));const max=Math.max(1,parseInt(req.query.max||"5",10));const sinceIso=new Date(Date.now()-minutes*60*1000).toISOString();
    const baseEnv=envAny("CHATMETER_V5_BASE")||"https://live.chatmeter.com/v5";
    const bases=[baseEnv,baseEnv.replace("/v5","/api/v5"),baseEnv.replace("/v5","")]; // /v5, /api/v5, root
    const user=envAny("CHATMETER_USERNAME","Chatmeter_username","chatmeter_username");
    const pass=envAny("CHATMETER_PASSWORD","Chatmeter_password","chatmeter_password");
    if(!user||!pass){res.statusCode=200;res.setHeader("Content-Type","application/json");return res.end(JSON.stringify({ok:false,stage:"env",error:"Missing CHATMETER_USERNAME or CHATMETER_PASSWORD"}))}
    // LOGIN on first viable base
    let token=null,loginBase=null,loginStatus=null,loginPreview=null;
    for(const b of bases){
      const r=await fetch(`${b}/login`,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({username:user,password:pass}),cache:"no-store"});
      loginStatus=r.status;const txt=await r.text();loginPreview=txt.slice(0,600);if(r.ok){try{const j=JSON.parse(txt);token=j?.token||j?.access_token||null}catch{}}
      if(token){loginBase=b;break;}
    }
    if(!token){res.statusCode=200;res.setHeader("Content-Type","application/json");return res.end(JSON.stringify({ok:false,stage:"login",bases,loginStatus,loginPreview}))}
    const H={Authorization:`Bearer ${token}`,Accept:"application/json"};
    // PROBE scopes across bases to get an id
    const scopes=["accounts","organizations","clients","companies","groups","brands","locations","businesses","profiles"];
    const scopeResults=[];
    let chosenScope=null,chosenId=null,scopeBase=null,scopeSampleKeys=null;
    for(const b2 of bases){
      for(const s of scopes){
        const url=`${b2}/${s}?limit=1`;
        const {ok,status,j,body}=await tryJSON(url,H);
        const list=Array.isArray(j?.data)?j.data:(Array.isArray(j)?j:null);
        const id=list?.[0]?pickId(list[0]):null;
        const sampleKeys=list?.[0]?Object.keys(list[0]):null;
        scopeResults.push({base:b2,scope:s,status,ok:!!list,idPreview:id,sampleKeys});
        if(list&&id){chosenScope=s;chosenId=id;scopeBase=b2;scopeSampleKeys=sampleKeys;break;}
      }
      if(chosenScope)break;
    }
    // Try review paths
    const attempts=[];
    for(const b3 of [scopeBase||loginBase]){
      // (A) root reviews with query id (try common param names)
      if(chosenId){
        for(const qName of ["accountId","organizationId","orgId","clientId","companyId","businessId","locationId","profileId"]){
          attempts.push({name:`root-reviews?${qName}=id`, url:`${b3}/reviews?since=${encodeURIComponent(sinceIso)}&limit=${max}&${qName}=${encodeURIComponent(chosenId)}`});
        }
      }
      // (B) scoped reviews path
      if(chosenScope&&chosenId){
        attempts.push({name:"scoped /{scope}/{id}/reviews", url:`${b3}/${chosenScope}/${encodeURIComponent(chosenId)}/reviews?since=${encodeURIComponent(sinceIso)}&limit=${max}`});
        // (C) some tenants use content path
        attempts.push({name:"content /{scope}/{id}/content/reviews", url:`${b3}/${chosenScope}/${encodeURIComponent(chosenId)}/content/reviews?since=${encodeURIComponent(sinceIso)}&limit=${max}`});
      }
      // (D) root /reviews (no id)
      attempts.push({name:"root /reviews", url:`${b3}/reviews?since=${encodeURIComponent(sinceIso)}&limit=${max}`});
    }
    const reviewResults=[];
    let success=null,successData=null;
    for(const a of attempts){
      const {ok,status,j,body}=await tryJSON(a.url,H);
      const arr=Array.isArray(j?.data)?j.data:(Array.isArray(j)?j:null);
      reviewResults.push({name:a.name,url:a.url,status,ok:!!arr,sampleKeys:arr?.[0]?Object.keys(arr[0]):null,preview:(!ok&&body)?body.slice(0,300):undefined});
      if(arr){success={name:a.name,url:a.url};successData=arr;break;}
    }
    if(!success){
      res.statusCode=200;res.setHeader("Content-Type","application/json");
      return res.end(JSON.stringify({
        ok:false,stage:"reviews-discovery",
        loginBase,scoped:{base:scopeBase,scope:chosenScope,id:chosenId,sampleKeys:scopeSampleKeys},
        scopeResults,reviewResults
      }));
    }
    res.statusCode=200;res.setHeader("Content-Type","application/json");
    return res.end(JSON.stringify({
      ok:true,stage:"chatmeter-ok",
      pathUsed:success, sinceIso, checked:successData.length,
      sampleKeys:successData[0]?Object.keys(successData[0]):null
    }));
  }catch(e){res.statusCode=500;res.setHeader("Content-Type","application/json");return res.end(JSON.stringify({ok:false,stage:"top-catch",error:String(e?.message||e)}))}
}
