-- ============================================================
-- OJC 발주계획 앱 - Supabase 추가 테이블 (v2)
-- 기존 supabase_setup.sql 실행 후 이 파일을 추가 실행하세요.
-- ============================================================

-- 판매현황 데이터 (품목코드 × 연월 집계)
CREATE TABLE IF NOT EXISTS sales_data (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  item_code  TEXT NOT NULL,
  year_month TEXT NOT NULL,   -- 'YYYY/MM'
  qty        NUMERIC DEFAULT 0,
  amount     NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(item_code, year_month)
);

-- 판매현황 품목명 (메타)
CREATE TABLE IF NOT EXISTS sales_meta (
  item_code TEXT PRIMARY KEY,
  item_name TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 입고예정 데이터
CREATE TABLE IF NOT EXISTS incoming_data (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  po_no          TEXT,
  dept           TEXT,
  code           TEXT NOT NULL,
  name           TEXT,
  spec           TEXT,
  qty            NUMERIC,
  order_date     TEXT,
  eta            TEXT,
  eta_expected   TEXT,
  eta_expected2  TEXT,
  loc            TEXT,
  note           TEXT,
  source         TEXT DEFAULT 'upload',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 동기화 타임스탬프
CREATE TABLE IF NOT EXISTS sync_status (
  key        TEXT PRIMARY KEY,
  synced_at  TIMESTAMPTZ DEFAULT NOW(),
  synced_by  TEXT,
  row_count  INTEGER
);

-- RLS 활성화
ALTER TABLE sales_data    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_meta    ENABLE ROW LEVEL SECURITY;
ALTER TABLE incoming_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_status   ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['sales_data','sales_meta','incoming_data','sync_status']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "anon_all" ON %I', tbl);
    EXECUTE format('CREATE POLICY "anon_all" ON %I FOR ALL TO anon USING (true) WITH CHECK (true)', tbl);
  END LOOP;
END $$;

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_sd_code ON sales_data(item_code);
CREATE INDEX IF NOT EXISTS idx_sd_ym   ON sales_data(year_month);
CREATE INDEX IF NOT EXISTS idx_id_code ON incoming_data(code);
CREATE INDEX IF NOT EXISTS idx_id_eta  ON incoming_data(eta_expected2);
