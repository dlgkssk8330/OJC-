// ============================================================
// OJC 발주 계획 - Supabase 연결 설정
// Supabase 프로젝트 생성 후 아래 두 값을 입력하세요.
// Supabase 대시보드 → Project Settings → API
// ============================================================
const SB_URL      = 'https://trahnzhixmdetbbkinju.supabase.co';
const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRyYWhuemhpeG1kZXRiYmtpbmp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwMTQ2ODUsImV4cCI6MjA5NTU5MDY4NX0.J4330rxVRrVYYtqu7aYWVHjLPe7A27IOmDqI_JRnEq4';

// 표준원가 기본 비율 (Supabase 미설정 시 fallback)
const DEFAULT_STD_RATIO = 1.39;

// 발주 목표 재고 커버리지 (개월)
const TARGET_MONTHS = 6;

// 기본 리드타임 (일)
const DEFAULT_LEADTIME = 60;
