import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, {interactionEnv} from '../src/index';
import { discord, dismissPrivatePicker, verifySignature } from '../src/discord';
import { gameDay } from '../src/game';
import type { Env } from '../src/types';

let db: DatabaseSync;
beforeEach(()=>{db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0002_recaps.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0003_media.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0005_three_guesses.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0006_regular_authors.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0007_five_guesses.sql',import.meta.url),'utf8'));});
afterEach(()=>{db.close();vi.restoreAllMocks();});
async function signing() {
  const keys=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
  const publicKey=Buffer.from(await crypto.subtle.exportKey('raw',keys.publicKey)).toString('hex');
  return {publicKey,async request(body:string,timestamp=String(Math.floor(Date.now()/1000))) {
    const signature=Buffer.from(await crypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(timestamp+body))).toString('hex');
    return new Request('https://test/interactions',{method:'POST',body,headers:{'x-signature-ed25519':signature,'x-signature-timestamp':timestamp}});
  }};
}
describe('Discord endpoint security',()=>{
  it('accepts a valid Ed25519 signature and rejects changed content and stale requests',async()=>{
    const s=await signing();const r=await s.request('{"type":1}');
    expect(await verifySignature(r,'{"type":1}',s.publicKey)).toBe(true);
    expect(await verifySignature(r,'{"type":2}',s.publicKey)).toBe(false);
    expect(await verifySignature(await s.request('{}','1'),'{}',s.publicKey)).toBe(false);
  });
  it('rejects malformed signatures without throwing',async()=>{
    expect(await verifySignature(new Request('https://test'),'{}','bad')).toBe(false);
  });
  it('responds to signed Discord ping but refuses unsigned traffic',async()=>{
    const s=await signing();const env={DISCORD_PUBLIC_KEY:s.publicKey} as Env;
    const ctx={waitUntil:vi.fn()} as unknown as ExecutionContext;
    const ping=await worker.fetch(await s.request('{"type":1}'),env,ctx);
    expect(await ping.json()).toEqual({type:1});
    expect((await worker.fetch(new Request('https://test/interactions',{method:'POST',body:'{}'}),env,ctx)).status).toBe(401);
  });
  it('refuses interactions from another server without scheduling work',async()=>{
    const s=await signing();const ctx={waitUntil:vi.fn()} as unknown as ExecutionContext;
    const response=await worker.fetch(await s.request(JSON.stringify({type:2,application_id:'app',guild_id:'other',member:{user:{id:'player'}}})),{DISCORD_PUBLIC_KEY:s.publicKey,DISCORD_APPLICATION_ID:'app',GUILD_ID:'configured'} as Env,ctx);
    expect(await response.json()).toMatchObject({type:4,data:{flags:64}});
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
});

describe('non-destructive guess completion',()=>{
  it.each([0,1])('handles a completed guess privately (correct=%s)',async(correct)=>{
    const storage=await import('../src/storage');
    vi.spyOn(storage,'publishResults').mockResolvedValue();
    const requests:{url:string;method:string}[]=[];
    const privateBodies:string[]=[];
    vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
      requests.push({url:String(input),method:init?.method||'GET'});
      if(init?.method==='PATCH')privateBodies.push(String(init.body));
      if(init?.method==='DELETE')return new Response(null,{status:204});
      return Response.json({user:{id:'123456789012345678',bot:false},flags:64,author:{id:'app'}});
    });
    const first=vi.fn().mockResolvedValue({correct,source_id:'source'});
    const s=await signing();
    const env={DISCORD_PUBLIC_KEY:s.publicKey,DISCORD_APPLICATION_ID:'app',GUILD_ID:'guild',TIME_ZONE:'America/New_York',DB:{prepare:()=>({bind:()=>({first})})}} as unknown as Env;
    let pending:Promise<unknown>|undefined;
    const ctx={waitUntil:(p:Promise<unknown>)=>{pending=p;}} as ExecutionContext;
    const interaction={type:3,id:'interaction',token:'test-token',application_id:'app',guild_id:'guild',member:{user:{id:'player'}},data:{custom_id:'guess:round',values:['123456789012345678']}};
    const response=await worker.fetch(await s.request(JSON.stringify(interaction)),env,ctx);
    expect(await response.json()).toEqual({type:6});
    await pending;
    expect(first).toHaveBeenCalledTimes(3);
    expect(requests).toContainEqual({url:'https://discord.com/api/v10/webhooks/app/test-token/messages/@original',method:correct?'PATCH':'DELETE'});
    expect(requests.filter(r=>r.method==='DELETE')).toHaveLength(correct?0:1);
    expect(privateBodies.some(body=>body.includes('View the original message'))).toBe(!!correct);
    expect(storage.publishResults).toHaveBeenCalledOnce();
  });
});

 it('blocks Discord deletion before sending a request',async()=>{
   const fetcher=vi.spyOn(globalThis,'fetch');
   await expect(discord({} as Env,'/channels/1/messages/2','DELETE')).rejects.toThrow('prohibited');
   await expect(discord({} as Env,'/channels/1/messages/bulk-delete','POST',{messages:['1','2']})).rejects.toThrow('prohibited');
   expect(fetcher).not.toHaveBeenCalled();
 });

 it('refuses to dismiss public responses or another bot’s private response',async()=>{
   const fetcher=vi.spyOn(globalThis,'fetch');
   for(const message of [{flags:0,author:{id:'app'}},{flags:64,author:{id:'other'}}]){
     fetcher.mockResolvedValue(Response.json(message));
     await expect(dismissPrivatePicker({DISCORD_APPLICATION_ID:'app'} as Env,'token')).rejects.toThrow('Refusing');
   }
   expect(fetcher.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
 });

it('routes only the testing channel to its separate database',()=>{
 const live={} as D1Database,test={} as D1Database;
 const env={DB:live,TEST_DB:test,GAME_CHANNEL_ID:'live',TEST_CHANNEL_ID:'test'} as Env;
 expect(interactionEnv(env,{channel_id:'test'} as any)).toMatchObject({DB:test,GAME_CHANNEL_ID:'test'});
 expect(interactionEnv(env,{channel_id:'live'} as any)).toBe(env);
 expect(interactionEnv(env,{channel_id:'other'} as any)).toBe(env);
});
