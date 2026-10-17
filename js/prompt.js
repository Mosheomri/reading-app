/* The AI prompt template. Kept in one place so it is easy to tune. Exposes window.buildPrompt. */
(function () {
  'use strict';

  // Schema example shown to the AI (section 5), nikudMode always "full":
  // nikud display is applied by the app at render time.
  var SCHEMA_EXAMPLE = {
    version: 1,
    title: 'כּוֹתֶרֶת מְנֻקֶּדֶת',
    topic: 'הַנּוֹשֵׂא',
    nikudMode: 'full',
    targetWords: [
      { word: 'מִלָּה מְנֻקֶּדֶת', emoji: '🙂' }
    ],
    story: 'הַסִּפּוּר הַמָּלֵא בְּנִקּוּד מָלֵא.\nפִּסְקָה חֲדָשָׁה אַחֲרֵי שׁוּרָה חֲדָשָׁה.',
    exercises: [
      { type: 'mcq', question: 'שְׁאֵלָה?', options: ['אֶפְשָׁרוּת א', 'אֶפְשָׁרוּת ב', 'אֶפְשָׁרוּת ג'], answer: 0 },
      { type: 'tf', statement: 'מִשְׁפָּט עַל הַסִּפּוּר.', answer: true },
      { type: 'fill', sentence: 'מִשְׁפָּט עִם ___ חֲסֵרָה.', options: ['מִלָּה', 'אַחֶרֶת', 'שְׁלִישִׁית'], answer: 0 },
      { type: 'order', sentences: ['מִשְׁפָּט רִאשׁוֹן', 'מִשְׁפָּט שֵׁנִי', 'מִשְׁפָּט שְׁלִישִׁי', 'מִשְׁפָּט רְבִיעִי'] }
    ]
  };

  // AIs follow paragraph/sentence counts better than word counts.
  var WORDS_PER_SENTENCE = 8;
  var SENTENCES_PER_PARAGRAPH = 4;

  // e.g. 128 words → "4 פסקאות, בכל פסקה 4 משפטים קצרים"
  function storyShape(length) {
    var sentences = Math.max(2, Math.round(length / WORDS_PER_SENTENCE));
    var paragraphs = Math.max(1, Math.round(sentences / SENTENCES_PER_PARAGRAPH));
    var perParagraph = Math.max(1, Math.round(sentences / paragraphs));
    if (paragraphs === 1) return 'פסקה אחת, עם ' + perParagraph + ' משפטים קצרים';
    return paragraphs + ' פסקאות, בכל פסקה ' + perParagraph + ' משפטים קצרים';
  }

  // settings: {topic, length, wordsMode: 'number'|'list', wordCount, words: []}
  function buildPrompt(settings) {
    var lines = [
      'אתה כותב תוכן ללימוד קריאה לילד בהוראה מותאמת.',
      '',
      'כתוב סיפור קצר בעברית בנושא: ' + settings.topic,
      'אורך הסיפור: ' + storyShape(settings.length) + '.'
    ];
    if (settings.wordsMode === 'list') {
      lines.push('מילות היעד: ' + settings.words.join(', ') + '. כל מילת יעד חייבת להופיע בסיפור לפחות פעמיים.');
    } else {
      lines.push('בחר ' + settings.wordCount + ' מילות יעד פשוטות ומוחשיות שקשורות לנושא. כל מילה חייבת להופיע בסיפור לפחות פעמיים.');
    }
    lines.push(
      '',
      'הנחיות לסיפור:',
      '- משפטים קצרים ופשוטים, שפה של ילדים.',
      '- כתוב את כל הטקסט בניקוד מלא ומדויק: הכותרת, הסיפור, המילים, השאלות והתשובות.',
      '- גם מילות היעד בשדה word חייבות להיות בניקוד מלא.',
      '- לכל מילת יעד הוסף אימוג׳י אחד שמתאר אותה.',
      '- אל תכניס אימוג׳י לסיפור, לכותרת או לתרגילים. אימוג׳י מופיעים רק בשדה emoji של מילות היעד.',
      '',
      'תרגילים:',
      '- 3 שאלות הבנה אמריקאיות (3 אפשרויות כל אחת).',
      '- 2 משפטי נכון/לא נכון.',
      '- 2 משפטים להשלמת מילה חסרה (סמן את החסר ב-___), עם 3 אפשרויות.',
      '- תרגיל סידור אחד: 4 משפטים מהסיפור, בסדר הנכון.',
      '- בשדה answer: מספר האפשרות הנכונה, כשהאפשרות הראשונה היא 0.',
      '',
      'החזר את ה-JSON בתוך בלוק קוד אחד (```json), בלי שום טקסט לפניו או אחריו, בדיוק במבנה הזה:',
      JSON.stringify(SCHEMA_EXAMPLE, null, 2)
    );
    return lines.join('\n');
  }

  window.buildPrompt = buildPrompt;
  window.storyShape = storyShape;
})();
