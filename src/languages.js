// 対応言語と翻訳モデル(HuggingFace上のONNX変換済み Marian モデル)の定義。
//
// - whisper: Whisper の言語トークン(繁体字/簡体字は同じ 'zh')
// - post:    出力テキストの変換(OpenCC による簡体字⇄繁体字)
// - 翻訳モデルは「英語⇄各言語」しか無いため、英語を含まないペアは英語を経由して2段階で翻訳する(中継翻訳)。

export const LANGUAGES = {
  ja: { name: '日本語', native: '日本語', tts: 'ja-JP', flag: '🇯🇵', whisper: 'ja' },
  'zh-TW': { name: '中国語（台湾・繁体字）', native: '繁體中文', tts: 'zh-TW', flag: '🇹🇼', whisper: 'zh', post: 'cn2twp' },
  vi: { name: 'ベトナム語', native: 'Tiếng Việt', tts: 'vi-VN', flag: '🇻🇳', whisper: 'vi' },
  th: { name: 'タイ語', native: 'ไทย', tts: 'th-TH', flag: '🇹🇭', whisper: 'th' },
  en: { name: '英語', native: 'English', tts: 'en-US', flag: '🇺🇸', whisper: 'en' },
  zh: { name: '中国語（簡体字）', native: '简体中文', tts: 'zh-CN', flag: '🇨🇳', whisper: 'zh', post: 't2cn' },
  ko: { name: '韓国語', native: '한국어', tts: 'ko-KR', flag: '🇰🇷', whisper: 'ko' },
  fr: { name: 'フランス語', native: 'Français', tts: 'fr-FR', flag: '🇫🇷', whisper: 'fr' },
  de: { name: 'ドイツ語', native: 'Deutsch', tts: 'de-DE', flag: '🇩🇪', whisper: 'de' },
  es: { name: 'スペイン語', native: 'Español', tts: 'es-ES', flag: '🇪🇸', whisper: 'es' },
  it: { name: 'イタリア語', native: 'Italiano', tts: 'it-IT', flag: '🇮🇹', whisper: 'it' },
  id: { name: 'インドネシア語', native: 'Bahasa Indonesia', tts: 'id-ID', flag: '🇮🇩', whisper: 'id' },
  ru: { name: 'ロシア語', native: 'Русский', tts: 'ru-RU', flag: '🇷🇺', whisper: 'ru' },
  hi: { name: 'ヒンディー語', native: 'हिन्दी', tts: 'hi-IN', flag: '🇮🇳', whisper: 'hi' },
  ar: { name: 'アラビア語', native: 'العربية', tts: 'ar-SA', flag: '🇸🇦', whisper: 'ar' },
  nl: { name: 'オランダ語', native: 'Nederlands', tts: 'nl-NL', flag: '🇳🇱', whisper: 'nl' },
  sv: { name: 'スウェーデン語', native: 'Svenska', tts: 'sv-SE', flag: '🇸🇪', whisper: 'sv' },
  fi: { name: 'フィンランド語', native: 'Suomi', tts: 'fi-FI', flag: '🇫🇮', whisper: 'fi' },
  uk: { name: 'ウクライナ語', native: 'Українська', tts: 'uk-UA', flag: '🇺🇦', whisper: 'uk' },
  cs: { name: 'チェコ語', native: 'Čeština', tts: 'cs-CZ', flag: '🇨🇿', whisper: 'cs' },
  da: { name: 'デンマーク語', native: 'Dansk', tts: 'da-DK', flag: '🇩🇰', whisper: 'da' },
};

// 方向別モデル("src>dst")。サイズは q8 量子化後の概算(encoder+decoder)。
// 英語→タイ語、英語→韓国語 は実用品質の小型 ONNX モデルが存在しないため未定義(オンラインモードで対応)。
export const MT_MODELS = {
  'ja>en': { id: 'Xenova/opus-mt-ja-en', sizeMB: 110 },
  'en>ja': { id: 'Kadonox/fugumt-en-ja-onnx', sizeMB: 145 },
  'zh-TW>en': { id: 'Xenova/opus-mt-zh-en', sizeMB: 110 },
  'en>zh-TW': { id: 'Xenova/opus-mt-en-zh', sizeMB: 110 },
  'zh>en': { id: 'Xenova/opus-mt-zh-en', sizeMB: 110 },
  'en>zh': { id: 'Xenova/opus-mt-en-zh', sizeMB: 110 },
  'vi>en': { id: 'Xenova/opus-mt-vi-en', sizeMB: 110 },
  'en>vi': { id: 'Xenova/opus-mt-en-vi', sizeMB: 110 },
  'th>en': { id: 'Xenova/opus-mt-th-en', sizeMB: 110 },
  'ko>en': { id: 'Xenova/opus-mt-ko-en', sizeMB: 110 },
  'fr>en': { id: 'Xenova/opus-mt-fr-en', sizeMB: 110 },
  'en>fr': { id: 'Xenova/opus-mt-en-fr', sizeMB: 110 },
  'de>en': { id: 'Xenova/opus-mt-de-en', sizeMB: 110 },
  'en>de': { id: 'Xenova/opus-mt-en-de', sizeMB: 110 },
  'es>en': { id: 'Xenova/opus-mt-es-en', sizeMB: 110 },
  'en>es': { id: 'Xenova/opus-mt-en-es', sizeMB: 110 },
  'it>en': { id: 'Xenova/opus-mt-it-en', sizeMB: 110 },
  'en>it': { id: 'Xenova/opus-mt-en-it', sizeMB: 110 },
  'id>en': { id: 'Xenova/opus-mt-id-en', sizeMB: 110 },
  'en>id': { id: 'Xenova/opus-mt-en-id', sizeMB: 110 },
  'ru>en': { id: 'Xenova/opus-mt-ru-en', sizeMB: 110 },
  'en>ru': { id: 'Xenova/opus-mt-en-ru', sizeMB: 110 },
  'hi>en': { id: 'Xenova/opus-mt-hi-en', sizeMB: 110 },
  'en>hi': { id: 'Xenova/opus-mt-en-hi', sizeMB: 110 },
  'ar>en': { id: 'Xenova/opus-mt-ar-en', sizeMB: 110 },
  'en>ar': { id: 'Xenova/opus-mt-en-ar', sizeMB: 110 },
  'nl>en': { id: 'Xenova/opus-mt-nl-en', sizeMB: 110 },
  'en>nl': { id: 'Xenova/opus-mt-en-nl', sizeMB: 110 },
  'sv>en': { id: 'Xenova/opus-mt-sv-en', sizeMB: 110 },
  'en>sv': { id: 'Xenova/opus-mt-en-sv', sizeMB: 110 },
  'fi>en': { id: 'Xenova/opus-mt-fi-en', sizeMB: 110 },
  'en>fi': { id: 'Xenova/opus-mt-en-fi', sizeMB: 110 },
  'uk>en': { id: 'Xenova/opus-mt-uk-en', sizeMB: 110 },
  'en>uk': { id: 'Xenova/opus-mt-en-uk', sizeMB: 110 },
  'cs>en': { id: 'Xenova/opus-mt-cs-en', sizeMB: 110 },
  'en>cs': { id: 'Xenova/opus-mt-en-cs', sizeMB: 110 },
  'da>en': { id: 'Xenova/opus-mt-da-en', sizeMB: 110 },
  'en>da': { id: 'Xenova/opus-mt-en-da', sizeMB: 110 },
};

export const WHISPER_MODELS = {
  tiny: { id: 'onnx-community/whisper-tiny', sizeMB: 40, label: '音声認識モデル（小）' },
  base: { id: 'onnx-community/whisper-base', sizeMB: 75, label: '音声認識モデル（中）' },
  small: { id: 'onnx-community/whisper-small', sizeMB: 250, label: '音声認識モデル（大）' },
};

// 同じモデルIDを使う方向はキーを共有する(例: zh>en と zh-TW>en は同じモデル)
export const mtKey = (dir) => `mt:${MT_MODELS[dir].id}`;

function step(dir) {
  const m = MT_MODELS[dir];
  return { dir, key: mtKey(dir), id: m.id, sizeMB: m.sizeMB };
}

// src→dst の翻訳経路。直接モデルがあれば1段、無ければ英語を経由して2段。無理なら null。
export function routeFor(src, dst) {
  if (src === dst) return null;
  if (MT_MODELS[`${src}>${dst}`]) return [step(`${src}>${dst}`)];
  if (src !== 'en' && dst !== 'en' && MT_MODELS[`${src}>en`] && MT_MODELS[`en>${dst}`]) return [step(`${src}>en`), step(`en>${dst}`)];
  return null;
}

export const directionSupported = (src, dst) => !!routeFor(src, dst);

// 少なくとも一方向がオフライン翻訳できればペアとして扱える
export function pairSupported(a, b) {
  return a !== b && (directionSupported(a, b) || directionSupported(b, a));
}

// 指定ペアでオフライン動作に必要なモデル一覧(音声認識 + 両方向の翻訳経路上のモデル、重複なし)
export function requiredModels(a, b, whisperSize) {
  const w = WHISPER_MODELS[whisperSize];
  const list = [];
  if (w) list.push({ key: `whisper:${whisperSize}`, kind: 'whisper', id: w.id, sizeMB: w.sizeMB, label: w.label });
  const seen = new Set();
  for (const [src, dst] of [
    [a, b],
    [b, a],
  ]) {
    const route = routeFor(src, dst);
    if (!route) continue;
    for (const s of route) {
      if (seen.has(s.key)) continue;
      seen.add(s.key);
      const [ms, md] = s.dir.split('>');
      list.push({ key: s.key, kind: 'mt', id: s.id, sizeMB: s.sizeMB, label: `翻訳 ${LANGUAGES[ms].name} → ${LANGUAGES[md].name}` });
    }
  }
  return list;
}

// 設定画面向け: 全ての既知モデル(重複IDなし)
export function allKnownModels() {
  const out = [];
  for (const [k, v] of Object.entries(WHISPER_MODELS)) out.push({ key: `whisper:${k}`, id: v.id, label: v.label, sizeMB: v.sizeMB });
  const seen = new Set();
  for (const [dir, v] of Object.entries(MT_MODELS)) {
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    const [s, d] = dir.split('>');
    out.push({ key: `mt:${v.id}`, id: v.id, label: `翻訳 ${LANGUAGES[s].name} → ${LANGUAGES[d].name}`, sizeMB: v.sizeMB });
  }
  return out;
}

// 入力テキストから言語Aと言語Bのどちらかを判定する(オフライン用判定)
export function detectTextLang(text, langA, langB) {
  if (!text) return langA;

  function scoreForLang(code, str) {
    let score = 0;
    switch (code) {
      case 'ja':
        if (/[\u3040-\u309F\u30A0-\u30FF]/.test(str)) score += 10;
        if (/[\u4E00-\u9FFF]/.test(str)) score += 2;
        break;
      case 'ko':
        if (/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(str)) score += 10;
        break;
      case 'th':
        if (/[\u0E00-\u0E7F]/.test(str)) score += 10;
        break;
      case 'zh':
      case 'zh-TW':
        if (/[\u4E00-\u9FFF]/.test(str) && !/[\u3040-\u309F\u30A0-\u30FF]/.test(str)) score += 10;
        break;
      case 'vi':
        if (/[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ]/.test(str)) score += 10;
        else if (/[a-zA-Z]/.test(str)) score += 1;
        break;
      case 'ru':
      case 'uk':
        if (/[\u0400-\u04FF]/.test(str)) score += 10;
        break;
      case 'ar':
        if (/[\u0600-\u06FF]/.test(str)) score += 10;
        break;
      case 'hi':
        if (/[\u0900-\u097F]/.test(str)) score += 10;
        break;
      case 'en':
      case 'fr':
      case 'de':
      case 'es':
      case 'it':
      case 'id':
      case 'nl':
      case 'sv':
      case 'fi':
      case 'cs':
      case 'da':
        if (/[a-zA-Z]/.test(str)) score += 3;
        break;
      default:
        break;
    }
    return score;
  }

  const scoreA = scoreForLang(langA, text);
  const scoreB = scoreForLang(langB, text);

  if (scoreB > scoreA) return langB;
  return langA;
}
