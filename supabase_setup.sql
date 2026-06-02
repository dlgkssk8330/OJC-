-- ============================================================
-- OJC 수입품목 발주 계획 - Supabase 초기 설정 SQL
-- Supabase 대시보드 → SQL Editor 에서 전체 실행하세요.
-- ============================================================

-- 1. 앱 설정 (비율·비밀번호 해시 등)
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_by  TEXT DEFAULT 'system',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 업로드 세션 (누가 언제 업로드했는지 추적)
CREATE TABLE IF NOT EXISTS upload_sessions (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_type  TEXT NOT NULL,   -- 'item_data' | 'price_list'
  uploader_name TEXT NOT NULL,
  row_count     INTEGER DEFAULT 0,
  ip_address    TEXT,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 품목 데이터 (업로드 템플릿에서 가져온 재고·판매 현황)
CREATE TABLE IF NOT EXISTS items (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id    UUID REFERENCES upload_sessions(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  spec          TEXT,
  supplier      TEXT,
  stock         NUMERIC DEFAULT 0,
  incoming      NUMERIC DEFAULT 0,
  leadtime      INTEGER DEFAULT 60,
  safety_stock  NUMERIC DEFAULT 0,
  avg_prev      NUMERIC DEFAULT 0,   -- 전년 월평균
  avg_cur       NUMERIC DEFAULT 0,   -- 당년 월평균
  trend         TEXT DEFAULT '',
  avail_mo      NUMERIC,             -- 현 가용재고(월)
  avail_mo_incl NUMERIC,             -- 입고포함 가용재고(월)
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 4. 가격 테이블 (품목코드 1개당 1행, 항상 최신 가격)
CREATE TABLE IF NOT EXISTS prices (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  item_code       TEXT NOT NULL UNIQUE,
  item_name       TEXT,
  import_price    NUMERIC,           -- 수입가격
  maeksan_cost    NUMERIC,           -- 맥산생산원가
  prod_cost       NUMERIC,           -- 생산원가
  std_ratio       NUMERIC,           -- 표준원가비율 (NULL이면 global 사용)
  standard_cost   NUMERIC,           -- 표준원가 (prod_cost × ratio, 앱에서 계산)
  updated_by      TEXT NOT NULL DEFAULT 'system',
  ip_address      TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 5. 가격 변경 이력 (모든 수정을 누적 보관)
CREATE TABLE IF NOT EXISTS price_history (
  id                   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  item_code            TEXT NOT NULL,
  item_name            TEXT,
  import_price_old     NUMERIC,
  import_price_new     NUMERIC,
  maeksan_cost_old     NUMERIC,
  maeksan_cost_new     NUMERIC,
  prod_cost_old        NUMERIC,
  prod_cost_new        NUMERIC,
  std_ratio_old        NUMERIC,
  std_ratio_new        NUMERIC,
  standard_cost_old    NUMERIC,
  standard_cost_new    NUMERIC,
  changed_by           TEXT NOT NULL,
  ip_address           TEXT,
  changed_at           TIMESTAMPTZ DEFAULT NOW(),
  note                 TEXT
);

-- 6. 다운로드 감사 로그 (보안 추적)
CREATE TABLE IF NOT EXISTS download_log (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  action_type   TEXT NOT NULL,   -- 'price_download' | 'price_view'
  actor_name    TEXT NOT NULL,
  ip_address    TEXT,
  item_count    INTEGER,
  file_type     TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 7. 발주 계획 (발주수량 확정 정보)
CREATE TABLE IF NOT EXISTS order_plan (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  item_code     TEXT NOT NULL UNIQUE,
  order_qty     NUMERIC DEFAULT 0,
  is_confirmed  BOOLEAN DEFAULT FALSE,
  note          TEXT,
  confirmed_by  TEXT,
  ip_address    TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 기본 설정값 삽입 ───────────────────────────────────────
INSERT INTO settings (key, value, updated_by) VALUES
  ('std_cost_ratio',   '1.39',   'system'),  -- 표준원가 = 생산원가 × 1.39
  ('admin_pw_hash',    '',       'system'),  -- 관리자 비밀번호 해시 (초기 미설정)
  ('app_name',         'OJC 수입품목 발주 계획', 'system')
ON CONFLICT (key) DO NOTHING;

-- ── Row Level Security 활성화 ─────────────────────────────
ALTER TABLE settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE prices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history   ENABLE ROW LEVEL SECURITY;
ALTER TABLE download_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_plan      ENABLE ROW LEVEL SECURITY;

-- anon 키로 전체 접근 허용 (보안은 앱 레이어에서 관리자 비밀번호로 제어)
DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['settings','upload_sessions','items','prices','price_history','download_log','order_plan']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "anon_all" ON %I', tbl);
    EXECUTE format('CREATE POLICY "anon_all" ON %I FOR ALL TO anon USING (true) WITH CHECK (true)', tbl);
  END LOOP;
END $$;

-- ── 인덱스 ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_items_session    ON items(session_id);
CREATE INDEX IF NOT EXISTS idx_items_code       ON items(code);
CREATE INDEX IF NOT EXISTS idx_prices_code      ON prices(item_code);
CREATE INDEX IF NOT EXISTS idx_ph_code          ON price_history(item_code);
CREATE INDEX IF NOT EXISTS idx_ph_changed_at    ON price_history(changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_dl_created_at    ON download_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_op_code          ON order_plan(item_code);
