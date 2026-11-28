// A small made-up book for the X-Ray preview (xray-preview.html): a startup
// story told in the third person, with a family (the Vances), a company
// (Lumen), a school, a few minor people, people met once, and the author
// named in the front matter. Every name and event is invented.

const P = (s: string) => `<p>${s}</p>`;

const front = [
  "<h1>Ánh Sáng Giả</h1>",
  P("Tác giả: Nam Phong. Bản quyền thuộc về Nam Phong và nhà xuất bản."),
  P("Nam Phong cảm ơn những người đã kể lại câu chuyện này."),
];

/** Chapter title and paragraphs. */
const chapters: [string, string[]][] = [
  ["Chương 1 · Cô bé ở Palo Alto", [
    "Mira Vance lớn lên ở Palo Alto, trong một căn nhà lúc nào cũng đầy sách. Daniel Vance, cha cô, làm kỹ sư cho thành phố.",
    "Những buổi tối, Daniel Vance kể cho Mira về ông cố từng mở xưởng in. Ruth Vance, mẹ cô, chỉ mỉm cười rồi dọn bàn.",
    "Mira hỏi cha vì sao ông cố mất xưởng in. Daniel nói rằng có những người dám nghĩ lớn nhưng không dám nhìn sự thật.",
    "Owen Vance, em trai Mira, thường ngồi nghe cùng chị. Owen hỏi Mira muốn làm gì khi lớn. Mira nói cô muốn làm một thứ chưa ai làm.",
    "Ruth Vance đưa hai chị em tới thư viện mỗi thứ bảy. Ruth tin rằng Mira sẽ thành nhà khoa học.",
    "Hàng xóm vẫn nhớ Daniel Vance như một người cha hiền, còn Ruth Vance thì nghiêm hơn. Ai cũng nói rằng Mira Vance giống cha, và cậu bé Owen Vance luôn đi theo chị.",
  ]],
  ["Chương 2 · Stanford", [
    "Mira vào Stanford năm mười tám tuổi. Ở Stanford, cô gặp giáo sư Hana Ito, người dạy môn hoá sinh.",
    "Hana Ito nhận Mira vào phòng thí nghiệm. Mira hỏi Hana Ito liệu có thể thử máu chỉ với một giọt.",
    "Hana Ito lắc đầu và nói rằng một giọt máu không đủ cho hầu hết các xét nghiệm. Mira không tin điều đó.",
    "Cũng ở Stanford, Mira quen Sam Kader, một doanh nhân hơn cô gần hai mươi tuổi. Sam Kader nói anh tin vào ý tưởng của cô.",
    "Daniel Vance gọi điện hỏi con gái về việc học. Mira nói với cha rằng cô sẽ nghỉ học để mở công ty.",
    "Trong thư gửi về nhà, Mira Vance kể cho Ruth Vance về phòng thí nghiệm. Lúc ấy Daniel Vance chỉ lặng im, còn Owen Vance thì háo hức.",
  ]],
  ["Chương 3 · Lumen ra đời", [
    "Mira đặt tên công ty là Lumen. Công ty Lumen thuê một văn phòng nhỏ gần Stanford.",
    "Sam Kader góp tiền và nhận chức giám đốc vận hành của Lumen. Sam Kader và Mira làm việc tới khuya mỗi đêm.",
    "Ian Price, một nhà hoá học trầm lặng, là người đầu tiên Lumen tuyển. Ian Price hỏi Mira chiếc máy sẽ hoạt động thế nào.",
    "Mira nói với Ian Price rằng chỉ cần thời gian. Ian Price ghi chép mọi thứ vào một cuốn sổ đen.",
    "Erin Cole tới Lumen sau đó vài tháng. Erin Cole làm cùng Ian Price trong phòng thí nghiệm.",
  ]],
  ["Chương 4 · Hội đồng", [
    "Để gọi vốn, Mira mời George Brook, một cựu bộ trưởng, vào hội đồng của Lumen. George Brook nói ông chưa từng thấy ai thuyết phục như Mira.",
    "George Brook giới thiệu thêm nhiều người nổi tiếng vào hội đồng. Sam Kader nói với Mira rằng họ cần những cái tên như vậy.",
    "Daniel Vance tới dự buổi ra mắt và đứng ở hàng cuối. Ruth Vance ôm con gái và khóc.",
    "Owen Vance được Mira nhận vào làm ở bộ phận bán hàng. Owen hỏi chị liệu chiếc máy đã chạy chưa. Mira không trả lời.",
    "Một người phục vụ tên Leo mang cà phê vào phòng họp rồi đi ra.",
    "Trong buổi ra mắt, Daniel Vance và Ruth Vance ngồi cạnh Owen Vance. Họ nhìn Mira Vance nói về Lumen với hội đồng.",
  ]],
  ["Chương 5 · Tyler", [
    "Tyler Brook, cháu của George Brook, tới Lumen làm việc sau khi tốt nghiệp. Tyler Brook làm cùng Erin Cole.",
    "Tyler nhận ra các con số trong báo cáo không khớp. Tyler hỏi Erin Cole vì sao kết quả thay đổi mỗi lần chạy.",
    "Erin Cole nói với Tyler rằng cô cũng đã thấy điều đó. Erin Cole đưa cho Tyler cuốn sổ của Ian Price.",
    "Sam Kader gọi Tyler Brook vào phòng và nói rằng anh không được hỏi nhiều.",
    "Tyler kể chuyện với ông nội. George Brook nói rằng Mira là người tử tế và Tyler nên tin cô.",
  ]],
  ["Chương 6 · Ian", [
    "Ian Price ngày càng ít nói. Ian Price nói với Erin Cole rằng ông sợ chiếc máy sẽ làm hại người bệnh.",
    "Mira gọi Ian Price lên văn phòng. Sam Kader đứng cạnh Mira suốt buổi.",
    "Hana Ito gửi thư cho Mira, hỏi về các kết quả mà Lumen công bố. Mira không trả lời Hana Ito.",
    "Erin Cole rời Lumen vào cuối năm. Erin Cole nói với Tyler rằng cô không thể ở lại.",
    "Tyler Brook ở lại thêm vài tháng. Tyler viết lại mọi thứ mình thấy.",
  ]],
  ["Chương 7 · Tình yêu và quyền lực", [
    "Không ai ở Lumen biết Sam Kader và Mira là người yêu. Sam Kader quản lý mọi người bằng nỗi sợ.",
    "Owen Vance nói với chị rằng nhân viên sợ Sam Kader. Mira bảo Owen đừng can thiệp.",
    "Daniel Vance gọi cho con gái và hỏi cô có hạnh phúc không. Mira nói với cha rằng cô chưa bao giờ hạnh phúc hơn.",
    "Ruth Vance tới thăm văn phòng Lumen và thấy con gái gầy đi nhiều.",
    "George Brook vẫn bảo vệ Mira trong mọi cuộc họp của hội đồng.",
    "Có lần Owen Vance cãi nhau với Sam Kader trước mặt mọi người. Ruth Vance lo cho cả hai con.",
  ]],
  ["Chương 8 · Phóng viên", [
    "Một phóng viên tên Carl Ober bắt đầu tìm hiểu về Lumen. Carl Ober gọi cho Erin Cole và Tyler Brook.",
    "Tyler Brook kể cho Carl Ober mọi điều anh đã thấy. Carl Ober hỏi Tyler liệu anh có sợ không.",
    "Sam Kader thuê luật sư theo dõi Tyler. George Brook giận cháu mình và không nói chuyện với Tyler nữa.",
    "Erin Cole đồng ý nói chuyện với Carl Ober, với điều kiện giấu tên.",
    "Mira nói với hội đồng rằng Carl Ober đang bịa chuyện.",
  ]],
  ["Chương 9 · Sụp đổ", [
    "Bài báo của Carl Ober được đăng vào mùa thu. Cổ phiếu của các đối tác Lumen lao dốc.",
    "Sam Kader rời Lumen sau một cuộc cãi vã với Mira. Mira nói rằng Sam Kader đã phản bội cô.",
    "Daniel Vance và Ruth Vance đến ở cạnh con gái. Owen Vance nghỉ việc.",
    "George Brook xin lỗi Tyler Brook. Tyler nói với ông nội rằng anh chỉ muốn sự thật được biết.",
    "Hana Ito nói với Carl Ober rằng bà đã cảnh báo Mira từ những ngày ở Stanford.",
    "Cuối cùng chỉ còn Daniel Vance, Ruth Vance và Owen Vance ở bên Mira Vance.",
  ]],
  ["Chương 10 · Sau tất cả", [
    "Lumen đóng cửa. Mira Vance ra toà vào một buổi sáng mưa.",
    "Tyler Brook tiếp tục làm khoa học ở một phòng thí nghiệm nhỏ. Erin Cole làm cùng Tyler.",
    "Ian Price không còn ở đó để thấy ngày này. Erin Cole giữ cuốn sổ đen của Ian Price.",
    "Daniel Vance kể lại cho Owen câu chuyện về ông cố và xưởng in. Owen Vance im lặng.",
    "Carl Ober viết một cuốn sách về Lumen.",
    "Phiên toà xử Mira Vance kéo dài nhiều tuần. Ngày nào Daniel Vance cũng ngồi ở hàng ghế đầu.",
  ]],
];

const back = [P("Lời cảm ơn. Nam Phong cảm ơn biên tập viên Thu Hà."), P("Thu Hà đã đọc bản thảo đầu tiên.")];

/** Sections as HTML: front matter, chapters, back matter. */
export const SECTIONS: { title: string; html: string }[] = [
  { title: "", html: front.join("") },
  ...chapters.map(([title, ps]) => ({ title, html: `<h2>${title}</h2>` + ps.map(P).join("") })),
  { title: "", html: back.join("") },
];

/**
 * A stand-in for the foliate view: the parts X-Ray reads (sections, their
 * place in the book, CFIs) and the jumps it asks for (logged).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fakeView(onGo: (where: string) => void): any {
  const sizes = SECTIONS.map((s) => s.html.length);
  const total = sizes.reduce((a, b) => a + b, 0);
  const fractions: number[] = [];
  let acc = 0;
  for (const n of sizes) {
    fractions.push(acc / total);
    acc += n;
  }
  return {
    book: {
      sections: SECTIONS.map((s) => ({
        createDocument: async () => new DOMParser().parseFromString(`<html><body>${s.html}</body></html>`, "text/html"),
      })),
    },
    getSectionFractions: () => fractions,
    getCFI: (index: number, range: Range) => `epubcfi(/6/${index * 2}!${range.toString().slice(0, 24)})`,
    goTo: async (cfi: string) => onGo(cfi),
  };
}

/** Section index → chapter title. */
export const chapterOf = (i: number) => SECTIONS[i]?.title ?? "";
