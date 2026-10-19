/* Reading levels: language guidelines for the lesson prompt, sentence length for the story shape,
   and what the review prompt checks. Everything about levels lives here, so it is easy to tune.
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

  // id: stored in the lesson ("level"). label: shown to the teacher and named in the prompts.
  // wordsPerSentence: average, turns the requested word count into paragraphs and sentences.
  // sentence / language: prompt lines about the story. questions: prompt line about the exercises.
  var LIST = [
    {
      id: 'k-1',
      label: 'גן–תחילת א׳',
      wordsPerSentence: 4,
      sentence: 'משפטים קצרים מאוד: 3 עד 5 מילים במשפט.',
      language: [
        'רק מילים יומיומיות שילדים צעירים מכירים.',
        'משפטים פשוטים, בלי משפטים מורכבים. בעיקר בזמן הווה.'
      ],
      questions: 'כל השאלות ישירות: התשובה כתובה במפורש בסיפור.',
      // How many questions of each type by default, and how the parts of a "message" are asked.
      exercises: { mcq: 3, tf: 2, fill: 1, order: 1, open: 0, locate: 1, message: 0 },
      messageStyle: 'mcq'
    },
    {
      id: '1-2',
      label: 'סוף א׳–ב׳',
      wordsPerSentence: 5.5,
      sentence: 'משפטים קצרים: 4 עד 7 מילים במשפט.',
      language: [
        'מילים מוכרות ופשוטות.',
        'אפשר לחבר שני חלקי משפט עם "ו" או "כי", בלי משפטים מורכבים יותר.',
        'מעט תיאורים.'
      ],
      questions: 'רוב השאלות ישירות (התשובה כתובה בסיפור), ושאלה אחת פשוטה של הבנה.',
      exercises: { mcq: 3, tf: 2, fill: 2, order: 1, open: 0, locate: 1, message: 1 },
      messageStyle: 'mcq'
    },
    {
      id: '3-4',
      label: 'ג׳–ד׳',
      wordsPerSentence: 8,
      sentence: 'משפטים של 6 עד 10 מילים.',
      language: [
        'אוצר מילים רחב יותר: אפשר מילים פחות יומיומיות, כשההקשר מסביר אותן.',
        'משפטים מורכבים פשוטים, עם "ש" או "כאשר".'
      ],
      questions: 'שאלה אחת של הסקה: התשובה לא כתובה במפורש, אבל אפשר להבין אותה מהסיפור. שאר השאלות ישירות.',
      exercises: { mcq: 3, tf: 1, fill: 2, order: 1, open: 1, locate: 1, message: 1 },
      messageStyle: 'open'
    },
    {
      id: '5-6',
      label: 'ה׳–ו׳',
      wordsPerSentence: 11,
      sentence: 'משפטים ארוכים יותר, בדרך כלל 8 עד 14 מילים.',
      language: [
        'אוצר מילים עשיר, כולל ביטויים.',
        'מילות קישור כמו "אבל", "לכן", "למרות ש", "בזמן ש".'
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

  // The counts of a level (a copy), or of the default level.
  function exerciseDefaults(id) {
    return Object.assign({}, (get(id) || get(DEFAULT)).exercises);
  }

  window.Levels = {
    DEFAULT: DEFAULT, LIST: LIST, TYPES: TYPES, MAX_PER_TYPE: MAX_PER_TYPE,
    get: get, valid: valid, exerciseDefaults: exerciseDefaults
  };
})();
