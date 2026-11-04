// Versioned, trusted built-in Skill content. No arbitrary JS/HTML/code uploads.
// Text-only scripted lessons are evidence of following an exercise, NOT
// pronunciation, child proficiency, mastery or accredited course completion.
const COURSES=Object.freeze([
  {
    id:'english.a1.intro',version:'1.0.0',mode:'english',
    skillId:'learning.english',level:'A1',title:'基础英语：介绍、喜好与能力',
    description:'五步文字句型练习：介绍、喜好、能力、感受。',
    objectives:['Use an English full sentence for preferences','Use I can and I am patterns'],
    targetStep:5,kind:'english_a1_text',
    opening:'Hello! I am Alex. Let us practice easy English. What nickname should I call you?'
  },
  {
    id:'english.a1.greetings',version:'1.0.0',mode:'english',
    skillId:'learning.english',level:'A1',title:'基础英语：打招呼',
    description:'三步文字练习：问好、表达感受和礼貌致谢。',
    objectives:['Greet politely in English','Respond to How are you? with a sentence'],
    targetStep:3,kind:'english_a1_text',
    opening:'Hello! Let us practice greetings. First, type: Hello, Alex!'
  },
  {
    id:'english.a1.daily',version:'1.0.0',mode:'english',
    skillId:'learning.english',level:'A1',title:'基础英语：我的一天',
    description:'四步文字句型：起床、吃早餐、去学校和睡觉。',
    objectives:['Use simple present tense for daily routines'],
    targetStep:4,kind:'english_a1_text',
    opening:'Let us talk about your day. Type: I wake up early.'
  },
  {
    id:'story.library.choice',version:'1.0.0',mode:'story',
    skillId:'story.interactive',level:'all',title:'互动故事：发光的图书馆',
    description:'三次可控剧情选择的文本互动故事。',
    objectives:['Follow a story and make choices'],
    targetStep:3,kind:'story_choice',
    opening:'你来到一座会发光的图书馆。A：打开星星地图。B：跟着会说话的小猫。请选择 A 或 B。'
  }
]);

export const DEFAULT_LESSON=Object.freeze({
  english:'english.a1.intro',story:'story.library.choice'
});
const norm=s=>s.replace(/\s+/g,' ').trim();
const QUESTIONS=Object.freeze({
  'english.a1.greetings':[
    {pattern:/^hello[,! ]*(alex)?[.!]?$/i,
      retry:'Please say a greeting: Hello, Alex!',
      next:'Well done! How are you? Reply: I am fine.'},
    {pattern:/^i\s+(?:am|'m)\s+(?:fine|good|happy|okay|ok|tired)[.!?]?$/i,
      retry:'Try a full sentence: I am fine.',
      next:'Good sentence! Now be polite. Type: Thank you.'},
    {pattern:/^thank\s+you[.!]?$/i,
      retry:'Please type: Thank you.',
      next:'Great! You finished the three text-only greetings steps. Type restart to do them again.'}
  ],
  'english.a1.daily':[
    {pattern:/^i\s+wake\s+up\s+(?:early|late)[.!]?$/i,
      retry:'Try: I wake up early.',
      next:'Good! Next: I eat breakfast.'},
    {pattern:/^i\s+eat\s+breakfast[.!]?$/i,
      retry:'Try: I eat breakfast.',
      next:'Nice. Now say: I go to school.'},
    {pattern:/^i\s+go\s+to\s+school[.!]?$/i,
      retry:'Try: I go to school.',
      next:'Last question: What do you do at night? Say: I go to bed.'},
    {pattern:/^i\s+go\s+to\s+bed[.!]?$/i,
      retry:'Try: I go to bed.',
      next:'Well done! You completed four scripted text routine steps. Type restart to practice again.'}
  ]
});

export function courseById(id){
  return COURSES.find(c=>c.id===id)??null;
}
export function coursesForMode(mode){
  return COURSES.filter(c=>c.mode===mode).map(c=>({
    ...c,objectives:[...c.objectives]
  }));
}
export function courseCatalog(){
  return COURSES.map(c=>({...c,objectives:[...c.objectives]}));
}
export function resolveCourse(mode,lessonId){
  if(mode==='chat'){
    if(lessonId!==undefined&&lessonId!==null)throw new Error('CHAT_HAS_NO_LESSON');
    return null;
  }
  const id=lessonId??DEFAULT_LESSON[mode];
  const course=courseById(id);
  if(!course||course.mode!==mode)throw new Error('INVALID_LESSON_SELECTION');
  return course;
}
export function exerciseReply(lessonId,input,step){
  const course=courseById(lessonId);
  if(!course||!QUESTIONS[lessonId])throw new Error('INVALID_SCRIPTED_LESSON');
  const text=norm(input);
  if(step===course.targetStep){
    if(/^(restart|again|重新开始|再来一次)$/i.test(text))
      return {step:0,context:'',text:course.opening};
    return {step,context:'',text:'The lesson is complete. Type restart to practice again.'};
  }
  if(!Number.isInteger(step)||step<0||step>course.targetStep)throw new Error('INVALID_LESSON_STEP');
  const question=QUESTIONS[lessonId][step];
  return question.pattern.test(text)
    ?{step:step+1,context:'',text:question.next}
    :{step,context:'',text:question.retry};
}
