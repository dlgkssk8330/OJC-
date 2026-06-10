'use strict';
// ============================================================
// app.js — OJC 수입품목 발주 계획 메인 로직
// ============================================================

// ── 구매처 약칭
const SUP_SHORT = {
  'Fiberwit Link Communication Co.,LTD':     'Fiberwit',
  'Shenzhen Fibercan Optical Co., Ltd':       'Fibercan(SZ)',
  'Huizhou Fibercan Industrial Co.,Ltd':      'Fibercan(HZ)',
  'CFOFC Communications (Shenzhen) Co., Ltd': 'CFOFC',
  'Henan Shijia Photons Technology Co.,Ltd':  'Shijia',
};

// ── 전역 상태
let G = {
  items:      [],      // 현재 품목 목록
  prices:     {},      // { code: {import_price,maeksan_cost,prod_cost,std_ratio,standard_cost} }
  orderPlan:  {},      // { code: {order_qty,is_confirmed,confirmed_by} }
  settings:   {},      // { std_cost_ratio, admin_pw_hash, ... }
  curFilter:  'all',
  curSearch:  '',
  curSupplier:'',
  curTrend:   '',
  showCost:   false,
  sortCol:    'urgency',
  sortDir:    'asc',
  stdRatio:   DEFAULT_STD_RATIO,
  priceModalCode: null,
  adminCallback:  null,
  uploadParsed:   null,  // 업로드 파싱된 데이터 임시 보관
  clientIP:       'unknown',
};

// ── 수치 파싱
const num = v => {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  const n = parseFloat(String(v).replace(/[,\s]/g, ''));
  return isNaN(n) ? null : n;
};
const fmt = (v, d = 0) => {
  const n = num(String(v ?? ''));
  if (n === null) return '-';
  return n.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const fmtW = v => { // 원화 표시
  const n = num(String(v ?? ''));
  if (n === null) return '-';
  return n.toLocaleString('ko-KR') + '원';
};
function round(n, step) { return Math.ceil(n / step) * step; }

// ── IP 주소 가져오기
async function fetchIP() {
  try {
    const r = await fetch('https://api64.ipify.org?format=json', { signal: AbortSignal.timeout(4000) });
    G.clientIP = (await r.json()).ip || 'unknown';
  } catch { G.clientIP = 'unknown'; }
}

// ── SHA-256 해시
async function sha256(msg) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ── 가용재고(월) 색상
function fmtAvail(v) {
  const n = num(v);
  if (n === null) return '<span class="av-na">-</span>';
  const cls = n < 0 ? 'av-crit' : n < 2 ? 'av-crit' : n < 4 ? 'av-warn' : 'av-ok';
  return `<span class="${cls}">${n.toFixed(1)}개월</span>`;
}

// ── 발주 알고리즘
function calcUrgency(item) {
  const avg = num(item.avg_cur) || num(item.avg_prev) || 0;
  if (avg === 0) return 'na';
  const avail = num(item.avail_mo_incl);
  if (avail === null) return 'na';
  if (avail < 2) return 'urgent';
  if (avail < 4) return 'warning';
  return 'ok';
}

function calcRecQty(item) {
  const avg = num(item.avg_cur) || num(item.avg_prev) || 0;
  if (avg === 0) return 0;
  const stock = Math.max(0, num(item.stock) ?? 0);
  const inc   = Math.max(0, num(item.incoming) ?? 0);
  const need  = avg * TARGET_MONTHS - stock - inc;
  if (need <= 0) return 0;
  return Math.ceil(need / 10) * 10;
}

function calcProjAvail(item, orderQty) {
  const avg = num(item.avg_cur) || num(item.avg_prev) || 0;
  if (avg === 0) return null;
  const stock = Math.max(0, num(item.stock) ?? 0);
  const inc   = Math.max(0, num(item.incoming) ?? 0);
  return (stock + inc + (orderQty || 0)) / avg;
}

function calcTiming(item) {
  const urgency = item._urgency;
  if (urgency === 'na')      return { text: '—',       cls: 't-na' };
  if (urgency === 'urgent')  return { text: '즉시',    cls: 't-now' };
  const lt   = (num(item.leadtime) || DEFAULT_LEADTIME) / 30;
  const avail = num(item.avail_mo_incl) ?? 0;
  const left  = avail - lt;
  if (urgency === 'warning') return { text: left < 1 ? '1개월 내' : `${Math.floor(left)}개월 내`, cls: 't-soon' };
  return { text: `${Math.floor(left)}개월+ 여유`, cls: 't-later' };
}

// ── 조달방식: 수입가격 vs 맥산생산원가 비교
function calcProcMethod(code) {
  const imp = num(G.prices[code]?.import_price);
  const mac = num(G.prices[code]?.maeksan_cost);
  if (imp === null && mac === null) return { text: '—', cls: 'proc-na' };
  if (imp === null) return { text: '생산', cls: 'proc-prod' };
  if (mac === null) return { text: '수입', cls: 'proc-import' };
  if (imp < mac)   return { text: '수입', cls: 'proc-import' };
  if (mac < imp)   return { text: '생산', cls: 'proc-prod' };
  return { text: '동일', cls: 'proc-na' };
}

// ── 실효 생산원가 = min(수입가격, 맥산생산원가)
function calcEffectiveCost(code) {
  const pr  = G.prices[code] || {};
  const imp = num(pr.import_price);
  const mac = num(pr.maeksan_cost);
  if (imp !== null && mac !== null) return Math.min(imp, mac);
  return imp ?? mac ?? null;
}

// ── 비율 정규화
// - 10 초과 → ÷100 (139 → 1.39)
// - 1 미만  → null (0.72 같은 잘못된 값은 기본 비율로 fallback)
function normalizeRatio(r) {
  if (r === null || r === undefined) return null;
  const v = r > 10 ? r / 100 : r;
  return v >= 1 ? v : null;
}

// ── 표준원가 (실효 생산원가 × 비율)
function calcStdFromEffective(code) {
  const eff   = calcEffectiveCost(code);
  const raw   = num(G.prices[code]?.std_ratio) ?? G.stdRatio;
  const ratio = normalizeRatio(raw) ?? G.stdRatio;
  return eff !== null ? eff * ratio : null;
}

// ── 판매단가: 판매현황 평균판매단가 우선, 없으면 표준원가 fallback
function getSalePrice(code) {
  const analysis = (typeof computeItemSales === 'function') ? computeItemSales(code) : null;
  return analysis?.avgPrice ?? calcStdFromEffective(code);
}

// ── 손익금액 = 표준원가 - 생산원가
function calcProfitAmt(code) {
  const std = calcStdFromEffective(code);
  const eff = calcEffectiveCost(code);
  if (std === null || eff === null) return null;
  return std - eff;
}

// ── 수익률 = (판매단가 - 표준원가) / 판매단가 × 100
// 판매현황 데이터가 있을 때만 계산 (없으면 null → '—')
function calcProfitRate(code) {
  const analysis  = (typeof computeItemSales === 'function') ? computeItemSales(code) : null;
  const salePrice = analysis?.avgPrice ?? null;  // 판매현황 없으면 null (표준원가 fallback 없음)
  const std       = calcStdFromEffective(code);
  if (salePrice === null || std === null || salePrice === 0) return null;
  return ((salePrice - std) / salePrice) * 100;
}

// ── 맥산 vs 수입: 어느 쪽이 저렴한지
function cmpMaeksan(code) {
  const imp = num(G.prices[code]?.import_price);
  const mac = num(G.prices[code]?.maeksan_cost);
  if (imp === null || mac === null) return { text: '—', cls: 'cmp-na' };
  if (mac > imp) return { text: '✅ 수입 유리', cls: 'cmp-import' };
  if (mac < imp) return { text: '🔵 생산 유리', cls: 'cmp-prod' };
  return { text: '= 동일', cls: 'cmp-na' };
}

// ── 손익금액 셀 HTML
function fmtProfitAmt(amt) {
  if (amt === null) return '<span class="cmp-na">—</span>';
  const cls = amt >= 0 ? 'rate-pos' : 'rate-neg';
  return `<span class="${cls}" style="font-weight:700">${amt >= 0 ? '+' : ''}${amt.toLocaleString('ko-KR', {maximumFractionDigits:0})}</span>`;
}

// ── 수익률 셀 HTML
function fmtProfitRate(rate) {
  if (rate === null) return '<span class="cmp-na">—</span>';
  const cls = rate >= 0 ? 'rate-pos' : 'rate-neg';
  return `<span class="${cls}" style="font-weight:700">${rate >= 0 ? '+' : ''}${rate.toFixed(1)}%</span>`;
}

// (이전 cmpCost는 제거 - 이제 calcProfitAmt 사용)
function cmpCost(item) { return { text:'—', cls:'cmp-na' }; } // 호환성 유지

// ── 표준원가 계산
function calcStdCost(prodCost, ratio) {
  const p = num(prodCost);
  const r = normalizeRatio(num(ratio)) ?? G.stdRatio;
  if (p === null) return null;
  return p * r;
}

// ============================================================
// 데이터 로드
// ============================================================
async function loadData() {
  setHeaderSub('데이터 로딩 중…');
  // Supabase에서 시도
  if (DB.isReady()) {
    const [sbItems, sbPrices, sbPlan, sbSettings, sbSales, sbSalesMeta, sbIncoming] = await Promise.all([
      DB.loadLatestItems(),
      DB.loadPrices(),
      DB.loadOrderPlan(),
      DB.getSettings(),
      DB.pullSalesData(),
      DB.pullSalesMeta(),
      DB.pullIncomingData(),
    ]);
    if (sbSettings) {
      G.settings = sbSettings;
      G.stdRatio = normalizeRatio(num(sbSettings.std_cost_ratio)) ?? DEFAULT_STD_RATIO;
    }
    G.prices    = sbPrices || {};
    G.orderPlan = sbPlan   || {};
    // 판매·입고 데이터 Supabase 우선
    if (sbSales)          { G_sales.data = sbSales; G_sales.meta = sbSalesMeta||{}; saveSalesData(); setSyncTs('sales'); }
    if (sbIncoming?.length) { G_incoming = sbIncoming; saveIncomingData(); setSyncTs('incoming'); }
    G.items = (sbItems && sbItems.length > 0)
      ? sbItems.map(normalizeItem)
      : (typeof RAW_DATA !== 'undefined' ? RAW_DATA.map(normalizeItem) : []);
  } else {
    // static fallback
    G.items = (typeof RAW_DATA !== 'undefined') ? RAW_DATA.map(normalizeItem) : [];
    // localStorage 발주 계획
    try { G.orderPlan = JSON.parse(localStorage.getItem('ojc_order_plan') || '{}'); } catch {}
  }
  updateStats();
  renderTable();
  renderCostTab();
  renderConfirmedTab();
  setHeaderSub(`품목 ${G.items.length}건 · 기준일 2026-03-27`);
  document.getElementById('ratioDisplay').textContent = G.stdRatio;
  document.getElementById('ratioLabel').textContent   = `×${G.stdRatio}`;
  updateSyncBadge(DB.isReady());
}

// static data → 내부 형식 통일
function normalizeItem(it) {
  // Supabase items: avg_cur / avg_prev
  // RAW_DATA: avg26 / avg2425
  return {
    code:         it.code,
    name:         it.name,
    spec:         it.spec || '',
    supplier:     it.supplier || '',
    stock:        it.stock     ?? it.stock,
    incoming:     it.incoming  ?? it.incoming,
    leadtime:     it.leadtime  ?? 60,
    safety_stock: it.safety_stock ?? it.safetyStock ?? 0,
    avg_prev:     num(it.avg_prev  ?? it.avg2425) ?? 0,
    avg_cur:      num(it.avg_cur   ?? it.avg26)   ?? 0,
    trend:        it.trend || '',
    avail_mo:     num(it.avail_mo     ?? it.availMo)     ?? null,
    avail_mo_incl:num(it.avail_mo_incl?? it.availMoIncl) ?? null,
    _urgency:     null,
    _recQty:      null,
  };
}

// 파생 필드 보정 + 판매 데이터 통합
function enrichItem(it) {
  let avg_cur  = num(it.avg_cur)  ?? 0;
  let avg_prev = num(it.avg_prev) ?? 0;
  let _hasSalesData = false;

  // 판매현황 데이터가 있으면 우선 사용
  if (G_sales.data[it.code]) {
    const curYear  = String(new Date().getFullYear());
    const prevYear = String(new Date().getFullYear() - 1);
    const analysis = computeItemSales(it.code);
    if (analysis?.monthlyAvg[curYear])  { avg_cur  = analysis.monthlyAvg[curYear];  _hasSalesData = true; }
    if (analysis?.monthlyAvg[prevYear]) { avg_prev = analysis.monthlyAvg[prevYear]; _hasSalesData = true; }
  }

  const stock = num(it.stock) ?? 0;
  const inc   = num(it.incoming) ?? 0;
  const avgBase = avg_cur || avg_prev || 0;

  const enriched = {
    ...it,
    avg_cur,
    avg_prev,
    _hasSalesData,
    avail_mo:      (it.avail_mo      ?? (avgBase > 0 ? stock / avgBase        : null)),
    avail_mo_incl: (it.avail_mo_incl ?? (avgBase > 0 ? (stock + inc) / avgBase : null)),
  };
  enriched._urgency = calcUrgency(enriched);
  enriched._recQty  = calcRecQty(enriched);
  return enriched;
}

// ============================================================
// 필터 / 정렬
// ============================================================
const URG_ORD = { urgent:0, warning:1, ok:2, na:3 };

function getFiltered() {
  return G.items.map(enrichItem).filter(it => {
    const conf = !!G.orderPlan[it.code]?.is_confirmed;
    if (G.curFilter === 'urgent'    && it._urgency !== 'urgent')  return false;
    if (G.curFilter === 'warning'   && it._urgency !== 'warning') return false;
    if (G.curFilter === 'ok'        && it._urgency !== 'ok')      return false;
    if (G.curFilter === 'confirmed' && !conf)                     return false;
    if (G.curSupplier && it.supplier !== G.curSupplier)           return false;
    if (G.curTrend    && it.trend.trim() !== G.curTrend)          return false;
    if (G.curSearch) {
      const q = G.curSearch.toLowerCase();
      if (!it.code.toLowerCase().includes(q) && !it.name.toLowerCase().includes(q)) return false;
    }
    // 열 필터 적용
    for (const [cfKey, vals] of Object.entries(colFilters)) {
      if (!vals?.size) continue;
      if (!vals.has(getItemColDisplayVal(it, cfKey))) return false;
    }
    return true;
  });
}

function getSorted(rows) {
  return [...rows].sort((a, b) => {
    let va, vb;
    if (G.sortCol === 'urgency') { va = URG_ORD[a._urgency]??9; vb = URG_ORD[b._urgency]??9; }
    else { va = a[G.sortCol]; vb = b[G.sortCol]; }
    const na = num(String(va??'')), nb = num(String(vb??''));
    const cmp = na !== null && nb !== null ? na-nb : String(va??'').localeCompare(String(vb??''),'ko');
    return G.sortDir === 'asc' ? cmp : -cmp;
  });
}

// ============================================================
// 통계 업데이트
// ============================================================
function updateStats() {
  const all = G.items.map(enrichItem);
  document.getElementById('cnt-all').textContent      = all.length;
  document.getElementById('cnt-urgent').textContent   = all.filter(i => i._urgency === 'urgent').length;
  document.getElementById('cnt-warning').textContent  = all.filter(i => i._urgency === 'warning').length;
  document.getElementById('cnt-ok').textContent       = all.filter(i => i._urgency === 'ok').length;
  document.getElementById('cnt-confirmed').textContent= Object.values(G.orderPlan).filter(p => p.is_confirmed).length;
}

// ============================================================
// 메인 테이블 렌더
// ============================================================
const URG_LABEL = { urgent:'🔴 즉시발주', warning:'🟡 발주검토', ok:'🟢 여유', na:'—' };
const URG_CLS   = { urgent:'urg-urgent',  warning:'urg-warning',  ok:'urg-ok',  na:'urg-na' };

function renderTable() {
  const rows  = getSorted(getFiltered());
  const tbody = document.getElementById('tbodyMain');
  const info  = document.getElementById('resultInfo');
  const conf  = Object.values(G.orderPlan).filter(p=>p.is_confirmed).length;
  info.textContent = `${rows.length}건 표시 · 전체 ${G.items.length}건 · 확정 ${conf}건`;
  document.getElementById('emptyMsg').classList.toggle('hidden', rows.length > 0);

  // 원가 칼럼 표시 여부
  document.querySelectorAll('.cost-col').forEach(el => el.classList.toggle('hidden', !G.showCost));

  if (!rows.length) {
    tbody.innerHTML = '';
    document.getElementById('tfootMain').innerHTML = '';
    return;
  }

  // 합계 HTML
  const summaryHTML = buildSummaryRow(rows);
  // 상단 합계 행 (tbody 첫번째, sticky)
  const topSummary = `<tr class="summary-row summary-top">${summaryHTML}</tr>`;
  // 하단 합계 행 (tfoot, sticky bottom)
  document.getElementById('tfootMain').innerHTML = `<tr>${summaryHTML}</tr>`;

  tbody.innerHTML = topSummary + rows.map(item => {
    const plan   = G.orderPlan[item.code] || {};
    const conf   = !!plan.is_confirmed;
    const savedQ = plan.order_qty != null ? plan.order_qty : null;
    const dispQ  = savedQ !== null ? savedQ : (item._recQty || '');
    const hasVal = dispQ !== '' && dispQ !== null && dispQ !== 0;
    const sup    = SUP_SHORT[item.supplier] || item.supplier.split(' ')[0];
    const timing = calcTiming(item);
    const trend  = item.trend.trim();
    const trendH = trend === '증가' ? '<span class="tr-inc">↑ 증가</span>'
                 : trend === '감소' ? '<span class="tr-dec">↓ 감소</span>'
                 : `<span>${trend}</span>`;
    const rowCls = conf ? 'row-confirmed' : item._urgency === 'urgent' ? 'row-urgent'
                        : item._urgency === 'warning' ? 'row-warning' : '';
    const codeE  = item.code.replace(/'/g,"\\'");
    const useQ   = savedQ !== null ? savedQ : (item._recQty || 0);
    const projA  = calcProjAvail(item, useQ);
    // 발주후 예상가용 → 직접 입력 가능 (목표 개월 입력 시 발주수량 자동 계산)
    const projVal = projA !== null ? projA.toFixed(1) : '';
    const projH   = `<div>
      <input type="number" class="months-input ${projVal?'has-months':''}"
        value="${projVal}"
        placeholder="목표(월)"
        min="0" step="0.5"
        title="목표 개월 수 입력 → 발주수량 자동 계산"
        ${conf?'disabled':''}
        onchange="onMonthsChange('${codeE}',this)">
      <span class="months-hint">↕ 목표 개월</span>
    </div>`;

    // 원가 칼럼
    const pr        = G.prices[item.code] || {};
    const effCost   = calcEffectiveCost(item.code);
    const stdCostV  = calcStdFromEffective(item.code);
    const profitAmt = calcProfitAmt(item.code);
    const profitRt  = calcProfitRate(item.code);
    const cmpMac    = cmpMaeksan(item.code);
    const costCols  = G.showCost ? `
      <td class="cost-td">${fmt(pr.import_price)}</td>
      <td class="cost-td">${fmt(pr.maeksan_cost)}</td>
      <td class="cost-td" style="font-weight:700">${fmt(effCost)}</td>
      <td class="cost-td" style="font-weight:700;color:var(--primary)">${fmt(stdCostV)}</td>
      <td class="cost-td"><span class="${cmpMac.cls}" style="font-size:11px">${cmpMac.text}</span></td>
      <td class="cost-td">${fmtProfitAmt(profitAmt)}</td>
      <td class="cost-td">${fmtProfitRate(profitRt)}</td>` : '';

    const proc = calcProcMethod(item.code);
    return `<tr class="${rowCls}" data-code="${codeE}">
      <td class="ctr"><input type="checkbox" class="chk-conf" data-code="${codeE}" ${conf?'checked':''} onchange="onConfirmChk('${codeE}',this.checked)"></td>
      <td class="ctr"><span class="${proc.cls}">${proc.text}</span></td>
      <td class="ctr"><span class="urg-badge ${URG_CLS[item._urgency]||'urg-na'}">${URG_LABEL[item._urgency]||'—'}</span></td>
      <td class="code">${item.code}</td>
      <td class="name" title="${item.name}">${item.name}</td>
      <td class="spec" title="${item.spec}">${item.spec||'—'}</td>
      <td class="ctr"><span class="sup-tag">${sup}</span></td>
      <td class="num" title="${item._hasSalesData?'판매현황 데이터 기준':'업로드 데이터 기준'}">
        ${fmt(item.avg_cur)}${item._hasSalesData?'<span style="color:var(--ok);font-size:9px;margin-left:2px">★</span>':''}
      </td>
      <td class="num" title="${item._hasSalesData?'판매현황 데이터 기준':'업로드 데이터 기준'}">
        ${fmt(item.avg_prev)}${item._hasSalesData?'<span style="color:var(--ok);font-size:9px;margin-left:2px">★</span>':''}
      </td>
      <td class="ctr">${trendH}</td>
      <td class="ctr">${item.leadtime||'—'}</td>
      <td class="num" style="${num(item.stock)<0?'color:var(--urgent)':''}">${fmt(item.stock)}</td>
      <td class="num" style="color:#0891b2">${(() => {
        const t = getItemIncomingTiming(item.code);
        const qtyStr = fmt(item.incoming);
        if (!t) return qtyStr;
        const timingCls = t.label==='월초'?'#15803d':t.label==='중순'?'#d97706':'#dc2626';
        return `${qtyStr}<small style="display:block;font-size:9px;font-weight:700;color:${timingCls}">${t.ym.replace('-','/')} ${t.label}</small>`;
      })()}</td>
      <td class="ctr">${fmtAvail(item.avail_mo_incl)}</td>
      <td class="ctr">${projH}</td>
      <td class="num ${item._recQty?'rec-val':'av-na'}">${item._recQty?fmt(item._recQty):'—'}</td>
      <td class="ctr">
        <input type="number" class="order-input ${hasVal?'has-val':''}"
          value="${hasVal?dispQ:''}" placeholder="${item._recQty?fmt(item._recQty):'0'}"
          min="0" step="1" ${conf?'disabled':''}
          onchange="onQtyChange('${codeE}',this)"
          oninput="onQtyChange('${codeE}',this)">
      </td>
      ${costCols}
      <td class="ctr"><span class="${timing.cls}">${timing.text}</span></td>
    </tr>`;
  }).join('');
}

// ── 합계 행 HTML 생성
function buildSummaryRow(rows) {
  const sumStock    = rows.reduce((s,i) => s + Math.max(0, num(i.stock)    ?? 0), 0);
  const sumIncoming = rows.reduce((s,i) => s + Math.max(0, num(i.incoming) ?? 0), 0);
  const sumRec      = rows.reduce((s,i) => s + (i._recQty || 0), 0);
  const sumOrder    = rows.reduce((s,i) => s + (num(G.orderPlan[i.code]?.order_qty) || 0), 0);
  const availList   = rows.map(i => num(i.avail_mo_incl)).filter(v => v !== null);
  const avgAvail    = availList.length ? availList.reduce((a,b) => a+b, 0) / availList.length : null;
  const urgC = {
    urgent:  rows.filter(i => i._urgency === 'urgent').length,
    warning: rows.filter(i => i._urgency === 'warning').length,
    ok:      rows.filter(i => i._urgency === 'ok').length,
  };
  const costCols = G.showCost
    ? `<td class="cost-td">—</td>`.repeat(7)
    : '';
  return `
    <td class="ctr"></td>
    <td></td>
    <td class="ctr" style="font-size:10px;line-height:1.8;white-space:nowrap">
      🔴${urgC.urgent}<br>🟡${urgC.warning}<br>🟢${urgC.ok}
    </td>
    <td colspan="4" class="summary-label" style="padding-left:10px">
      합 계 &nbsp;<span style="font-weight:400;font-size:11px;color:var(--text2)">${rows.length}건</span>
    </td>
    <td colspan="4"></td>
    <td class="num sum-val">${sumStock.toLocaleString('ko-KR')}</td>
    <td class="num sum-val">${sumIncoming.toLocaleString('ko-KR')}</td>
    <td class="ctr sum-val">${avgAvail !== null ? avgAvail.toFixed(1)+'개월' : '—'}</td>
    <td></td>
    <td class="num sum-val">${sumRec.toLocaleString('ko-KR')}</td>
    <td class="num sum-val" style="color:var(--primary);font-size:13px">${sumOrder.toLocaleString('ko-KR')}</td>
    ${costCols}
    <td></td>`;
}

// ── 수량 변경 → 개월 수 자동 갱신
window.onQtyChange = function(code, el) {
  const v   = parseInt(el.value, 10);
  const qty = !isNaN(v) && v >= 0 ? v : null;
  updateOrderPlan(code, qty, false, null);
  el.classList.toggle('has-val', qty !== null);

  const tr = el.closest('tr');
  if (!tr) return;
  const item = G.items.map(enrichItem).find(i => i.code === code);
  if (!item) return;

  // 예상 가용 개월 수 역방향 갱신
  const proj        = calcProjAvail(item, qty || 0);
  const monthsInput = tr.querySelector('.months-input');
  if (monthsInput) {
    monthsInput.value = proj !== null ? proj.toFixed(1) : '';
    monthsInput.classList.toggle('has-months', proj !== null && proj > 0);
  }
};

// ── 입고예정 날짜/텍스트 → 월초/중순/말 판단
function dateToTiming(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();

  // ── 한국어 텍스트: "7월 말", "7월 중순", "7월 초", "2026년 7월 말" 등
  const krMatch = s.match(/(?:(\d{4})년\s*)?(\d{1,2})월\s*(초순?|월초|중순|말)/);
  if (krMatch) {
    const today = new Date();
    let year    = krMatch[1] ? parseInt(krMatch[1]) : today.getFullYear();
    const month = parseInt(krMatch[2]);
    const kw    = krMatch[3]; // "초", "초순", "월초", "중순", "말"

    // 연도 미지정 + 이미 지난 달이면 내년으로 추정
    if (!krMatch[1] && month < today.getMonth() + 1) year++;

    let label, day;
    if (['초', '초순', '월초'].includes(kw))  { label = '월초'; day = 10; }
    else if (kw === '중순')                   { label = '중순'; day = 20; }
    else /* 말 */                             { label = '말';   day = new Date(year, month, 0).getDate(); }

    const mm   = String(month).padStart(2, '0');
    const dd   = String(day).padStart(2, '0');
    return { label, day, date: `${year}-${mm}-${dd}`, ym: `${year}/${mm}`, isText: true };
  }

  // ── 일반 날짜 형식 (YYYY-MM-DD 등)
  const d = new Date(s);
  if (isNaN(d)) return null;
  const day  = d.getDate();
  const ym   = `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}`;
  const date = s.slice(0, 10);
  if (day <= 10) return { label: '월초', day, date, ym };
  if (day <= 20) return { label: '중순', day, date, ym };
  return               { label: '말',   day, date, ym };
}

// ── 특정 품목코드의 다음 입고 시기 조회 (G_incoming + INCOMING_DATA)
function getItemIncomingTiming(code) {
  const all    = getIncomingAll();
  const today  = new Date().toISOString().slice(0, 10);
  const upcoming = all
    .filter(d => d.code === code)
    .map(d => ({ ...d, _date: d.etaExpected2 || d.etaExpected || '' }))
    .filter(d => d._date >= today)
    .sort((a, b) => a._date.localeCompare(b._date));
  if (!upcoming.length) return null;
  const first = upcoming[0];
  const t     = dateToTiming(first._date);
  if (!t) return null;
  return { ...t, qty: Number(first.qty) || 0, poNo: first.poNo || '' };
}

// ── 일괄 발주수량 계산 버튼
document.getElementById('btnBulkMonths')?.addEventListener('click', () => {
  const targetMonths = parseFloat(document.getElementById('bulkMonthsInput').value);
  if (isNaN(targetMonths) || targetMonths < 0) {
    showToast('목표 개월 수를 입력하세요.'); return;
  }

  const visible = getSorted(getFiltered()).map(enrichItem);
  let applied = 0, skipped = 0;

  visible.forEach(item => {
    if (G.orderPlan[item.code]?.is_confirmed) { skipped++; return; } // 확정 제외

    const avg   = item.avg_cur || item.avg_prev || 0;
    const stock = Math.max(0, num(item.stock)    ?? 0);
    const inc   = Math.max(0, num(item.incoming) ?? 0);

    if (avg === 0) { skipped++; return; } // 판매데이터 없는 품목 제외

    const newQty = Math.max(0, Math.round(targetMonths * avg - stock - inc));
    if (!G.orderPlan[item.code]) G.orderPlan[item.code] = {};
    G.orderPlan[item.code].order_qty = newQty;

    if (DB.isReady()) {
      DB.saveOrderPlan(item.code, newQty, false, '일괄계산', G.clientIP).catch(() => {});
    }
    applied++;
  });

  if (!DB.isReady()) localStorage.setItem('ojc_order_plan', JSON.stringify(G.orderPlan));

  renderTable();
  const info = document.getElementById('bulkMonthsInfo');
  info.textContent = `✅ ${applied}건 적용 (${skipped}건 제외)`;
  showToast(`${targetMonths}개월 기준 — ${applied}건 발주수량 일괄 계산 완료`);
});

// ── 목표 개월 수 변경 → 발주수량 자동 계산
window.onMonthsChange = function(code, el) {
  const targetMonths = parseFloat(el.value);
  if (isNaN(targetMonths) || targetMonths < 0) {
    el.value = '';
    el.classList.remove('has-months');
    return;
  }
  el.classList.add('has-months');

  const item = G.items.map(enrichItem).find(i => i.code === code);
  if (!item) return;

  const avg   = item.avg_cur || item.avg_prev || 0;
  const stock = Math.max(0, num(item.stock)    ?? 0);
  const inc   = Math.max(0, num(item.incoming) ?? 0);

  if (avg === 0) {
    showToast(`${code}: 월평균 판매량이 없어 자동 계산이 어렵습니다.`);
    return;
  }

  // 발주수량 = 목표 × 월평균 - 현재고 - 입고예정 (0 이하이면 0)
  const newQty = Math.max(0, Math.round(targetMonths * avg - stock - inc));

  // 발주수량 입력 업데이트
  const tr       = el.closest('tr');
  const qtyInput = tr?.querySelector('.order-input');
  if (qtyInput) {
    qtyInput.value = newQty;
    qtyInput.classList.toggle('has-val', newQty > 0);
  }

  // 저장
  updateOrderPlan(code, newQty, false, null);
  showToast(`${code}: ${targetMonths}개월 기준 → 발주수량 ${newQty.toLocaleString('ko-KR')}개`);
};

// ── 확정 체크박스
window.onConfirmChk = function(code, checked) {
  const plan = G.orderPlan[code] || {};
  updateOrderPlan(code, plan.order_qty ?? null, checked, checked ? '직접확정' : null);
  updateStats();
  const row = document.querySelector(`tr[data-code="${code}"]`);
  if (row) {
    row.classList.toggle('row-confirmed', checked);
    const inp = row.querySelector('.order-input');
    if (inp) inp.disabled = checked;
  }
  renderConfirmedTab();
};

function updateOrderPlan(code, qty, confirmed, by) {
  if (!G.orderPlan[code]) G.orderPlan[code] = {};
  if (qty !== undefined && qty !== null) G.orderPlan[code].order_qty = qty;
  if (confirmed !== undefined) G.orderPlan[code].is_confirmed = confirmed;
  if (by) G.orderPlan[code].confirmed_by = by;
  // 즉시 저장
  if (DB.isReady()) {
    DB.saveOrderPlan(code, qty ?? G.orderPlan[code].order_qty, confirmed, by || '사용자', G.clientIP)
      .catch(() => {});
  } else {
    localStorage.setItem('ojc_order_plan', JSON.stringify(G.orderPlan));
  }
}

// ============================================================
// 발주 확정 목록 탭
// ============================================================
function renderConfirmedTab() {
  const confirmed = G.items.map(enrichItem).filter(i => G.orderPlan[i.code]?.is_confirmed);
  const content   = document.getElementById('confirmContent');
  const summary   = document.getElementById('confirmSummaryText');
  if (!confirmed.length) {
    content.innerHTML = '<div class="confirm-empty">아직 확정된 발주가 없습니다.<br>발주 계획 탭에서 체크박스를 선택하세요.</div>';
    summary.textContent = '';
    return;
  }
  const groups = {};
  confirmed.forEach(it => {
    if (!groups[it.supplier]) groups[it.supplier] = [];
    groups[it.supplier].push(it);
  });
  let totalQty = 0, html = '';
  Object.entries(groups).forEach(([sup, items]) => {
    let gTotal = 0;
    const rows = items.map(it => {
      const qty = G.orderPlan[it.code]?.order_qty ?? it._recQty ?? 0;
      gTotal += Number(qty) || 0;
      return `<tr>
        <td class="code">${it.code}</td>
        <td>${it.name}</td>
        <td style="font-size:11px;color:var(--text2)">${it.spec||'—'}</td>
        <td style="text-align:right;font-weight:700;color:var(--primary)">${Number(qty).toLocaleString('ko-KR')}</td>
        <td style="text-align:center">${fmtAvail(it.avail_mo_incl)}</td>
        <td style="text-align:center"><span class="urg-badge ${URG_CLS[it._urgency]||'urg-na'}">${{urgent:'즉시',warning:'검토',ok:'여유',na:'—'}[it._urgency]||'—'}</span></td>
      </tr>`;
    }).join('');
    totalQty += gTotal;
    html += `<div class="supplier-group">
      <div class="sg-header">
        <span class="sg-name">${sup}</span>
        <span class="sg-count">${items.length}품목</span>
        <span class="sg-total">합계: ${gTotal.toLocaleString('ko-KR')}개</span>
      </div>
      <div class="sg-wrap"><table>
        <thead><tr><th>품목코드</th><th>품목명</th><th>규격</th><th style="text-align:right">발주수량</th><th>가용재고</th><th>긴급도</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  });
  content.innerHTML = html;
  summary.textContent = `총 ${confirmed.length}품목 · ${Object.keys(groups).length}개 구매처 · 발주수량 합계 ${totalQty.toLocaleString('ko-KR')}개`;
}

// ── CSV 내보내기
function exportConfirmCSV() {
  const confirmed = G.items.map(enrichItem).filter(i => G.orderPlan[i.code]?.is_confirmed);
  if (!confirmed.length) { showToast('확정된 발주 항목이 없습니다.'); return; }
  const BOM = '﻿';
  const header = '구매처,품목코드,품목명,규격,월평균판매,가용재고(월),권장발주량,확정발주수량,긴급도';
  const rows = confirmed.map(it => {
    const qty = G.orderPlan[it.code]?.order_qty ?? it._recQty ?? 0;
    return [`"${it.supplier}"`,`"${it.code}"`,`"${it.name}"`,`"${it.spec||''}"`,
      it.avg_cur||0, num(it.avail_mo_incl)??'', it._recQty||0, qty,
      {urgent:'즉시발주',warning:'발주검토',ok:'여유',na:'—'}[it._urgency]||'—'].join(',');
  });
  const csv = BOM + header + '\n' + rows.join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = 'OJC_발주확정_' + new Date().toISOString().slice(0,10) + '.csv';
  a.click(); URL.revokeObjectURL(url);
  showToast('CSV 다운로드 시작');
}

// ============================================================
// 입고예정 탭
// ============================================================
function renderIncomingTab() {
  const all    = getIncomingAll();
  const today  = new Date().toISOString().slice(0,10);
  document.getElementById('incomingTotal').textContent = all.length;

  // 발주# 별 소계 및 전체 합계
  const poGroups = {};
  all.forEach(it => {
    const po  = it.poNo || '—';
    const qty = Number(it.qty) || 0;
    if (!poGroups[po]) poGroups[po] = 0;
    poGroups[po] += qty;
  });
  const totalQty = Object.values(poGroups).reduce((s, v) => s + v, 0);

  // 정렬: 텍스트 날짜("7월 말" 등)도 파싱해서 비교
  const sorted = [...all].sort((a,b) => {
    const ta = dateToTiming(a.etaExpected2||a.etaExpected||a.eta||'');
    const tb = dateToTiming(b.etaExpected2||b.etaExpected||b.eta||'');
    const da = ta?.date || a.etaExpected2 || a.etaExpected || a.eta || '';
    const db = tb?.date || b.etaExpected2 || b.etaExpected || b.eta || '';
    return da.localeCompare(db);
  });

  // 상단 합계 행 (tbody 첫 행, sticky)
  const summaryRow = `<tr class="incoming-summary-top">
    <td colspan="3" style="font-weight:800;color:var(--primary);padding-left:10px">
      합 계 <span style="font-weight:400;font-size:11px;color:var(--text2)">${all.length}건</span>
    </td>
    <td></td>
    <td style="text-align:right;font-weight:800;font-size:14px;color:var(--primary)">${totalQty.toLocaleString('ko-KR')}</td>
    <td colspan="6"></td>
    <td></td>
  </tr>
  ${Object.entries(poGroups).map(([po, qty]) => `
    <tr style="background:#f8fafc">
      <td style="padding-left:16px;font-size:11px;color:var(--text2);font-weight:600">${po}</td>
      <td colspan="3" style="font-size:11px;color:var(--text2)">소계</td>
      <td style="text-align:right;font-weight:700;color:var(--text2)">${qty.toLocaleString('ko-KR')}</td>
      <td colspan="6"></td>
      <td></td>
    </tr>`).join('')}
  <tr><td colspan="12" style="height:4px;background:var(--border)"></td></tr>`;

  // 하단 합계 (tfoot, sticky)
  document.getElementById('tfootIncoming').innerHTML = `<tr class="incoming-summary-foot">
    <td colspan="3" style="font-weight:800;color:var(--primary);padding-left:10px">합 계</td>
    <td></td>
    <td style="text-align:right;font-weight:800;font-size:14px;color:var(--primary)">${totalQty.toLocaleString('ko-KR')}</td>
    <td colspan="6"></td>
    <td></td>
  </tr>`;

  document.getElementById('tbodyIncoming').innerHTML = summaryRow + sorted.map(it => {
    const incomingDate = it.etaExpected2 || it.etaExpected || '';
    const tParsed = dateToTiming(incomingDate);             // 텍스트 날짜도 파싱
    const cmpDate = tParsed?.date || incomingDate;
    const overdue = cmpDate && cmpDate < today;
    const isUploaded = it._source === 'upload';
    return `<tr ${overdue?'style="background:#fff8f8"':''}>
      <td style="font-weight:700;color:var(--primary)">${it.poNo||'—'}</td>
      <td>${it.dept||'—'}</td>
      <td class="code">${it.code||'—'}</td>
      <td>${it.name||'—'}</td>
      <td style="text-align:right;font-weight:600">${it.qty?Number(it.qty).toLocaleString('ko-KR'):'—'}</td>
      <td>${it.orderDate||'—'}</td>
      <td>${it.eta||'—'}</td>
      <td>${it.etaExpected||'—'}</td>
      <td style="${overdue?'color:var(--warn);font-weight:700':''}">
        ${incomingDate||'—'}
        ${tParsed ? (() => {
          const c  = tParsed.label==='월초'?'#15803d':tParsed.label==='중순'?'#d97706':'#dc2626';
          const bg = tParsed.label==='월초'?'#f0fdf4':tParsed.label==='중순'?'#fffbeb':'#fff5f5';
          return `<small style="margin-left:4px;font-size:9px;font-weight:700;padding:1px 5px;border-radius:8px;background:${bg};color:${c}">${tParsed.label}</small>`;
        })() : ''}
      </td>
      <td>${it.loc||'—'}</td>
      <td style="font-size:11px;color:var(--text2)">${it.note||'—'}</td>
      <td style="text-align:center">
        <span style="font-size:9px;padding:1px 5px;border-radius:8px;background:${isUploaded?'#dbeafe':'#f1f5f9'};color:${isUploaded?'#1d4ed8':'#94a3b8'}">
          ${isUploaded?'업로드':'기본'}
        </span>
      </td>
    </tr>`;
  }).join('');
}

// ============================================================
// 원가 관리 탭
// ============================================================
function renderCostTab(query) {
  const q = (query||'').toLowerCase();
  const all = G.items.map(enrichItem);
  const filtered = q ? all.filter(i => i.code.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)) : all;
  document.getElementById('costResultInfo').textContent = `${filtered.length}건`;
  document.getElementById('tbodyCost').innerHTML = filtered.map(it => {
    const pr        = G.prices[it.code] || {};
    const effCost   = calcEffectiveCost(it.code);       // min(수입, 맥산)
    const stdCost   = calcStdFromEffective(it.code);    // effCost × ratio
    const profitAmt = calcProfitAmt(it.code);           // 표준 - 생산원가
    const profitRt  = calcProfitRate(it.code);          // 손익 / 생산원가 × 100
    const cmpMac    = cmpMaeksan(it.code);
    const updTime   = pr.updated_at ? new Date(pr.updated_at).toLocaleDateString('ko-KR') : '—';
    const codeE     = it.code.replace(/'/g,"\\'");

    // 어느 쪽이 실효 생산원가인지 표시
    const imp = num(pr.import_price), mac = num(pr.maeksan_cost);
    const impStyle = (imp !== null && mac !== null && imp <= mac) ? 'font-weight:700;color:var(--ok)' : '';
    const macStyle = (imp !== null && mac !== null && mac <  imp) ? 'font-weight:700;color:var(--primary)' : '';
    // 실효 생산원가 원천 뱃지
    const effSrc = (imp !== null && mac !== null)
      ? `<small style="font-size:9px;color:#94a3b8;margin-left:3px">(${imp <= mac ? '수입' : '맥산'})</small>` : '';

    return `<tr>
      <td class="code">${it.code}</td>
      <td>${it.name}</td>
      <td style="text-align:right;${impStyle}">${fmt(pr.import_price)}</td>
      <td style="text-align:right;${macStyle}">${fmt(pr.maeksan_cost)}</td>
      <td style="text-align:right;font-weight:700">${fmt(effCost)}${effSrc}</td>
      <td style="text-align:right;font-weight:700;color:var(--primary)">${fmt(stdCost)}</td>
      <td style="text-align:center"><span class="${cmpMac.cls}">${cmpMac.text}</span></td>
      <td style="text-align:right">
        ${fmtProfitAmt(profitAmt)}
        ${computeItemSales(it.code)?.avgPrice
          ? `<small style="display:block;font-size:9px;color:#94a3b8">판매가 기준</small>`
          : `<small style="display:block;font-size:9px;color:#94a3b8">표준원가 기준</small>`}
      </td>
      <td style="text-align:center">${fmtProfitRate(profitRt)}</td>
      <td style="font-size:11px;color:var(--text2)">${pr.updated_by?`${pr.updated_by}<br>${updTime}`:'—'}</td>
      <td><button class="hist-btn" onclick="openHistModal('${codeE}')">이력</button></td>
      <td><button class="cost-edit-btn" onclick="openPriceModal('${codeE}')">수정</button></td>
    </tr>`;
  }).join('');
}

// ============================================================
// 가격 편집 모달
// ============================================================
window.openPriceModal = function(code) {
  G.priceModalCode = code;
  const item = G.items.find(i => i.code === code) || {};
  const pr   = G.prices[code] || {};
  document.getElementById('priceModalItem').textContent = `${code}  ${item.name||''}`;
  document.getElementById('priceWorker').value  = '';
  document.getElementById('pImport').value   = pr.import_price  ?? '';
  document.getElementById('pMaeksan').value  = pr.maeksan_cost  ?? '';
  document.getElementById('pProd').value     = pr.prod_cost     ?? '';
  document.getElementById('pRatio').value    = pr.std_ratio     ?? '';
  document.getElementById('modalRatioHint').textContent = G.stdRatio;
  updateStdCostPreview();
  document.getElementById('priceModal').classList.remove('hidden');
};
window.closePriceModal = () => document.getElementById('priceModal').classList.add('hidden');

window.updateStdCostPreview = function() {
  const prod  = num(document.getElementById('pProd').value);
  const raw   = num(document.getElementById('pRatio').value);
  const ratio = normalizeRatio(raw) ?? G.stdRatio;
  const std   = prod !== null ? prod * ratio : null;
  // 비율이 10 초과이면 변환 안내
  const ratioEl = document.getElementById('pRatio');
  if (raw !== null && raw > 10) {
    ratioEl.style.borderColor = 'var(--warn)';
    ratioEl.title = `${raw}은 퍼센트로 인식되어 ${raw/100}로 자동 변환됩니다`;
  } else {
    ratioEl.style.borderColor = '';
    ratioEl.title = '';
  }
  document.getElementById('stdCostPreview').textContent = std !== null ? std.toLocaleString('ko-KR') + '원' : '—';
};

document.getElementById('btnSavePriceModal').addEventListener('click', async () => {
  const worker = document.getElementById('priceWorker').value.trim();
  if (!worker) { showToast('작업자 이름을 입력하세요.'); return; }
  const code = G.priceModalCode;
  const item = G.items.find(i => i.code === code) || {};
  const prod    = num(document.getElementById('pProd').value);
  const rawRatio = num(document.getElementById('pRatio').value);
  const ratio   = normalizeRatio(rawRatio) ?? G.stdRatio;
  const stdCost = prod !== null ? prod * ratio : null;
  const newPrices = {
    import_price:  num(document.getElementById('pImport').value),
    maeksan_cost:  num(document.getElementById('pMaeksan').value),
    prod_cost:     prod,
    std_ratio:     normalizeRatio(num(document.getElementById('pRatio').value)),
    standard_cost: stdCost,
  };
  // 즉시 로컬 반영
  G.prices[code] = { ...G.prices[code], ...newPrices, updated_by: worker, updated_at: new Date().toISOString() };
  // Supabase 저장
  if (DB.isReady()) {
    const res = await DB.savePrice(code, item.name||'', newPrices, worker, G.clientIP);
    if (res.error) { showToast('저장 오류: ' + res.error); return; }
  }
  closePriceModal();
  renderCostTab(document.getElementById('costSearch').value);
  renderTable();
  showToast(`${code} 원가 저장 완료 (${worker})`);
});

// ============================================================
// 가격 이력 모달
// ============================================================
window.openHistModal = async function(code) {
  const item = G.items.find(i => i.code === code) || {};
  document.getElementById('histModalItem').textContent = `${code}  ${item.name||''}`;
  document.getElementById('histModalContent').innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px">로딩 중…</p>';
  document.getElementById('histModal').classList.remove('hidden');
  const hist = DB.isReady() ? await DB.loadPriceHistory(code) : [];
  if (!hist.length) {
    document.getElementById('histModalContent').innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px">변경 이력이 없습니다.</p>';
    return;
  }
  const rows = hist.map(h => {
    const d = new Date(h.changed_at).toLocaleString('ko-KR');
    const chg = (field, o, n) => o !== n && o !== null && n !== null
      ? `<span class="chg">${fmt(n)} <small style="color:#94a3b8">(이전: ${fmt(o)})</small></span>`
      : fmt(n ?? o);
    return `<tr>
      <td>${d}</td>
      <td style="font-weight:600">${h.changed_by}</td>
      <td style="font-size:10px;color:#94a3b8">${h.ip_address||'—'}</td>
      <td style="text-align:right">${chg('import', h.import_price_old, h.import_price_new)}</td>
      <td style="text-align:right">${chg('maeksan', h.maeksan_cost_old, h.maeksan_cost_new)}</td>
      <td style="text-align:right">${chg('prod', h.prod_cost_old, h.prod_cost_new)}</td>
      <td style="text-align:right">${chg('std', h.standard_cost_old, h.standard_cost_new)}</td>
    </tr>`;
  }).join('');
  document.getElementById('histModalContent').innerHTML = `
    <table class="hist-table">
      <thead><tr><th>변경일시</th><th>작업자</th><th>IP</th><th>수입가격</th><th>맥산원가</th><th>생산원가</th><th>표준원가</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
};
window.closeHistModal = () => document.getElementById('histModal').classList.add('hidden');

// ============================================================
// 가격 다운로드 (관리자 인증 후)
// ============================================================
document.getElementById('btnDownloadPrice').addEventListener('click', () => {
  openAdminModal('가격 데이터 다운로드를 위해 관리자 비밀번호를 입력하세요.', async (name, pw) => {
    const ok = await verifyAdmin(pw);
    if (!ok) return '비밀번호가 올바르지 않습니다.';
    await DB.logDownload('price_download', name, G.clientIP, G.items.length, 'csv');
    exportPriceCSV(name);
    return null;
  });
});

async function exportPriceCSV(actorName) {
  const BOM = '﻿';
  const header = '품목코드,품목명,규격,수입가격,맥산생산원가,생산원가,표준원가비율,표준원가,최종수정자,최종수정일시';
  const rows = G.items.map(it => {
    const pr  = G.prices[it.code] || {};
    const std = calcStdCost(pr.prod_cost, pr.std_ratio);
    return [`"${it.code}"`,`"${it.name}"`,`"${it.spec||''}"`,
      pr.import_price??'', pr.maeksan_cost??'', pr.prod_cost??'',
      pr.std_ratio??G.stdRatio, fmt(std??pr.standard_cost),
      `"${pr.updated_by||''}"`, `"${pr.updated_at||''}"`].join(',');
  });
  const csv  = BOM + header + '\n' + rows.join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a'); a.href = url;
  a.download = 'OJC_가격목록_' + actorName + '_' + new Date().toISOString().slice(0,10) + '.csv';
  a.click(); URL.revokeObjectURL(url);
  showToast(`가격 목록 다운로드 완료 (${actorName})`);
}

// ── 가격 업로드
document.getElementById('btnUploadPrice').addEventListener('click', () => {
  document.getElementById('priceFileInput').click();
});
document.getElementById('priceFileInput').addEventListener('change', async function() {
  const file = this.files[0]; if (!file) return;
  const worker = prompt('작업자 이름을 입력하세요 (필수):');
  if (!worker?.trim()) { showToast('작업자 이름이 필요합니다.'); this.value=''; return; }
  const data = await parseFile(file);
  if (!data) { this.value=''; return; }
  const hRow = data.findIndex(r => r.some(c => String(c).includes('품목코드')));
  if (hRow < 0) { showToast('템플릿 양식이 맞지 않습니다. 품목코드 헤더를 확인하세요.'); this.value=''; return; }
  const headers = data[hRow].map(h => String(h).trim());
  const ci = k => headers.findIndex(h => h.includes(k));
  const rows = [];
  for (let r = hRow+1; r < data.length; r++) {
    const row = data[r];
    const code = String(row[ci('품목코드')]||'').trim();
    if (!code) continue;
    rows.push({
      code,
      name:         String(row[ci('품목명')]||'').trim(),
      import_price: num(row[ci('수입가격')]),
      maeksan_cost: num(row[ci('맥산')]),
      prod_cost:    num(row[ci('생산원가')]),
      std_ratio:    num(row[ci('비율')])??num(row[ci('표준원가비율')]),
    });
  }
  if (!rows.length) { showToast('업로드할 가격 데이터가 없습니다.'); this.value=''; return; }
  if (!confirm(`${rows.length}건의 가격을 업로드하겠습니까?\n작업자: ${worker}`)) { this.value=''; return; }
  // 공란 = 기존값 유지 (merge 방식)
  rows.forEach(r => {
    const existing = G.prices[r.code] || {};
    const merged   = { ...existing };
    // null 이 아닌 항목만 덮어씀
    if (r.import_price  !== null) merged.import_price  = r.import_price;
    if (r.maeksan_cost  !== null) merged.maeksan_cost  = r.maeksan_cost;
    if (r.prod_cost     !== null) merged.prod_cost     = r.prod_cost;
    if (r.std_ratio     !== null) merged.std_ratio     = r.std_ratio;
    if (r.name?.trim())           merged.item_name     = r.name;
    // 표준원가 재계산 (생산원가·비율이 있을 때만)
    const pc  = merged.prod_cost  ?? null;
    const rat = merged.std_ratio  ?? G.stdRatio;
    merged.standard_cost = pc !== null ? pc * rat : null;
    merged.updated_by = worker;
    G.prices[r.code] = merged;
  });
  if (DB.isReady()) {
    // merge=true : Supabase도 공란은 기존값 유지
    const res = await DB.uploadPrices(
      rows.map(r => ({
        ...r,
        standard_cost: (() => {
          const exist = G.prices[r.code] || {};
          const pc  = r.prod_cost  ?? exist.prod_cost  ?? null;
          const rat = r.std_ratio  ?? exist.std_ratio  ?? G.stdRatio;
          return pc !== null ? pc * rat : null;
        })(),
      })),
      worker, G.clientIP
    );
    if (res.error) { showToast('일부 오류: ' + res.error.slice(0,80)); }
  }
  renderCostTab(); renderTable();
  showToast(`가격 ${rows.length}건 업로드 완료 (${worker})`);
  this.value = '';
});

// ── 전체 이력 조회
document.getElementById('btnPriceHistory').addEventListener('click', async () => {
  openHistModal(null); // code=null 이면 전체
  document.getElementById('histModalItem').textContent = '전체 가격 변경 이력';
  document.getElementById('histModalContent').innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px">로딩 중…</p>';
  const hist = DB.isReady() ? await DB.loadPriceHistory(null) : [];
  if (!hist.length) {
    document.getElementById('histModalContent').innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px">변경 이력이 없습니다.</p>';
    return;
  }
  const rows = hist.map(h => {
    const d = new Date(h.changed_at).toLocaleString('ko-KR');
    return `<tr>
      <td>${d}</td><td style="font-weight:600">${h.changed_by}</td>
      <td style="font-size:10px;color:#94a3b8">${h.ip_address||'—'}</td>
      <td class="code">${h.item_code}</td><td>${h.item_name||'—'}</td>
      <td style="text-align:right">${fmt(h.import_price_new)}</td>
      <td style="text-align:right">${fmt(h.prod_cost_new)}</td>
      <td style="text-align:right;font-weight:700;color:var(--primary)">${fmt(h.standard_cost_new)}</td>
    </tr>`;
  }).join('');
  document.getElementById('histModalContent').innerHTML = `
    <table class="hist-table">
      <thead><tr><th>변경일시</th><th>작업자</th><th>IP</th><th>품목코드</th><th>품목명</th><th>수입가격</th><th>생산원가</th><th>표준원가</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
});

// ── 표준원가 비율 변경
document.getElementById('btnEditRatio').addEventListener('click', () => {
  const v = prompt('표준원가 비율을 입력하세요\n예: 1.39 = 생산원가의 139%\n※ 139처럼 퍼센트 숫자로 입력하면 자동으로 1.39로 변환됩니다.', G.stdRatio);
  let n = num(v);
  if (n === null || n <= 0) { showToast('올바른 숫자를 입력하세요.'); return; }
  // 10 초과 입력 시 퍼센트로 간주 → 자동 변환
  if (n > 10) {
    const converted = n / 100;
    if (!confirm(`입력값 ${n}은 ${n}배로 매우 큽니다.\n${n}% → ${converted}(배)로 변환하겠습니까?`)) return;
    n = converted;
  }
  G.stdRatio = n;
  document.getElementById('ratioDisplay').textContent = n;
  document.getElementById('ratioLabel').textContent   = `×${n}`;
  if (DB.isReady()) DB.setSetting('std_cost_ratio', String(n), '관리자').catch(()=>{});
  // 기존에 잘못 저장된 per-item std_ratio도 정규화
  let fixedCount = 0;
  Object.keys(G.prices).forEach(code => {
    const r = G.prices[code]?.std_ratio;
    if (r !== null && r !== undefined && r > 10) {
      G.prices[code].std_ratio = r / 100;
      fixedCount++;
      if (DB.isReady()) {
        DB.savePrice(code, G.prices[code].item_name || '', G.prices[code], '비율보정', G.clientIP, true).catch(()=>{});
      }
    }
  });
  renderCostTab(); renderTable();
  showToast(`표준원가 비율이 ${n}으로 변경되었습니다.`);
});

// ============================================================
// 관리자 인증 모달
// ============================================================
window.closeAdminModal = () => {
  document.getElementById('adminModal').classList.add('hidden');
  G.adminCallback = null;
};

function openAdminModal(desc, callback) {
  G.adminCallback = callback;
  document.getElementById('adminModalDesc').textContent = desc;
  document.getElementById('adminActorName').value = '';
  document.getElementById('adminPwInput').value   = '';
  document.getElementById('adminPwError').textContent = '';
  document.getElementById('adminModal').classList.remove('hidden');
}

document.getElementById('btnAdminConfirm').addEventListener('click', async () => {
  const name = document.getElementById('adminActorName').value.trim();
  const pw   = document.getElementById('adminPwInput').value;
  if (!name) { document.getElementById('adminPwError').textContent = '이름을 입력하세요.'; return; }
  if (!pw)   { document.getElementById('adminPwError').textContent = '비밀번호를 입력하세요.'; return; }
  const err = await G.adminCallback(name, pw);
  if (err) { document.getElementById('adminPwError').textContent = err; return; }
  closeAdminModal();
});

async function verifyAdmin(pw) {
  const hash = await sha256(pw);
  const stored = G.settings.admin_pw_hash || '';
  if (!stored) return true; // 비밀번호 미설정 시 통과
  return hash === stored;
}

// ============================================================
// 동기화 설정 탭
// ============================================================
document.getElementById('btnSbSave').addEventListener('click', async () => {
  const url = document.getElementById('sbUrl').value.trim();
  const key = document.getElementById('sbKey').value.trim();
  if (!url || !key) { showToast('URL과 Anon Key를 입력하세요.'); return; }
  localStorage.setItem('ojc_sb_url', url);
  localStorage.setItem('ojc_sb_key', key);
  showToast('저장 후 새로고침하면 적용됩니다.'); location.reload();
});

document.getElementById('btnChangePw').addEventListener('click', async () => {
  const curPw   = document.getElementById('currentPw').value;
  const newPw   = document.getElementById('newPw').value;
  const confirm = document.getElementById('newPwConfirm').value;
  const msg     = document.getElementById('pwMsg');
  if (!newPw)           { msg.style.color='#dc2626'; msg.textContent='새 비밀번호를 입력하세요.'; return; }
  if (newPw !== confirm) { msg.style.color='#dc2626'; msg.textContent='비밀번호가 일치하지 않습니다.'; return; }
  const curOk = await verifyAdmin(curPw);
  if (!curOk) { msg.style.color='#dc2626'; msg.textContent='현재 비밀번호가 올바르지 않습니다.'; return; }
  const newHash = await sha256(newPw);
  G.settings.admin_pw_hash = newHash;
  if (DB.isReady()) await DB.setSetting('admin_pw_hash', newHash, '관리자');
  msg.style.color='#16a34a'; msg.textContent='비밀번호가 변경되었습니다.';
  ['currentPw','newPw','newPwConfirm'].forEach(id => document.getElementById(id).value='');
});

document.getElementById('btnViewDlLog').addEventListener('click', () => {
  openAdminModal('다운로드 로그 조회를 위해 관리자 인증이 필요합니다.', async (name, pw) => {
    const ok = await verifyAdmin(pw);
    if (!ok) return '비밀번호가 올바르지 않습니다.';
    const logs = DB.isReady() ? await DB.getDownloadLog() : [];
    const cont = document.getElementById('dlLogContent');
    if (!logs.length) { cont.innerHTML = '<p style="color:#94a3b8;font-size:13px">로그가 없습니다.</p>'; return null; }
    cont.innerHTML = `<table class="hist-table" style="width:100%">
      <thead><tr><th>일시</th><th>구분</th><th>이름</th><th>IP</th><th>건수</th></tr></thead>
      <tbody>${logs.map(l=>`<tr>
        <td>${new Date(l.created_at).toLocaleString('ko-KR')}</td>
        <td>${l.action_type}</td><td style="font-weight:600">${l.actor_name}</td>
        <td style="font-size:11px;color:#94a3b8">${l.ip_address||'—'}</td>
        <td>${l.item_count||'—'}</td>
      </tr>`).join('')}</tbody>
    </table>`;
    return null;
  });
});

// ============================================================
// 데이터 업로드 탭
// ============================================================
const APP = window.APP = {

  // ── 발주검토 템플릿 다운로드 (Excel .xlsx)
  downloadTemplate() {
    const wb = XLSX.utils.book_new();

    // ── 시트1: 데이터 입력 ──────────────────────────────────
    const note    = ['※ * 표시 항목은 필수입력. 1행(이 안내문)과 2행(헤더)은 절대 삭제 금지. 3행부터 데이터를 입력하세요.'];
    const headers = ['품목코드*','품목명*','규격','구매처','재고수량*','입고예정수량','리드타임(일)','안전재고','전년월평균판매량','당년월평균판매량*','판매추이'];
    const rows    = [note, headers];
    // 빈 입력 행 20개
    for (let i = 0; i < 20; i++) rows.push(Array(headers.length).fill(''));

    const ws1 = XLSX.utils.aoa_to_sheet(rows);
    ws1['!cols'] = [{wch:15},{wch:36},{wch:28},{wch:36},{wch:12},{wch:14},{wch:13},{wch:12},{wch:18},{wch:18},{wch:10}];
    ws1['!merges'] = [{ s:{r:0,c:0}, e:{r:0,c:headers.length-1} }];
    XLSX.utils.book_append_sheet(wb, ws1, '데이터입력');

    // ── 시트2: 작성 안내 ────────────────────────────────────
    const guide = [
      ['OJC 수입품목 발주 검토 — 데이터 입력 템플릿 작성 안내'],
      [''],
      ['컬럼명','필수여부','설명','예시값'],
      ['품목코드','★필수','고유 품목 코드 (변경 금지)','14-K-362'],
      ['품목명','★필수','품목 이름','PIGTAIL-SC/PC-SM-1C (0.9mm)'],
      ['규격','선택','규격 또는 사양 (없으면 빈칸)','1.5M'],
      ['구매처','선택','수입 구매처 회사명','Fiberwit Link Communication Co.,LTD'],
      ['재고수량','★필수','현재 창고 재고 수량 (마이너스 가능)','15293'],
      ['입고예정수량','선택','이미 발주하여 입고 예정인 수량','20000'],
      ['리드타임(일)','선택','발주 후 입고까지 걸리는 일수 (미입력 시 60일 적용)','60'],
      ['안전재고','선택','최소 유지해야 할 재고 수량','11376'],
      ['전년월평균판매량','선택','전년도 월 평균 판매 수량','3792'],
      ['당년월평균판매량','★필수','현재 연도 월 평균 판매 수량','1073'],
      ['판매추이','선택','"증가" 또는 "감소" 텍스트 입력','감소'],
      [''],
      ['★ 자동 계산 항목 (직접 입력 불필요)'],
      ['항목','계산 공식'],
      ['가용재고(월)','재고수량 ÷ 당년월평균판매량'],
      ['입고포함 가용재고(월)','(재고수량+입고예정수량) ÷ 당년월평균판매량'],
      ['권장발주량','(목표재고 6개월 × 월평균) − 현재고 − 입고예정'],
      ['긴급도','가용재고 2개월 미만=즉시발주 / 2~4개월=발주검토 / 4개월 이상=여유'],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(guide);
    ws2['!cols'] = [{wch:20},{wch:10},{wch:50},{wch:40}];
    ws2['!merges'] = [
      { s:{r:0,c:0}, e:{r:0,c:3} },
      { s:{r:14,c:0}, e:{r:14,c:3} },
    ];
    XLSX.utils.book_append_sheet(wb, ws2, '작성안내');

    XLSX.writeFile(wb, 'OJC_발주검토_입력템플릿.xlsx');
    showToast('발주검토 템플릿 다운로드 완료 (Excel)');
  },

  // ── 가격 템플릿 다운로드 (Excel .xlsx)
  downloadPriceTemplate() {
    const wb = XLSX.utils.book_new();

    const note    = ['※ * 표시 항목은 필수. 1행(안내)·2행(헤더) 삭제 금지. 가격 항목은 아는 것만 입력 (빈칸 허용).'];
    const headers = ['품목코드*','품목명','수입가격','맥산생산원가','생산원가','표준원가비율(선택)'];
    const rows    = [note, headers];
    for (let i = 0; i < 20; i++) rows.push(Array(headers.length).fill(''));

    const ws1 = XLSX.utils.aoa_to_sheet(rows);
    ws1['!cols'] = [{wch:15},{wch:36},{wch:14},{wch:16},{wch:14},{wch:18}];
    ws1['!merges'] = [{ s:{r:0,c:0}, e:{r:0,c:headers.length-1} }];
    XLSX.utils.book_append_sheet(wb, ws1, '가격입력');

    const guide = [
      ['OJC 수입품목 가격 관리 — 가격 입력 템플릿 작성 안내'],
      [''],
      ['컬럼명','설명','예시'],
      ['품목코드','★필수 / 품목 고유 코드','14-K-362'],
      ['품목명','선택 / 입력 시 이름 자동 갱신','PIGTAIL-SC/PC'],
      ['수입가격','수입 단가 (원화 기준)','1200'],
      ['맥산생산원가','맥산에서 생산 시 원가 (원화)','1000'],
      ['생산원가','내부 생산원가 (원화)','850'],
      ['표준원가비율','선택 / 표준원가 = 생산원가 × 비율\n빈칸이면 전역 설정값 자동 사용','1.15'],
      [''],
      ['★ 표준원가는 업로드 후 앱에서 자동 계산됩니다'],
      ['원가비교 기준: 수입가격 < 표준원가 → 수입유리 / 수입가격 ≥ 표준원가 → 생산유리'],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(guide);
    ws2['!cols'] = [{wch:18},{wch:50},{wch:30}];
    ws2['!merges'] = [
      { s:{r:0,c:0}, e:{r:0,c:2} },
      { s:{r:9,c:0}, e:{r:9,c:2} },
      { s:{r:10,c:0}, e:{r:10,c:2} },
      { s:{r:11,c:0}, e:{r:11,c:2} },
    ];
    XLSX.utils.book_append_sheet(wb, ws2, '작성안내');

    XLSX.writeFile(wb, 'OJC_가격_입력템플릿.xlsx');
    showToast('가격 템플릿 다운로드 완료 (Excel)');
  },

  // ── 발주계획 전체 엑셀 저장
  exportPlanExcel() {
    const rows = getSorted(getFiltered());
    if (!rows.length) { showToast('내보낼 데이터가 없습니다.'); return; }

    const urgLabel = { urgent:'즉시발주', warning:'발주검토', ok:'여유', na:'—' };
    const headers = [
      '조달방식','긴급도','품목코드','품목명','규격','구매처',
      '월평균(당년)','월평균(전년)','판매추이','리드타임(일)',
      '현재고','입고예정','가용재고(입고포함·월)','발주후예상가용(월)',
      '권장발주량','발주수량',
      '수입가격','맥산생산원가','생산원가','표준원가',
      '맥산vs수입','손익금액(1개판매)','수익률(%)',
      '발주시기'
    ];

    const data = rows.map(it => {
      const plan     = G.orderPlan[it.code] || {};
      const orderQty = plan.order_qty != null ? plan.order_qty : (it._recQty || '');
      const pr       = G.prices[it.code] || {};
      const proc     = calcProcMethod(it.code);
      const eff      = calcEffectiveCost(it.code);
      const std      = calcStdFromEffective(it.code);
      const profit   = calcProfitAmt(it.code);
      const rate     = calcProfitRate(it.code);
      const cmp      = cmpMaeksan(it.code);
      const timing   = calcTiming(it);
      const projAvail = calcProjAvail(it, Number(orderQty) || 0);
      return [
        proc.text,
        urgLabel[it._urgency] || '—',
        it.code,
        it.name,
        it.spec || '',
        it.supplier || '',
        it.avg_cur  || 0,
        it.avg_prev || 0,
        it.trend    || '',
        it.leadtime || DEFAULT_LEADTIME,
        it.stock    || 0,
        it.incoming || 0,
        it.avail_mo_incl != null ? Math.round(it.avail_mo_incl * 10) / 10 : '',
        projAvail   != null ? Math.round(projAvail * 10) / 10 : '',
        it._recQty  || 0,
        orderQty,
        num(pr.import_price)  ?? '',
        num(pr.maeksan_cost)  ?? '',
        eff  != null ? eff  : '',
        std  != null ? Math.round(std)    : '',
        cmp.text.replace(/[✅🔵]/g, '').trim(),
        profit != null ? Math.round(profit) : '',
        rate   != null ? Math.round(rate * 10) / 10 : '',
        timing.text
      ];
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
    ws['!cols'] = [
      {wch:8},{wch:10},{wch:16},{wch:36},{wch:24},{wch:12},
      {wch:10},{wch:10},{wch:8},{wch:10},
      {wch:8},{wch:8},{wch:14},{wch:14},
      {wch:10},{wch:10},
      {wch:10},{wch:12},{wch:10},{wch:10},
      {wch:10},{wch:12},{wch:8},
      {wch:12}
    ];
    XLSX.utils.book_append_sheet(wb, ws, '발주계획');
    const today = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `OJC_발주계획_${today}.xlsx`);
    showToast(`발주계획 엑셀 저장 완료 (${rows.length}건)`);
  },
};

// ── 파일 파싱 (SheetJS)
async function parseFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb  = XLSX.read(e.target.result, {type:'array', cellDates:true});
        const ws  = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});
        resolve(raw);
      } catch { showToast('파일 파싱 오류. xlsx·csv 형식을 확인하세요.'); resolve(null); }
    };
    reader.readAsArrayBuffer(file);
  });
}

// ── 업로드 파일 선택
document.getElementById('uploadFileInput').addEventListener('change', async function() {
  const file = this.files[0]; if (!file) return;
  const raw = await parseFile(file); if (!raw) { this.value=''; return; }

  // 헤더 행 찾기: '품목코드' 포함 행 (★ / * 등 특수문자 제거 후 비교)
  const hIdx = raw.findIndex(r =>
    r.some(c => String(c).replace(/[*★\s]/g,'').includes('품목코드'))
  );
  if (hIdx < 0) {
    showToast('헤더에 "품목코드" 컬럼이 없습니다. 다운로드한 템플릿을 사용하세요.');
    this.value = ''; return;
  }
  const headers = raw[hIdx].map(h => String(h||'').replace(/[*★]/g,'').trim());

  // 실제 데이터 행 개수 미리 계산
  const dataCount = raw.slice(hIdx+1).filter(r => {
    const code = String(r[headers.findIndex(h=>h.includes('품목코드'))]||'').trim();
    return code && !code.startsWith('※') && !code.startsWith('[');
  }).length;

  if (dataCount === 0) {
    showToast('입력된 데이터가 없습니다. 템플릿에 데이터를 입력한 후 업로드하세요.');
    this.value = ''; return;
  }

  G.uploadParsed = { raw, hIdx, headers };
  renderUploadPreview(raw, hIdx, headers, dataCount);
  document.getElementById('btnConfirmUpload').disabled = false;
  document.getElementById('uploadColMap').classList.remove('hidden');
  this.value = '';
});

function renderUploadPreview(raw, hIdx, headers, dataCount) {
  const prev = document.getElementById('uploadPreview');
  prev.classList.remove('hidden');

  // 컬럼 매핑 자동 감지 결과 표시
  const FIELD_MAP = [
    { label:'품목코드', key:'품목코드', req:true  },
    { label:'품목명',   key:'품목명',   req:true  },
    { label:'규격',     key:'규격',     req:false },
    { label:'구매처',   key:'구매처',   req:false },
    { label:'재고수량', key:'재고',     req:true  },
    { label:'입고예정', key:'입고',     req:false },
    { label:'리드타임', key:'리드',     req:false },
    { label:'안전재고', key:'안전',     req:false },
    { label:'전년판매', key:'전년',     req:false },
    { label:'당년판매', key:'당년',     req:true  },
    { label:'판매추이', key:'판매추이', req:false },
  ];
  const mapHTML = FIELD_MAP.map(f => {
    const idx = headers.findIndex(h => h.includes(f.key));
    const found = idx >= 0;
    const colName = found ? headers[idx] : '—';
    return `<div class="col-map-item">
      <label>${f.label}${f.req?' <span class="req">*필수</span>':''}</label>
      <div style="font-size:12px;padding:4px 7px;border-radius:5px;border:1px solid ${found?'#86efac':'#fca5a5'};background:${found?'#f0fdf4':'#fff5f5'};color:${found?'#166534':'#991b1b'}">
        ${found ? `✓ 열 ${idx+1}: ${colName}` : '✗ 미감지'}
      </div>
    </div>`;
  }).join('');

  // 데이터 미리보기 (첫 3행)
  const dataRows = raw.slice(hIdx+1)
    .filter(r => r.some(c => String(c).trim()))
    .filter(r => !String(r[0]||'').startsWith('※'))
    .slice(0, 3);

  prev.innerHTML = `
    <div style="padding:10px 12px;background:#eff6ff;border-bottom:1px solid #bfdbfe;font-size:12px;font-weight:600;color:var(--primary)">
      ✅ 파일 인식 완료 — 총 <strong>${dataCount}건</strong> 업로드 예정
    </div>
    <div style="padding:10px 12px">
      <div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:8px">컬럼 자동 감지 결과</div>
      <div class="col-map-grid">${mapHTML}</div>
    </div>
    <div style="padding:0 12px 10px">
      <div style="font-size:11px;font-weight:600;color:var(--text2);margin-bottom:6px">데이터 미리보기 (최대 3행)</div>
      <div style="overflow-x:auto"><table>
        <thead><tr>${headers.map(h=>`<th>${h||'—'}</th>`).join('')}</tr></thead>
        <tbody>${dataRows.map(row=>`<tr>${headers.map((_,i)=>`<td>${row[i]??''}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

// ── 업로드 확정
document.getElementById('btnConfirmUpload').addEventListener('click', async () => {
  const worker = document.getElementById('uploaderName').value.trim();
  if (!worker) { showToast('작업자 이름을 입력하세요.'); return; }
  if (!G.uploadParsed) { showToast('파일을 먼저 업로드하세요.'); return; }
  const { raw, hIdx, headers } = G.uploadParsed;
  // 헤더에서 *, ★ 제거 후 키 탐색
  const ci = k => headers.findIndex(h => h.replace(/[*★]/g,'').trim().includes(k));
  const items = [];
  for (let r = hIdx+1; r < raw.length; r++) {
    const row  = raw[r];
    const code = String(row[ci('품목코드')]||'').trim();
    // 빈 행, 안내 텍스트, '[예시]' 등 스킵
    if (!code || code.startsWith('※') || code.startsWith('[') || code.startsWith('*')) continue;
    const avgP = num(row[ci('전년')]) ?? num(row[ci('avg2425')]) ?? 0;
    const avgC = num(row[ci('당년')]) ?? num(row[ci('avg26')])   ?? 0;
    const stock = num(row[ci('재고')]) ?? 0;
    const inc   = num(row[ci('입고')]) ?? 0;
    const lt    = num(row[ci('리드')]) ?? DEFAULT_LEADTIME;
    const avg   = avgC || avgP || 0;
    items.push({
      code,
      name:          String(row[ci('품목명')]||'').trim(),
      spec:          String(row[ci('규격')]||'').trim(),
      supplier:      String(row[ci('구매처')]||'').trim(),
      stock,
      incoming:      inc,
      leadtime:      lt,
      safety_stock:  num(row[ci('안전')]) ?? 0,
      avg_prev:      avgP,
      avg_cur:       avgC,
      trend:         String(row[ci('판매추이')]||'').trim(),
      avail_mo:      avg > 0 ? stock/avg : null,
      avail_mo_incl: avg > 0 ? (stock+inc)/avg : null,
    });
  }
  if (!items.length) { showToast('업로드할 품목 데이터가 없습니다.'); return; }
  if (!confirm(`${items.length}건을 업로드합니다. 기존 데이터가 교체됩니다.\n작업자: ${worker}`)) return;
  if (DB.isReady()) {
    const res = await DB.uploadItems(items, worker, G.clientIP);
    if (res.error) { showToast('업로드 오류: ' + res.error); return; }
  }
  G.items = items.map(normalizeItem);
  G.uploadParsed = null;
  document.getElementById('uploadPreview').classList.add('hidden');
  document.getElementById('uploadColMap').classList.add('hidden');
  document.getElementById('btnConfirmUpload').disabled = true;
  document.getElementById('uploaderName').value = '';
  updateStats(); renderTable(); renderCostTab();
  await loadUploadHistory();
  showToast(`✅ ${items.length}건 업로드 완료 (${worker})`);
});

const SESS_TYPE = {
  item_data:    { label: '품목데이터',  bg: '#dbeafe', color: '#1d4ed8' },
  stock_update: { label: '재고업데이트', bg: '#dcfce7', color: '#15803d' },
  price_list:   { label: '가격',        bg: '#f5f3ff', color: '#7c3aed' },
};

async function loadUploadHistory() {
  const list = document.getElementById('uploadHistoryList');
  if (!DB.isReady()) {
    // 로컬 임시 이력 (Supabase 미연결 시)
    const local = JSON.parse(localStorage.getItem('ojc_stock_history') || '[]');
    if (!local.length) {
      list.innerHTML = '<p style="font-size:12px;color:#94a3b8">Supabase 연결 후 전체 이력이 표시됩니다.</p>';
    } else {
      const t = SESS_TYPE.stock_update;
      list.innerHTML = `<p style="font-size:11px;color:#94a3b8;margin-bottom:6px">※ 오프라인 임시 이력 (Supabase 연결 시 자동 저장)</p>` +
        local.map(s => `<div class="hist-row">
          <span class="hist-type" style="background:${t.bg};color:${t.color}">${t.label}</span>
          <span class="hist-name">${s.worker}</span>
          <span>${s.cnt}건</span>
          <span style="font-size:10px;color:#94a3b8">오프라인</span>
          <span class="hist-ts">${new Date(s.ts).toLocaleString('ko-KR')}</span>
        </div>`).join('');
    }
    return;
  }
  // 전체 세션 조회 (품목·재고·가격 모두)
  const sessions = await DB.getUploadSessions();
  if (!sessions.length) {
    list.innerHTML = '<p style="font-size:12px;color:#94a3b8">업로드 이력 없음</p>';
    return;
  }
  list.innerHTML = sessions.map(s => {
    const t   = SESS_TYPE[s.session_type] || { label: s.session_type, bg: '#f1f5f9', color: '#64748b' };
    const sid = (s.id||'').replace(/'/g,"\\'");
    const ts  = (s.created_at||'').replace(/'/g,"\\'");
    const upl = (s.uploader_name||'').replace(/'/g,"\\'");
    return `<div class="hist-row">
      <span class="hist-type" style="background:${t.bg};color:${t.color}">${t.label}</span>
      <span class="hist-name">${s.uploader_name}</span>
      <span>${(s.row_count||0).toLocaleString()}건</span>
      <span style="font-size:10px;color:#94a3b8">${s.ip_address||'—'}</span>
      ${s.is_active ? '<span style="font-size:10px;background:#d1fae5;color:#065f46;border-radius:10px;padding:1px 7px">현재</span>' : ''}
      <span class="hist-ts">${new Date(s.created_at).toLocaleString('ko-KR')}</span>
      <button class="btn btn-ghost-xs" style="margin-left:auto;white-space:nowrap"
        onclick="downloadHistory('${sid}','${s.session_type}','${ts}','${upl}')">
        🔒 다운로드
      </button>
    </div>`;
  }).join('');
}

// ============================================================
// 판매현황 분석 모듈
// ============================================================

let G_sales = {
  data: {},  // { code: { "YYYY/MM": { qty, amount } } }
  meta: {},  // { code: name }
};

function loadSalesData() {
  try { G_sales.data = JSON.parse(localStorage.getItem('ojc_sales_data') || '{}'); } catch {}
  try { G_sales.meta = JSON.parse(localStorage.getItem('ojc_sales_meta') || '{}'); } catch {}
}
function saveSalesData() {
  localStorage.setItem('ojc_sales_data', JSON.stringify(G_sales.data));
  localStorage.setItem('ojc_sales_meta', JSON.stringify(G_sales.meta));
}

// ── 판매 데이터에 존재하는 연도 목록 (정렬)
function getSalesYears() {
  const set = new Set();
  Object.values(G_sales.data).forEach(byMo =>
    Object.keys(byMo).forEach(ym => set.add(ym.split('/')[0]))
  );
  return [...set].sort();
}

// ── 다양한 날짜 형식 → "YYYY/MM"
function parseYearMonth(v) {
  const s = String(v || '').trim();
  if (!s) return null;

  // "2024/01" or "2024-01"
  let m = s.match(/^(\d{4})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}/${m[2].padStart(2,'0')}`;

  // "24/01/02" or "24/01/02-11" (2자리 연도 + 월 + 이후 무시)
  m = s.match(/^(\d{2})[\/\-](\d{1,2})/);
  if (m) return `20${m[1]}/${m[2].padStart(2,'0')}`;

  // "2024년 1월" or "2024년01월"
  m = s.replace(/\s/g,'').match(/(\d{4})년(\d{1,2})월/);
  if (m) return `${m[1]}/${m[2].padStart(2,'0')}`;

  // 숫자만: 202401
  m = s.match(/^(\d{4})(\d{2})$/);
  if (m) return `${m[1]}/${m[2]}`;

  return null;
}

// ── 유연한 컬럼 탐지
function findColIdx(headers, keywords) {
  const n = h => String(h || '').replace(/[\s\(\)]/g, '').toLowerCase();
  for (const kw of keywords) {
    const idx = headers.findIndex(h => n(h).includes(kw.toLowerCase().replace(/\s/g,'')));
    if (idx >= 0) return idx;
  }
  return -1;
}

// ── 판매 파일 파싱 (두 가지 형식 자동 감지)
async function parseSalesFile(file) {
  const raw = await parseFile(file);
  if (!raw) return null;

  // 헤더 행: 품목코드 포함 행
  const hIdx = raw.findIndex(r =>
    r.some(c => String(c).replace(/\s/g,'').includes('품목코드'))
  );
  if (hIdx < 0) { showToast('헤더에 "품목코드" 컬럼이 없습니다.'); return null; }

  const headers = raw[hIdx].map(h => String(h || '').trim());

  const codeIdx  = findColIdx(headers, ['품목코드','품번','itemcode']);
  const nameIdx  = findColIdx(headers, ['품목명','품명','itemname']);
  const specIdx  = findColIdx(headers, ['규격명','규격','spec']);
  const dateIdx  = findColIdx(headers, ['일자','날짜','월별','연월','기간','월','date','년월']);
  const qtyIdx   = findColIdx(headers, ['수량','판매수량','출하수량','qty','quantity']);
  const amtIdx   = findColIdx(headers, ['공급가액','공급금액','판매금액','금액','매출금액','amount']);

  const missing = [];
  if (codeIdx < 0) missing.push('품목코드');
  if (dateIdx < 0) missing.push('일자/월별');
  if (qtyIdx  < 0) missing.push('수량');
  if (missing.length) { showToast(`컬럼 인식 실패: ${missing.join(', ')}`); return null; }

  const rows = [], skipped = [];
  for (let r = hIdx + 1; r < raw.length; r++) {
    const row  = raw[r];
    const code = String(row[codeIdx] || '').trim();
    if (!code) continue;

    const ym = parseYearMonth(row[dateIdx]);
    if (!ym) { skipped.push({ code, raw: String(row[dateIdx]||'') }); continue; }

    const qty = num(row[qtyIdx]);
    if (!qty || qty <= 0) continue;

    const amt  = amtIdx >= 0 ? (num(row[amtIdx]) || 0) : 0;
    const name = nameIdx >= 0 ? String(row[nameIdx] || '').trim() : '';
    const spec = specIdx >= 0 ? String(row[specIdx] || '').trim() : '';
    rows.push({ code, ym, qty, amt, name, spec });
  }

  return { rows, skipped, headers, hIdx,
    usedCols: { date: headers[dateIdx], code: headers[codeIdx], qty: headers[qtyIdx],
                amt: amtIdx >= 0 ? headers[amtIdx] : null } };
}

// ── 파싱 결과를 G_sales.data에 누적 병합
function mergeSalesRows(rows) {
  for (const r of rows) {
    if (!G_sales.data[r.code]) G_sales.data[r.code] = {};
    const cur = G_sales.data[r.code][r.ym] || { qty: 0, amount: 0 };
    G_sales.data[r.code][r.ym] = { qty: cur.qty + r.qty, amount: cur.amount + r.amt };
    if (r.name) G_sales.meta[r.code] = r.name;
  }
}

// ── 품목별 판매 분석 계산
function computeItemSales(code) {
  const byMonth = G_sales.data[code] || {};
  const entries = Object.entries(byMonth);
  if (!entries.length) return null;

  const byYear = {};
  entries.forEach(([ym, d]) => {
    const yr = ym.split('/')[0];
    if (!byYear[yr]) byYear[yr] = { qtyArr: [], totalQty: 0, totalAmt: 0 };
    byYear[yr].qtyArr.push(d.qty);
    byYear[yr].totalQty  += d.qty;
    byYear[yr].totalAmt  += d.amount || 0;
  });

  // 연도별 월평균 (실제 판매 기록이 있는 월 수 기준)
  const monthlyAvg = {};
  Object.entries(byYear).forEach(([yr, d]) => {
    monthlyAvg[yr] = d.totalQty / d.qtyArr.length;
  });

  const totalQty = entries.reduce((s, [,d]) => s + d.qty,    0);
  const totalAmt = entries.reduce((s, [,d]) => s + d.amount, 0);
  const avgPrice = totalAmt > 0 && totalQty > 0 ? totalAmt / totalQty : null;

  // 전년대비 (가장 최근 2개 연도 비교)
  const sortedYrs = Object.keys(byYear).sort();
  let yoyPct = null;
  if (sortedYrs.length >= 2) {
    const prev = monthlyAvg[sortedYrs[sortedYrs.length - 2]];
    const curr = monthlyAvg[sortedYrs[sortedYrs.length - 1]];
    if (prev > 0) yoyPct = (curr - prev) / prev * 100;
  }

  return { byYear, monthlyAvg, avgPrice, totalQty, totalAmt, yoyPct, sortedYrs };
}

// ── 수익율 계산
function computeProfitRate(code, avgPrice) {
  if (!avgPrice) return { prodRate: null, stdRate: null };
  const pr      = G.prices[code] || {};
  const prodCost = num(pr.prod_cost);
  const stdCost  = num(pr.standard_cost) ?? calcStdCost(pr.prod_cost, pr.std_ratio);
  return {
    prodRate: prodCost ? (avgPrice - prodCost) / prodCost * 100 : null,
    stdRate:  stdCost  ? (avgPrice - stdCost)  / stdCost  * 100 : null,
  };
}

function fmtRate(r) {
  if (r === null || r === undefined) return '<span class="rate-na">—</span>';
  const cls = r >= 0 ? 'rate-pos' : 'rate-neg';
  return `<span class="${cls}">${r >= 0 ? '+' : ''}${r.toFixed(1)}%</span>`;
}

// ── 판매현황 탭 렌더
function renderSalesTab(query) {
  const q           = (query || '').toLowerCase();
  const profitFilter = document.getElementById('salesProfitFilter')?.value || '';
  const years       = getSalesYears().slice(-4); // 최근 4개 연도
  const curYear     = String(new Date().getFullYear());
  const prevYear    = String(new Date().getFullYear() - 1);

  // 모든 판매 코드 수집
  const allCodes = [...new Set([
    ...Object.keys(G_sales.data),
    ...G.items.map(i => i.code),
  ])].filter(code => G_sales.data[code]);

  let rows = allCodes.map(code => {
    const item     = G.items.find(i => i.code === code);
    const name     = G_sales.meta[code] || item?.name || '—';
    const analysis = computeItemSales(code);
    const profit   = analysis?.avgPrice ? computeProfitRate(code, analysis.avgPrice) : { prodRate: null, stdRate: null };
    return { code, name, item, analysis, profit };
  });

  // 검색 필터
  if (q) rows = rows.filter(r =>
    r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)
  );

  // 수익율 필터
  if (profitFilter === 'pos')    rows = rows.filter(r => r.profit.prodRate !== null && r.profit.prodRate >= 0);
  if (profitFilter === 'neg')    rows = rows.filter(r => r.profit.prodRate !== null && r.profit.prodRate <  0);
  if (profitFilter === 'nodata') rows = rows.filter(r => r.profit.prodRate === null);

  // 정렬: 전년도 월평균 내림차순
  rows.sort((a, b) =>
    (b.analysis?.monthlyAvg[prevYear] || 0) - (a.analysis?.monthlyAvg[prevYear] || 0)
  );

  document.getElementById('salesResultInfo').textContent =
    `${rows.length}건 / 판매데이터 ${Object.keys(G_sales.data).length}품목`;

  // 전체 데이터 기간 표시
  const allYMs = Object.values(G_sales.data).flatMap(d => Object.keys(d)).sort();
  if (allYMs.length) {
    document.getElementById('salesDataRange').textContent =
      `데이터 기간: ${allYMs[0]} ~ ${allYMs[allYMs.length-1]}`;
  }

  if (!rows.length) {
    document.getElementById('salesTableHead').innerHTML = '';
    document.getElementById('salesTableBody').innerHTML =
      `<tr><td colspan="10" style="text-align:center;padding:40px;color:#94a3b8">
        ${Object.keys(G_sales.data).length ? '검색 결과 없음' : '판매 데이터가 없습니다. 파일을 업로드하세요.'}
      </td></tr>`;
    return;
  }

  // 헤더 생성 (동적 연도 칼럼)
  const yrHeads = years.map(y =>
    `<th class="${y===curYear?'year-cur':y===prevYear?'year-prev':''}">${y}년<br><small>월평균</small></th>`
  ).join('');

  document.getElementById('salesTableHead').innerHTML = `<tr>
    <th style="width:110px">품목코드</th>
    <th style="width:200px">품목명</th>
    ${yrHeads}
    <th style="width:80px">전년대비</th>
    <th style="width:90px">평균판매단가</th>
    <th style="width:90px">생산원가<br>수익율</th>
    <th style="width:90px">표준원가<br>수익율</th>
  </tr>`;

  // 합계 행
  const sumByYear = {};
  years.forEach(y => {
    sumByYear[y] = rows.reduce((s, r) => s + (r.analysis?.monthlyAvg[y] || 0), 0);
  });
  const topRow = `<tr class="sales-summary-top">
    <td colspan="2" style="font-weight:800;color:var(--ok);padding-left:10px">합계 ${rows.length}건</td>
    ${years.map(y => `<td class="num">${fmt(sumByYear[y],0)}</td>`).join('')}
    <td></td><td></td><td></td><td></td>
  </tr>`;

  // 데이터 행
  const dataRows = rows.map(r => {
    const a  = r.analysis;
    const yrCells = years.map(y => {
      const avg = a?.monthlyAvg[y];
      const cls = y === curYear ? 'year-cur' : y === prevYear ? 'year-prev' : '';
      return `<td class="num ${cls}">${avg !== undefined ? fmt(avg,0) : '<span class="av-na">—</span>'}</td>`;
    }).join('');

    const yoyH = a?.yoyPct !== null && a?.yoyPct !== undefined
      ? `<span class="${a.yoyPct >= 0 ? 'tr-inc' : 'tr-dec'}">${a.yoyPct >= 0 ? '↑' : '↓'} ${Math.abs(a.yoyPct).toFixed(1)}%</span>`
      : '<span class="av-na">—</span>';

    return `<tr>
      <td class="code">${r.code}</td>
      <td class="name" title="${r.name}">${r.name}</td>
      ${yrCells}
      <td class="ctr">${yoyH}</td>
      <td class="num">${a?.avgPrice ? fmt(a.avgPrice,0)+'원' : '<span class="av-na">—</span>'}</td>
      <td class="ctr">${fmtRate(r.profit.prodRate)}</td>
      <td class="ctr">${fmtRate(r.profit.stdRate)}</td>
    </tr>`;
  }).join('');

  document.getElementById('salesTableBody').innerHTML = topRow + dataRows;
}

// ── 판매 파일 업로드 이벤트
document.getElementById('salesFileInput').addEventListener('change', async function() {
  const file   = this.files[0]; if (!file) return;
  const worker = document.getElementById('salesWorker').value.trim();
  if (!worker) { showToast('작업자 이름을 입력하세요.'); this.value=''; return; }

  const result = await parseSalesFile(file);
  if (!result) { this.value=''; return; }

  const { rows, skipped, usedCols } = result;
  if (!rows.length) { showToast('유효한 판매 데이터가 없습니다.'); this.value=''; return; }

  // 중복 여부 확인
  const newCodes = new Set(rows.map(r => r.code));
  const overlap  = [...newCodes].filter(c => G_sales.data[c]).length;

  const msg = overlap
    ? `${rows.length}건 로드 (${overlap}개 품목은 누적 합산). 인식 컬럼: ${Object.values(usedCols).filter(Boolean).join(', ')}`
    : `${rows.length}건 로드. 인식 컬럼: ${Object.values(usedCols).filter(Boolean).join(', ')}`;

  if (!confirm(`${msg}\n\n날짜 파싱 실패: ${skipped.length}건\n\n업로드하겠습니까?`)) { this.value=''; return; }

  mergeSalesRows(rows);
  saveSalesData();
  // Supabase 자동 동기화
  if (DB.isReady()) { DB.pushSalesData(G_sales.data, G_sales.meta).then(() => setSyncTs('sales')); }

  const msgEl = document.getElementById('salesUploadMsg');
  msgEl.textContent = `✅ ${rows.length}건 업로드 완료 (${worker}) · 날짜 파싱 실패: ${skipped.length}건`;
  msgEl.classList.remove('hidden');

  renderSalesTab('');
  showToast(`판매 ${rows.length}건 업로드 완료`);
  this.value = '';
});

// ============================================================
// 이력 다운로드 (관리자 비밀번호 필요)
// ============================================================

window.downloadHistory = function(sessionId, sessionType, ts, uploaderName) {
  const label = SESS_TYPE[sessionType]?.label || sessionType;
  openAdminModal(
    `이력 다운로드 (관리자 인증 필요)\n유형: ${label} / 작업자: ${uploaderName}\n${new Date(ts).toLocaleString('ko-KR')}`,
    async (actor, pw) => {
      const ok = await verifyAdmin(pw);
      if (!ok) return '비밀번호가 올바르지 않습니다.';
      await DB.logDownload('history_download', actor, G.clientIP, null, sessionType);
      await doHistoryDownload(sessionId, sessionType, ts, uploaderName);
      return null;
    }
  );
};

async function doHistoryDownload(sessionId, sessionType, ts, uploaderName) {
  const safe = uploaderName.replace(/[^a-zA-Z0-9가-힣]/g, '_');
  const date = ts.slice(0, 10);

  if (sessionType === 'item_data') {
    const items = DB.isReady() ? await DB.getItemsBySession(sessionId) : G.items;
    if (!items?.length) { showToast('데이터가 없습니다.'); return; }
    downloadAsExcel(
      ['품목코드','품목명','규격','구매처','재고수량','입고예정수량','리드타임(일)','안전재고','전년월평균','당년월평균','판매추이','가용재고(월)','입고포함가용재고(월)'],
      items.map(it => [it.code,it.name,it.spec||'',it.supplier||'',it.stock??'',it.incoming??'',it.leadtime??'',it.safety_stock??'',it.avg_prev??'',it.avg_cur??'',it.trend??'',it.avail_mo??'',it.avail_mo_incl??'']),
      '품목데이터', `OJC_품목데이터_${safe}_${date}.xlsx`
    );
  } else if (sessionType === 'stock_update') {
    // 재고 업데이트 세부 이력 없음 → 현재 아이템 데이터 제공
    showToast('재고 업데이트 세부 이력은 저장되지 않습니다. 현재 품목 데이터를 다운로드합니다.');
    downloadAsExcel(
      ['품목코드','품목명','재고수량','입고예정수량','가용재고(월)','입고포함가용재고(월)'],
      G.items.map(it => [it.code,it.name,it.stock??'',it.incoming??'',it.avail_mo??'',it.avail_mo_incl??'']),
      '재고현황', `OJC_재고현황_${safe}_${date}.xlsx`
    );
  } else if (sessionType === 'price_list') {
    const hist = DB.isReady() ? await DB.getPriceHistoryNear(ts) : [];
    if (!hist?.length) { showToast('해당 시점의 가격 이력이 없습니다.'); return; }
    downloadAsExcel(
      ['변경일시','작업자','IP','품목코드','품목명','수입가격(전)','수입가격(후)','맥산원가(전)','맥산원가(후)','생산원가(전)','생산원가(후)','표준원가(전)','표준원가(후)'],
      hist.map(h => [new Date(h.changed_at).toLocaleString('ko-KR'),h.changed_by,h.ip_address||'',h.item_code,h.item_name||'',h.import_price_old??'',h.import_price_new??'',h.maeksan_cost_old??'',h.maeksan_cost_new??'',h.prod_cost_old??'',h.prod_cost_new??'',h.standard_cost_old??'',h.standard_cost_new??'']),
      '가격이력', `OJC_가격이력_${safe}_${date}.xlsx`
    );
  } else if (sessionType === 'incoming') {
    downloadIncomingAsExcel(`OJC_입고예정_${safe}_${date}.xlsx`);
  } else if (sessionType === 'sales') {
    downloadSalesAsExcel(`OJC_판매현황_${safe}_${date}.xlsx`);
  } else {
    showToast('이 유형은 다운로드를 지원하지 않습니다.');
  }
}

// ── 공통 Excel 다운로드 유틸
function downloadAsExcel(headers, dataRows, sheetName, filename) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
  ws['!cols'] = headers.map(() => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
  showToast('다운로드 완료: ' + filename);
}

// ── 이력 행에 다운로드 버튼 표시 (loadUploadHistory 오버라이드)
const _origLoadHistory = loadUploadHistory;

// ============================================================
// 입고예정 업로드 / 다운로드
// ============================================================

let G_incoming = []; // 업로드된 입고예정 데이터

function loadIncomingData() {
  try { G_incoming = JSON.parse(localStorage.getItem('ojc_incoming_uploaded') || '[]'); } catch {}
}
function saveIncomingData() {
  localStorage.setItem('ojc_incoming_uploaded', JSON.stringify(G_incoming));
}

APP.downloadIncomingTemplate = function() {
  const wb = XLSX.utils.book_new();
  const note    = ['※ * 표시 필수. 날짜 형식: YYYY-MM-DD 또는 YYYY/MM/DD'];
  const headers = ['발주번호*','사용부서','품번*','품목명','규격','발주수량*','실발주일','ETD','ETA','입고예정일*','입고지','비고'];
  const ws = XLSX.utils.aoa_to_sheet([note, headers]);
  ws['!cols'] = [{wch:12},{wch:10},{wch:16},{wch:30},{wch:20},{wch:12},{wch:14},{wch:14},{wch:14},{wch:14},{wch:10},{wch:20}];
  ws['!merges'] = [{ s:{r:0,c:0}, e:{r:0,c:headers.length-1} }];
  XLSX.utils.book_append_sheet(wb, ws, '입고예정');
  XLSX.writeFile(wb, 'OJC_입고예정_템플릿.xlsx');
  showToast('입고예정 템플릿 다운로드');
};

document.getElementById('incomingFileInput').addEventListener('change', async function() {
  const file   = this.files[0]; if (!file) return;
  const worker = document.getElementById('incomingWorker').value.trim();
  if (!worker) { showToast('작업자 이름을 입력하세요.'); this.value=''; return; }
  const raw = await parseFile(file); if (!raw) { this.value=''; return; }

  const hIdx = raw.findIndex(r => r.some(c => String(c).replace(/[*\s]/g,'').includes('품번') || String(c).replace(/[*\s]/g,'').includes('발주번호')));
  if (hIdx < 0) { showToast('헤더에 "발주번호" 또는 "품번" 컬럼이 없습니다.'); this.value=''; return; }
  const headers = raw[hIdx].map(h => String(h||'').replace(/[*★]/g,'').trim());
  const ci = k => headers.findIndex(h => h.includes(k));

  const rows = [];
  for (let r = hIdx+1; r < raw.length; r++) {
    const row  = raw[r];
    const code = String(row[ci('품번')]||row[ci('품목코드')]||'').trim();
    if (!code) continue;
    rows.push({
      poNo:      String(row[ci('발주번호')]||row[ci('발주#')]||'').trim(),
      dept:      String(row[ci('사용부서')]||row[ci('부서')]||'').trim(),
      code,
      name:      String(row[ci('품목명')]||'').trim(),
      spec:      String(row[ci('규격')]||'').trim(),
      qty:       String(row[ci('발주수량')]||row[ci('수량')]||'').replace(/[,\s]/g,''),
      orderDate: String(row[ci('실발주일')]||'').trim(),
      eta:       String(row[ci('ETD')]||'').trim(),
      etaExpected: String(row[ci('ETA')]||'').trim(),
      etaExpected2: String(row[ci('입고예정일')]||'').trim(),
      loc:       String(row[ci('입고지')]||'').trim(),
      note:      String(row[ci('비고')]||'').trim(),
      _source:   'upload',
    });
  }
  if (!rows.length) { showToast('유효한 데이터가 없습니다.'); this.value=''; return; }
  if (!confirm(`${rows.length}건의 입고예정 데이터를 업로드하겠습니까?\n작업자: ${worker}`)) { this.value=''; return; }

  G_incoming = rows;
  saveIncomingData();
  // Supabase 자동 동기화
  if (DB.isReady()) {
    DB.pushIncomingData(G_incoming).then(() => setSyncTs('incoming'));
    DB.saveIncoming(rows, worker, G.clientIP);
  }

  const msgEl = document.getElementById('incomingUploadMsg');
  msgEl.textContent = `✅ 입고예정 ${rows.length}건 업로드 완료 (${worker})`;
  msgEl.classList.remove('hidden');

  renderIncomingTab();
  await loadUploadHistory();
  showToast(`입고예정 ${rows.length}건 업로드 완료`);
  this.value = '';
});

document.getElementById('btnDownloadIncoming').addEventListener('click', () => {
  openAdminModal('입고예정 전체 데이터를 다운로드합니다.', async (actor, pw) => {
    const ok = await verifyAdmin(pw);
    if (!ok) return '비밀번호가 올바르지 않습니다.';
    await DB.logDownload('incoming_download', actor, G.clientIP,
      getIncomingAll().length, 'xlsx');
    downloadIncomingAsExcel(`OJC_입고예정_${actor}_${new Date().toISOString().slice(0,10)}.xlsx`);
    return null;
  });
});

function getIncomingAll() {
  const staticData = (typeof INCOMING_DATA !== 'undefined') ? INCOMING_DATA : [];
  const uploaded   = G_incoming.map(d => ({ ...d, _source: 'upload' }));
  // 업로드 데이터가 있으면 우선, 없으면 static 사용
  return uploaded.length ? uploaded : staticData;
}

function downloadIncomingAsExcel(filename) {
  const all = getIncomingAll();
  if (!all.length) { showToast('입고예정 데이터가 없습니다.'); return; }
  downloadAsExcel(
    ['발주#','부서','품번','품목명','규격','발주수량','실발주일','ETD','ETA','입고예정일','입고지','비고'],
    all.map(d => [d.poNo||'',d.dept||'',d.code||'',d.name||'',d.spec||'',d.qty||'',d.orderDate||'',d.eta||'',d.etaExpected||'',d.etaExpected2||d.etaExpected||'',d.loc||'',d.note||'']),
    '입고예정', filename
  );
}

function downloadSalesAsExcel(filename) {
  const years = getSalesYears();
  const rows  = [];
  const hdr   = ['품목코드','품목명', ...years.flatMap(y => [`${y}년 총판매수량`,`${y}년 월평균`]), '평균판매단가'];
  rows.push(hdr);
  for (const [code, byMonth] of Object.entries(G_sales.data)) {
    const byYear = {};
    Object.entries(byMonth).forEach(([ym, d]) => {
      const yr = ym.split('/')[0];
      if (!byYear[yr]) byYear[yr] = { total: 0, months: 0, amt: 0 };
      byYear[yr].total  += d.qty;
      byYear[yr].months += 1;
      byYear[yr].amt    += d.amount || 0;
    });
    const totalQ = Object.values(byYear).reduce((s,d) => s + d.total, 0);
    const totalA = Object.values(byYear).reduce((s,d) => s + d.amt,   0);
    const avgP   = totalQ > 0 && totalA > 0 ? Math.round(totalA / totalQ) : '';
    const row = [code, G_sales.meta[code] || ''];
    years.forEach(yr => {
      const d = byYear[yr];
      row.push(d ? d.total : '');
      row.push(d ? Math.round(d.total / d.months) : '');
    });
    row.push(avgP);
    rows.push(row);
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, '판매현황');
  XLSX.writeFile(wb, filename);
  showToast('판매현황 다운로드 완료');
}

// ── 판매 드래그앤드롭
const sdz2 = document.getElementById('salesDropzone');
sdz2.addEventListener('dragover',  e => { e.preventDefault(); sdz2.classList.add('drag'); });
sdz2.addEventListener('dragleave', () => sdz2.classList.remove('drag'));
sdz2.addEventListener('drop', async e => {
  e.preventDefault(); sdz2.classList.remove('drag');
  const file = e.dataTransfer.files[0]; if (!file) return;
  const inp  = document.getElementById('salesFileInput');
  const dt   = new DataTransfer(); dt.items.add(file); inp.files = dt.files;
  inp.dispatchEvent(new Event('change'));
});

// ── 초기화
document.getElementById('btnClearSales').addEventListener('click', () => {
  if (!confirm('판매 데이터를 전체 삭제하겠습니까?')) return;
  G_sales.data = {}; G_sales.meta = {};
  saveSalesData();
  document.getElementById('salesUploadMsg').classList.add('hidden');
  renderSalesTab('');
  showToast('판매 데이터 초기화 완료');
});

// ============================================================
// 재고현황 업데이트 모듈
// ============================================================

let G_stock = {
  method:   'file',    // 'file' | 'manual'
  parsed:   null,      // 파일 업로드 시 파싱 결과 { stockMap, rows }
  manualMap: {},       // 수기입력 변경값 { code: qty }
};

// ── 탭 전환
document.querySelectorAll('.stock-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.stock-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    G_stock.method = btn.dataset.method;
    document.getElementById('stockFileSection').classList.toggle('hidden', G_stock.method !== 'file');
    document.getElementById('stockManualSection').classList.toggle('hidden', G_stock.method !== 'manual');
    if (G_stock.method === 'manual') renderStockManualTable('');
    syncStockConfirmBtn();
  });
});

// ── 파일 업로드
document.getElementById('stockFileInput').addEventListener('change', async function() {
  const file = this.files[0]; if (!file) return;
  const raw = await parseFile(file); if (!raw) { this.value=''; return; }

  // 헤더 행 탐색: 품목코드 포함 행
  const hIdx = raw.findIndex(r =>
    r.some(c => String(c).replace(/\s/g,'').includes('품목코드'))
  );
  if (hIdx < 0) {
    showToast('헤더에 "품목코드" 컬럼이 없습니다.');
    this.value=''; return;
  }
  const headers = raw[hIdx].map(h => String(h||'').trim());
  const ci = k => headers.findIndex(h => h.includes(k));

  const codeIdx  = ci('품목코드');
  // 재고수량(D열) 우선, 없으면 '재고' 포함 컬럼 사용
  const stockIdx = ci('재고수량') >= 0 ? ci('재고수량') : ci('재고');
  if (codeIdx < 0) {
    showToast('"품목코드" 컬럼을 찾을 수 없습니다. 헤더를 확인하세요.');
    this.value=''; return;
  }
  if (stockIdx < 0) {
    showToast('"재고수량" 컬럼을 찾을 수 없습니다. 헤더를 확인하세요.');
    this.value=''; return;
  }

  // 사용 중인 컬럼 안내
  const usedColName = headers[stockIdx];

  const stockMap = {};
  const rows = [];
  for (let r = hIdx+1; r < raw.length; r++) {
    const row  = raw[r];
    const code = String(row[codeIdx]||'').trim();
    if (!code) continue;
    const qty = num(row[stockIdx]);
    if (qty === null) continue;
    stockMap[code] = qty;
    rows.push({
      code,
      name: String(row[ci('품목명')]||'').trim(),
      spec: String(row[ci('규격명')] || row[ci('규격')] || '').trim(),
      qty,
    });
  }

  // 어떤 컬럼을 재고로 사용했는지 안내
  if (usedColName !== '재고수량') {
    showToast(`재고 컬럼: "${usedColName}" (열 ${stockIdx+1}) 사용됨`);
  }

  if (!Object.keys(stockMap).length) {
    showToast('유효한 재고 데이터가 없습니다.');
    this.value=''; return;
  }

  // 매칭 확인
  const matched   = rows.filter(r => G.items.some(i => i.code === r.code));
  const unmatched = rows.filter(r => !G.items.some(i => i.code === r.code));

  G_stock.parsed = { stockMap, rows, matched, unmatched };
  renderStockFilePreview(matched, unmatched);
  syncStockConfirmBtn();
  this.value = '';
});

// ── 미매칭 사유 분석
function findUnmatchedReason(code) {
  if (G.items.length === 0) return '⚠ 발주검토 데이터 미업로드';
  const norm = s => s.replace(/[\s\-\.]/g, '').toLowerCase();
  const nc   = norm(code);

  // 공백·대소문자만 다른 경우
  const fuzzy = G.items.find(i => norm(i.code) === nc);
  if (fuzzy) return `코드 유사 (공백/대소문자 차이) → ${fuzzy.code}`;

  // 부분 일치
  const partial = G.items.find(i =>
    norm(i.code).includes(nc) || nc.includes(norm(i.code))
  );
  if (partial) return `부분 일치 코드 있음 → ${partial.code}`;

  return '발주검토 목록 미등록 품목';
}

function renderStockFilePreview(matched, unmatched) {
  const prev = document.getElementById('stockFilePreview');
  prev.classList.remove('hidden');
  const sample = matched.slice(0, 5);

  // 미매칭 사유 분석 포함
  const unmatchedRows = unmatched.map(r => ({
    ...r,
    reason: findUnmatchedReason(r.code),
  }));

  // 미매칭 섹션 HTML
  const unmatchedHTML = unmatched.length ? `
    <div class="unmatched-section">
      <button class="unmatched-toggle" onclick="toggleUnmatched(this)">
        ⚠ 미매칭 ${unmatched.length}건 — 클릭하여 사유 확인 ▼
      </button>
      <div class="unmatched-list hidden">
        <table>
          <thead>
            <tr>
              <th>품목코드</th><th>품목명</th>
              <th style="text-align:right">재고수량</th>
              <th>미매칭 사유</th>
            </tr>
          </thead>
          <tbody>
            ${unmatchedRows.map(r => {
              const isFuzzy  = r.reason.includes('유사') || r.reason.includes('부분');
              const isNoData = r.reason.includes('미업로드');
              const color    = isFuzzy ? 'var(--warn)' : isNoData ? '#94a3b8' : 'var(--urgent)';
              return `<tr>
                <td class="code">${r.code}</td>
                <td style="font-size:12px">${r.name}</td>
                <td style="text-align:right">${r.qty.toLocaleString('ko-KR')}</td>
                <td style="color:${color};font-size:11px;font-weight:600">${r.reason}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>` : '';

  prev.innerHTML = `
    <div style="padding:10px 12px;background:#eff6ff;border-bottom:1px solid #bfdbfe;font-size:12px;font-weight:600;color:var(--primary)">
      ✅ 파일 인식 완료 —
      매칭 <strong>${matched.length}건</strong> 업데이트 예정
      ${unmatched.length
        ? `<span style="color:var(--warn);margin-left:14px">⚠ 미매칭 ${unmatched.length}건 (제외)</span>`
        : '<span style="color:var(--ok);margin-left:14px">✓ 전체 매칭</span>'}
    </div>
    <div style="overflow-x:auto;padding:8px 12px">
      <div style="font-size:11px;color:#64748b;margin-bottom:6px">매칭 항목 미리보기 (최대 5건)</div>
      <table>
        <thead>
          <tr>
            <th>품목코드</th><th>품목명</th><th>규격</th>
            <th style="text-align:right">재고수량(D열)</th>
          </tr>
        </thead>
        <tbody>
          ${sample.map(r => `<tr>
            <td class="code">${r.code}</td>
            <td>${r.name}</td>
            <td style="font-size:11px;color:#64748b">${r.spec||'—'}</td>
            <td style="text-align:right;font-weight:700;color:var(--primary)">${r.qty.toLocaleString('ko-KR')}</td>
          </tr>`).join('')}
          ${matched.length > 5
            ? `<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:6px">…외 ${matched.length - 5}건</td></tr>`
            : ''}
        </tbody>
      </table>
    </div>
    ${unmatchedHTML}`;
}

window.toggleUnmatched = function(btn) {
  const list = btn.nextElementSibling;
  const isHidden = list.classList.contains('hidden');
  list.classList.toggle('hidden', !isHidden);
  btn.innerHTML = btn.innerHTML.replace(isHidden ? '▼' : '▲', isHidden ? '▲' : '▼');
};

// ── 수기 입력 테이블
window.renderStockManualTable = function(query) {
  const q    = (query||'').toLowerCase();
  const all  = G.items;
  const list = q ? all.filter(i => i.code.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)) : all;
  document.getElementById('stockManualInfo').textContent = `${list.length}건`;

  document.getElementById('stockManualBody').innerHTML = list.map(it => {
    const current  = num(it.stock) ?? 0;
    const newVal   = G_stock.manualMap[it.code];
    const hasEdit  = newVal !== undefined;
    const codeE    = it.code.replace(/'/g,"\\'");
    return `<tr style="${hasEdit?'background:#eff6ff':''}">
      <td style="padding:5px 10px;font-family:monospace;font-size:11px;border-bottom:1px solid #f0f4f8">${it.code}</td>
      <td style="padding:5px 10px;border-bottom:1px solid #f0f4f8">${it.name}</td>
      <td style="padding:5px 10px;font-size:11px;color:#64748b;border-bottom:1px solid #f0f4f8">${it.spec||'—'}</td>
      <td style="padding:5px 10px;text-align:right;color:${current<0?'var(--urgent)':'#475569'};border-bottom:1px solid #f0f4f8">
        ${current.toLocaleString('ko-KR')}
      </td>
      <td style="padding:5px 10px;border-bottom:1px solid #f0f4f8;text-align:right">
        <input type="number" class="order-input ${hasEdit?'has-val':''}"
          value="${hasEdit ? newVal : ''}"
          placeholder="${current}"
          min="-99999999" step="1"
          onchange="onStockManualChange('${codeE}', this.value)"
          style="width:100px;text-align:right">
      </td>
    </tr>`;
  }).join('');
};

window.onStockManualChange = function(code, val) {
  const n = parseInt(val, 10);
  if (!isNaN(n)) { G_stock.manualMap[code] = n; }
  else           { delete G_stock.manualMap[code]; }
  syncStockConfirmBtn();
};

function syncStockConfirmBtn() {
  const btn = document.getElementById('btnConfirmStock');
  const info = document.getElementById('stockConfirmInfo');
  if (G_stock.method === 'file') {
    const cnt = G_stock.parsed?.matched?.length || 0;
    btn.disabled = cnt === 0;
    info.textContent = cnt ? `${cnt}건 업데이트 예정` : '';
  } else {
    const cnt = Object.keys(G_stock.manualMap).length;
    btn.disabled = cnt === 0;
    info.textContent = cnt ? `${cnt}건 변경됨` : '';
  }
}

// ── 재고 업데이트 확정
document.getElementById('btnConfirmStock').addEventListener('click', async () => {
  const worker = document.getElementById('stockWorkerName').value.trim();
  if (!worker) { showToast('작업자 이름을 입력하세요.'); return; }

  const stockMap = G_stock.method === 'file'
    ? G_stock.parsed?.stockMap || {}
    : G_stock.manualMap;

  if (!Object.keys(stockMap).length) { showToast('업데이트할 재고 데이터가 없습니다.'); return; }

  const cnt = Object.keys(stockMap).length;
  if (!confirm(`${cnt}건의 재고수량을 업데이트하겠습니까?\n작업자: ${worker}`)) return;

  // G.items 즉시 반영
  G.items = G.items.map(item => {
    if (!(item.code in stockMap)) return item;
    const newStock = stockMap[item.code];
    const avg = item.avg_cur || item.avg_prev || 0;
    return {
      ...item,
      stock:         newStock,
      avail_mo:      avg > 0 ? newStock / avg : item.avail_mo,
      avail_mo_incl: avg > 0 ? (newStock + (num(item.incoming)||0)) / avg : item.avail_mo_incl,
    };
  });

  // Supabase 업데이트 + 이력 저장
  if (DB.isReady()) {
    const res = await DB.updateItemStock(stockMap, worker, G.clientIP);
    if (res.error && !res.updated) {
      showToast('저장 오류: ' + res.error); return;
    }
  } else {
    // Supabase 미연결 시 localStorage 임시 보관
    const saved = JSON.parse(localStorage.getItem('ojc_stock_history') || '[]');
    saved.unshift({ worker, cnt, ts: new Date().toISOString(), offline: true });
    localStorage.setItem('ojc_stock_history', JSON.stringify(saved.slice(0, 30)));
  }

  // 초기화
  G_stock.parsed    = null;
  G_stock.manualMap = {};
  document.getElementById('stockFilePreview').classList.add('hidden');
  document.getElementById('btnConfirmStock').disabled = true;
  document.getElementById('stockConfirmInfo').textContent = '';
  document.getElementById('stockWorkerName').value = '';
  if (G_stock.method === 'manual') renderStockManualTable('');

  // 화면 갱신
  updateStats();
  renderTable();
  renderCostTab();
  await loadUploadHistory();

  // ✅ 발주계획 탭으로 자동 이동
  showToast(`✅ 재고 ${cnt}건 업데이트 완료 — 발주계획 반영됨 (${worker})`);
  setTimeout(() => {
    switchTab('plan');
    setFilter('urgent'); // 즉시발주 필터로 이동 (변경된 재고 기준)
  }, 900);
});

// ── 재고 드래그앤드롭
const sdz = document.getElementById('stockDropzone');
sdz.addEventListener('dragover', e => { e.preventDefault(); sdz.classList.add('drag'); });
sdz.addEventListener('dragleave', () => sdz.classList.remove('drag'));
sdz.addEventListener('drop', async e => {
  e.preventDefault(); sdz.classList.remove('drag');
  const file = e.dataTransfer.files[0]; if (!file) return;
  const inp  = document.getElementById('stockFileInput');
  const dt   = new DataTransfer(); dt.items.add(file); inp.files = dt.files;
  inp.dispatchEvent(new Event('change'));
});

// ── Dropzone 드래그앤드롭
const dz = document.getElementById('dropzone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', async e => {
  e.preventDefault(); dz.classList.remove('drag');
  const file = e.dataTransfer.files[0]; if (!file) return;
  const inp  = document.getElementById('uploadFileInput');
  const dt   = new DataTransfer(); dt.items.add(file); inp.files = dt.files;
  inp.dispatchEvent(new Event('change'));
});

// ============================================================
// 유틸
// ============================================================
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}
function setHeaderSub(txt) { document.getElementById('headerSub').textContent = txt; }
function updateSyncBadge(ok) {
  const el = document.getElementById('syncStatus');
  el.className = 'sync-badge ' + (ok ? 'sync-ready' : 'sync-offline');
  el.textContent = ok ? '☁ 연결됨' : '☁ 오프라인';
}

// ============================================================
// 열 필터 (Column Filter) 모듈
// ============================================================

let colFilters = {};
let _cfKey     = null;
let _cfPending = null;

function getItemColDisplayVal(item, cfKey) {
  switch (cfKey) {
    case 'cf_proc':    return calcProcMethod(item.code).text;
    case 'cf_urgency': {
      const m = { urgent:'🔴 즉시발주', warning:'🟡 발주검토', ok:'🟢 여유', na:'—' };
      return m[item._urgency] || '—';
    }
    case 'cf_code':     return item.code || '';
    case 'cf_name':     return item.name || '';
    case 'cf_spec':     return item.spec  || '(규격 없음)';
    case 'cf_supplier': return SUP_SHORT[item.supplier] || item.supplier.split(' ')[0] || '';
    case 'cf_trend':    return item.trend?.trim() || '(없음)';
    case 'cf_leadtime': return String(item.leadtime || '');
    case 'cf_avail': {
      const v = num(item.avail_mo_incl);
      if (v === null) return '데이터 없음';
      if (v < 0)  return '음수 (재고부족)';
      if (v < 2)  return '0~2개월 (즉시발주)';
      if (v < 4)  return '2~4개월 (발주검토)';
      return '4개월 이상 (여유)';
    }
    case 'cf_timing':   return calcTiming(item).text;
    default: return '';
  }
}

function getColUniqueValues(cfKey) {
  const vals = new Set();
  G.items.map(enrichItem).forEach(it => {
    const v = getItemColDisplayVal(it, cfKey);
    if (v !== '') vals.add(v);
  });
  if (cfKey === 'cf_urgency')
    return ['🔴 즉시발주','🟡 발주검토','🟢 여유','—'].filter(v => vals.has(v));
  if (cfKey === 'cf_avail')
    return ['음수 (재고부족)','0~2개월 (즉시발주)','2~4개월 (발주검토)','4개월 이상 (여유)','데이터 없음'].filter(v => vals.has(v));
  return [...vals].sort((a, b) => a.localeCompare(b, 'ko'));
}

window.openColFilter = function(cfKey, btn) {
  _cfKey = cfKey;
  const dd      = document.getElementById('cfDropdown');
  const allVals = getColUniqueValues(cfKey);
  const active  = colFilters[cfKey];
  _cfPending    = active ? new Set(active) : new Set(allVals);
  document.getElementById('cfSearch').value = '';
  renderCfList(allVals, _cfPending, '');
  const rect = btn.getBoundingClientRect();
  dd.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
  dd.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - 244) + 'px';
  dd.classList.remove('hidden');
  document.getElementById('cfSearch').focus();
};

function renderCfList(allVals, selected, query) {
  const q       = query.toLowerCase();
  const visible = q ? allVals.filter(v => v.toLowerCase().includes(q)) : allVals;
  document.getElementById('cfList').innerHTML = visible.map(v =>
    `<label class="cf-item">
      <input type="checkbox" value="${v.replace(/"/g,'&quot;')}"
        ${selected.has(v)?'checked':''}
        onchange="cfToggleVal(this.value,this.checked)">
      <span title="${v}">${v}</span>
    </label>`
  ).join('') || '<p style="padding:10px 12px;font-size:12px;color:#94a3b8">결과 없음</p>';
}

window.cfToggleVal = function(val, checked) {
  if (checked) _cfPending.add(val); else _cfPending.delete(val);
};

window.cfSelectAll = function(checked) {
  const query   = document.getElementById('cfSearch').value;
  const allVals = getColUniqueValues(_cfKey);
  const visible = query ? allVals.filter(v => v.toLowerCase().includes(query.toLowerCase())) : allVals;
  visible.forEach(v => checked ? _cfPending.add(v) : _cfPending.delete(v));
  renderCfList(allVals, _cfPending, query);
};

window.applyCfFilter = function() {
  const allVals = getColUniqueValues(_cfKey);
  if (_cfPending.size === 0 || _cfPending.size >= allVals.length) delete colFilters[_cfKey];
  else colFilters[_cfKey] = new Set(_cfPending);
  closeColFilter();
  renderTable();
  _syncCfBtnState();
};

window.closeColFilter = function() {
  document.getElementById('cfDropdown').classList.add('hidden');
  _cfKey = null; _cfPending = null;
};

window.resetColFilters = function() {
  colFilters = {};
  renderTable();
  _syncCfBtnState();
  showToast('열 필터가 초기화됐습니다.');
};

function _syncCfBtnState() {
  const hasAny = Object.keys(colFilters).length > 0;
  document.getElementById('btnResetCf')?.classList.toggle('hidden', !hasAny);
  document.querySelectorAll('.cf-btn').forEach(btn =>
    btn.classList.toggle('cf-active', !!(colFilters[btn.dataset.col]?.size > 0))
  );
}

document.addEventListener('click', e => {
  const dd = document.getElementById('cfDropdown');
  if (!dd?.classList.contains('hidden') && !e.target.closest('#cfDropdown') &&
      !e.target.classList.contains('cf-btn')) closeColFilter();
});

// ──────────────────────────────────────────────────────────
function setFilter(f) {
  G.curFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter===f));
  document.querySelectorAll('.stat-card').forEach(c => c.classList.toggle('active', c.dataset.filter===f));
  renderTable();
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById('tab-' + tab).classList.remove('hidden');
  if (tab==='confirmed') renderConfirmedTab();
  if (tab==='incoming')  renderIncomingTab();
  if (tab==='cost')      renderCostTab(document.getElementById('costSearch').value);
  if (tab==='upload')    loadUploadHistory();
  if (tab==='sync')      loadSyncSettings();
  if (tab==='sales')     renderSalesTab(document.getElementById('salesSearch')?.value || '');
}

// ============================================================
// 동기화 모듈
// ============================================================

const SYNC_TYPES = [
  { key:'items',     label:'품목데이터',    icon:'📋', localFn: () => G.items.length,            sbFn: 'loadLatestItems'   },
  { key:'prices',    label:'원가 데이터',   icon:'💰', localFn: () => Object.keys(G.prices).length,   sbFn: 'loadPrices'     },
  { key:'orderPlan', label:'발주 확정',     icon:'✅', localFn: () => Object.keys(G.orderPlan).length, sbFn: 'loadOrderPlan'  },
  { key:'sales',     label:'판매현황',      icon:'📊', localFn: () => Object.keys(G_sales.data).length, sbFn: 'pullSalesData' },
  { key:'incoming',  label:'입고예정',      icon:'🚢', localFn: () => G_incoming.length,           sbFn: 'pullIncomingData'  },
];

// 로컬 동기화 타임스탬프
function getSyncTs()    { try { return JSON.parse(localStorage.getItem('ojc_sync_ts')||'{}'); } catch { return {}; } }
function setSyncTs(key) { const d=getSyncTs(); d[key]=new Date().toISOString(); localStorage.setItem('ojc_sync_ts',JSON.stringify(d)); }

async function loadSyncSettings() {
  document.getElementById('sbUrl').value = localStorage.getItem('ojc_sb_url') || SB_URL || '';
  document.getElementById('sbKey').value = localStorage.getItem('ojc_sb_key') || SB_ANON_KEY || '';
  const box = document.getElementById('syncConnStatus');
  if (DB.isReady()) {
    box.className = 'sync-status-box sync-ok';
    box.textContent = '✅ Supabase 연결됨 — 모든 PC·브라우저에서 데이터 공유 가능합니다.';
  } else {
    box.className = 'sync-status-box sync-err';
    box.textContent = '⚠ Supabase 미연결 — URL과 Anon Key를 입력 후 저장하세요.';
  }
  await renderSyncMatrix();
}

async function renderSyncMatrix() {
  if (!document.getElementById('syncMatrixBody')) return;
  const syncTs  = getSyncTs();
  let sbStatus  = {};
  if (DB.isReady()) sbStatus = await DB.getSyncStatus().catch(() => ({}));

  document.getElementById('syncMatrixBody').innerHTML = SYNC_TYPES.map(t => {
    const localCnt = t.localFn();
    const sbInfo   = sbStatus[t.key];
    const sbCnt    = sbInfo?.row_count ?? '?';
    const lastSync = syncTs[t.key] ? new Date(syncTs[t.key]).toLocaleString('ko-KR') : '미동기화';
    const isSynced = !!syncTs[t.key];

    const statusBadge = !DB.isReady()
      ? `<span style="font-size:10px;color:#94a3b8">Supabase 미연결</span>`
      : isSynced
        ? `<span style="font-size:10px;color:var(--ok)">✅ ${lastSync}</span>`
        : `<span style="font-size:10px;color:var(--warn)">⚠ 미동기화</span>`;

    return `<div style="display:grid;grid-template-columns:1fr 120px 1fr;align-items:center;padding:9px 12px;border-bottom:1px solid var(--border)">
      <div>
        <span style="font-size:13px">${t.icon} ${t.label}</span>
        <span style="font-size:10px;color:#94a3b8;margin-left:8px">로컬 ${localCnt.toLocaleString()}건 / Supabase ${typeof sbCnt==='number'?sbCnt.toLocaleString():sbCnt}건</span>
      </div>
      <div style="text-align:center">${statusBadge}</div>
      <div style="text-align:right;display:flex;gap:6px;justify-content:flex-end">
        <button class="btn btn-ghost-xs" onclick="syncPush('${t.key}')" ${!DB.isReady()?'disabled':''}>↑ 업로드</button>
        <button class="btn btn-ghost-xs" onclick="syncPull('${t.key}')" ${!DB.isReady()?'disabled':''}>↓ 다운로드</button>
      </div>
    </div>`;
  }).join('')
  + `<div style="padding:9px 12px;border-top:2px solid var(--border);font-size:11px;color:#94a3b8">
      마지막 전체 동기화: ${getSyncTs()._all ? new Date(getSyncTs()._all).toLocaleString('ko-KR') : '없음'}
    </div>`;
}

// ── 개별 Push
window.syncPush = async function(key) {
  if (!DB.isReady()) { showToast('Supabase 미연결'); return; }
  const msgEl = document.getElementById('syncActionMsg');
  msgEl.style.color = '#64748b'; msgEl.textContent = `${key} 업로드 중…`;
  let res;
  try {
    switch(key) {
      case 'items':     res = await DB.uploadItems(G.items, '동기화', G.clientIP); break;
      case 'prices':    res = { ok:true }; showToast('원가는 수정 시 자동 저장됩니다.'); break;
      case 'orderPlan':
        for (const [code, p] of Object.entries(G.orderPlan))
          await DB.saveOrderPlan(code, p.order_qty??0, p.is_confirmed, p.confirmed_by||'sync', G.clientIP);
        res = { ok:true };
        break;
      case 'sales':     res = await DB.pushSalesData(G_sales.data, G_sales.meta); break;
      case 'incoming':  res = await DB.pushIncomingData(G_incoming); break;
    }
    if (res?.ok) { setSyncTs(key); msgEl.style.color='var(--ok)'; msgEl.textContent=`✅ ${key} 업로드 완료`; }
    else { msgEl.style.color='var(--urgent)'; msgEl.textContent=`오류: ${res?.error||'실패'}`; }
  } catch(e) { msgEl.style.color='var(--urgent)'; msgEl.textContent=`오류: ${e.message}`; }
  await renderSyncMatrix();
};

// ── 개별 Pull
window.syncPull = async function(key) {
  if (!DB.isReady()) { showToast('Supabase 미연결'); return; }
  if (!confirm(`Supabase에서 [${key}] 데이터를 내려받습니다.\n현재 로컬 데이터가 덮어씌워집니다. 계속할까요?`)) return;
  const msgEl = document.getElementById('syncActionMsg');
  msgEl.style.color='#64748b'; msgEl.textContent=`${key} 다운로드 중…`;
  try {
    switch(key) {
      case 'items': {
        const items = await DB.loadLatestItems();
        if (items?.length) { G.items = items.map(normalizeItem); buildSupplierSelect(); updateStats(); renderTable(); }
        break;
      }
      case 'prices': {
        G.prices = await DB.loadPrices() || {};
        renderTable(); renderCostTab();
        break;
      }
      case 'orderPlan': {
        G.orderPlan = await DB.loadOrderPlan() || {};
        updateStats(); renderTable(); renderConfirmedTab();
        break;
      }
      case 'sales': {
        const [d, m] = await Promise.all([DB.pullSalesData(), DB.pullSalesMeta()]);
        if (d) { G_sales.data = d; G_sales.meta = m||{}; saveSalesData(); renderSalesTab(''); renderTable(); }
        break;
      }
      case 'incoming': {
        const inc = await DB.pullIncomingData();
        if (inc) { G_incoming = inc; saveIncomingData(); renderIncomingTab(); }
        break;
      }
    }
    setSyncTs(key);
    msgEl.style.color='var(--ok)'; msgEl.textContent=`✅ ${key} 다운로드 완료`;
    showToast(`${key} 다운로드 완료`);
  } catch(e) { msgEl.style.color='var(--urgent)'; msgEl.textContent=`오류: ${e.message}`; }
  await renderSyncMatrix();
};

// ── 전체 Push
document.getElementById('btnSyncPushAll')?.addEventListener('click', async () => {
  if (!DB.isReady()) { showToast('먼저 Supabase URL과 Key를 설정하세요.'); return; }
  if (!confirm('모든 로컬 데이터를 Supabase에 업로드합니다. 계속할까요?')) return;
  const msgEl = document.getElementById('syncActionMsg');
  msgEl.style.color='#64748b'; msgEl.textContent='전체 업로드 중…';
  try {
    await DB.pushSalesData(G_sales.data, G_sales.meta);
    setSyncTs('sales');
    await DB.pushIncomingData(G_incoming);
    setSyncTs('incoming');
    for (const [code, p] of Object.entries(G.orderPlan))
      await DB.saveOrderPlan(code, p.order_qty??0, p.is_confirmed, p.confirmed_by||'sync', G.clientIP);
    setSyncTs('orderPlan');
    // items, prices: 이미 자동 저장
    setSyncTs('items'); setSyncTs('prices');
    const d = getSyncTs(); d._all = new Date().toISOString(); localStorage.setItem('ojc_sync_ts',JSON.stringify(d));
    msgEl.style.color='var(--ok)'; msgEl.textContent='✅ 전체 업로드 완료';
    showToast('전체 데이터 Supabase 업로드 완료');
  } catch(e) { msgEl.style.color='var(--urgent)'; msgEl.textContent=`오류: ${e.message}`; }
  await renderSyncMatrix();
});

// ── 전체 Pull
document.getElementById('btnSyncPullAll')?.addEventListener('click', async () => {
  if (!DB.isReady()) { showToast('먼저 Supabase URL과 Key를 설정하세요.'); return; }
  if (!confirm('⚠ Supabase의 모든 데이터를 내 PC로 다운로드합니다.\n현재 로컬 데이터가 모두 덮어씌워집니다. 계속할까요?')) return;
  const msgEl = document.getElementById('syncActionMsg');
  msgEl.style.color='#64748b'; msgEl.textContent='전체 다운로드 중…';
  try {
    const all = await DB.pullAll();
    if (all.settings)  { G.settings = all.settings; G.stdRatio = num(all.settings.std_cost_ratio) ?? DEFAULT_STD_RATIO; }
    if (all.prices)    { G.prices = all.prices; }
    if (all.plan)      { G.orderPlan = all.plan; localStorage.setItem('ojc_order_plan', JSON.stringify(all.plan)); }
    if (all.items?.length) { G.items = all.items.map(normalizeItem); }
    if (all.sales)     { G_sales.data = all.sales; G_sales.meta = all.salesMeta||{}; saveSalesData(); }
    if (all.incoming?.length) { G_incoming = all.incoming; saveIncomingData(); }

    // 타임스탬프
    const d = getSyncTs();
    ['items','prices','orderPlan','sales','incoming'].forEach(k => { d[k]=new Date().toISOString(); });
    d._all = new Date().toISOString();
    localStorage.setItem('ojc_sync_ts',JSON.stringify(d));

    buildSupplierSelect(); updateStats(); renderTable();
    renderCostTab(); renderConfirmedTab(); renderIncomingTab(); renderSalesTab('');
    msgEl.style.color='var(--ok)'; msgEl.textContent='✅ 전체 다운로드 완료 — 페이지가 최신 데이터로 업데이트됐습니다.';
    showToast('전체 데이터 다운로드 완료');
  } catch(e) { msgEl.style.color='var(--urgent)'; msgEl.textContent=`오류: ${e.message}`; }
  await renderSyncMatrix();
});

// ============================================================
// 정렬 헤더
// ============================================================
function initSort() {
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (G.sortCol===col) G.sortDir = G.sortDir==='asc'?'desc':'asc';
      else { G.sortCol=col; G.sortDir='asc'; }
      document.querySelectorAll('th.sortable').forEach(h => h.classList.remove('sort-asc','sort-desc'));
      th.classList.add(G.sortDir==='asc'?'sort-asc':'sort-desc');
      renderTable();
    });
  });
}

// ============================================================
// 저장 / 초기화
// ============================================================
document.getElementById('btnSave').addEventListener('click', () => {
  if (!DB.isReady()) localStorage.setItem('ojc_order_plan', JSON.stringify(G.orderPlan));
  showToast('저장 완료');
});
document.getElementById('btnReset').addEventListener('click', () => {
  if (!confirm('모든 발주 확정 및 수량 입력을 초기화하겠습니까?')) return;
  G.orderPlan = {};
  if (DB.isReady()) {
    // order_plan은 각 항목별로 is_confirmed=false로 업데이트 (간단히 로컬만 초기화)
  }
  localStorage.removeItem('ojc_order_plan');
  updateStats(); renderTable(); renderConfirmedTab();
  showToast('초기화 완료');
});

// ============================================================
// 구매처 셀렉트 빌드
// ============================================================
function buildSupplierSelect() {
  const sel  = document.getElementById('supplierFilter');
  const sups = [...new Set(G.items.map(i=>i.supplier))].filter(Boolean).sort();
  sel.innerHTML = '<option value="">전체 구매처</option>';
  sups.forEach(s => {
    const o = document.createElement('option');
    o.value = s; o.textContent = SUP_SHORT[s]||s; sel.appendChild(o);
  });
}

// ============================================================
// 초기화
// ============================================================
async function init() {
  // Supabase 설정 — localStorage 우선, 없으면 config.js 값
  const savedUrl = localStorage.getItem('ojc_sb_url') || SB_URL;
  const savedKey = localStorage.getItem('ojc_sb_key') || SB_ANON_KEY;
  if (savedUrl && savedKey) {
    // config.js의 전역 변수를 덮어쓰는 방식으로 db.js init 호출
    Object.assign(window, { SB_URL: savedUrl, SB_ANON_KEY: savedKey });
  }
  DB.init();
  await fetchIP();
  loadSalesData();    // 판매 데이터 localStorage 로드
  loadIncomingData(); // 입고예정 업로드 데이터 로드
  await loadData();
  buildSupplierSelect();
  initSort();

  // 통계카드 클릭
  document.querySelectorAll('.stat-card').forEach(c =>
    c.addEventListener('click', () => { switchTab('plan'); setFilter(c.dataset.filter); })
  );
  // 필터버튼
  document.querySelectorAll('.filter-btn').forEach(b =>
    b.addEventListener('click', () => setFilter(b.dataset.filter))
  );
  // 탭버튼
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.addEventListener('click', () => switchTab(b.dataset.tab))
  );
  // 셀렉트 필터
  document.getElementById('supplierFilter').addEventListener('change', e => { G.curSupplier=e.target.value; renderTable(); });
  document.getElementById('trendFilter').addEventListener('change',    e => { G.curTrend=e.target.value;    renderTable(); });
  // 검색
  document.getElementById('searchBox').addEventListener('input', e => { G.curSearch=e.target.value.trim(); renderTable(); });
  // 열 필터 검색 입력
  document.getElementById('cfSearch')?.addEventListener('input', function() {
    if (_cfKey) renderCfList(getColUniqueValues(_cfKey), _cfPending, this.value);
  });
  document.getElementById('costSearch').addEventListener('input', e => renderCostTab(e.target.value.trim()));
  // 원가 칼럼 토글
  document.getElementById('showCostCols').addEventListener('change', function() { G.showCost=this.checked; renderTable(); });
  // 발주확정 (벌크)
  document.getElementById('btnBulkConfirm').addEventListener('click', () => {
    const checked = [...document.querySelectorAll('.chk-conf:checked')]
      .map(c=>c.dataset.code).filter(code=>!G.orderPlan[code]?.is_confirmed);
    checked.forEach(code => {
      if (!G.orderPlan[code]) G.orderPlan[code]={};
      G.orderPlan[code].is_confirmed=true;
      if (DB.isReady()) DB.saveOrderPlan(code, G.orderPlan[code].order_qty??0, true, '일괄확정', G.clientIP).catch(()=>{});
    });
    updateStats(); renderTable(); renderConfirmedTab();
    document.getElementById('bulkBar').classList.remove('show');
    showToast(`${checked.length}건 발주 확정`);
  });
  document.getElementById('btnBulkCancel').addEventListener('click', () => {
    document.querySelectorAll('.chk-conf').forEach(c => { if (!G.orderPlan[c.dataset.code]?.is_confirmed) c.checked=false; });
    document.getElementById('bulkBar').classList.remove('show');
  });
  // 체크박스 변화 감지 (벌크바 표시)
  document.getElementById('tbodyMain').addEventListener('change', e => {
    if (!e.target.classList.contains('chk-conf')) return;
    const sel = [...document.querySelectorAll('.chk-conf:checked')]
      .filter(c => !G.orderPlan[c.dataset.code]?.is_confirmed);
    const bar = document.getElementById('bulkBar');
    if (sel.length) { bar.classList.add('show'); document.getElementById('bulkCount').textContent=`${sel.length}건 선택됨`; }
    else bar.classList.remove('show');
  });
  // 전체선택
  document.getElementById('chkAll').addEventListener('change', function() {
    document.querySelectorAll('.chk-conf').forEach(c => { if (!G.orderPlan[c.dataset.code]?.is_confirmed) c.checked=this.checked; });
    const sel = this.checked ? [...document.querySelectorAll('.chk-conf:checked')]
      .filter(c=>!G.orderPlan[c.dataset.code]?.is_confirmed).length : 0;
    const bar = document.getElementById('bulkBar');
    if (sel) { bar.classList.add('show'); document.getElementById('bulkCount').textContent=`${sel}건 선택됨`; }
    else bar.classList.remove('show');
  });
  // 발주확정 탭 export
  document.getElementById('btnExportConfirm').addEventListener('click', exportConfirmCSV);
  // 초기 정렬 표시
  const urgTh = document.querySelector('th[data-col="urgency"]');
  if (urgTh) urgTh.classList.add('sort-asc');
}

document.addEventListener('DOMContentLoaded', init);
