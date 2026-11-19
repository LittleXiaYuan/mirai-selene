/**
 * 世界市场的价目表。客户端只拿展示字段，价格与抽成以这里为准 ——
 * 不能由前端传 price，否则谁都能把 28 改成 0。
 */
export const MARKET_LISTINGS = [
  {
    id: "last-call-demo",
    title: "最后一通电话",
    price: 0,
    tag: "免费",
    summary: "合同签字截止前两小时，母亲在电话那头停顿了半拍。",
    authorCut: 0,
  },
  {
    id: "natural-after-school",
    title: "放学后的窗边",
    price: 12,
    tag: "高张力",
    summary: "她约你放学后留在教室，手里捏着一封没有署名的信。",
    authorCut: 70,
  },
  {
    id: "wednesday-before",
    title: "周三之前",
    price: 18,
    tag: "编辑推荐",
    summary: "母亲的手术排在下周三，上海的 offer 要你周二答复。",
    authorCut: 70,
  },
  {
    id: "dd-before-48h",
    title: "尽调前 48 小时",
    price: 24,
    tag: "死局悬赏",
    summary: "投资人周一进场，今晚技术合伙人要你交出生产库主密钥。",
    authorCut: 70,
  },
  {
    id: "whistleblower-eve",
    title: "实名举报前夜",
    price: 28,
    tag: "死局悬赏",
    summary: "明早九点签字，今晚被举报的人约你喝咖啡。",
    authorCut: 70,
  },
];

export function findListing(id) {
  return MARKET_LISTINGS.find((listing) => listing.id === id) ?? null;
}
