import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateImageAssets } = require('../native-helper/image-policy.cjs');
function setup(fetch = async () => { throw Error('unexpected fetch'); }, parsedDocument) {
  const context = vm.createContext({URL, AbortSignal, fetch, DOMParser: class { parseFromString() { return parsedDocument; } }});
  for (const file of ['adapter-runtime.js', 'adapters/instagram.js']) vm.runInContext(fs.readFileSync(new URL(`../content/${file}`, import.meta.url), 'utf8'), context);
  return context.TabMediaAdapters.registry[0];
}
const postUrl = 'https://www.instagram.com/p/DXbVfWfDhqK/?img_index=1';
const cdn = 'https://scontent-ssn1-1.cdninstagram.com/';
const photo = (index) => ({pk:String(index),media_type:1,image_versions2:{candidates:[{url:`${cdn}small-${index}.jpg`,width:100,height:100},{url:`${cdn}${index}.jpg?oh=signature`,width:1080,height:1350}]}});
const reel = {pk:'reel',media_type:2,video_versions:[{url:`${cdn}reel.mp4`,width:720,height:1280}]};
const post = {code:'DXbVfWfDhqK',media_type:8,carousel_media_count:20,carousel_media:Array.from({length:20},(_,i)=>photo(i+1)),user:{username:'ryudeee__'}};
const doc = (...nodes) => ({querySelectorAll:()=>nodes.map(n=>({textContent:JSON.stringify(n)}))});

test('Instagram 캐러셀은 20장 전체를 원래 순서·최대 해상도로 추출하고 다른 게시물은 제외한다', async () => {
 const result = await setup().extract(doc({data:[{...post,code:'other'},post]}),postUrl);
 assert.equal(result.assets.length,20);
 assert.equal(result.assets[0].url,`${cdn}1.jpg?oh=signature`);
 assert.equal(result.assets[19].filename,'0020.jpg');
 assert.equal(result.title,'ryudeee__ - DXbVfWfDhqK');
 assert.equal(setup().canonicalize(postUrl),'https://www.instagram.com/p/DXbVfWfDhqK/');
});
test('Instagram 릴스·혼합 게시물은 MP4와 이미지 순서를 유지한다', async () => {
 const adapter=setup();
 const single=await adapter.extract(doc({...reel,code:'C6XnZFmJoOy'}),'https://www.instagram.com/ryudeee__/reels/C6XnZFmJoOy/');
 assert.equal(single.assets[0].filename,'0001.mp4');
 const mixed=await adapter.extract(doc({...post,carousel_media_count:2,carousel_media:[photo(1),reel]}),postUrl);
 assert.deepEqual(Array.from(mixed.assets,a=>a.filename),['0001.jpg','0002.mp4']);
 await assert.rejects(adapter.extract(doc(post),'https://www.instagram.com/ryudeee__/'),/프로필/);
});
test('SPA 페이지에서는 현재 게시물 HTML만 재조회하고 불완전한 목록·외부 CDN은 거부한다', async () => {
 const requests=[];
 const fetch=async(url,options)=>{requests.push({url,options});return {ok:true,url,text:async()=>''};};
 const adapter=setup(fetch,doc(post));
 assert.equal((await adapter.extract(doc(),postUrl)).assets.length,20);
 assert.equal(requests.length,1);
 assert.equal(requests[0].options.credentials,'same-origin');
 for(const broken of [{...post,carousel_media:post.carousel_media.slice(1)}, {...reel,code:post.code,video_versions:[{url:'https://evil.test/reel.mp4'}]}, {...reel,code:post.code,video_versions:[{url:'https://cdninstagram.com.evil.test/reel.mp4'}]}]) {
  await assert.rejects(setup(fetch,doc(broken)).extract(doc(broken),postUrl),/전체 사진·영상/);
 }
});
test('Instagram WebP Helper 정책은 CDN 이미지와 고정 Referer만 허용한다',()=>{
 const asset={url:cdn+'1.jpg?oh=signature',filename:'0001.jpg',referer:'https://www.instagram.com/'};
 assert.equal(validateImageAssets('instagram',[asset])[0].filename,'0001.jpg');
 for(const url of ['https://127.0.0.1/1.jpg','https://cdninstagram.com.evil.test/1.jpg','https://user:pass@scontent-x.cdninstagram.com/1.jpg',cdn+'video.mp4']) assert.throws(()=>validateImageAssets('instagram',[{...asset,url}]));
 assert.throws(()=>validateImageAssets('instagram',[{...asset,referer:'https://evil.test/'}]));
});
