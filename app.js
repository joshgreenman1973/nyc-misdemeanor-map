/* NYC misdemeanors & violations map. Vanilla JS + Leaflet + hand-rolled SVG charts. */
'use strict';

const GCOL = { proactive:'#c1432f', victim:'#2f6b8f', other:'#9a9488' };
const GNAME = { proactive:'Enforcement-sensitive', victim:'Complaint-driven', other:'Other / mixed' };
const BORO_COL = { 'Manhattan':'#c1432f','Brooklyn':'#2f4b7c','Queens':'#d4a017','Bronx':'#1f7a6b','Staten Island':'#7a4f9e' };
const BOROS = ['Manhattan','Brooklyn','Queens','Bronx','Staten Island'];
const RAMP = ['#f3ead0','#e9c79a','#dd9a6c','#cc6a4b','#a83a2c','#6f1f14']; // cream -> deep red

const EVENTS = [
  { year:2018, label:'NYPD ends most marijuana-possession arrests' },
  { year:2020, label:'COVID-19 pandemic; bail reform takes effect' },
  { year:2021, label:'New York legalizes cannabis (MRTA)' },
  { year:2022, label:'Mayor Adams takes office' },
];

const fmt = n => n.toLocaleString('en-US');
const pct1 = n => (n*100).toFixed(1) + '%';

const state = {
  lens: 'complaints',
  law: 'all',          // 'all' | 0 (misd) | 1 (viol)
  metric: 'count',     // 'count' | 'share'
  year: 2025,
  offsel: new Set(),   // selected offense ids
  precinct: null,
  zero: { group:true, compare:true, boro:true },
  showEvents: true,
};

let DATA, geo, map, geoLayer, tip;
const byPctLayer = {};

fetch('data/data.json').then(r=>r.json()).then(d=>{
  DATA = d;
  return fetch('data/precincts.json').then(r=>r.json());
}).then(g=>{ geo = g; init(); }).catch(e=>{
  document.getElementById('map').innerHTML = '<p style="padding:20px">Could not load data: '+e+'</p>';
});

/* ---------- helpers over the row arrays [yr,pct,oid,lawcatIdx,n] ---------- */
const G = oid => DATA.offenses[oid].group;
function rows(){ return DATA[state.lens]; }
function passLaw(r){ return state.law==='all' || r[3]===state.law; }
function passSel(r){ return state.offsel.has(r[2]); }

// total for current selection (lens+law+offense set) in a given year, optional pct
function totalFor(year, pct){
  let s=0; for(const r of rows()){
    if(r[0]!==year) continue; if(pct!=null && r[1]!==pct) continue;
    if(!passLaw(r) || !passSel(r)) continue; s+=r[4];
  } return s;
}
// per-precinct count for selection in year
function perPrecinct(year){
  const m={}; for(const r of rows()){
    if(r[0]!==year || !passLaw(r) || !passSel(r)) continue;
    m[r[1]]=(m[r[1]]||0)+r[4];
  } return m;
}
// per-precinct enforcement-sensitive share in year (ignores offense selection; respects lens+law)
function perPrecinctShare(year){
  const pro={}, tot={};
  for(const r of rows()){
    if(r[0]!==year || !passLaw(r)) continue;
    tot[r[1]]=(tot[r[1]]||0)+r[4];
    if(G(r[2])==='proactive') pro[r[1]]=(pro[r[1]]||0)+r[4];
  }
  const m={}; for(const p in tot){ m[p]= tot[p] ? (pro[p]||0)/tot[p] : 0; }
  return {share:m, tot};
}
// citywide series by group, per lens
function groupSeries(lens){
  const out={proactive:{},victim:{},other:{}};
  for(const r of DATA[lens]){ if(!passLaw(r)) continue;
    out[G(r[2])][r[0]]=(out[G(r[2])][r[0]]||0)+r[4]; }
  return out;
}
// citywide series for current offense selection, per lens
function selSeries(lens){
  const o={}; for(const r of DATA[lens]){ if(!passLaw(r)||!state.offsel.has(r[2])) continue;
    o[r[0]]=(o[r[0]]||0)+r[4]; } return o;
}
// borough series for current selection, current lens
function boroSeries(){
  const pb={}; DATA.precincts.forEach(p=>pb[p.pct]=p.boro);
  const out={}; BOROS.forEach(b=>out[b]={});
  for(const r of rows()){ if(!passLaw(r)||!passSel(r)) continue;
    const b=pb[r[1]]; if(!out[b]) continue; out[b][r[0]]=(out[b][r[0]]||0)+r[4]; }
  return out;
}
function offenseTotals(lens){ // total per oid across all years (for picker counts), respects law
  const m={}; for(const r of DATA[lens]){ if(!passLaw(r)) continue; m[r[2]]=(m[r[2]]||0)+r[4]; } return m;
}

/* ---------- init ---------- */
function init(){
  tip = document.getElementById('tip');
  document.getElementById('genDate').textContent = DATA.generated;
  DATA.offenses.forEach((o,i)=>state.offsel.add(i)); // default: all selected

  // year slider
  const ys=document.getElementById('yearSlider');
  ys.min=0; ys.max=DATA.years.length-1;
  state.year = 2025; ys.value = DATA.years.indexOf(2025);
  ys.addEventListener('input',()=>{ state.year=DATA.years[+ys.value]; document.getElementById('yearVal').textContent=yearLabel(state.year); renderYearDependent(); });
  document.getElementById('yearVal').textContent = yearLabel(state.year);

  // segmented controls
  seg('lensSeg', v=>{ state.lens=v; buildPicker(); renderAll(); });
  seg('lawSeg', v=>{ state.law = v==='all'?'all':+v; buildPicker(); renderAll(); });
  seg('metricSeg', v=>{ state.metric=v; renderMap(); });

  // offense picker
  document.getElementById('offSearch').addEventListener('input', buildPicker);
  document.querySelectorAll('.pickbtns button').forEach(b=>b.addEventListener('click',()=>{
    const k=b.dataset.pick;
    if(k==='all') DATA.offenses.forEach((o,i)=>state.offsel.add(i));
    else if(k==='none') state.offsel.clear();
    else { state.offsel.clear(); DATA.offenses.forEach((o,i)=>{ if(o.group===k) state.offsel.add(i); }); }
    buildPicker(); renderAll();
  }));

  // toggles
  bindTog('zeroGroup','group',renderGroupTrend);
  bindTog('zeroCompare','compare',renderCompare);
  bindTog('zeroBoro','boro',renderBoro);
  document.getElementById('showEvents').addEventListener('change',e=>{ state.showEvents=e.target.checked; renderGroupTrend(); renderCompare(); renderBoro(); });

  // events list
  document.getElementById('eventList').innerHTML = EVENTS.map(e=>`<span class="pill">${e.year}: ${e.label}</span>`).join('') +
    ' &mdash; shown as neutral reference lines only.';

  initMap();
  buildPicker();
  renderAll();
  initPlay();
}
function yearLabel(y){ return y===2026 ? '2026 (Q1)' : ''+y; }
function seg(id,cb){ const el=document.getElementById(id);
  el.addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return;
    [...el.children].forEach(c=>c.setAttribute('aria-pressed', c===b)); cb(b.dataset.v); }); }
function bindTog(id,key,fn){ document.getElementById(id).addEventListener('change',e=>{ state.zero[key]=e.target.checked; fn(); }); }

/* ---------- offense picker ---------- */
function buildPicker(){
  const q=(document.getElementById('offSearch').value||'').toLowerCase();
  const tot=offenseTotals(state.lens);
  const groups={proactive:[],victim:[],other:[]};
  DATA.offenses.forEach((o,i)=>{ if(q && !o.label.toLowerCase().includes(q)) return; groups[o.group].push(i); });
  let html='';
  ['proactive','victim','other'].forEach(g=>{
    if(!groups[g].length) return;
    html+=`<div class="offgrp"><span class="dot" style="background:${GCOL[g]}"></span>${GNAME[g]}</div>`;
    groups[g].sort((a,b)=>(tot[b]||0)-(tot[a]||0)).forEach(i=>{
      const o=DATA.offenses[i];
      html+=`<div class="offrow"><input type="checkbox" data-oid="${i}" ${state.offsel.has(i)?'checked':''}>
        <label data-oid="${i}">${o.label}</label><span class="c">${fmt(tot[i]||0)}</span></div>`;
    });
  });
  const wrap=document.getElementById('offWrap'); wrap.innerHTML=html||'<div class="detailempty">No offenses match.</div>';
  wrap.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.addEventListener('change',()=>{
    const i=+cb.dataset.oid; cb.checked?state.offsel.add(i):state.offsel.delete(i); renderAll();
  }));
  wrap.querySelectorAll('label[data-oid]').forEach(l=>l.addEventListener('click',()=>{
    const i=+l.dataset.oid; const cb=wrap.querySelector(`input[data-oid="${i}"]`); cb.checked=!cb.checked;
    cb.checked?state.offsel.add(i):state.offsel.delete(i); renderAll();
  }));
}

/* ---------- map ---------- */
function initMap(){
  map = L.map('map',{scrollWheelZoom:true, zoomControl:true}).setView([40.705,-73.93],10);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png',{
    attribution:'&copy; OpenStreetMap &copy; CARTO', subdomains:'abcd', maxZoom:19
  }).addTo(map);
  geoLayer = L.geoJSON(geo,{
    style:f=>baseStyle(),
    onEachFeature:(f,layer)=>{
      const p=f.properties.pct; byPctLayer[p]=layer;
      layer.on({
        mouseover:e=>{ layer.setStyle({weight:2.5,color:'#1b1b1a'}); layer.bringToFront(); showPctTip(e,p); },
        mousemove:e=>moveTip(e),
        mouseout:e=>{ geoLayer.resetStyle(layer); restyleOne(p); hideTip(); },
        click:()=>{ state.precinct=p; renderDetail(); highlightSelected(); }
      });
    }
  }).addTo(map);
}
function baseStyle(){ return {weight:0.7,color:'#9a9488',fillColor:'#eee',fillOpacity:0.85}; }

function mapValues(){
  if(state.metric==='share'){ const {share}=perPrecinctShare(state.year); return {vals:share, max:1, isShare:true}; }
  const vals=perPrecinct(state.year); let max=0; for(const p in vals) max=Math.max(max,vals[p]);
  return {vals, max, isShare:false};
}
let _scale={breaks:[],isShare:false,max:0};
function colorFor(v,info){
  if(v==null) return '#eeece4';
  if(info.isShare){ const idx=Math.min(RAMP.length-1, Math.floor(v*RAMP.length)); return RAMP[idx]; }
  if(info.max<=0) return RAMP[0];
  for(let i=0;i<_scale.breaks.length;i++){ if(v<=_scale.breaks[i]) return RAMP[i]; }
  return RAMP[RAMP.length-1];
}
function computeBreaks(info){
  if(info.isShare){ _scale={isShare:true}; return; }
  const arr=Object.values(info.vals).filter(v=>v>0).sort((a,b)=>a-b);
  const breaks=[];
  for(let i=1;i<=RAMP.length;i++){ const q=arr.length?arr[Math.min(arr.length-1,Math.floor(arr.length*i/RAMP.length))]:0; breaks.push(q); }
  _scale={breaks,isShare:false,max:info.max};
}
function renderMap(){
  const info=mapValues(); computeBreaks(info); _mapInfo=info;
  for(const p in byPctLayer) restyleOne(p, info);
  document.getElementById('mapTitle').textContent = state.metric==='share'
    ? 'Enforcement-sensitive share of incidents, by precinct'
    : 'Incident count by precinct';
  document.getElementById('mapNote').textContent = mapNoteText();
  renderLegend(info);
  highlightSelected();
}
let _mapInfo=null;
function restyleOne(p, info){ info=info||_mapInfo; if(!info||!byPctLayer[p]) return;
  const v=info.vals[p]; byPctLayer[p].setStyle({fillColor:colorFor(v,info), weight:0.7, color:'#9a9488', fillOpacity:0.85}); }
function highlightSelected(){ if(state.precinct!=null && byPctLayer[state.precinct]){
  const l=byPctLayer[state.precinct]; l.setStyle({weight:3,color:'#1b1b1a'}); l.bringToFront(); } }
function mapNoteText(){
  const lens = state.lens==='complaints'?'complaints (reported)':'arrests (enforcement)';
  const law = state.law==='all'?'misdemeanors + violations':(state.law===0?'misdemeanors only':'violations only');
  const sel = state.offsel.size===DATA.offenses.length?'all offenses':`${state.offsel.size} selected offense type(s)`;
  return `${lens} · ${law} · ${state.metric==='share'?'share is computed over all offenses':sel} · ${yearLabel(state.year)}`;
}
function renderLegend(info){
  const el=document.getElementById('legend');
  if(info.isShare){
    el.innerHTML = '<div style="width:100%"><div style="display:flex">'+
      RAMP.map((c,i)=>`<span class="box" style="background:${c}"></span>`).join('')+
      '</div><div class="lbls"><span>0%</span><span>50%</span><span>100% enforcement-sensitive</span></div></div>';
  } else {
    const b=_scale.breaks;
    el.innerHTML = '<div style="width:100%"><div style="display:flex">'+
      RAMP.map(c=>`<span class="box" style="background:${c}"></span>`).join('')+
      '</div><div class="lbls"><span>0</span><span>'+fmt(b[Math.floor(b.length/2)]||0)+'</span><span>'+fmt(info.max)+' incidents</span></div></div>';
  }
}
function showPctTip(e,p){
  const info=_mapInfo; const meta=DATA.precincts.find(x=>x.pct===p)||{boro:''};
  let body;
  if(info && info.isShare){ const {share,tot}=perPrecinctShare(state.year);
    body=`${pct1(share[p]||0)} enforcement-sensitive<br>${fmt(tot[p]||0)} total incidents`; }
  else { body=`${fmt((info&&info.vals[p])||0)} incidents`; }
  tip.innerHTML=`<strong>Precinct ${p}</strong> · ${meta.boro}<br>${body}<br><span style="opacity:.7">${yearLabel(state.year)} · click for detail</span>`;
  moveTip(e); tip.style.opacity=1;
}
function moveTip(e){ const ev=e.originalEvent||e; tip.style.left=(ev.pageX+14)+'px'; tip.style.top=(ev.pageY+12)+'px'; }
function hideTip(){ tip.style.opacity=0; }

/* ---------- KPIs ---------- */
function renderKPIs(){
  const yr=state.year, cur=totalFor(yr), prev=totalFor(yr-1);
  const pp=perPrecinct(yr); let topP=null,topV=-1; for(const p in pp){ if(pp[p]>topV){topV=pp[p];topP=p;} }
  const {share}=(()=>{ const pro={},tot={}; for(const r of rows()){ if(r[0]!==yr||!passLaw(r)) continue;
      tot.a=(tot.a||0)+r[4]; if(G(r[2])==='proactive') pro.a=(pro.a||0)+r[4]; }
      return {share: tot.a? pro.a/tot.a : 0}; })();
  let chg='';
  if(yr===2026){ chg=`<div class="meta">Q1 only — not comparable to full years</div>`; }
  else if(prev>0){ const d=(cur-prev)/prev; const cls=d>=0?'up':'down';
    chg=`<div class="meta ${cls}">${d>=0?'▲':'▼'} ${pct1(Math.abs(d))} vs ${yr-1}</div>`; }
  const boro=(DATA.precincts.find(x=>x.pct==topP)||{}).boro||'';
  document.getElementById('kpis').innerHTML = card('Incidents, '+yearLabel(yr), fmt(cur),
      state.offsel.size===DATA.offenses.length?'all offense types':state.offsel.size+' offense type(s)')
    + card('Change', yr===2026?'—':(cur>=prev?'+':'−')+fmt(Math.abs(cur-prev)), '', chg)
    + card('Enforcement-sensitive share', pct1(share), 'of all '+(state.lens)+' this year')
    + card('Top precinct', topP?('#'+topP):'—', topP?(boro+' · '+fmt(topV)+' incidents'):'');
}
function card(lab,val,meta,extra){ return `<div class="kpi"><div class="lab">${lab}</div>
  <div class="val num">${val}</div>${extra||(meta?`<div class="meta">${meta}</div>`:'')}</div>`; }

/* ---------- SVG line chart ---------- */
function lineChart(elId, series, opt){
  opt=opt||{}; const el=document.getElementById(elId);
  const W=el.clientWidth||560, H=opt.height||250, m={t:14,r:14,b:26,l:52};
  const years=DATA.years, xmin=years[0], xmax=years[years.length-1];
  let ymax=0, ymin=Infinity;
  series.forEach(s=>s.values.forEach(v=>{ if(v.y>ymax)ymax=v.y; if(v.y<ymin)ymin=v.y; }));
  if(!isFinite(ymin)) ymin=0;
  const zero = opt.zero!==false; const lo = zero?0:Math.max(0, ymin*0.92); const hi = ymax*1.06||1;
  const X=y=>m.l+(y-xmin)/(xmax-xmin||1)*(W-m.l-m.r);
  const Y=v=>H-m.b-(v-lo)/(hi-lo||1)*(H-m.t-m.b);
  let s=`<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" data-el="${elId}">`;
  // y gridlines
  const ticks=4; for(let i=0;i<=ticks;i++){ const val=lo+(hi-lo)*i/ticks; const yy=Y(val);
    s+=`<line class="gridline" x1="${m.l}" x2="${W-m.r}" y1="${yy}" y2="${yy}"/>`;
    s+=`<text class="axislab" x="${m.l-6}" y="${yy+3}" text-anchor="end">${fmt(Math.round(val))}</text>`; }
  // x labels
  years.forEach(y=>{ if(y%2===1 && y!==xmax) return; s+=`<text class="axislab" x="${X(y)}" y="${H-8}" text-anchor="middle">${y===2026?"'26 Q1":"'"+String(y).slice(2)}</text>`; });
  // events
  if(state.showEvents && opt.events!==false){ EVENTS.forEach(e=>{ const xx=X(e.year);
    s+=`<line class="evline" x1="${xx}" x2="${xx}" y1="${m.t}" y2="${H-m.b}"/>`;
    s+=`<text class="evlab" x="${xx+3}" y="${m.t+9}" >${e.year}</text>`; }); }
  // lines (split solid 2015-2025, dashed 2025->2026 to flag partial)
  series.forEach(se=>{
    const pts=se.values.slice().sort((a,b)=>a.x-b.x);
    let dFull='', dPart='';
    for(let i=0;i<pts.length;i++){ const p=pts[i], cmd=(i===0?'M':'L')+X(p.x)+' '+Y(p.y);
      if(p.x<=2025) dFull+=cmd+' '; }
    const p25=pts.find(p=>p.x===2025), p26=pts.find(p=>p.x===2026);
    if(p25&&p26) dPart=`M${X(2025)} ${Y(p25.y)} L${X(2026)} ${Y(p26.y)}`;
    s+=`<path d="${dFull}" fill="none" stroke="${se.color}" stroke-width="2.2"/>`;
    if(dPart) s+=`<path d="${dPart}" fill="none" stroke="${se.color}" stroke-width="2.2" stroke-dasharray="4 3"/>`;
    pts.forEach(p=>{ s+=`<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="3" fill="${se.color}"
      data-x="${p.x}" data-name="${se.name}" data-y="${p.y}"/>`; });
  });
  s+='</svg>';
  el.innerHTML=s;
  // hover
  el.querySelectorAll('circle').forEach(c=>{
    c.addEventListener('mouseenter',ev=>{ tip.innerHTML=`<strong>${c.dataset.name}</strong><br>${c.dataset.x==='2026'?'2026 Q1':c.dataset.x}: ${fmt(+c.dataset.y)}`;
      tip.style.opacity=1; moveTip(ev); });
    c.addEventListener('mousemove',moveTip);
    c.addEventListener('mouseleave',hideTip);
  });
}
function legendHtml(elId, items){ document.getElementById(elId).innerHTML =
  items.map(i=>`<span><i style="background:${i.color}"></i>${i.name}</span>`).join(''); }
function toSeries(obj,name,color){ return {name,color,values:DATA.years.map(y=>({x:y,y:obj[y]||0}))}; }

/* ---------- charts ---------- */
function renderGroupTrend(){
  const gs=groupSeries(state.lens);
  const series=['proactive','victim','other'].map(g=>toSeries(gs[g],GNAME[g],GCOL[g]));
  lineChart('groupTrend',series,{zero:state.zero.group,height:240});
  legendHtml('groupLegend',series);
}
function renderCompare(){
  const c=selSeries('complaints'), a=selSeries('arrests');
  const series=[ toSeries(c,'Complaints (reported)','#2f6b8f'), toSeries(a,'Arrests (enforcement)','#c1432f') ];
  lineChart('compareChart',series,{zero:state.zero.compare,height:260});
  legendHtml('compareLegend',series);
  const lbl=document.getElementById('compareSelLabel');
  if(lbl){ const n=state.offsel.size, tot=DATA.offenses.length;
    lbl.textContent = n===tot ? 'all offenses' : (n===0 ? 'no offenses selected' : n+' selected offense type(s)'); }
}
function renderBoro(){
  const bs=boroSeries();
  const series=BOROS.map(b=>toSeries(bs[b],b,BORO_COL[b]));
  lineChart('boroChart',series,{zero:state.zero.boro,height:250});
  legendHtml('boroLegend',series);
}

/* ---------- ranking ---------- */
function renderRank(){
  const pp=perPrecinct(state.year); const pb={}; DATA.precincts.forEach(p=>pb[p.pct]=p.boro);
  const arr=Object.entries(pp).map(([p,v])=>({p:+p,v,boro:pb[p]})).sort((a,b)=>b.v-a.v);
  const max=arr.length?arr[0].v:1;
  document.getElementById('rankNote').textContent = `${state.lens}, ${yearLabel(state.year)} — top 15 of ${arr.length} precincts for the current selection.`;
  let h='<table class="rank"><tr><th>#</th><th>Precinct</th><th>Borough</th><th style="text-align:right">Incidents</th><th></th></tr>';
  arr.slice(0,15).forEach((r,i)=>{ h+=`<tr style="cursor:pointer" data-p="${r.p}"><td>${i+1}</td><td>#${r.p}</td><td>${r.boro}</td>
    <td class="n">${fmt(r.v)}</td><td style="width:34%"><span class="bar" style="width:${Math.max(2,r.v/max*100)}%;background:${BORO_COL[r.boro]||'#c1432f'}"></span></td></tr>`; });
  h+='</table>';
  const t=document.getElementById('rankTable'); t.innerHTML=h;
  t.querySelectorAll('tr[data-p]').forEach(tr=>tr.addEventListener('click',()=>{ state.precinct=+tr.dataset.p; renderDetail(); highlightSelected();
    if(byPctLayer[state.precinct]) map.fitBounds(byPctLayer[state.precinct].getBounds(),{maxZoom:13,padding:[40,40]}); }));
}

/* ---------- precinct detail ---------- */
function renderDetail(){
  const p=state.precinct; if(p==null) return;
  const meta=DATA.precincts.find(x=>x.pct===p)||{boro:''};
  document.getElementById('detailTitle').textContent=`Precinct ${p} · ${meta.boro}`;
  // trend for current selection at this precinct
  const ser={}; for(const r of rows()){ if(r[1]!==p||!passLaw(r)||!passSel(r)) continue; ser[r[0]]=(ser[r[0]]||0)+r[4]; }
  // top offenses this year at this precinct
  const yr=state.year; const off={};
  for(const r of rows()){ if(r[1]!==p||r[0]!==yr||!passLaw(r)) continue; off[r[2]]=(off[r[2]]||0)+r[4]; }
  const top=Object.entries(off).map(([o,v])=>({o:+o,v})).sort((a,b)=>b.v-a.v).slice(0,8);
  const tmax=top.length?top[0].v:1;
  // enforcement share at precinct this year
  let pro=0,tot=0; for(const r of rows()){ if(r[1]!==p||r[0]!==yr||!passLaw(r)) continue; tot+=r[4]; if(G(r[2])==='proactive') pro+=r[4]; }
  let h=`<div class="note">Enforcement-sensitive share in ${yearLabel(yr)}: <strong>${pct1(tot?pro/tot:0)}</strong> · ${fmt(tot)} total incidents (${state.lens})</div>`;
  h+='<div id="detTrend"></div>';
  h+=`<h3 style="margin-top:10px;font-size:13px">Top offenses, ${yearLabel(yr)}</h3><table class="rank">`;
  top.forEach(t=>{ const o=DATA.offenses[t.o]; h+=`<tr><td><span class="pill" style="border-color:${GCOL[o.group]};color:${GCOL[o.group]}">${GNAME[o.group][0]}</span></td>
    <td>${o.label}</td><td class="n">${fmt(t.v)}</td><td style="width:36%"><span class="bar" style="width:${Math.max(2,t.v/tmax*100)}%;background:${GCOL[o.group]}"></span></td></tr>`; });
  h+='</table>';
  const body=document.getElementById('detailBody'); body.innerHTML=h;
  lineChart('detTrend',[toSeries(ser,'Precinct '+p+' (current selection)','#1b1b1a')],{zero:true,height:170,events:true});
}

/* ---------- orchestration ---------- */
function renderYearDependent(){ renderMap(); renderKPIs(); renderRank(); if(state.precinct!=null) renderDetail(); }
function renderAll(){
  renderMap(); renderKPIs(); renderRank();
  renderGroupTrend(); renderCompare(); renderBoro();
  if(state.precinct!=null) renderDetail();
}
window.addEventListener('resize', ()=>{ renderGroupTrend(); renderCompare(); renderBoro(); if(state.precinct!=null) renderDetail(); });

/* ---------- play ---------- */
function initPlay(){
  let timer=null; const btn=document.getElementById('playBtn'); const ys=document.getElementById('yearSlider');
  btn.addEventListener('click',()=>{
    if(timer){ clearInterval(timer); timer=null; btn.innerHTML='&#9658;'; return; }
    btn.innerHTML='&#10073;&#10073;';
    timer=setInterval(()=>{ let v=+ys.value+1; if(v>+ys.max) v=0; ys.value=v;
      state.year=DATA.years[v]; document.getElementById('yearVal').textContent=yearLabel(state.year); renderYearDependent();
    },1100);
  });
}
