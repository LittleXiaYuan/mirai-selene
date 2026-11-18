/**
 * 视觉 Codebook：资产工厂的 Prompt 库。
 *
 * 目标不是「一张好看的图」，而是「同一个世界里，十张切片看起来像同一天拍的」。
 * 所以饱和度、色温、光位、镜头高度、透视都被写成固定约束，
 * 情绪只改神态与光，不改画风。
 */

export const VISUAL_CODEBOOK = {
  render: "日系电影感动画，赛璐璐与厚涂混合，干净的线稿，细腻的皮肤质感",
  light: "单一主光位（左上 35°），柔和体积光，低对比阴影，统一 5200K 色温",
  color: "低饱和高级灰，主色不超过两种，暗部带一点同色系冷暖偏移",
  camera: "人眼高度 1.6m，50mm 等效镜头，轻微景深，背景不抢主体",
  ratio: {
    portrait: "2:3",
    background: "16:9",
    emotion: "2:3",
  },
};

export const NEGATIVE = [
  "文字",
  "水印",
  "logo",
  "多余手指",
  "畸形肢体",
  "双头",
  "塑料感",
  "过度锐化",
  "高饱和大红大绿",
  "强烈霓虹",
  "赛博朋克",
  "低清",
  "拼接痕迹",
].join("，");

const EMOTION_DIRECTION = {
  neutral: "表情收着，眼神平静，嘴角没有明显弧度",
  warm: "眼神放软，嘴角有一点点笑意，肩颈放松",
  cold: "眼神后退半步，唇线收紧，下眼睑有一点阴影",
  tense: "呼吸停在胸口，眉间轻皱，手指微微收紧",
  broken: "妆有点散，眼眶发红但没有泪，视线落空",
};

const BASE_STYLE = [
  VISUAL_CODEBOOK.render,
  VISUAL_CODEBOOK.light,
  VISUAL_CODEBOOK.color,
  VISUAL_CODEBOOK.camera,
].join("。");

export function portraitPrompt({ world, character, emotion }) {
  return [
    `角色立绘，半身像，${character.name}，${character.role}，${character.traits}`,
    EMOTION_DIRECTION[emotion] ?? EMOTION_DIRECTION.neutral,
    `世界：${world}`,
    "背景为纯色渐变，人物占画面 70%，头顶留白 8%",
    BASE_STYLE,
  ]
    .filter(Boolean)
    .join("。");
}

export function backgroundPrompt({ world, place, time, weather, mood, logline }) {
  return [
    `场景背景，无人物，${place}`,
    time ? `时间：${time}` : "",
    weather ? `天气：${weather}` : "",
    mood ? `气氛：${mood}` : "",
    logline ? `世界梗概：${logline}` : `世界：${world}`,
    "横向构图，纵深三点透视，前景有轻微遮挡，光源方向与立绘一致",
    BASE_STYLE,
  ]
    .filter(Boolean)
    .join("。");
}

/**
 * 从一份 Spec 推出整套资产任务单。
 * 立绘按 5 个情绪切片各出一张，背景按场景键去重。
 */
export function planAssetTasks(spec) {
  const tasks = [];
  const backgrounds = spec.assets_manifest?.backgrounds ?? {};
  const scenes = new Map();

  for (const node of spec.logic_nodes ?? []) {
    const key = node.scene?.background;
    if (!key || scenes.has(key)) continue;
    scenes.set(key, {
      key,
      place: node.scene?.place ?? key,
      time: node.scene?.time ?? "",
      weather: node.scene?.weather ?? "",
      mood: node.scene?.mood ?? "",
    });
  }

  for (const scene of scenes.values()) {
    tasks.push({
      id: `bg-${spec.id}-${scene.key}`,
      kind: "background",
      asset_key: scene.key,
      target: backgrounds[scene.key]?.path ?? `/mirai/generated/${spec.id}/${scene.key}.webp`,
      aspect: VISUAL_CODEBOOK.ratio.background,
      size: "1280x720",
      prompt: backgroundPrompt({
        world: spec.title,
        place: scene.place,
        time: scene.time,
        weather: scene.weather,
        mood: scene.mood,
        logline: spec.logline,
      }),
      negative: NEGATIVE,
    });
  }

  for (const member of spec.cast ?? []) {
    for (const emotion of Object.keys(EMOTION_DIRECTION)) {
      tasks.push({
        id: `portrait-${spec.id}-${member.id}-${emotion}`,
        kind: "portrait",
        asset_key: `${member.portrait}:${emotion}`,
        cast_id: member.id,
        emotion,
        target: `/mirai/generated/${spec.id}/${member.id}-${emotion}.webp`,
        aspect: VISUAL_CODEBOOK.ratio.portrait,
        size: "832x1216",
        prompt: portraitPrompt({ world: spec.title, character: member, emotion }),
        negative: NEGATIVE,
      });
    }
  }

  return tasks;
}
