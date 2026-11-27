# Kế hoạch: Streak, Thống kê & Tổng kết tuần/tháng/năm

Thiết kế tham chiếu: canvas **pntome Stats & Streak** — https://claude.ai/artifact/Pte7qYnDj8GT2yFEwxJ9PQ
(mobile: Trang chủ, Thống kê, Chạm vào một ngày, Tổng kết tháng · PC: Thống kê, Popover streak).

## Quyết định đã chốt

| Chủ đề | Quyết định |
|---|---|
| Ghi streak | Tự động từ thời gian đọc trong pntome + ước tính Kindle (không có nút "I read today"). Giữ quy tắc hiện có: ngày bắt đầu 04:00, đạt mục tiêu phút mới tính, 1 lá chắn/tuần. |
| Thẻ tổng kết | App tự xếp icon 3D theo số liệu, người dùng **kéo/xoay/phóng/xoá/thêm** được. Nền phía sau là **shape sinh ngẫu nhiên** (có seed). |
| Khi nào hiện tổng kết | Thẻ trên Trang chủ **từ chiều ngày cuối kỳ** (CN, ngày cuối tháng, 31/12) và tiếp tục ở đầu kỳ mới; luôn mở lại được từ Thống kê. Không gửi thông báo hệ thống. |
| Hồ sơ đọc | Luật cố định chạy offline; nếu đã cấu hình AI thì có nút "Viết lại bằng AI". |
| Thể loại | Gộp về bộ nhóm chuẩn dựa trên Thema/BISAC + danh mục Goodreads (xem §0.3). |

## Hiện trạng (đã có trong code)

- `app/src-tauri/src/stats.rs`: bảng `reading_log(day, asin, source, slot, seconds, positions, merged)` — `source` = app/kindle, `slot` chỉ có night/early/day; `book_event` (first_read, finished, finished_backfill, abandoned); streak + lá chắn (`compute_streak`); 13 huy hiệu; `stats_summary` trả mọi thứ một lần.
- Theo ngày đã biết **từng cuốn đọc bao nhiêu giây** (đủ để vẽ bìa trong lịch).
- `annotation.created_at`, `vocab.created_at` (UTC) → đếm đánh dấu/ghi chú/từ mới theo ngày được.
- Thể loại: `goodreads` (JSON sách đã khớp, có `genres`) và `book_meta.subjects` (chủ đề Amazon).
- `app/src/Stats.tsx` (521 dòng) chứa cả bản PC lẫn Android; ảnh huy hiệu ở `app/public/badges/`.
- Android: Rust gọi Kotlin qua JNI (`commands.rs` → `MainActivity.openAmazonSignIn`) — dùng lại mẫu này cho chia sẻ ảnh.
- Chưa có: dữ liệu theo **giờ**, mục tiêu **số cuốn/năm**, **ngày đọc xong** đáng tin cho sách cũ, plugin chia sẻ/clipboard.

---

## Phase 0 — Dữ liệu & API (Rust)

**0.1 Giờ trong ngày.** Ghi `slot` dạng `h00`…`h23` cho dòng mới (`day_and_slot`); `night` = h00–h03, `early` = h04–h05 được suy ra để huy hiệu cũ vẫn đúng. Dòng cũ giữ nguyên. Biểu đồ giờ chỉ dùng dữ liệu có giờ; ghi chú "từ ngày …" khi chưa đủ. Kindle ước tính lấy giờ của lần kiểm tra (gần đúng, ghi rõ là ước tính).

**0.2 Mục tiêu năm.** Setting `goal_books_year` (mặc định 12). Sách "đọc xong trong kỳ" = `book_event.finished` theo ngày; `finished_backfill` không gán vào tháng nào, chỉ cộng vào "Tất cả".

**0.3 Thể loại.** Module mới `genre.rs`:

- Bộ nhóm (Thema/BISAC top-level + nhóm Goodreads Choice), mỗi sách **1 thể loại chính**:
  - Hư cấu: Văn học · Kỳ ảo · Khoa học viễn tưởng · Lãng mạn · Trinh thám & Giật gân · Kinh dị · Tiểu thuyết lịch sử · Thiếu nhi & YA · Truyện tranh & Manga · Thơ & Kịch
  - Phi hư cấu: Tiểu sử & Hồi ký · Lịch sử · Khoa học & Công nghệ · Tâm lý & Phát triển bản thân · Kinh doanh & Kinh tế · Triết học & Tôn giáo · Phi hư cấu khác
- Cách gán: duyệt `genres` Goodreads theo thứ tự (bỏ nhãn chung như "Fiction", "Audiobook", "Classics"), khớp bảng từ khoá → nhóm; không có thì dùng `subjects` Amazon (chuỗi kiểu `Fiction / Romance / …`); không có nữa → "Chưa rõ" (không vẽ vào biểu đồ, ghi "n cuốn chưa rõ thể loại").
- Cache `book_genre(asin, genre, source)`; cho phép người dùng sửa ở trang sách (Phase 4).
- Biểu đồ: 5 nhóm lớn nhất + "Khác".

**0.4 API kỳ.** Lệnh mới `stats_period(kind: week|month|year|all, anchor: day)` → `PeriodStats`:
ngày (giây app/kindle, danh sách sách + giây), tổng & so với kỳ trước, sách đọc xong (kèm ngày), sách đọc lâu nhất, thể loại, 24 cột giờ, đánh dấu/ghi chú/từ mới, chuỗi dài nhất trong kỳ, ngày đọc nhiều nhất, dữ kiện cho Hồ sơ đọc. `stats_summary` giữ cho thanh tiêu đề/Trang chủ (nhẹ). Tuần bắt đầu thứ Hai.

**0.5 Kiểm thử** (`stats.rs` tests): ranh giới 04:00 với slot giờ, tuần/tháng/năm, so sánh kỳ trước, bảng gán thể loại (mỗi nhóm vài ví dụ thật từ Goodreads), sách backfill không lọt vào tháng.

## Phase 1 — Thống kê mobile (Android)

- Tách `Stats.tsx` thành `app/src/stats/`: `StatsPage`, `useStatsPeriod`, và một file cho mỗi thẻ: `ProfileCard`, `GoalCard` (Hôm nay/Tuần/Năm, kệ sách), `StreakCalendar`, `ReadingTimeCard`, `FinishedByMonth`, `TopBooks`, `GenreDonut`, `HoursCard`, `BadgesCard`.
- Thẻ streak Trang chủ (hàng 7 ngày + vòng hôm nay + bìa đang đọc) trong `MobileShell`.
- "Chạm vào một ngày" dùng `MobileReaderSheet`.
- Bìa sách qua protocol `cover` sẵn có; khi không có ảnh dùng `spine_color`.
- Token màu + 4 theme thẻ (Rượu vang, Rừng, Đêm, Giấy cũ) dùng chung với Tổng kết; chuỗi i18n vi/en trong `i18n.ts`.
- Hồ sơ đọc: danh sách luật có thứ tự (giờ đọc, thể loại, xu hướng so kỳ trước, chuỗi, tốc độ) → 1–2 câu; nút AI tuỳ chọn gọi `ai.rs`, có 👍/👎 để ẩn câu AI.

## Phase 2 — Thống kê PC

- Cùng các thẻ, lưới co giãn (đã có trong canvas): hàng 1 Hồ sơ · Hôm nay · Mục tiêu năm; hàng 2 Lịch chuỗi + dải 12 tháng (thay heatmap 53 tuần) | 30 ngày · Giờ đọc · Thể loại; hàng 3 Đọc xong theo tháng | Đọc lâu nhất; Huy hiệu.
- Nút ngọn lửa trên thanh tiêu đề mở **popover** (thay vì sang trang); "Mở thống kê" trong popover.
- Bấm một ngày trong lịch → popover chi tiết ngày (nội dung như sheet mobile).

## Phase 3 — Tổng kết tuần / tháng / năm

**3.1 Kỳ & thời điểm hiện**

| Kỳ | Bắt đầu hiện (thẻ Trang chủ) | Ẩn tự động | Ghi chú |
|---|---|---|---|
| Tuần (T2–CN) | CN 18:00 ("tạm tính") | CN tuần sau | Chốt số liệu từ T2 04:00 |
| Tháng | Ngày cuối tháng 18:00 | Ngày 7 tháng sau | |
| Năm | 31/12 18:00 | 31/1 | Dạng nhiều trang (story) |

Bảng `wrap(kind, period_start, data_json, layout_json, seed, created_at, seen)`: chụp số liệu khi chốt kỳ để mở lại vẫn y nguyên, và lưu bố cục người dùng đã chỉnh. Thống kê có mục "Các bản tổng kết" để xem lại.

**3.2 Mẫu**

- Tuần: 7 chấm ngày, tổng phút, sách chính, 1 dữ kiện nổi bật.
- Tháng: lưới bìa, 4 ô số, câu "đêm đọc dài nhất…" (như canvas).
- Năm: 6 trang — Tổng quan · Sách đã đọc · Thể loại · Chuỗi & lịch · Giờ đọc · Huy hiệu; chia sẻ từng trang hoặc cả bộ.
- Khổ xuất: 1080×1920 (story) và 1080×1350 (post).

**3.3 Nền shape sinh ngẫu nhiên** — tự viết `wrapShapes.ts`, không chép file từ shaape (repo không có giấy phép chuẩn, chỉ ghi "free to use"; dùng làm tham khảo thị giác):

- RNG có seed (`hash(kind + period + reroll)`); nút "Đổi nền" tăng `reroll`.
- Loại shape: blob (n điểm trên vòng tròn, lệch bán kính → Catmull-Rom → bezier kín), sao/burst (bán kính xen kẽ, bo góc), hoa (k cánh), con dấu gợn sóng, hình học (vòng, viên thuốc, vòm).
- 3–6 shape/thẻ, 1–2 shape lớn làm mờ, màu từ palette của theme thẻ; lớp **grain** bằng SVG `feTurbulence` + `feColorMatrix` (đúng kiểu "grainy gradient").
- Xuất ra SVG nên vừa hiển thị vừa dùng được khi render ảnh.

**3.4 Icon 3D (3dicons.reicon.dev)**

- Giấy phép "Free Usage License 1.0": dùng thương mại, không bắt ghi công; **cấm phân phối lại như một bộ icon/pack**. → Chỉ đóng gói ~30–40 icon được chọn, chuyển WebP 256/512px vào `app/public/wrap-icons/`, không có màn "tải bộ icon". Ghi cảm ơn trong Giới thiệu. Nên gửi mail hello@reicon.dev xác nhận việc đóng gói trong app (giấy phép không nói rõ). Phương án dự phòng: 3dicons.co V1 (CC0).
- Ánh xạ số liệu → icon: lửa (chuỗi), trăng (cú đêm), mặt trời (dậy sớm), cúp (đạt mục tiêu), huy chương (mở huy hiệu), đồng hồ (thời gian), lịch, ngôi sao, trái tim (thể loại Lãng mạn), tên lửa (tăng so với kỳ trước), vương miện (sách đọc lâu nhất), hồng tâm (mục tiêu), quà (tổng kết năm), sổ tay (đánh dấu), bóng đèn (từ mới), biểu đồ. Bộ này không có icon "sách" → dùng sổ tay hoặc bìa sách thật.
- Ảnh huy hiệu hiện có cũng là sticker.

**3.5 Trình chỉnh sticker**

- Mô hình lớp: nền (shape) · nội dung cố định (tiêu đề, số, bìa) · sticker (icon 3D, huy hiệu) với `{id, x, y, scale, rotate, z}`.
- Android: kéo 1 ngón, 2 ngón phóng + xoay; chạm chọn, nút xoá; khay icon (gợi ý icon liên quan số liệu lên đầu).
- PC: kéo, tay nắm góc để phóng/xoay, phím mũi tên dịch, Delete xoá.
- "Xếp lại tự động"; lưu vào `wrap.layout_json`.

**3.6 Xuất ảnh & chia sẻ**

- Dựng thẻ thành **một SVG** từ chính mô hình lớp (shape, bìa dạng data URL lấy từ protocol `cover`, Literata nhúng `@font-face`) → vẽ lên canvas → PNG. Tránh lỗi canvas "tainted" và không cần thư viện html-to-image.
- PC: "Lưu ảnh" (plugin-dialog có sẵn) + "Sao chép" (thêm `tauri-plugin-clipboard-manager`, hỗ trợ ảnh).
- Android: ghi file vào cache → `MainActivity.shareImage(path)` qua JNI (FileProvider + `ACTION_SEND`); "Lưu ảnh" → MediaStore `Pictures/pntome`.

## Phase 4 — Bổ sung

- Thêm thời gian đọc sách giấy: `source = 'manual'`, tối đa 7 ngày trước, ≤ 600 phút/ngày, tính vào chuỗi.
- Sửa thể loại sách bằng tay.
- Lịch sử các bản tổng kết.

## Thứ tự làm

1. Phase 0 (dữ liệu + test) — mọi thứ phía sau phụ thuộc.
2. Phase 1 mobile → Phase 2 PC (dùng chung thẻ, khác bố cục).
3. Phase 3: 3.3 nền + 3.4 icon → mẫu tháng → xuất/chia sẻ → trình chỉnh sticker → tuần → năm.
4. Phase 4.

Mỗi bước: `cargo test` (stats), `npm run build`, chạy app trên Windows và Android để xem thật; thêm script kiểm tra kiểu `scripts/check-*.mjs` cho trình chỉnh sticker (cử chỉ) như `check-reader-gestures.mjs`.

## Rủi ro / còn mở

- Sách đọc xong trước khi dùng pntome không có ngày → thống kê theo tháng của năm đầu sẽ thiếu.
- Giờ đọc của phần Kindle chỉ gần đúng (theo lúc kiểm tra).
- Thể loại phụ thuộc việc khớp Goodreads; sách lạ sẽ "Chưa rõ".
- Giấy phép đóng gói icon reicon cần xác nhận (xem 3.4).
