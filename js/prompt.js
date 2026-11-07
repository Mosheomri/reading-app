/* The AI prompt template. Kept in one place so it is easy to tune.
   Like an author: first an idea, then a plan, and only then the writing.
   Exposes window.buildPrompt (the whole lesson, for copy-paste: a plan field, then the story) and, for the
   automatic flow with Gemini, window.buildIdeasPrompt (3 ideas), window.buildPlanPrompt (an outline of scenes),
   window.buildStoryPrompt (the text, written from the outline), window.buildEditPrompt (an editor's rewrite of it)
   and window.buildExercisesPrompt. */
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

  // The plan before the story (copy-paste prompt): the idea and the scenes. Shown to the teacher, not kept in the lesson.
  function planExample(genre) {
    return genre === 'info'
      ? { idea: 'הזווית ב-2 עד 3 משפטים: על מה הטקסט מתמקד, ומה הילד ילמד ממנו.',
          scenes: [{ what: 'תת-הנושא', facts: 'העובדות המרכזיות', words: ['מילה'], length: 40 }] }
      : { idea: 'הרעיון ב-2 עד 3 משפטים: הדמות המרכזית ושמה, מה היא רוצה, מה מפריע לה ואיך זה נגמר.',
          scenes: [{ what: 'מה קורה', feeling: 'הרגש', words: ['מילה'], length: 40 }] };
  }

  function schemaExample(counts, messageStyle, genre) {
    return Object.assign({ version: 1, plan: planExample(genre) }, storyExample(), { exercises: exercisesExample(counts, messageStyle) });
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

  // The structure of each kind of text (the plan call, and the plan in the copy-paste prompt).
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

  // Topic, kind of text, level and length: the head of every writing call.
  function taskLines(settings, level) {
    return [
      'נושא: ' + settings.topic,
      'סוג הטקסט: ' + noun(settings.genre).kind + '.',
      'רמת קריאה: ' + level.label + '.',
      'אורך: ' + storyShape(settings.length)
    ];
  }

  // How many scenes (or subtopics) the outline has, by the length asked for: a short text has fewer parts.
  function sceneRange(length) {
    if (length <= 80) return { min: 2, max: 3 };
    if (length <= 250) return { min: 3, max: 5 };
    return { min: 4, max: 6 };
  }

  var EMOJI_LINE = '- לכל מילת יעד הוסף אימוג׳י אחד שמתאר אותה. רק אימוג׳י נפוץ וותיק שמוצג בכל מכשיר (כמו 🐶 🌳 ⚽ 🏠 🍎): ' +
    'בלי אימוג׳י חדשים, בלי צירוף של כמה אימוג׳י, בלי גווני עור ובלי דגלים.';

  // The AI chooses the words: n simple, concrete words that the text needs.
  function chooseWordsLine(settings, n) {
    return '- בחר ' + settings.wordCount + ' מילות יעד פשוטות ומוחשיות, שמשתלבות ב' + n.text +
      ' באופן טבעי (לדוגמה: בסיפור על כדורגל, החפץ הוא "כדור", לא "כדורגל").';
  }

  // How the target words are used in the text (the copy-paste prompt and the writing call).
  var WORD_USE = [
    '- השתמש בכל מילה רק במשמעות הנכונה שלה, ובמקום שבו היא מתאימה באופן טבעי.',
    '- כל מילה מופיעה לפחות פעם אחת, ועדיף 2 עד 3 פעמים, אם זה טבעי.',
    '- אסור להמציא משפט או דמות רק כדי לשלב מילה.'
  ];

  // The outline's fields, for the plan call and the plan field of the copy-paste prompt.
  function sceneLines(settings, genre) {
    var r = sceneRange(settings.length);
    var range = r.min + ' עד ' + r.max;
    var lines = genre === 'info'
      ? ['- scenes: מתווה של ' + range + ' תתי-נושאים, לפי הסדר בטקסט. לכל תת-נושא:',
         '  - what: תת-הנושא.',
         '  - facts: העובדות המרכזיות שהטקסט מסביר עליו.']
      : ['- scenes: מתווה של ' + range + ' סצנות, לפי הסדר בסיפור. לכל סצנה:',
         '  - what: מה קורה בה.',
         '  - feeling: הרגש של הדמות בסצנה.'];
    lines.push('  - words: מילות היעד שמופיעות בה.',
      '  - length: כמה מילים בערך. סכום האורכים: בערך ' + settings.length + ' מילים.');
    return lines;
  }

  // The language rules, the text rules and the style example (the copy-paste prompt and the writing call).
  function writingRules(level, genre) {
    var lines = ['', 'שפה:'].concat(languageLines(level, genre));
    lines.push(NO_NIKUD, KTIV, NO_EMOJI);
    var example = window.StyleExamples && window.StyleExamples.get(level.id, genre);
    if (example) lines.push('', 'דוגמה לסגנון הכתיבה ברמה הזו (לא לנושא ולא לתוכן):', '---', example, '---');
    lines.push('', READ_ALOUD);
    return lines;
  }

  // settings: {topic, length, level, genre: 'story'|'info', wordsMode: 'number'|'list', wordCount, words: [],
  //            exercises: {mcq: n, tf: n, ...} (optional: the level's defaults)}
  // The whole lesson in one answer: a plan first (the idea and the outline), then the text written from it, then the exercises.
  function buildPrompt(settings) {
    var level = levelOf(settings.level);
    var genre = window.Levels.genre(settings.genre);
    var n = noun(genre);
    var counts = countsOf(settings, level);
    var lines = [
      WRITER,
      'כתוב ' + n.a + ' בעברית לילד שלומד לקרוא, בהוראה מותאמת.',
      QUALITY,
      ''
    ].concat(taskLines(settings, level), [
      '',
      'קודם תכנן, אחר כך כתוב לפי התכנון.',
      '',
      'תכנון (בשדה plan, לפני ' + n.the + '):',
      genre === 'info'
        ? '- idea: הזווית ב-2 עד 3 משפטים: על מה הטקסט מתמקד, ומה הילד ילמד ממנו.'
        : '- idea: הרעיון ב-2 עד 3 משפטים: הדמות המרכזית ושמה, מה היא רוצה, מה מפריע לה ואיך זה נגמר.'
    ], sceneLines(settings, genre), [
      '',
      genre === 'info' ? 'מבנה הטקסט המידעי:' : 'מבנה הסיפור:'
    ], GENRE_LINES[genre], ['', 'מילות יעד:']);
    if (settings.wordsMode === 'list') lines.push('- מילות היעד: ' + settings.words.join(', ') + '.');
    else lines.push(chooseWordsLine(settings, n));
    lines = lines.concat(WORD_USE, [EMOJI_LINE, '', 'כתיבה (בשדה story):',
      '- כתוב את ' + n.the + ' לפי התכנון, לפי הסדר ובערך באורך שתכננת לכל חלק.'], writingRules(level, genre));
    lines.push('', 'תרגילים (בסדר הזה):');
    exerciseLines(counts, level).forEach(function (l) { lines.push(forGenre(l, genre)); });
    lines.push(
      '',
      'החזר את ה-JSON בתוך בלוק קוד אחד (```json), בלי שום טקסט לפניו או אחריו, בדיוק במבנה הזה' +
        ' (בדוגמה סצנה אחת ותרגיל אחד מכל סוג; כתוב את מספר הסצנות והתרגילים שביקשתי):',
      JSON.stringify(schemaExample(counts, level.messageStyle, genre), null, 2)
    );
    return lines.join('\n');
  }

  /* ---------- The automatic flow: ideas, plan, writing ---------- */

  // An idea as text, for the plan and writing prompts. idea: a card from the ideas call, or {own: the teacher's text}.
  function ideaText(idea, genre) {
    if (!idea) return '';
    if (idea.own) return String(idea.own).trim();
    var parts = [idea.title ? idea.title + '.' : ''];
    if (window.Levels.genre(genre) === 'info') {
      parts.push(idea.angle || '');
    } else {
      if (idea.character) parts.push('הדמות המרכזית: ' + idea.character + '.');
      if (idea.want) parts.push('מה היא רוצה: ' + idea.want + '.');
      if (idea.obstacle) parts.push('מה מפריע לה: ' + idea.obstacle + '.');
      if (idea.ending) parts.push('איך זה נגמר: ' + idea.ending);
    }
    return parts.filter(Boolean).join(' ').replace(/([.?!])\./g, '$1');
  }

  function ideaWords(idea) {
    return ((idea && idea.words) || []).map(function (w) { return String((w && w.word) || '').trim(); }).filter(Boolean);
  }

  // First call: 3 ideas for the text (for an informational text, 3 angles on the topic). If the AI chooses the
  // target words, it chooses them here, from the plot. avoid: titles of ideas already shown, not to repeat.
  function buildIdeasPrompt(settings, avoid) {
    var level = levelOf(settings.level);
    var genre = window.Levels.genre(settings.genre);
    var n = noun(genre);
    var info = genre === 'info';
    var one = info ? 'זווית' : 'רעיון';
    var lines = [
      WRITER,
      'לפני שכותבים ' + n.a + ' בעברית לילד שלומד לקרוא, בהוראה מותאמת, ' +
        (info ? 'הצע 3 זוויות שונות לנושא.' : 'הצע 3 רעיונות שונים לסיפור.'),
      ''
    ].concat(taskLines(settings, level), ['', 'לכל ' + one + ':', '- title: כותרת.']);
    if (info) {
      lines.push('- angle: הזווית ב-2 עד 3 משפטים: על מה הטקסט מתמקד, ומה הילד ילמד ממנו.');
    } else {
      lines.push('- character: הדמות המרכזית ושמה.',
        '- want: מה היא רוצה.',
        '- obstacle: מה מפריע לה.',
        '- ending: איך זה נגמר, ב-2 עד 3 משפטים.');
    }
    lines.push('- words: איך כל מילת יעד משתלבת ב' + n.text + ' באופן טבעי: המילה (word), ואיפה ולמה היא מופיעה (use).', '', 'מילות יעד:');
    if (settings.wordsMode === 'list') {
      lines.push('- מילות היעד: ' + settings.words.join(', ') + '. כל ' + one + ' משלב את כולן.');
    } else {
      lines.push(chooseWordsLine(settings, n),
        '- בחר אותן מתוך ' + (info ? 'הזווית' : 'העלילה') + ': מילים ש' + n.the + ' צריך באמת, לא מילים שמוסיפים לו. לכל ' + one + ' המילים שלו.');
    }
    lines.push('', 'הנחיות:');
    if (info) {
      lines.push('- 3 זוויות שונות באמת: כל אחת מתמקדת בצד אחר של הנושא.',
        '- זווית מצומצמת, שאפשר להסביר ב-' + settings.length + ' מילים, ברמת הקריאה הזו.',
        '- עובדות נכונות, שמעניינות ילד.');
    } else {
      lines.push('- 3 רעיונות שונים באמת: דמות, רצון, בעיה וסוף אחרים.',
        '- עלילה קטנה שאפשר לספר ב-' + settings.length + ' מילים, ברמת הקריאה הזו: רצון אחד, בעיה אחת ופתרון אחד.',
        '- הדמות פותרת את הבעיה בעצמה, במעשה או ברעיון שלה, ולא במזל או בעזרת מבוגר שפותר הכול.',
        '- רעיון שמעניין ילד, מהעולם שלו.');
    }
    if (avoid && avoid.length) lines.push('- אל תחזור על ' + (info ? 'הזוויות' : 'הרעיונות') + ' שכבר הוצעו: ' + avoid.join('; ') + '.');
    lines.push(NO_NIKUD, KTIV);
    var example = info
      ? { title: 'כותרת', angle: 'הזווית.', words: [{ word: 'מילה', use: 'איפה ולמה היא מופיעה.' }] }
      : { title: 'כותרת', character: 'הדמות ושמה', want: 'מה היא רוצה', obstacle: 'מה מפריע לה', ending: 'איך זה נגמר.',
          words: [{ word: 'מילה', use: 'איפה ולמה היא מופיעה.' }] };
    lines.push('', 'החזר JSON בדיוק במבנה הזה, עם 3 ' + (info ? 'זוויות' : 'רעיונות') + ':', JSON.stringify({ ideas: [example] }, null, 2));
    return lines.join('\n');
  }

  // Second call: an outline of scenes (subtopics; how many by the length, sceneRange) for the chosen idea, with the target words and their emoji.
  // idea: a card from buildIdeasPrompt's answer, or {own: the teacher's own idea}.
  function buildPlanPrompt(settings, idea) {
    var level = levelOf(settings.level);
    var genre = window.Levels.genre(settings.genre);
    var n = noun(genre);
    var info = genre === 'info';
    var lines = [
      WRITER,
      'תכנן ' + n.a + ' בעברית לילד שלומד לקרוא, בהוראה מותאמת, לפני שכותבים אותו.',
      ''
    ].concat(taskLines(settings, level), [
      '',
      (info ? 'הזווית' : 'הרעיון') + (idea && idea.own ? ' (של המורה)' : '') + ': ' + ideaText(idea, genre),
      '',
      'התכנון:',
      '- title: כותרת.'
    ], sceneLines(settings, genre), [
      '',
      info ? 'מבנה הטקסט המידעי:' : 'מבנה הסיפור:'
    ], GENRE_LINES[genre], ['', 'מילות יעד (בשדה targetWords):']);
    var words = settings.wordsMode === 'list' ? settings.words : ideaWords(idea);
    if (words.length) lines.push('- מילות היעד: ' + words.join(', ') + '.');
    else lines.push(chooseWordsLine(settings, n));
    lines.push('- כל מילה מופיעה לפחות ב' + (info ? 'תת-נושא אחד' : 'סצנה אחת') + ', במקום שבו היא מתאימה באופן טבעי, ובמשמעות הנכונה שלה.',
      EMOJI_LINE, NO_NIKUD, KTIV);
    lines.push('', 'החזר JSON בדיוק במבנה הזה (בדוגמה ' + (info ? 'תת-נושא אחד' : 'סצנה אחת') + '):',
      JSON.stringify({ title: 'כותרת', targetWords: [{ word: 'מילה', emoji: '🙂' }], scenes: planExample(genre).scenes }, null, 2));
    return lines.join('\n');
  }

  // The outline as numbered lines, for the writing prompt.
  function outlineLines(plan, genre) {
    return (plan.scenes || []).map(function (s, i) {
      var notes = [];
      if (genre !== 'info' && s.feeling) notes.push('הרגש: ' + s.feeling + '.');
      if (s.words && s.words.length) notes.push('מילות יעד: ' + s.words.join(', ') + '.');
      if (s.length) notes.push('בערך ' + s.length + ' מילים.');
      var what = String(s.what || '').trim();
      if (genre === 'info' && s.facts) what += ': ' + String(s.facts).trim();
      return (i + 1) + '. ' + what + (notes.length ? ' (' + notes.join(' ') + ')' : '');
    });
  }

  // Third call: the text, written from the plan ({title, idea, targetWords, scenes}). The structure is in the plan,
  // so this prompt has the plan, the target words, the language rules and the style example. Returns {story}.
  function buildStoryPrompt(settings, plan) {
    var level = levelOf(settings.level);
    var genre = window.Levels.genre(settings.genre);
    var n = noun(genre);
    var info = genre === 'info';
    var words = (plan.targetWords || []).map(function (w) { return w.word; }).filter(Boolean);
    var lines = [
      WRITER,
      'כתוב ' + n.a + ' בעברית לילד שלומד לקרוא, בהוראה מותאמת, לפי התכנון שלמטה.',
      QUALITY,
      ''
    ].concat(taskLines(settings, level), [
      '',
      'הכותרת: ' + plan.title,
      (info ? 'הזווית: ' : 'הרעיון: ') + plan.idea,
      '',
      info ? 'תתי-הנושאים, לפי הסדר:' : 'הסצנות, לפי הסדר:'
    ], outlineLines(plan, genre), [
      '',
      '- כתוב לפי התכנון, לפי הסדר ובערך באורך שנקבע לכל חלק. מותר לשנות פרט קטן אם זה משפר את ' + n.the +
        ', אבל לא ' + (info ? 'את העובדות.' : 'את העלילה ואת הסוף.'),
      '',
      'מילות יעד: ' + words.join(', ') + '.'
    ], WORD_USE, writingRules(level, genre));
    lines.push('', 'החזר JSON בדיוק במבנה הזה (פסקאות מופרדות בשורה חדשה):', JSON.stringify({ story: storyExample().story }, null, 2));
    return lines.join('\n');
  }

  // Fourth call of the automatic flow: an editor rewrites the draft ({title, targetWords, story}) for flow and
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
  window.buildIdeasPrompt = buildIdeasPrompt;
  window.buildPlanPrompt = buildPlanPrompt;
  window.buildStoryPrompt = buildStoryPrompt;
  window.buildEditPrompt = buildEditPrompt;
  window.buildExercisesPrompt = buildExercisesPrompt;
  window.storyShape = storyShape;
  window.Prompt = { LENGTH_SLACK: LENGTH_SLACK, sceneRange: sceneRange, languageLines: languageLines, GENRE_LINES: GENRE_LINES,
    ideaText: ideaText, ideaWords: ideaWords };
})();
