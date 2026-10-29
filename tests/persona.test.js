import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomHost } from '../plugins/ruwo-suoxie/team/host.js';
test('team workstation reads bundled persona without a development source tree',()=>{
  const sections=[];let onCreated;
  const ctx={on:(_event,fn)=>{onCreated=fn;},effect:fn=>fn()};
  const room={hostSessionId:'synthetic-session',kind:'workstation',members:['cyrene']};
  createRoomHost(ctx,'unused-install-directory',()=>({rooms:[room]}),{});
  onCreated({agent:{id:room.hostSessionId,ctx:{systemPrompt:{section:value=>sections.push(value)},tools:{restrict:()=>{}}}}});
  assert.equal(sections.length,1);assert.ok(sections[0].text().length>100);
});
