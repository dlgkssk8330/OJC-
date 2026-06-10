-- ============================================================
-- OJC 발주 계획 - 발주 프로젝트 테이블 추가
-- Supabase 대시보드 → SQL Editor 에서 실행하세요.
-- ============================================================

CREATE TABLE IF NOT EXISTS order_projects (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name         TEXT NOT NULL,
  data_mode    TEXT NOT NULL DEFAULT 'existing',  -- 'existing' | 'new'
  status       TEXT NOT NULL DEFAULT 'draft',     -- 'draft' | 'confirmed' | 'completed'
  created_by   TEXT NOT NULL DEFAULT 'system',
  description  TEXT DEFAULT '',
  order_plan   JSONB DEFAULT '{}',
  items        JSONB DEFAULT '[]',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE order_projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all" ON order_projects;
CREATE POLICY "anon_all" ON order_projects FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_proj_created ON order_projects(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proj_status  ON order_projects(status);
