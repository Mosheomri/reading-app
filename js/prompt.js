/* The AI prompt template. Kept in one place so it is easy to tune.
   Exposes window.buildPrompt (the whole lesson, for copy-paste) and, for the automatic flow with Gemini,
   window.buildStoryPrompt and window.buildExercisesPrompt (the same lesson in two calls). */
(function () {
  'use strict';

  // Schema example shown to the AI (section 5). No nikud and no nikudMode:
  // the teacher adds nikud with Dicta, and the display mode is chosen in the app.
  // One example per exercise type; the prompt shows only the chosen types.
  var EXAMPLES = {
    mcq: { type: 'mcq', question: 'שאלה?', options: ['אפשרות א', 'אפשרות ב', 'אפשרות ג'], answer: 0 },
    tf: { type: 'tf', statement: 'משפט על הסיפור.', answer: true },
    fill: { type: 'fill', sentence: 'משפט עם ___ חסרה.', options: ['מילה', 'אחרת', 'שלישית'], answer: 0 },
    order: { type: 'order', sentences: ['משפט ראשון', 'משפט שני', 'משפט שלישי', 'משפט רביעי'] },
    open: { type: 'open', question: 'שאלה פתוחה?', sampleAnswer: 'תשובה לדוגמה במשפט אחד או שניים.' },
    locate: { type: 'locate', question: 'שאלה שהתשובה עליה כתובה במשפט אחד בסיפור?', sentence: 'המשפט מהסיפור, מילה במילה.' },
    message: {
      mcq: { type: 'message',
        visible: { question: 'שאלה על מה שכתוב בסיפור?', options: ['אפשרות א', 'אפשרות ב', 'אפשרות ג'], answer: 0 },
        hidden: { question: 'שאלה על מה שהסיפור מלמד?', options: ['אפשרות א', 'אפשרות ב', 'אפשרות ג'], answer: 1 } },
      open: { type: 'message',
        visible: { question: 'שאלה על מה שכתוב בסיפור?', sampleAnswer: 'תשובה לדוגמה.' },
        hidden: { question: 'שאלה על מה שהסיפור מלמד?', sampleAnswer: 'תשובה לדוגמה.' } }
    }
  };

  function storyExample() {
    return {
      title: 'כותרת',
      topic: 'הנושא',
      targetWords: [
        { word: 'מילה', emoji: '🙂' }
      ],
      story: 'הסיפור המלא.\nפסקה חדשה אחרי שורה חדשה.'
    };
  }

  function exercisesExample(counts, messageStyle) {
    return window.Levels.TYPES.filter(function (t) { return counts[t.id] > 0; }).map(function (t) {
      return t.id === 'message' ? EXAMPLES.message[messageStyle] : EXAMPLES[t.id];
    });
  }

  function schemaExample(counts, messageStyle) {
    return Object.assign({ version: 1 }, storyExample(), { exercises: exercisesExample(counts, messageStyle) });
  }

  // "3 שאלות" / "שאלה אחת": n with the noun (singular for one).
  function many(n, one, plural) { return n === 1 ? one : n + ' ' + plural; }

  // The prompt lines about the exercises, from the counts the teacher chose.
  function exerciseLines(counts, level) {
    var lines = [];
    var c = function (id) { return counts[id] || 0; };
    if (c('mcq')) lines.push('- ' + many(c('mcq'), 'שאלת הבנה אמריקאית אחת', 'שאלות הבנה אמריקאיות') + ' (3 אפשרויות כל אחת). ' + level.questions);
    if (c('tf')) lines.push('- ' + many(c('tf'), 'משפט נכון/לא נכון אחד', 'משפטי נכון/לא נכון') + '.');
    if (c('fill')) lines.push('- ' + many(c('fill'), 'משפט אחד', 'משפטים') + ' להשלמת מילה חסרה (סמן את החסר ב-___), עם 3 אפשרויות.');
    if (c('order')) lines.push('- ' + many(c('order'), 'תרגיל סידור אחד', 'תרגילי סידור') + ': 4 משפטים מהסיפור, בסדר הנכון.');
    if (c('open')) lines.push('- ' + many(c('open'), 'שאלה פתוחה אחת', 'שאלות פתוחות') +
      ': שאלה שהתשובה עליה היא משפט או שניים, לא מילה אחת. בשדה sampleAnswer כתוב תשובה לדוגמה קצרה.');
    if (c('locate')) lines.push('- ' + many(c('locate'), 'שאלת איתור מידע אחת', 'שאלות איתור מידע') +
      ': שאלה שהתשובה עליה כתובה במשפט אחד בסיפור. בשדה sentence העתק את המשפט הזה מהסיפור מילה במילה, בדיוק כפי שהוא כתוב בו.');
    if (c('message')) {
      lines.push('- ' + many(c('message'), 'תרגיל אחד', 'תרגילים') + ' של מסר גלוי ומסר סמוי, בשני חלקים: ' +
        'visible: שאלה על המסר הגלוי, מה שכתוב בסיפור במפורש; hidden: שאלה על המסר הסמוי, מה שהסיפור מלמד אותנו גם אם זה לא כתוב בו.');
      lines.push(level.messageStyle === 'open'
        ? '  כל חלק הוא שאלה פתוחה, עם תשובה לדוגמה קצרה בשדה sampleAnswer.'
        : '  כל חלק הוא שאלה אמריקאית עם 3 אפשרויות (options), ובשדה answer מספר האפשרות הנכונה.');
    }
    if (c('mcq') || c('fill') || (c('message') && level.messageStyle !== 'open')) {
      lines.push('- בשדה answer: מספר האפשרות הנכונה, כשהאפשרות הראשונה היא 0.');
    }
    return lines;
  }

  // AIs follow paragraph/sentence counts better than word counts.
  // Words per sentence comes from the reading level (js/levels.js).
  var SENTENCES_PER_PARAGRAPH = 4;

  function levelOf(id) {
    return window.Levels.get(id) || window.Levels.get(window.Levels.DEFAULT);
  }

  // e.g. 128 words at level ג׳–ד׳ (8 words per sentence) → "4 פסקאות, בכל פסקה 4 משפטים, סך הכול בערך 128 מילים"
  function storyShape(length, levelId) {
    var sentences = Math.max(2, Math.round(length / levelOf(levelId).wordsPerSentence));
    var paragraphs = Math.max(1, Math.round(sentences / SENTENCES_PER_PARAGRAPH));
    var perParagraph = Math.max(1, Math.round(sentences / paragraphs));
    var total = ', סך הכול בערך ' + length + ' מילים';
    if (paragraphs === 1) return 'פסקה אחת, עם ' + perParagraph + ' משפטים' + total;
    return paragraphs + ' פסקאות, בכל פסקה ' + perParagraph + ' משפטים' + total;
  }

  var INTRO = 'אתה כותב תוכן ללימוד קריאה לילד בהוראה מותאמת.';
  // Rules for every text the AI writes (story and exercises).
  var NO_NIKUD = '- כתוב את כל הטקסט בלי ניקוד בכלל: הכותרת, הסיפור, המילים, השאלות והתשובות.';
  var KTIV = '- כתוב בכתיב מלא תקני, כמו בטקסט רגיל בלי ניקוד (למשל שישי ולא ששי, בוקר ולא בקר).';
  var NO_EMOJI = '- אל תכניס אימוג׳י לסיפור, לכותרת או לתרגילים. אימוג׳י מופיעים רק בשדה emoji של מילות היעד.';

  function countsOf(settings, level) {
    return settings.exercises || window.Levels.exerciseDefaults(level.id);
  }

  // The story part of the prompt: topic, level, length, target words and the language rules.
  function storyLines(settings, level) {
    var lines = [
      INTRO,
      '',
      'כתוב סיפור קצר בעברית בנושא: ' + settings.topic,
      'רמת קריאה: ' + level.label + '.',
      'אורך הסיפור: ' + storyShape(settings.length, level.id) + '.'
    ];
    if (settings.wordsMode === 'list') {
      lines.push('מילות היעד: ' + settings.words.join(', ') + '. כל מילת יעד חייבת להופיע בסיפור לפחות פעמיים.');
    } else {
      lines.push('בחר ' + settings.wordCount + ' מילות יעד פשוטות ומוחשיות שקשורות לנושא. כל מילה חייבת להופיע בסיפור לפחות פעמיים.');
    }
    lines.push(
      '',
      'הנחיות לסיפור:',
      '- שפה של ילדים, מותאמת לרמת הקריאה.',
      '- ' + level.sentence
    );
    level.language.forEach(function (l) { lines.push('- ' + l); });
    lines.push(NO_NIKUD, KTIV, '- לכל מילת יעד הוסף אימוג׳י אחד שמתאר אותה.', NO_EMOJI);
    return lines;
  }

  // settings: {topic, length, level, wordsMode: 'number'|'list', wordCount, words: [],
  //            exercises: {mcq: n, tf: n, ...} (optional: the level's defaults)}
  function buildPrompt(settings) {
    var level = levelOf(settings.level);
    var counts = countsOf(settings, level);
    var lines = storyLines(settings, level);
    lines.push('', 'תרגילים (בסדר הזה):');
    exerciseLines(counts, level).forEach(function (l) { lines.push(l); });
    lines.push(
      '',
      'החזר את ה-JSON בתוך בלוק קוד אחד (```json), בלי שום טקסט לפניו או אחריו, בדיוק במבנה הזה' +
        ' (בדוגמה תרגיל אחד מכל סוג; כתוב את מספר התרגילים שביקשתי):',
      JSON.stringify(schemaExample(counts, level.messageStyle), null, 2)
    );
    return lines.join('\n');
  }

  // First call of the automatic flow: the story and the target words only.
  function buildStoryPrompt(settings) {
    var lines = storyLines(settings, levelOf(settings.level));
    lines.push('', 'החזר JSON בדיוק במבנה הזה:', JSON.stringify(storyExample(), null, 2));
    return lines.join('\n');
  }

  // Second call: the exercises on the story the first call wrote ({title, targetWords, story}).
  function buildExercisesPrompt(settings, story) {
    var level = levelOf(settings.level);
    var counts = countsOf(settings, level);
    var lines = [
      INTRO,
      '',
      'זה סיפור לילד ברמת קריאה: ' + level.label + '.',
      'הכותרת: ' + story.title,
      'מילות היעד: ' + (story.targetWords || []).map(function (w) { return w.word; }).join(', '),
      '',
      'הסיפור:',
      '---',
      story.story,
      '---',
      '',
      'כתוב תרגילים על הסיפור הזה (בסדר הזה):'
    ];
    exerciseLines(counts, level).forEach(function (l) { lines.push(l); });
    lines.push(
      '',
      'הנחיות לתרגילים:',
      '- כל תרגיל מבוסס על מה שכתוב בסיפור. משפט שלוקחים מהסיפור מועתק מילה במילה.',
      '- שפה של ילדים, מותאמת לרמת הקריאה.',
      NO_NIKUD,
      KTIV,
      NO_EMOJI,
      '',
      'החזר JSON בדיוק במבנה הזה (בדוגמה תרגיל אחד מכל סוג; כתוב את מספר התרגילים שביקשתי):',
      JSON.stringify({ exercises: exercisesExample(counts, level.messageStyle) }, null, 2)
    );
    return lines.join('\n');
  }

  window.buildPrompt = buildPrompt;
  window.buildStoryPrompt = buildStoryPrompt;
  window.buildExercisesPrompt = buildExercisesPrompt;
  window.storyShape = storyShape;
})();
