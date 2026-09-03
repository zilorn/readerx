/**
 * 书籍 mock 数据与正文生成器（当前无后端，先用本地数据演示）。
 * 后续接入真实书源/后端时，替换该文件即可。
 */

export interface Book {
  id: string;
  title: string;
  author: string;
  category: string;
  tags: string[];
  intro: string;
  /** 总字数（单位：万字） */
  wordCount: number;
  rating: number;
  status: "连载" | "完结";
  /** 章节总数 */
  chapters: number;
  /** 封面渐变基准色相 0-360 */
  hue: number;
}

export const BOOKS: Book[] = [
  { id: "b01", title: "星穹之下", author: "陆离", category: "科幻", tags: ["星际", "硬核"], intro: "地球失联三百年后，一艘返回舱带着陌生信号降落，重启了人类仰望星空的漫长远征。", wordCount: 186.4, rating: 9.2, status: "连载", chapters: 148, hue: 252 },
  { id: "b02", title: "山河入梦", author: "顾云深", category: "历史", tags: ["架空", "权谋"], intro: "一介寒门书生卷入庙堂风云，在王朝倾覆的前夜，他选择了最难的那条路。", wordCount: 96.8, rating: 8.7, status: "完结", chapters: 102, hue: 16 },
  { id: "b03", title: "第七封印", author: "苏夜白", category: "悬疑", tags: ["推理", "刑侦"], intro: "老刑警在退休前收到第七封空白信笺，尘封二十年的旧案随之再次泛起涟漪。", wordCount: 63.2, rating: 8.9, status: "完结", chapters: 76, hue: 200 },
  { id: "b04", title: "春风渡", author: "沈清辞", category: "言情", tags: ["甜宠", "都市"], intro: "时装设计师与冷淡律师因一场乌龙相亲相识，此后每个春天都有人比花先开。", wordCount: 45.6, rating: 8.1, status: "连载", chapters: 88, hue: 330 },
  { id: "b05", title: "万古丹帝", author: "秦陌", category: "玄幻", tags: ["炼丹", "升级"], intro: "丹道没落三千载，少年携一卷残经从边城走出，要重铸丹帝之名。", wordCount: 412.7, rating: 8.3, status: "连载", chapters: 312, hue: 95 },
  { id: "b06", title: "寒门首辅", author: "周怀瑾", category: "历史", tags: ["科举", "官场"], intro: "从落第书生到入阁首辅，他用了二十年，也等了一个王朝二十年。", wordCount: 158.9, rating: 9.0, status: "完结", chapters: 126, hue: 36 },
  { id: "b07", title: "虚拟王朝", author: "林晚星", category: "科幻", tags: ["近未来", "网游"], intro: "全民接入《虚拟王朝》的那天，游戏里的 NPC 开始声称自己拥有记忆。", wordCount: 121.3, rating: 8.6, status: "连载", chapters: 134, hue: 190 },
  { id: "b08", title: "午夜图书馆", author: "韩秋水", category: "悬疑", tags: ["都市传说", "灵异"], intro: "只在午夜开门的小图书馆，每一本书的扉页都写着借阅者的秘密。", wordCount: 52.1, rating: 8.8, status: "完结", chapters: 64, hue: 270 },
  { id: "b09", title: "长街与旧梦", author: "纪安宁", category: "言情", tags: ["青春", "治愈"], intro: "老街拆迁前夜，她收到一封来自十年前的信，寄信人写的是自己的名字。", wordCount: 38.4, rating: 8.4, status: "完结", chapters: 52, hue: 12 },
  { id: "b10", title: "兽潮纪元", author: "姜野", category: "玄幻", tags: ["末日", "热血"], intro: "异兽潮水般涌来，人类退守最后的九座城。少年站在城墙上，握紧了锈刀。", wordCount: 276.5, rating: 8.5, status: "连载", chapters: 198, hue: 24 },
  { id: "b11", title: "白夜追凶手册", author: "陈默", category: "悬疑", tags: ["罪案", "法医"], intro: "法医实习生捡到一本手写笔记，上面的每一起案件都比卷宗多写了一个结局。", wordCount: 71.9, rating: 9.1, status: "连载", chapters: 96, hue: 214 },
  { id: "b12", title: "时光邮差", author: "许轻轻", category: "都市", tags: ["奇幻", "温情"], intro: "新入职的邮差发现，自己投递的信件可以寄往任何一个过去的日子。", wordCount: 29.6, rating: 8.2, status: "完结", chapters: 44, hue: 150 },
];

export const CATEGORIES: string[] = [
  "全部",
  ...Array.from(new Set(BOOKS.map((b) => b.category))),
];

export function getBook(id: string): Book | undefined {
  return BOOKS.find((b) => b.id === id);
}

export function formatWords(wordCount: number): string {
  return `${wordCount}万字`;
}

// ---------------------------------------------------------------------------
// 正文生成：无后端阶段用确定性伪随机文本撑起阅读页

/** 简单可复现的哈希随机数（LCG） */
function hashSeed(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}

function lcg(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223;
    return (state >>> 0) / 4294967296;
  };
}

const SENTENCES = [
  "夜色像一层薄墨，缓缓漫过窗棂，把室内的灯光压得低低的。",
  "风声掠过檐角，听久了，竟像有人在很远的地方低声说着什么。",
  "他站在原地没有动，仿佛只要不动，时间也会跟着停下来。",
  "记忆里的那条路比现在宽，也比现在安静，安静得能听见自己的心跳。",
  "桌上摊开的那一页纸，边缘微微卷起，像是被谁反复读过。",
  "她忽然想起很多年前的那个下午，阳光也是这样斜斜地落下来。",
  "窗外的人群来来往往，没有谁为某一扇窗多停留片刻。",
  "话到嘴边又咽了回去，有些事说出来是轻的，压在心上却是重的。",
  "旧钟敲过十一下，屋里的空气仿佛也跟着颤了颤。",
  "他合上眼，那些散落的线索像退潮后的沙粒，一颗一颗地清晰起来。",
  "街道两旁的灯一盏接一盏亮起来，把影子拉得忽长忽短。",
  "答案也许一直就在眼前，只是它换了一个让人认不出的样子。",
  "雨不知什么时候停了，空气里有泥土和青草的气息。",
  "她写下最后一笔，停住，抬头看了一眼窗外的天空。",
  "有些决定做出的时候毫无声息，却在后来改变了许多人的方向。",
  "他数着脚下的台阶，一级、两级，仿佛数清了就能走到对岸。",
  "书页翻动的声音在寂静里格外清晰，像谁在轻轻叩门。",
  "远方传来若有若无的汽笛声，把夜晚又推远了一寸。",
  "她笑了笑，没有追问，有些答案等时间来说比较合适。",
  "灯光把两个人的影子叠在一起，又缓缓分开。",
  "他把那封信收进抽屉最深处，像收进一段不必言说的旧事。",
  "晨光爬上窗台的时候，昨夜的种种都像一场模糊的梦。",
  "所谓转折，往往藏在一个最不起眼的细节里。",
  "他抬起头，发现天空的颜色和很多年前那一夜一模一样。",
];

const CHAPTER_NAMES = [
  "初见", "风声", "旧事", "岔路", "暗流", "回声", "灯下", "远行",
  "谜底", "错过", "重逢", "长夜", "晨光", "约定", "裂痕", "抉择",
  "来客", "潮汐", "空白", "归途", "转折", "答案", "余温", "启程",
];

/** 生成某章标题 */
export function chapterTitle(book: Book, index: number): string {
  const name = CHAPTER_NAMES[(hashSeed(book.id, index) >> 3) % CHAPTER_NAMES.length];
  return `第${index + 1}章 · ${name}`;
}

/** 生成某章正文段落 */
export function chapterParagraphs(book: Book, index: number): string[] {
  const rand = lcg(hashSeed(book.id, "ch", index));
  const paraCount = 7 + Math.floor(rand() * 5);
  const paras: string[] = [];
  for (let i = 0; i < paraCount; i++) {
    const sentenceCount = 3 + Math.floor(rand() * 3);
    const parts: string[] = [];
    for (let j = 0; j < sentenceCount; j++) {
      const pick = Math.floor(rand() * SENTENCES.length);
      parts.push(SENTENCES[pick]);
    }
    paras.push(parts.join(""));
  }
  return paras;
}
