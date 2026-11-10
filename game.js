import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js';

const canvas = document.querySelector('#chess-canvas');
const boardFrame = document.querySelector('#board-frame');
const loading = document.querySelector('#loading');
const files = 'abcdefgh';
const glyphs = {wk:'♔',wq:'♕',wr:'♖',wb:'♗',wn:'♘',wp:'♙',bk:'♚',bq:'♛',br:'♜',bb:'♝',bn:'♞',bp:'♟'};
const values = {p:1,n:3,b:3,r:5,q:9,k:0};
let state, history = [], selected = null, legalTargets = [], capturedBy = {w:[],b:[]}, flipped = false, toastTimer;
let scene, camera, renderer, raycaster, boardGroup, pieceGroup, highlightGroup, squareMeshes = [], pieceMeshes = new Map(), orbit = {theta:3*Math.PI/4,phi:0.72,radius:18.5}, pointer = null, dragged = false;
const color = {light:0xf2e5c7,dark:0x5d3927,gold:0xc2a15e,ivory:0xf1e4c9,ink:0x1d3430};

function initialState(){
 const b=Array.from({length:8},()=>Array(8).fill(null));
 const back='rnbqkbnr';
 for(let f=0;f<8;f++){b[0][f]={c:'w',t:back[f]};b[1][f]={c:'w',t:'p'};b[6][f]={c:'b',t:'p'};b[7][f]={c:'b',t:back[f]};}
 return {b,turn:'w',castle:{K:true,Q:true,k:true,q:true},ep:null,half:0,full:1};
}
function cloneState(s){return {b:s.b.map(r=>r.map(p=>p&&({...p}))),turn:s.turn,castle:{...s.castle},ep:s.ep&&[...s.ep],half:s.half,full:s.full};}
function same(a,b){return a&&b&&a[0]===b[0]&&a[1]===b[1];}
function inBounds(r,f){return r>=0&&r<8&&f>=0&&f<8;}
function findKing(s,c){for(let r=0;r<8;r++)for(let f=0;f<8;f++){let p=s.b[r][f];if(p&&p.c===c&&p.t==='k')return [r,f];}return null;}
function attacked(s,r,f,by){
 const pawnDir=by==='w'?1:-1;
 for(const df of [-1,1]){let rr=r-pawnDir,ff=f-df;if(inBounds(rr,ff)&&s.b[rr][ff]?.c===by&&s.b[rr][ff].t==='p')return true;}
 for(const [dr,df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]){let rr=r+dr,ff=f+df;if(inBounds(rr,ff)&&s.b[rr][ff]?.c===by&&s.b[rr][ff].t==='n')return true;}
 for(const [dr,df] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){let rr=r+dr,ff=f+df,dist=1;while(inBounds(rr,ff)){let p=s.b[rr][ff];if(p){if(p.c===by&&(p.t==='q'||(p.t==='r'&&(!dr||!df))||(p.t==='b'&&dr&&df)||(p.t==='k'&&dist===1)))return true;break;}rr+=dr;ff+=df;dist++;}}
 return false;
}
function inCheck(s,c){let k=findKing(s,c);return !k||attacked(s,k[0],k[1],c==='w'?'b':'w');}
function pseudoMoves(s,r,f){
 const p=s.b[r][f];if(!p)return [];const out=[],add=(rr,ff,extra={})=>{if(inBounds(rr,ff))out.push({from:[r,f],to:[rr,ff],...extra});};
 if(p.t==='p'){const d=p.c==='w'?1:-1,start=p.c==='w'?1:6,promo=p.c==='w'?7:0;if(inBounds(r+d,f)&&!s.b[r+d][f]){add(r+d,f,r+d===promo?{promotion:'q'}:{});if(r===start&&!s.b[r+2*d][f])add(r+2*d,f,{double:true});}for(let df of [-1,1]){let rr=r+d,ff=f+df;if(inBounds(rr,ff)&&s.b[rr][ff]&&s.b[rr][ff].c!==p.c)add(rr,ff,rr===promo?{promotion:'q'}:{});if(s.ep&&same(s.ep,[rr,ff]))add(rr,ff,{ep:true});}}
 else if(p.t==='n'){for(let [dr,df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]){let rr=r+dr,ff=f+df;if(inBounds(rr,ff)&&s.b[rr][ff]?.c!==p.c)add(rr,ff);}}
 else if('brq'.includes(p.t)){let dirs=[];if(p.t!=='b')dirs.push([1,0],[-1,0],[0,1],[0,-1]);if(p.t!=='r')dirs.push([1,1],[1,-1],[-1,1],[-1,-1]);for(let [dr,df] of dirs){let rr=r+dr,ff=f+df;while(inBounds(rr,ff)){if(!s.b[rr][ff])add(rr,ff);else{if(s.b[rr][ff].c!==p.c)add(rr,ff);break;}rr+=dr;ff+=df;}}}
 else if(p.t==='k'){for(let dr=-1;dr<=1;dr++)for(let df=-1;df<=1;df++){if(!dr&&!df)continue;let rr=r+dr,ff=f+df;if(inBounds(rr,ff)&&s.b[rr][ff]?.c!==p.c)add(rr,ff);}let row=p.c==='w'?0:7,enemy=p.c==='w'?'b':'w';if(r===row&&f===4&&!inCheck(s,p.c)){for(const side of ['K','Q']){if(!s.castle[side==='K'?'K':'Q']&&p.c==='w'||!s.castle[side==='K'?'k':'q']&&p.c==='b')continue;let kingSide=side==='K',rookFile=kingSide?7:0,rook=s.b[row][rookFile],between=kingSide?[5,6]:[1,2,3],pass=kingSide?[5,6]:[3,2];if(!rook||rook.t!=='r'||rook.c!==p.c||between.some(x=>s.b[row][x])||pass.some(x=>attacked(s,row,x,enemy)))continue;add(row,kingSide?6:2,{castle:kingSide?'K':'Q'});}}}
 return out;
}
function applyMove(s,m){const n=cloneState(s),[r,f]=m.from,[rr,ff]=m.to,p=n.b[r][f],target=n.b[rr][ff];if(m.ep)n.b[r][ff]=null;n.b[rr][ff]=p;n.b[r][f]=null;if(m.promotion)n.b[rr][ff]={c:p.c,t:m.promotion};if(m.castle){let row=r,rf=m.castle==='K'?7:0,tf=m.castle==='K'?5:3;n.b[row][tf]=n.b[row][rf];n.b[row][rf]=null;}
 if(p.t==='k'){n.castle[p.c==='w'?'K':'k']=false;n.castle[p.c==='w'?'Q':'q']=false;}if(p.t==='r'){if(r===0&&f===0)n.castle.Q=false;if(r===0&&f===7)n.castle.K=false;if(r===7&&f===0)n.castle.q=false;if(r===7&&f===7)n.castle.k=false;}if(target?.t==='r'){if(rr===0&&ff===0)n.castle.Q=false;if(rr===0&&ff===7)n.castle.K=false;if(rr===7&&ff===0)n.castle.q=false;if(rr===7&&ff===7)n.castle.k=false;}n.ep=m.double?[(r+rr)/2,f]:null;n.half=p.t==='p'||target||m.ep?0:n.half+1;if(s.turn==='b')n.full++;n.turn=s.turn==='w'?'b':'w';return n;}
function legalMoves(s,r,f){return pseudoMoves(s,r,f).filter(m=>!inCheck(applyMove(s,m),s.b[r][f].c));}
function allMoves(s,c=s.turn){let out=[];for(let r=0;r<8;r++)for(let f=0;f<8;f++)if(s.b[r][f]?.c===c)out.push(...legalMoves(s,r,f));return out;}
function squareName([r,f]){return files[f]+(r+1);}
function san(s,m){const p=s.b[m.from[0]][m.from[1]],target=s.b[m.to[0]][m.to[1]],capture=target||m.ep;let text;if(m.castle)text=m.castle==='K'?'O-O':'O-O-O';else{text=(p.t==='p'?'':p.t.toUpperCase())+(capture&&p.t==='p'?files[m.from[1]]:'')+(capture?'x':'')+squareName(m.to)+(m.promotion?'=Q':'');}const after=applyMove(s,m);if(inCheck(after,after.turn))text+=allMoves(after).length?'＋':'#';return text;}

const mat=(c,rough=.35,metal=0)=>new THREE.MeshStandardMaterial({color:c,roughness:rough,metalness:metal});
function mesh(geo,material,parent,x=0,y=0,z=0){const m=new THREE.Mesh(geo,material);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
function lathe(parent,profile,material,y=0){const m=mesh(new THREE.LatheGeometry(profile.map(([x,z])=>new THREE.Vector2(x,z)),40),material,parent,0,y,0);m.castShadow=true;return m;}
function createBoard(){
 boardGroup=new THREE.Group();scene.add(boardGroup);pieceGroup=new THREE.Group();boardGroup.add(pieceGroup);highlightGroup=new THREE.Group();boardGroup.add(highlightGroup);
 const dark=mat(0x30251e,.28),wood=mat(0x5a3624,.27),trim=mat(0x987044,.25,.35),felt=mat(0x21342d,.83),tileA=mat(0xe4d2ad,.38),tileB=mat(0x75513a,.36);
 mesh(new THREE.BoxGeometry(9.05,.34,9.05),dark,boardGroup,0,-.39,0);mesh(new THREE.BoxGeometry(8.92,.1,8.92),trim,boardGroup,0,-.18,0);mesh(new THREE.BoxGeometry(8.78,.16,8.78),wood,boardGroup,0,-.095,0);mesh(new THREE.BoxGeometry(8.55,.09,8.55),felt,boardGroup,0,.005,0);
 const squareGeo=new THREE.BoxGeometry(1,.08,1);squareMeshes=[];
 for(let r=0;r<8;r++)for(let f=0;f<8;f++){const sq=mesh(squareGeo,(r+f)%2?tileB:tileA,boardGroup,f-3.5,.085,r-3.5);sq.userData.square=[r,f];squareMeshes.push(sq);}
 const brass=mat(0xd0ad68,.23,.55);for(let i=-1;i<=1;i+=2){mesh(new THREE.BoxGeometry(8.9,.13,.055),brass,boardGroup,0,-.22,i*4.43);mesh(new THREE.BoxGeometry(.055,.13,8.9),brass,boardGroup,i*4.43,-.22,0);}
 // Fine engraved corner studs and a small maker's medallion give the timber frame a crafted finish.
 for(const x of [-4.3,4.3])for(const z of [-4.3,4.3])mesh(new THREE.CylinderGeometry(.055,.055,.025,20),brass,boardGroup,x,-.13,z);
}
function makePiece(p){
 const g=new THREE.Group(),dark=p.c==='b',main=mat(dark?0x17342e:0xf1e8d6,dark?.24:.27,dark?.3:.06),edge=mat(dark?0x071814:0xb8a77e,.31,dark?.2:.18),gold=mat(dark?0xd4b269:0x9a7946,.22,.62),shadow=mat(dark?0x0b201b:0xddd0b5,.4);
 const foot=[[.29,0],[.34,.04],[.34,.09],[.31,.13],[.28,.15],[.27,.19],[.24,.22],[.21,.26],[.18,.29],[.16,.33],[.14,.36],[.12,.39]];
 lathe(g,foot,edge,.13);lathe(g,[[.28,.12],[.32,.135],[.32,.17],[.29,.19]],gold,.13);
 // The stepped plinth, chamfered rings and polished collar create a readable silhouette at phone scale.
 const stemProfiles={p:[[.11,.36],[.14,.42],[.12,.52],[.1,.61],[.13,.68],[.2,.72],[.22,.77],[.19,.8]],r:[[.13,.35],[.16,.42],[.15,.49],[.14,.55],[.2,.6],[.21,.65],[.18,.7],[.18,.92],[.22,.96],[.22,1],[.17,1.04]],n:[[.13,.35],[.16,.42],[.14,.49],[.15,.55],[.2,.6],[.22,.66],[.16,.71],[.14,.8],[.2,.91],[.24,.98],[.21,1.03]],b:[[.13,.35],[.16,.42],[.14,.49],[.15,.55],[.2,.61],[.21,.66],[.16,.72],[.13,.84],[.16,.94],[.22,.99],[.21,1.03]],q:[[.13,.35],[.16,.42],[.14,.49],[.15,.56],[.21,.61],[.23,.67],[.17,.73],[.15,.83],[.2,.91],[.27,.96],[.28,1]],k:[[.13,.35],[.17,.43],[.15,.51],[.15,.58],[.22,.64],[.24,.7],[.17,.76],[.16,.9],[.23,.96],[.26,1.01]]};
 lathe(g,stemProfiles[p.t],main,.13);
 const ringY={p:.83,r:.79,n:.79,b:.79,q:1.04,k:1.05}[p.t];
 const ringRadius={p:.19,r:.19,n:.19,b:.18,q:.27,k:.25}[p.t];
 lathe(g,[[ringRadius*.88,ringY],[ringRadius,ringY+.018],[ringRadius,ringY+.05],[ringRadius*.88,ringY+.065]],gold,.13);
 if(p.t==='p'){
  const neck=lathe(g,[[.105,.69],[.085,.76],[.073,.85],[.09,.92],[.14,.97],[.18,1.02],[.2,1.08],[.19,1.12],[.16,1.15]],main,.13);
  mesh(new THREE.SphereGeometry(.19,32,24),main,g,0,1.31,0).scale.set(1,1.08,1);
  mesh(new THREE.SphereGeometry(.125,24,16),gold,g,0,1.48,0);
 }else if(p.t==='r'){
  lathe(g,[[.19,1.02],[.22,1.08],[.22,1.17],[.24,1.2]],main,.13);
  mesh(new THREE.CylinderGeometry(.24,.24,.1,32),main,g,0,1.35,0);
  const count=8;for(let i=0;i<count;i++){const a=i/count*Math.PI*2;mesh(new THREE.BoxGeometry(.14,.14,.12),gold,g,Math.cos(a)*.19,1.48,Math.sin(a)*.19).rotation.y=-a;}
 }else if(p.t==='n'){
  // Sculpted horse head with cheek, muzzle and raised ears.
  const head=mesh(new THREE.SphereGeometry(.22,24,20),main,g,0,1.31,0);head.scale.set(.73,1.18,.72);
  const muzzle=mesh(new THREE.SphereGeometry(.13,20,16),main,g,0,1.19,.14);muzzle.scale.set(.85,.65,1.05);
  const mane=mesh(new THREE.SphereGeometry(.18,20,16),edge,g,0,1.39,-.06);mane.scale.set(.8,1.15,.8);
  for(const x of [-.105,.105]){const ear=mesh(new THREE.ConeGeometry(.055,.19,12),gold,g,x,1.55,-.015);ear.rotation.z=x<0?-.2:.2;const eye=mesh(new THREE.SphereGeometry(.028,12,10),gold,g,x*1.35,1.38,.13);}
  for(let i=0;i<4;i++){const tuft=mesh(new THREE.ConeGeometry(.055,.17,12),main,g,0,1.5-i*.055,-.15-i*.025);tuft.rotation.x=-.25;}
 }else if(p.t==='b'){
  const mitre=mesh(new THREE.SphereGeometry(.19,24,20),main,g,0,1.31,0);mitre.scale.set(.82,1.12,.82);
  const slit=mesh(new THREE.BoxGeometry(.045,.25,.012),gold,g,0,1.34,.176);slit.rotation.z=.35;
  mesh(new THREE.SphereGeometry(.065,20,16),gold,g,0,1.54,0);
 }else if(p.t==='q'){
  const crownY=1.12;mesh(new THREE.CylinderGeometry(.24,.2,.11,32),main,g,0,crownY,0);
  for(let i=0;i<9;i++){let a=i/9*Math.PI*2,x=Math.cos(a)*.215,z=Math.sin(a)*.215;const tip=mesh(new THREE.SphereGeometry(.058,16,12),gold,g,x,1.28,z);tip.scale.set(.8,1.15,.8);}
  mesh(new THREE.SphereGeometry(.065,18,14),gold,g,0,1.31,0);
 }else if(p.t==='k'){
  mesh(new THREE.CylinderGeometry(.22,.2,.11,32),main,g,0,1.16,0);
  mesh(new THREE.BoxGeometry(.1,.38,.1),gold,g,0,1.42,0);mesh(new THREE.BoxGeometry(.29,.09,.1),gold,g,0,1.48,0);
 }
 // A tiny front-facing maker's medallion adds contrast to every sculpted base.
 mesh(new THREE.SphereGeometry(.045,16,12),gold,g,0,.37,.295).scale.set(1,.75,.35);
 g.userData.piece=p;g.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});return g;
}
function clearGroup(g){g.traverse(o=>{if(o.isMesh){o.geometry?.dispose();if(Array.isArray(o.material))o.material.forEach(m=>m.dispose());else o.material?.dispose();}});g.clear();}
function syncPieces(){clearGroup(pieceGroup);pieceMeshes.clear();for(let r=0;r<8;r++)for(let f=0;f<8;f++){const p=state.b[r][f];if(!p)continue;const g=makePiece(p);g.position.set(f-3.5,.13,r-3.5);g.userData.square=[r,f];pieceGroup.add(g);pieceMeshes.set(`${r},${f}`,g);}}
function clearHighlights(){clearGroup(highlightGroup);}
function addHighlight(r,f,kind){const x=f-3.5,z=r-3.5;if(kind==='selected'){const m=new THREE.Mesh(new THREE.BoxGeometry(.96,.025,.96),new THREE.MeshBasicMaterial({color:0xe9c96e,transparent:true,opacity:.43,depthWrite:false}));m.position.set(x,.145,z);highlightGroup.add(m);}else{const matl=new THREE.MeshBasicMaterial({color:kind==='capture'?0xb55a3e:0x4c9a70,transparent:true,opacity:.78,depthWrite:false});const m=new THREE.Mesh(new THREE.CylinderGeometry(kind==='capture'?.38:.13,kind==='capture'?.38:.13,.026,40),matl);m.position.set(x,.153,z);highlightGroup.add(m);}}
function paintHighlights(){clearHighlights();if(selected)addHighlight(selected[0],selected[1],'selected');for(const m of legalTargets)addHighlight(m.to[0],m.to[1],state.b[m.to[0]][m.to[1]]||m.ep?'capture':'move');}
function updateCamera(){const {theta,phi,radius}=orbit;camera.position.set(radius*Math.sin(phi)*Math.sin(theta),radius*Math.cos(phi),radius*Math.sin(phi)*Math.cos(theta));camera.lookAt(0,.15,0);}
function init3D(){
 scene=new THREE.Scene();scene.background=new THREE.Color(0x1a2420);scene.fog=new THREE.Fog(0x1a2420,18,33);
 camera=new THREE.PerspectiveCamera(35,1,.1,80);raycaster=new THREE.Raycaster();
 renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance'});renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.6));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.13;
 scene.add(new THREE.HemisphereLight(0xdce9ee,0x453222,2.1));const key=new THREE.DirectionalLight(0xffe6bd,3.2);key.position.set(-5,10,7);key.castShadow=true;key.shadow.mapSize.set(1536,1536);key.shadow.camera.left=-7;key.shadow.camera.right=7;key.shadow.camera.top=8;key.shadow.camera.bottom=-7;key.shadow.bias=-.00015;key.shadow.normalBias=.025;scene.add(key);
 const fill=new THREE.DirectionalLight(0xb8d8dc,1.25);fill.position.set(6,7,-5);scene.add(fill);const rim=new THREE.DirectionalLight(0xffd69a,1);rim.position.set(-6,4,-7);scene.add(rim);
 const floor=new THREE.Mesh(new THREE.PlaneGeometry(200,200),mat(0x1a2420,.95));floor.rotation.x=-Math.PI/2;floor.position.y=-.63;floor.receiveShadow=true;scene.add(floor);
 createBoard();syncPieces();resize();new ResizeObserver(resize).observe(boardFrame);window.addEventListener('resize',resize);updateCamera();
 renderer.setAnimationLoop(()=>{renderer.render(scene,camera);});loading.classList.add('hidden');
}
function resize(){if(!renderer||!camera)return;const w=Math.max(1,boardFrame.clientWidth),h=Math.max(1,boardFrame.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}
function updateUI(){
 const whiteTurn=state.turn==='w',status=checkStatus();document.querySelector('#turn-value').textContent=whiteTurn?'White':'Black';document.querySelector('#turn-icon').textContent=whiteTurn?'♙':'♟';
 document.querySelector('#white-marker').parentElement.classList.toggle('active',whiteTurn&&!status.over);document.querySelector('#black-marker').parentElement.classList.toggle('active',!whiteTurn&&!status.over);
 document.querySelector('#white-sub').textContent=whiteTurn?(status.check?'In check — find safety':'Your move'):'Waiting for Black';document.querySelector('#black-sub').textContent=!whiteTurn?(status.check?'In check — find safety':'Their move'):'Waiting for White';
 document.querySelector('#turn-box').classList.toggle('in-check',status.check);document.querySelector('#undo-button').disabled=history.length===0;document.querySelector('#move-count').textContent=`${history.length} ${history.length===1?'MOVE':'MOVES'}`;
 document.querySelector('#white-captured').textContent=capturedBy.w.map(p=>glyphs['b'+p.t]).join('');document.querySelector('#black-captured').textContent=capturedBy.b.map(p=>glyphs['w'+p.t]).join('');
 const list=document.querySelector('#move-list');if(!history.length)list.innerHTML='<div class="empty-state"><span>♟</span> Your game begins with a single move.</div>';else{list.innerHTML='';for(let i=0;i<history.length;i+=2){const row=document.createElement('div');row.className='move-row';row.innerHTML=`<span class="move-index">${String(i/2+1).padStart(2,'0')}.</span><span class="move-cell">${history[i].notation}</span><span class="move-cell">${history[i+1]?.notation||''}</span>`;list.appendChild(row);}list.scrollTop=list.scrollHeight;}
 document.querySelector('#game-over').hidden=!status.over;if(status.over){document.querySelector('#result-title').textContent=status.check?'Checkmate':'Draw';document.querySelector('#result-copy').textContent=status.check?`${state.turn==='w'?'Black':'White'} wins the game.`:'Stalemate — neither side can move.';}
}
function checkStatus(){const check=inCheck(state,state.turn),moves=allMoves(state);return {check,over:moves.length===0,checkmate:check&&moves.length===0};}
function notify(text){const el=document.querySelector('#toast');el.textContent=text;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2100);}
function commitMove(move){
 const piece=state.b[move.from[0]][move.from[1]],victim=state.b[move.to[0]][move.to[1]]||(move.ep?state.b[move.from[0]][move.to[1]]:null),notation=san(state,move);
 history.push({state:cloneState(state),move,notation});if(victim)capturedBy[piece.c].push({...victim});state=applyMove(state,move);selected=null;legalTargets=[];syncPieces();paintHighlights();updateUI();
 const status=checkStatus();if(status.check&&!status.over)notify(`${state.turn==='w'?'White':'Black'} is in check`);if(status.checkmate)notify(`${state.turn==='w'?'Black':'White'} wins by checkmate`);
}
function handleSquare(pos){const [r,f]=pos;if(selected){const chosen=legalTargets.find(m=>same(m.to,pos));if(chosen){commitMove(chosen);return;}}
 const p=state.b[r][f];if(p?.c===state.turn){selected=pos;legalTargets=legalMoves(state,r,f);paintHighlights();return;}
 if(selected){selected=null;legalTargets=[];paintHighlights();}}
function undo(){if(!history.length)return;const last=history.pop();state=last.state;if(last.move){const prev=last.state;const victim=prev.b[last.move.to[0]][last.move.to[1]]||(last.move.ep?prev.b[last.move.from[0]][last.move.to[1]]:null);if(victim)capturedBy[state.turn].pop();}selected=null;legalTargets=[];syncPieces();paintHighlights();updateUI();}
function resetGame(){state=initialState();history=[];capturedBy={w:[],b:[]};selected=null;legalTargets=[];syncPieces();paintHighlights();updateUI();document.querySelector('#game-over').hidden=true;notify('A fresh game. White to move.');}
function hitTest(event){const rect=canvas.getBoundingClientRect();const pointerNdc=new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-((event.clientY-rect.top)/rect.height)*2+1);raycaster.setFromCamera(pointerNdc,camera);const hits=raycaster.intersectObjects(pieceGroup.children,true);for(const h of hits){let o=h.object;while(o&&o!==pieceGroup&&!o.userData.square)o=o.parent;if(o?.userData.square)return o.userData.square;}const squares=raycaster.intersectObjects(squareMeshes,false);return squares[0]?.object.userData.square||null;}
canvas.addEventListener('pointerdown',e=>{if(e.button!==undefined&&e.button!==0)return;pointer={x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,id:e.pointerId};dragged=false;canvas.setPointerCapture?.(e.pointerId);});
canvas.addEventListener('pointermove',e=>{if(!pointer)return;const dx=e.clientX-pointer.lastX,dy=e.clientY-pointer.lastY;if(Math.hypot(e.clientX-pointer.x,e.clientY-pointer.y)>5)dragged=true;if(dragged){orbit.theta-=dx*.008;orbit.phi=Math.max(.35,Math.min(1.13,orbit.phi+dy*.006));updateCamera();}pointer.lastX=e.clientX;pointer.lastY=e.clientY;});
canvas.addEventListener('pointerup',e=>{if(!pointer)return;const wasDrag=dragged;pointer=null;if(!wasDrag){const sq=hitTest(e);if(sq)handleSquare(sq);}});
canvas.addEventListener('pointercancel',()=>pointer=null);canvas.addEventListener('wheel',e=>{e.preventDefault();orbit.radius=Math.max(10,Math.min(19,orbit.radius+Math.sign(e.deltaY)*.7));updateCamera();},{passive:false});
document.querySelector('#undo-button').addEventListener('click',undo);document.querySelector('#new-game').addEventListener('click',resetGame);document.querySelector('#play-again').addEventListener('click',resetGame);document.querySelector('#flip-button').addEventListener('click',()=>{flipped=!flipped;orbit.theta+=Math.PI;updateCamera();});
window.addEventListener('keydown',e=>{if(e.key==='Escape'){selected=null;legalTargets=[];paintHighlights();}if(e.key.toLowerCase()==='u'&&!e.repeat)undo();});
state=initialState();init3D();paintHighlights();updateUI();
