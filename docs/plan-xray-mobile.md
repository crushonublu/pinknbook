# Kế hoạch: X-Ray và sơ đồ quan hệ trên điện thoại

Thiết kế tham chiếu: canvas **pntome X-Ray mobile**: https://claude.ai/artifact/8sx8YpH1nGaGtmubov2izb
(1 Danh sách · 2 Trang nhân vật · 3 Xem đoạn trích tại chỗ · 4 Menu chỉnh sửa · 5 Sơ đồ theo nhóm · 6 Sơ đồ tập trung · 7 Quan hệ dạng danh sách · 8 Sau khi nhảy; 5b vòng tròn là phương án cũ, không làm).

Phạm vi: **Android**. Bản PC giữ giao diện hiện tại; chỉ dùng chung phần dữ liệu mới (nhóm nhân vật, loại tác giả). Chỉ X-Ray trong trình đọc; không đụng Amazon X-Ray.

## Quyết định đã chốt

| Chủ đề | Quyết định |
|---|---|
| Ai có mặt | Ba nhóm **Chính / Phụ / Thoáng qua**, tính tự động; người đọc ghim hoặc đổi được. Thoáng qua ẩn mặc định nhưng vẫn tìm được. |
| Tác giả | Tự loại tác giả, người dịch và những tên chỉ nằm ở trang đầu/cuối sách. |
| AI | Tuỳ chọn, như hiện nay. Khi chạy AI, mỗi người có thêm **vai trò** (chính / phụ / không phải nhân vật) để loại tổ chức bị nhận nhầm (Pfizer…), **nhóm** và **dòng vai trò ngắn**. Không có AI vẫn chạy bằng luật. |
| Không lộ nội dung | Giữ cơ chế hiện có (`limit` = vị trí đang đọc). Đoạn trích sau chỗ đang đọc ẩn, có nút hiện kèm cảnh báo. |
| Sửa dữ liệu | Không nằm trên trang đọc nữa: gom vào menu `•••` (bảng chỉnh sửa). |
| Sơ đồ | Mặc định **theo nhóm, dạng poster dọc** (như sơ đồ nhân vật phim): nhân vật trung tâm ở trên, bên dưới là các khung nhóm (gia đình, tổ chức, phe), mỗi người có một dòng vai trò. Chạm một người → chế độ tập trung (người đó ở giữa, quan hệ trực tiếp xếp vòng quanh). Có danh sách quan hệ thay thế. |

## Hiện trạng (đã có trong code)

- `src/xrayIndex.ts`: tự tìm tên trong sách (offline), 4 loại `person|place|org|term`; `entities()` (:592) gộp tên gọi; `links()` (:662) nối người với người nếu chung ≥2 đoạn ~600 ký tự; `upTo()` (:646) lọc theo vị trí đọc. `XrEdits` (:46) lưu sửa của người đọc (gộp, ẩn, đổi tên, đổi loại, nhãn quan hệ), `XrAi` (:65) lưu kết quả AI. Chỉ có **số lần nhắc** để xếp hạng; không có nhóm chính/phụ, không biết tác giả.
- `src/XRay.tsx`: `useXray` (:39), `XRayPanel` (:354, danh sách), `XRayDetail` (:479, trang nhân vật, dùng chung PC/Android), `goToMention` (:326, nhảy tới một lần nhắc: không nhớ chỗ cũ, không tô sáng).
- `src/XRayGraph.tsx`: sơ đồ lực đẩy-hút (`graphLayout.ts:85`), lấy 20 người nhắc nhiều nhất (thanh trượt 2–80), nhãn quan hệ trôi nổi (`placeLabels`). Android chỉ đổi cỡ chạm và đưa nút vào menu.
- `src/Reader.tsx`: `undoJump` (:265) + nút "Quay lại X%" chỉ có khi kéo thanh tiến độ, và chỉ hiện khi thanh điều khiển đang mở; `chapterOf` (:334) đổi vị trí thành tên chương; `addAnnotation` (:383) vẽ được tô màu tạm.
- `src-tauri/src/ai.rs`: lệnh `xray_ai_estimate` / `xray_ai_run`, schema JSON (:192) chỉ có `description`, `same_as`, `label`, `detail`.

## Giai đoạn 1: Nhóm nhân vật (dữ liệu dùng chung)

**Mục tiêu:** danh sách và sơ đồ chỉ còn người đáng kể; tác giả và "người qua đường" tự biến mất.

1. `xrayIndex.ts`, hàm mới `tiers(ents, links, limit, book)`. Với mỗi người (type `person`):
   - `mentions` = số lần nhắc tới vị trí đọc;
   - `spread` = số **phần (section)** khác nhau có tên;
   - `degree` = số người khác nối với họ (`links`).
   - Điểm = `log(1 + mentions) × (1 + log2(spread)) × (1 + 0.5·log2(1 + degree))`.
   - **Chính:** người kể chuyện (nếu có) + những người điểm ≥ 35% điểm cao nhất, tối đa 8.
   - **Thoáng qua:** `mentions < 5`, hoặc chỉ ở **1 phần** và `degree ≤ 1`, hoặc mọi lần nhắc đều nằm trong 2% đầu / 3% cuối sách (lời giới thiệu, bản quyền, cảm ơn).
   - **Phụ:** phần còn lại.
2. **Loại tác giả:** `Reader` truyền `row.author` (và người dịch nếu `book_meta` có) vào `useXray`. Tên trùng (bỏ dấu, so họ tên đầy đủ hoặc tên cuối) bị gắn `author` và ẩn khỏi danh sách và sơ đồ. Trường hợp tác giả cũng là nhân vật xưng "tôi" vẫn giữ người kể chuyện như cũ.
3. `XrEdits` thêm `tiers: Record<key, "main"|"minor"|"hidden">`: người đọc ghim hoặc đổi nhóm; luôn thắng luật tự động.
4. AI (tuỳ chọn): schema `ai.rs` thêm `role: "main"|"supporting"|"minor"|"not_a_character"` cho mỗi người; lưu vào `XrAi.roles`. `not_a_character` → chuyển sang loại `org`/`term` (không xoá). Vai trò AI chỉ dùng khi người đọc chưa tự đặt.
5. Kiểm tra: `app/scripts/check-xray-tiers.mjs` chạy `tiers()` trên chỉ mục mẫu (một tiểu thuyết ngôi thứ nhất, một sách phi hư cấu): tác giả không lọt vào, người chỉ xuất hiện 1 chương bị xếp Thoáng qua, top 3 không đổi.

## Giai đoạn 2: Nhảy tới đoạn trích và quay lại (màn 3, 8)

**Mục tiêu:** bấm một đoạn không bao giờ làm lạc chỗ đang đọc.

1. `XRay.tsx`: đoạn nhắc đến **mở rộng tại chỗ** (màn 3). Lấy câu chứa tên + 2 câu trước và sau từ đoạn văn của phần đó (`rangeAt` đã có; mở rộng tới ranh giới câu), tô tên bằng `<mark>`. Hai nút: **Đến đoạn này** và **Thu gọn**.
2. `goToMention` trả về CFI của đoạn đích. Trước khi nhảy, `Reader` lưu `jumpFrom = { cfi, fraction, chapter }` của chỗ đang đọc (khác `undoJump` hiện có: tồn tại tới khi người đọc quay lại hoặc bỏ qua).
3. **Tô sáng đoạn đích** 3 giây bằng một annotation tạm (`addAnnotation` với kiểu riêng `xray-flash`, rồi `deleteAnnotation`); chỉ tô câu có tên, không lưu vào DB.
4. Thành phần mới `JumpBack` (Android) nổi trên trang, **không cần mở thanh điều khiển**:
   - "← Quay lại chỗ đang đọc · {chương} · {x}%" → `view.goTo(jumpFrom.cfi)`;
   - nút **X-Ray** (avatar nhân vật) → mở lại sidebar X-Ray đúng nhân vật và đoạn vừa xem (`xrSel` đã được giữ).
   - Ẩn khi: bấm quay lại, đọc tiếp từ chỗ mới quá 3 trang (người đọc chọn ở lại), hoặc nhảy lần khác (cập nhật đích, giữ `jumpFrom` cũ).
   - Nút Back của Android cũng quay lại chỗ cũ khi `JumpBack` đang hiện.
5. Thanh tiến độ dưới cùng thêm **vạch "đang đọc"** tại `jumpFrom.fraction`.
6. Đoạn nằm **sau** chỗ đang đọc: ẩn mặc định trong danh sách đoạn; khi người đọc bấm "Hiện" thì đoạn đó có nhãn "có thể lộ nội dung".

## Giai đoạn 3: Danh sách và trang nhân vật (màn 1, 2, 4)

1. `XRayPanel` (Android):
   - Ba tab Nhân vật / Nơi chốn / Thuật ngữ, dòng phụ "Tên sách · tới {x}%, không lộ phần sau".
   - Thẻ **Sơ đồ quan hệ** ở đầu.
   - Nhóm **Chính**: dòng có avatar màu (màu cố định theo tên), tên, một câu vai trò (mệnh đề đầu của mô tả AI, hoặc quan hệ với nhân vật trung tâm "Cha của Elizabeth"), số lần.
   - Nhóm **Phụ**: các nút tên nhỏ. **Thoáng qua**: một dòng gập "N người (ẩn)".
   - Ô tìm kiếm giữ như cũ, tìm cả nhóm Thoáng qua.
2. `MobileXRayDetail` mới (tách khỏi `XRayDetail`; PC giữ `XRayDetail`):
   - Đầu trang: nút quay về, `•••`, đóng. Avatar lớn, tên **một lần**, nhãn nhóm, câu vai trò.
   - "Xuất hiện N lần · lần đầu ở {chương} ({x}%)": dùng `chapterOf`, bỏ số vị trí thô.
   - Dải vị trí (`Spread`) theo cả sách, phần sau chỗ đang đọc mờ, vạch "Bạn ở đây".
   - Giới thiệu (mô tả AI hoặc câu đầu tiên nhắc tới) + Wikipedia khi phù hợp.
   - Quan hệ: tối đa 6 dòng, nhãn màu theo loại (`relKind`), chạm → sơ đồ tập trung vào người đó.
   - Các đoạn nhắc đến: nhóm theo chương; 20 đoạn đầu, "Xem thêm"; vạch "Bạn đang đọc ở đây"; đoạn sau đó ẩn (Giai đoạn 2).
3. `XRayEditSheet` (màn 4) mở từ `•••`, dùng lại các hàm sửa đang có: đổi tên, đổi loại, **vai trò** (tự động / chính / phụ / ẩn), tên gọi (tách bằng ×, gộp với người khác), ẩn khỏi X-Ray.

## Giai đoạn 4: Sơ đồ quan hệ cho điện thoại (màn 5, 6, 7)

1. `MobileRelationMap.tsx` thay `XRayGraph` trên Android (PC giữ `XRayGraph`). Ba chế độ: **Theo nhóm** (mặc định, màn 5), **Tập trung** (màn 6), **Danh sách** (màn 7).
2. **Chia nhóm** (`xrayIndex.ts`, hàm mới `groups(ents, links, limit)`; chạy cùng `tiers()`, chỉ trên người ở nhóm Chính và Phụ, tính tới vị trí đang đọc):
   1. **Gia đình theo họ:** những người cùng họ (từ cuối của tên đầy đủ với tên phương Tây, từ đầu với tên Việt/Hàn/Trung; nhận diện theo thứ tự tên trong sách) và có nối với nhau → "Gia đình {họ}". Quan hệ họ hàng tự nhận (`kin`, "bố tôi") cũng vào nhóm gia đình của người kể chuyện.
   2. **Theo tổ chức:** với mỗi tổ chức X-Ray tìm được (`org`, ví dụ Theranos, Stanford), những người xuất hiện cùng tổ chức đó đủ nhiều (≥ 3 đoạn chung và ≥ 30% số lần người đó được nhắc) → nhóm mang tên tổ chức. Một người chỉ vào một nhóm: nhóm có tỷ lệ cao nhất.
   3. **Theo cụm:** người còn lại → tìm cộng đồng trên đồ thị cùng-xuất-hiện (label propagation, có trọng số, cố định thứ tự để kết quả không đổi giữa các lần mở). Tên cụm = tổ chức hoặc nơi chốn đi cùng cụm nhiều nhất ("Những người ở Palo Alto"); không có thì "Những người khác".
   4. Nhóm chỉ có 1 người thì gộp vào "Những người khác"; tối đa 6 nhóm, còn lại gộp.
   5. Người đọc đổi được nhóm của một người và đổi tên nhóm (`XrEdits.groups`, `XrEdits.groupNames`); AI (Giai đoạn 5) cho tên nhóm và dòng vai trò; thứ tự ưu tiên: người đọc → AI → luật.
3. **Dòng vai trò** dưới tên mỗi người (tối đa ~6 chữ): nhãn quan hệ với nhân vật trung tâm nếu có ("Cha của Elizabeth"); không có thì mệnh đề đầu của mô tả AI; không có nữa thì để trống (không bịa).
4. **Bố cục poster** (màn 5, cuộn dọc, không zoom):
   - Trên cùng: 1–2 **nhân vật trung tâm**: người điểm cao nhất (hoặc người kể chuyện), cộng người nối mạnh nhất với họ nếu điểm người đó ≥ 60% điểm người thứ nhất. Thẻ lớn; giữa hai thẻ là nhãn quan hệ của họ.
   - Bên dưới: các **khung nhóm**, xếp theo độ gắn với trung tâm (tổng số đoạn chung). Mỗi khung: tên nhóm, số người, chip quan hệ của cả nhóm với trung tâm ("gia đình", "công ty của cô", "đối đầu": nhãn chiếm đa số trong nhóm, màu theo loại). Trong khung là lưới 3 cột: avatar, tên, dòng vai trò.
   - Một **trục dọc** bên trái nối trung tâm với từng khung (chấm màu theo loại quan hệ). Không vẽ đường tới từng người, nên không có đường chéo nhau.
   - Quan hệ đáng chú ý giữa hai người khác nhóm (Tyler là cháu của George) ghi vào dòng vai trò, không vẽ đường.
   - Công tắc "Hiện nhân vật phụ" thêm người nhóm Phụ vào các khung; mặc định chỉ người nhóm Chính và người Phụ nối mạnh với trung tâm (≤ 4 người mỗi khung, còn lại là ô "+N").
   - Dòng ghi chú cuối: nhóm tính tới chỗ đang đọc, có thể đổi khi đọc tiếp.
5. **Tập trung** (màn 6): chạm một người → người đó vào tâm, vòng quanh = quan hệ trực tiếp, xếp theo độ mạnh (tối đa 10; nhiều hơn thì có "+N" mở danh sách). Chỉ dùng quan hệ có nhãn hoặc mạnh.
6. Bố cục `radialLayout()` mới trong `graphLayout.ts` cho chế độ Tập trung, không còn lực đẩy-hút:
   - Tâm ở giữa; một vòng (≤8 người) hoặc hai vòng (người có quan hệ phụ ra vòng ngoài, như George → Tyler).
   - Góc chia đều, người cùng loại quan hệ đứng gần nhau.
   - Nhãn quan hệ đặt **trên đường nối, cách tâm 55%**; nhãn rộng quá thì rút gọn và hiện đủ khi chạm.
   - Bố cục cố định theo dữ liệu (cùng sách cùng vị trí → cùng hình), có test không chồng lấn.
7. Tương tác:
   - Chạm người (ở poster hoặc vòng) → tập trung. Hàng "Elizabeth › Chris" ghi lịch sử, nút Back của Android lùi theo lịch sử, rồi về poster.
   - Chạm tên khung nhóm → bảng các thành viên kèm số lần xuất hiện và nút đổi tên nhóm.
   - Thẻ dưới cùng của người đang ở tâm → trang nhân vật.
   - Chạm nhãn quan hệ → bảng các đoạn hai người cùng xuất hiện (dùng lại `EdgePanel` dạng bảng trượt).
   - Không cần kéo nút hay zoom; vẫn cho chụm hai ngón khi màn hình chật.
8. Tab **Danh sách** (màn 7): nhóm theo Gia đình / Tình cảm / Công việc / Đối đầu / Khác, mỗi dòng "A là cha của B" + số lần cùng xuất hiện.
9. Màu theo loại: Gia đình xanh dương, Tình cảm hồng, Công việc xanh lá, Đối đầu cam, Khác xám. Các màu khác nhau cả về độ sáng, và luôn có chữ đi kèm.
10. Nút AI và phạm vi "cả sách" chuyển vào menu `•••` của màn sơ đồ.
11. Kiểm tra: `check-xray-groups.mjs` trên chỉ mục mẫu: gia đình cùng họ gom đúng, người gắn với một tổ chức vào nhóm tổ chức, kết quả không đổi giữa hai lần chạy, không nhóm nào chỉ một người.

## Giai đoạn 5: AI vai trò và hoàn thiện

1. Thêm vào lời gọi AI hiện có, không thêm lần gọi riêng: `role` (Giai đoạn 1.4), `group` (tên nhóm/phe ngắn, ví dụ "Hội đồng quản trị") và `caption` (dòng vai trò ≤ 6 chữ) cho mỗi người; cùng quy tắc chỉ dùng đoạn đã đọc. Ước tính chi phí (`xray_ai_estimate`) cập nhật theo.
2. Chuỗi vi/en cho mọi chữ mới (`i18n.ts`).
3. Dữ liệu mẫu cho trang preview (`dev/`) để xem các màn không cần sách thật.

## Kiểm tra

- `npx tsc --noEmit`, các `app/scripts/check-*.mjs` (thêm `check-xray-tiers.mjs` và `check-radial-layout.mjs`), `cargo test` (schema AI).
- Thử trên máy ảo Android với 2 sách: *Máu Bẩn* (phi hư cấu, nhiều người thật, tác giả xuất hiện) và một tiểu thuyết xưng "tôi":
  - nhóm Chính hợp lý, không có tác giả và tổ chức;
  - bấm đoạn → mở rộng tại chỗ → Đến đoạn này → đoạn được tô → Quay lại đúng trang cũ, cả bằng nút Back;
  - sơ đồ theo nhóm: *Máu Bẩn* ra được gia đình Holmes, Theranos, Stanford; tiểu thuyết xưng "tôi" ra gia đình người kể chuyện; mỗi người có dòng vai trò hoặc để trống, không bịa;
  - chế độ tập trung: chạm đổi tâm, lịch sử lùi được, nhãn không đè nhau.
- PC: danh sách và sơ đồ cũ vẫn chạy; nhóm mới chỉ làm danh sách gọn hơn.

## Thứ tự và khối lượng

| # | Việc | File chính | Ước lượng |
|---|---|---|---|
| 1 | Nhóm nhân vật, loại tác giả | `xrayIndex.ts`, `XRay.tsx`, `Reader.tsx` | vừa |
| 2 | Nhảy và quay lại, tô sáng | `XRay.tsx`, `Reader.tsx`, CSS mobile | vừa |
| 3 | Danh sách + trang nhân vật + menu sửa | `XRay.tsx` (tách `MobileXRayDetail`, `XRayEditSheet`) | lớn |
| 4 | Chia nhóm + sơ đồ poster theo nhóm + chế độ tập trung + danh sách quan hệ | `xrayIndex.ts` (`groups`), `MobileRelationMap.tsx`, `graphLayout.ts` | lớn |
| 5 | AI vai trò, chuỗi, preview | `ai.rs`, `i18n.ts`, `dev/` | nhỏ |

Mỗi giai đoạn là một commit riêng, chạy được độc lập; giai đoạn 1–2 cải thiện ngay cả khi giao diện cũ còn nguyên.

## Câu hỏi mở

- Ngưỡng nhóm (35% điểm cao nhất, < 5 lần nhắc) cần chỉnh sau khi thử trên vài sách.
- Sách không có mục lục: "lần đầu ở chương…" thay bằng "ở {x}%".
- Người đọc ghim một người vào Chính nhưng AI nói "không phải nhân vật": người đọc thắng.
