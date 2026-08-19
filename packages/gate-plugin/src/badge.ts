/**
 * 装配可观测徽章:注入 DSH Web 页面(webServer.tapIndex),
 * 让用户一进页面就看到——装配了哪个 harness 配置、四层门禁各有什么。
 * 零 fork:走 DSH 官方注入点,随 preset 自动携带。
 */
import { type GateDefinition } from '@dsh-agent-builder/gate-engine'

export interface BadgeInfo {
  readonly name: string
  readonly description: string
  readonly layers: { readonly structural: number; readonly rule: number; readonly grounding: number; readonly aiReview: number }
  readonly maxRetries: number
  readonly promptInjected: boolean
  readonly feedbackOn: boolean
}

const STRUCTURAL = new Set(['required', 'number', 'date', 'enum'])
const RULE = new Set(['compare', 'not-future'])

/** 从门禁定义汇总徽章信息。 */
export function badgeInfo(gate: GateDefinition, maxRetries: number, promptInjected: boolean, feedbackOn: boolean): BadgeInfo {
  let structural = 0, rule = 0, grounding = 0
  for (const c of gate.checks) {
    if (STRUCTURAL.has(c.type)) structural++
    else if (RULE.has(c.type)) rule++
    else grounding++
  }
  return {
    name: gate.name,
    description: gate.description ?? '',
    layers: { structural, rule, grounding, aiReview: gate.aiReview?.length ?? 0 },
    maxRetries,
    promptInjected,
    feedbackOn,
  }
}

/** 生成注入 index.html 的自包含徽章片段(样式+脚本内联,无外部依赖)。 */
export function badgeHtml(info: BadgeInfo): string {
  const data = JSON.stringify(info).replaceAll('<', '\\u003c')
  return `
<script id="gate-badge-loader">(function(){
  var I=${data};
  var s=document.createElement('style');
  s.textContent='#gate-badge{position:fixed;left:14px;bottom:14px;z-index:99999;font:12px/1.5 ui-monospace,Menlo,monospace}'
    +'#gate-badge .chip{display:inline-flex;align-items:center;gap:6px;background:#0e141f;color:#4ade80;border:1px solid #1d3a2a;border-radius:99px;padding:5px 12px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4)}'
    +'#gate-badge .panel{display:none;position:absolute;left:0;bottom:34px;width:280px;background:#0e141f;color:#c9d6e4;border:1px solid #1d2836;border-radius:10px;padding:12px 14px;box-shadow:0 6px 24px rgba(0,0,0,.5)}'
    +'#gate-badge.open .panel{display:block}'
    +'#gate-badge .panel h4{margin:0 0 6px;color:#22d3ee;font-size:12px}'
    +'#gate-badge .panel p{margin:3px 0;color:#8aa0b8}'
    +'#gate-badge .panel b{color:#c9d6e4;font-weight:600}';
  document.head.appendChild(s);
  var d=document.createElement('div');
  d.id='gate-badge';
  d.innerHTML='<div class="panel"><h4>'+I.name+'</h4>'
    +(I.description?'<p>'+I.description+'</p>':'')
    +'<p>门禁:<b>①结构 '+I.layers.structural+' · ②规则 '+I.layers.rule+' · ③对照 '+I.layers.grounding+'</b></p>'
    +'<p>④独立评审:<b>'+(I.layers.aiReview>0?I.layers.aiReview+' 项':'未配置')+'</b> · 重试上限 <b>'+I.maxRetries+'</b></p>'
    +'<p>专属提示词:<b>'+(I.promptInjected?'已注入':'未配置')+'</b> · 运行回流:<b>'+(I.feedbackOn?'开':'关')+'</b></p>'
    +'<p id="gate-live">本次会话:等待统计…</p>'
    +'<p style="margin-top:6px;color:#5c6b7d">产出不合格会被自动打回重做</p></div>'
    +'<span class="chip">🛡 已装配:'+I.name+' <b id="gate-count"></b></span>';
  d.querySelector('.chip').addEventListener('click',function(){d.classList.toggle('open')});
  document.body.appendChild(d);
  function poll(){
    fetch('/gate/status').then(function(r){return r.json()}).then(function(st){
      var c=st.counters;
      document.getElementById('gate-count').textContent='✓'+c.pass+' ✗'+c.block+(c.steer>0?' ↩'+c.steer:'');
      document.getElementById('gate-live').innerHTML='本次会话:放行 <b>'+c.pass+'</b> · 拦截 <b>'+c.block+'</b> · 打回重做 <b>'+c.steer+'</b> 次'
        +(c.degraded>0?' · <span style="color:#fbbf24">评审降级放行 '+c.degraded+'</span>':'');
    }).catch(function(){})
  }
  poll(); setInterval(poll, 5000);
})()</script>`
}
