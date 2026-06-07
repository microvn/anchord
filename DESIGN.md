# Design System — anchord

> Nguồn sự thật về font, màu, spacing, aesthetic. Đọc file này TRƯỚC mọi quyết định
> UI. Không lệch nếu chưa có phê duyệt rõ ràng.

## Product Context
- **What this is:** nền tảng self-hosted để chia sẻ + annotate AI-generated docs (HTML/MD/ảnh). "Vaultwarden for AI-generated docs".
- **Who it's for:** dev/team tự host, dùng thật trên spec/plan/report của chính họ.
- **Space/peers:** uselink.app (SaaS, light-marketing), Plannotator (dark, purple-gradient), Linear (refined dark benchmark).
- **Project type:** web app lai — doc viewer + annotation (đọc nhiều) và quản lý (project browser, version/diff, share, auth, member).
- **Stack:** React 19 + Vite + Tailwind 4. Reuse editor OSS Plannotator.

## Memorable Thing (kim chỉ nam)
**"Nghiêm túc, đáng tin, của tôi."** Mọi quyết định design phục vụ cảm giác phần
mềm kỹ thuật nghiêm túc, tự-host, dữ liệu trong tay mình. Tin cậy > bóng bẩy.

## Aesthetic Direction
- **Direction:** Refined Utilitarian — "operator-grade", dark-first.
- **Decoration:** minimal — type + space + 1 accent. KHÔNG gradient, blob, hay 3-col icon grid.
- **Mood:** calm, tự tin, kỹ thuật; cảm giác "hạ tầng mình sở hữu", không phải SaaS có phễu marketing.
- **Nguyên tắc cốt lõi — chrome lùi sau nội dung:** chrome (topbar, sidebar, rail) low-contrast; **doc + comment là chỗ tương phản cao nhất**. Design KHÔNG cạnh tranh thị giác với doc.
- **Doc content KHÔNG bị style bởi hệ này:** doc người dùng render trong iframe sandbox và giữ style riêng của nó. Design system chỉ áp cho *chrome* của app.
- **Khác biệt có chủ đích:** (1) màu accent **teal sâu** (không tím-Plannotator, không cam-Claude #d97757); (2) **serif Fraunces** cho heading/title trên một tool kỹ thuật = gravitas đáng tin, khác dàn all-grotesk.
- **Artifacts duyệt:** `~/.gstack/projects/microvn-anchord/designs/design-system-20260607/` (variant-b-full = canonical viewer; anchord-screens = browser/share/diff/auth).

## Typography
- **Display / doc title / headings:** **Fraunces** (serif, weight 500) — chỉ dùng cho title + heading, không dùng cho body/UI.
- **Body / UI:** **Geist** (400/500/600), bật `tabular-nums` cho version/số liệu.
- **Code / diff / version label / data:** **Geist Mono** (fallback JetBrains Mono).
- **Loading:** Bunny Fonts (privacy-friendly) — `fraunces`, `geist`, `geist-mono`. Tự-host khi single-binary v1.
- **Scale (px):** display 27–46 · h2 20–22 · h3 15 · body 14 · small 12.5 · mono-label 11. Letter-spacing âm nhẹ cho heading (-.01 → -.02em).

## Color
Dark là theme **canonical** (operator); light **first-class** (cùng cấp). Chrome theme độc lập với doc content.

**Dark (primary):**
- bg: paper `#0c1012` · surface `#11171a` · elev `#161d21` / `#1b2327` · sunken `#0a0e10`
- text: ink `#e7edee` · muted `#939fa3` · subtle `#677074` · faint `#444e52`
- line: `#222a2e` · soft `#1a2024`
- **accent teal:** `#37b3bd` · strong `#56cdd6` · soft `#0e2e30` · ink `#7fdce1`

**Light (secondary):**
- bg: paper `#fbfbfa` · surface `#ffffff` · elev `#f5f6f6` · sunken `#eef0f0`
- text: ink `#14181a` · muted `#5b6568` · subtle `#8a9296`
- line: `#e3e6e6` · soft `#eceeee`
- **accent teal:** `#0b6b73` · strong `#085259` · soft `#e3f0f0` · ink `#0a4a50`

**Semantic (cùng vai trò ở cả 2 mode):**
- detached / orphaned annotation → **amber** (dark `#d6a23e` / bg `#26200f`; light `#9a6700` / bg `#fdf3da`)
- error / link hết hạn → **red** (`#f1655d` / `#b3251f`)
- resolved → **green** (`#43b873` / `#1c7a4a`)
- suggestion / active highlight → **teal-soft** nền + teal underline
- priority badge: P0 = red, P1 = amber, P2 = subtle gray
- **Accent là teal DUY NHẤT.** Không thêm accent thứ hai. Cấm purple/violet gradient.

## Spacing
- **Base:** 4px. Scale: 2(2) xs(4) sm(8) md(12-16) lg(24) xl(32) 2xl(48).
- **Density:** compact-comfortable — dày ở list (version, member, doc grid, TOC), thoáng ở vùng đọc + comment thread.

## Layout
- **Doc viewer (màn cốt lõi) = 3 pane:** TOC sidebar trái (~236px, collapsible, search + outline + P-badge + scroll-spy) · doc center (reading max ~760px) · annotations rail phải (~300px, threads + detached + composer).
- **Topbar:** thin, low-contrast — title + status (LIVE/format) + version + Preview|Edit + Comments + Share(teal) + theme + ⋯. Dưới có meta-strip cho spec doc (stories/AS/Draft).
- **Selection popover:** nổi trên đoạn bôi đen — comment / suggest / resolve / react / ✕ (kiểu Plannotator).
- **App chrome khác (browser/share/auth):** grid kỷ luật, modal cho share dialog.
- **Border radius:** sm 5–6px · md 7–9px · lg 9–12px · pill 999px. Không bo tròn đồng loạt kiểu bubble.

## Responsive (bắt buộc — mọi màn)
Mobile-aware, không chỉ desktop. Breakpoints (Tailwind-style):
- **≥1200 (desktop):** doc viewer full 3-pane (TOC | doc | rail).
- **900–1199 (laptop):** TOC collapsible (toggle ▤ ở topbar, mặc định ẩn được); rail giữ nguyên hoặc thu hẹp.
- **600–899 (tablet):** TOC + rail thành **off-canvas drawer/sheet** (mở bằng nút); doc full width. Topbar gọn lại: Share/Comments thành icon, gộp bớt vào ⋯.
- **<600 (mobile):** một cột. Doc full width; **comment rail thành bottom-sheet** mở bằng badge số (💬 3); tap vào highlight → mở thread đó. Selection popover bám touch (long-press để chọn), nút ≥40px. Topbar = title + ⋯.

Per-screen:
- **Project browser:** doc grid 3-col → 2 (≤900) → 1 (≤600); sidebar projects → drawer ở mobile.
- **Share dialog:** modal giữa màn → **full-screen sheet** ở <600.
- **Version diff:** rendered side-by-side (v2 | v3) → **stacked** (v2 trên v3) ở ≤760; source line-diff luôn scroll ngang được.
- **Auth / first-run:** 2 pane → stacked ở ≤760.

Quy tắc: doc content trong iframe tự responsive (nội dung người dùng), chrome không ép layout lên nó. Tap target ≥40px. Test ở 360 / 768 / 1024 / 1440.

## Motion
- **Approach:** minimal-functional — chỉ transition giúp hiểu (mở/đóng rail, scroll-to mark, resolve fade). Không nhún nhảy.
- **Easing:** enter ease-out · exit ease-in. **Duration:** micro 80ms · short 150–200ms · medium 250ms.

## Anti-slop (cấm trong code lẫn mock)
purple/violet gradient · 3-col icon grid · centered-everything · gradient CTA · bubble-radius đồng loạt · Inter/Roboto/Space Grotesk làm primary · system-ui display · accent cam-Claude #d97757.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-07 | Tạo design system (dark-operator, teal, Geist+Fraunces+Geist Mono) | /design-consultation; research browser uselink/Plannotator/Linear; memorable = "nghiêm túc, đáng tin, của tôi"; user chọn variant B (dark operator), mock đủ 5 màn. |
| 2026-06-07 | Thêm phần Responsive (breakpoint + per-screen mobile behavior) | User yêu cầu bắt buộc responsive; 3-pane → drawer/bottom-sheet ở tablet/mobile. |
