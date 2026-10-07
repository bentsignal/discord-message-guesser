import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createRound, maintenance, publishResults, revealOldRounds } from '../src/storage';
import * as eligibility from '../src/eligibility';
import {sampleCandidates,search} from '../src/sampling';
import { gameDay } from '../src/game';
import type { Env, Message } from '../src/types';

let db: DatabaseSync;
let env: Env;
function statement(sql: string, args: any[] = []): any {
  return {
    bind: (...values:any[])=>statement(sql,values),
    first: async (column?:string)=> { const row=db.prepare(sql).get(...args) as any; return column ? row?.[column]??null : row??null; },
    all: async()=>({results:db.prepare(sql).all(...args),success:true}),
    run: async()=>({success:true,meta:db.prepare(sql).run(...args)}),
  };
}
const msg=(id:string,content='a historical quote'):Message=>({id,content,type:0,timestamp:'2016-01-01T00:00:00Z',author:{id:'author',username:'author'}});
beforeEach(()=>{
  vi.spyOn(eligibility,'eligibleAuthors').mockResolvedValue({ready:true,remaining:0,members:[{user:{id:'author',username:'author'}}]});
  db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0002_recaps.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0003_media.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0005_three_guesses.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0006_regular_authors.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0007_five_guesses.sql',import.meta.url),'utf8'));db.exec(readFileSync(new URL('../migrations/0004_on_demand.sql',import.meta.url),'utf8'));
  env={DB:{prepare:statement,batch:async(stmts:any[])=>{db.exec('BEGIN');try{const r=[];for(const s of stmts)r.push(await s.run());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}} as any,
    GUILD_ID:'guild',SOURCE_CHANNEL_ID:'source',GAME_CHANNEL_ID:'game',DISCORD_APPLICATION_ID:'bot',DISCORD_TOKEN:'test-token',TIME_ZONE:'America/New_York',DISCORD_PUBLIC_KEY:''};
});
afterEach(()=>{db.close();vi.restoreAllMocks();vi.unstubAllGlobals();});
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
describe('resumable history and daily lifecycle',()=>{
  it('samples old and recent months without storing channel messages',async()=>{
    db.exec("INSERT INTO state VALUES ('source_first_ms','1451606400000')");
    const fetcher=vi.fn(async(url:any)=>String(url).includes('offset=')?response({total_results:50,messages:[[msg('1')]]}):response({total_results:50,messages:[]}));vi.stubGlobal('fetch',fetcher);
    vi.spyOn(Math,'random').mockReturnValue(0);
    expect(await sampleCandidates(env)).toHaveLength(1);
    const oldBounds=new URL(fetcher.mock.calls[0][0]).searchParams.get('min_id');
    vi.mocked(Math.random).mockReturnValue(0.999);
    expect(await sampleCandidates(env)).toHaveLength(1);
    const recentBounds=new URL(fetcher.mock.calls[2][0]).searchParams.get('min_id');
    expect(BigInt(recentBounds!)).toBeGreaterThan(BigInt(oldBounds!));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='messages'").get()).toBeUndefined();
  });
  it('honors rate limits across subsequent calls without another request',async()=>{
    const fetcher=vi.fn().mockResolvedValue(response({retry_after:30},429));vi.stubGlobal('fetch',fetcher);
    expect(await search(env,{limit:'1'})).toBeNull();
    expect(await search(env,{limit:'1'})).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('waits for Discord historical indexing instead of treating it as empty history',async()=>{
    const fetcher=vi.fn().mockResolvedValue(response({retry_after:10,code:110000},202));vi.stubGlobal('fetch',fetcher);
    expect(await sampleCandidates(env)).toEqual([]);
    expect(await sampleCandidates(env)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT value FROM state WHERE key='source_first_ms'").get()).toBeUndefined();
  });
  it('narrows busy periods so random offsets stay within the search limit',async()=>{
    db.exec("INSERT INTO state VALUES ('source_first_ms','1451606400000')");
    const fetcher=vi.fn().mockResolvedValueOnce(response({total_results:200000,messages:[]})).mockResolvedValueOnce(response({total_results:50,messages:[]})).mockResolvedValueOnce(response({total_results:50,messages:[[msg('1')]]}));vi.stubGlobal('fetch',fetcher);
    expect(await sampleCandidates(env)).toHaveLength(1);
    const first=new URL(fetcher.mock.calls[0][0]).searchParams,second=new URL(fetcher.mock.calls[1][0]).searchParams;
    expect(BigInt(second.get('max_id')!)-BigInt(second.get('min_id')!)).toBeLessThan(BigInt(first.get('max_id')!)-BigInt(first.get('min_id')!));
    expect(Number(new URL(fetcher.mock.calls[2][0]).searchParams.get('offset'))).toBeLessThan(50);
  });
  it('caps requests even when every sampled period is extremely busy',async()=>{
    db.exec("INSERT INTO state VALUES ('source_first_ms','1451606400000')");
    const fetcher=vi.fn().mockImplementation(async()=>response({total_results:1000000,messages:[]}));vi.stubGlobal('fetch',fetcher);
    expect(await sampleCandidates(env)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(8);
  });
  it('does not replay a recently used daily message',async()=>{
    db.exec("INSERT INTO state VALUES ('source_first_ms','1451606400000')");
    db.prepare("INSERT INTO rounds(id,day,source_id,author_id,content,status) VALUES ('prior',?,'1','author','quote','closed')").run(new Date(Date.now()-86400000).toISOString().slice(0,10));
    const fetcher=vi.fn(async()=>response({total_results:1,messages:[[msg('1')]]}));vi.stubGlobal('fetch',fetcher);
    expect(await createRound(env)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects a selected message from a departed author',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:any)=>String(url).includes('/members/')?response({},404):response(msg('1'))));
    expect(await createRound(env,'practice-test','1')).toBeNull();
  });
  it('can create a practice puzzle immediately without importing history',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:any)=>String(url).includes('/members/')?response({user:{id:'author'}}):response(msg('1'))));
    expect(await createRound(env,'practice-test','1')).toMatchObject({practice:1,source_id:'1',guess_limit:5});
  });
  it('does not select a message from an author outside the regular-author pool',async()=>{
    vi.mocked(eligibility.eligibleAuthors).mockResolvedValue({ready:true,remaining:0,members:[{user:{id:'someone-else',username:'regular'}}]});
    const fetcher=vi.fn().mockResolvedValue(response(msg('1')));vi.stubGlobal('fetch',fetcher);
    expect(await createRound(env,'practice-excluded','1')).toBeNull();expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('labels other speakers by nickname and hides the target author in context',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:any)=>{
      const path=String(url);
      if(path.includes('?before='))return response([{...msg('before','hello'),author:{id:'other',username:'handle'}}]);
      if(path.includes('?after='))return response([msg('after','reply')]);
      if(path.includes('/members/other'))return response({user:{id:'other',username:'handle'},nick:'Display name'});
      if(path.includes('/members/'))return response({user:{id:'author'}});
      return response(msg('1'));
    }));
    const round=await createRound(env,'practice-context','1');
    expect(JSON.parse(round!.context_json!)).toEqual({before:{text:'hello',name:'Display name',timestamp:'2016-01-01T00:00:00Z'},after:{text:'reply',name:'???',timestamp:'2016-01-01T00:00:00Z'}});
  });
  it('stores the exact eligible-author list alongside the puzzle',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:any)=>String(url).includes('/members/')?response({user:{id:'author'}}):String(url).includes('?')?response([]):response(msg('1'))));
    expect(await createRound(env,'practice-pool','1')).toMatchObject({eligible_authors_json:'["author"]'});
  });
  it('closes the old puzzle, removes controls and reveals the original author',async()=>{
    db.exec("INSERT INTO rounds(id,day,source_id,author_id,content,status,discord_id) VALUES ('old','2000-01-01','source-message','author','quote','open','public-post');");
    const fetcher=vi.fn().mockResolvedValue(response({}));vi.stubGlobal('fetch',fetcher);
    await revealOldRounds(env);
    expect(db.prepare("SELECT status,revealed FROM rounds WHERE id='old'").get()).toMatchObject({status:'closed',revealed:1});
    const payload=JSON.parse(fetcher.mock.calls[0][1].body);
    expect(payload.components).toEqual([]);
    expect(payload.content).toContain('<@author>');
    expect(db.prepare('SELECT COUNT(*) AS n FROM recaps').get()).toMatchObject({n:1});
    await revealOldRounds(env);
    expect(db.prepare('SELECT COUNT(*) AS n FROM recaps').get()).toMatchObject({n:1});
  });
  it('retries a saved result after a failed Discord send without changing the guess',async()=>{
    db.exec("INSERT INTO rounds(id,day,source_id,author_id,content,status) VALUES ('round','2026-09-25','source-message','author','quote','open'); INSERT INTO guesses(round_id,user_id,guessed_id,correct,interaction_id) VALUES ('round','player','author',1,'interaction');");
    let fail=true;
    const fetcher=vi.fn(async(_url:any,init:any)=>init.method==='GET'?response([]):fail?response({},500):response({id:'result-post'}));vi.stubGlobal('fetch',fetcher);
    await expect(publishResults(env)).rejects.toMatchObject({status:500});
    expect(db.prepare('SELECT correct,published_id FROM guesses').get()).toMatchObject({correct:1,published_id:null});
    fail=false;await publishResults(env);
    expect(db.prepare('SELECT published_id FROM guesses').get()).toMatchObject({published_id:'result-post'});
    await publishResults(env);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('recovers a result already posted before the database acknowledgment failed',async()=>{
    db.exec("INSERT INTO rounds(id,day,source_id,author_id,content,status) VALUES ('round','2026-09-25','s','author','quote','open'); INSERT INTO guesses(round_id,user_id,guessed_id,correct,interaction_id) VALUES ('round','player','author',1,'interaction');");
    const fetcher=vi.fn().mockResolvedValue(response([{id:'existing',author:{id:'bot'},embeds:[{footer:{text:'Result interaction'}}]}]));vi.stubGlobal('fetch',fetcher);
    await publishResults(env);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT published_id FROM guesses').get()).toMatchObject({published_id:'existing'});
  });
});
