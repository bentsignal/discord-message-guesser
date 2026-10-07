import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {INSERT_ATTEMPT,finalizeUnfinished} from '../src/attempts';
import {memberControls} from '../src/members';
import {eligibleMessage,roundPayload,resultSquares} from '../src/game';
import type {Env,Message,Round} from '../src/types';
let db:DatabaseSync;
beforeEach(()=>{db=new DatabaseSync(':memory:');for(const name of ['0001_initial','0002_recaps','0003_media','0004_on_demand','0005_three_guesses','0006_regular_authors','0007_five_guesses'])db.exec(readFileSync(new URL(`../migrations/${name}.sql`,import.meta.url),'utf8'));db.exec("INSERT INTO rounds(id,day,source_id,author_id,content,status,guess_limit) VALUES ('round','2026-09-26','source','author','quote','open',3)");});
afterEach(()=>db.close());
const attempt=(expected:number,guessed:string,interaction='i'+expected,user='player')=>db.prepare(INSERT_ATTEMPT).get(user,guessed,expected,guessed,interaction,'round','2026-09-26',expected,user,expected,user);
const outcomes=()=>db.prepare('SELECT * FROM guesses').all();
describe('three guesses',()=>{
 it('keeps misses private, then finalizes a correct second guess atomically',()=>{
  expect(attempt(0,'wrong')).toMatchObject({attempt:1,correct:0});expect(outcomes()).toEqual([]);
  expect(attempt(1,'author')).toMatchObject({attempt:2,correct:1});expect(outcomes()).toMatchObject([{correct:1,attempts_used:2}]);
  expect(attempt(2,'other')).toBeUndefined();
 });
 it('publishes one loss only at the third wrong guess',()=>{
  attempt(0,'one');attempt(1,'two');expect(outcomes()).toEqual([]);attempt(2,'three');
  expect(outcomes()).toMatchObject([{correct:0,attempts_used:3}]);expect(attempt(3,'author')).toBeUndefined();
 });
 it('rejects double clicks, stale selectors, duplicate people and repeated interaction delivery',()=>{
  attempt(0,'wrong');expect(attempt(0,'author','other-click')).toBeUndefined();
  expect(attempt(1,'wrong','repeat-person')).toBeUndefined();expect(attempt(1,'other','i0')).toBeUndefined();
  expect(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({n:1});
  expect(attempt(1,'author','valid')).toMatchObject({attempt:2,correct:1});
 });
 it('keeps different players independent and rejects closed or expired rounds',()=>{
  attempt(0,'wrong');expect(attempt(0,'author','other','player2')).toMatchObject({correct:1});
  db.exec("UPDATE rounds SET status='closed'");expect(attempt(1,'author')).toBeUndefined();
  db.exec("UPDATE rounds SET status='open',day='2000-01-01'");expect(attempt(1,'author')).toBeUndefined();
 });
 it('records unfinished players once when the day closes',async()=>{
  attempt(0,'wrong');db.exec("UPDATE rounds SET status='closed'");
  const env={DB:{prepare:(sql:string)=>({bind:(...args:any[])=>({run:async()=>db.prepare(sql).run(...args)})})}} as unknown as Env;
  await finalizeUnfinished(env,'round');await finalizeUnfinished(env,'round');expect(outcomes()).toMatchObject([{correct:0,attempts_used:1}]);
 });
 it('allows five guesses on new rounds and publishes one loss only at the fifth miss',()=>{
  db.exec("UPDATE rounds SET guess_limit=5");
  for(const [n,name] of ['one','two','three','four'].entries()){expect(attempt(n,name)).toMatchObject({attempt:n+1,correct:0});}
  expect(outcomes()).toEqual([]);expect(attempt(4,'five')).toMatchObject({attempt:5,correct:0});
  expect(outcomes()).toMatchObject([{correct:0,attempts_used:5}]);expect(attempt(5,'author')).toBeUndefined();
 });
 it('keeps attempts recorded before the five-guess migration',()=>{
  const old=new DatabaseSync(':memory:');
  for(const name of ['0001_initial','0002_recaps','0003_media','0004_on_demand','0005_three_guesses','0006_regular_authors'])old.exec(readFileSync(new URL(`../migrations/${name}.sql`,import.meta.url),'utf8'));
  old.exec("INSERT INTO rounds(id,day,source_id,author_id,content,status,guess_limit) VALUES ('round','2026-09-26','source','author','quote','open',3)");
  old.exec("INSERT INTO attempts(round_id,user_id,guessed_id,attempt,correct,interaction_id) VALUES ('round','player','wrong',1,0,'kept')");
  old.exec(readFileSync(new URL('../migrations/0007_five_guesses.sql',import.meta.url),'utf8'));
  expect(old.prepare('SELECT user_id,attempt,interaction_id FROM attempts').all()).toMatchObject([{user_id:'player',attempt:1,interaction_id:'kept'}]);
  old.exec("INSERT INTO attempts(round_id,user_id,guessed_id,attempt,correct,interaction_id) VALUES ('round','player','author',2,1,'won')");
  expect(old.prepare('SELECT correct,attempts_used FROM guesses').all()).toMatchObject([{correct:1,attempts_used:2}]);
  old.close();
 });
 it('preserves old one-guess round rules and existing outcomes',()=>{
  db.exec("UPDATE rounds SET guess_limit=1");attempt(0,'wrong');expect(outcomes()).toMatchObject([{correct:0,attempts_used:1}]);
  expect(attempt(1,'author')).toBeUndefined();
 });
});
describe('readable clues and member choices',()=>{
 it('includes all 76 members across dropdowns with at most 25 options each',()=>{
  const members=Array.from({length:76},(_,i)=>({nick:`Person ${i}`,user:{id:String(i),username:`user${i}`}}));
  const rows=memberControls(members,'round',0,[]) as any[];
  expect(rows).toHaveLength(4);expect(rows.flatMap(r=>r.components[0].options)).toHaveLength(76);
  expect(rows.every(r=>r.components[0].options.length<=25)).toBe(true);
  const remaining=memberControls(members,'round',1,['0']) as any[];
  expect(remaining.flatMap(r=>r.components[0].options).some(o=>o.value==='0')).toBe(false);
 });
 it('excludes commands while keeping ordinary prose and links',()=>{
  const message:Message={id:'1',author:{id:'2',username:'user'},type:0,timestamp:'2026',content:''};
  for(const text of ['/clear chat','!play song','.ban user','?help','$roll'])expect(eligibleMessage({...message,content:text})).toBe(false);
  for(const text of ['This is a good story!','https://youtube.com/watch?v=test','What?'])expect(eligibleMessage({...message,content:text})).toBe(true);
 });
 it('marks the target between anonymous neighboring messages without exposing its author',()=>{
  const round:Round={id:'r',day:'2026',source_id:'source',author_id:'secret',practice:1,status:'open',discord_id:null,revealed:0,content:'target',context_json:JSON.stringify({before:'previous <@123456789012345678>',after:'next'})};
  const payload=roundPayload(round);expect(payload.content.indexOf('previous')).toBeLessThan(payload.content.indexOf('👤 **???**\n**target**'));
  expect(payload.content.indexOf('target')).toBeLessThan(payload.content.indexOf('next'));
  expect(payload.content).not.toContain('Before');expect(payload.content).not.toContain('After');expect(payload.content).not.toContain('Guess this message');
  expect(payload.content).not.toContain('secret');expect(payload.content).not.toContain('<@123');
 });
 it('shows attempts and unused slots clearly',()=>{
  expect(resultSquares(1,2,3)).toBe('🟥🟩⬜');expect(resultSquares(0,3,3)).toBe('🟥🟥🟥');expect(resultSquares(0,1,3)).toBe('🟥⬜⬜');expect(resultSquares(1,3)).toBe('🟥🟥🟩⬜⬜');
 });
});
