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

  // settings: {topic, length, wordsMode: 'number'|'list', wordCount, words: []}
  function buildPrompt(settings) {
    var lines = [
      'אתה כותב תוכן ללימוד קריאה לילד בהוראה מותאמת.',
      '',
      'כתוב סיפור קצר בעברית בנושא: ' + settings.topic,
      'אורך הסיפור: בערך ' + settings.length + ' מילים.'
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
})();
