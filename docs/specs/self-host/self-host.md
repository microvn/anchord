# Spec: self-host

**Created:** 2026-06-07
**Last updated:** 2026-06-07
**Status:** Draft

## Overview

`docker compose up` để tự host anchord: app + Postgres + volume; migration chạy lúc
boot; config bắt buộc được validate (thiếu thì không khởi động). Content text trong
Postgres, ảnh trên volume. Không telemetry, không phone-home. Lý do tồn tại của dự án.

## Data Model

- Không thêm entity nghiệp vụ. Hạ tầng:
  - Volume `anchord_db` (Postgres data) + `anchord_assets` (ảnh, path `ASSETS_DIR`).
  - Config qua env: `APP_SECRET`, `DATABASE_URL`, `SMTP_*`, OAuth `GITHUB_*`/`GOOGLE_*`
    (optional), `ASSETS_DIR`, `CORS_ORIGIN`, `PORT`.
  - (Optional) blob dedup theo `content_hash` cho version trùng nội dung.

## Stories

### S-001: Bring up the stack with docker compose (P0)

**Description:** Là operator, tôi chạy `docker compose up` và có một instance hoạt
động: Postgres lên, migration chạy, app phục vụ.
**Source:** docs/explore/self-host.md#quyết-định, #happy-path.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (`docker-compose.yml`, `Dockerfile`, `src/db/migrate.*`, env schema)
- `autonomous:` true
- `verify:` `docker compose up` với .env hợp lệ → `/health` trả ok sau khi Postgres healthy + migration xong.

**Acceptance Scenarios:**

AS-001: compose up dựng instance hoạt động
- **Given:** `.env` hợp lệ (APP_SECRET, DATABASE_URL, SMTP_*)
- **When:** chạy `docker compose up`
- **Then:** Postgres lên (healthcheck), app chờ healthy rồi chạy migration (idempotent)
  và phục vụ; `/health` trả ok
- **Data:** compose mặc định + .env hợp lệ

AS-002: App chờ Postgres healthy trước khi migrate/serve
- **Given:** Postgres chưa sẵn sàng lúc app khởi động
- **When:** app boot
- **Then:** app chờ healthcheck Postgres rồi mới migrate + serve (không chạy nửa vời)
- **Data:** Postgres khởi động chậm

### S-002: Validate required config at boot (P0)

**Description:** Là operator, nếu tôi thiếu config bắt buộc, app từ chối khởi động và
báo rõ thiếu gì.
**Source:** docs/explore/self-host.md#unhappy-paths; auth C-008 (SMTP bắt buộc).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (`src/config/env.*`)
- `autonomous:` true
- `verify:` bỏ APP_SECRET → app không khởi động, log nêu rõ; bỏ SMTP → tương tự.

**Acceptance Scenarios:**

AS-003: Thiếu APP_SECRET → từ chối khởi động
- **Given:** `.env` thiếu APP_SECRET (hoặc < 16 ký tự)
- **When:** app boot
- **Then:** app không khởi động; log nêu rõ thiếu/không hợp lệ APP_SECRET
- **Data:** APP_SECRET rỗng

AS-004: Thiếu SMTP → từ chối khởi động
- **Given:** `.env` chưa cấu hình SMTP
- **When:** app boot
- **Then:** app không khởi động; log nêu rõ SMTP bắt buộc (đồng bộ auth C-008)
- **Data:** SMTP_* rỗng

### S-003: Store images on a volume, content in Postgres (P1)

**Description:** Là hệ thống, tôi lưu content text trong Postgres và ảnh trên volume
cấu hình được.
**Source:** docs/explore/self-host.md#quyết-định (mục 1 storage).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (asset storage path)
- `autonomous:` true

**Acceptance Scenarios:**

AS-005: Ảnh lưu trên volume, content trong DB
- **Given:** instance đang chạy với volume assets
- **When:** publish một doc ảnh và một doc HTML
- **Then:** bytes ảnh nằm trên volume (`ASSETS_DIR`); content HTML nằm trong Postgres;
  cả hai serve được
- **Data:** 1 ảnh + 1 HTML

AS-006: Volume ảnh không ghi được → lỗi rõ
- **Given:** `ASSETS_DIR` không có quyền ghi
- **When:** publish một ảnh
- **Then:** báo lỗi rõ lúc publish; không crash app
- **Data:** thư mục read-only

### S-004: No telemetry by default (P1)

**Description:** Là operator quan tâm dữ liệu, tôi yên tâm rằng instance không gửi
dữ liệu ra ngoài.
**Source:** docs/explore/self-host.md#quyết-định (mục 3 no telemetry).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-007: Không phone-home / analytics
- **Given:** instance đang chạy bình thường
- **When:** vận hành (publish, annotate, search…)
- **Then:** không có request ra dịch vụ ngoài cho mục đích telemetry/analytics (chỉ
  ra ngoài khi cần: gửi email qua SMTP đã cấu hình, OAuth tới provider đã bật)
- **Data:** giám sát outbound khi dùng

## Constraints & Invariants

- C-001: `docker compose up` dựng app + Postgres + volume (`anchord_db`,
  `anchord_assets`); migration chạy lúc boot, idempotent, fail thì app không serve. (AS-001, AS-002)
- C-002: Config bắt buộc (APP_SECRET ≥16, DATABASE_URL, SMTP_*) validate lúc boot;
  thiếu/không hợp lệ → từ chối khởi động với log rõ. (AS-003, AS-004)
- C-003: Content text trong Postgres; ảnh binary trên volume (`ASSETS_DIR`). (AS-005)
- C-004: Mặc định không telemetry/phone-home; outbound chỉ cho SMTP/OAuth đã cấu hình. (AS-007)
- C-005: Lỗi storage (volume không ghi được) báo rõ, không crash. (AS-006)

## Linked Fields

- **SMTP config (bắt buộc)** — produced bởi self-host (env validate, C-002).
  Consumed bởi `auth` (verify/invite), `workspace-project` (notify). ✔ self-host đảm
  bảo SMTP luôn có nên các cụm kia không cần degrade.
- **`ASSETS_DIR` / volume ảnh** — produced bởi self-host (C-003). Consumed bởi
  `render-publish` (lưu/serve ảnh) + `annotation-core` (image-region). ✔.

## What Already Exists

### System Impact & Technical Risks

- Repo greenfield. `docker-compose.yml`/`Dockerfile`/`src/db/migrate.ts`/`src/config/env.ts`
  từng được phác (đã revert) — dựng lại theo spec này.
- Cross-spec: SMTP bắt buộc khoá vào `auth`/`workspace-project`; ASSETS_DIR khoá vào
  `render-publish`.
- Risk: migration-on-boot phải idempotent + fail-closed (không serve nếu migrate
  lỗi). Single-binary v1 là phần khó, defer.

## Not in Scope

- Single-binary `bun --compile` → v1 (và đã pha loãng: vẫn cần Postgres kèm).
- Object store S3-compatible cho ảnh → v0.5+.
- Helm chart / k8s manifest → v2.
- Auto-update / migration rollback UI → v2.
- Multi-instance / HA → v2.

## Gaps

- GAP-001 (status: open): dedup content theo content_hash (version trùng lưu một
  lần) — làm ở v0 hay defer? Ảnh hưởng storage growth (versioning-diff GAP-001).
  Source: "Dedup content theo content_hash được làm ở v0 (hay defer?)".
- GAP-002 (status: open): ship kèm script backup (`pg_dump` + tar volume ảnh) hay
  chỉ document? Source: "Backup tool/đường dẫn khuyến nghị … ship kèm hay document".
- GAP-003 (status: open): giới hạn tổng storage/quota trên instance (chống một
  workspace ngốn hết đĩa)? Liên quan retention version. Source: "Giới hạn tổng
  storage/quota trên instance".

## Clarifications — 2026-06-07

- **Storage: content Postgres + ảnh volume:** nhiều version × ảnh lớn nhồi DB sẽ
  phình + backup nặng; tách ra giữ DB lean, vẫn "data trên máy bạn".
- **SMTP BẮT BUỘC (đảo lại explore "optional + degrade"):** app không khởi động nếu
  thiếu SMTP → bỏ mọi logic degrade; email verify/invite/notify luôn hoạt động. Đồng
  bộ `auth` C-008.
- **Postgres (chốt từ trước) pha loãng giấc mơ single-file:** v1 single-binary =
  binary app + Postgres kèm, không all-in-one; honest, không bán quá lời.
- **No telemetry:** chính là wedge "tin về data".
- **SMTP runtime (từ /mf-challenge H6):** bắt buộc lúc boot KHÁC gửi-được lúc runtime;
  outbound mail enqueue + retry + dead-letter + trạng thái lỗi cho operator (chi tiết
  ở `auth` C-009). Boot vẫn fail-fast nếu thiếu cấu hình SMTP.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-07 | Initial creation (from docs/explore/self-host.md); SMTP bắt buộc (đảo explore) | -- |
| 2026-06-07 | /mf-challenge harden H6: ghi nhận SMTP runtime retry/dead-letter (auth C-009) | -- |
