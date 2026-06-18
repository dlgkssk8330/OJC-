'use strict';
// ============================================================
// cert.js — 3시트 발주 파일 생성기
//   시트1: 완제품 비축 발주 요청 (VLOOKUP 수식 참조)
//   시트2: 단가표 (housing/boots 수식 포함)
//   시트3: 성적서 (8행×2열 블록, 행 방향 적층)
// ============================================================

const CERT = (() => {

  let _items   = [];
  let _srcFile = null;

  // ── 분류 ──────────────────────────────────────────────────
  const isMM  = n => /-MM[-( ]/i.test(n || '');
  const isFot = s => (s || '').includes('포앤티');

  function classify(name) { return isMM(name) ? 'MM' : 'SM'; }

  const SPECS = {
    SM: { il: '≤0.2dB', pc: '≥50dB', apc: '≥60dB' },
    MM: { il: '≤0.3dB', pc: '',      apc: ''       },  // MM 반사손실 미기재
  };

  // ── 이름 파서 ─────────────────────────────────────────────
  function parseMode(name) { return isMM(name) ? 'MM' : 'SM'; }

  // 케이블 종류: PIGTAIL / SOJC / DOJC / MOJC
  // KT OJC 품명: -SP 접미→SOJC, -DP 접미→DOJC
  function parseCableType(name) {
    const n = (name || '').toUpperCase();
    if (n.includes('PIGTAIL')) return 'PIGTAIL';
    if (n.startsWith('DOJC')) return 'DOJC';
    if (n.startsWith('SOJC')) return 'SOJC';
    if (n.startsWith('MOJC')) return 'MOJC';
    if (/[-_]DP(?:[-_]|$)/.test(n)) return 'DOJC';   // KT DP
    if (/[-_]SP(?:[-_]|$)/.test(n)) return 'SOJC';   // KT SP
    return 'SOJC';
  }

  // 케이블 타입: A1/A2/C2 (KT OJC 전용)
  function parseCableKind(name) {
    const m = (name || '').toUpperCase().match(/^OJC-([A-Z]\d)/);
    return m ? m[1] : 'A1';
  }

  // ── 커넥터 파서 ───────────────────────────────────────────
  // KT 품명: OJC-[A1]-[SC/SC]-[SM/MM]-[길이]-[PC/PC]-[SP/DP/nC]
  //          커넥터A/커넥터B 따로, 페룰A/페룰B 따로 → 합쳐서 SC/PC
  // LG 품명: SOJC-SM-[SC/PC]-[SC/PC]-3M-G657B3
  //          직접 SC/PC 형식
  function parseConnectors(name) {
    const n = (name || '').toUpperCase();
    const isPigtail = n.includes('PIGTAIL');

    if (isPigtail) {
      const m = n.match(/(SC|LC|FC|ST)\/(PC|APC)/);
      return { c1: m ? m[0] : '', c2: '' };
    }

    const parts = n.split('-');

    if (parts[0] === 'OJC') {
      // 커넥터 필드: SC/SC, SC/LC, LC/LC 등 (양쪽 모두 커넥터명)
      const connField = parts.find(p => /^(SC|LC|FC|ST)\/(SC|LC|FC|ST)$/.test(p));
      // 페룰 필드: PC/PC, APC/APC, PC/APC 등
      const ferrField = parts.find(p => /^(PC|APC)\/(PC|APC)$/.test(p));
      if (connField && ferrField) {
        const [cA, cB] = connField.split('/');
        const [fA, fB] = ferrField.split('/');
        return { c1: `${cA}/${fA}`, c2: `${cB}/${fB}` };
      }
      // 폴백: SC/PC 직접 패턴
      const ms = [...n.matchAll(/(SC|LC|FC|ST)\/(PC|APC)/g)].map(m => m[0]);
      return { c1: ms[0] || '', c2: ms[1] || ms[0] || '' };
    }

    if (/^(SOJC|DOJC|MOJC)/.test(parts[0])) {
      // LG: 필드 중 SC/PC 형식 직접 추출
      const connPat = /^(SC|LC|FC|ST)\/(PC|APC)$/;
      const conns = parts.filter(p => connPat.test(p));
      return { c1: conns[0] || '', c2: conns[1] || '' };
    }

    // 일반 폴백
    const ms = [...n.matchAll(/(SC|LC|FC|ST)\/(PC|APC)/g)].map(m => m[0]);
    return { c1: ms[0] || '', c2: ms[1] || '' };
  }

  // M수: 규격 → 품명 KT (-SM-3-) → 품명 LG (-3M-) 순으로 탐색
  function parseLength(spec, name) {
    let m = (spec || '').match(/(\d+(?:\.\d+)?)\s*M\b/i);
    if (m) return m[1] + 'M';
    // LG: -3M-
    m = (name || '').match(/[-_](\d+(?:\.\d+)?)M[-_]/i);
    if (m) return m[1] + 'M';
    // KT: -SM-3- 또는 -MM-3-
    const parts = (name || '').toUpperCase().split('-');
    for (let i = 0; i < parts.length - 1; i++) {
      if (/^(SM|MM)$/.test(parts[i]) && /^\d+(?:\.\d+)?$/.test(parts[i+1])) {
        return parts[i+1] + 'M';
      }
    }
    return '';
  }

  function parseCableSpec(name) {
    if ((name || '').includes('0.9')) return '0.9mm';
    if ((name || '').toUpperCase().includes('PIGTAIL')) return '0.9mm';
    return '2.0mm';
  }

  function parseFiberCount(name) {
    const m = (name || '').match(/[-_](\d+)[Cc][-_(]/);
    return m ? parseInt(m[1], 10) : null;
  }

  // ── 발주 확정 목록에서 불러오기 ────────────────────────────
  function loadFromApp() {
    if (typeof G === 'undefined') { showToast('앱 데이터가 로드되지 않았습니다.'); return; }
    const confirmed = G.items.filter(it => G.orderPlan[it.code]?.is_confirmed);
    if (!confirmed.length) { showToast('발주 확정된 항목이 없습니다.'); return; }
    _srcFile = null;
    _items = confirmed.map((it, i) => ({
      no:   i + 1,
      code: it.code || '',
      name: it.name || '',
      spec: it.spec || '',
      qty:  G.orderPlan[it.code]?.order_qty || 0,
      type: classify(it.name),
      fot:  isFot(it.spec),
    }));
    renderPreview();
    showToast(`${_items.length}건을 불러왔습니다.`);
  }

  // ── 파일 업로드 처리 ───────────────────────────────────────
  function handleFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb   = XLSX.read(e.target.result, { type: 'array' });
        const sn   = wb.SheetNames.find(n => /발주계획|계획|발주요청|발주/.test(n)) || wb.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: '' });
        _srcFile   = file.name;
        _items = rows
          .map((r, i) => {
            const code = String(r['품목코드'] || r['code'] || '').trim();
            const name = String(r['품목명']   || r['name'] || '').trim();
            const spec = String(r['규격']     || r['spec'] || '').trim();
            const qty  = Number(r['발주수량'] || r['수량']  || 0);
            if (!code && !name) return null;
            return { no: i+1, code, name, spec, qty, type: classify(name), fot: isFot(spec) };
          })
          .filter(Boolean);
        renderPreview();
        showToast(`${_items.length}건 파싱됨`);
      } catch (err) {
        showToast('파일 파싱 실패: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ── 유형 변경 ─────────────────────────────────────────────
  function updateType(idx, type) {
    if (_items[idx]) _items[idx].type = type;
  }

  // ── 미리보기 렌더링 ────────────────────────────────────────
  function renderPreview() {
    const el  = document.getElementById('certPreviewArea');
    const btn = document.getElementById('btnGenerateCert');
    if (!el) return;
    if (!_items.length) {
      el.innerHTML = '<p style="text-align:center;padding:36px;color:#94a3b8">불러온 항목이 없습니다.</p>';
      if (btn) btn.disabled = true;
      return;
    }
    el.innerHTML = `
      <div style="font-size:12px;color:#64748b;margin-bottom:8px">
        총 <b>${_items.length}</b>건
        ${_srcFile ? `<span style="margin-left:8px;color:#94a3b8">(${_srcFile})</span>` : ''}
        <span style="margin-left:12px;color:#94a3b8;font-size:11px">유형을 클릭해 SM/MM을 변경할 수 있습니다</span>
      </div>
      <div style="overflow:auto;max-height:320px;border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:#f8fafc;position:sticky;top:0;z-index:1">
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);width:32px">#</th>
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);width:120px;text-align:left">품목코드</th>
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);text-align:left">품목명</th>
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);text-align:left">규격</th>
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);width:64px;text-align:right">발주수량</th>
            <th style="padding:6px 8px;border-bottom:2px solid var(--border);width:80px;text-align:center">유형</th>
          </tr></thead>
          <tbody>${_items.map((it, i) => `
            <tr style="border-bottom:1px solid #f1f5f9">
              <td style="padding:5px 8px;text-align:center;color:#94a3b8">${it.no}</td>
              <td style="padding:5px 8px;font-family:monospace;font-size:11px">${it.code}</td>
              <td style="padding:5px 8px">${it.name}</td>
              <td style="padding:5px 8px;color:#64748b;font-size:11px">${it.spec}</td>
              <td style="padding:5px 8px;text-align:right">${Number(it.qty).toLocaleString()}</td>
              <td style="padding:5px 8px;text-align:center">
                <select onchange="CERT.updateType(${i}, this.value)"
                  style="border:1px solid var(--border);border-radius:6px;padding:2px 6px;font-size:12px;cursor:pointer;
                         background:${it.type==='MM'?'#fef3c7':'#dbeafe'};
                         color:${it.type==='MM'?'#92400e':'#1d4ed8'};font-weight:600">
                  <option value="SM" ${it.type==='SM'?'selected':''}>SM</option>
                  <option value="MM" ${it.type==='MM'?'selected':''}>MM</option>
                </select>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    if (btn) btn.disabled = false;
  }

  // ── SheetJS 헬퍼 ──────────────────────────────────────────
  const ENC = XLSX.utils.encode_cell;

  function cv(v, s) {
    return { v, t: typeof v === 'number' ? 'n' : 's', s: s || {} };
  }
  function cf(formula, resultType, s) {
    return { f: formula, t: resultType || 's', s: s || {} };
  }
  function addMerge(ws, r0, c0, r1, c1) {
    if (!ws['!merges']) ws['!merges'] = [];
    ws['!merges'].push({ s: { r: r0, c: c0 }, e: { r: r1, c: c1 } });
  }

  // ── 스타일 ────────────────────────────────────────────────
  const BD = {
    top:    { style: 'thin', color: { rgb: '999999' } },
    bottom: { style: 'thin', color: { rgb: '999999' } },
    left:   { style: 'thin', color: { rgb: '999999' } },
    right:  { style: 'thin', color: { rgb: '999999' } },
  };
  const BDB = {
    top:    { style: 'thin', color: { rgb: '000000' } },
    bottom: { style: 'thin', color: { rgb: '000000' } },
    left:   { style: 'thin', color: { rgb: '000000' } },
    right:  { style: 'thin', color: { rgb: '000000' } },
  };

  const S = {
    // 성적서
    line:   { fill: { patternType:'solid', fgColor:{rgb:'FFFF00'} }, alignment:{horizontal:'center',vertical:'center'}, border: BD },
    label:  { alignment:{horizontal:'center',vertical:'center'}, border: BD },
    value:  { alignment:{horizontal:'center',vertical:'center'}, border: BD },
    valueL: { alignment:{horizontal:'left',vertical:'center'},   border: BD },
    // 시트1
    title:  { font:{bold:true,sz:13}, alignment:{horizontal:'center',vertical:'center'} },
    hdr:    { font:{bold:true}, fill:{patternType:'solid',fgColor:{rgb:'D9D9D9'}}, alignment:{horizontal:'center',vertical:'center'}, border: BDB },
    hdrL:   { font:{bold:true}, fill:{patternType:'solid',fgColor:{rgb:'D9D9D9'}}, alignment:{horizontal:'left',vertical:'center'},   border: BDB },
    cell:   { alignment:{horizontal:'left',  vertical:'center',wrapText:true}, border: BDB },
    cellC:  { alignment:{horizontal:'center',vertical:'center'}, border: BDB },
    cellR:  { alignment:{horizontal:'right', vertical:'center'}, border: BDB },
    sum:    { font:{bold:true}, fill:{patternType:'solid',fgColor:{rgb:'EBF1DE'}}, alignment:{horizontal:'right',vertical:'center'}, border: BDB },
    sumL:   { font:{bold:true}, fill:{patternType:'solid',fgColor:{rgb:'EBF1DE'}}, alignment:{horizontal:'center',vertical:'center'}, border: BDB },
  };

  // ══════════════════════════════════════════════════════════
  // 시트2: 단가표
  // 컬럼: A품번 B품명 C규격 D케이블종류 E케이블MODE F케이블타입
  //        G커넥터1 H커넥터2 I M수 J케이블규격 K커넥터1단가
  //        L커넥터2단가 M케이블가격 N단가 O수입가(RMB)
  //        P(housing수식) Q(boots수식) R(cable)
  // ══════════════════════════════════════════════════════════
  function buildDangaSheet(allItems, prices) {
    const ws = {};

    const HDRS = [
      '품번','품명','규격','케이블 종류','케이블 MODE','케이블 타입',
      '커넥터1','커넥터2','M수','케이블 규격','커넥터1 단가','커넥터2 단가',
      '케이블 가격','단가','수입가(RMB)','housing','boots','cable',
    ];
    HDRS.forEach((h, c) => {
      ws[ENC({r:0, c})] = cv(h, S.hdr);
    });

    // housing 컬러 공식 빌더
    // FC 타입은 하우징이 금속(metal) → SC/PC,LC/PC만 blue, SC/APC,LC/APC만 green
    const connColor = g =>
      `IF(OR(${g}="SC/PC",${g}="LC/PC"),"blue",IF(OR(${g}="SC/APC",${g}="LC/APC"),"green","metal"))`;
    // boots: SOJC/DOJC(=LG) + MM + SC/PC,LC/PC → beige, FC/PC → black
    const bootsColor = (g, er) =>
      `IF(AND(OR(LEFT(B${er},1)="S",LEFT(B${er},1)="D"),E${er}="MM",OR(${g}="SC/PC",${g}="LC/PC")),"beige",IF(OR(${g}="SC/PC",${g}="LC/PC"),"blue",IF(OR(${g}="SC/APC",${g}="LC/APC",${g}="FC/APC"),"green",IF(${g}="FC/PC","black",""))))`;

    allItems.forEach((item, i) => {
      const r  = i + 1;
      const er = r + 1; // Excel 1-based
      const { c1, c2 } = parseConnectors(item.name);
      const ctype  = parseCableType(item.name);
      const mode   = parseMode(item.name);
      const cKind  = parseCableKind(item.name);       // A1/A2/C2
      const length = parseLength(item.spec, item.name);
      const cspec  = parseCableSpec(item.name);
      const p      = prices[item.code] || {};
      const usd    = Number(p.import_price) || 0;
      const rmb    = Number(p.maeksan_cost) || 0;

      const row = [
        item.code, item.name, item.spec, ctype, mode, cKind,
        c1, c2, length, cspec,
        '', '', '',     // 커넥터1단가, 커넥터2단가, 케이블가격 (수동 입력)
        usd > 0 ? usd : '',
        rmb > 0 ? rmb : '',
      ];
      row.forEach((v, col) => {
        const st = col >= 13 ? S.cellR : (col === 0 ? S.cell : S.cell);
        ws[ENC({r, c: col})] = cv(v, st);
      });

      // P: housing 수식
      const hF = `G${er}&" "&${connColor(`G${er}`)}&IF(H${er}<>"",", "&H${er}&" "&${connColor(`H${er}`)},"")`;
      ws[ENC({r, c:15})] = cf(hF, 's', S.cell);

      // Q: boots 수식 (MM+PC→beige, DOJC→ & red)
      const bF1 = `G${er}&" "&${bootsColor(`G${er}`,er)}&IF(D${er}="DOJC"," & red","")`;
      const bF2 = `H${er}&" "&${bootsColor(`H${er}`,er)}&IF(D${er}="DOJC"," & red","")`;
      const bF  = `${bF1}&IF(H${er}<>"",", "&${bF2},"")`;
      ws[ENC({r, c:16})] = cf(bF, 's', S.cell);

      // R: cable
      let cable = 'yellow cable';
      if (ctype === 'PIGTAIL') {
        const fc = parseFiberCount(item.name);
        cable = fc ? fc + 'colors' : '';
      }
      ws[ENC({r, c:17})] = cv(cable, S.cell);
    });

    ws['!cols'] = [
      {wch:15},{wch:42},{wch:16},{wch:10},{wch:10},{wch:8},
      {wch:12},{wch:12},{wch:7}, {wch:10},{wch:12},{wch:12},
      {wch:12},{wch:12},{wch:12},{wch:32},{wch:32},{wch:14},
    ];
    ws['!ref'] = `A1:R${allItems.length + 1}`;
    return ws;
  }

  // ══════════════════════════════════════════════════════════
  // 시트1: 완제품 비축 발주 요청
  // 컬럼: A NO. B품목코드 C품목명 D규격 E발주수량
  //        F단가(VLOOKUP) G합계 H성적서 I LOT J케이블마킹 K spec detail
  // ══════════════════════════════════════════════════════════
  function buildOrderSheet(items, ymd) {
    const ws = {};
    const DS = 4; // data start row (0-based) → Excel row 5

    // 타이틀 (row 0)
    ws[ENC({r:0,c:0})] = cv('OJC 완제품 비축 발주 요청 건', S.title);
    addMerge(ws, 0, 0, 0, 10);

    // 헤더 (row 3)
    ['No.','품목코드','품목명','규격','발주수량','단가','합계','성적서','LOT','케이블 마킹','spec detail']
      .forEach((h, c) => { ws[ENC({r:3,c})] = cv(h, c===0?S.hdr:S.hdr); });

    // 데이터 행
    items.forEach((it, i) => {
      const r  = DS + i;
      const er = r + 1; // Excel 1-based

      ws[ENC({r, c:0})] = cv(i + 1, S.cellC);   // No.
      ws[ENC({r, c:1})] = cv(it.code, S.cell);  // 품목코드
      ws[ENC({r, c:2})] = cv(it.name, S.cell);  // 품목명 (정적)
      ws[ENC({r, c:3})] = cv(it.spec, S.cell);  // 규격 (정적)
      ws[ENC({r, c:4})] = cv(it.qty,  S.cellR); // 발주수량

      // F: 단가 = VLOOKUP(단가표 N열 = 14번째)
      ws[ENC({r,c:5})] = cf(
        `IFERROR(VLOOKUP($B${er},단가표!$A:$R,14,0),"")`, 'n', S.cellR);

      // G: 합계 = E * F
      ws[ENC({r,c:6})] = cf(`IF(OR(B${er}="",F${er}=""),"",E${er}*F${er})`, 'n', S.cellR);

      // H: 성적서 유형
      ws[ENC({r,c:7})] = cf(
        `IF(B${er}="","",IF(ISNUMBER(SEARCH("포앤티",D${er})),"포앤티용 성적서","기본 성적서"))`,
        's', S.cellC);

      // I: LOT
      ws[ENC({r,c:8})] = cf(
        `IF(B${er}="","",IF(ISNUMBER(SEARCH("포앤티",D${er})),"FOT${ymd}","AJW${ymd}"))`,
        's', S.cell);

      // J: 케이블 마킹
      ws[ENC({r,c:9})] = cf(
        `IF(B${er}="","",IF(ISNUMBER(SEARCH("PIGTAIL",C${er})),"-",C${er}&"-"&I${er}))`,
        's', S.cell);

      // K: spec detail (P=16, Q=17, R=18번째 열)
      ws[ENC({r,c:10})] = cf(
        `IF(B${er}="","","housing: "&IFERROR(VLOOKUP($B${er},단가표!$A:$R,16,0),"")&` +
        `"     boots: "&IFERROR(VLOOKUP($B${er},단가표!$A:$R,17,0),"")&` +
        `"     cable: "&IFERROR(VLOOKUP($B${er},단가표!$A:$R,18,0),""))`,
        's', S.cell);
    });

    // 합계 행
    const sr = DS + items.length;
    ws[ENC({r:sr,c:0})] = cv('합  계', S.sumL);
    addMerge(ws, sr, 0, sr, 3);
    ws[ENC({r:sr,c:4})] = cf(`SUM(E${DS+1}:E${sr})`,     'n', S.sum);
    ws[ENC({r:sr,c:5})] = cv('', S.sumL);
    ws[ENC({r:sr,c:6})] = cf(`SUM(G${DS+1}:G${sr})`,     'n', S.sum);
    for (let c = 7; c <= 10; c++) ws[ENC({r:sr,c})] = cv('', S.sumL);

    ws['!cols'] = [
      {wch:7},  // A
      {wch:17}, // B
      {wch:45}, // C
      {wch:18}, // D
      {wch:12}, // E
      {wch:12}, // F
      {wch:18}, // G
      {wch:18}, // H
      {wch:18}, // I
      {wch:45}, // J
      {wch:64}, // K
    ];
    ws['!ref'] = `A1:K${sr + 1}`;
    return ws;
  }

  // ══════════════════════════════════════════════════════════
  // 시트3: 성적서
  //   · 2개씩 나란히 (sc=0, sc=6), 그룹이 아래로 쌓임
  //   · 그룹당 8행: LINE | 품명 | 규격 | LOT | 수량 | 파장 | 삽입손실 | 반사손실
  //   · 항상 12열 고정 (A-L)
  // ══════════════════════════════════════════════════════════
  function buildCertSheet(items, ymd) {
    const ws = {};
    const GR = 8; // rows per group
    const BLOCK = 6;

    items.forEach((item, i) => {
      const gIdx   = Math.floor(i / 2);
      const inG    = i % 2;         // 0=좌, 1=우
      const baseR  = gIdx * GR;
      const sc     = inG * BLOCK;   // 시작 열
      const d      = sc + 1;        // 첫 데이터 열
      const sp     = SPECS[item.type] || SPECS.SM;
      const lotNo  = (item.fot ? 'FOT' : 'AJW') + ymd;
      const lineN  = i + 1;

      // row 0: LINE N (노란 배경)
      ws[ENC({r:baseR, c:sc})] = cv('LINE  ' + lineN, S.line);
      for (let j = 1; j <= 4; j++) ws[ENC({r:baseR, c:sc+j})] = cv('', S.line);

      // rows 1-5: 라벨 | 4열 병합 데이터
      const waveband = item.type === 'MM' ? '850nm ~ 1300nm' : '1310nm ~ 1630nm';
      [
        [1, '품           명', item.name, S.valueL],
        [2, '규           격', item.spec, S.valueL],
        [3, 'L O T   N O .', lotNo,      S.value ],
        [4, '수           량', item.qty + ' 본', S.value],
        [5, '파  장  대  역', waveband,           S.value],
      ].forEach(([off, label, val, vs]) => {
        const r = baseR + off;
        ws[ENC({r, c:sc  })] = cv(label, S.label);
        ws[ENC({r, c:d   })] = cv(val,   vs);
        ws[ENC({r, c:d+1 })] = cv('',    S.value);
        ws[ENC({r, c:d+2 })] = cv('',    S.value);
        ws[ENC({r, c:d+3 })] = cv('',    S.value);
        addMerge(ws, r, d, r, d+3);
      });

      // row 6: 삽입손실 | 유형(d:d+1) | 기준(d+2:d+3)
      const r6 = baseR + 6;
      ws[ENC({r:r6, c:sc  })] = cv('삽  입  손  실', S.label);
      ws[ENC({r:r6, c:d   })] = cv(item.type, S.value);
      ws[ENC({r:r6, c:d+1 })] = cv('',        S.value);
      ws[ENC({r:r6, c:d+2 })] = cv(sp.il,     S.value);
      ws[ENC({r:r6, c:d+3 })] = cv('',        S.value);
      addMerge(ws, r6, d,   r6, d+1);
      addMerge(ws, r6, d+2, r6, d+3);

      // row 7: 반사손실 | PC | 값 | APC | 값  (MM은 미기재 → 공백)
      const r7 = baseR + 7;
      ws[ENC({r:r7, c:sc  })] = cv('반  사  손  실', S.label);
      if (sp.pc || sp.apc) {
        ws[ENC({r:r7, c:d   })] = cv('PC',    S.value);
        ws[ENC({r:r7, c:d+1 })] = cv(sp.pc,  S.value);
        ws[ENC({r:r7, c:d+2 })] = cv('APC',  S.value);
        ws[ENC({r:r7, c:d+3 })] = cv(sp.apc, S.value);
      } else {
        ws[ENC({r:r7, c:d   })] = cv('', S.value);
        ws[ENC({r:r7, c:d+1 })] = cv('', S.value);
        ws[ENC({r:r7, c:d+2 })] = cv('', S.value);
        ws[ENC({r:r7, c:d+3 })] = cv('', S.value);
      }
    });

    // 항상 12열 (A-L)
    ws['!cols'] = [
      {wch:14.64},{wch:11.79},{wch:11.79},{wch:11.79},{wch:11.79},{wch:7.5},
      {wch:14.64},{wch:11.79},{wch:11.79},{wch:11.79},{wch:11.79},{wch:7.5},
    ];

    const totalRows = Math.ceil(items.length / 2) * GR;
    ws['!rows'] = Array(totalRows).fill(null).map(() => ({ hpt: 20.25 }));
    ws['!ref']  = `A1:L${totalRows}`;
    return ws;
  }

  // ══════════════════════════════════════════════════════════
  // 메인 생성
  // ══════════════════════════════════════════════════════════
  function generate() {
    if (!_items.length) { showToast('항목이 없습니다. 먼저 데이터를 불러오세요.'); return; }

    const today = new Date();
    const ymd   = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
    const prices   = (typeof G !== 'undefined') ? (G.prices   || {}) : {};
    const allItems = (typeof G !== 'undefined') ? (G.items    || []) : _items;

    const wb = XLSX.utils.book_new();

    // 시트 순서: 시트1 → 시트2 → 시트3
    XLSX.utils.book_append_sheet(wb, buildOrderSheet(_items, ymd), '완제품 비축 발주 요청');
    XLSX.utils.book_append_sheet(wb, buildDangaSheet(allItems, prices), '단가표');
    XLSX.utils.book_append_sheet(wb, buildCertSheet(_items, ymd), '성적서');

    const fname = `OJC_발주요청_${ymd}.xlsx`;
    try {
      XLSX.writeFile(wb, fname, { cellStyles: true });
    } catch {
      XLSX.writeFile(wb, fname);
    }
    showToast(`발주 파일 생성 완료: ${fname} (3시트)`);
  }

  // ── 탭 초기화 ─────────────────────────────────────────────
  function initTab() {
    const dz = document.getElementById('certDropzone');
    const fi = document.getElementById('certFileInput');
    if (!dz || fi?._certInited) return;
    if (fi) fi._certInited = true;
    if (dz) {
      dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag'); });
      dz.addEventListener('dragleave', ()  => dz.classList.remove('drag'));
      dz.addEventListener('drop', e => {
        e.preventDefault(); dz.classList.remove('drag');
        const f = e.dataTransfer.files[0];
        if (f) handleFile(f);
      });
    }
    if (fi) fi.addEventListener('change', () => { if (fi.files[0]) handleFile(fi.files[0]); });
  }

  return { loadFromApp, handleFile, generate, renderPreview, initTab, updateType };
})();
