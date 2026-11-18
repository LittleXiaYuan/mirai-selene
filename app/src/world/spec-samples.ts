import type { WorldSpec } from "./spec";

/**
 * 三个可以直接热载入的内置世界。
 *
 * 它们用的是同一份 Spec 结构和同一个渲染器；换世界只是换 JSON。
 * 资产先指向仓库里已有的插画与立绘，等资产工厂产出新切片后改路径即可。
 */

const portrait = (base: string) => ({
  base,
  emotions: {
    neutral: base,
    warm: base,
    cold: base,
    tense: base,
    broken: base,
  },
});

const backdrop = (path: string, focus: "center" | "top" = "center") => ({ path, focus });

export const SPEC_ROOM: WorldSpec = {
  spec_version: "1.0",
  id: "wednesday-before",
  title: "周三之前",
  subtitle: "医院走廊 · 上海 offer",
  logline: "母亲的复查报告在周三出。上海的 offer 要你在周二答复。",
  ui: { palette: "warm", accent: "rose" },
  assets_manifest: {
    cover: backdrop("/mirai/cover-wednesday.webp"),
    backgrounds: {
      corridor: backdrop("/mirai/01-cover.webp"),
      ward: backdrop("/mirai/05-sleep.webp"),
      city: backdrop("/mirai/07-market.webp"),
      night: backdrop("/mirai/08-closing.webp"),
    },
    portraits: {
      linxia: portrait("/mirai/linxia.webp"),
      mother: portrait("/mirai/mother.webp"),
    },
  },
  cast: [
    { id: "linxia", name: "林夏", role: "你", traits: "怕的不是选错，是没得选", portrait: "linxia" },
    { id: "mother", name: "母亲", role: "家人", traits: "嘴硬心软，不肯说复查结果", portrait: "mother" },
  ],
  state_injection: {
    prior_memories: [
      { key: "房租压力", value: 6 },
      { key: "想家", value: 5 },
    ],
    stance_bias: { neutral: 0.4, probe_blindspot: 0.3 },
    temperature: 0.7,
  },
  entry: "corridor",
  logic_nodes: [
    {
      id: "corridor",
      title: "医院走廊",
      scene: { background: "corridor", place: "医院走廊", time: "黄昏", weather: "阴", mood: "紧绷" },
      speaker: "母亲",
      text: "她把报告单折了两折，塞进包里，说「没什么大事」。说完却没站起来，手指一直压在包的搭扣上。",
      stance_goal: "neutral",
      observe: [{ key: "怀疑", value: 5 }],
      choices: [
        { label: "直接问她报告上写了什么", to: "ask", memory: { key: "逼问", value: 7 } },
        { label: "先坐下，陪她把这一会儿坐完", to: "sit", memory: { key: "陪伴", value: 6 } },
      ],
    },
    {
      id: "ask",
      title: "把话问开",
      scene: { background: "corridor", place: "医院走廊", time: "黄昏", weather: "阴", mood: "紧绷" },
      speaker: "母亲",
      text: "「你明天不是还要回电话吗？」她把问题推回来，眼睛没看你，「你先把你自己的事定下来。」",
      stance_goal: "skeptical_push",
      observe: [{ key: "被推回来", value: 6 }],
      choices: [
        { label: "把 offer 的截止时间告诉她", to: "offer", memory: { key: "坦白", value: 7 } },
        { label: "说「我的事不急」", to: "deflect", memory: { key: "回避", value: 5 } },
      ],
    },
    {
      id: "sit",
      title: "坐一会儿",
      scene: { background: "corridor", place: "医院走廊", time: "黄昏", weather: "阴", mood: "安静" },
      speaker: "母亲",
      text: "走廊的灯亮了一排。她终于把包放到腿上，声音低下来：「周三拿结果。你先别告诉他们你妈这边的事。」",
      stance_goal: "empathetic",
      observe: [{ key: "被信任", value: 7 }],
      choices: [
        { label: "答应她，先不说", to: "promise", memory: { key: "承诺", value: 7 } },
        { label: "说「这事我得自己决定」", to: "offer", memory: { key: "边界", value: 6 } },
      ],
    },
    {
      id: "offer",
      title: "周二的电话",
      scene: { background: "city", place: "出租屋", time: "深夜", weather: "晴", mood: "紧绷" },
      speaker: "林夏",
      text: " offer 的邮件停在「请于周二 18:00 前回复」。你把手机扣在桌上，桌面震了一下，又安静了。",
      stance_goal: "probe_blindspot",
      observe: [{ key: "时限", value: 8 }],
      choices: [
        { label: "打给上海的 HR，要求延到周三", to: "extend", memory: { key: "争取", value: 7 } },
        { label: "回绝，留在青岛", to: "stay", memory: { key: "留下", value: 8 } },
      ],
    },
    {
      id: "promise",
      title: "承诺之后",
      scene: { background: "night", place: "医院门口", time: "夜", weather: "雾", mood: "安静" },
      speaker: "母亲",
      text: "她把你送到门口，忽然说：「要是周三结果不好，你就走。别因为我，把你自己按在这儿。」",
      stance_goal: "counter_bluff",
      observe: [{ key: "被推着走", value: 7 }],
      choices: [
        { label: "说「我不走」", to: "stay", memory: { key: "留下", value: 9 } },
        { label: "沉默，替她叫了车", to: "silence", memory: { key: "没说出口", value: 6 } },
      ],
    },
    {
      id: "extend",
      title: "争取来的二十四小时",
      scene: { background: "city", place: "出租屋", time: "清晨", weather: "晴", mood: "安静" },
      speaker: "HR",
      text: "对面沉默了几秒，说可以延到周三中午，但「这是最后一次」。你挂了电话，发现手心全是汗。",
      stance_goal: "neutral",
      observe: [{ key: "多一天", value: 6 }],
      choices: [],
    },
    {
      id: "stay",
      title: "留在青岛",
      scene: { background: "ward", place: "病房外", time: "清晨", weather: "晴", mood: "安静" },
      speaker: "母亲",
      text: "结果出来那天，她自己先笑了：「看吧，我说没事。」你不知道她是真的不怕，还是练过很多次。",
      stance_goal: "empathetic",
      observe: [{ key: "安心", value: 8 }],
      choices: [],
    },
    {
      id: "deflect",
      title: "把话咽回去",
      scene: { background: "corridor", place: "医院走廊", time: "夜", weather: "阴", mood: "疏离" },
      speaker: "母亲",
      text: "她点点头，没再问。你们并排坐着，各自看手机。那条没发出去的消息，在输入框里停到自动保存。",
      stance_goal: "rupture",
      observe: [{ key: "没说出口", value: 9 }],
      choices: [],
    },
    {
      id: "silence",
      title: "车走了",
      scene: { background: "night", place: "医院门口", time: "夜", weather: "雾", mood: "疏离" },
      speaker: "旁白",
      text: "车灯拐过街角就没了。你站在原地，风把报告单的折痕吹开一点，又合上。",
      stance_goal: "rupture",
      observe: [{ key: "错过", value: 8 }],
      choices: [],
    },
  ],
};

export const SPEC_PARTNER: WorldSpec = {
  spec_version: "1.0",
  id: "dd-before-48h",
  title: "尽调前 48 小时",
  subtitle: "技术合伙人 · 密钥逼宫",
  logline: "投资人周一进场。今晚，技术合伙人要你交出生产库的主密钥。",
  ui: { palette: "noir", accent: "violet" },
  assets_manifest: {
    cover: backdrop("/mirai/cover-dd48h.webp"),
    backgrounds: {
      office: backdrop("/mirai/06-tech.webp"),
      rain: backdrop("/mirai/03-insight.webp"),
      roof: backdrop("/mirai/08-closing.webp"),
    },
    portraits: {
      mentor: portrait("/mirai/mentor.webp"),
      selene: portrait("/mirai/selene.webp"),
    },
  },
  cast: [
    { id: "founder", name: "你", role: "CEO", traits: "知道账上只剩六周", portrait: "mentor" },
    { id: "cto", name: "周屿", role: "技术合伙人", traits: "把代码当孩子，最恨被人绕过", portrait: "selene" },
  ],
  state_injection: {
    prior_memories: [
      { key: "控制权", value: 7 },
      { key: "信任缺口", value: 6 },
    ],
    stance_bias: { skeptical_push: 0.5, counter_bluff: 0.4 },
    temperature: 0.8,
  },
  entry: "office",
  logic_nodes: [
    {
      id: "office",
      title: "办公室的雨",
      scene: { background: "office", place: "办公室", time: "深夜", weather: "雨", mood: "紧绷" },
      speaker: "周屿",
      text: "他把笔记本电脑转过来，屏幕上是你上周签的那份数据授权。「尽调要看生产库。密钥在谁手里，你今晚给个说法。」",
      stance_goal: "neutral",
      observe: [{ key: "控制权", value: 7 }],
      choices: [
        { label: "承认密钥一直在我手里", to: "own", memory: { key: "坦白", value: 7 } },
        { label: "说这是投资人的要求", to: "blame", memory: { key: "甩锅", value: 6 } },
      ],
    },
    {
      id: "own",
      title: "把底牌摊开",
      scene: { background: "office", place: "办公室", time: "深夜", weather: "雨", mood: "安静" },
      speaker: "周屿",
      text: "他盯了你三秒，笑了一下：「你防我，防到尽调前一晚。」窗外雨敲在空调外机上，一声一声。",
      stance_goal: "skeptical_push",
      observe: [{ key: "信任缺口", value: 8 }],
      choices: [
        { label: "说账上只剩六周", to: "cash", memory: { key: "示弱", value: 7 } },
        { label: "说「你可以不签」", to: "ultimatum", memory: { key: "摊牌", value: 8 } },
      ],
    },
    {
      id: "blame",
      title: "把球踢回去",
      scene: { background: "office", place: "办公室", time: "深夜", weather: "雨", mood: "紧绷" },
      speaker: "周屿",
      text: "「投资人要求？」他重复了一遍，声音很轻，「那你现在是代表他，跟我谈？」他把电脑合上了。",
      stance_goal: "counter_bluff",
      observe: [{ key: "对立", value: 8 }],
      choices: [
        { label: "承认这是借口", to: "own", memory: { key: "坦白", value: 6 } },
        { label: "顺势把话说死", to: "ultimatum", memory: { key: "摊牌", value: 9 } },
      ],
    },
    {
      id: "cash",
      title: "六周",
      scene: { background: "rain", place: "天台", time: "凌晨", weather: "雨", mood: "疏离" },
      speaker: "周屿",
      text: "「六周。」他把烟掐了，「你早说六周，我不会问密钥。我会问你打算怎么活。」",
      stance_goal: "probe_blindspot",
      observe: [{ key: "被看穿", value: 8 }],
      choices: [
        { label: "问他愿不愿意一起扛", to: "together", memory: { key: "同盟", value: 8 } },
        { label: "说「我自己扛」", to: "alone", memory: { key: "孤军", value: 7 } },
      ],
    },
    {
      id: "ultimatum",
      title: "不签就走",
      scene: { background: "roof", place: "天台", time: "凌晨", weather: "雨", mood: "紧绷" },
      speaker: "周屿",
      text: "他站起来，把工牌放在桌上。「那今晚就到这儿。明天尽调，你自己讲。」门没关，走廊的灯照进来一条。",
      stance_goal: "rupture",
      observe: [{ key: "决裂", value: 9 }],
      choices: [
        { label: "叫住他，认下密钥的事", to: "own", memory: { key: "挽回", value: 7 } },
        { label: "让他走", to: "alone", memory: { key: "孤军", value: 9 } },
      ],
    },
    {
      id: "together",
      title: "一起扛",
      scene: { background: "rain", place: "天台", time: "凌晨", weather: "雨", mood: "安静" },
      speaker: "周屿",
      text: "「密钥可以给。」他说，「但你得让我进董事会。」雨小了，他把外套拉链拉到顶。",
      stance_goal: "empathetic",
      observe: [{ key: "同盟", value: 9 }],
      choices: [],
    },
    {
      id: "alone",
      title: "一个人讲",
      scene: { background: "roof", place: "天台", time: "凌晨", weather: "雨", mood: "疏离" },
      speaker: "旁白",
      text: "天快亮了。你把两份授权书摆在一起，发现签字栏都是你的名字。风把纸角吹起来，又按下去。",
      stance_goal: "rupture",
      observe: [{ key: "孤军", value: 9 }],
      choices: [],
    },
  ],
};

export const SPEC_WHISTLE: WorldSpec = {
  spec_version: "1.0",
  id: "whistleblower-eve",
  title: "实名举报前夜",
  subtitle: "咖啡馆 · 私下约谈",
  logline: "明早九点，你要在举报信上签字。今晚，被举报的人约你喝咖啡。",
  ui: { palette: "cream", accent: "amber" },
  assets_manifest: {
    cover: backdrop("/mirai/cover-whistleblow.webp"),
    backgrounds: {
      cafe: backdrop("/mirai/04-world.webp"),
      street: backdrop("/mirai/07-market.webp"),
      home: backdrop("/mirai/08-closing.webp"),
    },
    portraits: {
      linxia: portrait("/mirai/linxia.webp"),
      mentor: portrait("/mirai/mentor.webp"),
    },
  },
  cast: [
    { id: "you", name: "你", role: "举报人", traits: "证据在包里，手一直在抖", portrait: "linxia" },
    { id: "target", name: "陈总", role: "被举报人", traits: "从不发火，擅长让人自己退", portrait: "mentor" },
  ],
  state_injection: {
    prior_memories: [
      { key: "证据", value: 8 },
      { key: "恐惧", value: 7 },
    ],
    stance_bias: { probe_blindspot: 0.5, skeptical_push: 0.3 },
    temperature: 0.6,
  },
  entry: "cafe",
  logic_nodes: [
    {
      id: "cafe",
      title: "靠窗的位置",
      scene: { background: "cafe", place: "咖啡馆", time: "夜", weather: "雨", mood: "紧绷" },
      speaker: "陈总",
      text: "他把你的杯子往你那边推了推：「明天的事，我听说了一点。」他没用「举报」两个字，像在说天气。",
      stance_goal: "neutral",
      observe: [{ key: "恐惧", value: 8 }],
      choices: [
        { label: "问他听说了什么", to: "probe", memory: { key: "试探", value: 6 } },
        { label: "说「那就别谈了」", to: "leave", memory: { key: "硬顶", value: 8 } },
      ],
    },
    {
      id: "probe",
      title: "他听说了多少",
      scene: { background: "cafe", place: "咖啡馆", time: "夜", weather: "雨", mood: "紧绷" },
      speaker: "陈总",
      text: "「你手里那份东西，」他停了一下，「有几页是复印件吧。复印的人，不一定只想帮你。」",
      stance_goal: "probe_blindspot",
      observe: [{ key: "被看穿", value: 8 }],
      choices: [
        { label: "承认还有别人", to: "ally", memory: { key: "同盟", value: 7 } },
        { label: "说「我一个人做的」", to: "alone", memory: { key: "孤军", value: 8 } },
      ],
    },
    {
      id: "leave",
      title: "站起来",
      scene: { background: "cafe", place: "咖啡馆门口", time: "夜", weather: "雨", mood: "紧绷" },
      speaker: "陈总",
      text: "「坐下。」他还是没抬头，「你走出去，明天签的字就只是你一个人的事。」",
      stance_goal: "counter_bluff",
      observe: [{ key: "被按住", value: 7 }],
      choices: [
        { label: "坐回去，听他讲完", to: "probe", memory: { key: "试探", value: 6 } },
        { label: "推门走进雨里", to: "rain", memory: { key: "孤军", value: 9 } },
      ],
    },
    {
      id: "ally",
      title: "复印件的人",
      scene: { background: "street", place: "街口", time: "夜", weather: "雨", mood: "安静" },
      speaker: "陈总",
      text: "他报了一个名字，是你部门里最不可能的人。「你以为你在举报我，」他说，「其实有人在用你。」",
      stance_goal: "skeptical_push",
      observe: [{ key: "被利用", value: 8 }],
      choices: [
        { label: "回去核实这个名字", to: "verify", memory: { key: "核实", value: 7 } },
        { label: "不管，明天照签", to: "sign", memory: { key: "硬顶", value: 9 } },
      ],
    },
    {
      id: "alone",
      title: "一个人做的",
      scene: { background: "cafe", place: "咖啡馆", time: "夜", weather: "雨", mood: "紧绷" },
      speaker: "陈总",
      text: "「好。」他点点头，第一次看你，「那我明天也只对付你一个人。」他把咖啡钱压在杯底。",
      stance_goal: "rupture",
      observe: [{ key: "孤军", value: 9 }],
      choices: [
        { label: "把证据留在桌上", to: "sign", memory: { key: "摊牌", value: 8 } },
        { label: "收回包，先走", to: "rain", memory: { key: "退半步", value: 6 } },
      ],
    },
    {
      id: "verify",
      title: "核实",
      scene: { background: "home", place: "出租屋", time: "凌晨", weather: "雨", mood: "安静" },
      speaker: "旁白",
      text: "你把复印件一页页摊在床上，对着灯看水印。第三页的边角，有一道你不认识的订书钉印。",
      stance_goal: "probe_blindspot",
      observe: [{ key: "核实", value: 8 }],
      choices: [],
    },
    {
      id: "sign",
      title: "早上九点",
      scene: { background: "street", place: "纪检门口", time: "清晨", weather: "晴", mood: "安静" },
      speaker: "旁白",
      text: "你把笔帽咬在嘴里，签下名字。风把举报信的一角掀起来，又落回去。",
      stance_goal: "empathetic",
      observe: [{ key: "签字", value: 9 }],
      choices: [],
    },
    {
      id: "rain",
      title: "雨里",
      scene: { background: "street", place: "街口", time: "夜", weather: "雨", mood: "疏离" },
      speaker: "旁白",
      text: "雨把路灯拉成一条一条。你走了两条街，才发现包还抱在胸前，拉链一直没拉。",
      stance_goal: "rupture",
      observe: [{ key: "退半步", value: 8 }],
      choices: [],
    },
  ],
};

export const SPEC_NATURAL: WorldSpec = {
  spec_version: "1.0",
  id: "natural-after-school",
  title: "放学后的窗边",
  subtitle: "自然交互 · 黄昏教室",
  logline: "她约你放学后留在教室，手里捏着一封没有署名的信。",
  ui: { palette: "cream", accent: "rose" },
  assets_manifest: {
    cover: backdrop("/mirai/cover-window.webp"),
    backgrounds: {
      classroom: backdrop("/mirai/04-world.webp"),
      window: backdrop("/mirai/01-cover.webp"),
      night: backdrop("/mirai/08-closing.webp"),
    },
    portraits: {
      linxia: portrait("/mirai/linxia.webp"),
      selene: portrait("/mirai/selene.webp"),
    },
  },
  cast: [
    { id: "linxia", name: "林夏", role: "你", traits: "把话在嘴里过了三遍才敢说", portrait: "linxia" },
    { id: "selene", name: "Selene", role: "同班同学", traits: "看起来什么都懂，唯独不说自己的事", portrait: "selene" },
  ],
  state_injection: {
    prior_memories: [
      { key: "想靠近", value: 6 },
      { key: "怕被拒绝", value: 6 },
    ],
    stance_bias: { empathetic: 0.35, neutral: 0.3 },
    temperature: 0.7,
  },
  entry: "window",
  logic_nodes: [
    {
      id: "window",
      title: "窗边",
      scene: { background: "window", place: "教室窗边", time: "黄昏", weather: "晴", mood: "安静" },
      speaker: "Selene",
      text: "教室里只剩你们两个。她把信折成很小的一块，捏在指尖，眼睛却看着窗外的操场。",
      stance_goal: "neutral",
      observe: [{ key: "想靠近", value: 6 }],
      choices: [
        { label: "叫住她，问她手里拿着什么", to: "call", memory: { key: "主动", value: 7 } },
        { label: "先坐下，等她自己开口", to: "wait", memory: { key: "耐心", value: 6 } },
      ],
    },
    {
      id: "call",
      title: "叫住她",
      scene: { background: "classroom", place: "教室", time: "黄昏", weather: "晴", mood: "安静" },
      speaker: "Selene",
      text: "她把手往身后藏了一下，又慢慢拿出来。「你是真的想知道，还是只是随口问？」",
      stance_goal: "probe_blindspot",
      observe: [{ key: "被看穿", value: 7 }],
      choices: [
        { label: "说「我真的想知道」", to: "letter", memory: { key: "坦白", value: 8 } },
        { label: "说「随口问问」", to: "retreat", memory: { key: "退缩", value: 6 } },
      ],
    },
    {
      id: "wait",
      title: "等她开口",
      scene: { background: "classroom", place: "教室", time: "黄昏", weather: "晴", mood: "安静" },
      speaker: "Selene",
      text: "你坐下之后，她反而更不知道该怎么说。窗外的光从她手背上移开，信的一角露了出来。",
      stance_goal: "empathetic",
      observe: [{ key: "耐心", value: 7 }],
      choices: [
        { label: "把她手里的信接过来", to: "letter", memory: { key: "靠近", value: 8 } },
        { label: "说「不急，明天也行」", to: "retreat", memory: { key: "退半步", value: 6 } },
      ],
    },
    {
      id: "letter",
      title: "信",
      scene: { background: "night", place: "空教室", time: "夜", weather: "晴", mood: "温柔" },
      speaker: "Selene",
      text: "信里只有一句话：「如果你也有一点想留下来，明天放学别走。」她一直没抬头。",
      stance_goal: "empathetic",
      observe: [{ key: "被回应", value: 9 }],
      choices: [],
    },
    {
      id: "retreat",
      title: "把话留到明天",
      scene: { background: "classroom", place: "教室门口", time: "黄昏", weather: "晴", mood: "疏离" },
      speaker: "Selene",
      text: "她点点头，把信收回口袋，说「嗯，明天也行」。你们一前一后走出教室，谁都没有再提。",
      stance_goal: "rupture",
      observe: [{ key: "没说出口", value: 9 }],
      choices: [],
    },
  ],
};

/**
 * 旗舰路演演示剧本：专为现场演示与发布片打造。
 * 每次点击都会实时切换立绘表情（calm / tense / warm）、对手角色（陈总）与场景光影（雨夜陆家嘴 ↔ 清晨青岛海岸）。
 */
export const SPEC_DEMO_SHOWCASE: WorldSpec = {
  spec_version: "1.0",
  id: "last-call-demo",
  title: "最后一通电话",
  subtitle: "雨夜陆家嘴 · 清晨海岸线（演示专场）",
  logline: "合同签字截止前两小时，陈总在落地窗对面等你，而母亲在电话那头停顿了半拍。",
  ui: { palette: "noir", accent: "teal" },
  assets_manifest: {
    cover: backdrop("/mirai/demo_bg_rain_cafe.webp"),
    backgrounds: {
      rain_cafe: backdrop("/mirai/demo_bg_rain_cafe.webp"),
      dawn_coast: backdrop("/mirai/demo_bg_dawn_coast.webp"),
    },
    portraits: {
      linxia: {
        base: "/mirai/demo_linxia_calm.webp",
        emotions: {
          neutral: "/mirai/demo_linxia_calm.webp",
          warm: "/mirai/demo_linxia_warm.webp",
          cold: "/mirai/demo_linxia_tense.webp",
          tense: "/mirai/demo_linxia_tense.webp",
          broken: "/mirai/demo_linxia_tense.webp",
        },
      },
      chen: portrait("/mirai/demo_chen_exec.webp"),
    },
  },
  cast: [
    { id: "linxia", name: "林夏", role: "你", traits: "冷静敏感，听得出语气里的停顿", portrait: "linxia" },
    { id: "chen", name: "陈总", role: "面试官", traits: "克制犀利，习惯用期限施压", portrait: "chen" },
  ],
  state_injection: {
    prior_memories: [
      { key: "职业野心", value: 7 },
      { key: "牵挂家人", value: 6 },
    ],
    stance_bias: { probe_blindspot: 0.45, neutral: 0.35 },
    temperature: 0.65,
  },
  entry: "cafe_open",
  logic_nodes: [
    {
      id: "cafe_open",
      title: "雨夜落地窗",
      scene: { background: "rain_cafe", place: "陆家嘴咖啡馆", time: "深夜", weather: "雨", mood: "安静" },
      speaker: "林夏",
      text: "雨点敲在四十二楼的玻璃窗上，合同就压在咖啡杯下，陈总正等着你今晚给出最终答复。",
      stance_goal: "neutral",
      observe: [{ key: "决断压力", value: 6 }],
      choices: [
        { label: "直视陈总，问他为什么非要今晚签字", to: "chen_push", memory: { key: "正面交锋", value: 8 } },
        { label: "先放下笔，给青岛的母亲拨通电话", to: "phone_tense", memory: { key: "牵挂", value: 7 } },
      ],
    },
    {
      id: "chen_push",
      title: "期限博弈",
      scene: { background: "rain_cafe", place: "陆家嘴咖啡馆", time: "深夜", weather: "雨", mood: "紧绷" },
      speaker: "陈总",
      text: "陈总合上文件夹，语气平静却步步紧逼：「位置只留到今晚十二点，你确定要为了不确定性放弃这里？」",
      stance_goal: "counter_bluff",
      observe: [{ key: "被施压", value: 8 }],
      choices: [
        { label: "「我去上海，但入职条款按我的时间来。」", to: "dawn_accept", memory: { key: "主动权", value: 9 } },
        { label: "「我今晚不签——有些事比截止时间更重要。」", to: "dawn_coast", memory: { key: "守住边界", value: 9 } },
      ],
    },
    {
      id: "phone_tense",
      title: "半拍停顿",
      scene: { background: "rain_cafe", place: "走廊窗边", time: "深夜", weather: "雨", mood: "紧绷" },
      speaker: "林夏",
      text: "电话接通三秒，母亲抢先笑着说「我很好」，可声音里那半拍发虚的停顿还是被你听了出来。",
      stance_goal: "probe_blindspot",
      observe: [{ key: "听出隐瞒", value: 9 }],
      choices: [
        { label: "轻声拆穿她的停顿，问出周三复查的真实结果", to: "dawn_coast", memory: { key: "说出真话", value: 9 } },
        { label: "先安抚好她，转身回桌与陈总谈延迟入职", to: "chen_push", memory: { key: "双线博弈", value: 8 } },
      ],
    },
    {
      id: "dawn_accept",
      title: "带着条件出发",
      scene: { background: "dawn_coast", place: "清晨海岸", time: "清晨", weather: "晴", mood: "温柔" },
      speaker: "林夏",
      text: "天亮时雨雾散尽，你带着自己谈下来的条件去往上海，也把随时回家的车票留在了最上层。",
      stance_goal: "empathetic",
      observe: [{ key: "坦然出发", value: 9 }],
      choices: [],
    },
    {
      id: "dawn_coast",
      title: "把选择权拿回来",
      scene: { background: "dawn_coast", place: "青岛海滨", time: "清晨", weather: "晴", mood: "温柔" },
      speaker: "林夏",
      text: "清晨的海岸线亮成一片金色，你没有被任何期限推着走——这一次，未来真正属于你自己。",
      stance_goal: "empathetic",
      observe: [{ key: "自我掌控", value: 10 }],
      choices: [],
    },
  ],
};

export const SPEC_SAMPLES: WorldSpec[] = [SPEC_DEMO_SHOWCASE, SPEC_NATURAL, SPEC_ROOM, SPEC_PARTNER, SPEC_WHISTLE];
