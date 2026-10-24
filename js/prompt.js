/* The AI prompt template. Kept in one place so it is easy to tune.
   Exposes window.buildPrompt (the whole lesson, for copy-paste) and, for the automatic flow with Gemini,
   window.buildStoryPrompt, window.buildEditPrompt and window.buildExercisesPrompt (the same lesson in three calls:
   a draft, an editor's rewrite of it, and the exercises). */
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

  function levelOf(id) {
    return window.Levels.get(id) || window.Levels.get(window.Levels.DEFAULT);
  }

  // How much the length may differ from what was asked (also the warning in Lesson.check and the editor's limit).
  var LENGTH_SLACK = 0.2;

  // e.g. 200 → "בערך 200 מילים. סטייה של עד 20% (בין 160 ל-240 מילים) מותרת."
  function storyShape(length) {
    return 'בערך ' + length + ' מילים. סטייה של עד ' + Math.round(LENGTH_SLACK * 100) + '% (בין ' +
      Math.round(length * (1 - LENGTH_SLACK)) + ' ל-' + Math.round(length * (1 + LENGTH_SLACK)) + ' מילים) מותרת.';
  }

  // The words for the kind of text, in the prompts.
  function noun(genre) {
    return window.Levels.genre(genre) === 'info'
      ? { a: 'טקסט מידעי קצר', the: 'הטקסט', text: 'טקסט', kind: 'טקסט מידעי' }
      : { a: 'סיפור קצר', the: 'הסיפור', text: 'סיפור', kind: 'סיפור' };
  }

  // Exercise lines speak of "the story"; for an informational text, "the text".
  function forGenre(line, genre) {
    return window.Levels.genre(genre) === 'info' ? line.replace(/סיפור/g, 'טקסט') : line;
  }

  var WRITER = 'אתה סופר ישראלי מנוסה לילדים, שכותב ספרים לקוראים מתחילים.';
  var EDITOR = 'אתה עורך ספרי ילדים מנוסה.';
  var INTRO = 'אתה כותב תוכן ללימוד קריאה לילד בהוראה מותאמת.';
  // Rules for every text the AI writes (story and exercises).
  var NO_NIKUD = '- כתוב את כל הטקסט בלי ניקוד בכלל: הכותרת, הסיפור, המילים, השאלות והתשובות.';
  var KTIV = '- כתוב בכתיב מלא תקני, כמו בטקסט רגיל בלי ניקוד (למשל שישי ולא ששי, בוקר ולא בקר).';
  var NO_EMOJI = '- אל תכניס אימוג׳י לסיפור, לכותרת או לתרגילים. אימוג׳י מופיעים רק בשדה emoji של מילות היעד.';
  var QUALITY = 'העיקרון: הטקסט צריך להיראות כאילו סופר מקצועי לילדים כתב אותו. כשיש התנגשות בין איכות לבין דרישה מספרית ' +
    '(אורך, מספר הופעות של מילה), האיכות קובעת.';
  var READ_ALOUD = 'לפני שאתה מחזיר את התשובה: קרא את הטקסט כאילו אתה מקריא אותו לילד, ותקן כל משפט שנשמע לא טבעי.';

  // The structure of each kind of text (writing and editing prompts).
  var GENRE_LINES = {
    story: [
      '- דמות מרכזית עם שם, שיש לה רצון או בעיה.',
      '- הדמות מנסה לפתור את הבעיה (ניסיון אחד או יותר), מגיעה לשיא, ובסוף יש פתרון.',
      '- התחלה, אמצע וסוף ברורים.',
      '- מקום וזמן עקביים לאורך כל הסיפור.',
      '- כל משפט מקדם את העלילה.',
      '- מותר ורצוי דיאלוג קצר.',
      '- זה סיפור בלבד: בלי פסקאות של מידע והסברים כמו בטקסט מידעי.'
    ],
    info: [
      '- נושא אחד.',
      '- משפט פתיחה שמציג את הנושא.',
      '- פסקה לכל תת-נושא.',
      '- משפט סיכום בסוף.',
      '- בלי עלילה ובלי דמויות בדיוניות.',
      '- זה טקסט מידעי בלבד: לא סיפור, וגם לא סיפור שמשולב בו מידע.'
    ]
  };

  // Language, level and paragraph rules (writing and editing prompts).
  function languageLines(level, genre) {
    var lines = [
      '- עברית טבעית, כמו בספרי ילדים ישראליים.',
      '- אורך משפטים מגוון, מילות קישור (ו, אבל, כי, אז, פתאום, כש-, ש-) ופסיקים, כך שהטקסט זורם ולא נשמע כמו רשימה.',
      '- בלי שפה ספרותית גבוהה, בלי ז׳רגון (של ספורט, מדע וכו׳), בלי צירופים שנשמעים כמו תרגום, ובלי משפטי מילוי שלא מקדמים את הטקסט.',
      '- ' + level.sentence
    ];
    window.Levels.textLines(level, genre).forEach(function (l) { lines.push('- ' + l); });
    lines.push('- מה לא לכתוב ברמה הזו:');
    level.avoid.forEach(function (l) { lines.push('  - ' + l); });
    lines.push('- פסקאות: 3 עד 6 משפטים בכל פסקה. ירידת שורה רק בין פסקאות, לא אחרי כל משפט.');
    return lines;
  }

  function countsOf(settings, level) {
    return settings.exercises || window.Levels.exerciseDefaults(level.id, settings.genre);
  }

  // The story part of the prompt: role, kind of text, topic, level, length, target words and the language rules.
  function storyLines(settings, level) {
    var genre = window.Levels.genre(settings.genre);
    var n = noun(genre);
    var lines = [
      WRITER,
      'כתוב ' + n.a + ' בעברית לילד שלומד לקרוא, בהוראה מותאמת.',
      QUALITY,
      '',
      'נושא: ' + settings.topic,
      'סוג הטקסט: ' + n.kind + '.',
      'רמת קריאה: ' + level.label + '.',
      'אורך: ' + storyShape(settings.length),
      '',
      genre === 'info' ? 'מבנה הטקסט המידעי:' : 'מבנה הסיפור:'
    ].concat(GENRE_LINES[genre], ['', 'מילות יעד:']);
    if (settings.wordsMode === 'list') {
      lines.push('- מילות היעד: ' + settings.words.join(', ') + '.');
    } else {
      lines.push('- בחר ' + settings.wordCount + ' מילות יעד פשוטות ומוחשיות, שמשתלבות ב' + n.text +
        ' באופן טבעי (לדוגמה: בסיפור על כדורגל, החפץ הוא "כדור", לא "כדורגל").');
    }
    lines.push(
      '- השתמש בכל מילה רק במשמעות הנכונה שלה, ובמקום שבו היא מתאימה באופן טבעי.',
      '- כל מילה מופיעה לפחות פעם אחת, ועדיף 2 עד 3 פעמים, אם זה טבעי.',
      '- אסור להמציא משפט או דמות רק כדי לשלב מילה.',
      '- לכל מילת יעד הוסף אימוג׳י אחד שמתאר אותה. רק אימוג׳י נפוץ וותיק שמוצג בכל מכשיר (כמו 🐶 🌳 ⚽ 🏠 🍎): ' +
        'בלי אימוג׳י חדשים, בלי צירוף של כמה אימוג׳י, בלי גווני עור ובלי דגלים.',
      '',
      'שפה:'
    );
    languageLines(level, genre).forEach(function (l) { lines.push(l); });
    lines.push(NO_NIKUD, KTIV, NO_EMOJI, '', READ_ALOUD);
    return lines;
  }

  // settings: {topic, length, level, genre: 'story'|'info', wordsMode: 'number'|'list', wordCount, words: [],
  //            exercises: {mcq: n, tf: n, ...} (optional: the level's defaults)}
  function buildPrompt(settings) {
    var level = levelOf(settings.level);
    var counts = countsOf(settings, level);
    var lines = storyLines(settings, level);
    lines.push('', 'תרגילים (בסדר הזה):');
    exerciseLines(counts, level).forEach(function (l) { lines.push(forGenre(l, settings.genre)); });
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

  // Second call of the automatic flow: an editor rewrites the draft ({title, targetWords, story}) for flow and
  // natural language, keeping the plot, the target words, the kind of text and the level. Returns {story}.
  function buildEditPrompt(settings, draft) {
    var level = levelOf(settings.level);
    var genre = window.Levels.genre(settings.genre);
    var n = noun(genre);
    var words = window.Hebrew.countWords(draft.story);
    var targets = (draft.targetWords || []).map(function (w) { return w.word; });
    var lines = [
      EDITOR,
      'לפניך טיוטה של ' + n.a + ' לילד שלומד לקרוא, ברמת קריאה ' + level.label + '.',
      'שכתב אותה כך שתישמע כמו ספר ילדים טוב: רצף טבעי, מעברים חלקים בין המשפטים, ועברית שנשמעת טבעית כשמקריאים אותה בקול.',
      '',
      'מה לא משתנה:',
      genre === 'info'
        ? '- התוכן: אותו נושא, אותן עובדות ואותו סדר של תת-נושאים. אל תוסיף עובדות חדשות.'
        : '- העלילה: אותן דמויות, אותם אירועים, באותו סדר ועם אותו סוף.',
      '- מילות היעד: ' + targets.join(', ') + '. כל אחת נשארת בטקסט לפחות פעם אחת, באותו כתיב (מותר עם ו, ה, ב, ל, מ, ש לפניה), ובמשמעות הנכונה שלה.',
      '- סוג הטקסט: ' + n.kind + '. אל תהפוך אותו ל' + (genre === 'info' ? 'סיפור' : 'טקסט מידעי') + ' ואל תערבב ביניהם.',
      '- רמת הקריאה: ' + level.label + '.',
      '- האורך: בטיוטה ' + words + ' מילים. מותר לשנות אותו עד 20% (בין ' + Math.round(words * (1 - LENGTH_SLACK)) +
        ' ל-' + Math.round(words * (1 + LENGTH_SLACK)) + ' מילים).',
      '',
      'מה לשפר:',
      '- רצף: חבר משפטים קצרים ונפרדים עם מילות קישור, וגוון את אורך המשפטים.',
      '- משפטי מילוי שלא מקדמים את הטקסט: מחק אותם או מזג אותם עם משפט אחר.',
      '- היגיון ועקביות: זמן, מקום, ומה שכל דמות יודעת ועושה.',
      '- צירופים שנשמעים כמו תרגום, ז׳רגון ושפה גבוהה מדי לרמה: החלף בעברית פשוטה וטבעית.',
      '- מילת יעד שמופיעה במקום מאולץ: נסח מחדש את המשפט כך שהיא תתאים בו באופן טבעי.',
      '',
      'הנחיות לרמה ולשפה:'
    ];
    languageLines(level, genre).forEach(function (l) { lines.push(l); });
    lines.push(NO_NIKUD, KTIV, NO_EMOJI, '', READ_ALOUD, '',
      'הכותרת: ' + draft.title,
      '',
      'הטיוטה:',
      '---',
      draft.story,
      '---',
      '',
      'החזר JSON בדיוק במבנה הזה, עם הטקסט המלא אחרי העריכה (פסקאות מופרדות בשורה חדשה):',
      JSON.stringify({ story: 'הטקסט המלא אחרי העריכה.' }, null, 2));
    return lines.join('\n');
  }

  // Last call: the exercises on the (edited) story ({title, targetWords, story}).
  function buildExercisesPrompt(settings, story) {
    var level = levelOf(settings.level);
    var counts = countsOf(settings, level);
    var g = function (l) { return forGenre(l, settings.genre); };
    var lines = [
      INTRO,
      '',
      g('זה סיפור לילד ברמת קריאה: ') + level.label + '.',
      'הכותרת: ' + story.title,
      'מילות היעד: ' + (story.targetWords || []).map(function (w) { return w.word; }).join(', '),
      '',
      g('הסיפור:'),
      '---',
      story.story,
      '---',
      '',
      g('כתוב תרגילים על הסיפור הזה (בסדר הזה):')
    ];
    exerciseLines(counts, level).forEach(function (l) { lines.push(g(l)); });
    lines.push(
      '',
      'הנחיות לתרגילים:',
      g('- כל תרגיל מבוסס על מה שכתוב בסיפור. משפט שלוקחים מהסיפור מועתק מילה במילה.'),
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
  window.buildEditPrompt = buildEditPrompt;
  window.buildExercisesPrompt = buildExercisesPrompt;
  window.storyShape = storyShape;
  window.Prompt = { LENGTH_SLACK: LENGTH_SLACK, languageLines: languageLines, GENRE_LINES: GENRE_LINES };
})();
