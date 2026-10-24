/* Reading levels and kinds of text: language guidelines for the writing, editing and review prompts,
   and the default question counts. Everything about levels lives here, so it is easy to tune.
   Exposes window.Levels. */
(function () {
  'use strict';

  var DEFAULT = '1-2';

  // The question types the teacher can choose in the settings form, in the order shown (and asked for).
  var TYPES = [
    { id: 'mcq', label: 'אמריקאית' },
    { id: 'tf', label: 'נכון / לא נכון' },
    { id: 'fill', label: 'השלמה' },
    { id: 'order', label: 'סידור' },
    { id: 'open', label: 'פתוחה' },
    { id: 'locate', label: 'איתור מידע' },
    { id: 'message', label: 'מסר גלוי וסמוי' }
  ];
  var MAX_PER_TYPE = 5;

  // Kinds of text (the lesson's "genre"). An informational text has no plot: no sequence of events to order
  // and no hidden message, so those types are off by default (their questions go to locating information).
  var GENRES = [
    { id: 'story', label: 'סיפור' },
    { id: 'info', label: 'טקסט מידעי' }
  ];
  var DEFAULT_GENRE = 'story';

  // id: stored in the lesson ("level"). label: shown to the teacher and named in the prompts.
  // Prompt lines about the text (writing, editing and review): sentence (sentence length), language (vocabulary and
  // style, for every kind of text), story (stories only: characters and dialogue), avoid (what not to write).
  // questions: prompt line about the exercises.
  var LIST = [
    {
      id: 'k-1',
      label: 'גן–תחילת א׳',
      sentence: 'משפטים קצרים: 3 עד 6 מילים במשפט. אבל לא רשימה של משפטים נפרדים: חבר אותם עם "ו", "אז", "כי".',
      language: [
        'רק מילים מעולם הילד הצעיר: בית, משפחה, גן, חברים, חיות, אוכל, משחקים, מזג אוויר.',
        'חזרתיות מכוונת: ביטוי או משפט קצר שחוזר כמה פעמים (כמו "ושוב לא מצא"), כדי שהילד יזהה אותו ויצפה לו.',
        'זמן אחד לאורך כל הטקסט: הווה, או עבר פשוט.'
      ],
      story: [
        'דמות אחת או שתיים, עם שם קצר וקל לקריאה.',
        'דיאלוג קצר מאוד: משפט אחד בכל פעם שמישהו מדבר.'
      ],
      avoid: [
        'מילים מופשטות (כמו "אכזבה", "התלהבות") ומילים שילד בגן לא אומר.',
        'משפטים עם כמה חלקים, סוגריים או מקפים.',
        'קפיצות בזמן או במקום.'
      ],
      questions: 'כל השאלות ישירות: התשובה כתובה במפורש בסיפור.',
      // How many questions of each type by default, and how the parts of a "message" are asked.
      exercises: { mcq: 3, tf: 2, fill: 1, order: 1, open: 0, locate: 1, message: 0 },
      messageStyle: 'mcq'
    },
    {
      id: '1-2',
      label: 'סוף א׳–ב׳',
      sentence: 'משפטים קצרים: 4 עד 8 מילים במשפט, לא כולם באותו אורך.',
      language: [
        'מילים מוכרות מעולם הילד: בית ספר, חברים, משפחה, טבע, חיות, תחביבים.',
        'משפטים מחוברים עם "ו", "כי", "אבל", "אז", "כש-", ולא רצף של משפטים קצרים ונפרדים.',
        'מעט תיאורים: מילה או שתיים שמתארות דבר חשוב.',
        'חזרתיות במידה: ביטוי מפתח שחוזר פעמיים או שלוש.'
      ],
      story: [
        'דיאלוג קצר וברור, עם "אמר" או "שאלה", כדי שיהיה ברור מי מדבר.'
      ],
      avoid: [
        'מילים מופשטות או נדירות, ביטויים ושפה גבוהה.',
        'משפטים עם יותר משני חלקים.',
        'קפיצות בזמן או במקום.'
      ],
      questions: 'רוב השאלות ישירות (התשובה כתובה בסיפור), ושאלה אחת פשוטה של הבנה.',
      exercises: { mcq: 3, tf: 2, fill: 2, order: 1, open: 0, locate: 1, message: 1 },
      messageStyle: 'mcq'
    },
    {
      id: '3-4',
      label: 'ג׳–ד׳',
      sentence: 'משפטים של 6 עד 12 מילים, באורך מגוון: קצרים ברגע מותח, ארוכים יותר בתיאור.',
      language: [
        'אוצר מילים רחב יותר: אפשר מילים פחות יומיומיות, כשההקשר מסביר אותן.',
        'משפטים מורכבים פשוטים, עם "ש", "כש", "כי", "אבל", "לכן".',
        'יותר תיאור: איך נראה המקום, מה מרגישים, מה שומעים.'
      ],
      story: [
        'דיאלוג שמקדם את העלילה ומראה מי הדמויות.'
      ],
      avoid: [
        'ז׳רגון מקצועי ומילים שילד בכיתה ג׳ לא מכיר בלי הסבר.',
        'שפה ספרותית גבוהה (כמו "לפתע פתאום", "אזי", "על אתר").',
        'מוסר השכל מפורש בסוף ("ומאז הוא הבין ש...").'
      ],
      questions: 'שאלה אחת של הסקה: התשובה לא כתובה במפורש, אבל אפשר להבין אותה מהסיפור. שאר השאלות ישירות.',
      exercises: { mcq: 3, tf: 1, fill: 2, order: 1, open: 1, locate: 1, message: 1 },
      messageStyle: 'open'
    },
    {
      id: '5-6',
      label: 'ה׳–ו׳',
      sentence: 'משפטים באורך מגוון, בדרך כלל 8 עד 15 מילים, לצד משפטים קצרים.',
      language: [
        'אוצר מילים עשיר, כולל ביטויים מוכרים, אבל עדיין השפה של ספר ילדים.',
        'מילות קישור כמו "אבל", "לכן", "למרות ש", "בזמן ש", "אחרי ש".',
        'תיאורים חיים: להראות מה קורה ומה מרגישים, ולא רק להגיד את זה.'
      ],
      story: [
        'דיאלוג טבעי, שמראה מה הדמויות חושבות ומרגישות.',
        'אפשר רגשות מורכבים ודילמה.'
      ],
      avoid: [
        'שפה ספרותית גבוהה, מילים ארכאיות ומליצות.',
        'ז׳רגון מקצועי בלי הסבר.',
        'מוסר השכל מפורש בסוף.'
      ],
      questions: 'שתי שאלות הסקה: התשובה לא כתובה במפורש, אבל אפשר להבין אותה מהסיפור. שאר השאלות ישירות.',
      exercises: { mcq: 3, tf: 1, fill: 1, order: 1, open: 2, locate: 1, message: 1 },
      messageStyle: 'open'
    }
  ];

  function get(id) {
    for (var i = 0; i < LIST.length; i++) if (LIST[i].id === id) return LIST[i];
    return null;
  }

  // A known level id, or '' (lessons made before levels existed have none).
  function valid(id) {
    return get(String(id == null ? '' : id).trim()) ? String(id).trim() : '';
  }

  // 'story' or 'info'; anything else (lessons made before genres) is a story.
  function genre(id) {
    return id === 'info' ? 'info' : DEFAULT_GENRE;
  }

  // The counts of a level (a copy), or of the default level. genre 'info': no order or message questions.
  function exerciseDefaults(id, g) {
    var out = Object.assign({}, (get(id) || get(DEFAULT)).exercises);
    if (genre(g) === 'info') {
      out.locate += out.order + out.message;
      out.order = 0;
      out.message = 0;
    }
    return out;
  }

  // The level's prompt lines about the text, for a kind of text: language, then the story lines (stories only).
  function textLines(level, g) {
    return level.language.concat(genre(g) === 'story' ? level.story : []);
  }

  window.Levels = {
    DEFAULT: DEFAULT, LIST: LIST, TYPES: TYPES, MAX_PER_TYPE: MAX_PER_TYPE,
    GENRES: GENRES, DEFAULT_GENRE: DEFAULT_GENRE,
    get: get, valid: valid, genre: genre, exerciseDefaults: exerciseDefaults, textLines: textLines
  };
})();
