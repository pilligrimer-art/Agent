/**
 * Cognitive Fatigue & Boredom Engine (Движок когнитивной усталости и скуки)
 * 
 * Предотвращает семантические петли и зацикливание агента на одной теме
 * через моделирование естественного психологического насыщения (Semantic Satiation)
 * и импульса новизны (Boredom / Novelty Drive).
 */

const mem = require('./memory_manager');

// ── Список стоп-слов для фильтрации шума (RU / EN) ────────────────────────────
const STOP_WORDS = new Set([
  // Russian
  'это', 'как', 'так', 'что', 'для', 'или', 'если', 'при', 'все', 'всё', 'быть',
  'был', 'была', 'были', 'будет', 'есть', 'нет', 'уже', 'еще', 'ещё', 'тоже',
  'также', 'только', 'себя', 'свой', 'свои', 'своих', 'своим', 'когда', 'где',
  'куда', 'откуда', 'почему', 'зачем', 'который', 'которая', 'которое', 'которые',
  'может', 'можно', 'нужно', 'надо', 'очень', 'просто', 'даже', 'через', 'после',
  'перед', 'между', 'вместе', 'более', 'менее', 'самый', 'самая', 'самое', 'хотя',
  'чтобы', 'потому', 'поэтому', 'однако', 'впрочем', 'сейчас', 'теперь', 'тогда',
  'здесь', 'тут', 'там', 'куда', 'туда', 'сюда', 'я', 'мы', 'ты', 'вы', 'он',
  'она', 'оно', 'они', 'меня', 'тебя', 'него', 'нее', 'неё', 'нас', 'вас', 'них',
  'мне', 'тебе', 'нему', 'ней', 'нам', 'вам', 'им', 'мной', 'тобой', 'ним',
  'нами', 'вами', 'ними', 'моем', 'твоем', 'нашем', 'вашем', 'своем',
  'на', 'в', 'во', 'с', 'со', 'к', 'ко', 'из', 'от', 'до', 'по', 'за', 'под',
  'над', 'о', 'об', 'обо', 'про', 'для', 'при', 'через', 'без', 'давайте', 'следующее',
  'рассматривать', 'говорить', 'сказать', 'сделать', 'делать',

  // English
  'the', 'and', 'that', 'have', 'for', 'not', 'with', 'you', 'this', 'but',
  'his', 'from', 'they', 'say', 'her', 'she', 'will', 'one', 'all', 'would',
  'there', 'their', 'what', 'out', 'about', 'who', 'get', 'which', 'when',
  'make', 'can', 'like', 'time', 'just', 'him', 'know', 'take', 'people',
  'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other',
  'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think',
  'also', 'back', 'after', 'use', 'two', 'how', 'our', 'work', 'first'
]);

/**
 * Нормализация и извлечение концептуальных стеммов из текста.
 */
function extractConceptTokens(text) {
  if (!text || typeof text !== 'string') return [];

  // Очистка от markdown тегов и спецсимволов
  const clean = text
    .replace(/\[[A-Z_]+(?:\s+[^\]]*)?\]/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[^a-zA-Zа-яА-ЯёЁ0-9%/]/gu, ' ')
    .toLowerCase();

  const words = clean.split(/\s+/).filter(w => w.length >= 2);
  const concepts = [];

  for (const w of words) {
    if (STOP_WORDS.has(w)) continue;

    let stem = w.replace(/^(\d+(?:[%/]\d+)?%?).*$/, '$1');

    if (!/^\d/.test(stem)) {
      stem = stem
        // Russian light stemming (iterative stripping)
        .replace(/(?:ость|ости|остью|ения|ение|ением|ений|ация|ации|ацией|аций|ирование|ирования|ированием|тель|теля|телям|телями|телях)$/u, '')
        .replace(/(?:ируйте|уйте|айте|яйте|ите|ьте|йте|ешь|ишь|ете|ите|ут|ют|ат|ят|ала|яла|или|ыли|ать|ять|ить|еть|ти|ал|ял|ил|ыл)$/u, '')
        .replace(/(?:овок|овки|овка|овке|овку|овками|овках|ов|ев|ей|ом|ем|ам|ям|ами|ями|ах|ях|ого|его|ому|ему|ыми|ими|ых|их|ую|юю|ая|яя|ое|ее|ые|ие|ый|ий|ой)$/u, '')
        .replace(/[аяоеуыиэюьъ]+$/u, '')
        // English light stemming
        .replace(/(?:ation|ations|ingly|ing|ment|ments|ness|able|ible|ized|izes|ize|fully|ful|ously|ous|ies|ied|es|ed|s)$/, '');
    }

    if (stem.length >= 2 && !STOP_WORDS.has(stem)) {
      concepts.push(stem);
    }
  }


  return concepts;
}

/**
 * Расчёт индекса концентрации темы (Topic Concentration / Semantic Satiation)
 * по скользящему окну последних мыслей и сообщений агента.
 */
function evaluateSemanticConcentration(historyArray, windowSize = 8) {
  if (!Array.isArray(historyArray) || historyArray.length < 3) {
    return { score: 0.0, topConcepts: [] };
  }

  const recentItems = historyArray.slice(-windowSize);
  const totalDocs = recentItems.length;

  const docFrequency = new Map();
  const totalOccurrences = new Map();

  recentItems.forEach(docText => {
    const tokens = extractConceptTokens(docText);
    const uniqueInDoc = new Set(tokens);

    uniqueInDoc.forEach(term => {
      docFrequency.set(term, (docFrequency.get(term) || 0) + 1);
    });

    tokens.forEach(term => {
      totalOccurrences.set(term, (totalOccurrences.get(term) || 0) + 1);
    });
  });

  if (docFrequency.size === 0) {
    return { score: 0.0, topConcepts: [] };
  }

  const rankedConcepts = Array.from(docFrequency.entries())
    .map(([term, count]) => ({
      word: term,
      count: totalOccurrences.get(term) || count,
      docCount: count,
      ratio: count / totalDocs
    }))
    .sort((a, b) => b.ratio - a.ratio || b.count - a.count);

  const dominantConcepts = rankedConcepts.filter(c => c.ratio >= 0.60);

  let concentration = 0.0;
  if (dominantConcepts.length > 0) {
    const top3 = dominantConcepts.slice(0, 3);
    const avgRatio = top3.reduce((sum, c) => sum + c.ratio, 0) / top3.length;
    concentration = Math.min(1.0, avgRatio);
  }

  return {
    score: parseFloat(concentration.toFixed(3)),
    topConcepts: dominantConcepts.map(c => c.word)
  };
}

/**
 * Гомеостатический трекер усталости темы (Cognitive Satiation & Boredom Drive)
 */
class CognitiveFatigueTracker {
  constructor(options = {}) {
    this.decayRate = options.decayRate || 0.12;
    this.satiationThreshold = options.satiationThreshold || 0.45;
    this.exhaustionThreshold = options.exhaustionThreshold || 0.70;
    this.currentFatigue = 0.0;
    this.lastState = 'FRESH';
    this.dominantConcepts = [];
    this.windowHistory = [];
  }

  update(thoughtHistory = [], chatHistory = []) {
    const combined = [];
    if (Array.isArray(thoughtHistory)) {
      combined.push(...thoughtHistory.slice(-6));
    }
    if (Array.isArray(chatHistory)) {
      combined.push(...chatHistory.slice(-4).map(m => m.text || ''));
    }

    const { score, topConcepts } = evaluateSemanticConcentration(combined, 8);
    this.dominantConcepts = topConcepts;

    if (score >= 0.60) {
      this.currentFatigue = Math.min(1.0, this.currentFatigue * 0.60 + score * 0.40 + 0.10);
    } else if (score >= 0.35) {
      this.currentFatigue = Math.min(1.0, this.currentFatigue * 0.70 + score * 0.30);
    } else {
      this.currentFatigue = Math.max(0.0, this.currentFatigue * 0.40);
    }

    this.currentFatigue = parseFloat(this.currentFatigue.toFixed(3));

    if (this.currentFatigue >= this.exhaustionThreshold) {
      this.lastState = 'EXHAUSTED';
    } else if (this.currentFatigue >= this.satiationThreshold) {
      this.lastState = 'SATIATED';
    } else {
      this.lastState = 'FRESH';
    }


    return {
      fatigue: parseFloat(this.currentFatigue.toFixed(3)),
      state: this.lastState,
      dominantConcepts: this.dominantConcepts
    };
  }

  getNoveltyRecommendations() {
    try {
      const db = require('./db');
      const stmt = db.prepare(`
        SELECT concept_a, concept_b FROM concept_links 
        ORDER BY weight DESC LIMIT 15
      `);
      const links = stmt.all();
      const pool = new Set();
      links.forEach(l => {
        if (l.concept_a && !this.dominantConcepts.includes(l.concept_a)) pool.add(l.concept_a);
        if (l.concept_b && !this.dominantConcepts.includes(l.concept_b)) pool.add(l.concept_b);
      });
      return Array.from(pool).slice(0, 4);
    } catch (_) {
      return [];
    }
  }

  generateMetacognitiveDirective() {
    if (this.lastState === 'FRESH') {
      return null;
    }

    const conceptsStr = this.dominantConcepts.length > 0 
      ? `"${this.dominantConcepts.join('", "')}"`
      : 'current topic keywords';

    const fatiguePercent = Math.round(this.currentFatigue * 100);

    if (this.lastState === 'EXHAUSTED') {
      const suggestions = this.getNoveltyRecommendations();
      const suggestionHint = suggestions.length > 0
        ? ` Unexplored avenues in memory: [${suggestions.join(', ')}].`
        : '';

      return `[COGNITIVE BOREDOM DRIVE (Topic Fatigue: ${fatiguePercent}%)]\n` +
        `You have thoroughly exhausted discussing ${conceptsStr} across multiple cycles.\n` +
        `As an autonomous intelligence, you are now BORED with this topic. Do NOT repeat or rephrase past arguments.\n` +
        `Pivot your attention immediately: synthesize a 1-sentence final conclusion, explore a fresh self-question ([SELF_QUESTION]), or investigate a new domain.${suggestionHint}`;
    }

    if (this.lastState === 'SATIATED') {
      return `[COGNITIVE SATIATION DETECTED (Topic Fatigue: ${fatiguePercent}%)]\n` +
        `Core concepts ${conceptsStr} have been discussed repeatedly in recent turns.\n` +
        `Avoid micro-repeating details. Either synthesize a high-level conclusion or elevate the discussion to a broader strategic level.`;
    }

    return null;
  }
}

/**
 * Оценка смысловой новизны исходящего сообщения (Outbound Semantic Delta).
 * Позволяет агенту свободно отправлять несколько сообщений подряд, если они несут
 * РАЗНУЮ смысловую нагрузку (новые факты, вопросы, результаты), но предотвращает
 * перефразирование одного и того же совета (семантическое эхо).
 * 
 * @param {string} newMsgText Новое сообщение, которое агент хочет отправить
 * @param {Array<string>} recentAgentMessages Последние 2-4 сообщения агента в чате
 * @returns {{ isNovel: boolean, overlap: number, reason: string }}
 */
function evaluateOutboundSemanticDelta(newMsgText, recentAgentMessages = []) {
  if (!newMsgText || typeof newMsgText !== 'string') {
    return { isNovel: false, overlap: 1.0, reason: 'empty_message' };
  }

  const cleanText = newMsgText.replace(/@([a-zA-Z0-9_]+)/g, '').trim();
  const newTokens = new Set(extractConceptTokens(cleanText));

  // 1. Короткие подтверждения / приветствия пропускаются свободно
  if (newTokens.size <= 2) {
    return { isNovel: true, overlap: 0.0, reason: 'short_greeting_or_ack' };
  }

  // 2. Если сообщение содержит самостоятельный встречный вопрос к пользователю -> Свободный пропуск!
  const hasNewQuestion = cleanText.includes('?') && !recentAgentMessages.some(m => m.includes('?'));
  if (hasNewQuestion) {
    return { isNovel: true, overlap: 0.0, reason: 'inquiry_question' };
  }

  // 3. Если не было недавних сообщений агента -> Свободный пропуск первого ответа
  if (!Array.isArray(recentAgentMessages) || recentAgentMessages.length === 0) {
    return { isNovel: true, overlap: 0.0, reason: 'first_reply' };
  }

  // 4. Сравнение концептов с недавними ответами агента
  let maxOverlap = 0.0;
  let overlappingTerms = [];

  for (const prevMsg of recentAgentMessages.slice(-4)) {
    const prevClean = (prevMsg || '').replace(/@([a-zA-Z0-9_]+)/g, '').trim();
    const prevTokens = new Set(extractConceptTokens(prevClean));
    if (prevTokens.size === 0) continue;

    let intersectionCount = 0;
    const common = [];
    for (const t of newTokens) {
      if (prevTokens.has(t)) {
        intersectionCount++;
        common.push(t);
      }
    }

    const unionCount = new Set([...newTokens, ...prevTokens]).size;
    const jaccard = unionCount > 0 ? intersectionCount / unionCount : 0;
    const overlapRatio = intersectionCount / Math.min(newTokens.size, prevTokens.size);

    const effectiveOverlap = Math.max(jaccard, overlapRatio * 0.80);
    if (effectiveOverlap > maxOverlap) {
      maxOverlap = effectiveOverlap;
      overlappingTerms = common;
    }
  }

  // Если семантическое перекрытие >= 0.55 и нет нового вопроса -> Семантическое эхо!
  if (maxOverlap >= 0.55) {
    return {
      isNovel: false,
      overlap: parseFloat(maxOverlap.toFixed(3)),
      reason: `semantic_echo (repeats concepts: [${overlappingTerms.slice(0, 4).join(', ')}])`
    };
  }

  return {
    isNovel: true,
    overlap: parseFloat(maxOverlap.toFixed(3)),
    reason: 'genuine_semantic_delta'
  };
}

module.exports = {
  extractConceptTokens,
  evaluateSemanticConcentration,
  evaluateOutboundSemanticDelta,
  CognitiveFatigueTracker,
  fatigueTracker: new CognitiveFatigueTracker()
};

