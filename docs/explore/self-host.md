## Explore: self-host

_2026-06-07_

**Feature:** `docker compose up` một dòng để tự host anchord; data nằm trên hạ tầng
của bạn; không telemetry, không phone-home. Lý do tồn tại của dự án.

**Trigger:** Operator cài instance (first-run setup ở cụm workspace), cấu hình qua
env/config.

**UI expectation:** Hầu như không — là vận hành. First-run wizard (cụm workspace)
+ settings (provider toggle, branding, SMTP). **[N] NEW**.

---

### Quyết định (đã chốt trong phiên explore)

**1. Storage = content trong Postgres + ảnh trên volume.**
- HTML/MD (content version) lưu trong Postgres.
- Ảnh binary lưu trên **named volume** (path cấu hình được), không nhồi vào DB →
  DB gọn dù nhiều version.
- Object store S3-compatible → thêm sau (v0.5+), không trừu tượng hoá sớm ở v0.

**2. SMTP = optional + degrade mượt.**
- Chưa cấu hình SMTP → instance vẫn chạy: bỏ email verify (hoặc invite bằng link
  copy tay), notify chỉ in-app. Đúng tinh thần "một dòng".
- Gỡ luôn open question của auth: instance nội bộ không SMTP vẫn dùng được.

**3. No telemetry (mặc định, v0).**
- Không phone-home, không analytics. (uselink có analyticsApi — anchord bỏ hẳn.)

**4. Dedup version theo content_hash (đề xuất giữ).**
- Version trùng nội dung (vd restore append-copy) lưu blob một lần theo
  content_hash → kiềm storage cho lịch sử version. (Assumption, xác nhận lúc build.)

**5. Single-binary = v1, đã pha loãng vì Postgres.**
- v0: `docker compose up` (app + Postgres + 1 volume ảnh).
- v1: `bun --compile` ra binary app (nhúng SPA) NHƯNG vẫn cần Postgres chạy kèm —
  không phải một-file-all-in-one như Vaultwarden/SQLite. Vẫn giá trị (1 binary app,
  no node_modules) nhưng honest: không phải "một file".

**6. Backup story.**
- Backup = `pg_dump` (hoặc snapshot volume Postgres) + volume ảnh. Document rõ cho
  operator. (Không phải "copy 1 file" như SQLite — đánh đổi đã biết.)

---

### Happy path

1. Operator: `git clone` + `cp .env.example .env` (đặt APP_SECRET, optional SMTP/
   OAuth) → `docker compose up`.
2. compose dựng Postgres + app + volume ảnh; app chạy migration lúc boot
   (drizzle-orm migrator), mở port.
3. Mở browser → first-run setup (cụm workspace): tạo admin + workspace.
4. Dùng ngay; không SMTP thì verify tắt, notify in-app.

### Unhappy paths

- **Thiếu APP_SECRET:** app từ chối khởi động, báo rõ (đã có trong env schema phác).
- **Postgres chưa healthy:** app chờ healthcheck (depends_on condition) rồi mới
  migrate/serve.
- **Volume ảnh không ghi được (permission):** báo lỗi rõ lúc publish ảnh, không
  crash.
- **Upgrade version:** migration mới chạy lúc boot; nếu fail → app không serve,
  log rõ (không chạy nửa vời).

### Business rules

- Mặc định không gửi bất kỳ dữ liệu nào ra ngoài instance.
- Mọi tính năng phụ thuộc email phải degrade được khi thiếu SMTP.
- Migration tự chạy lúc boot, idempotent.

### Input validation (config)

- APP_SECRET: bắt buộc, min 16 ký tự (đã có trong `src/config/env.ts` phác).
- DATABASE_URL: bắt buộc, đúng định dạng postgres://.
- SMTP_*: optional; nếu set thì validate đủ host/port/user.
- Provider OAuth (GitHub/Google): optional; set client id/secret thì bật provider.

### Data impact

- Postgres: toàn bộ bảng (better-auth + app). Volume `anchord_db` cho Postgres.
- Volume mới `anchord_assets` cho ảnh; path cấu hình `ASSETS_DIR`.
- Bảng/blob dedup theo content_hash (nếu làm).

### Out of scope (v0 — defer)

- Single-binary `bun --compile` → v1.
- Object store S3-compatible → v0.5+.
- Helm chart / k8s manifest → v2.
- Auto-update / migration rollback UI → v2.
- Multi-instance / HA → v2 (ngược mô hình single small instance).

### Decision rationale

- Ảnh trên volume (không trong DB): nhiều version × 25MB ảnh nhồi DB sẽ phình +
  backup nặng; tách ra giữ DB lean, vẫn "data trên máy bạn".
- SMTP optional: ép SMTP lúc first-run phá trải nghiệm "một dòng"; degrade mượt giữ
  rào vào thấp nhất.
- Postgres (đã chốt từ trước) đánh đổi giấc mơ single-file; chấp nhận vì workload
  multi-writer cần MVCC — ghi nhận honest, không bán quá lời về single-binary.
- No telemetry: chính là wedge "tin về data"; bật telemetry sẽ phá luận điểm bán hàng.

### Assumptions (cần xác nhận)

- Dedup content theo content_hash được làm ở v0 (hay defer?).
- Ảnh trên local volume; chưa cần S3 ở v0.
- Migration chạy lúc boot qua drizzle-orm migrator (đã phác `src/db/migrate.ts`).

### Open questions

- Backup tool/đường dẫn khuyến nghị (script `pg_dump` + tar volume ảnh) có ship kèm
  không, hay chỉ document?
- Reset/seed cho dev vs prod khác nhau thế nào?
- Giới hạn tổng storage/quota trên instance (chống một workspace ngốn hết đĩa)?
  → liên quan retention version của versioning-diff.
- Health/readiness endpoint cho reverse-proxy (đã có `/health` phác) — đủ chưa?

### Complexity signal: **low-medium**

Phần lớn là compose + config + degrade logic. Đáng lưu ý: volume ảnh + backup
story + migration-on-boot. Single-binary v1 mới là phần khó (defer).

### Cross-cluster dependencies

- **render-publish / versioning-diff:** ảnh trên volume; dedup version; cap size.
- **auth:** APP_SECRET (session), OAuth provider env, SMTP cho verify/invite.
- **workspace-project:** first-run setup; SMTP cho notify; branding/provider toggle
  trong workspace settings.
- **mcp-roundtrip:** expose `/mcp`, rate-limit, token storage.
- **annotation-core:** content (kèm block_id) serve từ content-route, ảnh từ volume.

## UI sketches

Cụm self-host gần như không có UI riêng — vận hành qua `docker compose` + env/config
(CLI). Màn người-dùng duy nhất là **First-run setup**, sketch ở `auth` UI sketches
(panel phải: workspace name + admin + provider toggle + SMTP configured ✓). Còn lại
là config file, không phải screen.
