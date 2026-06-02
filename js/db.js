'use strict';
// ============================================================
// DB.js — Supabase 데이터 레이어
// ============================================================

let _sb = null;

const DB = {
  // ── 초기화 ────────────────────────────────────────────────
  init() {
    if (!SB_URL || !SB_ANON_KEY) return false;
    try {
      _sb = supabase.createClient(SB_URL, SB_ANON_KEY);
      return true;
    } catch { return false; }
  },
  isReady() { return !!_sb; },

  // ── 설정 ──────────────────────────────────────────────────
  async getSettings() {
    if (!_sb) return {};
    const { data } = await _sb.from('settings').select('*');
    const map = {};
    (data || []).forEach(r => { map[r.key] = r.value; });
    return map;
  },
  async setSetting(key, value, by) {
    if (!_sb) return;
    await _sb.from('settings').upsert({ key, value, updated_by: by, updated_at: new Date().toISOString() });
  },

  // ── 품목 데이터 ───────────────────────────────────────────
  async loadLatestItems() {
    if (!_sb) return null;
    // 가장 최근 active 세션의 items 반환
    const { data: sess } = await _sb
      .from('upload_sessions')
      .select('id')
      .eq('session_type', 'item_data')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1);
    if (!sess || !sess.length) return null;
    const sessionId = sess[0].id;
    const { data: items } = await _sb
      .from('items')
      .select('*')
      .eq('session_id', sessionId)
      .order('code');
    return items || [];
  },

  async uploadItems(items, uploaderName, ip) {
    if (!_sb) return { error: 'Supabase 미연결' };
    // 이전 sessions 비활성화
    await _sb.from('upload_sessions')
      .update({ is_active: false })
      .eq('session_type', 'item_data');
    // 새 세션 생성
    const { data: sess, error: sessErr } = await _sb.from('upload_sessions').insert({
      session_type: 'item_data',
      uploader_name: uploaderName,
      row_count: items.length,
      ip_address: ip,
      is_active: true,
    }).select().single();
    if (sessErr) return { error: sessErr.message };
    // items 삽입 (batch 50)
    const rows = items.map(it => ({ ...it, session_id: sess.id }));
    for (let i = 0; i < rows.length; i += 50) {
      const { error } = await _sb.from('items').insert(rows.slice(i, i + 50));
      if (error) return { error: error.message };
    }
    return { ok: true, sessionId: sess.id };
  },

  async getUploadSessions(type) {
    if (!_sb) return [];
    const q = _sb.from('upload_sessions').select('*').order('created_at', { ascending: false }).limit(20);
    if (type) q.eq('session_type', type);
    const { data } = await q;
    return data || [];
  },

  // ── 가격 ──────────────────────────────────────────────────
  async loadPrices() {
    if (!_sb) return {};
    const { data } = await _sb.from('prices').select('*');
    const map = {};
    (data || []).forEach(r => { map[r.item_code] = r; });
    return map;
  },

  // merge=true : 공란 항목은 기존값 유지 (업로드 시 사용)
  // merge=false: 공란 항목은 null로 덮어쓰기 (웹 직접 수정 시 사용)
  async savePrice(itemCode, itemName, newPrices, changedBy, ip, merge = false) {
    if (!_sb) return { error: 'Supabase 미연결' };
    // 기존 가격 조회 (이력 기록 + merge 시 기존값 보존용)
    const { data: old } = await _sb.from('prices').select('*').eq('item_code', itemCode).single();
    const now = new Date().toISOString();

    // merge 모드: null인 신규값은 기존값으로 채움
    const val = (newKey, oldKey) => {
      const n = newPrices[newKey];
      return (merge && (n === null || n === undefined)) ? (old?.[oldKey] ?? null) : (n ?? null);
    };

    const row = {
      item_code:    itemCode,
      item_name:    itemName || old?.item_name,
      import_price:  val('import_price',  'import_price'),
      maeksan_cost:  val('maeksan_cost',  'maeksan_cost'),
      prod_cost:     val('prod_cost',     'prod_cost'),
      std_ratio:     val('std_ratio',     'std_ratio'),
      standard_cost: val('standard_cost', 'standard_cost'),
      updated_by: changedBy, ip_address: ip, updated_at: now,
    };
    const { error } = await _sb.from('prices').upsert(row, { onConflict: 'item_code' });
    if (error) return { error: error.message };
    // 이력 기록
    await _sb.from('price_history').insert({
      item_code: itemCode, item_name: itemName,
      import_price_old:  old?.import_price,  import_price_new:  newPrices.import_price,
      maeksan_cost_old:  old?.maeksan_cost,  maeksan_cost_new:  newPrices.maeksan_cost,
      prod_cost_old:     old?.prod_cost,     prod_cost_new:     newPrices.prod_cost,
      std_ratio_old:     old?.std_ratio,     std_ratio_new:     newPrices.std_ratio,
      standard_cost_old: old?.standard_cost, standard_cost_new: newPrices.standard_cost,
      changed_by: changedBy, ip_address: ip, changed_at: now,
    });
    return { ok: true };
  },

  async loadPriceHistory(itemCode) {
    if (!_sb) return [];
    const q = _sb.from('price_history').select('*').order('changed_at', { ascending: false }).limit(100);
    if (itemCode) q.eq('item_code', itemCode);
    const { data } = await q;
    return data || [];
  },

  // 가격 업로드 (배치)
  async uploadPrices(priceRows, uploaderName, ip) {
    if (!_sb) return { error: 'Supabase 미연결' };
    // 세션 기록
    const { data: sess } = await _sb.from('upload_sessions').insert({
      session_type: 'price_list', uploader_name: uploaderName,
      row_count: priceRows.length, ip_address: ip, is_active: true,
    }).select().single();
    const errors = [];
    for (const pr of priceRows) {
      const res = await DB.savePrice(pr.code, pr.name, pr, uploaderName, ip, true); // merge=true
      if (res.error) errors.push(`${pr.code}: ${res.error}`);
    }
    return errors.length ? { error: errors.join('\n') } : { ok: true, count: priceRows.length };
  },

  // ── 다운로드 로그 ─────────────────────────────────────────
  async logDownload(actionType, actorName, ip, itemCount, fileType) {
    if (!_sb) return;
    await _sb.from('download_log').insert({
      action_type: actionType, actor_name: actorName,
      ip_address: ip, item_count: itemCount, file_type: fileType,
    });
  },

  async getDownloadLog(limit = 100) {
    if (!_sb) return [];
    const { data } = await _sb.from('download_log')
      .select('*').order('created_at', { ascending: false }).limit(limit);
    return data || [];
  },

  // ── 이력 다운로드용 데이터 조회 ───────────────────────────
  async getItemsBySession(sessionId) {
    if (!_sb || !sessionId) return [];
    const { data } = await _sb.from('items').select('*')
      .eq('session_id', sessionId).order('code');
    return data || [];
  },

  // 특정 시점 ±window분 이내 가격 이력 조회
  async getPriceHistoryNear(ts, windowMin = 120) {
    if (!_sb) return [];
    const t = new Date(ts);
    const from = new Date(t.getTime() - windowMin * 60000).toISOString();
    const to   = new Date(t.getTime() + windowMin * 60000).toISOString();
    const { data } = await _sb.from('price_history').select('*')
      .gte('changed_at', from).lte('changed_at', to)
      .order('changed_at');
    return data || [];
  },

  // 입고예정 데이터 저장 (Supabase 없을 시 localStorage 폴백)
  async saveIncoming(rows, uploaderName, ip) {
    if (!_sb) return { error: 'Supabase 미연결' };
    // upload_sessions 기록
    await _sb.from('upload_sessions').insert({
      session_type: 'incoming', uploader_name: uploaderName,
      row_count: rows.length, ip_address: ip, is_active: true,
    });
    return { ok: true };
  },

  // ── 재고 업데이트 ────────────────────────────────────────
  async updateItemStock(stockMap, uploaderName, ip) {
    if (!_sb) return { error: 'Supabase 미연결' };
    const { data: sess } = await _sb.from('upload_sessions')
      .select('id').eq('session_type','item_data').eq('is_active',true)
      .order('created_at',{ascending:false}).limit(1);
    const sessionId = sess?.[0]?.id;

    let updated = 0, errors = [];
    for (const [code, qty] of Object.entries(stockMap)) {
      let q = _sb.from('items').update({ stock: qty });
      if (sessionId) q = q.eq('session_id', sessionId);
      const { error } = await q.eq('code', code);
      if (error) errors.push(code); else updated++;
    }
    // 업로드 이력 기록
    await _sb.from('upload_sessions').insert({
      session_type:'stock_update', uploader_name: uploaderName,
      row_count: updated, ip_address: ip, is_active: false,
    });
    return errors.length ? { error:`${errors.length}건 실패`, updated } : { ok:true, updated };
  },

  // ── 판매현황 동기화 ───────────────────────────────────────
  async pushSalesData(salesData, salesMeta) {
    if (!_sb) return { error: 'Supabase 미연결' };
    // 전체 삭제 후 재삽입
    await _sb.from('sales_data').delete().not('id','is',null);
    const rows = [];
    for (const [code, byMo] of Object.entries(salesData)) {
      for (const [ym, d] of Object.entries(byMo)) {
        rows.push({ item_code:code, year_month:ym, qty:d.qty||0, amount:d.amount||0 });
      }
    }
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await _sb.from('sales_data').insert(rows.slice(i, i+200));
      if (error) return { error: error.message };
    }
    // 메타 저장
    if (salesMeta && Object.keys(salesMeta).length) {
      await _sb.from('sales_meta').delete().not('item_code','is',null);
      const mRows = Object.entries(salesMeta).map(([k,v]) => ({ item_code:k, item_name:v }));
      for (let i = 0; i < mRows.length; i += 200)
        await _sb.from('sales_meta').insert(mRows.slice(i, i+200));
    }
    await this._markSync('sales', rows.length);
    return { ok:true, count:rows.length };
  },

  async pullSalesData() {
    if (!_sb) return null;
    const { data } = await _sb.from('sales_data').select('*');
    if (!data?.length) return null;
    const result = {};
    data.forEach(r => {
      if (!result[r.item_code]) result[r.item_code] = {};
      result[r.item_code][r.year_month] = { qty: r.qty||0, amount: r.amount||0 };
    });
    return result;
  },

  async pullSalesMeta() {
    if (!_sb) return {};
    const { data } = await _sb.from('sales_meta').select('*');
    const meta = {};
    (data||[]).forEach(r => { meta[r.item_code] = r.item_name; });
    return meta;
  },

  // ── 입고예정 동기화 ───────────────────────────────────────
  async pushIncomingData(rows) {
    if (!_sb) return { error: 'Supabase 미연결' };
    await _sb.from('incoming_data').delete().not('id','is',null);
    if (!rows.length) return { ok:true, count:0 };
    const insRows = rows.map(r => ({
      po_no:r.poNo||'', dept:r.dept||'', code:r.code||'', name:r.name||'', spec:r.spec||'',
      qty:r.qty||null, order_date:r.orderDate||'', eta:r.eta||'',
      eta_expected:r.etaExpected||'', eta_expected2:r.etaExpected2||r.etaExpected||'',
      loc:r.loc||'', note:r.note||'', source:'upload',
    }));
    const { error } = await _sb.from('incoming_data').insert(insRows);
    if (error) return { error: error.message };
    await this._markSync('incoming', rows.length);
    return { ok:true, count:rows.length };
  },

  async pullIncomingData() {
    if (!_sb) return null;
    const { data } = await _sb.from('incoming_data').select('*')
      .order('eta_expected2', { ascending:true });
    if (!data?.length) return null;
    return data.map(r => ({
      poNo:r.po_no, dept:r.dept, code:r.code, name:r.name, spec:r.spec,
      qty:r.qty, orderDate:r.order_date, eta:r.eta,
      etaExpected:r.eta_expected, etaExpected2:r.eta_expected2,
      loc:r.loc, note:r.note, _source:'upload',
    }));
  },

  // ── 동기화 타임스탬프 ─────────────────────────────────────
  async _markSync(key, count) {
    if (!_sb) return;
    await _sb.from('sync_status').upsert({
      key, synced_at: new Date().toISOString(), row_count: count,
    }, { onConflict:'key' });
  },

  async getSyncStatus() {
    if (!_sb) return {};
    const { data } = await _sb.from('sync_status').select('*');
    const map = {};
    (data||[]).forEach(r => { map[r.key] = r; });
    return map;
  },

  // ── 전체 다운로드 (Pull All) ──────────────────────────────
  async pullAll() {
    if (!_sb) return { error: 'Supabase 미연결' };
    const [items, prices, plan, settings, sales, salesMeta, incoming] = await Promise.all([
      this.loadLatestItems(),
      this.loadPrices(),
      this.loadOrderPlan(),
      this.getSettings(),
      this.pullSalesData(),
      this.pullSalesMeta(),
      this.pullIncomingData(),
    ]);
    return { items, prices, plan, settings, sales, salesMeta, incoming };
  },

  // ── 발주 계획 ─────────────────────────────────────────────
  async loadOrderPlan() {
    if (!_sb) return {};
    const { data } = await _sb.from('order_plan').select('*');
    const map = {};
    (data || []).forEach(r => { map[r.item_code] = r; });
    return map;
  },

  async saveOrderPlan(itemCode, qty, isConfirmed, confirmedBy, ip) {
    if (!_sb) return;
    await _sb.from('order_plan').upsert({
      item_code: itemCode, order_qty: qty,
      is_confirmed: isConfirmed, confirmed_by: confirmedBy,
      ip_address: ip, updated_at: new Date().toISOString(),
    }, { onConflict: 'item_code' });
  },
};
